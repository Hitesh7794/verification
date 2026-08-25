package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/veni/neet-verification/internal/auth"
)

// parseDateTimeWindow parses ISO/RFC3339 timestamps, HTML5 datetime-local
// strings ("2006-01-02T15:04"), or plain date strings ("2006-01-02").
// If a date-only string is passed and isEnd is true, it defaults the time to
// 23:59:59 UTC so the entire closing day is inclusive.
func parseDateTimeWindow(s string, isEnd bool) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, errors.New("datetime is required")
	}
	formats := []string{
		time.RFC3339,
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04:05",
		"2006-01-02T15:04",
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
		"2006-01-02",
	}
	for _, f := range formats {
		if t, err := time.Parse(f, s); err == nil {
			if f == "2006-01-02" && isEnd {
				t = time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 0, time.UTC)
			}
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid datetime format: %q", s)
}

type ctxKey string

const claimsKey ctxKey = "claims"

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// friendlyServerError is what every 5xx returns to the client. Real
// engineering context (constraint names, driver messages, stack traces)
// stays in the server logs — the user just needs to know that this
// isn't their fault and that a retry is safe.
const friendlyServerError = "Something went wrong on our end. Please try again in a moment."

// retakeSuffixRe strips the mobile retake marker `-r<N>` off the tail
// of an idempotency key. Mobile appends this on every retake so each
// attempt's temp-probe blob lands under its own S3 path (letting
// promoteCaptureBlobs pick the right one), but the liveness_checks
// row is keyed on the BASE session_id — the operator only redoes the
// biometric on a retake, not the blink challenge. Backend gate
// lookups therefore need to strip the suffix before querying.
var retakeSuffixRe = regexp.MustCompile(`-r\d+$`)

// stripRetakeSuffix returns key with any trailing `-r<N>` removed.
// Idempotent on keys that don't have the suffix.
func stripRetakeSuffix(key string) string {
	return retakeSuffixRe.ReplaceAllString(key, "")
}

// writeErr sends {"error": msg} at the given status code. For any 5xx
// status it forces a friendly generic string on the wire and pushes
// the caller's technical detail into the server log, so a stray
// `writeErr(w, 500, "db error: " + err.Error())` can no longer leak
// pg constraint names / driver strings to a non-technical user.
//
// 4xx messages pass through unchanged — those are deliberately
// user-facing copy per handler (uniqueness collisions, validation
// hints, "please verify OTP first" etc.).
func writeErr(w http.ResponseWriter, status int, msg string) {
	if status >= 500 {
		if msg != "" && msg != friendlyServerError {
			log.Printf("[5xx %d] %s", status, msg)
		}
		writeJSON(w, status, map[string]string{"error": friendlyServerError})
		return
	}
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "Your session has expired. Please sign in again.")
			return
		}
		tok := strings.TrimPrefix(h, "Bearer ")
		c, err := s.deps.JWT.Parse(tok)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "Your session has expired. Please sign in again.")
			return
		}

		// Re-check the user against the DB on every request. The JWT
		// proves the holder authenticated at some point in the last
		// 12h, but does NOT prove the account is still valid right
		// now: an admin may have disabled this user, the row may have
		// been deleted, or the user's role may have changed. We pay
		// one indexed-PK lookup per request to keep mid-session
		// revocation actually mean something. Returning 401 (not 403)
		// trips the frontend's auto-logout on the next call.
		var disabledAt sql.NullTime
		var dbRole string
		err = s.deps.DB.QueryRowContext(r.Context(),
			`SELECT role, disabled_at FROM users WHERE id = $1`, c.UserID,
		).Scan(&dbRole, &disabledAt)
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusUnauthorized, "Your account is no longer available. Please contact your administrator.")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "auth check failed")
			return
		}
		if disabledAt.Valid {
			writeErr(w, http.StatusUnauthorized, "Your account has been disabled. Please contact your administrator.")
			return
		}
		if dbRole != c.Role {
			// Role changed since JWT was issued — force re-login so
			// the new role is reflected in the claims.
			writeErr(w, http.StatusUnauthorized, "Your session has expired. Please sign in again.")
			return
		}

		ctx := context.WithValue(r.Context(), claimsKey, c)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func claimsFrom(r *http.Request) *auth.Claims {
	c, _ := r.Context().Value(claimsKey).(*auth.Claims)
	return c
}

func (s *Server) requireRole(roles ...string) func(http.HandlerFunc) http.HandlerFunc {
	return s.requireRoleGated(true, roles...)
}

// requireRoleOpen is requireRole without the KYC-approved gate. Use it
// only for endpoints that need to be reachable BEFORE the org's KYC
// is approved (the kyc-status endpoint, and any read that the lock
// screen legitimately needs). Everything else should use requireRole.
func (s *Server) requireRoleOpen(roles ...string) func(http.HandlerFunc) http.HandlerFunc {
	return s.requireRoleGated(false, roles...)
}

// requireRoleGated is the shared implementation. When kycGate is true
// (the default via requireRole), admin and client callers must belong
// to an org whose linked institution_application is status='approved'.
// A pending / rejected KYC returns 403 with a machine-readable
// x-kyc-state header so the FE lock screen can render the right copy.
// Roles that don't carry an org (superadmin, ops_admin, client_reviewer)
// always bypass the KYC check — it doesn't apply to them.
func (s *Server) requireRoleGated(kycGate bool, roles ...string) func(http.HandlerFunc) http.HandlerFunc {
	allowed := map[string]bool{}
	for _, r := range roles {
		allowed[r] = true
	}
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			c := claimsFrom(r)
			if c == nil || !allowed[c.Role] {
				writeErr(w, http.StatusForbidden, "You don't have access to that.")
				return
			}
			if kycGate && (c.Role == "admin" || c.Role == "client") && c.OrgID != nil {
				state, _ := s.orgKYCState(r.Context(), *c.OrgID)
				// state == 'approved' → pass. Everything else → block.
				// 'unknown' means the org has no linked application (legacy
				// pre-V17 or seeded via superadmin bulk); treat as approved
				// so those flows keep working without a migration script.
				if state != "" && state != "approved" && state != "unknown" {
					w.Header().Set("x-kyc-state", state)
					writeErr(w, http.StatusForbidden,
						"Your institution's KYC review is "+state+". Access unlocks once it is approved.")
					return
				}
			}
			next(w, r)
		}
	}
}

// orgKYCState resolves the KYC review state for a given org by
// following organizations.application_id → institution_applications.
// Returns "" on DB error (which the caller treats as a soft-pass so
// a transient blip doesn't lock every admin out).
func (s *Server) orgKYCState(ctx context.Context, orgID int64) (string, error) {
	var status string
	err := s.deps.DB.QueryRowContext(ctx, `
		SELECT COALESCE(a.status, 'unknown')
		  FROM organizations o
		  LEFT JOIN institution_applications a ON a.id = o.application_id
		 WHERE o.id = $1`, orgID,
	).Scan(&status)
	if err != nil {
		return "", err
	}
	return status, nil
}
