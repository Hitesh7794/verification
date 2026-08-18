package api

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/veni/neet-verification/internal/db"
)

// Designed for ~10k institutions over time, with peaks of dozens of
// concurrent uploads during onboarding waves. The hot path here is the
// document upload — it streams to disk via io.Copy + MaxBytesReader so
// we never hold full files in memory, uses an atomic temp-then-rename
// pattern so a crashed upload never leaves a half-file the superadmin
// might try to open, and shards storage by `app_id / 100` so no single
// directory accumulates more than ~100 application subfolders.
//
// Rate limiting is per-IP, sliding-window, in-memory. Sufficient for
// single-instance dev + early prod. When we go multi-instance we'll
// swap for Redis-backed sliding window; the registerLimiter type
// behind it stays the same.

// ----- limits / constants -----

const (
	// Hard cap on multipart upload size (bytes). Higher than the per-file
	// limit because multipart frames + form fields add ~1 KB of overhead.
	maxUploadBytes = 11 << 20 // 11 MB

	// Per-file cap surfaced in the UI and enforced post-parse.
	maxFileBytes = 10 << 20 // 10 MB

	// Cap on the JSON body for /api/register/init.
	maxInitJSONBytes = 16 << 10 // 16 KB

	// Per-IP rate limit on /api/register/init. Prevents anyone from
	// flooding the queue with junk applications. 5/hour is generous for
	// a legitimate user fat-fingering the form, restrictive for a bot.
	registerRateMax    = 100
	registerRateWindow = 1 * time.Hour

	// Per-application document count cap. Recognition + PAN + auth letter
	// + optional NAAC + a couple more = 6 is comfortable.
	maxDocsPerApplication = 8
)

var (
	// Allowed mime types for document uploads. We accept JPG / PNG / PDF
	// only. PDF is the safest format for a superadmin to review without
	// rendering attacker-controlled HTML; JPG/PNG are convenient for
	// phone-scanned recognition letters.
	allowedDocMimes = map[string]bool{
		"application/pdf": true,
		"image/jpeg":      true,
		"image/jpg":       true,
		"image/png":       true,
	}

	// Allowed institution types / tiers / designations / kinds —
	// hard-coded enums mirroring the CHECK constraints on the DB rows.
	// Mismatch = 400 before we ever touch the DB.
	// College + university only — schools and coaching centres are
	// not currently in scope. The DB CHECK constraint still allows
	// the historical 'school' / 'coaching' values for any legacy
	// rows, but new submissions can only pick from this map.
	allowedInstitutionTypes = map[string]bool{
		"college":    true,
		"university": true,
	}
	allowedTiers = map[string]bool{
		"":       true, // optional
		"tier_1": true,
		"tier_2": true,
		"tier_3": true,
	}
	allowedDocKinds = map[string]bool{
		"recognition_letter":   true,
		"pan_card":             true,
		"authorization_letter": true,
		"naac_certificate":     true,
		"other":                true,
	}

	// Required document kinds — submit() refuses to finalise without
	// these on file.
	requiredDocKinds = []string{
		"recognition_letter",
		"pan_card",
		"authorization_letter",
	}

	// Loose validators. We don't try to validate AISHE / PAN against
	// external APIs here — the superadmin's eyeball is the truth source.
	// We just reject obviously-malformed values so the queue isn't full
	// of garbage.
	reEmail = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	// Indian mobile: 10 digits, first digit 6/7/8/9 (TRAI mobile ranges).
	// Country code + trunk-0 prefix are stripped on the frontend before
	// submit; the backend still enforces the canonical form as a defence
	// against bad API clients / direct curl calls.
	reMobile = regexp.MustCompile(`^[6-9][0-9]{9}$`)
	rePAN    = regexp.MustCompile(`^[A-Z]{5}[0-9]{4}[A-Z]$`)
	rePIN    = regexp.MustCompile(`^[0-9]{6}$`)
)

// ----- rate limiter -----

// registerLimiter is a tiny in-memory sliding-window limiter keyed by
// client IP. Thread-safe. Old entries are GC'd lazily on each check.
type registerLimiter struct {
	mu      sync.Mutex
	hits    map[string][]time.Time
	max     int
	window  time.Duration
	maxKeys int // soft cap so a flood of unique IPs can't OOM us
}

func newRegisterLimiter(max int, window time.Duration) *registerLimiter {
	return &registerLimiter{
		hits:    map[string][]time.Time{},
		max:     max,
		window:  window,
		maxKeys: 100_000, // ~10 MB of timestamps at worst; trivial
	}
}

func (l *registerLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.window)
	// Prune the list for this IP.
	stamps := l.hits[ip]
	kept := stamps[:0]
	for _, t := range stamps {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.hits[ip] = kept
		return false
	}
	kept = append(kept, now)
	l.hits[ip] = kept

	// Soft cap on total keys. Drop a random one if we're over. The
	// background cleanup goroutine prunes expired entries on a timer
	// so under normal load this branch is unreachable; it stays as a
	// last-resort OOM guard against high-cardinality flood attacks
	// faster than the cleanup interval.
	if len(l.hits) > l.maxKeys {
		for k := range l.hits {
			delete(l.hits, k)
			break
		}
	}
	return true
}

// pruneExpired removes IPs whose latest hit is older than the limiter
// window. Called from a background goroutine to keep the map size
// bounded under sustained traffic. O(n) over the map; we run it
// infrequently (every 10 minutes) so the cost is negligible.
func (l *registerLimiter) pruneExpired() {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := time.Now().Add(-l.window)
	for ip, stamps := range l.hits {
		latest := time.Time{}
		for _, t := range stamps {
			if t.After(latest) {
				latest = t
			}
		}
		if latest.Before(cutoff) {
			delete(l.hits, ip)
		}
	}
}

// Per-server-instance limiters. Sufficient until we go multi-instance,
// at which point Redis-backed limiting is the right move.
var (
	globalRegisterLimiter = newRegisterLimiter(registerRateMax, registerRateWindow)

	// Login rate limit: stricter window than registration because the
	// failure mode is credential stuffing / brute force. 10 attempts
	// per IP per 15 minutes is enough headroom for forgetful operators
	// without making batch enumeration trivial.
	globalLoginLimiter = newRegisterLimiter(10, 15*time.Minute)
)

// StartLimiterCleanup runs forever, pruning expired entries from the
// in-process limiters every 10 minutes. Exposed so main.go can
// launch it as a goroutine at boot.
func StartLimiterCleanup() {
	for {
		time.Sleep(10 * time.Minute)
		globalRegisterLimiter.pruneExpired()
		globalLoginLimiter.pruneExpired()
		globalWalletWriteLimiter.pruneExpired()
	}
}

func clientIP(r *http.Request) string {
	// Honour X-Forwarded-For first (we're behind nginx in prod). Fall
	// back to RemoteAddr. Strip the port if present.
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// First IP in the list is the original client.
		if i := strings.IndexByte(xff, ','); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// shouldRateLimit decides whether to enforce the per-IP limiter for a
// given client. Returns false for loopback + RFC1918 private addresses
// so:
//   - the dev loop (browser → Vite proxy → backend on 127.0.0.1) is
//     never blocked
//   - LAN testing from a phone / Windows laptop on the same private
//     network isn't blocked
//
// Public IPs (real internet traffic) still hit the limit so spam on a
// production deployment is contained.
func shouldRateLimit(ipStr string) bool {
	if ipStr == "" {
		return false
	}
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		return false
	}
	return true
}

// ----- request / response shapes -----

type registerInitReq struct {
	InstitutionName    string `json:"institution_name"`
	InstitutionType    string `json:"institution_type"`
	Tier               string `json:"tier"`
	AisheCode          string `json:"aishe_code"`
	PAN                string `json:"pan"`
	YearEstablished    int    `json:"year_established"`
	AffiliationBody    string `json:"affiliation_body"`

	AddressLine1       string `json:"address_line1"`
	AddressLine2       string `json:"address_line2"`
	City               string `json:"city"`
	District           string `json:"district"`
	State              string `json:"state"`
	PinCode            string `json:"pin_code"`

	ApproxStudentCount int    `json:"approx_student_count"`
	ExpectedCentres    int    `json:"expected_centres"`

	HeadName        string `json:"head_name"`
	HeadDesignation string `json:"head_designation"`
	HeadEmail       string `json:"head_email"`
	HeadMobile      string `json:"head_mobile"`

	// OTP Verification Proof Tokens
	EmailVerificationToken  string `json:"email_otp_token,omitempty"`
	MobileVerificationToken string `json:"mobile_otp_token,omitempty"`

	// Optional — routes this KYC to a specific client's inbox
	// (e.g. NTA reviews its own applications from /client/*). When
	// omitted or 0, the application lands in the legacy superadmin
	// queue (null client_id) and only superadmins can act on it.
	//
	// Server-side we verify the ID exists AND the client has
	// portal_enabled=true, else 400 — we don't want the register form
	// silently routing to a client that can't review.
	ClientID int64 `json:"client_id,omitempty"`

	// Honeypot: legitimate UI never fills this. Bots that submit every
	// field they see will. If non-empty we silently 200 (so the bot
	// thinks it succeeded and doesn't try harder) but skip the insert.
	Website string `json:"website"`
}

type registerInitResp struct {
	ApplicationID int64    `json:"application_id"`
	UploadURL     string   `json:"upload_url"`
	SubmitURL     string   `json:"submit_url"`
	RequiredDocs  []string `json:"required_docs"`
	MaxFileBytes  int      `json:"max_file_bytes"`
}

// ----- POST /api/register/init -----

func (s *Server) registerInit(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if shouldRateLimit(ip) && !globalRegisterLimiter.allow(ip) {
		writeErr(w, http.StatusTooManyRequests, "too many registrations from this network; please try again later")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxInitJSONBytes)
	var req registerInitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	// Honeypot trap: tell the bot it succeeded.
	if strings.TrimSpace(req.Website) != "" {
		writeJSON(w, http.StatusOK, registerInitResp{
			ApplicationID: 0,
			RequiredDocs:  requiredDocKinds,
			MaxFileBytes:  maxFileBytes,
		})
		return
	}

	if err := validateInit(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// Validate OTP proof tokens if OTP store is active
	if s.otpStore != nil && !strings.EqualFold(s.deps.Cfg.AppEnv, "test") {
		// Verify email token
		if req.EmailVerificationToken == "" {
			writeErr(w, http.StatusBadRequest, "Head Email must be verified with OTP before submitting")
			return
		}
		if err := s.otpStore.ValidateProofToken("registration", req.HeadEmail, req.EmailVerificationToken); err != nil {
			writeErr(w, http.StatusBadRequest, "Email verification failed: "+err.Error())
			return
		}

		// Verify mobile token
		if req.MobileVerificationToken == "" {
			writeErr(w, http.StatusBadRequest, "Head Mobile must be verified with OTP before submitting")
			return
		}
		// Normalise mobile for token verification
		mob := strings.TrimSpace(req.HeadMobile)
		if strings.HasPrefix(mob, "+91") {
			mob = strings.TrimPrefix(mob, "+91")
		} else if strings.HasPrefix(mob, "91") && len(mob) == 12 {
			mob = mob[2:]
		}
		if err := s.otpStore.ValidateProofToken("registration", mob, req.MobileVerificationToken); err != nil {
			writeErr(w, http.StatusBadRequest, "Mobile verification failed: "+err.Error())
			return
		}
	}

	// Optional client_id — verify the referenced client is real +
	// portal-enabled before we bind the application to it. Rejecting
	// here beats letting a request slip through with a bogus id that
	// no reviewer can act on.
	if req.ClientID > 0 {
		var portalOn bool
		err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT portal_enabled FROM clients
			  WHERE id = $1 AND visible = 1 AND closed = 0`, req.ClientID,
		).Scan(&portalOn)
		if err != nil || !portalOn {
			writeErr(w, http.StatusBadRequest, "selected exam board is not accepting new registrations")
			return
		}
	}

	// Re-application: if an application exists for this AISHE code and
	// it's not currently pending review, delete it so the new one can
	// take its place. Approved rows are left alone — those institutions
	// are already live and shouldn't be replaceable via re-registration.
	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin")
		return
	}
	defer tx.Rollback()

	if req.AisheCode != "" {
		var existingID int64
		var existingStatus string
		err := tx.QueryRowContext(r.Context(),
			`SELECT id, status FROM institution_applications WHERE aishe_code = $1`,
			req.AisheCode,
		).Scan(&existingID, &existingStatus)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			// Fall through — first application for this AISHE code.
		case err != nil:
			writeErr(w, http.StatusInternalServerError, "db lookup")
			return
		case existingStatus == "approved":
			writeErr(w, http.StatusConflict,
				"this institution is already registered and active; please contact support if you've lost access")
			return
		case existingStatus == "pending":
			writeErr(w, http.StatusConflict,
				"an application for this institution is already under review")
			return
		default:
			// rejected or draft — clean up and replace. CASCADE on
			// institution_application_documents removes the old files
			// from the FK but we still need to delete files from disk.
			if err := s.deleteApplicationDocs(r.Context(), tx, existingID); err != nil {
				writeErr(w, http.StatusInternalServerError, "cleanup old: "+err.Error())
				return
			}
			if _, err := tx.ExecContext(r.Context(),
				`DELETE FROM institution_applications WHERE id = $1`, existingID,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "cleanup old row")
				return
			}
		}
	}

	// PAN uniqueness — mirrors AISHE semantics.
	//   approved / pending  → 409
	//   draft   / rejected  → auto-clean and let the new registration take its slot
	if pan := strings.ToUpper(strings.TrimSpace(req.PAN)); pan != "" {
		var existingID int64
		var existingStatus string
		err := tx.QueryRowContext(r.Context(),
			`SELECT id, status FROM institution_applications WHERE pan = $1`,
			pan,
		).Scan(&existingID, &existingStatus)
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			writeErr(w, http.StatusInternalServerError, "db lookup (pan)")
			return
		case existingStatus == "approved":
			writeErr(w, http.StatusConflict,
				"this PAN is already registered to an active institution")
			return
		case existingStatus == "pending":
			writeErr(w, http.StatusConflict,
				"an application with this PAN is already under review")
			return
		default:
			if err := s.deleteApplicationDocs(r.Context(), tx, existingID); err != nil {
				writeErr(w, http.StatusInternalServerError, "cleanup old (pan): "+err.Error())
				return
			}
			if _, err := tx.ExecContext(r.Context(),
				`DELETE FROM institution_applications WHERE id = $1`, existingID,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "cleanup old row (pan)")
				return
			}
		}
	}

	// Head-email uniqueness — same semantics as PAN.
	if email := strings.ToLower(strings.TrimSpace(req.HeadEmail)); email != "" {
		var existingID int64
		var existingStatus string
		err := tx.QueryRowContext(r.Context(),
			`SELECT id, status FROM institution_applications WHERE head_email = $1`,
			email,
		).Scan(&existingID, &existingStatus)
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			writeErr(w, http.StatusInternalServerError, "db lookup (email)")
			return
		case existingStatus == "approved":
			writeErr(w, http.StatusConflict,
				"this email is already registered to an active institution")
			return
		case existingStatus == "pending":
			writeErr(w, http.StatusConflict,
				"an application with this email is already under review")
			return
		default:
			if err := s.deleteApplicationDocs(r.Context(), tx, existingID); err != nil {
				writeErr(w, http.StatusInternalServerError, "cleanup old (email): "+err.Error())
				return
			}
			if _, err := tx.ExecContext(r.Context(),
				`DELETE FROM institution_applications WHERE id = $1`, existingID,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "cleanup old row (email)")
				return
			}
		}
	}

	var appID int64
	var clientIDArg any
	if req.ClientID > 0 {
		clientIDArg = req.ClientID
	}
	if err := tx.QueryRowContext(r.Context(), `INSERT INTO institution_applications(
		status,
		institution_name, institution_type, tier, aishe_code, pan,
		year_established, affiliation_body,
		address_line1, address_line2, city, district, state, pin_code,
		approx_student_count, expected_centres,
		head_name, head_designation, head_email, head_mobile,
		submitter_ip, client_id
	) VALUES('draft', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
	RETURNING id`,
		strings.TrimSpace(req.InstitutionName), req.InstitutionType,
		nullable(req.Tier), nullable(req.AisheCode), nullable(strings.ToUpper(strings.TrimSpace(req.PAN))),
		nullInt(req.YearEstablished), nullable(req.AffiliationBody),
		strings.TrimSpace(req.AddressLine1), nullable(req.AddressLine2),
		strings.TrimSpace(req.City), nullable(req.District),
		strings.TrimSpace(req.State), strings.TrimSpace(req.PinCode),
		nullInt(req.ApproxStudentCount), maxInt(req.ExpectedCentres, 1),
		strings.TrimSpace(req.HeadName), strings.TrimSpace(req.HeadDesignation),
		strings.ToLower(strings.TrimSpace(req.HeadEmail)), strings.TrimSpace(req.HeadMobile),
		ip, clientIDArg,
	).Scan(&appID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit")
		return
	}

	writeJSON(w, http.StatusCreated, registerInitResp{
		ApplicationID: appID,
		UploadURL:     fmt.Sprintf("/api/register/%d/docs", appID),
		SubmitURL:     fmt.Sprintf("/api/register/%d/submit", appID),
		RequiredDocs:  requiredDocKinds,
		MaxFileBytes:  maxFileBytes,
	})
}

// validateInit enforces required-field + format constraints. Returns
// the first failure as a user-facing error string.
func validateInit(r *registerInitReq) error {
	r.InstitutionName = strings.TrimSpace(r.InstitutionName)
	r.HeadEmail = strings.ToLower(strings.TrimSpace(r.HeadEmail))
	r.HeadMobile = strings.TrimSpace(r.HeadMobile)
	r.PAN = strings.ToUpper(strings.TrimSpace(r.PAN))
	r.AisheCode = strings.TrimSpace(r.AisheCode)
	r.PinCode = strings.TrimSpace(r.PinCode)

	if len(r.InstitutionName) < 3 || len(r.InstitutionName) > 200 {
		return errors.New("institution_name must be 3-200 characters")
	}
	if !allowedInstitutionTypes[r.InstitutionType] {
		return errors.New("institution_type must be college or university")
	}
	// Tier is optional — when supplied it must be one of the known
	// values, but the form no longer requires it.
	if r.Tier != "" && !allowedTiers[r.Tier] {
		return errors.New("tier must be tier_1, tier_2 or tier_3")
	}
	if r.AisheCode == "" {
		return errors.New("aishe_code is required")
	}
	if r.PAN == "" {
		return errors.New("pan is required")
	}
	if !rePAN.MatchString(r.PAN) {
		return errors.New("pan format is invalid (expected ABCDE1234F)")
	}
	if r.HeadName = strings.TrimSpace(r.HeadName); len(r.HeadName) < 2 || len(r.HeadName) > 120 {
		return errors.New("head_name required (2-120 chars)")
	}
	if r.HeadDesignation = strings.TrimSpace(r.HeadDesignation); len(r.HeadDesignation) < 2 {
		return errors.New("head_designation required")
	}
	if !reEmail.MatchString(r.HeadEmail) {
		return errors.New("head_email is not a valid email")
	}
	if !reMobile.MatchString(r.HeadMobile) {
		return errors.New("head_mobile must be a 10-digit Indian mobile starting with 6, 7, 8 or 9")
	}
	if !rePIN.MatchString(r.PinCode) {
		return errors.New("pin_code must be 6 digits")
	}
	if r.AddressLine1 = strings.TrimSpace(r.AddressLine1); r.AddressLine1 == "" {
		return errors.New("address_line1 required")
	}
	if r.City = strings.TrimSpace(r.City); r.City == "" {
		return errors.New("city required")
	}
	if r.State = strings.TrimSpace(r.State); r.State == "" {
		return errors.New("state required")
	}
	// year_established, affiliation_body, approx_student_count are
	// required (form-level mandatory).
	if r.YearEstablished == 0 {
		return errors.New("year_established is required")
	}
	if r.YearEstablished < 1800 || r.YearEstablished > 2100 {
		return errors.New("year_established out of range (1800-2100)")
	}
	if strings.TrimSpace(r.AffiliationBody) == "" {
		return errors.New("affiliation_body is required")
	}
	if r.ApproxStudentCount <= 0 {
		return errors.New("approx_student_count is required")
	}
	if r.ApproxStudentCount > 10_000_000 {
		return errors.New("approx_student_count out of range")
	}
	if r.ExpectedCentres < 0 || r.ExpectedCentres > 1000 {
		return errors.New("expected_centres out of range")
	}
	return nil
}

// ----- POST /api/register/{id}/docs -----

type docUploadResp struct {
	DocID        int64  `json:"doc_id"`
	DocKind      string `json:"doc_kind"`
	OriginalName string `json:"original_name"`
	Mime         string `json:"mime"`
	SizeBytes    int64  `json:"size_bytes"`
	Sha256       string `json:"sha256"`
}

func (s *Server) registerUploadDoc(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid application id")
		return
	}

	// Only draft applications can accept uploads. Once submit() flips it
	// to pending, the upload endpoint refuses further changes so a
	// superadmin reviewing the queue can't see docs mutating under them.
	var status string
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT status FROM institution_applications WHERE id = $1`, appID,
	).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if status != "draft" {
		writeErr(w, http.StatusConflict, "application already submitted; uploads locked")
		return
	}

	// Per-application doc count cap.
	var docCount int
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM institution_application_documents WHERE application_id = $1`, appID,
	).Scan(&docCount)
	if docCount >= maxDocsPerApplication {
		writeErr(w, http.StatusConflict, fmt.Sprintf("at most %d documents per application", maxDocsPerApplication))
		return
	}

	// Cap raw bytes early so a malicious multipart frame can't blow RAM
	// during ParseMultipartForm.
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeErr(w, http.StatusBadRequest, "multipart parse: "+err.Error())
		return
	}

	kind := r.FormValue("doc_kind")
	if !allowedDocKinds[kind] {
		writeErr(w, http.StatusBadRequest, "invalid doc_kind")
		return
	}

	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()

	mime := strings.ToLower(strings.TrimSpace(hdr.Header.Get("Content-Type")))
	if !allowedDocMimes[mime] {
		// Some browsers send weird charset suffixes; strip them.
		if i := strings.IndexByte(mime, ';'); i > 0 {
			mime = strings.TrimSpace(mime[:i])
		}
		if !allowedDocMimes[mime] {
			writeErr(w, http.StatusBadRequest, "only PDF, JPG and PNG are accepted")
			return
		}
	}
	if hdr.Size > maxFileBytes {
		writeErr(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("file exceeds %d MB limit", maxFileBytes>>20))
		return
	}

	dir, fname, fullPath := s.docPath(appID, kind, hdr.Filename)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, http.StatusInternalServerError, "mkdir: "+err.Error())
		return
	}

	// Atomic write: stream into <fullPath>.tmp, fsync, then rename. If
	// we crash mid-write the .tmp is orphaned but the real path never
	// holds a half-file. A reaper could sweep .tmp files later; for now
	// they're harmless leftovers.
	tmpPath := fullPath + ".tmp"
	tmpFile, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create tmp: "+err.Error())
		return
	}
	h := sha256.New()
	// io.MultiWriter teed through hasher → single-pass hash+write.
	written, err := io.Copy(io.MultiWriter(tmpFile, h), file)
	closeErr := tmpFile.Close()
	if err != nil || closeErr != nil {
		os.Remove(tmpPath)
		if err == nil {
			err = closeErr
		}
		writeErr(w, http.StatusInternalServerError, "write: "+err.Error())
		return
	}
	if written > maxFileBytes {
		os.Remove(tmpPath)
		writeErr(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("file exceeds %d MB limit (post-decode)", maxFileBytes>>20))
		return
	}
	if err := os.Rename(tmpPath, fullPath); err != nil {
		os.Remove(tmpPath)
		writeErr(w, http.StatusInternalServerError, "rename: "+err.Error())
		return
	}

	sum := hex.EncodeToString(h.Sum(nil))

	var docID int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`INSERT INTO institution_application_documents(
			application_id, doc_kind, original_name, storage_path,
			mime, size_bytes, sha256
		) VALUES($1,$2,$3,$4,$5,$6,$7)
		RETURNING id`,
		appID, kind, hdr.Filename, fullPath, mime, written, sum,
	).Scan(&docID); err != nil {
		// Roll back the on-disk file so DB + disk stay consistent.
		os.Remove(fullPath)
		writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
		return
	}

	_, _ = s.deps.DB.ExecContext(r.Context(),
		`UPDATE institution_applications SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
		appID,
	)
	_ = fname

	writeJSON(w, http.StatusCreated, docUploadResp{
		DocID:        docID,
		DocKind:      kind,
		OriginalName: hdr.Filename,
		Mime:         mime,
		SizeBytes:    written,
		Sha256:       sum,
	})
}

// docPath shards by app_id / 100 so a single directory never holds
// more than ~100 institution subfolders. Filenames are id_sha8 to
// avoid collisions and never trust the user-supplied filename for
// disk layout (path-traversal defence).
func (s *Server) docPath(appID int64, kind, originalName string) (dir, fname, full string) {
	bucket := appID / 100
	root := filepath.Join(s.deps.Cfg.ArtifactDir, "institution_docs",
		fmt.Sprintf("%04d", bucket), fmt.Sprintf("%d", appID))
	ext := strings.ToLower(filepath.Ext(originalName))
	if ext == "" || len(ext) > 5 {
		ext = ".bin"
	}
	// Random-ish suffix from nanoTime so two uploads with same kind+ext
	// in the same second don't overwrite. We don't have the doc ID yet
	// (DB autoincrement is post-insert), so use a timestamp-derived
	// shard. SHA fixes the actual collision case later.
	fname = fmt.Sprintf("%s_%d%s", kind, time.Now().UnixNano(), ext)
	return root, fname, filepath.Join(root, fname)
}

// ----- DELETE /api/register/{id}/docs/{doc_id} -----

// Lets the registrant remove an uploaded doc before submitting — common
// when they realise they uploaded the wrong file.
func (s *Server) registerDeleteDoc(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid application id")
		return
	}
	docID, err := parseInt64(chi.URLParam(r, "doc_id"))
	if err != nil || docID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid doc id")
		return
	}
	var status, storagePath string
	err = s.deps.DB.QueryRowContext(r.Context(), `
		SELECT a.status, d.storage_path
		  FROM institution_application_documents d
		  JOIN institution_applications a ON a.id = d.application_id
		 WHERE d.id = $1 AND d.application_id = $2`,
		docID, appID,
	).Scan(&status, &storagePath)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "document not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if status != "draft" {
		writeErr(w, http.StatusConflict, "application already submitted; deletes locked")
		return
	}
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`DELETE FROM institution_application_documents WHERE id = $1`, docID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db delete")
		return
	}
	// Best-effort disk cleanup. If it fails the row is gone, so the
	// file becomes orphaned but causes no functional harm.
	_ = os.Remove(storagePath)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true, "doc_id": docID})
}

// ----- POST /api/register/{id}/submit -----

func (s *Server) registerSubmit(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid application id")
		return
	}
	var status string
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT status FROM institution_applications WHERE id = $1`, appID,
	).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if status != "draft" {
		writeErr(w, http.StatusConflict, "application already submitted")
		return
	}

	// Confirm required docs are on file.
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT doc_kind FROM institution_application_documents WHERE application_id = $1`, appID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	have := map[string]bool{}
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		have[k] = true
	}
	rows.Close()
	var missing []string
	for _, k := range requiredDocKinds {
		if !have[k] {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		writeErr(w, http.StatusBadRequest,
			"missing required documents: "+strings.Join(missing, ", "))
		return
	}

	_, err = s.deps.DB.ExecContext(r.Context(),
		`UPDATE institution_applications
		 SET status = 'pending', updated_at = CURRENT_TIMESTAMP
		 WHERE id = $1 AND status = 'draft'`,
		appID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db update")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"application_id": appID,
		"status":         "pending",
		"message":        "Application submitted. You'll hear back within 48 hours by email.",
	})
}

// ----- GET /api/register/{id} (read-back for "Submitted" page) -----

type registerStatusResp struct {
	ApplicationID int64    `json:"application_id"`
	Status        string   `json:"status"`
	Institution   string   `json:"institution_name"`
	HeadEmail     string   `json:"head_email"`
	Docs          []docMin `json:"docs"`
	CreatedAt     string   `json:"created_at"`
}

type docMin struct {
	DocID        int64  `json:"doc_id"`
	DocKind      string `json:"doc_kind"`
	OriginalName string `json:"original_name"`
	SizeBytes    int64  `json:"size_bytes"`
}

func (s *Server) registerStatus(w http.ResponseWriter, r *http.Request) {
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid application id")
		return
	}
	var (
		st        string
		name      string
		email     string
		createdAt time.Time
	)
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT status, institution_name, head_email, created_at
		 FROM institution_applications WHERE id = $1`, appID,
	).Scan(&st, &name, &email, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT id, doc_kind, original_name, size_bytes
		 FROM institution_application_documents
		 WHERE application_id = $1 ORDER BY id`, appID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read docs")
		return
	}
	defer rows.Close()
	docs := []docMin{}
	for rows.Next() {
		var d docMin
		_ = rows.Scan(&d.DocID, &d.DocKind, &d.OriginalName, &d.SizeBytes)
		docs = append(docs, d)
	}
	writeJSON(w, http.StatusOK, registerStatusResp{
		ApplicationID: appID,
		Status:        st,
		Institution:   name,
		HeadEmail:     email,
		Docs:          docs,
		CreatedAt:     createdAt.UTC().Format(time.RFC3339),
	})
}

// ----- helpers -----

// deleteApplicationDocs removes the on-disk files for an application,
// reading their paths from the DB (because CASCADE will drop the rows
// when we delete the parent, but won't touch the disk). Best-effort:
// missing files are ignored.
func (s *Server) deleteApplicationDocs(ctx context.Context, tx *sql.Tx, appID int64) error {
	rows, err := tx.QueryContext(ctx,
		db.Q(`SELECT storage_path FROM institution_application_documents WHERE application_id = $1`),
		appID,
	)
	if err != nil {
		return err
	}
	var paths []string
	for rows.Next() {
		var p string
		_ = rows.Scan(&p)
		paths = append(paths, p)
	}
	rows.Close()
	for _, p := range paths {
		_ = os.Remove(p)
	}
	return nil
}

func nullInt(n int) any {
	if n == 0 {
		return nil
	}
	return n
}

func maxInt(n, min int) int {
	if n < min {
		return min
	}
	return n
}
