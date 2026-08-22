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

	"github.com/veni/neet-verification/internal/storage"
	"github.com/veni/neet-verification/internal/trustview"
)

// fpMatchReq is what the operator's browser POSTs after capturing a
// fingerprint via the local Mantra MorFin daemon or Startek/ACPL Capture
// API. Either probe template (base64) or roll_no must be provided; the
// gallery is looked up server-side via the candidate index.
//
//   probe_b64  — raw FMR_V2005 / FMR_V2011 / ANSI_V378 template captured
//                live from the operator-laptop fingerprint daemon. Same
//                byte shape the /api/candidates/<roll>/fp-template endpoint
//                serves for gallery lookups.
//   roll_no    — candidate roll number. Backend resolves to the gallery
//                template from gndu27 (or whatever data tree DATA_DIR
//                points at).
//   fp_vendor  — optional audit hint ("mantra"|"startek"). Not used in
//                matching, just logged. The actual fp_vendor that goes on
//                the verifications row arrives later via POST /api/verifications.
//
// We deliberately do NOT record the result here — this endpoint is a pure
// read. The operator's "Verified / Not verified" click is what writes the
// audit row, and the frontend echoes the score back in that submit body.
// Keeps this endpoint idempotent and cheap to retry.
type fpMatchReq struct {
	RollNo   string `json:"roll_no"`
	ProbeB64 string `json:"probe_b64"`
	FpVendor string `json:"fp_vendor"`
	// Optional: clients that want the raw probe stored for audit send
	// the same idempotency_key here that they used on /face-match.
	// The server writes the FP template to `_captures_temp/<key>/fp.<ext>`
	// so /verifications submit can promote it. Empty = no audit.
	IdempotencyKey string `json:"idempotency_key"`
}

// fpMatchResp echoes everything the dashboard needs to surface inline.
// Score is TrustView's unified 0..100 (50 = threshold, 100 = perfect
// match). Threshold is always 50 for this endpoint — the previous
// SourceAFIS-native threshold (140) no longer applies.
type fpMatchResp struct {
	RollNo    string  `json:"roll_no"`
	Score     float64 `json:"score"`
	Threshold float64 `json:"threshold"`
	Status    bool    `json:"status"`
	Vendor    string  `json:"vendor,omitempty"`
	Engine    string  `json:"engine,omitempty"` // e.g. "sourceafis" — echoed from TrustView
}

// fpMatch is the operator's hot path on the fingerprint step. The frontend
// captures a probe via the local SDK (Mantra MorFin or ACPL Capture API),
// then POSTs the probe + roll_no here. The backend reads the gallery
// ISO template from disk, base64s both, forwards to the TrustView hosted
// compare API, and returns the unified 0..100 score.
//
// Mirrors the face-match endpoint's shape exactly — same auth (operator
// JWT), same error taxonomy via writeTrustViewErr, same idempotency
// property (pure read; the operator's Verified/Denied click writes the
// audit row).
func (s *Server) fpMatch(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10) // 256 KB — probes are ~500 bytes; ample headroom
	var req fpMatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	// Prefer roll from URL path (new URL-scoped route) so this stays
	// aligned with the face-match handler's contract.
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		roll = strings.TrimSpace(req.RollNo)
	}
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "roll_no required (URL path or body)")
		return
	}
	probeB64 := strings.TrimSpace(req.ProbeB64)
	if probeB64 == "" {
		writeErr(w, http.StatusBadRequest, "probe_b64 required")
		return
	}

	probe, err := base64.StdEncoding.DecodeString(probeB64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "probe_b64 not valid base64: "+err.Error())
		return
	}
	if len(probe) == 0 {
		writeErr(w, http.StatusBadRequest, "probe_b64 decoded to zero bytes")
		return
	}

	// Resolve the gallery template the same way /api/candidates/{roll}/fp-template
	// does. Re-using the candidate index keeps a single source of truth for
	// "which file holds the enrolled template for roll X."
	c, ok := s.deps.Index.Get(roll)
	if !ok {
		writeErr(w, http.StatusNotFound, "candidate not found")
		return
	}
	if !c.HasIsoTpl {
		writeErr(w, http.StatusUnprocessableEntity,
			"candidate has no enrolled fingerprint template")
		return
	}
	gallery, err := os.ReadFile(c.IsoTplPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "read gallery template: "+err.Error())
		return
	}
	if len(gallery) == 0 {
		writeErr(w, http.StatusUnprocessableEntity,
			"gallery template file is empty")
		return
	}

	if s.trustview == nil {
		writeErr(w, http.StatusServiceUnavailable, "trustview client not configured")
		return
	}
	// Both probe and gallery are ISO/IEC 19794-2 FMR templates — our
	// sample gallery bytes are FMR_V2005 and live MorFin captures come
	// out the same. Tag both sides format="iso" so TrustView's SourceAFIS
	// backend treats them as templates rather than trying to sniff.
	iso := trustview.FormatIso
	res, err := s.trustview.Compare(r.Context(),
		trustview.Fingerprint, probe, &iso, gallery, &iso, nil)
	if err != nil {
		writeTrustViewErr(w, err)
		return
	}

	// V10: stash the raw probe template to S3 under a temp key keyed
	// by idempotency_key so /verifications submit can promote it to
	// the institute-scoped audit path. Skipped when the client didn't
	// send an idempotency_key (older clients) or storage is
	// unconfigured. Fire-and-forget goroutine — never stalls the
	// operator's match response.
	if k := safeSlug(req.IdempotencyKey); k != "" && k != "file" &&
		s.storage != nil && s.storage.Enabled() {
		bytesCopy := append([]byte(nil), probe...)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := s.storage.PutBiometric(ctx,
				storage.CaptureTempKey(k, "fp", "iso"),
				bytesCopy, "application/octet-stream",
			); err != nil {
				log.Printf("captures: fp probe s3-temp put failed idem=%s: %v", k, err)
			}
		}()
	}

	writeJSON(w, http.StatusOK, fpMatchResp{
		RollNo:    roll,
		Score:     res.Score,
		Threshold: 50, // TrustView unified: 50 = threshold
		Status:    res.Matched,
		Vendor:    strings.TrimSpace(req.FpVendor),
		Engine:    res.Engine,
	})
}
