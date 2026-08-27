package api

// Operator-facing "list my exams" endpoint. Backs the dashboard's
// current-exam picker so an operator holding multiple exams can pick
// which one they are verifying for right now. The picked exam is sent
// back to every subsequent request as the `X-Exam-Id` header — that
// header is what resolveExamForOperator + lookupExamCandidate scope
// against, so data never crosses exams even when the same person is
// assigned to more than one.

import (
	"net/http"
	"time"

	"github.com/veni/neet-verification/internal/db"
)

type operatorExamRow struct {
	ID               int64  `json:"id"`
	ExamCode         string `json:"exam_code"`
	Name             string `json:"name"`
	ClientName       string `json:"client_name,omitempty"`
	VerificationFrom string `json:"verification_from"` // IST wall-clock, YYYY-MM-DDTHH:MM
	VerificationTo   string `json:"verification_to"`
	Closed           bool   `json:"closed"`
	// CandidateCount lets the picker show "1,204 candidates" per exam
	// so operators can eyeball which board is bigger. Small aggregate
	// per row — measured under 5ms for a typical roster.
	CandidateCount int64 `json:"candidate_count"`
}

// listOperatorExams returns every exam the caller is assigned to via
// operator_exams, ordered so the exam with the soonest verification
// window comes first (most likely to be "the one I want right now").
func (s *Server) listOperatorExams(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	if c == nil || c.Role != "client" || c.UserID == 0 {
		writeErr(w, http.StatusForbidden, "operator role required")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(), db.Q(`
		SELECT e.id, e.exam_code, e.name, cl.name,
		       COALESCE(TO_CHAR(e.verification_from, 'YYYY-MM-DD"T"HH24:MI'), ''),
		       COALESCE(TO_CHAR(e.verification_to,   'YYYY-MM-DD"T"HH24:MI'), ''),
		       e.closed,
		       (SELECT COUNT(*) FROM exam_candidates ec WHERE ec.exam_id = e.id)
		  FROM operator_exams oe
		  JOIN exams   e  ON e.id = oe.exam_id
		  JOIN clients cl ON cl.id = e.client_id
		 WHERE oe.user_id = ?
		 ORDER BY e.verification_from ASC NULLS LAST, e.id ASC
	`), c.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db read: "+err.Error())
		return
	}
	defer rows.Close()

	out := []operatorExamRow{}
	for rows.Next() {
		var row operatorExamRow
		var closed int
		if err := rows.Scan(&row.ID, &row.ExamCode, &row.Name, &row.ClientName,
			&row.VerificationFrom, &row.VerificationTo, &closed, &row.CandidateCount); err != nil {
			writeErr(w, http.StatusInternalServerError, "row scan: "+err.Error())
			return
		}
		row.Closed = closed == 1
		out = append(out, row)
	}
	// A tiny freshness stamp so the FE can decide whether to refresh
	// on next visibility change instead of firing a fresh list on
	// every tab focus.
	writeJSON(w, http.StatusOK, map[string]any{
		"exams":       out,
		"fetched_at":  time.Now().UTC().Format(time.RFC3339),
	})
}
