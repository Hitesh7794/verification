package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/storage"
)

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

	// Exam active-window enforcement — only for operators.
	// Admin / superadmin / ops_admin can still fetch a candidate
	// outside the exam window for audit or review; the operator
	// (client role) can't because that's where a new verification
	// would begin. Empty From/To strings mean "no window set" and
	// are treated as always-on for backward compat with legacy rows.
	if claims.Role == "client" {
		now := time.Now().UTC()
		if ec.VerificationFrom != "" {
			if fromT, err := parseDateTimeWindow(ec.VerificationFrom, false); err == nil && now.Before(fromT) {
				writeJSON(w, http.StatusForbidden, map[string]any{
					"error": fmt.Sprintf("Verification for %s (%s) will start on %s. Verifications cannot be started before this date/time.",
						ec.ExamName, ec.ExamCode, ec.VerificationFrom),
					"code":              "EXAM_WINDOW_FUTURE",
					"exam_code":         ec.ExamCode,
					"exam_name":         ec.ExamName,
					"verification_from": ec.VerificationFrom,
					"verification_to":   ec.VerificationTo,
				})
				return
			}
		}
		if ec.VerificationTo != "" {
			if toT, err := parseDateTimeWindow(ec.VerificationTo, true); err == nil && now.After(toT) {
				writeJSON(w, http.StatusForbidden, map[string]any{
					"error": fmt.Sprintf("Verification window for %s (%s) closed on %s. Verifications are no longer accepted.",
						ec.ExamName, ec.ExamCode, ec.VerificationTo),
					"code":              "EXAM_WINDOW_EXPIRED",
					"exam_code":         ec.ExamCode,
					"exam_name":         ec.ExamName,
					"verification_from": ec.VerificationFrom,
					"verification_to":   ec.VerificationTo,
				})
				return
			}
		}
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
		"has_iris_bytes":     hasFS && fsRow.HasIrisBytes,
		"fp_template_format": func() string { if hasFS { return fsRow.FpTemplateFormat }; return "" }(),
		"photo_url":          "/api/candidates/" + roll + "/photo",
		"fp_template_url":    "/api/candidates/" + roll + "/fp-template",
		// Per-exam requirements (migration 022). Frontend renders only
		// panels for modalities the exam requires AND the candidate has
		// enrolment for.
		"requires_face": ec.RequiresFace,
		"requires_fp":   ec.RequiresFP,
		"requires_iris": ec.RequiresIris,
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
	if !ok {
		writeErr(w, http.StatusNotFound, "photo not found")
		return
	}

	// PHOTOS_BACKEND=s3: fetch the object server-side and stream the
	// bytes back to the browser inline. We used to 302→presigned S3
	// URL for the bandwidth win, but the bucket has no CORS config so
	// the browser blocked the cross-origin body — the operator saw
	// "No photo on file" even though the server was matching the same
	// photo happily via GetPhotoBytes on the face-match path. Bytes
	// per photo are ~180 KB, once per candidate lookup — well under
	// any bandwidth threshold worth optimising for.
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
		bytes, err := s.storage.GetPhotoBytes(r.Context(), examCode, roll)
		if err != nil {
			if errors.Is(err, storage.ErrNotFound) {
				writeErr(w, http.StatusNotFound, "photo not found")
				return
			}
			writeErr(w, http.StatusBadGateway,
				"read gallery photo from s3: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "private, max-age=300")
		_, _ = w.Write(bytes)
		return
	}

	// Disk fallback (dev + prod during migration window).
	if !c.HasPhoto {
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
		writeErr(w, http.StatusForbidden, "verification agent missing org context")
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

	var id int64
	err := s.deps.DB.QueryRowContext(r.Context(),
		`INSERT INTO verifications(
			roll_no, org_id, operator_id,
			face_match, fp_match, status, note,
			device_serial, device_model,
			fp_vendor, fp_template_format, fp_quality, fp_nfiq, fp_match_score, fp_liveness,
			iris_left_score, iris_right_score, iris_left_quality, iris_right_quality,
			face_match_score,
			via, match_threshold, decision_ms, client_app_version,
			idempotency_key
		) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
		RETURNING id`,
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
	).Scan(&id)
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

	// Promote the probe photo, if the face-match endpoint stashed one
	// under the same idempotency key. Best-effort: a missing temp file
	// (fingerprint-only flow, or a legacy client that didn't send the
	// key on face-match) just leaves probe_photo_path NULL.
	if req.IdempotencyKey != "" && id > 0 {
		if path := s.promoteProbePhoto(req.IdempotencyKey, id); path != "" {
			_, _ = s.deps.DB.ExecContext(r.Context(),
				`UPDATE verifications SET probe_photo_path = $1 WHERE id = $2`,
				path, id)
		}
	}

	// V10: promote any capture blobs the match endpoints stashed to
	// S3 (temp key `_captures_temp/<idem>/...`) into the institute-
	// scoped audit path (`<ORG>/<EXAM>/captures/YYYY-MM/<id>/...`).
	// Runs in a goroutine — the operator's create-verification
	// response has already gone out; S3 hiccups mustn't block it.
	if req.IdempotencyKey != "" && id > 0 && s.storage != nil && s.storage.Enabled() {
		go s.promoteCaptureBlobs(req, id, claims.UserID)
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":     id,
		"status": req.Status,
		"via":    req.Via,
	})
}

// promoteCaptureBlobs copies each modality's temp S3 blob to its
// permanent institute-scoped location, writes a small meta.json
// alongside them, updates the verifications row with the S3 keys, and
// deletes the temp objects. Each step is best-effort — a partial
// success still leaves audit evidence findable at either the temp or
// final key. Runs in its own goroutine (called async by the
// createVerification handler).
func (s *Server) promoteCaptureBlobs(req verifyReq, verifID, operatorID int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	idem := safeSlug(req.IdempotencyKey)
	if idem == "" || idem == "file" {
		return
	}

	// Look up the org's code + the exam's code so we can build the
	// institute-scoped final key. Primary lookup joins through
	// exam_candidates; if that misses (sample-data / disk-index rolls
	// with no DB row) we fall back to a simpler "org from operator +
	// exam_code from any exam this org is subscribed to" — better than
	// dropping the audit blob because a legacy candidate lacks a
	// exam_candidates row.
	var (
		orgCode  string
		examCode string
	)
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT o.code, e.exam_code
		   FROM verifications v
		   JOIN organizations o ON o.id = v.org_id
		   JOIN exam_candidates ec ON ec.roll_no = v.roll_no
		   JOIN exams e ON e.id = ec.exam_id
		  WHERE v.id = $1
		  LIMIT 1`,
		verifID,
	).Scan(&orgCode, &examCode); err != nil {
		if err2 := s.deps.DB.QueryRowContext(ctx,
			`SELECT o.code
			   FROM organizations o
			   JOIN users u ON u.org_id = o.id
			  WHERE u.id = $1 LIMIT 1`, operatorID,
		).Scan(&orgCode); err2 != nil {
			log.Printf("captures: promote failed for verif=%d (org lookup): %v", verifID, err2)
			return
		}
		examCode = "unknown-exam"
	}

	when := time.Now().UTC()

	type modality struct {
		name      string
		ext       string
		mime      string
		column    string // verifications column to UPDATE with the s3 key
	}
	modalities := []modality{
		{"face", "jpg", "image/jpeg", "face_probe_s3_key"},
		{"fp", "iso", "application/octet-stream", "fp_probe_s3_key"},
		{"iris", "k7", "application/octet-stream", "iris_probe_s3_key"},
	}

	promoted := map[string]string{} // modality → final key

	for _, m := range modalities {
		tempKey := storage.CaptureTempKey(idem, m.name, m.ext)
		finalKey := storage.CaptureFinalKey(orgCode, examCode, verifID, m.name, m.ext, when)

		if err := s.storage.CopyObject(ctx, tempKey, finalKey); err != nil {
			// Not-found on CopyObject is expected for modalities the
			// operator didn't capture (e.g. iris on a face-only exam).
			// Only log at debug level.
			continue
		}
		promoted[m.column] = finalKey

		// Best-effort temp cleanup. A leftover temp object is harmless
		// (S3 lifecycle rule can prune _captures_temp/ after 24 h).
		if err := s.storage.DeleteObject(ctx, tempKey); err != nil {
			log.Printf("captures: temp delete failed key=%s: %v", tempKey, err)
		}
	}

	// meta.json — regulator opens this next to the raw blobs to see
	// scores, device, operator, timestamps at a glance.
	meta := map[string]any{
		"verification_id":   verifID,
		"roll_no":           req.RollNo,
		"org_code":          orgCode,
		"exam_code":         examCode,
		"operator_user_id":  operatorID,
		"created_at":        when.Format(time.RFC3339),
		"status":            req.Status,
		"via":               req.Via,
		"face_match":        req.FaceMatch,
		"fp_match":          req.FpMatch,
		"face_match_score":  req.FaceMatchScore,
		"fp_match_score":    req.FpMatchScore,
		"iris_left_score":   req.IrisLeftScore,
		"device_serial":     req.DeviceSerial,
		"device_model":      req.DeviceModel,
		"fp_vendor":         req.FpVendor,
		"fp_template_format": req.FpTemplateFormat,
		"client_app_version": req.ClientAppVersion,
		"idempotency_key":   req.IdempotencyKey,
	}
	if metaBytes, err := json.Marshal(meta); err == nil {
		metaKey := storage.CaptureMetaKey(orgCode, examCode, verifID, when)
		if err := s.storage.PutJSON(ctx, metaKey, metaBytes); err != nil {
			log.Printf("captures: meta.json put failed key=%s: %v", metaKey, err)
		}
	}

	// Update the verifications row with whichever keys landed. Empty
	// map = nothing to update (no temp blobs found — pure fingerprint-
	// only flow from a client that didn't audit anything).
	if len(promoted) == 0 {
		return
	}
	setClauses := make([]string, 0, len(promoted))
	args := make([]any, 0, len(promoted)+1)
	i := 1
	for col, key := range promoted {
		setClauses = append(setClauses, fmt.Sprintf("%s = $%d", col, i))
		args = append(args, key)
		i++
	}
	args = append(args, verifID)
	q := fmt.Sprintf(`UPDATE verifications SET %s WHERE id = $%d`,
		strings.Join(setClauses, ", "), i)
	if _, err := s.deps.DB.ExecContext(ctx, q, args...); err != nil {
		log.Printf("captures: db update s3 keys failed verif=%d: %v", verifID, err)
	}
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

// patchVerification -- recapture flow.
//
// The auto-submit useEffect on the operator dashboard fires as soon as
// every required modality has produced a result (pass OR fail). When
// the operator then recaptures a modality (e.g. fp failed the first
// time, they retry and it passes), we can't re-run POST because that
// would either duplicate the row or 200-replay via idempotency. So
// the frontend fires PATCH on the existing verification.id, we
// overwrite the biometric flags + scores + recompute status/via
// server-side, and the audit_log gets the before-after diff so
// investigators can see the flip.
//
// Wallet: not re-charged. Original face-match debit is the only
// charged event; recaptures of the fp/iris modalities are already
// free, and recapturing face doesn't fire the wallet middleware on
// this endpoint at all (no walletCharge wrapper).
//
// Auth: client role, own rows only. Same scope as POST.
func (s *Server) patchVerification(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.UserID == 0 {
		writeErr(w, http.StatusUnauthorized, "missing token")
		return
	}
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid verification id")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var req verifyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	// Load the current row to (a) scope-check the operator owns it and
	// (b) build the before-after audit diff.
	var (
		curStatus   string
		curFace     int
		curFp       int
		curIrisScore sql.NullFloat64
		curVia      sql.NullString
		curOperator int64
	)
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT status, face_match, fp_match, iris_left_score, via, operator_id
		   FROM verifications WHERE id = $1`, id,
	).Scan(&curStatus, &curFace, &curFp, &curIrisScore, &curVia, &curOperator)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "verification not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if curOperator != claims.UserID {
		writeErr(w, http.StatusForbidden, "not your verification")
		return
	}

	// Recompute status server-side from the modality flags. Frontend
	// still sends its own req.Status but we trust the flags -- the
	// whole point of PATCH is that recapture may have flipped verdict.
	irisPass := req.IrisLeftScore != nil && *req.IrisLeftScore >= 50
	// Load the exam requires_* flags for this verification's roll so
	// we know which modalities count toward the AND-gate.
	var reqFace, reqFP, reqIris int
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COALESCE(e.requires_face,1), COALESCE(e.requires_fp,1), COALESCE(e.requires_iris,0)
		   FROM verifications v
		   JOIN exam_candidates ec ON ec.roll_no = v.roll_no
		   JOIN exams e ON e.id = ec.exam_id
		  WHERE v.id = $1 LIMIT 1`, id,
	).Scan(&reqFace, &reqFP, &reqIris)
	facePass := reqFace == 0 || req.FaceMatch
	fpPassFlag := reqFP == 0 || req.FpMatch
	irisPassFlag := reqIris == 0 || irisPass
	newStatus := "denied"
	if facePass && fpPassFlag && irisPassFlag {
		newStatus = "verified"
	}
	// Compute the new "via" list the same way the PDF does.
	passed := []string{}
	if reqFace == 1 && req.FaceMatch { passed = append(passed, "fingerprint") } // placeholder -- overwritten below
	passed = passed[:0]
	if reqFace == 1 && req.FaceMatch { passed = append(passed, "face") }
	if reqFP   == 1 && req.FpMatch   { passed = append(passed, "fingerprint") }
	if reqIris == 1 && irisPass      { passed = append(passed, "iris") }
	newVia := "manual"
	if newStatus == "verified" && len(passed) > 0 {
		newVia = strings.Join(passed, "+")
	}

	// Atomic UPDATE. Fields that require optional-null semantics use
	// nullable helpers so a missing PATCH field doesn't zero the DB.
	_, err = s.deps.DB.ExecContext(r.Context(),
		`UPDATE verifications
		    SET face_match         = $1,
		        fp_match           = $2,
		        status             = $3,
		        via                = $4,
		        face_match_score   = COALESCE($5, face_match_score),
		        fp_match_score     = COALESCE($6, fp_match_score),
		        fp_quality         = COALESCE($7, fp_quality),
		        fp_nfiq            = COALESCE($8, fp_nfiq),
		        fp_liveness        = COALESCE($9, fp_liveness),
		        iris_left_score    = COALESCE($10, iris_left_score),
		        iris_right_score   = COALESCE($11, iris_right_score),
		        iris_left_quality  = COALESCE($12, iris_left_quality),
		        iris_right_quality = COALESCE($13, iris_right_quality),
		        match_threshold    = COALESCE($14, match_threshold),
		        decision_ms        = COALESCE($15, decision_ms)
		  WHERE id = $16`,
		boolInt(req.FaceMatch), boolInt(req.FpMatch), newStatus, newVia,
		nullableFloat(req.FaceMatchScore), nullableInt(req.FpMatchScore),
		nullableInt(req.FpQuality), nullableInt(req.FpNfiq), nullableInt(req.FpLiveness),
		nullableFloat(req.IrisLeftScore), nullableFloat(req.IrisRightScore),
		nullableInt(req.IrisLeftQuality), nullableInt(req.IrisRightQuality),
		nullableInt(req.MatchThreshold), nullableInt(req.DecisionMs),
		id,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}

	// Audit the transition so investigators can trace pass<->fail flips.
	s.auditFromRequest(r, "verification.patched", "verification", id, map[string]any{
		"before": map[string]any{
			"status":     curStatus,
			"face_match": curFace == 1,
			"fp_match":   curFp == 1,
			"iris_score": nullableFloatVal(curIrisScore),
			"via":        curVia.String,
		},
		"after": map[string]any{
			"status":     newStatus,
			"face_match": req.FaceMatch,
			"fp_match":   req.FpMatch,
			"iris_score": nullableFloatValPtr(req.IrisLeftScore),
			"via":        newVia,
		},
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"id":     id,
		"status": newStatus,
		"via":    newVia,
	})
}

func nullableFloatVal(n sql.NullFloat64) any {
	if !n.Valid { return nil }
	return n.Float64
}
func nullableFloatValPtr(p *float64) any {
	if p == nil { return nil }
	return *p
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
		 WHERE idempotency_key = $1 AND operator_id = $2`,
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

	// Per-exam modality flags (migration 022). Tell the operator UI
	// which capture panels to show + which must pass for "verified".
	// Frontend AND-s these with per-candidate has_* flags: an exam
	// requiring iris still hides the iris panel for a candidate that
	// has no iris bytes enrolled (silent downgrade -- user's choice).
	RequiresFace bool
	RequiresFP   bool
	RequiresIris bool

	// Exam active-window (YYYY-MM-DD). Enforced for operators in
	// getCandidate — a client-role lookup outside [From, To] returns
	// 403 so the operator can't start a verification for an exam
	// that hasn't opened or has already closed. Empty string when
	// the exam has no window set (legacy rows) — treated as always-on.
	VerificationFrom string
	VerificationTo   string
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
	// verification_date + dob are Postgres DATE columns; casting to text
	// so COALESCE can fall back to '' without a type mismatch (SQLite
	// was permissive here, Postgres is not).
	base := `
		SELECT ec.id, ec.exam_id, e.exam_code, e.name, e.client_id, c.name,
		       ec.roll_no, ec.name, COALESCE(ec.verification_date::text, ''),
		       COALESCE(ec.registration_id, ''), COALESCE(ec.father_name, ''),
		       COALESCE(ec.dob::text, ''),       COALESCE(ec.gender, ''),
		       COALESCE(ec.shift_name, ''),      COALESCE(ec.centre_code, ''),
		       e.requires_face, e.requires_fp, e.requires_iris,
		       COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD"T"HH24:MI'), ''),
		       COALESCE(TO_CHAR(e.verification_to,   'YYYY-MM-DD"T"HH24:MI'), '')
		  FROM exam_candidates ec
		  JOIN exams   e ON e.id = ec.exam_id
		  JOIN clients c ON c.id = e.client_id
		 WHERE ec.roll_no = $1`

	switch claims.Role {
	case "client":
		if claims.UserID == 0 {
			return nil, nil
		}
		query = base + `
		  AND EXISTS (
		    SELECT 1 FROM operator_exams oe
		     WHERE oe.exam_id = ec.exam_id AND oe.user_id = $2
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
		     WHERE s.exam_id = ec.exam_id AND s.org_id = $2
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
		&out.RequiresFace, &out.RequiresFP, &out.RequiresIris,
		&out.VerificationFrom, &out.VerificationTo,
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
		 WHERE org_id = $1 AND roll_no = $2 AND created_at >= $3`,
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
