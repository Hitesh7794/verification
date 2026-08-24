package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/veni/neet-verification/internal/auth"
)

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
			next(w, r)
		}
	}
}
