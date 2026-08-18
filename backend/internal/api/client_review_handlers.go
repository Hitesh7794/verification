package api

// Client-reviewer endpoints — the per-client (exam-board) inbox for
// reviewing KYC applications targeting that client.
//
// Roles:
//   client_reviewer → their JWT carries client_id; every read/write
//                     below is scoped to that client_id server-side.
//                     They cannot see applications for other clients
//                     nor the legacy null-scoped (superadmin-only) queue.
//   superadmin      → keeps using /api/superadmin/applications/*, which
//                     already sees every row regardless of client_id.
//
// The approve/reject bodies delegate to the shared helpers in
// application_review_shared.go, so client + superadmin flows always
// stay in lockstep.
//
// Endpoints:
//   GET  /api/client/applications          list, scoped to client_id
//   GET  /api/client/applications/{id}     one, scoped
//   POST /api/client/applications/{id}/approve
//   POST /api/client/applications/{id}/reject

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/db"
)

// clientReviewerScope pulls the caller's client_id from JWT claims.
// Returns a *sql.NullInt64-friendly value plus a bool indicating whether
// the caller is allowed at all — false means the handler should 403
// (missing claim, wrong role, or no client_id attached).
func clientReviewerScope(r *http.Request) (int64, bool) {
	c := claimsFrom(r)
	if c == nil || c.Role != "client_reviewer" || c.ClientID == nil {
		return 0, false
	}
	return *c.ClientID, true
}

// ---------- GET /api/client/applications ----------

// Same shape as superadmin's list — thin variant, no free-text search
// yet (client inboxes are typically small; add search if / when it hurts).
func (s *Server) clientListApplications(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	q := r.URL.Query()

	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = listDefaultLimit
	}
	if limit > listMaxLimit {
		limit = listMaxLimit
	}
	offset, _ := strconv.Atoi(q.Get("offset"))
	if offset < 0 {
		offset = 0
	}

	status := strings.TrimSpace(q.Get("status"))
	allowed := map[string]bool{
		"": true, "all": true,
		"pending": true, "approved": true, "rejected": true,
	}
	if !allowed[status] {
		writeErr(w, http.StatusBadRequest, "invalid status filter")
		return
	}

	where := []string{"client_id = ?"}
	args := []any{clientID}
	if status != "" && status != "all" {
		where = append(where, "status = ?")
		args = append(args, status)
	}
	whereSQL := strings.Join(where, " AND ")

	var total int
	if err := s.deps.DB.QueryRowContext(r.Context(),
		db.Q("SELECT COUNT(*) FROM institution_applications WHERE "+whereSQL), args...,
	).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "db count")
		return
	}

	listArgs := append([]any{}, args...)
	listArgs = append(listArgs, limit, offset)
	rows, err := s.deps.DB.QueryContext(r.Context(),
		db.Q(`SELECT id, status, institution_name, institution_type,
		             COALESCE(tier,''), COALESCE(aishe_code,''),
		             state, city, head_name, head_email, created_at,
		             (SELECT COUNT(*) FROM institution_application_documents d
		                WHERE d.application_id = institution_applications.id)
		        FROM institution_applications WHERE `+whereSQL+`
		       ORDER BY created_at DESC LIMIT ? OFFSET ?`),
		listArgs...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db list")
		return
	}
	defer rows.Close()

	out := []applicationListItem{}
	for rows.Next() {
		var it applicationListItem
		var createdAt time.Time
		if err := rows.Scan(&it.ID, &it.Status, &it.InstitutionName, &it.InstitutionType,
			&it.Tier, &it.AisheCode, &it.State, &it.City,
			&it.HeadName, &it.HeadEmail, &createdAt, &it.DocCount); err != nil {
			continue
		}
		it.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, applicationListResp{
		Items: out, Total: total, Limit: limit, Offset: offset,
	})
}

// ---------- GET /api/client/applications/{id} ----------

func (s *Server) clientGetApplication(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}

	// Pre-check scope so a reviewer for one client can't fetch an
	// application belonging to another (would be an info leak).
	var appScope sql.NullInt64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT client_id FROM institution_applications WHERE id = $1`, appID,
	).Scan(&appScope); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "application not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if !appScope.Valid || appScope.Int64 != clientID {
		// Same 404 message as "doesn't exist" so a scope probe returns
		// the same shape as an unknown id.
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}

	d, err := s.loadApplicationDetail(r.Context(), appID)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "application not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	// loadApplicationDetail stamps each doc's download_url with the
	// superadmin path because it was written before the reviewer role
	// existed. Rewrite to the scoped mirror so the reviewer's browser
	// hits /api/client/... (which enforces the client_id predicate on
	// the doc's parent application).
	for i := range d.Docs {
		d.Docs[i].DownloadURL = fmt.Sprintf(
			"/api/client/applications/%d/docs/%d", appID, d.Docs[i].DocID,
		)
	}
	writeJSON(w, http.StatusOK, d)
}

// ---------- GET /api/client/applications/{id}/docs/{doc_id} ----------
//
// Scoped mirror of superadminDownloadDoc — same streaming behaviour,
// but the SQL WHERE joins to institution_applications.client_id so a
// reviewer for one client can never read another client's uploads.
func (s *Server) clientDownloadDoc(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	docID, err := parseInt64(chi.URLParam(r, "doc_id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid doc_id")
		return
	}
	var storagePath, mime, original string
	err = s.deps.DB.QueryRowContext(r.Context(),
		`SELECT d.storage_path, d.mime, d.original_name
		   FROM institution_application_documents d
		   JOIN institution_applications a ON a.id = d.application_id
		  WHERE d.id = $1 AND d.application_id = $2 AND a.client_id = $3`,
		docID, appID, clientID,
	).Scan(&storagePath, &mime, &original)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "document not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	f, err := os.Open(storagePath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "file open")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`inline; filename="%s"`, safeFilename(original)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, f)
}

// ---------- POST /api/client/applications/{id}/approve ----------

func (s *Server) clientApproveApplication(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	claims := claimsFrom(r)
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req approveReq
	_ = json.NewDecoder(r.Body).Decode(&req)

	out, err := s.approveApplication(r, appID, claims.UserID, &clientID, req.Note)
	if err != nil {
		code, msg := mapReviewErrorToHTTP(err)
		writeErr(w, code, msg)
		return
	}
	s.auditFromRequest(r, "application.approve", "application", appID, map[string]any{
		"org_id":           out.OrgID,
		"institution_name": out.InstitutionName,
		"admin_user_id":    out.AdminUserID,
		"actor":            "client_reviewer",
		"client_id":        clientID,
	})
	writeJSON(w, http.StatusOK, approveResp{
		ApplicationID:    out.ApplicationID,
		OrgID:            out.OrgID,
		AdminUserID:      out.AdminUserID,
		AdminUsername:    out.AdminUsername,
		MagicLinkURL:     out.MagicLinkURL,
		OperatorUsername: out.OperatorUsername,
		OperatorPassword: out.OperatorPassword,
	})
}

// ---------- POST /api/client/applications/{id}/reject ----------

func (s *Server) clientRejectApplication(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	appID, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil || appID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	claims := claimsFrom(r)
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	var req rejectReq
	_ = json.NewDecoder(r.Body).Decode(&req)

	if err := s.rejectApplication(r.Context(), appID, claims.UserID, &clientID, req.Note); err != nil {
		code, msg := mapReviewErrorToHTTP(err)
		writeErr(w, code, msg)
		return
	}
	s.auditFromRequest(r, "application.reject", "application", appID, map[string]any{
		"actor":     "client_reviewer",
		"client_id": clientID,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"application_id": appID,
		"status":         "rejected",
	})
}

// ---------- GET /api/client/me ----------
//
// The dashboard uses this to render the client's name in the page
// header ("NTA — KYC inbox"). Cheap enough to include on every
// dashboard mount; the alternative was passing name via the JWT which
// would grow every issued token.
func (s *Server) clientReviewerMe(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	var (
		name          string
		visible       int
		closed        int
		portalEnabled bool
	)
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT name, visible, closed, portal_enabled FROM clients WHERE id = $1`, clientID,
	).Scan(&name, &visible, &closed, &portalEnabled); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "client not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"client_id":      clientID,
		"name":           name,
		"visible":        visible == 1,
		"closed":         closed == 1,
		"portal_enabled": portalEnabled,
	})
}
