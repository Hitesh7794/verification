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

	"github.com/veni/neet-verification/internal/auth"
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

// getCandidate — Phase 3a exam-scoped lookup.
//
// The roll must live in exam_candidates and be reachable by the caller:
//   client (operator) → the exam is in the operator's operator_exams
//   admin             → the exam is subscribed by the operator's org
//   superadmin        → any exam
//
// If the roll doesn't match under those rules, we return 404 "no data" —
// there is deliberately no leak of "the roll exists in another exam
// you don't have access to". That's the security gate.
//
// Biometric artifacts (photo, fp template) are still fetched by roll_no
// from the filesystem (legacy path). Once S3 + TrustView land the
// artifact URLs become derived from exam_code, but the DB-level gate
// here doesn't need to change again.
func (s *Server) getCandidate(w http.ResponseWriter, r *http.Request) {
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "missing roll")
		return
	}
	claims := claimsFrom(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "missing token")
		return
	}

	ec, err := s.lookupExamCandidate(r, claims, roll)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if ec == nil {
		writeErr(w, http.StatusNotFound, "no data")
		return
	}

	// Optionally attach the legacy filesystem indexer's metadata so the
	// operator UI can still surface has_photo / has_iso_template flags
	// without a separate HEAD request. Filesystem is our biometric
	// source until S3 lands; a matching roll_no in gndu27 means we can
	// serve those assets. Absence just means "no enrolled photo/fp
	// yet" — operator UI handles that gracefully.
	fsRow, hasFS := s.deps.Index.Get(roll)

	resp := map[string]any{
		"roll_no":           ec.RollNo,
		"name":              ec.Name,
		"verification_date": ec.VerificationDate,
		"exam_id":           ec.ExamID,
		"exam_code":         ec.ExamCode,
		"exam_name":         ec.ExamName,
		"client_id":         ec.ClientID,
		"client_name":       ec.ClientName,
		// Extended catalog (migration 019) — empty strings when the CSV
		// omitted them, so the frontend can conditionally hide fields.
		"registration_id": ec.RegistrationID,
		"father_name":     ec.FatherName,
		"dob":             ec.DOB,
		"gender":          ec.Gender,
		"shift_name":      ec.ShiftName,
		"centre_code":     ec.CentreCode,
		// Biometric availability — filesystem-backed until S3/TrustView.
		"has_photo":          hasFS && fsRow.HasPhoto,
		"has_fp_image":       hasFS && fsRow.HasFpImage,
		"has_iso_template":   hasFS && fsRow.HasIsoTpl,
		"fp_template_format": func() string { if hasFS { return fsRow.FpTemplateFormat }; return "" }(),
		"photo_url":          "/api/candidates/" + roll + "/photo",
		"fp_template_url":    "/api/candidates/" + roll + "/fp-template",
	}
	writeJSON(w, http.StatusOK, resp)
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

	FpVendor         string `json:"fp_vendor"`          // mantra|startek (NULL for legacy/manual rows)
	FpTemplateFormat string `json:"fp_template_format"` // FMR_V2005|FMR_V2011|ANSI_V378
	FpQuality        *int   `json:"fp_quality"`         // 1..100, vendor-defined scale
	FpNfiq           *int   `json:"fp_nfiq"`            // 1..5, NIST (MorFin only)
	FpMatchScore     *int   `json:"fp_match_score"`     // vendor-specific scale
	FpLiveness       *int   `json:"fp_liveness"`        // -1 unknown, 0 spoof, 1 live (MorFin only)

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
	if claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "operator missing org context")
		return
	}
	// (center_id column was dropped in migration 021; verifications
	// are exam-scoped via exam_candidates/exam_centres now.)

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
			roll_no, org_id, operator_id,
			face_match, fp_match, status, note,
			device_serial, device_model,
			fp_vendor, fp_template_format, fp_quality, fp_nfiq, fp_match_score, fp_liveness,
			iris_left_score, iris_right_score, iris_left_quality, iris_right_quality,
			face_match_score,
			via, match_threshold, decision_ms, client_app_version,
			idempotency_key
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		req.RollNo, *claims.OrgID, claims.UserID,
		boolInt(req.FaceMatch), boolInt(req.FpMatch), req.Status, nullable(req.Note),
		nullable(req.DeviceSerial), nullable(req.DeviceModel),
		nullable(req.FpVendor), nullable(req.FpTemplateFormat), nullableInt(req.FpQuality), nullableInt(req.FpNfiq),
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

	// Promote the probe photo, if the face-match endpoint stashed one
	// under the same idempotency key. Best-effort: a missing temp file
	// (fingerprint-only flow, or a legacy client that didn't send the
	// key on face-match) just leaves probe_photo_path NULL.
	if req.IdempotencyKey != "" && id > 0 {
		if path := s.promoteProbePhoto(req.IdempotencyKey, id); path != "" {
			_, _ = s.deps.DB.ExecContext(r.Context(),
				`UPDATE verifications SET probe_photo_path = ? WHERE id = ?`,
				path, id)
		}
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":     id,
		"status": req.Status,
		"via":    req.Via,
	})
}

// promoteProbePhoto moves the temp probe file (dropped by the
// face-match endpoint under idempotencyKey) into a permanent
// verification-scoped location, and returns that path. Returns "" if
// there was no temp file to promote (fingerprint-only flow, retake
// after abandonment, backward-compat client).
//
// Layout on disk:
//
//	{ArtifactDir}/probes/temp/<idem-key>.jpg      (before promotion)
//	{ArtifactDir}/probes/YYYY/MM/<verification_id>.jpg (after)
//
// Keying by verification_id after promotion gives us a 1:1 mapping —
// the PDF endpoint reads verifications.probe_photo_path and streams
// exactly that file. Retakes create a new verification row → new
// probe file → the PDF for retake N shows only the day of retake N.
func (s *Server) promoteProbePhoto(idemKey string, verificationID int64) string {
	k := safeSlug(idemKey)
	if k == "" || k == "file" {
		return ""
	}
	tempPath := filepath.Join(s.deps.Cfg.ArtifactDir, "probes", "temp", k+".jpg")
	if _, err := os.Stat(tempPath); err != nil {
		return ""
	}
	now := time.Now().UTC()
	permDir := filepath.Join(s.deps.Cfg.ArtifactDir, "probes",
		fmt.Sprintf("%04d", now.Year()), fmt.Sprintf("%02d", int(now.Month())))
	if err := os.MkdirAll(permDir, 0o755); err != nil {
		return ""
	}
	permPath := filepath.Join(permDir, fmt.Sprintf("%d.jpg", verificationID))
	if err := os.Rename(tempPath, permPath); err != nil {
		return ""
	}
	return permPath
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

// ── Phase 3a exam-scoped lookup ──────────────────────────────────────

// examCandidateRow is what a lookup returns after the role-based scope
// filter has been applied. The exam context (id / code / name / client)
// travels alongside so the operator UI can show "exam: UPSC-CS-2026"
// as a small pill, and the audit trail on POST /api/verifications can
// tag the row with which exam produced it (Phase 3+).
type examCandidateRow struct {
	ID               int64
	ExamID           int64
	ExamCode         string
	ExamName         string
	ClientID         int64
	ClientName       string
	RollNo           string
	Name             string
	VerificationDate string // may be empty if the CSV row omitted the date

	// Extended catalog fields — populated when the CSV upload provided
	// them (migration 019 onwards). All may be empty on legacy rows.
	// Consumed by the PDF-receipt endpoint and shown on the operator
	// candidate card.
	RegistrationID string
	FatherName     string
	DOB            string
	Gender         string
	ShiftName      string
	CentreCode     string
}

// lookupExamCandidate finds a candidate the caller is allowed to see.
// Returns (row, nil) on a hit, (nil, nil) if the roll is nowhere the
// caller can reach, and (nil, err) on a real DB error.
//
// Role-based scoping — the entire security gate lives here:
//
//   client (operator)  →  row must be in an exam the operator is
//                         assigned to via operator_exams
//   admin              →  row must be in an exam the operator's org
//                         subscribes to via organization_exam_subscriptions
//   superadmin         →  no scope filter — sees everything
//
// A roll that exists in exam_candidates for some OTHER org's exam is
// invisible: the SELECT simply returns no rows. We deliberately do not
// return a distinct "exists but forbidden" — that would leak the
// existence of enrollments across tenants.
func (s *Server) lookupExamCandidate(r *http.Request, claims *authClaims, roll string) (*examCandidateRow, error) {
	if claims == nil {
		return nil, nil
	}

	var (
		query string
		args  []any
	)
	base := `
		SELECT ec.id, ec.exam_id, e.exam_code, e.name, e.client_id, c.name,
		       ec.roll_no, ec.name, COALESCE(ec.verification_date, ''),
		       COALESCE(ec.registration_id, ''), COALESCE(ec.father_name, ''),
		       COALESCE(ec.dob, ''),             COALESCE(ec.gender, ''),
		       COALESCE(ec.shift_name, ''),      COALESCE(ec.centre_code, '')
		  FROM exam_candidates ec
		  JOIN exams   e ON e.id = ec.exam_id
		  JOIN clients c ON c.id = e.client_id
		 WHERE ec.roll_no = ?`

	switch claims.Role {
	case "client":
		if claims.UserID == 0 {
			return nil, nil
		}
		query = base + `
		  AND EXISTS (
		    SELECT 1 FROM operator_exams oe
		     WHERE oe.exam_id = ec.exam_id AND oe.user_id = ?
		  )
		LIMIT 1`
		args = []any{roll, claims.UserID}

	case "admin":
		if claims.OrgID == nil {
			return nil, nil
		}
		query = base + `
		  AND EXISTS (
		    SELECT 1 FROM organization_exam_subscriptions s
		     WHERE s.exam_id = ec.exam_id AND s.org_id = ?
		  )
		LIMIT 1`
		args = []any{roll, *claims.OrgID}

	case "superadmin", "ops_admin":
		query = base + ` LIMIT 1`
		args = []any{roll}

	default:
		return nil, nil
	}

	var out examCandidateRow
	err := s.deps.DB.QueryRowContext(r.Context(), query, args...).Scan(
		&out.ID, &out.ExamID, &out.ExamCode, &out.ExamName,
		&out.ClientID, &out.ClientName,
		&out.RollNo, &out.Name, &out.VerificationDate,
		&out.RegistrationID, &out.FatherName, &out.DOB,
		&out.Gender, &out.ShiftName, &out.CentreCode,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// authClaims mirrors auth.Claims — kept as a local alias so this file
// doesn't need to import the auth package just for the type reference.
type authClaims = auth.Claims

// ── Phase 3c attempt counter ─────────────────────────────────────────
//
// Operator UI shows a small "3rd attempt" chip when they open a
// candidate. We look 30 days back so a genuine multi-day re-verify
// (student returned) still surfaces prior context, but very old
// history doesn't pollute the badge.
//
// Scoped to the caller's org so a college can't see how many times
// another college has looked up the same roll. That would leak
// enrollment traffic.

func (s *Server) getCandidateAttempts(w http.ResponseWriter, r *http.Request) {
	roll := strings.TrimSpace(chi.URLParam(r, "roll"))
	if roll == "" {
		writeErr(w, http.StatusBadRequest, "missing roll")
		return
	}
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "org context required")
		return
	}
	cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour)

	var (
		count  int64
		lastAt sql.NullTime
	)
	err := s.deps.DB.QueryRowContext(r.Context(), `
		SELECT COUNT(*), MAX(created_at)
		  FROM verifications
		 WHERE org_id = ? AND roll_no = ? AND created_at >= ?`,
		*claims.OrgID, roll, cutoff,
	).Scan(&count, &lastAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	out := map[string]any{
		"roll_no": roll,
		"count":   count,
		"since":   cutoff.Format(time.RFC3339),
	}
	if lastAt.Valid {
		out["last_at"] = lastAt.Time.Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, out)
}
