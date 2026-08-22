package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/data"
	"github.com/veni/neet-verification/internal/storage"
	"github.com/veni/neet-verification/internal/trustview"
)

// irisMatchReq is what the operator's browser POSTs after a single-eye
// iris capture via the Marvis Auth Client Service on localhost:8031.
// The current SDK (v1.4) captures ONE eye per invocation — the previous
// left+right split from the Java iris-service era is gone. Operators
// can capture again if they want the other eye; each capture is one
// POST to this endpoint.
//
//	roll_no        — candidate roll number, resolved server-side to the
//	                 enrolled iris gallery bytes.
//	probe_b64      — raw BMP / K7 / IIR_K7 (whatever the SDK exposed via
//	                 GetImage). TrustView's iris pre-processor sniffs
//	                 the format; we forward as image bytes without a
//	                 format hint.
//	device_serial  — echoed back to the frontend for the audit trail;
//	                 not forwarded to TrustView.
//	device_model   — same.
type irisMatchReq struct {
	RollNo       string `json:"roll_no"`
	ProbeB64     string `json:"probe_b64"`
	DeviceSerial string `json:"device_serial"`
	DeviceModel  string `json:"device_model"`
	// Optional — same idempotency_key the client used on /face-match.
	// When present the server stashes the iris probe under
	// `_captures_temp/<key>/iris.<ext>` for later promotion by
	// /verifications submit. Empty = no audit storage for this capture.
	IdempotencyKey string `json:"idempotency_key"`
}

// irisMatchResp mirrors the face + fp response shapes with two twists:
//
//  1. GalleryMissing=true is the flag the frontend renders as
//     "iris captured (no enrolled template — record for audit)". Iris
//     was never enrolled server-side; the endpoint returns 200 with
//     matched=null so the operator can still capture for audit without
//     a bogus pass/fail.
//  2. LeftScore is populated (RightScore stays null) so the
//     verifications.iris_left_* columns get filled — matches the
//     single-eye capture model without a schema change. Once iris
//     enrollment ships, this endpoint becomes a real 1:1 matcher and
//     the field naming stays intact.
type irisMatchResp struct {
	RollNo         string   `json:"roll_no"`
	GalleryMissing bool     `json:"gallery_missing"`
	Matched        *bool    `json:"matched"` // null when no compare was attempted
	Score          *float64 `json:"score,omitempty"`
	Threshold      float64  `json:"threshold"`
	Engine         string   `json:"engine,omitempty"`
	DeviceSerial   string   `json:"device_serial,omitempty"`
	DeviceModel    string   `json:"device_model,omitempty"`
}

// irisMatch handles the operator's iris-capture submit. Because iris
// gallery storage is still an open design question (see IRIS_NOTES.md
// + the TrustView migration blockers), this handler currently:
//
//  1. Validates the request + confirms the candidate exists in the
//     filesystem index.
//  2. Skips the TrustView compare — no gallery bytes exist yet — and
//     returns matched=null + gallery_missing=true.
//
// The full compare path is wired below and gated on
// irisGalleryFor returning bytes. The moment iris enrollment lands
// (columns on exam_candidates OR a new artefact table OR filesystem
// bytes alongside face photos), replace irisGalleryFor's return value
// and this handler starts scoring for real without another change.
func (s *Server) irisMatch(w http.ResponseWriter, r *http.Request) {
	// Iris captures can be ~1-2 MB per eye in K7 format. 8 MB is
	// comfortably below the TrustView 8 MB body cap.
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)

	var req irisMatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	// Prefer roll from URL path (URL-scoped route) to match the face /
	// fp match handlers' contract.
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		roll = strings.TrimSpace(req.RollNo)
	}
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "roll_no required (URL path or body)")
		return
	}
	if strings.TrimSpace(req.ProbeB64) == "" {
		writeErr(w, http.StatusBadRequest, "probe_b64 required")
		return
	}

	c, ok := s.deps.Index.Get(roll)
	if !ok {
		writeErr(w, http.StatusNotFound, "candidate not found")
		return
	}

	// Decode the probe up front (was previously done after the gallery
	// lookup) so the V10 audit stash below can run even when the
	// gallery is missing — a capture with no gallery still deserves
	// the audit blob so a regulator can see it happened.
	probeBytes, err := decodeIrisProbe(req.ProbeB64)
	if err != nil || len(probeBytes) == 0 {
		writeErr(w, http.StatusBadRequest, "probe_b64 not valid base64")
		return
	}

	// V10: stash the raw iris payload to S3 under a temp key so the
	// /verifications submit step can promote it to the institute-
	// scoped audit path. Fire-and-forget goroutine — never stalls
	// the operator's iris-match response. Empty idempotency_key
	// (older clients) → skipped silently.
	if k := safeSlug(req.IdempotencyKey); k != "" && k != "file" &&
		s.storage != nil && s.storage.Enabled() {
		bytesCopy := append([]byte(nil), probeBytes...)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.storage.PutBiometric(ctx,
				storage.CaptureTempKey(k, "iris", "k7"),
				bytesCopy, "application/octet-stream",
			); err != nil {
				log.Printf("captures: iris probe s3-temp put failed idem=%s: %v", k, err)
			}
		}()
	}

	// Iris gallery lookup: filesystem indexer surfaces enrolled iris
	// bytes at data/gndu27/**/<centre>/iris/<roll>.<iso|k7|bmp>. If no
	// file is on disk for this roll we return matched=null +
	// gallery_missing=true so the operator UI records the capture for
	// audit without a bogus pass/fail. (The probe was already stashed
	// to S3 above so the audit trail still gets the raw bytes.)
	galleryBytes, ok := s.irisGalleryFor(roll, c)
	if !ok {
		writeJSON(w, http.StatusOK, irisMatchResp{
			RollNo:         roll,
			GalleryMissing: true,
			Matched:        nil,
			Threshold:      50,
			DeviceSerial:   strings.TrimSpace(req.DeviceSerial),
			DeviceModel:    strings.TrimSpace(req.DeviceModel),
		})
		return
	}
	if s.trustview == nil {
		writeErr(w, http.StatusServiceUnavailable, "trustview client not configured")
		return
	}
	res, err := s.trustview.Compare(r.Context(),
		trustview.Iris, probeBytes, nil, galleryBytes, nil, nil)
	if err != nil {
		writeTrustViewErr(w, err)
		return
	}
	score := res.Score
	writeJSON(w, http.StatusOK, irisMatchResp{
		RollNo:       roll,
		Matched:      &res.Matched,
		Score:        &score,
		Threshold:    50,
		Engine:       res.Engine,
		DeviceSerial: strings.TrimSpace(req.DeviceSerial),
		DeviceModel:  strings.TrimSpace(req.DeviceModel),
	})
}

// irisGalleryFor is the single choke-point for iris gallery lookup.
// Reads enrolled iris bytes discovered by the filesystem indexer at
// data/gndu27/**/<centre>/iris/<roll>.<iso|k7|bmp>. Returns
// (nil, false) when no gallery file exists for the roll (which the
// handler surfaces to the frontend as gallery_missing:true → audit-
// only capture).
//
// The indexer picks up whichever iris format the enrollment tool
// wrote out; TrustView's iris engine sniffs the format from the bytes
// so the extension itself doesn't matter.
func (s *Server) irisGalleryFor(_ string, c *data.Candidate) ([]byte, bool) {
	if c == nil || !c.HasIrisBytes || c.IrisBytesPath == "" {
		return nil, false
	}
	b, err := os.ReadFile(c.IrisBytesPath)
	if err != nil || len(b) == 0 {
		return nil, false
	}
	return b, true
}

// decodeIrisProbe tolerates data-URL prefixes so the frontend can pass
// the SDK's BitmapData through unchanged.
func decodeIrisProbe(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, ","); i >= 0 && strings.HasPrefix(s, "data:") {
		s = s[i+1:]
	}
	return base64.StdEncoding.DecodeString(s)
}
