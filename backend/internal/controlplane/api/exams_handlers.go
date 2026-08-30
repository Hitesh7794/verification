package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"
)

// ── Per-client review portal (portal_enabled + reviewer users) ───────

func (s *Server) setClientPortal(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	_, err = s.deps.DB.ExecContext(r.Context(),
		`UPDATE clients_registry SET updated_at = NOW() WHERE id = $1`, id,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "portal_enabled": req.Enabled})
}

func (s *Server) listClientReviewers(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	type reviewerItem struct {
		ID          int64  `json:"id"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
		CreatedAt   string `json:"created_at"`
	}
	reviewers := []reviewerItem{}
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT id, username, COALESCE(display_name, ''), COALESCE(email, ''), created_at
		  FROM users
		 WHERE role = 'client_reviewer' AND client_id = $1
		 ORDER BY created_at DESC`, id)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var u reviewerItem
			var t time.Time
			if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &t); err == nil {
				u.CreatedAt = t.UTC().Format(time.RFC3339)
				reviewers = append(reviewers, u)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"reviewers": reviewers})
}

func (s *Server) createClientReviewer(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var req struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	u := strings.TrimSpace(req.Username)
	p := strings.TrimSpace(req.Password)
	if len(u) < 3 || len(p) < 6 {
		writeErr(w, http.StatusBadRequest, "username (>=3 chars) and password (>=6 chars) required")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(p), bcrypt.DefaultCost)

	var uid int64
	err = s.deps.DB.QueryRowContext(r.Context(), `
		INSERT INTO users(username, password_hash, role, display_name, email, activated_at, client_id)
		VALUES($1, $2, 'client_reviewer', $3, $4, NOW(), $5)
		RETURNING id`,
		u, string(hash), strings.TrimSpace(req.DisplayName), strings.TrimSpace(req.Email), id,
	).Scan(&uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create reviewer: "+err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":           uid,
		"username":     u,
		"display_name": req.DisplayName,
		"email":        req.Email,
		"password":     p,
		"client_id":    id,
	})
}

func (s *Server) deleteClientReviewer(w http.ResponseWriter, r *http.Request) {
	uid, err := strconv.ParseInt(chi.URLParam(r, "userId"), 10, 64)
	if err != nil || uid <= 0 {
		writeErr(w, http.StatusBadRequest, "bad userId")
		return
	}
	_, err = s.deps.DB.ExecContext(r.Context(),
		`DELETE FROM users WHERE id = $1 AND role = 'client_reviewer'`, uid,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "delete: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── Exam Handlers ──────────────────────────────────────────────────

type createExamReq struct {
	Name             string `json:"name"`
	ExamCode         string `json:"exam_code"`
	VerificationFrom string `json:"verification_from"`
	VerificationTo   string `json:"verification_to"`
}

func (s *Server) createExam(w http.ResponseWriter, r *http.Request) {
	clientID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || clientID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad client id")
		return
	}
	var req createExamReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	name := strings.TrimSpace(req.Name)
	code := strings.TrimSpace(req.ExamCode)
	if len(name) < 2 || len(code) < 2 {
		writeErr(w, http.StatusBadRequest, "name and exam_code required")
		return
	}
	from := strings.TrimSpace(req.VerificationFrom)
	to := strings.TrimSpace(req.VerificationTo)
	if from == "" {
		from = time.Now().UTC().Format("2006-01-02 15:04:05")
	}
	if to == "" {
		to = time.Now().AddDate(1, 0, 0).UTC().Format("2006-01-02 15:04:05")
	}

	var id int64
	err = s.deps.DB.QueryRowContext(r.Context(), `
		INSERT INTO exams(client_id, name, exam_code, verification_from, verification_to, visible, closed)
		VALUES($1, $2, $3, $4::timestamptz, $5::timestamptz, 1, 0)
		RETURNING id`,
		clientID, name, code, from, to,
	).Scan(&id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "insert exam: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":        id,
		"name":      name,
		"exam_code": code,
		"client_id": clientID,
	})
}

func (s *Server) getExam(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var e struct {
		ID               int64  `json:"id"`
		ClientID         int64  `json:"client_id"`
		ClientName       string `json:"client_name"`
		Name             string `json:"name"`
		ExamCode         string `json:"exam_code"`
		Status           string `json:"status"`
		Closed           bool   `json:"closed"`
		Visible          bool   `json:"visible"`
		VerificationFrom string `json:"verification_from"`
		VerificationTo   string `json:"verification_to"`
		CandidateCount   int64  `json:"candidate_count"`
	}
	var closedInt, visibleInt int
	err = s.deps.DB.QueryRowContext(r.Context(), `
		SELECT e.id, e.client_id, COALESCE(c.name, ''), e.name, e.exam_code,
		       COALESCE(e.status, 'active'), COALESCE(e.closed, 0), COALESCE(e.visible, 1),
		       COALESCE(e.verification_from::text, ''), COALESCE(e.verification_to::text, '')
		  FROM exams e
		  LEFT JOIN clients_registry c ON c.id = e.client_id
		 WHERE e.id = $1`, id,
	).Scan(&e.ID, &e.ClientID, &e.ClientName, &e.Name, &e.ExamCode, &e.Status,
		&closedInt, &visibleInt, &e.VerificationFrom, &e.VerificationTo)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "exam not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	e.Closed = closedInt == 1 || e.Status == "archived" || e.Status == "ended"
	e.Visible = visibleInt == 1
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM exam_candidates WHERE exam_id = $1`, e.ID).Scan(&e.CandidateCount)

	writeJSON(w, http.StatusOK, map[string]any{
		"exam":    e,
		"uploads": []any{},
	})
}

func (s *Server) patchExam(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var req struct {
		Name             *string `json:"name"`
		VerificationFrom *string `json:"verification_from"`
		VerificationTo   *string `json:"verification_to"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	if req.Name != nil {
		_, _ = s.deps.DB.ExecContext(r.Context(), `UPDATE exams SET name = $1, updated_at = NOW() WHERE id = $2`, *req.Name, id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) toggleExamVisibility(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	_, err = s.deps.DB.ExecContext(r.Context(),
		`UPDATE exams SET visible = 1 - visible, updated_at = NOW() WHERE id = $1`, id,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "toggle: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) closeExam(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	_, err = s.deps.DB.ExecContext(r.Context(),
		`UPDATE exams SET closed = 1, status = 'ended', closed_at = NOW(), updated_at = NOW() WHERE id = $1`, id,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "close: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) reopenExam(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	_, err = s.deps.DB.ExecContext(r.Context(),
		`UPDATE exams SET closed = 0, status = 'active', closed_at = NULL, updated_at = NOW() WHERE id = $1`, id,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "reopen: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) deleteExam(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	_, err = s.deps.DB.ExecContext(r.Context(), `DELETE FROM exams WHERE id = $1`, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "delete: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) getExamCompleteness(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	var total int64
	_ = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT COUNT(*) FROM exam_candidates WHERE exam_id = $1`, id).Scan(&total)
	writeJSON(w, http.StatusOK, map[string]any{
		"total_candidates": total,
		"candidates":       []any{},
	})
}
