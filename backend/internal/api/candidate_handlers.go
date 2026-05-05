package api

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Maximum artifact upload size. Captured fingerprint images are <100 KB,
// photos <500 KB, iris images can hit a couple MB. 5 MB is a comfortable
// ceiling that still rejects accidental whole-disk uploads.
const maxArtifactBytes = 5 << 20

// kinds the verification_artifacts.kind CHECK constraint will accept.
var allowedArtifactKinds = map[string]bool{
	"captured_face":         true,
	"captured_fp_image":     true,
	"captured_fp_template":  true,
	"captured_iris_left":    true,
	"captured_iris_right":   true,
}

// channels the verifications.via column can record. "manual" means the
// operator made the decision without a passing biometric — kept as a
// first-class option since the SDKs aren't infallible and a center
// supervisor sometimes overrides on visual inspection.
var allowedVerificationVia = map[string]bool{
	"fingerprint": true,
	"iris":        true,
	"face":        true,
	"manual":      true,
}

func (s *Server) getCandidate(w http.ResponseWriter, r *http.Request) {
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "missing roll")
		return
	}
	c, ok := s.deps.Index.Get(roll)
	if !ok {
		writeErr(w, http.StatusNotFound, "candidate not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"roll_no":             c.RollNo,
		"org_code":            c.OrgCode,
		"center_code":         c.CenterCode,
		"center_name":         c.CenterName,
		"exam_date":           c.ExamDate,
		"has_photo":           c.HasPhoto,
		"has_fp_image":        c.HasFpImage,
		"has_iso_template":    c.HasIsoTpl,
		"fp_template_format":  c.FpTemplateFormat,
		"photo_url":           "/api/candidates/" + roll + "/photo",
		"fp_template_url":     "/api/candidates/" + roll + "/fp-template",
	})
}

// getCandidateFPTemplate returns the candidate's enrolled fingerprint
// template as base64 alongside the detected wire format. The frontend hands
// this directly to MorFin's verify/match call as GalleryTemplate + TmpFormat.
//
// Templates are tiny (typically <500 bytes). A whole shift of operators
// looking up candidates is a few thousand reads — well below the threshold
// where caching would matter, so we read from disk on each request and let
// the OS page cache do its job.
func (s *Server) getCandidateFPTemplate(w http.ResponseWriter, r *http.Request) {
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "missing roll")
		return
	}
	c, ok := s.deps.Index.Get(roll)
	if !ok || !c.HasIsoTpl {
		writeErr(w, http.StatusNotFound, "template not found")
		return
	}
	bytes, err := os.ReadFile(c.IsoTplPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "read error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"roll_no":      c.RollNo,
		"format":       c.FpTemplateFormat,
		"template_b64": base64.StdEncoding.EncodeToString(bytes),
		"size_bytes":   len(bytes),
	})
}

func (s *Server) getCandidatePhoto(w http.ResponseWriter, r *http.Request) {
	roll := chi.URLParam(r, "roll")
	c, ok := s.deps.Index.Get(roll)
	if !ok || !c.HasPhoto {
		writeErr(w, http.StatusNotFound, "photo not found")
		return
	}
	f, err := os.Open(c.PhotoPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "read error")
		return
	}
	defer f.Close()
	ext := strings.ToLower(filepath.Ext(c.PhotoPath))
	mime := "image/jpeg"
	if ext == ".png" {
		mime = "image/png"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = copyTo(w, f)
}

// verifyReq is the operator-submitted verification record. Boolean
// face_match/fp_match are kept for backward compatibility (and as the
// canonical "did the biometric match" answer); the numeric *_score fields
// carry the raw values from the SDKs and are what an audit later reads to
// reconstruct *why* a row was verified or denied.
type verifyReq struct {
	RollNo string `json:"roll_no"`
	Status string `json:"status"` // verified | denied
	Note   string `json:"note"`

	FaceMatch bool `json:"face_match"`
	FpMatch   bool `json:"fp_match"`

	DeviceSerial string `json:"device_serial"`
	DeviceModel  string `json:"device_model"`

	FpTemplateFormat string `json:"fp_template_format"` // FMR_V2005|FMR_V2011|ANSI_V378
	FpQuality        *int   `json:"fp_quality"`         // 1..100, MorFin
	FpNfiq           *int   `json:"fp_nfiq"`            // 1..5, NIST
	FpMatchScore     *int   `json:"fp_match_score"`     // MorFin MatchScore
	FpLiveness       *int   `json:"fp_liveness"`        // -1 unknown, 0 spoof, 1 live

	IrisLeftScore    *float64 `json:"iris_left_score"`
	IrisRightScore   *float64 `json:"iris_right_score"`
	IrisLeftQuality  *int     `json:"iris_left_quality"`
	IrisRightQuality *int     `json:"iris_right_quality"`

	FaceMatchScore *float64 `json:"face_match_score"` // Luxand placeholder

	Via              string `json:"via"`              // fingerprint|iris|face|manual
	MatchThreshold   *int   `json:"match_threshold"`  // threshold applied at decision time
	DecisionMs       *int   `json:"decision_ms"`      // verification duration ms (UX/SLA)
	ClientAppVersion string `json:"client_app_version"`

	IdempotencyKey string `json:"idempotency_key"`
}

func (s *Server) createVerification(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims.OrgID == nil || claims.CenterID == nil {
		writeErr(w, http.StatusForbidden, "client must be assigned to a center")
		return
	}

	// Cap the request body. The verifyReq struct is small JSON; anything
	// over a few KB is a misconfigured client or an attack.
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)

	var req verifyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Status != "verified" && req.Status != "denied" {
		writeErr(w, http.StatusBadRequest, "status must be verified|denied")
		return
	}
	if strings.TrimSpace(req.RollNo) == "" {
		writeErr(w, http.StatusBadRequest, "roll_no required")
		return
	}
	if req.Via != "" && !allowedVerificationVia[req.Via] {
		writeErr(w, http.StatusBadRequest, "via must be fingerprint|iris|face|manual")
		return
	}
	if req.IdempotencyKey != "" && len(req.IdempotencyKey) > 64 {
		writeErr(w, http.StatusBadRequest, "idempotency_key too long")
		return
	}

	// Idempotency: if the client supplies a key and we've already recorded
	// a row under it, return the original. Operators on flaky links retry.
	if req.IdempotencyKey != "" {
		if existing, ok := s.findByIdempotencyKey(r, req.IdempotencyKey, claims.UserID); ok {
			w.Header().Set("X-Idempotent-Replay", "true")
			writeJSON(w, http.StatusOK, existing)
			return
		}
	}

	res, err := s.deps.DB.ExecContext(r.Context(),
		`INSERT INTO verifications(
			roll_no, org_id, center_id, operator_id,
			face_match, fp_match, status, note,
			device_serial, device_model,
			fp_template_format, fp_quality, fp_nfiq, fp_match_score, fp_liveness,
			iris_left_score, iris_right_score, iris_left_quality, iris_right_quality,
			face_match_score,
			via, match_threshold, decision_ms, client_app_version,
			idempotency_key
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		req.RollNo, *claims.OrgID, *claims.CenterID, claims.UserID,
		boolInt(req.FaceMatch), boolInt(req.FpMatch), req.Status, nullable(req.Note),
		nullable(req.DeviceSerial), nullable(req.DeviceModel),
		nullable(req.FpTemplateFormat), nullableInt(req.FpQuality), nullableInt(req.FpNfiq),
		nullableInt(req.FpMatchScore), nullableInt(req.FpLiveness),
		nullableFloat(req.IrisLeftScore), nullableFloat(req.IrisRightScore),
		nullableInt(req.IrisLeftQuality), nullableInt(req.IrisRightQuality),
		nullableFloat(req.FaceMatchScore),
		nullable(req.Via), nullableInt(req.MatchThreshold), nullableInt(req.DecisionMs),
		nullable(req.ClientAppVersion),
		nullable(req.IdempotencyKey),
	)
	if err != nil {
		// Race: two concurrent requests with the same idempotency key.
		// Re-fetch and return the winner instead of erroring.
		if req.IdempotencyKey != "" && isUniqueViolation(err) {
			if existing, ok := s.findByIdempotencyKey(r, req.IdempotencyKey, claims.UserID); ok {
				w.Header().Set("X-Idempotent-Replay", "true")
				writeJSON(w, http.StatusOK, existing)
				return
			}
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":     id,
		"status": req.Status,
		"via":    req.Via,
	})
}

// findByIdempotencyKey looks up a previously-recorded verification by the
// (operator_id, idempotency_key) pair. Scoping to operator_id is a defence
// against one operator's key colliding with another's; in practice keys are
// UUIDs so this is belt-and-braces.
func (s *Server) findByIdempotencyKey(r *http.Request, key string, userID int64) (map[string]any, bool) {
	var (
		id     int64
		status string
		via    sql.NullString
	)
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id, status, via FROM verifications
		 WHERE idempotency_key = ? AND operator_id = ?`,
		key, userID,
	).Scan(&id, &status, &via)
	if err != nil {
		return nil, false
	}
	return map[string]any{
		"id":     id,
		"status": status,
		"via":    via.String,
	}, true
}

// uploadArtifact stores a captured biometric image/template alongside an
// existing verification row. Behaviour depends on Cfg.ArtifactRetention:
//
//	"none"     — accept the upload, hash and discard
//	"metadata" — record sha256/size/mime only
//	"full"     — also persist bytes under Cfg.ArtifactDir
//
// The streaming hasher means we never load the whole file into memory; this
// is what lets a single backend instance handle hundreds of operators
// uploading captures without ballooning RSS.
func (s *Server) uploadArtifact(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)

	verID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	_ = claims
	if !s.operatorOwnsVerification(r, verID) {
		writeErr(w, http.StatusForbidden, "not your verification")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxArtifactBytes)
	if err := r.ParseMultipartForm(maxArtifactBytes); err != nil {
		writeErr(w, http.StatusBadRequest, "multipart parse: "+err.Error())
		return
	}

	kind := r.FormValue("kind")
	if !allowedArtifactKinds[kind] {
		writeErr(w, http.StatusBadRequest, "invalid kind")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()

	mime := hdr.Header.Get("Content-Type")
	if mime == "" {
		mime = "application/octet-stream"
	}

	if s.deps.Cfg.ArtifactRetention == "none" {
		// Drop on the floor but still 200 so clients don't retry.
		writeJSON(w, http.StatusOK, map[string]any{"stored": false, "reason": "retention=none"})
		return
	}

	h := sha256.New()
	var size int64
	var storagePath string

	if s.deps.Cfg.ArtifactRetention == "full" {
		dir, fname, err := s.artifactPath(verID, kind, hdr.Filename)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "artifact path: "+err.Error())
			return
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeErr(w, http.StatusInternalServerError, "mkdir: "+err.Error())
			return
		}
		full := filepath.Join(dir, fname)
		f, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "create: "+err.Error())
			return
		}
		// Tee through the hasher so we don't have to read the file twice.
		size, err = io.Copy(io.MultiWriter(f, h), file)
		f.Close()
		if err != nil {
			os.Remove(full)
			writeErr(w, http.StatusInternalServerError, "write: "+err.Error())
			return
		}
		storagePath = full
	} else {
		// retention=metadata: hash through a discarding writer.
		size, err = io.Copy(h, file)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "read: "+err.Error())
			return
		}
	}

	sum := hex.EncodeToString(h.Sum(nil))

	res, err := s.deps.DB.ExecContext(r.Context(),
		`INSERT INTO verification_artifacts(verification_id, kind, mime, sha256, size_bytes, storage_path)
		 VALUES(?,?,?,?,?,?)`,
		verID, kind, mime, sum, size, nullable(storagePath),
	)
	if err != nil {
		// If we wrote bytes to disk but the DB insert failed, the caller
		// will retry — leaving an orphan file behind. A sweep job is the
		// right cleanup; for now we accept this rare failure mode rather
		// than fragile rollback.
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	id, _ := res.LastInsertId()

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":         id,
		"sha256":     sum,
		"size_bytes": size,
		"stored":     storagePath != "",
	})
}

// artifactPath returns the directory and filename for a stored artifact.
// Files are sharded by date so a single directory never accumulates more
// than ~1 day of captures.
func (s *Server) artifactPath(verID int64, kind, original string) (dir, fname string, err error) {
	now := time.Now().UTC()
	dir = filepath.Join(
		s.deps.Cfg.ArtifactDir,
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", now.Month()),
		fmt.Sprintf("%02d", now.Day()),
	)
	ext := filepath.Ext(original)
	if ext == "" || len(ext) > 5 {
		ext = ".bin"
	}
	fname = fmt.Sprintf("%d_%s%s", verID, kind, ext)
	return dir, fname, nil
}

// operatorOwnsVerification checks the row belongs to the calling operator
// (or the org/superadmin scope). Without this an operator could attach
// captures to another center's verifications.
func (s *Server) operatorOwnsVerification(r *http.Request, verID int64) bool {
	c := claimsFrom(r)
	var operatorID int64
	var orgID int64
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT operator_id, org_id FROM verifications WHERE id=?`, verID,
	).Scan(&operatorID, &orgID)
	if err != nil {
		return false
	}
	switch c.Role {
	case "client":
		return operatorID == c.UserID
	case "admin":
		return c.OrgID != nil && *c.OrgID == orgID
	case "superadmin":
		return true
	}
	return false
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullable(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func nullableInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullableFloat(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func parseInt64(s string) (int64, error) {
	var n int64
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return 0, errors.New("not a number")
	}
	return n, nil
}

// isUniqueViolation reports whether a SQL error is a unique-constraint
// failure. modernc.org/sqlite returns errors whose Error() string contains
// "UNIQUE constraint failed". Postgres reports SQLSTATE 23505. Both shapes
// are accepted so the migration to pgx is a no-op here.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") ||
		strings.Contains(msg, "23505")
}
