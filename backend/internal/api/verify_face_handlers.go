package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/luxand"
)

// faceMatchReq is what the operator's browser POSTs after a webcam capture.
// The image arrives as a base64 string (we strip the "data:image/jpeg;base64,"
// prefix the canvas toDataURL produces so callers can paste it raw).
type faceMatchReq struct {
	RollNo   string `json:"roll_no"`
	ImageB64 string `json:"image_b64"`
	// Optional explicit mime; default image/jpeg.
	Mime string `json:"mime"`
	// Optional per-verification key minted at lookup time on the client.
	// When present, the raw probe bytes are stashed at
	// {ArtifactDir}/probes/temp/<key>.jpg — the createVerification
	// handler later moves that file to its permanent location and
	// records the path on the verifications row for the PDF receipt.
	// Absent → no probe is persisted (backward-compatible).
	IdempotencyKey string `json:"idempotency_key"`
}

// faceMatchResp echoes everything the dashboard wants to surface inline.
type faceMatchResp struct {
	RollNo    string  `json:"roll_no"`
	FaceFound bool    `json:"face_found"`
	Score     float64 `json:"score"`
	Threshold float64 `json:"threshold"`
	Status    bool    `json:"status"`
}

// getCandidateFaceTemplate exposes the cached/extracted face template
// straight to the operator's browser. Lazy: if the template hasn't been
// extracted from the candidate's enrolled photo yet, do it now and cache
// to disk. After first hit, every operator's lookup of the same roll is
// a single OS read of a 1040-byte file.
//
// Used today by /api/face-match (server-side); kept exposed so a future
// frontend that wants to do its own matching (or pre-warming) can pull it.
func (s *Server) getCandidateFaceTemplate(w http.ResponseWriter, r *http.Request) {
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "missing roll")
		return
	}
	tpl, err := s.galleryTemplate(r.Context(), roll)
	switch {
	case errors.Is(err, errCandidateMissing):
		writeErr(w, http.StatusNotFound, "candidate not found")
		return
	case errors.Is(err, errPhotoMissing):
		writeErr(w, http.StatusNotFound, "candidate has no enrolled photo")
		return
	case errors.Is(err, errFaceNotInPhoto):
		// The enrolled photo is a real file but Luxand can't find a face
		// in it. Loud and clear so the data-quality team can fix the photo.
		writeErr(w, http.StatusUnprocessableEntity,
			"no face detected in enrolled photo; cannot extract gallery template")
		return
	case err != nil:
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"roll_no":      roll,
		"format":       "FSDK_FaceTemplate_v8",
		"size_bytes":   len(tpl),
		"template_b64": base64.StdEncoding.EncodeToString(tpl),
	})
}

// faceMatch is the operator hot path. After the webcam capture, the
// frontend POSTs the JPEG bytes here; we look up (or extract+cache) the
// gallery template, forward both to luxand-service /face/match-image,
// and return the score so the operator can decide.
//
// We deliberately do NOT record the result in the verifications table
// from this endpoint — this is just a read. The operator's
// "Verified / Not verified" click is what writes the row, and the
// frontend echoes the score back in that submit body. Keeps this
// endpoint cheap to retry.
func (s *Server) faceMatch(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20) // 8 MB cap on captured JPEG
	var req faceMatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	// Prefer roll from URL path (new URL-scoped route) so the wallet
	// middleware saw the same value we're about to act on. Fall back
	// to the body field for the legacy /api/face-match route.
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		roll = strings.TrimSpace(req.RollNo)
	}
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "roll_no required (URL path or body)")
		return
	}

	imgBytes, err := decodeDataURL(req.ImageB64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "image_b64 invalid: "+err.Error())
		return
	}
	mime := req.Mime
	if mime == "" {
		mime = "image/jpeg"
	}

	gallery, err := s.galleryTemplate(r.Context(), roll)
	switch {
	case errors.Is(err, errCandidateMissing):
		writeErr(w, http.StatusNotFound, "candidate not found")
		return
	case errors.Is(err, errPhotoMissing):
		writeErr(w, http.StatusNotFound, "candidate has no enrolled photo")
		return
	case errors.Is(err, errFaceNotInPhoto):
		writeErr(w, http.StatusUnprocessableEntity,
			"no face detected in enrolled photo")
		return
	case err != nil:
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	if s.luxand == nil {
		writeErr(w, http.StatusServiceUnavailable, "luxand client not configured")
		return
	}
	res, err := s.luxand.MatchImage(r.Context(), imgBytes, mime, gallery)
	if err != nil {
		var serv *luxand.ErrService
		var sdk *luxand.ErrSDK
		switch {
		case errors.As(err, &serv):
			writeErr(w, http.StatusServiceUnavailable, "luxand-service unreachable")
		case errors.As(err, &sdk):
			writeErr(w, http.StatusBadGateway, "luxand "+sdk.Code+": "+sdk.Description)
		default:
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}

	// Persist the probe under the client-supplied idempotency key. Kept
	// regardless of match outcome — a denied verification still deserves
	// the probe on its PDF receipt so a reviewer can see what was
	// captured. Failure to write is not fatal: the match already
	// happened, and the PDF just won't have the captured photo.
	if k := safeSlug(req.IdempotencyKey); k != "" && k != "file" {
		tempDir := filepath.Join(s.deps.Cfg.ArtifactDir, "probes", "temp")
		if err := os.MkdirAll(tempDir, 0o755); err == nil {
			_ = os.WriteFile(filepath.Join(tempDir, k+".jpg"), imgBytes, 0o644)
		}
	}

	writeJSON(w, http.StatusOK, faceMatchResp{
		RollNo:    roll,
		FaceFound: res.FaceFound,
		Score:     res.Score,
		Threshold: res.Threshold,
		Status:    res.Status,
	})
}

// galleryTemplate returns the candidate's enrolled face template. If the
// template hasn't been extracted yet, it reads the photo, asks
// luxand-service to extract a template, writes it to disk, and returns
// the bytes. After the first miss for a roll, every subsequent call is
// just one os.ReadFile.
//
// Templates live at <FACE_TEMPLATE_DIR>/<roll>.tpl. Each is exactly 1040
// bytes — the entire 2,847-candidate sample data set fits in ~3 MB.
func (s *Server) galleryTemplate(ctx context.Context, roll string) ([]byte, error) {
	c, ok := s.deps.Index.Get(roll)
	if !ok {
		return nil, errCandidateMissing
	}
	if !c.HasPhoto || c.PhotoPath == "" {
		return nil, errPhotoMissing
	}
	cachePath := s.faceTemplatePath(roll)

	// Cache hit?
	if data, err := os.ReadFile(cachePath); err == nil {
		return data, nil
	}

	// Cache miss → extract.
	if s.luxand == nil {
		return nil, errors.New("luxand client not configured; cannot extract face template")
	}
	photoBytes, err := os.ReadFile(c.PhotoPath)
	if err != nil {
		return nil, err
	}
	mime := "image/jpeg"
	if strings.HasSuffix(strings.ToLower(c.PhotoPath), ".png") {
		mime = "image/png"
	}
	tpl, err := s.luxand.ExtractTemplate(ctx, photoBytes, mime)
	if err != nil {
		return nil, err
	}
	if tpl == nil {
		return nil, errFaceNotInPhoto
	}

	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		return nil, err
	}
	// Write atomically: write to .tmp then rename, so a crashed extract
	// never leaves a half-written file that future calls would happily
	// hand to MatchFaces and produce a garbage score.
	tmp := cachePath + ".tmp"
	if err := os.WriteFile(tmp, tpl, 0o644); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, cachePath); err != nil {
		return nil, err
	}
	return tpl, nil
}

func (s *Server) faceTemplatePath(roll string) string {
	return filepath.Join(s.deps.Cfg.FaceTemplateDir, roll+".tpl")
}

// decodeDataURL accepts either a raw base64 string or a "data:image/jpeg
// ;base64,XXX" data URL (which is what canvas.toDataURL emits) and
// returns the decoded bytes.
func decodeDataURL(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, ","); i >= 0 && strings.HasPrefix(s, "data:") {
		s = s[i+1:]
	}
	return base64.StdEncoding.DecodeString(s)
}

// Sentinel errors so callers can distinguish "no candidate" (404) from
// "service unreachable" (503) from "photo has no detectable face" (422).
var (
	errCandidateMissing = errors.New("candidate not found")
	errPhotoMissing     = errors.New("candidate has no enrolled photo")
	errFaceNotInPhoto   = errors.New("no face detected in enrolled photo")
)
