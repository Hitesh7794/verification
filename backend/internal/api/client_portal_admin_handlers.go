package api

// Superadmin-side management of the per-client review portal.
//
//   POST   /api/superadmin/clients/{id}/portal           enable/disable
//   GET    /api/superadmin/clients/{id}/reviewers        list
//   POST   /api/superadmin/clients/{id}/reviewers        create
//   DELETE /api/superadmin/clients/{id}/reviewers/{uid}  remove
//
// Reviewer users are role='client_reviewer' with client_id set. The
// portal_enabled flag on clients gates whether this client shows up in
// the public /api/clients/public list that the register form reads;
// login itself doesn't require it (superadmin can still create/verify
// reviewers before flipping the switch).

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
)

// ---------- POST /api/superadmin/clients/{id}/portal ----------

type portalToggleReq struct {
	Enabled bool `json:"enabled"`
}

func (s *Server) superadminSetClientPortal(w http.ResponseWriter, r *http.Request) {
	clientID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || clientID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req portalToggleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE clients SET portal_enabled = $1, updated_at = NOW() WHERE id = $2`,
		req.Enabled, clientID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "client not found")
		return
	}
	s.auditFromRequest(r, "client.portal_toggle", "client", clientID, map[string]any{
		"enabled": req.Enabled,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"client_id":      clientID,
		"portal_enabled": req.Enabled,
	})
}

// ---------- GET /api/superadmin/clients/{id}/reviewers ----------

type reviewerRow struct {
	ID          int64      `json:"id"`
	Username    string     `json:"username"`
	Email       string     `json:"email,omitempty"`
	DisplayName string     `json:"display_name"`
	CreatedAt   time.Time  `json:"created_at"`
	DisabledAt  *time.Time `json:"disabled_at,omitempty"`
	// Plaintext echoed once at creation time. Never re-read for an
	// existing row (unlike the operator-side plaintext echo, which the
	// admin dashboard needs on every visit) — reviewers manage their
	// own password after first login.
	Password string `json:"password,omitempty"`
}

func (s *Server) superadminListReviewers(w http.ResponseWriter, r *http.Request) {
	clientID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || clientID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT id, username, COALESCE(email,''), display_name, created_at, disabled_at
		   FROM users
		  WHERE role = 'client_reviewer' AND client_id = $1
		  ORDER BY created_at DESC, id DESC`,
		clientID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	defer rows.Close()
	out := []reviewerRow{}
	for rows.Next() {
		var it reviewerRow
		var disabled sql.NullTime
		if err := rows.Scan(&it.ID, &it.Username, &it.Email, &it.DisplayName, &it.CreatedAt, &disabled); err != nil {
			continue
		}
		if disabled.Valid {
			t := disabled.Time
			it.DisabledAt = &t
		}
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"reviewers": out})
}

// ---------- POST /api/superadmin/clients/{id}/reviewers ----------

type createReviewerReq struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
}

func (s *Server) superadminCreateReviewer(w http.ResponseWriter, r *http.Request) {
	clientID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || clientID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	// Confirm client exists so we can't create a reviewer for a ghost.
	var probe int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT id FROM clients WHERE id = $1`, clientID,
	).Scan(&probe); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "client not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}

	var req createReviewerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if len(req.Username) < 3 || len(req.Username) > 60 {
		writeErr(w, http.StatusBadRequest, "username required (3-60 chars)")
		return
	}
	if req.DisplayName == "" {
		req.DisplayName = req.Username
	}
	if req.Email != "" && !isPlausibleEmail(req.Email) {
		writeErr(w, http.StatusBadRequest, "email is not a valid address")
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
	var userID int64
	// activated_at set now — reviewers don't need a magic-link
	// activation flow; superadmin hands them their password out-of-band.
	err = s.deps.DB.QueryRowContext(r.Context(),
		`INSERT INTO users(username, password_hash, role, client_id,
		                    display_name, email, activated_at)
		 VALUES($1, $2, 'client_reviewer', $3, $4, $5, CURRENT_TIMESTAMP)
		 RETURNING id`,
		req.Username, string(hash), clientID, req.DisplayName, nullable(req.Email),
	).Scan(&userID)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
			writeErr(w, http.StatusConflict, "username already taken")
			return
		}
		writeErr(w, http.StatusInternalServerError, "user insert: "+err.Error())
		return
	}
	s.auditFromRequest(r, "reviewer.create", "user", userID, map[string]any{
		"client_id": clientID,
		"username":  req.Username,
	})
	writeJSON(w, http.StatusCreated, reviewerRow{
		ID:          userID,
		Username:    req.Username,
		DisplayName: req.DisplayName,
		Email:       req.Email,
		CreatedAt:   time.Now().UTC(),
		Password:    req.Password, // echoed ONCE, never surfaced again
	})
}

// ---------- DELETE /api/superadmin/clients/{id}/reviewers/{uid} ----------

func (s *Server) superadminDeleteReviewer(w http.ResponseWriter, r *http.Request) {
	clientID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || clientID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	userID, err := parseInt64(chi.URLParam(r, "uid"))
	if err != nil || userID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid uid")
		return
	}
	// Scope the DELETE by (id, client_id, role) so a superadmin call
	// can't accidentally delete an admin user by ID.
	res, err := s.deps.DB.ExecContext(r.Context(),
		`DELETE FROM users
		  WHERE id = $1 AND client_id = $2 AND role = 'client_reviewer'`,
		userID, clientID,
	)
	if err != nil {
		// A reviewer who's already approved or rejected applications is
		// referenced by institution_applications.reviewed_by_user_id
		// (ON DELETE NO ACTION), so the DELETE fails with a FK
		// violation (SQLSTATE 23503). Surface a 409 with an actionable
		// message instead of a generic 500 — the superadmin's next
		// question is "so how do I get rid of them?" and the answer
		// (once we ship soft-disable) will belong here too.
		if strings.Contains(err.Error(), "23503") ||
			strings.Contains(strings.ToLower(err.Error()), "foreign key") {
			writeErr(w, http.StatusConflict,
				"reviewer has prior approvals or rejections on record — cannot delete. "+
					"Their history is referenced by past applications.")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db delete: "+err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeErr(w, http.StatusNotFound, "reviewer not found")
		return
	}
	s.auditFromRequest(r, "reviewer.delete", "user", userID, map[string]any{
		"client_id": clientID,
	})
	w.WriteHeader(http.StatusNoContent)
}

// ---------- GET /api/clients/public ----------
//
// Public — used by the register form's client dropdown. Returns only
// clients where portal_enabled AND visible=1 AND closed=0 so we don't
// route new KYCs to a client that isn't ready to review them.
func (s *Server) publicListClients(w http.ResponseWriter, r *http.Request) {
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT id, name FROM clients
		  WHERE portal_enabled = true AND visible = 1 AND closed = 0
		  ORDER BY name ASC`,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			continue
		}
		out = append(out, map[string]any{"id": id, "name": name})
	}
	writeJSON(w, http.StatusOK, map[string]any{"clients": out})
}
