package api

// Admin-side self-service exam catalog surface (Phase 2).
//
//   GET    /api/admin/catalog             all visible clients + their
//                                         visible+open exams. Each exam
//                                         carries a `subscribed` flag
//                                         so the UI can render the
//                                         [Subscribe]/[Unsubscribe]
//                                         button correctly in one pass.
//
//   GET    /api/admin/subscriptions       just the org's subscribed
//                                         exams, hydrated with client
//                                         name + assigned-operator count.
//
//   POST   /api/admin/subscriptions       { exam_id } — add. Idempotent
//                                         via INSERT OR IGNORE.
//
//   DELETE /api/admin/subscriptions/{id}  unsubscribe. Cascades into
//                                         operator_exams so any operator
//                                         still assigned this exam is
//                                         quietly cut off — matches the
//                                         "operators lose access" answer
//                                         to my Q3.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/veni/neet-verification/internal/db"
)

// ── /api/admin/catalog ────────────────────────────────────────────────

type catalogExam struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	ExamCode           string `json:"exam_code"`
	VerificationFrom   string `json:"verification_from"`
	VerificationTo     string `json:"verification_to"`
	CandidateCount     int64  `json:"candidate_count"`
	Subscribed         bool   `json:"subscribed"` // true if status == "approved"
	SubscriptionStatus string `json:"subscription_status"` // "none", "pending", "approved", "rejected", "revoked"
	ReviewNote         string `json:"review_note,omitempty"`
	RequestedAt        string `json:"requested_at,omitempty"`
}
type catalogClient struct {
	ID                    int64         `json:"id"`
	Name                  string        `json:"name"`
	Notes                 string        `json:"notes,omitempty"`
	ClientBlanketApproved bool          `json:"client_blanket_approved"`
	Exams                 []catalogExam `json:"exams"`
}

func (s *Server) adminCatalog(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID

	// Single query: visible clients LEFT JOIN their visible+open exams,
	// LEFT JOIN this org's subscriptions and client-level approvals.
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT
			c.id, c.name, COALESCE(c.notes,''),
			CASE WHEN coa.client_id IS NOT NULL THEN 1 ELSE 0 END AS client_blanket_approved,
			e.id, e.name, e.exam_code,
			COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD"T"HH24:MI'), ''),
			COALESCE(TO_CHAR(e.verification_to,   'YYYY-MM-DD"T"HH24:MI'), ''),
			(SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id),
			COALESCE(s.status, ''),
			COALESCE(s.review_note, ''),
			s.requested_at
		FROM clients c
		LEFT JOIN client_organization_approvals coa
			ON coa.client_id = c.id AND coa.org_id = $1
		LEFT JOIN exams e
			ON e.client_id = c.id
			AND e.visible = 1
			AND e.closed = 0
			AND (e.verification_to IS NULL OR e.verification_to >= CURRENT_TIMESTAMP)
		LEFT JOIN organization_exam_subscriptions s
			ON s.exam_id = e.id AND s.org_id = $2
		WHERE c.visible = 1 AND c.closed = 0
		ORDER BY c.name, e.created_at DESC`, orgID, orgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	byClient := map[int64]*catalogClient{}
	order := []int64{}
	for rows.Next() {
		var (
			cID             int64
			cName, cNotes   string
			blanketApproved int
			eID             sql.NullInt64
			eName, eCode    sql.NullString
			from, to        sql.NullString
			candCount       sql.NullInt64
			subStatus       string
			reviewNote      string
			reqAt           sql.NullTime
		)
		if err := rows.Scan(&cID, &cName, &cNotes, &blanketApproved,
			&eID, &eName, &eCode, &from, &to, &candCount,
			&subStatus, &reviewNote, &reqAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		cc, ok := byClient[cID]
		if !ok {
			cc = &catalogClient{
				ID:                    cID,
				Name:                  cName,
				Notes:                 cNotes,
				ClientBlanketApproved: blanketApproved == 1,
				Exams:                 []catalogExam{},
			}
			byClient[cID] = cc
			order = append(order, cID)
		}
		if eID.Valid {
			// Subscribed iff an approved subscription row exists OR the
			// client has blanket approval.
			isApproved := subStatus == "approved" || blanketApproved == 1
			var reqAtStr string
			if reqAt.Valid {
				reqAtStr = reqAt.Time.UTC().Format("2006-01-02T15:04:05Z")
			}
			cc.Exams = append(cc.Exams, catalogExam{
				ID:                 eID.Int64,
				Name:               eName.String,
				ExamCode:           eCode.String,
				VerificationFrom:   from.String,
				VerificationTo:     to.String,
				CandidateCount:     candCount.Int64,
				Subscribed:         isApproved,
				SubscriptionStatus: subStatus,
				ReviewNote:         reviewNote,
				RequestedAt:        reqAtStr,
			})
		}
	}

	out := []*catalogClient{}
	for _, id := range order {
		out = append(out, byClient[id])
	}
	writeJSON(w, http.StatusOK, map[string]any{"clients": out})
}

// ── /api/admin/subscriptions ──────────────────────────────────────────

type subscriptionRow struct {
	ExamID           int64  `json:"exam_id"`
	ExamName         string `json:"exam_name"`
	ExamCode         string `json:"exam_code"`
	ClientID         int64  `json:"client_id"`
	ClientName       string `json:"client_name"`
	VerificationFrom string `json:"verification_from"`
	VerificationTo   string `json:"verification_to"`
	CandidateCount   int64  `json:"candidate_count"`
	OperatorCount    int64  `json:"operator_count"`
	ExamClosed       bool   `json:"exam_closed"`
	SubscribedAt     string `json:"subscribed_at"`
}

func (s *Server) adminListSubscriptions(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID

	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT e.id, e.name, e.exam_code, e.client_id, c.name,
		       COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD"T"HH24:MI'), ''),
		       COALESCE(TO_CHAR(e.verification_to,   'YYYY-MM-DD"T"HH24:MI'), ''),
		       e.closed,
		       (SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id),
		       (SELECT COUNT(DISTINCT oe.user_id)
		          FROM operator_exams oe
		          JOIN users u ON u.id = oe.user_id
		         WHERE oe.exam_id = e.id AND u.org_id = $1),
		       s.subscribed_at
		FROM organization_exam_subscriptions s
		JOIN exams e   ON e.id = s.exam_id
		JOIN clients c ON c.id = e.client_id
		WHERE s.org_id = $2 AND s.status = 'approved'
		  AND e.closed = 0
		  AND (e.verification_to IS NULL OR e.verification_to >= CURRENT_TIMESTAMP)
		ORDER BY s.subscribed_at DESC`, orgID, orgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()
	out := []subscriptionRow{}
	for rows.Next() {
		var r subscriptionRow
		var closed int
		if err := rows.Scan(&r.ExamID, &r.ExamName, &r.ExamCode,
			&r.ClientID, &r.ClientName, &r.VerificationFrom, &r.VerificationTo,
			&closed, &r.CandidateCount, &r.OperatorCount, &r.SubscribedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		r.ExamClosed = closed == 1
		out = append(out, r)
	}
	writeJSON(w, http.StatusOK, map[string]any{"subscriptions": out})
}

type subscribeReq struct {
	ExamID int64 `json:"exam_id"`
}

func (s *Server) adminSubscribe(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID
	var req subscribeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.ExamID <= 0 {
		writeErr(w, http.StatusBadRequest, "exam_id required")
		return
	}
	// Verify the exam exists, is visible, and not closed — matches what
	// the catalog surfaces. Hidden exams are not subscribable.
	var clientID int64
	var visible, closed int
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT client_id, visible, closed FROM exams WHERE id = $1`, req.ExamID,
	).Scan(&clientID, &visible, &closed)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "exam not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	if visible != 1 || closed != 0 {
		writeErr(w, http.StatusConflict, "exam is hidden or closed; cannot subscribe")
		return
	}

	// V15 flow (2026-08-25): admin subscribe is immediate — no review
	// step, no pending status. The previous pending → reviewer inbox
	// path is retired (the reviewer's subscription-request page is
	// gone), and the KYC review already covers the "does this org
	// deserve access to this client's exams" question. So a click on
	// the admin's Subscribe button flips the row straight to approved.
	if _, err := s.deps.DB.ExecContext(r.Context(), `
		INSERT INTO organization_exam_subscriptions(
			org_id, exam_id, status, approval_type,
			requested_at, subscribed_at, subscribed_by,
			reviewed_at, reviewed_by, review_note
		) VALUES(
			$1, $2, 'approved', 'blanket_client',
			NOW(), NOW(), $3,
			NOW(), $3, 'Admin self-subscribe (V15)'
		)
		ON CONFLICT (org_id, exam_id) DO UPDATE SET
			status = 'approved',
			approval_type = 'blanket_client',
			requested_at = NOW(),
			subscribed_at = NOW(),
			subscribed_by = EXCLUDED.subscribed_by,
			reviewed_at = NOW(),
			reviewed_by = EXCLUDED.reviewed_by,
			review_note = EXCLUDED.review_note`,
		orgID, req.ExamID, claims.UserID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
		return
	}
	// clientID captured earlier for future audit / rules but currently
	// unused now that blanket-approval branching is gone.
	_ = clientID
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":      true,
		"exam_id": req.ExamID,
		"status":  "approved",
	})
}

func (s *Server) adminUnsubscribe(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID
	examID, err := parseInt64(chi.URLParam(r, "exam_id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad exam_id")
		return
	}

	tx, err := s.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db begin")
		return
	}
	defer tx.Rollback()

	// Remove the org's subscription…
	res, err := tx.ExecContext(r.Context(),
		`DELETE FROM organization_exam_subscriptions WHERE org_id = $1 AND exam_id = $2`,
		orgID, examID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db delete: "+err.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		writeErr(w, http.StatusNotFound, "not subscribed to this exam")
		return
	}
	// …and cascade into operator_exams: any of this org's operators still
	// assigned this exam loses that assignment quietly. We don't touch
	// operators from OTHER orgs (their subscription is independent).
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── helpers used by operator-access handlers when they set exam_ids ──

// setOperatorExams replaces the operator_exams rows for a given user
// with the supplied exam-id list. Enforces two rules atomically:
//
//   1. The user must belong to the caller's org.
//   2. Every exam in the list must be currently subscribed by the caller's
//      org. Prevents an admin from assigning their operator an exam their
//      college has never subscribed to.
//
// Returns a user-facing error string when the constraints don't hold.
func (s *Server) setOperatorExams(tx *sql.Tx, orgID, userID int64, examIDs []int64) error {
	// Enforce exactly-one-exam-per-operator. Zero would leave the
	// operator seeing "no data" on every lookup with no explanation;
	// two+ would collide with the UNIQUE index from migration 022.
	// Checking here gives a clean 4xx instead of a raw DB error.
	if len(examIDs) == 0 {
		return errors.New("a verification agent must be assigned to exactly one exam")
	}
	if len(examIDs) > 1 {
		return errors.New("a verification agent can be assigned to only one exam")
	}

	// Sanity: user belongs to org.
	var uOrg sql.NullInt64
	if err := tx.QueryRow(db.Q(`SELECT org_id FROM users WHERE id = $1`), userID).Scan(&uOrg); err != nil {
		return fmt.Errorf("operator not found: %w", err)
	}
	if !uOrg.Valid || uOrg.Int64 != orgID {
		return errors.New("verification agent does not belong to your organisation")
	}

	// Every exam in the incoming list must be subscribed by this org.
	if len(examIDs) > 0 {
		// Build (?, ?, …) placeholders.
		placeholders := make([]string, len(examIDs))
		args := make([]any, 0, len(examIDs)+1)
		args = append(args, orgID)
		for i, id := range examIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		q := "SELECT COUNT(*) FROM organization_exam_subscriptions " +
			"WHERE org_id = ? AND exam_id IN (" + strings.Join(placeholders, ",") + ")"
		var subCount int
		if err := tx.QueryRow(db.Q(q), args...).Scan(&subCount); err != nil {
			return err
		}
		if subCount != len(examIDs) {
			return errors.New("one or more of the selected exams is not subscribed by your organisation")
		}
	}

	// Replace: delete all + re-insert. Small list, cheap.
	if _, err := tx.Exec(db.Q(`DELETE FROM operator_exams WHERE user_id = $1`), userID); err != nil {
		return err
	}
	for _, id := range examIDs {
		if _, err := tx.Exec(
			`INSERT INTO operator_exams(user_id, exam_id) VALUES($1, $2)`,
			userID, id,
		); err != nil {
			return err
		}
	}
	return nil
}
