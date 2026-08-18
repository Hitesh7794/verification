package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/magiclink"
)

// Public endpoints backing the magic-link landing page.
//
//   GET  /api/set-password/verify?token=...  → check token & return who it's for
//   POST /api/set-password                   → consume token + set password
//
// Both rate-limited per IP via the same limiter the register endpoints
// use, so a leaked token can't be brute-force-guessed at scale.

type setPasswordVerifyResp struct {
	Valid       bool   `json:"valid"`
	Username    string `json:"username,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
}

// GET /api/set-password/verify?token=...
func (s *Server) setPasswordVerify(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if shouldRateLimit(ip) && !globalRegisterLimiter.allow(ip) {
		writeErr(w, http.StatusTooManyRequests, "too many attempts; try again later")
		return
	}
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		writeErr(w, http.StatusBadRequest, "token required")
		return
	}
	link, err := s.magicLinks.Verify(r.Context(), token, magiclink.PurposeSetPassword)
	if errors.Is(err, magiclink.ErrInvalid) {
		// Always return the same JSON shape so the frontend can show a
		// clean "this link is no longer valid" message without exposing
		// the precise reason.
		writeJSON(w, http.StatusOK, setPasswordVerifyResp{Valid: false})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "verify error")
		return
	}
	var username, displayName string
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT username, display_name FROM users WHERE id = $1`, link.UserID,
	).Scan(&username, &displayName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusOK, setPasswordVerifyResp{Valid: false})
			return
		}
		writeErr(w, http.StatusInternalServerError, "user read")
		return
	}
	writeJSON(w, http.StatusOK, setPasswordVerifyResp{
		Valid:       true,
		Username:    username,
		DisplayName: displayName,
	})
}

type setPasswordReq struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

// POST /api/set-password
//
// Consumes the token atomically with the password update inside one
// DB transaction. If anything fails — bcrypt blow-up, DB error — the
// token stays usable for a retry. Once committed, the link is dead.
func (s *Server) setPassword(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if shouldRateLimit(ip) && !globalRegisterLimiter.allow(ip) {
		writeErr(w, http.StatusTooManyRequests, "too many attempts; try again later")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req setPasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" {
		writeErr(w, http.StatusBadRequest, "token required")
		return
	}
	if err := validatePassword(req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bcrypt")
		return
	}

	err = s.magicLinks.Consume(r.Context(), req.Token, magiclink.PurposeSetPassword,
		func(tx *sql.Tx, userID int64) error {
			// Stamp activated_at on first password set so the admin's
			// operator list can distinguish "Pending invite" from
			// "Active" without inspecting bcrypt hashes. Idempotent:
			// COALESCE preserves the original activation time on
			// password *resets* (when activated_at is already set).
			_, err := tx.ExecContext(r.Context(),
				`UPDATE users
				 SET password_hash = $1,
				     activated_at  = COALESCE(activated_at, CURRENT_TIMESTAMP)
				 WHERE id = $2`,
				string(hash), userID,
			)
			return err
		})
	if errors.Is(err, magiclink.ErrInvalid) {
		writeErr(w, http.StatusBadRequest, "link is invalid or expired")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "set password failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "Password set. Sign in at /admin/login.",
	})
}

// validatePassword: minimum 10 chars, at most 200, must contain a letter
// and a digit. Deliberately not too strict — the head of an institution
// shouldn't need a password manager to comply.
func validatePassword(p string) error {
	if len(p) < 10 {
		return errors.New("password must be at least 10 characters")
	}
	if len(p) > 200 {
		return errors.New("password too long")
	}
	hasLetter, hasDigit := false, false
	for _, c := range p {
		switch {
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
			hasLetter = true
		case c >= '0' && c <= '9':
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return errors.New("password must contain at least one letter and one digit")
	}
	return nil
}
