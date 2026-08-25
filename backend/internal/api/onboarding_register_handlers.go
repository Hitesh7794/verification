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

	// institution_type used to be a fixed enum enforced by both this map
	// and a DB CHECK constraint. V8 (2026-08-20) dropped the CHECK to let
	// users type a custom value when they pick "Other" in the register
	// form, so the allowlist here was dropped too — validateInit now
	// only checks length. See project_snapshot.md V8 notes.
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
	reTAN    = regexp.MustCompile(`^[A-Z]{4}[0-9]{5}[A-Z]$`)
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

// ----- POST /api/register/check -----

type checkIdentifiersReq struct {
	AisheCode string `json:"aishe_code"`
	PAN       string `json:"pan"`
	Email     string `json:"email"`
	Mobile    string `json:"mobile"`
}

type checkFieldResult struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

type checkIdentifiersResp struct {
	AisheCode *checkFieldResult `json:"aishe_code,omitempty"`
	PAN       *checkFieldResult `json:"pan,omitempty"`
	Email     *checkFieldResult `json:"email,omitempty"`
	Mobile    *checkFieldResult `json:"mobile,omitempty"`
}

func (s *Server) registerCheckIdentifiers(w http.ResponseWriter, r *http.Request) {
	var req checkIdentifiersReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}

	resp := checkIdentifiersResp{}

	if aishe := strings.TrimSpace(req.AisheCode); aishe != "" {
		var status string
		err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT status FROM institution_applications WHERE LOWER(TRIM(aishe_code)) = LOWER(TRIM($1)) AND status IN ('approved', 'pending') LIMIT 1`,
			aishe,
		).Scan(&status)
		if err == nil {
			if status == "approved" {
				resp.AisheCode = &checkFieldResult{
					Available: false,
					Reason:    "This AISHE / Ref code is already registered to an active institution.",
				}
			} else {
				resp.AisheCode = &checkFieldResult{
					Available: false,
					Reason:    "An application with this AISHE / Ref code is already under review.",
				}
			}
		} else {
			resp.AisheCode = &checkFieldResult{Available: true}
		}
	}

	if pan := strings.ToUpper(strings.TrimSpace(req.PAN)); pan != "" {
		var status string
		err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT status FROM institution_applications WHERE UPPER(TRIM(pan)) = UPPER(TRIM($1)) AND status IN ('approved', 'pending') LIMIT 1`,
			pan,
		).Scan(&status)
		if err == nil {
			if status == "approved" {
				resp.PAN = &checkFieldResult{
					Available: false,
					Reason:    "This PAN / TAN is already registered to an active institution.",
				}
			} else {
				resp.PAN = &checkFieldResult{
					Available: false,
					Reason:    "An application with this PAN / TAN is already under review.",
				}
			}
		} else {
			resp.PAN = &checkFieldResult{Available: true}
		}
	}

	if email := strings.ToLower(strings.TrimSpace(req.Email)); email != "" {
		var status string
		// 1. Check existing active users
		var userID int64
		err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT id FROM users WHERE LOWER(TRIM(email)) = $1 AND disabled_at IS NULL LIMIT 1`,
			email,
		).Scan(&userID)
		if err == nil {
			resp.Email = &checkFieldResult{
				Available: false,
				Reason:    "This email is already registered to an active institution administrator.",
			}
		} else {
			// 2. Check institution applications
			err = s.deps.DB.QueryRowContext(r.Context(),
				`SELECT status FROM institution_applications WHERE LOWER(TRIM(head_email)) = $1 AND status IN ('approved', 'pending') LIMIT 1`,
				email,
			).Scan(&status)
			if err == nil {
				if status == "approved" {
					resp.Email = &checkFieldResult{
						Available: false,
						Reason:    "This email is already registered to an active institution.",
					}
				} else {
					resp.Email = &checkFieldResult{
						Available: false,
						Reason:    "An application with this email is already under review.",
					}
				}
			} else {
				resp.Email = &checkFieldResult{Available: true}
			}
		}
	}

	if mobile := strings.TrimSpace(req.Mobile); mobile != "" {
		if strings.HasPrefix(mobile, "+91") {
			mobile = strings.TrimPrefix(mobile, "+91")
		} else if strings.HasPrefix(mobile, "91") && len(mobile) == 12 {
			mobile = mobile[2:]
		}
		mobile = strings.TrimSpace(mobile)

		var status string
		err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT status FROM institution_applications 
			 WHERE (head_mobile = $1 OR head_mobile = '+91' || $1 OR head_mobile = '91' || $1) 
			   AND status IN ('approved', 'pending') 
			 LIMIT 1`,
			mobile,
		).Scan(&status)
		if err == nil {
			if status == "approved" {
				resp.Mobile = &checkFieldResult{
					Available: false,
					Reason:    "This mobile number is already registered to an active institution admin.",
				}
			} else {
				resp.Mobile = &checkFieldResult{
					Available: false,
					Reason:    "An application with this mobile number is already under review.",
				}
			}
		} else {
			resp.Mobile = &checkFieldResult{Available: true}
		}
	}

	writeJSON(w, http.StatusOK, resp)
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
		// 1. Check existing active users
		var existingUserID int64
		err := tx.QueryRowContext(r.Context(),
			`SELECT id FROM users WHERE LOWER(TRIM(email)) = $1 AND disabled_at IS NULL LIMIT 1`,
			email,
		).Scan(&existingUserID)
		if err == nil {
			writeErr(w, http.StatusConflict,
				"this email is already registered to an active institution administrator")
			return
		}

		// 2. Check institution_applications
		var existingID int64
		var existingStatus string
		err = tx.QueryRowContext(r.Context(),
			`SELECT id, status FROM institution_applications WHERE LOWER(TRIM(head_email)) = $1`,
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

	// Head-mobile uniqueness — same semantics as PAN and email.
	// Must be unique across approved or pending institution applications.
	if mobile := strings.TrimSpace(req.HeadMobile); mobile != "" {
		if strings.HasPrefix(mobile, "+91") {
			mobile = strings.TrimPrefix(mobile, "+91")
		} else if strings.HasPrefix(mobile, "91") && len(mobile) == 12 {
			mobile = mobile[2:]
		}
		mobile = strings.TrimSpace(mobile)
		req.HeadMobile = mobile

		var existingID int64
		var existingStatus string
		err := tx.QueryRowContext(r.Context(),
			`SELECT id, status FROM institution_applications WHERE head_mobile = $1`,
			mobile,
		).Scan(&existingID, &existingStatus)
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			writeErr(w, http.StatusInternalServerError, "db lookup (mobile)")
			return
		case existingStatus == "approved":
			writeErr(w, http.StatusConflict,
				"this mobile number is already registered to an active institution admin")
			return
		case existingStatus == "pending":
			writeErr(w, http.StatusConflict,
				"an application with this mobile number is already under review")
			return
		default:
			if err := s.deleteApplicationDocs(r.Context(), tx, existingID); err != nil {
				writeErr(w, http.StatusInternalServerError, "cleanup old (mobile): "+err.Error())
				return
			}
			if _, err := tx.ExecContext(r.Context(),
				`DELETE FROM institution_applications WHERE id = $1`, existingID,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "cleanup old row (mobile)")
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

	// Normalize institution_type so casing / whitespace variants of the
	// same free-text bucket collapse to one DB value. Since V8 dropped
	// the CHECK enum, "IIT College", "iit college", "IIT  college" would
	// otherwise be three distinct rows.
	r.InstitutionType = strings.ToLower(strings.TrimSpace(r.InstitutionType))
	r.InstitutionType = strings.Join(strings.Fields(r.InstitutionType), " ")
	if len(r.InstitutionName) < 3 || len(r.InstitutionName) > 200 {
		return errors.New("institution_name must be 3-200 characters")
	}
	if r.InstitutionType == "" || len(r.InstitutionType) > 80 {
		return errors.New("institution_type is required (up to 80 characters)")
	}
	// Tier is optional — when supplied it must be one of the known
	// values, but the form no longer requires it.
	if r.Tier != "" && !allowedTiers[r.Tier] {
		return errors.New("tier must be tier_1, tier_2 or tier_3")
	}
	isAcademic := r.InstitutionType == "college" || r.InstitutionType == "university"
	if isAcademic {
		if r.AisheCode == "" {
			return errors.New("aishe_code is required")
		}
		if strings.TrimSpace(r.AffiliationBody) == "" {
			return errors.New("affiliation_body is required")
		}
		if r.ApproxStudentCount <= 0 {
			return errors.New("approx_student_count is required")
		}
	} else {
		if r.AisheCode == "" {
			return errors.New("registration / establishment reference number is required")
		}
		if strings.TrimSpace(r.AffiliationBody) == "" {
			r.AffiliationBody = "Government / Recruitment Body"
		}
		if r.ApproxStudentCount <= 0 {
			r.ApproxStudentCount = 1000
		}
	}
	if r.PAN == "" {
		return errors.New("pan is required")
	}
	if !rePAN.MatchString(r.PAN) && !reTAN.MatchString(r.PAN) {
		return errors.New("pan/tan format is invalid (expected PAN: ABCDE1234F or TAN: ABCD12345E)")
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
	r.District = strings.TrimSpace(r.District)
	r.City = strings.TrimSpace(r.City)
	if r.District == "" && r.City == "" {
		return errors.New("district required")
	}
	if r.District == "" {
		r.District = r.City
	}
	if r.City == "" {
		r.City = r.District
	}
	if r.State = strings.TrimSpace(r.State); r.State == "" {
		return errors.New("state required")
	}
	// year_established is required (form-level mandatory).
	if r.YearEstablished == 0 {
		return errors.New("year_established is required")
	}
	if r.YearEstablished < 1800 || r.YearEstablished > 2100 {
		return errors.New("year_established out of range (1800-2100)")
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

	// storage_path is what download handlers switch on:
	//   "s3://…"  → new S3-backed row (fetched via storage.GetDocBytes)
	//   "/…"      → legacy disk row  (fetched via os.Open)
	// New rows go straight to S3 when the bucket is configured. Insert
	// with the disk path first, then flip to s3:// after a successful
	// upload so a mid-flight failure leaves the row pointing at bytes
	// that actually exist.
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

	if s.storage != nil && s.storage.Enabled() {
		body, rerr := os.ReadFile(fullPath)
		if rerr != nil {
			fmt.Fprintf(os.Stderr,
				"kyc upload: read local file for s3 mirror failed doc=%d: %v\n",
				docID, rerr)
		} else {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(hdr.Filename), "."))
			uri, perr := s.storage.PutDoc(ctx, appID, docID, kind, ext, body, mime)
			cancel()
			if perr != nil {
				fmt.Fprintf(os.Stderr,
					"kyc upload: s3 put failed doc=%d: %v — leaving row on disk\n",
					docID, perr)
			} else {
				// Flip the DB pointer to S3, then drop the local copy.
				// If the UPDATE fails, we leave both copies alive so the
				// disk row keeps serving until the next upload retries.
				if _, uerr := s.deps.DB.ExecContext(r.Context(),
					`UPDATE institution_application_documents
					    SET storage_path = $1
					  WHERE id = $2`,
					uri, docID,
				); uerr != nil {
					fmt.Fprintf(os.Stderr,
						"kyc upload: db update to s3 uri failed doc=%d: %v\n",
						docID, uerr)
				} else {
					_ = os.Remove(fullPath)
				}
			}
		}
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
	// Best-effort object cleanup. If it fails the row is already gone,
	// so the file becomes orphaned but causes no functional harm.
	// Discriminate on the s3:// prefix — S3-backed rows go via the
	// storage client, disk rows via os.Remove.
	if strings.HasPrefix(storagePath, "s3://") {
		if s.storage != nil && s.storage.Enabled() {
			ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
			_ = s.storage.DeleteDoc(ctx, storagePath)
			cancel()
		}
	} else {
		_ = os.Remove(storagePath)
	}
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

	// Auto-attach + queue routing (2026-08-25 rebuild — no manual
	// route-to-client step any more). If the app already carries a
	// client_id (deep-linked registration) we respect it; otherwise
	// we look for the single visible+open+portal-enabled client on
	// the platform and attach to that. Single-client model is the
	// intended production shape right now; the fallback keeps the
	// system quiet if 0 or >1 candidates exist.
	//
	//   mode 'admin'  → pending_reviewer='admin'  (superadmin only)
	//   mode 'client' → pending_reviewer='client' (client reviewer only)
	//   mode 'both'   → pending_reviewer='admin'  (superadmin first, then hands off)
	//   no client_id  → pending_reviewer='admin'  (safety net; UI treats as legacy)
	pendingReviewer := "admin"
	var clientID sql.NullInt64
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT client_id FROM institution_applications WHERE id = $1`, appID,
	).Scan(&clientID)
	if !clientID.Valid {
		// Pick the sole eligible client. COUNT(*) matters: with more
		// than one visible+open client we can't tell which board the
		// applicant belongs to, so we leave client_id NULL.
		//
		// portal_enabled deliberately IS NOT in the filter: it gates
		// the reviewer's LOGIN when the platform team temporarily
		// disables a client, not whether new applications should
		// route to that client. A portal-disabled client can still
		// own its incoming KYCs; superadmin can act on them via the
		// admin queue while the client reviewer is offline.
		var count int
		var candidate int64
		if err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT COUNT(*), COALESCE(MIN(id), 0)
			   FROM clients
			  WHERE visible = 1 AND closed = 0`,
		).Scan(&count, &candidate); err == nil && count == 1 && candidate > 0 {
			clientID = sql.NullInt64{Int64: candidate, Valid: true}
		}
	}
	if clientID.Valid {
		var mode string
		if err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT kyc_review_mode FROM clients WHERE id = $1`, clientID.Int64,
		).Scan(&mode); err == nil && mode == "client" {
			pendingReviewer = "client"
		}
	}

	// UPDATE sets client_id AND pending_reviewer in one shot. When the
	// row already had a client_id, the coalesce leaves it alone.
	var clientIDArg any
	if clientID.Valid {
		clientIDArg = clientID.Int64
	}
	_, err = s.deps.DB.ExecContext(r.Context(),
		`UPDATE institution_applications
		 SET status = 'pending',
		     pending_reviewer = $2,
		     client_id = COALESCE(client_id, $3),
		     updated_at = CURRENT_TIMESTAMP
		 WHERE id = $1 AND status = 'draft'`,
		appID, pendingReviewer, clientIDArg,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db update")
		return
	}

	// 2026-08-25 rebuild: provision the org + admin user + magic link
	// at submit time (not at approve time). The applicant can log in
	// during the pending window; the frontend's KYC gate keeps them on
	// the lock screen until the review lands. If provisioning fails,
	// we don't roll back the pending flip — the applicant is still in
	// the queue and superadmin can trigger a resend from ApplicationDetail.
	prov, provErr := s.provisionOrgAndAdmin(r, appID, true)
	resp := map[string]any{
		"application_id":   appID,
		"status":           "pending",
		"pending_reviewer": pendingReviewer,
		"message":          "Application submitted. Check your email for a link to set your password and sign in.",
	}
	if provErr != nil {
		// Log but don't fail the submit — the row is safe as-is.
		fmt.Printf("registerSubmit: provisionOrgAndAdmin failed app=%d: %v\n", appID, provErr)
	} else if prov != nil {
		// Echo the magic link URL so the FE's "submitted" page can
		// deep-link the applicant into set-password in dev, and so
		// integration tests can pick it up without hitting logs.
		resp["admin_username"] = prov.AdminUsername
		resp["magic_link_url"] = prov.MagicLinkURL
	}
	writeJSON(w, http.StatusOK, resp)
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
