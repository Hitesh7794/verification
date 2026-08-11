package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/fpmatch"
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
}

// fpMatchResp echoes everything the dashboard needs to surface inline.
type fpMatchResp struct {
	RollNo    string  `json:"roll_no"`
	Score     float64 `json:"score"`
	Threshold float64 `json:"threshold"`
	Status    bool    `json:"status"`
	Vendor    string  `json:"vendor,omitempty"`
}

// fpMatch is the operator's hot path on the fingerprint step. The frontend
// captures a probe via the local SDK (Mantra MorFin or ACPL Capture API),
// then POSTs the probe + roll_no here. The backend reads the gallery
// template from disk (same source as /api/candidates/{roll}/fp-template),
// forwards probe + gallery to the loopback fp-match-service (SourceAFIS),
// and returns the score.
//
// Mirrors the face-match endpoint's shape exactly — same auth (operator
// JWT), same error taxonomy (404 candidate, 422 no template, 503 service
// down, 502 SDK error), same idempotency property (pure read).
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

	if s.fpMatchCl == nil {
		writeErr(w, http.StatusServiceUnavailable, "fp-match client not configured")
		return
	}
	res, err := s.fpMatchCl.Match(r.Context(), probe, gallery)
	if err != nil {
		var serv *fpmatch.ErrService
		var sdk *fpmatch.ErrSDK
		switch {
		case errors.As(err, &serv):
			writeErr(w, http.StatusServiceUnavailable, "fp-match-service unreachable")
		case errors.As(err, &sdk):
			writeErr(w, http.StatusBadGateway, "fp-match "+sdk.Code+": "+sdk.Description)
		default:
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, fpMatchResp{
		RollNo:    roll,
		Score:     res.Score,
		Threshold: res.Threshold,
		Status:    res.Status,
		Vendor:    strings.TrimSpace(req.FpVendor),
	})
}
