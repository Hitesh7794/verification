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
)

// ── /api/admin/catalog ────────────────────────────────────────────────

type catalogExam struct {
	ID               int64  `json:"id"`
	Name             string `json:"name"`
	ExamCode         string `json:"exam_code"`
	VerificationFrom string `json:"verification_from"`
	VerificationTo   string `json:"verification_to"`
	CandidateCount   int64  `json:"candidate_count"`
	Subscribed       bool   `json:"subscribed"`
}
type catalogClient struct {
	ID    int64         `json:"id"`
	Name  string        `json:"name"`
	Notes string        `json:"notes,omitempty"`
	Exams []catalogExam `json:"exams"`
}

func (s *Server) adminCatalog(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin org context required")
		return
	}
	orgID := *claims.OrgID

	// Single query: visible clients LEFT JOIN their visible+open exams,
	// LEFT JOIN this org's subscriptions so we know per-exam whether the
	// admin has already subscribed. Ordering keeps clients alphabetical
	// and exams by creation.
	rows, err := s.deps.DB.QueryContext(r.Context(), `
		SELECT
			c.id, c.name, COALESCE(c.notes,''),
			e.id, e.name, e.exam_code,
			e.verification_from, e.verification_to,
			(SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id),
			CASE WHEN s.exam_id IS NULL THEN 0 ELSE 1 END AS subscribed
		FROM clients c
		LEFT JOIN exams e
			ON e.client_id = c.id
			AND e.visible = 1
			AND e.closed = 0
		LEFT JOIN organization_exam_subscriptions s
			ON s.exam_id = e.id AND s.org_id = ?
		WHERE c.visible = 1 AND c.closed = 0
		ORDER BY c.name, e.created_at DESC`, orgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	byClient := map[int64]*catalogClient{}
	order := []int64{}
	for rows.Next() {
		var (
			cID           int64
			cName, cNotes string
			eID           sql.NullInt64
			eName, eCode  sql.NullString
			from, to      sql.NullString
			candCount     sql.NullInt64
			sub           int
		)
		if err := rows.Scan(&cID, &cName, &cNotes,
			&eID, &eName, &eCode, &from, &to, &candCount, &sub); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		cli, ok := byClient[cID]
		if !ok {
			cli = &catalogClient{ID: cID, Name: cName, Notes: cNotes, Exams: []catalogExam{}}
			byClient[cID] = cli
			order = append(order, cID)
		}
		if eID.Valid {
			cli.Exams = append(cli.Exams, catalogExam{
				ID:               eID.Int64,
				Name:             eName.String,
				ExamCode:         eCode.String,
				VerificationFrom: from.String,
				VerificationTo:   to.String,
				CandidateCount:   candCount.Int64,
				Subscribed:       sub == 1,
			})
		}
	}
	out := []catalogClient{}
	for _, id := range order {
		out = append(out, *byClient[id])
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
		       e.verification_from, e.verification_to, e.closed,
		       (SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id),
		       (SELECT COUNT(DISTINCT oe.user_id)
		          FROM operator_exams oe
		          JOIN users u ON u.id = oe.user_id
		         WHERE oe.exam_id = e.id AND u.org_id = ?),
		       s.subscribed_at
		FROM organization_exam_subscriptions s
		JOIN exams e   ON e.id = s.exam_id
		JOIN clients c ON c.id = e.client_id
		WHERE s.org_id = ?
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
	var visible, closed int
	err := s.deps.DB.QueryRowContext(r.Context(),
		`SELECT visible, closed FROM exams WHERE id = ?`, req.ExamID,
	).Scan(&visible, &closed)
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
	if _, err := s.deps.DB.ExecContext(r.Context(), `
		INSERT INTO organization_exam_subscriptions(org_id, exam_id, subscribed_by)
		VALUES(?, ?, ?)
		ON CONFLICT DO NOTHING`,
		orgID, req.ExamID, claims.UserID,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "db insert: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "exam_id": req.ExamID})
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
		`DELETE FROM organization_exam_subscriptions WHERE org_id = ? AND exam_id = ?`,
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
		 WHERE exam_id = ?
		   AND user_id IN (SELECT id FROM users WHERE org_id = ?)`,
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
		return errors.New("an operator must be assigned to exactly one exam")
	}
	if len(examIDs) > 1 {
		return errors.New("an operator can be assigned to only one exam")
	}

	// Sanity: user belongs to org.
	var uOrg sql.NullInt64
	if err := tx.QueryRow(`SELECT org_id FROM users WHERE id = ?`, userID).Scan(&uOrg); err != nil {
		return fmt.Errorf("operator not found: %w", err)
	}
	if !uOrg.Valid || uOrg.Int64 != orgID {
		return errors.New("operator does not belong to your organisation")
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
		if err := tx.QueryRow(q, args...).Scan(&subCount); err != nil {
			return err
		}
		if subCount != len(examIDs) {
			return errors.New("one or more of the selected exams is not subscribed by your organisation")
		}
	}

	// Replace: delete all + re-insert. Small list, cheap.
	if _, err := tx.Exec(`DELETE FROM operator_exams WHERE user_id = ?`, userID); err != nil {
		return err
	}
	for _, id := range examIDs {
		if _, err := tx.Exec(
			`INSERT INTO operator_exams(user_id, exam_id) VALUES(?, ?)`,
			userID, id,
		); err != nil {
			return err
		}
	}
	return nil
}
