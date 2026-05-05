package api

import (
	"database/sql"
	"encoding/json"
	"net/http"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/auth"
)

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var (
		id           int64
		passHash     string
		role         string
		orgID        sql.NullInt64
		centerID     sql.NullInt64
		displayName  string
	)
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id,password_hash,role,org_id,center_id,display_name FROM users WHERE username=?`,
		req.Username,
	).Scan(&id, &passHash, &role, &orgID, &centerID, &displayName)
	if err == sql.ErrNoRows {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passHash), []byte(req.Password)) != nil {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	claims := auth.Claims{
		UserID:   id,
		Username: req.Username,
		Role:     role,
	}
	if orgID.Valid {
		v := orgID.Int64
		claims.OrgID = &v
	}
	if centerID.Valid {
		v := centerID.Int64
		claims.CenterID = &v
	}
	tok, err := s.deps.JWT.Issue(claims)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "token error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token": tok,
		"user": map[string]any{
			"id":           id,
			"username":     req.Username,
			"role":         role,
			"display_name": displayName,
			"org_id":       claims.OrgID,
			"center_id":    claims.CenterID,
		},
	})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	var displayName string
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT display_name FROM users WHERE id=?`, c.UserID,
	).Scan(&displayName)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":           c.UserID,
		"username":     c.Username,
		"role":         c.Role,
		"display_name": displayName,
		"org_id":       c.OrgID,
		"center_id":    c.CenterID,
	})
}
