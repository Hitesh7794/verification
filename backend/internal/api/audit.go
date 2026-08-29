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

// GET /api/super/audit + auditRow / auditListResp + superAuditList +
// fmtParseInt / fmtParseInt64 were retired 2026-08-27: the FE
// superadmin dashboard never called /super/audit, so a paginated
// audit reader with no viewer was pure dead weight. The audit-log
// WRITE path (audit / auditFromRequest / auditAnonymous above) stays
// — every mutating handler still records events; we simply lost the
// on-portal viewer. If a viewer comes back, re-add here.

