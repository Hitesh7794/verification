package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"golang.org/x/crypto/bcrypt"
)

// Admin "operator access" endpoints. Every org has one shared client-role
// user that every operator machine at the institution signs in with. The
// admin needs to:
//
//   - GET /api/admin/operator-access            — view current credentials
//   - POST /api/admin/operator-access/reset     — generate a new password
//   - POST /api/admin/operator-access/disable   — temporarily revoke access
//   - POST /api/admin/operator-access/enable    — restore access
//
// All endpoints are strictly org-scoped via the admin's JWT claims.
//
// Discovery convention: the shared operator is the lowest-id client-role
// user under the admin's org with password_plaintext IS NOT NULL. For
// orgs created via the approval flow there is exactly one. For legacy
// seeded data the demo seed backfills password_plaintext on one client
// user so the demo admin sees a working operator credential.

type operatorAccessView struct {
	Username    string `json:"username"`
	Password    string `json:"password"`             // plaintext, by deliberate design
	DisplayName string `json:"display_name"`
	Status      string `json:"status"`               // "active" | "disabled"
}

// findSharedOperator returns the row representing the shared operator
// for the given org, or sql.ErrNoRows if the org doesn't have one yet.
// Picks the lowest-id qualifying row so the result is stable as new
// users are added.
func findSharedOperator(ctx interface{}, db *sql.DB, orgID int64, dest *operatorAccessRow) error {
	return db.QueryRow(
		`SELECT id, username, COALESCE(password_plaintext, ''), display_name, disabled_at
		 FROM users
		 WHERE org_id = ?
		   AND role = 'client'
		   AND password_plaintext IS NOT NULL
		 ORDER BY id ASC
		 LIMIT 1`,
		orgID,
	).Scan(&dest.id, &dest.username, &dest.password, &dest.displayName, &dest.disabledAt)
}

type operatorAccessRow struct {
	id          int64
	username    string
	password    string
	displayName string
	disabledAt  sql.NullTime
}

func (s *Server) loadOperatorAccess(w http.ResponseWriter, r *http.Request) (*operatorAccessRow, bool) {
	claims := claimsFrom(r)
	if claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin without org context")
		return nil, false
	}
	var row operatorAccessRow
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id, username, COALESCE(password_plaintext, ''), display_name, disabled_at
		 FROM users
		 WHERE org_id = ?
		   AND role = 'client'
		   AND password_plaintext IS NOT NULL
		 ORDER BY id ASC
		 LIMIT 1`,
		*claims.OrgID,
	).Scan(&row.id, &row.username, &row.password, &row.displayName, &row.disabledAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "no shared operator account exists for this org — contact platform support")
		return nil, false
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "operator-access read: "+err.Error())
		return nil, false
	}
	return &row, true
}

func operatorStatus(r *operatorAccessRow) string {
	if r.disabledAt.Valid {
		return "disabled"
	}
	return "active"
}

// GET /api/admin/operator-access
func (s *Server) adminGetOperatorAccess(w http.ResponseWriter, r *http.Request) {
	row, ok := s.loadOperatorAccess(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, operatorAccessView{
		Username:    row.username,
		Password:    row.password,
		DisplayName: row.displayName,
		Status:      operatorStatus(row),
	})
}

// POST /api/admin/operator-access/reset-password
//
// Generates a fresh random password, updates both the bcrypt hash and
// the recoverable plaintext column atomically. Active sessions for the
// shared operator continue working until their JWT expires (12h) —
// that's intentional, so an admin doing a routine credential rotation
// doesn't immediately log out every operator machine mid-verification.
// To force an immediate logout, the admin disables + re-enables.
func (s *Server) adminResetOperatorAccess(w http.ResponseWriter, r *http.Request) {
	row, ok := s.loadOperatorAccess(w, r)
	if !ok {
		return
	}
	newPassword := generateOperatorPassword()
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bcrypt: "+err.Error())
		return
	}
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE users
		 SET password_hash = ?, password_plaintext = ?
		 WHERE id = ?`,
		string(newHash), newPassword, row.id,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, operatorAccessView{
		Username:    row.username,
		Password:    newPassword,
		DisplayName: row.displayName,
		Status:      operatorStatus(row),
	})
}

// POST /api/admin/operator-access/set-password
//
// Admin-chosen password for the shared operator. Useful when the admin
// wants a memorable credential they can distribute to physical
// machines without copy-pasting a random 12-char string. Same
// validation as the magic-link set-password flow (10+ chars, letter +
// digit) so the strength floor is consistent across the product.
// Active operator sessions stay logged in until their JWT expires —
// same trade-off as the reset endpoint; admin must Disable+Enable for
// immediate kick-out.
type setOperatorPasswordReq struct {
	Password string `json:"password"`
}

func (s *Server) adminSetOperatorPassword(w http.ResponseWriter, r *http.Request) {
	row, ok := s.loadOperatorAccess(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req setOperatorPasswordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := validatePassword(req.Password); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bcrypt: "+err.Error())
		return
	}
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE users
		 SET password_hash = ?, password_plaintext = ?
		 WHERE id = ?`,
		string(hash), req.Password, row.id,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "update: "+err.Error())
		return
	}
	s.auditFromRequest(r, "operator.password.set", "user", row.id, map[string]any{
		"mode": "custom",
	})
	writeJSON(w, http.StatusOK, operatorAccessView{
		Username:    row.username,
		Password:    req.Password,
		DisplayName: row.displayName,
		Status:      operatorStatus(row),
	})
}

// POST /api/admin/operator-access/disable
func (s *Server) adminDisableOperatorAccess(w http.ResponseWriter, r *http.Request) {
	row, ok := s.loadOperatorAccess(w, r)
	if !ok {
		return
	}
	if row.disabledAt.Valid {
		writeJSON(w, http.StatusOK, operatorAccessView{
			Username: row.username, Password: row.password,
			DisplayName: row.displayName, Status: "disabled",
		})
		return
	}
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = ?`, row.id,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "disable: "+err.Error())
		return
	}
	s.auditFromRequest(r, "operator.disable", "user", row.id, nil)
	writeJSON(w, http.StatusOK, operatorAccessView{
		Username: row.username, Password: row.password,
		DisplayName: row.displayName, Status: "disabled",
	})
}

// POST /api/admin/operator-access/enable
func (s *Server) adminEnableOperatorAccess(w http.ResponseWriter, r *http.Request) {
	row, ok := s.loadOperatorAccess(w, r)
	if !ok {
		return
	}
	if !row.disabledAt.Valid {
		writeJSON(w, http.StatusOK, operatorAccessView{
			Username: row.username, Password: row.password,
			DisplayName: row.displayName, Status: "active",
		})
		return
	}
	if _, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE users SET disabled_at = NULL WHERE id = ?`, row.id,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "enable: "+err.Error())
		return
	}
	s.auditFromRequest(r, "operator.enable", "user", row.id, nil)
	writeJSON(w, http.StatusOK, operatorAccessView{
		Username: row.username, Password: row.password,
		DisplayName: row.displayName, Status: "active",
	})
}
