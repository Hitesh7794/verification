package api

import (
	"database/sql"
	"net/http"
	"strconv"
	"time"

	"github.com/veni/neet-verification/internal/db"
)

// GET /api/verifications/mine — a client-role operator's own past
// verifications, verified + denied only. Abandoned flows (started
// liveness but never produced a verifications row) are excluded per
// product ask — the operator's "who did I check" list should not read
// as their own dropouts.
//
// Scoped to the caller. `operator_id` is the `users.id` FK of the
// specific user who signed the verification, so an operator only ever
// sees their own history — never their org-mates', never every row on
// the box. Admins/superadmins keep /api/admin/verifications.
//
// Pagination: cursor-based, same shape as /api/admin/verifications so
// clients don't need a second dialect. Pass ?before=<id> to fetch the
// page older than that verifications.id. Response carries
// `next_cursor` (the smallest id in the returned page) whenever the
// page is full — a null next_cursor means "no more".

const myVerificationsPageSize = 30

type myVerificationRow struct {
	ID        int64  `json:"id"`
	RollNo    string `json:"roll_no"`
	Status    string `json:"status"`
	FaceMatch bool   `json:"face_match"`
	FpMatch   bool   `json:"fp_match"`
	CreatedAt string `json:"created_at"`
}

type myVerificationsResp struct {
	Items      []myVerificationRow `json:"items"`
	NextCursor *int64              `json:"next_cursor,omitempty"`
}

func (s *Server) listMyVerifications(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r)
	if c == nil || c.UserID == 0 {
		writeErr(w, http.StatusUnauthorized, "auth required")
		return
	}
	// Parse optional cursor. Malformed (negative, non-numeric) is
	// treated as "no cursor" so a bad client can't 400 the whole
	// history — the operator just gets page 1 back.
	var beforeID int64
	if bs := r.URL.Query().Get("before"); bs != "" {
		if n, err := strconv.ParseInt(bs, 10, 64); err == nil && n > 0 {
			beforeID = n
		}
	}

	// One extra row so we can tell "was this the last page?" without
	// a second COUNT query — if we get pageSize back the caller can
	// keep paging; if fewer, we know we hit the end.
	limit := myVerificationsPageSize + 1

	var (
		rows *sql.Rows
		err  error
	)
	if beforeID > 0 {
		rows, err = s.deps.DB.QueryContext(r.Context(), db.Q(`
			SELECT v.id, v.roll_no, v.status,
			       COALESCE(v.face_match, 0),
			       COALESCE(v.fp_match, 0),
			       v.created_at
			  FROM verifications v
			 WHERE v.operator_id = ?
			   AND v.status IN ('verified', 'denied')
			   AND v.id < ?
			 ORDER BY v.id DESC
			 LIMIT ?
		`), c.UserID, beforeID, limit)
	} else {
		rows, err = s.deps.DB.QueryContext(r.Context(), db.Q(`
			SELECT v.id, v.roll_no, v.status,
			       COALESCE(v.face_match, 0),
			       COALESCE(v.fp_match, 0),
			       v.created_at
			  FROM verifications v
			 WHERE v.operator_id = ?
			   AND v.status IN ('verified', 'denied')
			 ORDER BY v.id DESC
			 LIMIT ?
		`), c.UserID, limit)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "query: "+err.Error())
		return
	}
	defer rows.Close()

	out := myVerificationsResp{Items: make([]myVerificationRow, 0, myVerificationsPageSize)}
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

	// If we got the sentinel extra row, there's another page — drop
	// it from the response and expose its predecessor as the cursor.
	if len(out.Items) > myVerificationsPageSize {
		out.Items = out.Items[:myVerificationsPageSize]
		last := out.Items[len(out.Items)-1].ID
		out.NextCursor = &last
	}
	writeJSON(w, http.StatusOK, out)
}
