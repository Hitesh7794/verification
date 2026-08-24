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
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
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
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`inline; filename="%s"`, safeFilename(original)))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := s.streamDocBytes(w, r, storagePath); err != nil {
		fmt.Fprintf(os.Stderr,
			"clientDownloadDoc: stream failed doc=%d: %v\n", docID, err)
	}
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

// ── Exam Subscription Requests Reviewer Endpoints ──────────────────────

type subscriptionRequestItem struct {
	OrgID                 int64  `json:"org_id"`
	ExamID                int64  `json:"exam_id"`
	Status                string `json:"status"`
	ApprovalType          string `json:"approval_type,omitempty"`
	RequestedAt           string `json:"requested_at"`
	ReviewedAt            string `json:"reviewed_at,omitempty"`
	ReviewNote            string `json:"review_note,omitempty"`
	OrgName               string `json:"org_name"`
	OrgSlug               string `json:"org_slug"`
	ExamName              string `json:"exam_name"`
	ExamCode              string `json:"exam_code"`
	VerificationFrom      string `json:"verification_from"`
	VerificationTo        string `json:"verification_to"`
	CandidateCount        int64  `json:"candidate_count"`
	ClientBlanketApproved bool   `json:"client_blanket_approved"`
	InstitutionType       string `json:"institution_type,omitempty"`
	AisheCode             string `json:"aishe_code,omitempty"`
	Pan                   string `json:"pan,omitempty"`
	State                 string `json:"state,omitempty"`
	City                  string `json:"city,omitempty"`
	HeadName              string `json:"head_name,omitempty"`
	HeadDesignation       string `json:"head_designation,omitempty"`
	HeadEmail             string `json:"head_email,omitempty"`
	HeadMobile            string `json:"head_mobile,omitempty"`
	ApproxStudentCount    int64  `json:"approx_student_count,omitempty"`
}

type subscriptionApproveReq struct {
	Mode string `json:"mode"` // "per_exam" or "blanket_client"
	Note string `json:"note"`
}

type subscriptionRejectReq struct {
	Note string `json:"note"`
}

// ---------- GET /api/client/subscription-requests ----------
func (s *Server) clientListSubscriptionRequests(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}

	q := r.URL.Query()
	statusFilter := strings.TrimSpace(q.Get("status"))
	if statusFilter == "" {
		statusFilter = "pending"
	}
	examIDStr := strings.TrimSpace(q.Get("exam_id"))

	where := []string{"e.client_id = $1"}
	args := []any{clientID}

	if statusFilter != "all" {
		where = append(where, fmt.Sprintf("s.status = $%d", len(args)+1))
		args = append(args, statusFilter)
	}

	if examIDStr != "" && examIDStr != "all" {
		if eid, err := strconv.ParseInt(examIDStr, 10, 64); err == nil && eid > 0 {
			where = append(where, fmt.Sprintf("e.id = $%d", len(args)+1))
			args = append(args, eid)
		}
	}

	whereClause := strings.Join(where, " AND ")

	query := fmt.Sprintf(`
		SELECT
			s.org_id, s.exam_id, s.status, COALESCE(s.approval_type, ''),
			s.requested_at, s.reviewed_at, COALESCE(s.review_note, ''),
			o.name AS org_name, COALESCE(o.code, '') AS org_slug,
			e.name AS exam_name, e.exam_code,
			COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD'), ''),
			COALESCE(TO_CHAR(e.verification_to, 'YYYY-MM-DD'), ''),
			(SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id) AS candidate_count,
			CASE WHEN coa.client_id IS NOT NULL THEN 1 ELSE 0 END AS client_blanket_approved,
			COALESCE(app.institution_type, ''),
			COALESCE(app.aishe_code, ''),
			COALESCE(app.pan, ''),
			COALESCE(app.state, ''),
			COALESCE(app.city, ''),
			COALESCE(app.head_name, ''),
			COALESCE(app.head_designation, ''),
			COALESCE(app.head_email, ''),
			COALESCE(app.head_mobile, ''),
			COALESCE(app.approx_student_count, 0)
		FROM organization_exam_subscriptions s
		JOIN exams e ON e.id = s.exam_id
		JOIN organizations o ON o.id = s.org_id
		LEFT JOIN client_organization_approvals coa
			ON coa.client_id = e.client_id AND coa.org_id = s.org_id
		LEFT JOIN institution_applications app
			ON LOWER(TRIM(app.institution_name)) = LOWER(TRIM(o.name))
			AND app.status = 'approved'
		WHERE %s
		ORDER BY s.requested_at DESC`, whereClause)

	rows, err := s.deps.DB.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db list: "+err.Error())
		return
	}
	defer rows.Close()

	items := []subscriptionRequestItem{}
	for rows.Next() {
		var it subscriptionRequestItem
		var reqAt, revAt sql.NullTime
		var blanketApproved int
		var appStudentCount sql.NullInt64

		if err := rows.Scan(
			&it.OrgID, &it.ExamID, &it.Status, &it.ApprovalType,
			&reqAt, &revAt, &it.ReviewNote,
			&it.OrgName, &it.OrgSlug,
			&it.ExamName, &it.ExamCode,
			&it.VerificationFrom, &it.VerificationTo,
			&it.CandidateCount,
			&blanketApproved,
			&it.InstitutionType,
			&it.AisheCode,
			&it.Pan,
			&it.State,
			&it.City,
			&it.HeadName,
			&it.HeadDesignation,
			&it.HeadEmail,
			&it.HeadMobile,
			&appStudentCount,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		it.ClientBlanketApproved = blanketApproved == 1
		if reqAt.Valid {
			it.RequestedAt = reqAt.Time.UTC().Format("2006-01-02T15:04:05Z")
		}
		if revAt.Valid {
			it.ReviewedAt = revAt.Time.UTC().Format("2006-01-02T15:04:05Z")
		}
		if appStudentCount.Valid {
			it.ApproxStudentCount = appStudentCount.Int64
		}
		items = append(items, it)
	}

	// Calculate counts (scoped optionally by exam_id if filtering by single exam)
	var pendingCount, approvedCount, rejectedCount int
	countWhere := "e.client_id = $1"
	countArgs := []any{clientID}
	if examIDStr != "" && examIDStr != "all" {
		if eid, err := strconv.ParseInt(examIDStr, 10, 64); err == nil && eid > 0 {
			countWhere += " AND e.id = $2"
			countArgs = append(countArgs, eid)
		}
	}

	countQuery := fmt.Sprintf(`
		SELECT
			COALESCE(SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN s.status = 'approved' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN s.status = 'rejected' THEN 1 ELSE 0 END), 0)
		FROM organization_exam_subscriptions s
		JOIN exams e ON e.id = s.exam_id
		WHERE %s`, countWhere)

	_ = s.deps.DB.QueryRowContext(r.Context(), countQuery, countArgs...).Scan(&pendingCount, &approvedCount, &rejectedCount)

	// Fetch all visible client exams with their specific subscription counts
	type clientExamItem struct {
		ID               int64  `json:"id"`
		ExamCode         string `json:"exam_code"`
		Name             string `json:"name"`
		VerificationFrom string `json:"verification_from"`
		VerificationTo   string `json:"verification_to"`
		CandidateCount   int64  `json:"candidate_count"`
		PendingCount     int64  `json:"pending_count"`
		ApprovedCount    int64  `json:"approved_count"`
		RejectedCount    int64  `json:"rejected_count"`
		TotalCount       int64  `json:"total_count"`
	}
	clientExams := []clientExamItem{}
	examRows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT
			e.id, e.exam_code, e.name,
			COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD'), ''),
			COALESCE(TO_CHAR(e.verification_to, 'YYYY-MM-DD'), ''),
			(SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id),
			COALESCE((SELECT COUNT(*) FROM organization_exam_subscriptions s WHERE s.exam_id = e.id AND s.status = 'pending'), 0),
			COALESCE((SELECT COUNT(*) FROM organization_exam_subscriptions s WHERE s.exam_id = e.id AND s.status = 'approved'), 0),
			COALESCE((SELECT COUNT(*) FROM organization_exam_subscriptions s WHERE s.exam_id = e.id AND s.status = 'rejected'), 0)
		FROM exams e
		WHERE e.client_id = $1 AND e.visible = 1 AND e.closed = 0
		ORDER BY e.verification_from ASC`, clientID)
	if err == nil {
		defer examRows.Close()
		for examRows.Next() {
			var ce clientExamItem
			if err := examRows.Scan(
				&ce.ID, &ce.ExamCode, &ce.Name,
				&ce.VerificationFrom, &ce.VerificationTo,
				&ce.CandidateCount,
				&ce.PendingCount, &ce.ApprovedCount, &ce.RejectedCount,
			); err == nil {
				ce.TotalCount = ce.PendingCount + ce.ApprovedCount + ce.RejectedCount
				clientExams = append(clientExams, ce)
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items":        items,
		"client_exams": clientExams,
		"counts": map[string]int{
			"pending":  pendingCount,
			"approved": approvedCount,
			"rejected": rejectedCount,
			"total":    pendingCount + approvedCount + rejectedCount,
		},
	})
}

// ---------- POST /api/client/subscription-requests/{org_id}/{exam_id}/approve ----------
func (s *Server) clientApproveSubscriptionRequest(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	claims := claimsFrom(r)

	orgID, err := parseInt64(chi.URLParam(r, "org_id"))
	if err != nil || orgID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid org_id")
		return
	}
	examID, err := parseInt64(chi.URLParam(r, "exam_id"))
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid exam_id")
		return
	}

	var req subscriptionApproveReq
	_ = json.NewDecoder(r.Body).Decode(&req)

	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode != "blanket_client" {
		mode = "per_exam"
	}

	// Verify exam belongs to caller's client_id
	var examClientID int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT client_id FROM exams WHERE id = $1`, examID,
	).Scan(&examClientID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "exam not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if examClientID != clientID {
		writeErr(w, http.StatusNotFound, "exam not found")
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin: "+err.Error())
		return
	}
	defer tx.Rollback()

	if mode == "blanket_client" {
		// 1. Insert or update client_organization_approvals to grant
		//    client-wide blanket approval. Any subsequent subscription
		//    by this organization for this client's exams will be
		//    auto-approved instantly via adminSubscribe.
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO client_organization_approvals(client_id, org_id, approved_at, approved_by, note)
			VALUES($1, $2, NOW(), $3, $4)
			ON CONFLICT (client_id, org_id) DO UPDATE SET
				approved_at = NOW(),
				approved_by = EXCLUDED.approved_by,
				note = EXCLUDED.note`,
			clientID, orgID, claims.UserID, req.Note,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "db approval insert: "+err.Error())
			return
		}

		// 2. Back-fill: approve EVERY currently-pending subscription
		//    for this org under this client's exams — not just the one
		//    the reviewer clicked. Blanket semantic is "always approve
		//    this org for anything I offer"; leaving sibling pending
		//    rows as pending contradicts the badge the UI shows next
		//    to them (fixed 2026-08-24). If the clicked exam already
		//    has a pending row this update covers it; the fallback
		//    INSERT below handles the case where NO pending row
		//    exists yet for the clicked exam (bulk-approve called
		//    before the sub arrived).
		if _, err := tx.ExecContext(r.Context(), `
			UPDATE organization_exam_subscriptions
			SET status = 'approved',
			    approval_type = 'blanket_client',
			    reviewed_at = NOW(),
			    reviewed_by = $1,
			    review_note = $2
			WHERE org_id = $3
			  AND status = 'pending'
			  AND exam_id IN (SELECT id FROM exams WHERE client_id = $4)`,
			claims.UserID, req.Note, orgID, clientID,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "db subscription update: "+err.Error())
			return
		}

		// 3. If the reviewer clicked an exam that has NO existing
		//    subscription row (rare — usually they'd click one that
		//    was pending), create it approved so the click still
		//    lands on something concrete.
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO organization_exam_subscriptions(
				org_id, exam_id, status, approval_type, subscribed_by, reviewed_at, reviewed_by, review_note
			) VALUES($1, $2, 'approved', 'blanket_client', $3, NOW(), $3, $4)
			ON CONFLICT (org_id, exam_id) DO NOTHING`,
			orgID, examID, claims.UserID, req.Note,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
			return
		}
	} else {
		// Option A: Per-exam approval
		res, err := tx.ExecContext(r.Context(), `
			UPDATE organization_exam_subscriptions
			SET status = 'approved',
			    approval_type = 'per_exam',
			    reviewed_at = NOW(),
			    reviewed_by = $1,
			    review_note = $2
			WHERE org_id = $3 AND exam_id = $4`,
			claims.UserID, req.Note, orgID, examID,
		)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db subscription update: "+err.Error())
			return
		}
		rowsAffected, _ := res.RowsAffected()
		if rowsAffected == 0 {
			// Insert if not already present
			if _, err := tx.ExecContext(r.Context(), `
				INSERT INTO organization_exam_subscriptions(
					org_id, exam_id, status, approval_type, subscribed_by, reviewed_at, reviewed_by, review_note
				) VALUES($1, $2, 'approved', 'per_exam', $3, NOW(), $3, $4)
				ON CONFLICT (org_id, exam_id) DO UPDATE SET
					status = 'approved',
					approval_type = 'per_exam',
					reviewed_at = NOW(),
					reviewed_by = EXCLUDED.reviewed_by,
					review_note = EXCLUDED.review_note`,
				orgID, examID, claims.UserID, req.Note,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
				return
			}
		}
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}

	s.auditFromRequest(r, "subscription.approve", "organization_exam_subscriptions", orgID, map[string]any{
		"exam_id":   examID,
		"client_id": clientID,
		"mode":      mode,
		"note":      req.Note,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"status":  "approved",
		"mode":    mode,
		"org_id":  orgID,
		"exam_id": examID,
	})
}

// ---------- POST /api/client/subscription-requests/{org_id}/{exam_id}/reject ----------
func (s *Server) clientRejectSubscriptionRequest(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	claims := claimsFrom(r)

	orgID, err := parseInt64(chi.URLParam(r, "org_id"))
	if err != nil || orgID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid org_id")
		return
	}
	examID, err := parseInt64(chi.URLParam(r, "exam_id"))
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid exam_id")
		return
	}

	var req subscriptionRejectReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	req.Note = strings.TrimSpace(req.Note)
	if req.Note == "" {
		writeErr(w, http.StatusBadRequest, "rejection note is required")
		return
	}

	// Verify exam belongs to caller's client_id
	var examClientID int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT client_id FROM exams WHERE id = $1`, examID,
	).Scan(&examClientID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "exam not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if examClientID != clientID {
		writeErr(w, http.StatusNotFound, "exam not found")
		return
	}

	if _, err := s.deps.DB.ExecContext(r.Context(), `
		UPDATE organization_exam_subscriptions
		SET status = 'rejected',
		    reviewed_at = NOW(),
		    reviewed_by = $1,
		    review_note = $2
		WHERE org_id = $3 AND exam_id = $4`,
		claims.UserID, req.Note, orgID, examID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}

	s.auditFromRequest(r, "subscription.reject", "organization_exam_subscriptions", orgID, map[string]any{
		"exam_id":   examID,
		"client_id": clientID,
		"note":      req.Note,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"status":  "rejected",
		"org_id":  orgID,
		"exam_id": examID,
	})
}

// ---------- GET /api/client/subscription-requests/export.csv ----------
//
// Streams a CSV of every APPROVED subscription for this reviewer's
// client, one row per (org, exam) pair, joined with the institution's
// KYC record so the download carries the full head-of-institution +
// address contact block a compliance sweep would care about.
//
// Column set intentionally flat + human-readable (no JSON in cells,
// no nested structures) so the file opens cleanly in Excel /
// LibreOffice / anything.
//
// Institution details are LEFT JOINed against
// institution_applications so orgs that were seeded directly (no KYC
// row) still export with blank fields instead of dropping the row.
func (s *Server) clientExportApprovedSubscriptionsCSV(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}

	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT
			COALESCE(o.code, ''),
			o.name,
			COALESCE(app.institution_type, ''),
			COALESCE(app.aishe_code, ''),
			COALESCE(app.pan, ''),
			COALESCE(app.state, ''),
			COALESCE(app.city, ''),
			COALESCE(app.approx_student_count, 0),
			COALESCE(app.head_name, ''),
			COALESCE(app.head_designation, ''),
			COALESCE(app.head_email, ''),
			COALESCE(app.head_mobile, ''),
			e.exam_code,
			e.name,
			COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD'), ''),
			COALESCE(TO_CHAR(e.verification_to,   'YYYY-MM-DD'), ''),
			COALESCE(s.approval_type, ''),
			COALESCE(TO_CHAR(s.reviewed_at  AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), ''),
			COALESCE(TO_CHAR(s.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), '')
		FROM organization_exam_subscriptions s
		JOIN exams e         ON e.id = s.exam_id
		JOIN organizations o ON o.id = s.org_id
		LEFT JOIN institution_applications app
			ON LOWER(TRIM(app.institution_name)) = LOWER(TRIM(o.name))
			AND app.status = 'approved'
		WHERE e.client_id = $1 AND s.status = 'approved'
		ORDER BY o.name, e.exam_code
	`, clientID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db list: "+err.Error())
		return
	}
	defer rows.Close()

	// Stream directly to the client. Content-Disposition includes a
	// timestamp so repeat downloads don't overwrite each other in
	// Downloads/.
	fname := fmt.Sprintf("approved-subscriptions-%s.csv",
		time.Now().UTC().Format("20060102-150405"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, fname))

	cw := csv.NewWriter(w)
	defer cw.Flush()

	// Header row. Snake_case + explicit units so a compliance analyst
	// pulling this into Excel isn't guessing at columns.
	_ = cw.Write([]string{
		"org_code", "institution_name", "institution_type",
		"aishe_code", "pan", "state", "city", "approx_student_count",
		"head_name", "head_designation", "head_email", "head_mobile",
		"exam_code", "exam_name", "verification_from", "verification_to",
		"approval_type", "approved_at_utc", "requested_at_utc",
	})

	rowCount := 0
	for rows.Next() {
		var (
			orgCode, orgName, instType                       string
			aishe, pan, state, city                          string
			studentCount                                     int64
			headName, headDesig, headEmail, headMobile       string
			examCode, examName, vFrom, vTo                   string
			apprType, apprAt, reqAt                          string
		)
		if err := rows.Scan(
			&orgCode, &orgName, &instType,
			&aishe, &pan, &state, &city, &studentCount,
			&headName, &headDesig, &headEmail, &headMobile,
			&examCode, &examName, &vFrom, &vTo,
			&apprType, &apprAt, &reqAt,
		); err != nil {
			// Skip bad rows silently — better to give the reviewer a
			// partial CSV than fail the download.
			continue
		}
		_ = cw.Write([]string{
			orgCode, orgName, instType,
			aishe, pan, state, city, strconv.FormatInt(studentCount, 10),
			headName, headDesig, headEmail, headMobile,
			examCode, examName, vFrom, vTo,
			apprType, apprAt, reqAt,
		})
		rowCount++
	}

	s.auditFromRequest(r, "subscription.export_csv", "client", clientID, map[string]any{
		"rows": rowCount,
	})
}

// ---------- POST /api/client/subscription-requests/{org_id}/{exam_id}/revoke ----------
//
// Reviewer had previously approved this org for the exam, now wants
// to pull that back. Semantically distinct from 'rejected' (which
// means "never approved"): 'revoked' preserves the audit story that
// the row was live for some period.
//
// Side effects on revoke:
//   - status = 'revoked', reviewed_at + reviewed_by + review_note stamped
//   - operator_exams cascade: every operator in this org loses this
//     exam from their allowed list (matches adminUnsubscribe's
//     cleanup pattern). Operators can still log in, they just can't
//     verify against this exam.
//
// The college admin can Resubscribe from the catalog page; that
// path (adminSubscribe) uses ON CONFLICT DO UPDATE which flips this
// row back to 'pending' (or straight to 'approved' if the client
// has a blanket approval for the org).
func (s *Server) clientRevokeSubscriptionRequest(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	claims := claimsFrom(r)

	orgID, err := parseInt64(chi.URLParam(r, "org_id"))
	if err != nil || orgID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid org_id")
		return
	}
	examID, err := parseInt64(chi.URLParam(r, "exam_id"))
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid exam_id")
		return
	}

	var req subscriptionRejectReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	req.Note = strings.TrimSpace(req.Note)
	if req.Note == "" {
		writeErr(w, http.StatusBadRequest, "revoke note is required so the college admin sees why access was pulled")
		return
	}

	// Verify exam belongs to caller's client_id (same scope check
	// as approve/reject to keep reviewers walled off from other
	// clients' exams).
	var examClientID int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT client_id FROM exams WHERE id = $1`, examID,
	).Scan(&examClientID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "exam not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if examClientID != clientID {
		writeErr(w, http.StatusNotFound, "exam not found")
		return
	}

	// Guard: only 'approved' rows can be revoked. A pending or
	// rejected one should use the existing reject flow.
	var currentStatus string
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT status FROM organization_exam_subscriptions WHERE org_id = $1 AND exam_id = $2`,
		orgID, examID,
	).Scan(&currentStatus); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "subscription not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if currentStatus != "approved" {
		writeErr(w, http.StatusConflict,
			fmt.Sprintf("can only revoke an approved subscription; this one is %s", currentStatus))
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin")
		return
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(r.Context(), `
		UPDATE organization_exam_subscriptions
		SET status = 'revoked',
		    reviewed_at = NOW(),
		    reviewed_by = $1,
		    review_note = $2
		WHERE org_id = $3 AND exam_id = $4`,
		claims.UserID, req.Note, orgID, examID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}

	// Cascade: pull this exam from every operator_exams row for
	// operators in this org so they can't verify against it any
	// more. Mirrors adminUnsubscribe's cleanup — see line 338.
	if _, err := tx.ExecContext(r.Context(), `
		DELETE FROM operator_exams
		 WHERE exam_id = $1
		   AND user_id IN (SELECT id FROM users WHERE org_id = $2)`,
		examID, orgID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db cascade: "+err.Error())
		return
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit")
		return
	}

	s.auditFromRequest(r, "subscription.revoke", "organization_exam_subscriptions", orgID, map[string]any{
		"exam_id":   examID,
		"client_id": clientID,
		"note":      req.Note,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"status":  "revoked",
		"org_id":  orgID,
		"exam_id": examID,
	})
}

// ---------- POST /api/client/subscription-requests/{org_id}/{exam_id}/reset-pending ----------
func (s *Server) clientResetSubscriptionRequestToPending(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	claims := claimsFrom(r)

	orgID, err := parseInt64(chi.URLParam(r, "org_id"))
	if err != nil || orgID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid org_id")
		return
	}
	examID, err := parseInt64(chi.URLParam(r, "exam_id"))
	if err != nil || examID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid exam_id")
		return
	}

	// Verify exam belongs to caller's client_id
	var examClientID int64
	if err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT client_id FROM exams WHERE id = $1`, examID,
	).Scan(&examClientID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "exam not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db read")
		return
	}
	if examClientID != clientID {
		writeErr(w, http.StatusNotFound, "exam not found")
		return
	}

	if _, err := s.deps.DB.ExecContext(r.Context(), `
		UPDATE organization_exam_subscriptions
		SET status = 'pending',
		    review_note = NULL,
		    reviewed_at = NULL,
		    reviewed_by = NULL
		WHERE org_id = $1 AND exam_id = $2`,
		orgID, examID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db update: "+err.Error())
		return
	}

	s.auditFromRequest(r, "subscription.reset_pending", "organization_exam_subscriptions", orgID, map[string]any{
		"exam_id":     examID,
		"client_id":   clientID,
		"reopened_by": claims.UserID,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"status":  "pending",
		"org_id":  orgID,
		"exam_id": examID,
	})
}

// ── Bulk / Mass Operations ─────────────────────────────────────────────

type subscriptionBulkApproveReq struct {
	OrgIDs  []int64 `json:"org_ids"`
	ExamIDs []int64 `json:"exam_ids"` // optional list of specific exams
	Mode    string  `json:"mode"`     // "per_exam" or "blanket_client"
	Note    string  `json:"note"`
}

type subscriptionBulkRejectReq struct {
	OrgIDs  []int64 `json:"org_ids"`
	ExamIDs []int64 `json:"exam_ids"` // optional list of specific exams
	Note    string  `json:"note"`
}

// ---------- POST /api/client/subscription-requests/bulk-approve ----------
func (s *Server) clientBulkApproveSubscriptionRequests(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	claims := claimsFrom(r)

	var req subscriptionBulkApproveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(req.OrgIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "org_ids list required")
		return
	}

	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode != "blanket_client" {
		mode = "per_exam"
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db tx: "+err.Error())
		return
	}
	defer tx.Rollback()

	for _, orgID := range req.OrgIDs {
		if orgID <= 0 {
			continue
		}

		if mode == "blanket_client" {
			// Grant blanket authorization for this client & organization
			if _, err := tx.ExecContext(r.Context(), `
				INSERT INTO client_organization_approvals(client_id, org_id, approved_at, approved_by, note)
				VALUES($1, $2, NOW(), $3, $4)
				ON CONFLICT (client_id, org_id) DO UPDATE SET
					approved_at = NOW(),
					approved_by = EXCLUDED.approved_by,
					note = EXCLUDED.note`,
				clientID, orgID, claims.UserID, req.Note,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "db blanket approval: "+err.Error())
				return
			}
		}

		// Update pending subscriptions for this org & client
		approvalType := "per_exam"
		if mode == "blanket_client" {
			approvalType = "blanket_client"
		}

		// Blanket mode ignores req.ExamIDs — blanket means "approve
		// this org for every exam under the client, present and
		// future," so limiting the flip to a subset of exam_ids
		// would leave sibling pending rows contradicting the
		// blanket badge on the UI (fixed 2026-08-24). Per-exam
		// mode WITH exam_ids scopes to those; per-exam mode with
		// no exam_ids falls through to the org-wide branch too.
		orgWide := mode == "blanket_client" || len(req.ExamIDs) == 0
		if !orgWide {
			for _, examID := range req.ExamIDs {
				if examID <= 0 {
					continue
				}
				if _, err := tx.ExecContext(r.Context(), `
					UPDATE organization_exam_subscriptions
					SET status = 'approved',
					    approval_type = $1,
					    reviewed_at = NOW(),
					    reviewed_by = $2,
					    review_note = $3
					WHERE org_id = $4
					  AND exam_id = $5
					  AND status = 'pending'
					  AND exam_id IN (SELECT id FROM exams WHERE client_id = $6)`,
					approvalType, claims.UserID, req.Note, orgID, examID, clientID,
				); err != nil {
					writeErr(w, http.StatusInternalServerError, "db bulk approve: "+err.Error())
					return
				}
			}
		} else {
			if _, err := tx.ExecContext(r.Context(), `
				UPDATE organization_exam_subscriptions
				SET status = 'approved',
				    approval_type = $1,
				    reviewed_at = NOW(),
				    reviewed_by = $2,
				    review_note = $3
				WHERE org_id = $4
				  AND status = 'pending'
				  AND exam_id IN (SELECT id FROM exams WHERE client_id = $5)`,
				approvalType, claims.UserID, req.Note, orgID, clientID,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "db bulk approve: "+err.Error())
				return
			}
		}
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}

	s.auditFromRequest(r, "subscription.bulk_approve", "organization_exam_subscriptions", 0, map[string]any{
		"org_ids":   req.OrgIDs,
		"exam_ids":  req.ExamIDs,
		"client_id": clientID,
		"mode":      mode,
		"note":      req.Note,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"approved_count": len(req.OrgIDs),
		"mode":           mode,
	})
}

// ---------- POST /api/client/subscription-requests/bulk-reject ----------
func (s *Server) clientBulkRejectSubscriptionRequests(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	claims := claimsFrom(r)

	var req subscriptionBulkRejectReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if len(req.OrgIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "org_ids list required")
		return
	}
	req.Note = strings.TrimSpace(req.Note)
	if req.Note == "" {
		writeErr(w, http.StatusBadRequest, "rejection note is required")
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db tx: "+err.Error())
		return
	}
	defer tx.Rollback()

	for _, orgID := range req.OrgIDs {
		if orgID <= 0 {
			continue
		}

		if len(req.ExamIDs) > 0 {
			for _, examID := range req.ExamIDs {
				if examID <= 0 {
					continue
				}
				if _, err := tx.ExecContext(r.Context(), `
					UPDATE organization_exam_subscriptions
					SET status = 'rejected',
					    reviewed_at = NOW(),
					    reviewed_by = $1,
					    review_note = $2
					WHERE org_id = $3
					  AND exam_id = $4
					  AND status = 'pending'
					  AND exam_id IN (SELECT id FROM exams WHERE client_id = $5)`,
					claims.UserID, req.Note, orgID, examID, clientID,
				); err != nil {
					writeErr(w, http.StatusInternalServerError, "db bulk reject: "+err.Error())
					return
				}
			}
		} else {
			if _, err := tx.ExecContext(r.Context(), `
				UPDATE organization_exam_subscriptions
				SET status = 'rejected',
				    reviewed_at = NOW(),
				    reviewed_by = $1,
				    review_note = $2
				WHERE org_id = $3
				  AND status = 'pending'
				  AND exam_id IN (SELECT id FROM exams WHERE client_id = $4)`,
				claims.UserID, req.Note, orgID, clientID,
			); err != nil {
				writeErr(w, http.StatusInternalServerError, "db bulk reject: "+err.Error())
				return
			}
		}
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}

	s.auditFromRequest(r, "subscription.bulk_reject", "organization_exam_subscriptions", 0, map[string]any{
		"org_ids":   req.OrgIDs,
		"exam_ids":  req.ExamIDs,
		"client_id": clientID,
		"note":      req.Note,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"rejected_count": len(req.OrgIDs),
	})
}

// ---------- POST /api/client/subscription-requests/bulk-csv-decide ----------
//
// CSV upload → bulk approve/reject subscription requests.
//
// Reviewer uploads a CSV with three columns:
//
//	aishe_code, institution_name, decision
//
// where `decision` is a truthy or falsy token (true / false / yes / no /
// 1 / 0 / approve / reject / y / n — case-insensitive). A header row is
// permitted (auto-detected) but not required. The institution_name
// column is display-only — the AISHE code is what drives the match.
//
// For each row:
//   - Normalise the AISHE code — accept both bare ("H-3454") and the
//     internal prefixed form ("AISHE_H-3454") the register handler
//     stores on organizations.code.
//   - Look up the organization by code.
//   - Find PENDING subscription requests for that org under the
//     reviewer's client_id (across every exam the client owns).
//   - approve=true → mark them approved, reviewed_by=<caller>.
//     approve=false → mark them rejected.
//   - Rows with an unknown code or no pending requests are counted
//     separately and returned to the client so the reviewer can see
//     what the batch actually touched vs. what it dropped.
//
// The whole batch runs in one transaction — a per-row DB error aborts
// the entire operation so the reviewer never lands in a half-applied
// state.
func (s *Server) clientBulkDecideSubscriptionRequestsCSV(w http.ResponseWriter, r *http.Request) {
	clientID, ok := clientReviewerScope(r)
	if !ok {
		writeErr(w, http.StatusForbidden, "client reviewer context required")
		return
	}
	claims := claimsFrom(r)

	// Cap the multipart body — a real bulk CSV of a few thousand rows
	// is well under 1 MB. 2 MB gives generous headroom for a spreadsheet
	// export that includes stray BOMs / blank tail rows.
	const maxCSVBytes = 2 << 20
	r.Body = http.MaxBytesReader(w, r.Body, maxCSVBytes+16<<10)
	if err := r.ParseMultipartForm(maxCSVBytes + 16<<10); err != nil {
		writeErr(w, http.StatusBadRequest,
			"upload too large or malformed — CSV must be under 2 MB")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "file is required (multipart field 'file')")
		return
	}
	defer file.Close()

	// Basic filename check — surface the mistake early rather than
	// letting csv.Reader silently accept a JSON blob.
	if ext := strings.ToLower(strings.TrimSpace(hdr.Filename)); ext != "" &&
		!strings.HasSuffix(ext, ".csv") && !strings.HasSuffix(ext, ".txt") {
		writeErr(w, http.StatusBadRequest,
			"expected a .csv file — got "+hdr.Filename)
		return
	}

	// Sniff the delimiter — Excel/Sheets often export "Tab delimited"
	// or "Semicolon delimited" (European locales) with a .csv extension.
	// We peek at the first 4 KB, count candidate separators outside
	// double-quotes, and pick whichever is most common. Falls back to
	// comma when nothing wins so the "did the operator forget to save
	// as CSV" case still surfaces the field-count error clearly.
	head := make([]byte, 4096)
	n, _ := file.Read(head)
	head = head[:n]
	if _, err := file.Seek(0, 0); err != nil {
		writeErr(w, http.StatusInternalServerError, "csv seek: "+err.Error())
		return
	}
	delim := sniffCSVDelimiter(head)

	rd := csv.NewReader(file)
	rd.Comma = delim
	rd.FieldsPerRecord = -1 // allow ragged rows; we validate per-row
	rd.LazyQuotes = true    // Excel-style CSVs sometimes emit weird quoting

	records, err := rd.ReadAll()
	if err != nil {
		writeErr(w, http.StatusBadRequest,
			"could not parse CSV — check for unmatched quotes: "+err.Error())
		return
	}
	if len(records) == 0 {
		writeErr(w, http.StatusBadRequest, "CSV is empty")
		return
	}

	// Header auto-detection: if the first row's first cell looks like a
	// header (contains "aishe" or "code" — case-insensitive) drop it.
	if len(records) > 0 && len(records[0]) > 0 {
		first := strings.ToLower(strings.TrimSpace(records[0][0]))
		if strings.Contains(first, "aishe") || first == "code" ||
			first == "aishe_code" || first == "org_code" {
			records = records[1:]
		}
	}

	type csvRow struct {
		LineNo       int    `json:"line_no"`
		AisheInput   string `json:"aishe_code"`
		OrgName      string `json:"institution_name"`
		Approve      bool   `json:"approve"`
		Outcome      string `json:"outcome"` // "approved" | "rejected" | "skipped"
		Detail       string `json:"detail,omitempty"`
		OrgCode      string `json:"org_code,omitempty"`
		OrgID        int64  `json:"org_id,omitempty"`
		SubsAffected int    `json:"subscriptions_affected"`
	}
	out := make([]csvRow, 0, len(records))

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db tx: "+err.Error())
		return
	}
	defer tx.Rollback()

	var approved, rejected, skipped int

	for i, row := range records {
		lineNo := i + 1 // header, if any, was popped above
		if len(row) == 0 {
			continue
		}
		aisheInput := strings.TrimSpace(row[0])
		if aisheInput == "" {
			// blank line — silently ignore, don't count against the
			// reviewer's stats
			continue
		}
		orgName := ""
		if len(row) > 1 {
			orgName = strings.TrimSpace(row[1])
		}
		decisionRaw := ""
		if len(row) > 2 {
			decisionRaw = strings.TrimSpace(row[2])
		}

		item := csvRow{
			LineNo: lineNo, AisheInput: aisheInput, OrgName: orgName,
		}

		approve, ok := parseDecisionToken(decisionRaw)
		if !ok {
			item.Outcome = "skipped"
			item.Detail = "decision column must be true/false (got '" + decisionRaw + "')"
			skipped++
			out = append(out, item)
			continue
		}
		item.Approve = approve

		// Resolve org — try the bare AISHE input first, then the
		// "AISHE_" prefixed form used by application_review_shared.go.
		candidates := []string{aisheInput, "AISHE_" + aisheInput}
		var orgID int64
		var orgCode string
		for _, c := range candidates {
			err := tx.QueryRowContext(r.Context(),
				`SELECT id, code FROM organizations WHERE code = $1`, c,
			).Scan(&orgID, &orgCode)
			if err == nil {
				break
			}
			if !errors.Is(err, sql.ErrNoRows) {
				writeErr(w, http.StatusInternalServerError,
					fmt.Sprintf("db org lookup line %d: %s", lineNo, err.Error()))
				return
			}
		}
		if orgID == 0 {
			item.Outcome = "skipped"
			item.Detail = "no organisation found for aishe_code '" + aisheInput + "'"
			skipped++
			out = append(out, item)
			continue
		}
		item.OrgID = orgID
		item.OrgCode = orgCode

		// Update pending subscription requests for this org under this
		// reviewer's client. Whether approving or rejecting, we scope
		// to exams the client OWNS — a rogue CSV can never touch
		// another exam board's subscriptions.
		targetStatus := "rejected"
		auditAction := "subscription.bulk_csv_reject"
		if approve {
			targetStatus = "approved"
			auditAction = "subscription.bulk_csv_approve"
		}
		_ = auditAction // per-row audit is optional; batch audit below covers it

		res, err := tx.ExecContext(r.Context(), `
			UPDATE organization_exam_subscriptions
			   SET status = $1,
			       approval_type = 'per_exam',
			       reviewed_at = NOW(),
			       reviewed_by = $2,
			       review_note = $3
			 WHERE org_id = $4
			   AND status = 'pending'
			   AND exam_id IN (SELECT id FROM exams WHERE client_id = $5)`,
			targetStatus, claims.UserID,
			"Bulk CSV upload by reviewer",
			orgID, clientID,
		)
		if err != nil {
			writeErr(w, http.StatusInternalServerError,
				fmt.Sprintf("db update line %d: %s", lineNo, err.Error()))
			return
		}
		n, _ := res.RowsAffected()
		item.SubsAffected = int(n)
		if n == 0 {
			// The row wasn't wrong — it just had nothing pending under
			// this client. Common on repeat uploads. Skipped, not
			// approved/rejected, so the reviewer sees the reality.
			item.Outcome = "skipped"
			item.Detail = "no PENDING subscription for this org under this client"
			skipped++
		} else if approve {
			item.Outcome = "approved"
			approved++
		} else {
			item.Outcome = "rejected"
			rejected++
		}
		out = append(out, item)
	}

	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db commit: "+err.Error())
		return
	}

	s.auditFromRequest(r, "subscription.bulk_csv_decide", "organization_exam_subscriptions", 0, map[string]any{
		"client_id":  clientID,
		"filename":   hdr.Filename,
		"total_rows": len(out),
		"approved":   approved,
		"rejected":   rejected,
		"skipped":    skipped,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"total_rows": len(out),
		"approved":   approved,
		"rejected":   rejected,
		"skipped":    skipped,
		"rows":       out,
	})
}

// parseDecisionToken maps a wide range of "yes/no" spellings to a bool.
// Returns (bool, false) when the token doesn't match any known form.
func parseDecisionToken(s string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "t", "yes", "y", "1", "approve", "approved", "ok":
		return true, true
	case "false", "f", "no", "n", "0", "reject", "rejected", "deny", "denied":
		return false, true
	}
	return false, false
}

// sniffCSVDelimiter picks between comma, tab, and semicolon by counting
// occurrences in the header portion of the file, ignoring anything
// inside double quotes. Falls back to comma on a tie or empty sample.
//
// Motivation: Excel and Sheets commonly export "Tab delimited" or
// "Semicolon delimited" (European locales) under a .csv extension.
// Without sniffing, the Go csv reader — which defaults to comma —
// would read each row as one giant field, producing a single-row
// upload with the header + data mashed together (bug seen
// 2026-08-24 on a bulk-decide TSV upload).
func sniffCSVDelimiter(sample []byte) rune {
	if len(sample) == 0 {
		return ','
	}
	counts := map[rune]int{',': 0, '\t': 0, ';': 0}
	inQuote := false
	for _, b := range sample {
		c := rune(b)
		if c == '"' {
			inQuote = !inQuote
			continue
		}
		if inQuote {
			continue
		}
		if c == '\n' {
			// Only score the first line — mixed delimiters across
			// rows can happen in messy exports; header row is the
			// authoritative signal.
			break
		}
		if _, ok := counts[c]; ok {
			counts[c]++
		}
	}
	best := ','
	bestN := counts[',']
	if counts['\t'] > bestN {
		best = '\t'
		bestN = counts['\t']
	}
	if counts[';'] > bestN {
		best = ';'
	}
	return best
}
