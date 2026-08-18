package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/auth"
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
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id, password_hash, role, org_id, client_id, display_name,
		        disabled_at, password_change_required, username
		   FROM users
		  WHERE username = $1
		     OR (email = $2 AND role IN ('admin','client','client_reviewer'))
		  LIMIT 1`,
		identifier, emailLower,
	).Scan(&id, &passHash, &role, &orgID, &clientID, &displayName,
		&disabledAt, &passChangeReq, &actualUsername)
	if err == sql.ErrNoRows {
		s.auditAnonymous(r, "login.failure", map[string]any{
			"username": req.Username, "reason": "unknown_user",
		})
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
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
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT display_name, password_change_required FROM users WHERE id=$1`, c.UserID,
	).Scan(&displayName, &passChangeReq)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":                       c.UserID,
		"username":                 c.Username,
		"role":                     c.Role,
		"display_name":             displayName,
		"org_id":                   c.OrgID,
		"client_id":                c.ClientID,
		"password_change_required": passChangeReq != 0,
	})
}
