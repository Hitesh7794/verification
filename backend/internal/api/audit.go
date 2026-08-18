package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/db"
)

// Audit log write helpers. Append-only, best-effort: a failed audit
// write logs to stdout but never blocks the request that triggered
// it (better to lose an audit row than to refuse a legitimate
// password change because the audit table was momentarily unhappy).
//
// Call from handlers like:
//
//	auditFromRequest(r, "password.change", "user", c.UserID, nil)
//	auditFromRequest(r, "wallet.deposit", "org", orgID, map[string]any{
//	    "amount_paise": req.AmountPaise,
//	})
//
// The actor identity is taken from the JWT claims on the request.
// For pre-auth events (login failures), use auditAnonymous() and
// pass the attempted username via metadata.

func (s *Server) audit(ctx context.Context, actor *auth.Claims, action, targetType string, targetID int64, ip string, metadata map[string]any) {
	var (
		actorID       sql.NullInt64
		actorUsername sql.NullString
		actorRole     sql.NullString
		orgID         sql.NullInt64
		metaJSON      sql.NullString
		tType         sql.NullString
		tID           sql.NullInt64
	)
	if actor != nil {
		actorID = sql.NullInt64{Int64: actor.UserID, Valid: true}
		actorUsername = sql.NullString{String: actor.Username, Valid: actor.Username != ""}
		actorRole = sql.NullString{String: actor.Role, Valid: actor.Role != ""}
		if actor.OrgID != nil {
			orgID = sql.NullInt64{Int64: *actor.OrgID, Valid: true}
		}
	}
	if targetType != "" {
		tType = sql.NullString{String: targetType, Valid: true}
	}
	if targetID != 0 {
		tID = sql.NullInt64{Int64: targetID, Valid: true}
	}
	if metadata != nil {
		if b, err := json.Marshal(metadata); err == nil {
			metaJSON = sql.NullString{String: string(b), Valid: true}
		}
	}
	_, err := s.deps.DB.ExecContext(ctx,
		db.Q(`INSERT INTO audit_log(
			actor_user_id, actor_username, actor_role,
			org_id, action, target_type, target_id, metadata, ip
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`),
		actorID, actorUsername, actorRole,
		orgID, action, tType, tID, metaJSON,
		sql.NullString{String: ip, Valid: ip != ""},
	)
	if err != nil {
		// Best-effort logging — never propagate, never break the
		// caller's request just because the audit insert failed.
		log.Printf("audit.write %s: %v", action, err)
	}
}

// auditFromRequest is the convenience wrapper most call sites should
// use. Pulls the actor from claims and the IP from clientIP().
func (s *Server) auditFromRequest(r *http.Request, action, targetType string, targetID int64, metadata map[string]any) {
	s.audit(r.Context(), claimsFrom(r), action, targetType, targetID, clientIP(r), metadata)
}

// auditAnonymous logs an event that happens before auth — login
// failures, set-password attempts. actor_user_id is left NULL.
func (s *Server) auditAnonymous(r *http.Request, action string, metadata map[string]any) {
	s.audit(r.Context(), nil, action, "", 0, clientIP(r), metadata)
}

// GET /api/super/audit?action=<filter>&before=<id>&limit=N
//
// Paginated read of the audit log for superadmin support work.
// Cursor-by-id keeps results stable under concurrent inserts (new
// rows land with higher IDs, never disturbing older pages).
//
// Optional filter: ?action=password.change to scope to one event kind.
// Default page size: 50, max 200.
type auditRow struct {
	ID            int64          `json:"id"`
	ActorUserID   *int64         `json:"actor_user_id,omitempty"`
	ActorUsername string         `json:"actor_username,omitempty"`
	ActorRole     string         `json:"actor_role,omitempty"`
	OrgID         *int64         `json:"org_id,omitempty"`
	Action        string         `json:"action"`
	TargetType    string         `json:"target_type,omitempty"`
	TargetID      *int64         `json:"target_id,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	IP            string         `json:"ip,omitempty"`
	CreatedAt     string         `json:"created_at"`
}

type auditListResp struct {
	Rows       []auditRow `json:"rows"`
	NextCursor int64      `json:"next_cursor"`
}

func (s *Server) superAuditList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	action := q.Get("action")
	limit := 50
	if v := q.Get("limit"); v != "" {
		var n int
		_, _ = fmtParseInt(v, &n)
		if n > 0 && n <= 200 {
			limit = n
		}
	}
	var beforeID int64
	_, _ = fmtParseInt64(q.Get("before"), &beforeID)

	args := []any{}
	where := ""
	if action != "" {
		where = " WHERE action = ?"
		args = append(args, action)
	}
	if beforeID > 0 {
		if where == "" {
			where = " WHERE "
		} else {
			where += " AND "
		}
		where += "id < ?"
		args = append(args, beforeID)
	}
	args = append(args, limit)

	rows, err := s.deps.DB.QueryContext(r.Context(),
		db.Q(`SELECT id, actor_user_id, COALESCE(actor_username,''), COALESCE(actor_role,''),
		        org_id, action, COALESCE(target_type,''), target_id,
		        COALESCE(metadata,''), COALESCE(ip,''), created_at
		 FROM audit_log`+where+` ORDER BY id DESC LIMIT ?`),
		args...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "audit: "+err.Error())
		return
	}
	defer rows.Close()
	out := make([]auditRow, 0, limit)
	for rows.Next() {
		var row auditRow
		var actorID, orgID, targetID sql.NullInt64
		var metaJSON string
		if err := rows.Scan(
			&row.ID, &actorID, &row.ActorUsername, &row.ActorRole,
			&orgID, &row.Action, &row.TargetType, &targetID,
			&metaJSON, &row.IP, &row.CreatedAt,
		); err != nil {
			writeErr(w, http.StatusInternalServerError, "audit scan: "+err.Error())
			return
		}
		if actorID.Valid {
			v := actorID.Int64
			row.ActorUserID = &v
		}
		if orgID.Valid {
			v := orgID.Int64
			row.OrgID = &v
		}
		if targetID.Valid {
			v := targetID.Int64
			row.TargetID = &v
		}
		if metaJSON != "" {
			_ = json.Unmarshal([]byte(metaJSON), &row.Metadata)
		}
		out = append(out, row)
	}
	var next int64
	if len(out) == limit {
		next = out[len(out)-1].ID
	}
	writeJSON(w, http.StatusOK, auditListResp{Rows: out, NextCursor: next})
}

// Small string→int parser helpers, scoped here to keep audit.go
// self-contained.
func fmtParseInt(s string, dst *int) (int, error) {
	if s == "" {
		return 0, nil
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, nil
		}
		n = n*10 + int(c-'0')
	}
	*dst = n
	return n, nil
}
func fmtParseInt64(s string, dst *int64) (int64, error) {
	if s == "" {
		return 0, nil
	}
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, nil
		}
		n = n*10 + int64(c-'0')
	}
	*dst = n
	return n, nil
}
