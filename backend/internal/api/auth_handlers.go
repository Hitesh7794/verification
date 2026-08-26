package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/db"
	"github.com/veni/neet-verification/internal/email"
	"github.com/veni/neet-verification/internal/magiclink"
)

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	// Per-IP login rate limiter disabled per operator request -- the
	// limit was tripping demo + password-reset loops from public IPs.
	// Credential stuffing defence is now down to bcrypt cost + password
	// strength; if this becomes an issue in real deployments, restore
	// the guard from git or gate it on a role-agnostic soft threshold
	// (e.g. 100 attempts / 15 min) instead of the earlier 10 / 15 min.

	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var (
		id             int64
		passHash       string
		role           string
		orgID          sql.NullInt64
		clientID       sql.NullInt64
		displayName    string
		disabledAt     sql.NullTime
		passChangeReq  int
		actualUsername string
	)
	// The identifier can be either a username (case-sensitive) OR an
	// email (case-insensitive, admin/client/client_reviewer roles).
	// Superadmin stays username-only — that account has no email on
	// file by design. The DB stores emails lowercase, so we normalise
	// the email side of the OR to match.
	identifier := strings.TrimSpace(req.Username)
	emailLower := strings.ToLower(identifier)
	err := s.deps.DB.QueryRowContext(r.Context(), db.Q(
		`SELECT id, password_hash, role, org_id, display_name,
		        disabled_at, password_change_required, username, client_id
		   FROM users
		  WHERE username = ?
		     OR (email = ? AND role IN ('admin','client','client_reviewer'))
		  LIMIT 1`),
		identifier, emailLower,
	).Scan(&id, &passHash, &role, &orgID, &displayName,
		&disabledAt, &passChangeReq, &actualUsername, &clientID)
	if err == sql.ErrNoRows {
		s.auditAnonymous(r, "login.failure", map[string]any{
			"username": req.Username, "reason": "unknown_user",
		})
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		log.Printf("login query error: %v", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passHash), []byte(req.Password)) != nil {
		s.auditAnonymous(r, "login.failure", map[string]any{
			"username": req.Username, "reason": "bad_password",
		})
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	// Disabled accounts: still verify password first so an attacker
	// can't enumerate enabled-vs-disabled accounts by timing differences
	// (constant-time bcrypt either way). Then refuse with a distinct
	// 403 so the legitimate user knows the account exists but is
	// blocked, not that their credentials are wrong.
	if disabledAt.Valid {
		writeErr(w, http.StatusForbidden, "account disabled — contact your administrator")
		return
	}

	claims := auth.Claims{
		UserID:   id,
		Username: actualUsername, // canonical from DB, not the raw input
		Role:     role,
	}
	if orgID.Valid {
		v := orgID.Int64
		claims.OrgID = &v
	}
	if clientID.Valid {
		v := clientID.Int64
		claims.ClientID = &v
	}
	tok, err := s.deps.JWT.Issue(claims)
	if err != nil {
		log.Printf("login token issue error: %v", err)
		writeErr(w, http.StatusInternalServerError, "token error")
		return
	}

	s.audit(r.Context(), &claims, "login.success", "user", id, clientIP(r), nil)

	writeJSON(w, http.StatusOK, map[string]any{
		"token": tok,
		"user": map[string]any{
			"id":                       id,
			"username":                 actualUsername,
			"role":                     role,
			"display_name":             displayName,
			"org_id":                   claims.OrgID,
			"client_id":                claims.ClientID,
			"password_change_required": passChangeReq != 0,
		},
	})
}

// changePasswordReq is the body for self-service password change.
// Both fields are required; the current_password proves the caller
// holds the existing credential (defence against a stolen JWT being
// used to lock the legitimate owner out of their account).
type changePasswordReq struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// POST /api/me/change-password
//
// Any logged-in user can rotate their own password without going
// through a magic link. Used by superadmin on first prod login
// (to change away from the seeded super123) and by admin/operator
// users any time. The new password takes effect on the next login;
// the existing JWT stays valid until its 12h expiry, so concurrent
// sessions are not kicked.
//
// For shared client-role users whose password_plaintext is stored
// (so the admin dashboard can display it), we update plaintext too
// — otherwise the admin's "Operator access" view would show a stale
// password. Admin / superadmin / ops_admin password_plaintext stays
// NULL by design (these accounts go through bcrypt-only).
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req changePasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.CurrentPassword == "" {
		writeErr(w, http.StatusBadRequest, "current_password required")
		return
	}
	if err := validatePassword(req.NewPassword); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// Verify current_password against the stored bcrypt hash. We
	// also re-read role + plaintext-presence so we know whether to
	// sync the plaintext column on update.
	var (
		currentHash      string
		role             string
		plaintextPresent bool
	)
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT password_hash, role, password_plaintext IS NOT NULL
		 FROM users WHERE id = $1`,
		c.UserID,
	).Scan(&currentHash, &role, &plaintextPresent)
	if err == sql.ErrNoRows {
		writeErr(w, http.StatusUnauthorized, "account no longer exists")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(req.CurrentPassword)) != nil {
		writeErr(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bcrypt: "+err.Error())
		return
	}

	// Sync plaintext only when it was already populated (shared
	// operator). For admin / superadmin / ops_admin we keep
	// plaintext NULL — these accounts go through bcrypt-only.
	// Also clear password_change_required: if the user was being
	// forced to rotate the seeded default, this is the moment that
	// gate drops.
	if plaintextPresent {
		_, err = s.deps.DB.ExecContext(r.Context(),
			`UPDATE users
			 SET password_hash = $1, password_plaintext = $2, password_change_required = 0
			 WHERE id = $3`,
			string(newHash), req.NewPassword, c.UserID,
		)
	} else {
		_, err = s.deps.DB.ExecContext(r.Context(),
			`UPDATE users
			 SET password_hash = $1, password_change_required = 0
			 WHERE id = $2`,
			string(newHash), c.UserID,
		)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	s.auditFromRequest(r, "password.change", "user", c.UserID, nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var displayName string
	var passChangeReq int
	var clientID sql.NullInt64
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT display_name, password_change_required, client_id FROM users WHERE id=$1`, c.UserID,
	).Scan(&displayName, &passChangeReq, &clientID)
	resolvedClientID := c.ClientID
	if resolvedClientID == nil && clientID.Valid {
		v := clientID.Int64
		resolvedClientID = &v
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":                       c.UserID,
		"username":                 c.Username,
		"role":                     c.Role,
		"display_name":             displayName,
		"org_id":                   c.OrgID,
		"client_id":                resolvedClientID,
		"password_change_required": passChangeReq != 0,
	})
}

// authRefresh mints a fresh JWT for the calling user without requiring
// them to re-enter credentials. Same shape as /api/auth/login on success.
//
// Long-lived clients (the Android verification-agent app) call this when
// their token is within a few hours of expiry so a shift at the exam
// centre doesn't get kicked back to the login screen mid-verification.
//
// Re-verifies from the DB every call so a disabled account or a
// reviewer whose client's portal was flipped off can't extend their
// session past those events.
func (s *Server) authRefresh(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	if c == nil {
		writeErr(w, http.StatusUnauthorized, "auth required")
		return
	}

	var (
		actualUsername string
		role           string
		displayName    string
		disabledAt     sql.NullTime
		orgID          sql.NullInt64
		clientID       sql.NullInt64
	)
	if err := s.deps.DB.QueryRowContext(r.Context(), db.Q(
		`SELECT username, role, COALESCE(display_name, username),
		        disabled_at, org_id, client_id
		 FROM users WHERE id = ?`), c.UserID,
	).Scan(&actualUsername, &role, &displayName, &disabledAt, &orgID, &clientID); err != nil {
		writeErr(w, http.StatusUnauthorized, "user not found")
		return
	}
	if disabledAt.Valid {
		writeErr(w, http.StatusForbidden, "account disabled")
		return
	}

	claims := auth.Claims{
		UserID:   c.UserID,
		Username: actualUsername,
		Role:     role,
	}
	if orgID.Valid {
		v := orgID.Int64
		claims.OrgID = &v
	}
	if clientID.Valid {
		v := clientID.Int64
		claims.ClientID = &v
	}
	tok, err := s.deps.JWT.Issue(claims)
	if err != nil {
		log.Printf("authRefresh token issue error: %v", err)
		writeErr(w, http.StatusInternalServerError, "token error")
		return
	}

	s.audit(r.Context(), &claims, "auth.refresh", "user", c.UserID, clientIP(r), nil)

	writeJSON(w, http.StatusOK, map[string]any{
		"token": tok,
		"user": map[string]any{
			"id":           c.UserID,
			"username":     actualUsername,
			"role":         role,
			"display_name": displayName,
			"org_id":       claims.OrgID,
			"client_id":    claims.ClientID,
		},
	})
}

type forgotPasswordReq struct {
	Email string `json:"email"`
	Role  string `json:"role,omitempty"`
}

// POST /api/auth/forgot-password
// Generates a one-time password reset link for the user and emails it.
func (s *Server) forgotPassword(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if shouldRateLimit(ip) && !globalRegisterLimiter.allow(ip) {
		writeErr(w, http.StatusTooManyRequests, "too many attempts; try again later")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req forgotPasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	input := strings.TrimSpace(req.Email)
	if input == "" {
		writeErr(w, http.StatusBadRequest, "email or username required")
		return
	}

	inputLower := strings.ToLower(input)
	roleFilter := strings.TrimSpace(req.Role)

	var (
		userID      int64
		username    string
		displayName string
		emailAddr   sql.NullString
		userRole    string
		disabledAt  sql.NullTime
	)

	query := `SELECT id, username, display_name, email, role, disabled_at
	            FROM users
	           WHERE (LOWER(email) = $1 OR LOWER(username) = $1)`
	args := []any{inputLower}

	if roleFilter != "" {
		query += ` AND role = $2`
		args = append(args, roleFilter)
	} else {
		query += ` AND role IN ('admin', 'client_reviewer', 'client', 'superadmin', 'ops_admin')`
	}
	query += ` LIMIT 1`

	err := s.deps.DB.QueryRowContext(r.Context(), query, args...).Scan(
		&userID, &username, &displayName, &emailAddr, &userRole, &disabledAt,
	)

	// If user exists, is not disabled, and has a registered email -> send reset token
	if err == nil && !disabledAt.Valid && emailAddr.Valid && strings.TrimSpace(emailAddr.String) != "" {
		token, genErr := s.magicLinks.Generate(r.Context(), userID, magiclink.PurposeResetPassword, 2*time.Hour)
		if genErr == nil && s.emailer != nil {
			resetURL := s.buildResetPasswordURL(r, token)
			subject := "Reset your Verification Portal password"
			body := fmt.Sprintf("Hello %s,\n\nWe received a request to reset the password for your account (%s).\n\nClick the link below to set a new password:\n%s\n\nThis link is valid for 2 hours. If you did not request a password reset, you can safely ignore this email.\n\n— Verification Portal Team",
				displayName, username, resetURL)

			_ = s.emailer.Send(r.Context(), email.Message{
				To:      emailAddr.String,
				Subject: subject,
				Body:    body,
			})

			s.auditAnonymous(r, "auth.forgot_password_requested", map[string]any{
				"user_id": userID,
				"role":    userRole,
				"email":   emailAddr.String,
			})
		}
	}

	// Always return generic safe message to prevent email enumeration
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "If an account matching this email or username exists, a password reset link has been sent to the registered email address.",
	})
}

// buildResetPasswordURL composes the URL the recipient clicks to reset their password.
func (s *Server) buildResetPasswordURL(r *http.Request, token string) string {
	path := "/reset-password?token=" + token
	if base := s.deps.Cfg.PublicBaseURL; base != "" {
		return strings.TrimRight(base, "/") + path
	}
	if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" {
		scheme := r.Header.Get("X-Forwarded-Proto")
		if scheme == "" {
			scheme = "https"
		}
		return scheme + "://" + fwdHost + path
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		return scheme + "://" + r.Host + path
	}
	return strings.TrimRight(origin, "/") + path
}
