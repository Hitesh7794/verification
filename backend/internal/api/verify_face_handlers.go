package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/storage"
	"github.com/veni/neet-verification/internal/trustview"
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

// getCandidateFaceTemplate used to lazy-extract a Luxand face template
// from the enrolled photo and cache it as <FACE_TEMPLATE_DIR>/<roll>.tpl.
// Deprecated with the TrustView migration — the hosted matcher works on
// raw images end-to-end so no server-side template exists any more.
// Returning 410 Gone (instead of silently serving stale cached bytes)
// so any caller that hasn't updated fails loudly.
func (s *Server) getCandidateFaceTemplate(w http.ResponseWriter, r *http.Request) {
	writeErr(w, http.StatusGone,
		"face templates were removed with the TrustView migration; POST /api/candidates/{roll}/face-match with the probe image instead")
}

// faceMatch is the operator hot path. After the webcam capture, the
// frontend POSTs the JPEG bytes here; we read the candidate's enrolled
// gallery photo from disk, base64 both images, forward them to the
// TrustView hosted compare API, and return the unified 0..100 score.
//
// The wallet middleware already charged the org's wallet before we get
// here (chargeable event = one face-match POST per roll, cached per
// WALLET_SAME_ROLL_CACHE_MIN). The probe photo is persisted under the
// caller-supplied idempotency key so createVerification can promote it
// to the permanent path for the PDF receipt.
//
// We deliberately do NOT record the result in the verifications table
// from this endpoint — this is just a read. The operator's
// "Verified / Not verified" click is what writes the row, and the
// frontend echoes the score back in that submit body.
func (s *Server) faceMatch(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20) // 8 MB cap on captured JPEG
	var req faceMatchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	// Prefer roll from URL path (URL-scoped route) so the wallet
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

	probeBytes, err := decodeDataURL(req.ImageB64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "image_b64 invalid: "+err.Error())
		return
	}

	// Defence-in-depth: reject face-match requests that don't carry a
	// still-fresh, passing liveness_checks row keyed by the same
	// (org, roll, session_id) tuple. The wallet middleware already ran
	// and did NOT charge (its own duplicate check happens before we
	// get here); this refusal produces a clean 412 without a debit.
	//
	// Only enforced for the URL-scoped route where {roll} is present +
	// idempotency_key is passed in the body. The legacy body-only
	// /api/face-match path stays unguarded for now — nothing new
	// should reach it (frontend has moved to the scoped route) but
	// removing it needs a separate release window.
	if chi.URLParam(r, "roll") != "" {
		claims := claimsFrom(r)
		if claims != nil && claims.OrgID != nil {
			key := strings.TrimSpace(req.IdempotencyKey)
			passed, err := s.livenessGatePassed(r.Context(),
				*claims.OrgID, roll, key)
			if err != nil {
				writeErr(w, http.StatusInternalServerError,
					"liveness gate probe: "+err.Error())
				return
			}
			if !passed {
				writeErr(w, http.StatusPreconditionFailed,
					"active-liveness step required before face capture — please complete the blink challenge")
				return
			}
		}
	}

	// Read the enrolled gallery photo bytes directly — TrustView compares
	// raw images end-to-end, so no template extraction step exists any
	// more. Same candidate-index lookup galleryTemplate did before, just
	// stopping at "raw file bytes" instead of "cached feature vector".
	c, ok := s.deps.Index.Get(roll)
	if !ok {
		writeErr(w, http.StatusNotFound, "candidate not found")
		return
	}

	// Photo source selection:
	//   PHOTOS_BACKEND=s3 + storage wired  → read from bucket, keyed by
	//                                        <exam_code>/photos/<roll>.jpg
	//   anything else                      → read from local disk via the
	//                                        candidate index (unchanged)
	// Failure to read the s3 object fails LOUD (400/500) — better than
	// silently degrading to disk and running a match against a stale
	// pre-migration photo. Fresh-install exams will never have a disk
	// copy in the first place.
	var galleryBytes []byte
	if s.deps.Cfg.PhotosBackend == "s3" && s.storage != nil && s.storage.Enabled() {
		examCode, err := s.resolveExamCodeForOperator(r)
		if err != nil {
			writeErr(w, http.StatusInternalServerError,
				"could not resolve exam scope: "+err.Error())
			return
		}
		if examCode == "" {
			writeErr(w, http.StatusForbidden,
				"verification agent is not scoped to any exam")
			return
		}
		galleryBytes, err = s.storage.GetPhotoBytes(r.Context(), examCode, roll)
		if err != nil {
			if errors.Is(err, storage.ErrNotFound) {
				writeErr(w, http.StatusNotFound,
					"candidate has no enrolled photo")
				return
			}
			writeErr(w, http.StatusBadGateway,
				"read gallery photo from s3: "+err.Error())
			return
		}
	} else {
		if !c.HasPhoto || c.PhotoPath == "" {
			writeErr(w, http.StatusNotFound, "candidate has no enrolled photo")
			return
		}
		galleryBytes, err = os.ReadFile(c.PhotoPath)
		if err != nil {
			writeErr(w, http.StatusInternalServerError,
				"read gallery photo: "+err.Error())
			return
		}
	}

	if s.trustview == nil {
		writeErr(w, http.StatusServiceUnavailable, "trustview client not configured")
		return
	}
	res, err := s.trustview.Compare(r.Context(),
		trustview.Face, probeBytes, nil, galleryBytes, nil, nil)
	if err != nil {
		writeTrustViewErr(w, err)
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
			_ = os.WriteFile(filepath.Join(tempDir, k+".jpg"), probeBytes, 0o644)
		}
		// V10: also stash to S3 under a temp key so the /verifications
		// submit step can promote it to the institute-scoped audit
		// path. Fire-and-forget goroutine so a slow S3 PUT doesn't
		// stall the operator's face-match response.
		if s.storage != nil && s.storage.Enabled() {
			bytesCopy := append([]byte(nil), probeBytes...)
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if err := s.storage.PutBiometric(ctx,
					storage.CaptureTempKey(k, "face", "jpg"),
					bytesCopy, "image/jpeg",
				); err != nil {
					log.Printf("captures: face probe s3-temp put failed idem=%s: %v", k, err)
				}
			}()
		}
	}

	// TrustView folds "no face" into a 422 (handled by writeTrustViewErr
	// above) so a 200 here always means a face WAS found. Keep FaceFound
	// in the response for FE backward compat.
	writeJSON(w, http.StatusOK, faceMatchResp{
		RollNo:    roll,
		FaceFound: true,
		Score:     res.Score,
		Threshold: 50, // TrustView unified: 50 = threshold, 100 = perfect
		Status:    res.Matched,
	})
}

// galleryTemplate + faceTemplatePath + errFaceNotInPhoto retired with
// the TrustView migration — the hosted matcher works on raw images
// end-to-end so we no longer maintain an on-disk feature-vector cache
// under FACE_TEMPLATE_DIR. Config value stays wired for backward
// compat but nothing reads it any more; safe to delete after the
// TrustView rollout is confirmed in production.

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

// Sentinel errors — kept because verify_fp_handlers.go historically
// used the same ones (only the "missing candidate" / "missing photo"
// cases apply now that template extraction is gone).
var (
	errCandidateMissing = errors.New("candidate not found")
	errPhotoMissing     = errors.New("candidate has no enrolled photo")
)

// resolveExamCodeForOperator returns the exam_code the requesting
// operator is scoped to via operator_exams (UNIQUE on user_id, so at
// most one exam per operator). Returns "" without error if the caller
// isn't an operator or isn't subscribed to any exam.
//
// The S3 key layout is <exam_code>/photos/<roll>.jpg, so this is the
// missing piece the disk path doesn't need (Candidate.PhotoPath was
// pre-baked at index-scan time from filesystem walk).
func (s *Server) resolveExamCodeForOperator(r *http.Request) (string, error) {
	c := claimsFrom(r)
	if c == nil {
		return "", nil
	}
	var code string
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT e.exam_code
		   FROM operator_exams oe
		   JOIN exams e ON e.id = oe.exam_id
		  WHERE oe.user_id = $1
		  LIMIT 1`,
		c.UserID,
	).Scan(&code)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return code, err
}

// Keep the context import referenced when the resolver isn't
// called (dev builds with PhotosBackend=disk).
var _ = context.Background
var _ = storage.ErrNotFound
