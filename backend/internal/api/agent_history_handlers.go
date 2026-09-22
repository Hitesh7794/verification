package api

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/veni/neet-verification/internal/db"
)

// GET /api/verifications/mine — a client-role operator's own past
// verifications, verified + denied only. Abandoned flows (started
// liveness but never produced a verifications row) are excluded per
// product ask — the operator's "who did I check" list should not read
// as their own dropouts. Bounded to the most recent 100 rows so a
// long day still fits one payload; if we later need pagination we can
// add ?before=<id> the same way admin/verifications does.
//
// Additive endpoint — nothing else references it, so shipping it can
// neither break existing clients nor cause an unrelated regression.

type myVerificationRow struct {
	ID        int64  `json:"id"`
	RollNo    string `json:"roll_no"`
	Status    string `json:"status"`
	FaceMatch bool   `json:"face_match"`
	FpMatch   bool   `json:"fp_match"`
	CreatedAt string `json:"created_at"`
}

type myVerificationsResp struct {
	Items []myVerificationRow `json:"items"`
}

func (s *Server) listMyVerifications(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	if c == nil || c.UserID == 0 {
		writeErr(w, http.StatusUnauthorized, "auth required")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(), db.Q(`
		SELECT v.id, v.roll_no, v.status,
		       COALESCE(v.face_match, 0),
		       COALESCE(v.fp_match, 0),
		       v.created_at
		  FROM verifications v
		 WHERE v.operator_id = ?
		   AND v.status IN ('verified', 'denied')
		 ORDER BY v.created_at DESC
		 LIMIT 100
	`), c.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "query: "+err.Error())
		return
	}
	defer rows.Close()

	out := myVerificationsResp{Items: make([]myVerificationRow, 0, 64)}
	for rows.Next() {
		var (
			row       myVerificationRow
			face      int
			fp        int
			createdAt time.Time
		)
		if err := rows.Scan(&row.ID, &row.RollNo, &row.Status, &face, &fp, &createdAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan: "+err.Error())
			return
		}
		row.FaceMatch = face == 1
		row.FpMatch = fp == 1
		row.CreatedAt = createdAt.UTC().Format("2006-01-02T15:04:05Z")
		out.Items = append(out.Items, row)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "rows: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Silence the sql import when db.Q's generated code doesn't reference
// it directly — keeps go vet happy in some tags without pulling the
// import in unnecessarily elsewhere.
var _ = sql.ErrNoRows
