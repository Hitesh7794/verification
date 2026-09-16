package api

// Operator streak → auto-disable (V30, 2026-09-14).
//
// Rule: three consecutive DENY verdicts by the same operator locks the
// account. Any APPROVE resets the counter to zero. On lockout the row
// is stamped:
//
//     users.disabled_at    = NOW()
//     users.disable_reason = 'auto_streak'
//
// The auth middleware already blocks every subsequent request from a
// user whose disabled_at is set, so the operator is booted on their
// very next call. Lockouts marked 'auto_streak' can ONLY be lifted by
// a superadmin or the client's reviewer — the institute admin (the
// same admin whose agent went rogue) can still lift their own manual
// disables through /api/admin/operators/:id/enable, but that route
// now refuses to touch anything with disable_reason='auto_streak'.
//
// One helper is called from the verification write path
// (bumpOperatorStreak), and two HTTP handlers expose the lift-lock
// action to superadmin and reviewer.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/veni/neet-verification/internal/email"
)

// streakDenyThreshold is the number of consecutive denies that trips
// the auto-disable. Three is the value the product ask picked; kept
// as a named const so the tuning point is obvious if we ever change it.
const streakDenyThreshold = 3

// bumpOperatorStreak updates users.consecutive_denials in response to
// one verdict submitted by the operator (users.id = operatorID).
// verified=true resets the counter; false increments it and, if it
// crosses the threshold, stamps disabled_at + disable_reason. Fires
// the notification email exactly once, when the streak trips (not on
// every subsequent deny that ticks the counter up while the user is
// already off).
//
// Best-effort: any DB error is logged, never returned — the caller's
// verification response has already been committed.
func (s *Server) bumpOperatorStreak(ctx context.Context, operatorID int64, verified bool) {
	if verified {
		if _, err := s.deps.DB.ExecContext(ctx,
			`UPDATE users SET consecutive_denials = 0 WHERE id = $1`,
			operatorID,
		); err != nil {
			log.Printf("streak: reset for user %d: %v", operatorID, err)
		}
		return
	}

	// Read the current state first so we can tell whether this write
	// is the one that trips the lockout. A single UPDATE ... RETURNING
	// gives us the NEW value only, and we need to compare NEW ≥ 3
	// against OLD-was-enabled to fire the email exactly once.
	var (
		oldStreak     int
		oldDisabledAt sql.NullTime
	)
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT consecutive_denials, disabled_at FROM users WHERE id = $1`,
		operatorID,
	).Scan(&oldStreak, &oldDisabledAt); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("streak: read for user %d: %v", operatorID, err)
		}
		return
	}
	if oldDisabledAt.Valid {
		// Already disabled — don't bump. A disabled operator can't
		// actually submit a verification (middleware blocks them), so
		// this branch is defensive against an in-flight request racing
		// a same-second disable, or an operator whose session was
		// disabled between login and verify.
		return
	}

	newStreak := oldStreak + 1
	tripped := newStreak >= streakDenyThreshold
	if tripped {
		if _, err := s.deps.DB.ExecContext(ctx,
			`UPDATE users
			    SET consecutive_denials = $1,
			        disabled_at         = NOW(),
			        disable_reason      = 'auto_streak'
			  WHERE id = $2 AND disabled_at IS NULL`,
			newStreak, operatorID,
		); err != nil {
			log.Printf("streak: trip for user %d: %v", operatorID, err)
			return
		}
		go s.notifyOperatorAutoDisabled(operatorID)
		// Anonymous audit — the streak trip runs off the operator's
		// own request, but the *actor* here is the platform (auto-
		// enforcement), not the operator themselves. Recording as an
		// unattributed system event keeps the audit-trail honest.
		s.audit(ctx, nil, "operator.auto_disable", "user", operatorID, "",
			map[string]any{
				"consecutive_denials": newStreak,
				"threshold":           streakDenyThreshold,
			})
		return
	}
	if _, err := s.deps.DB.ExecContext(ctx,
		`UPDATE users SET consecutive_denials = $1 WHERE id = $2`,
		newStreak, operatorID,
	); err != nil {
		log.Printf("streak: bump for user %d: %v", operatorID, err)
	}
}

// notifyOperatorAutoDisabled emails the client's reviewer(s) and the
// operator's institute admin(s) that the operator was auto-disabled.
// Short, factual — the reviewer/superadmin has to decide whether to
// lift the lockout, so the email points at where to do that.
func (s *Server) notifyOperatorAutoDisabled(operatorID int64) {
	if s.emailer == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Load context: who is the operator, in which org, which client
	// board owns them. We need the operator's username + display name
	// for the body, org name for context, and client_id to fan out
	// the reviewer list.
	var (
		opUsername sql.NullString
		opDisplay  sql.NullString
		orgID      sql.NullInt64
		orgName    sql.NullString
		clientID   sql.NullInt64
		clientName sql.NullString
	)
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT u.username, u.display_name, u.org_id, o.name, o.application_id
		   FROM users u
		   JOIN organizations o ON o.id = u.org_id
		  WHERE u.id = $1`,
		operatorID,
	).Scan(&opUsername, &opDisplay, &orgID, &orgName, new(sql.NullInt64)); err != nil {
		log.Printf("auto-disable email: lookup user %d: %v", operatorID, err)
		return
	}
	// Resolve the client that owns the org via the COA table (a single
	// row per (client, org) — an org that only has verification
	// subscriptions but no COA still gets the notification skipped
	// silently, which matches how the reviewer inbox scopes queries).
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT c.id, c.name
		   FROM client_organization_approvals coa
		   JOIN clients c ON c.id = coa.client_id
		  WHERE coa.org_id = $1 AND coa.status = 'approved'
		  ORDER BY coa.approved_at DESC
		  LIMIT 1`,
		orgID.Int64,
	).Scan(&clientID, &clientName); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("auto-disable email: coa lookup org=%d: %v", orgID.Int64, err)
		}
	}

	// Reviewer recipients — every active reviewer scoped to the client.
	type recipient struct{ email, name string }
	var recipients []recipient
	if clientID.Valid {
		rows, err := s.deps.DB.QueryContext(ctx,
			`SELECT COALESCE(u.email,''), COALESCE(u.display_name, u.username)
			   FROM users u
			  WHERE u.role = 'client_reviewer'
			    AND u.client_id = $1
			    AND u.disabled_at IS NULL
			    AND COALESCE(u.email,'') <> ''`,
			clientID.Int64,
		)
		if err == nil {
			for rows.Next() {
				var r recipient
				if err := rows.Scan(&r.email, &r.name); err == nil && r.email != "" {
					recipients = append(recipients, r)
				}
			}
			rows.Close()
		}
	}
	// Institute admins for the org — same fan-out.
	if orgID.Valid {
		rows, err := s.deps.DB.QueryContext(ctx,
			`SELECT COALESCE(u.email,''), COALESCE(u.display_name, u.username)
			   FROM users u
			  WHERE u.role = 'admin'
			    AND u.org_id = $1
			    AND u.disabled_at IS NULL
			    AND COALESCE(u.email,'') <> ''`,
			orgID.Int64,
		)
		if err == nil {
			for rows.Next() {
				var r recipient
				if err := rows.Scan(&r.email, &r.name); err == nil && r.email != "" {
					recipients = append(recipients, r)
				}
			}
			rows.Close()
		}
	}
	if len(recipients) == 0 {
		return
	}

	subject := fmt.Sprintf("Agent auto-disabled — %s", opUsername.String)
	body := buildAutoDisableEmail(
		opUsername.String,
		opDisplay.String,
		orgName.String,
		clientName.String,
	)
	for _, r := range recipients {
		if err := s.emailer.Send(ctx, email.Message{
			To:      r.email,
			Subject: subject,
			Body:    body,
		}); err != nil {
			log.Printf("auto-disable email to %s failed: %v", r.email, err)
		}
	}
}

func buildAutoDisableEmail(username, displayName, orgName, clientName string) string {
	var b strings.Builder
	if displayName == "" {
		displayName = username
	}
	if clientName != "" {
		fmt.Fprintf(&b, "The verification agent %s (%s) at %s has been automatically disabled after %d consecutive denied candidates.\n\n",
			displayName, username, orgName, streakDenyThreshold)
	} else {
		fmt.Fprintf(&b, "The verification agent %s (%s) at %s has been automatically disabled after %d consecutive denied candidates.\n\n",
			displayName, username, orgName, streakDenyThreshold)
	}
	b.WriteString("The agent can no longer sign in or submit verifications until the account is re-enabled from the reviewer portal or the superadmin console.\n\n")
	b.WriteString("If this looks like a genuine problem with the exam session (a broken scanner, spoofed candidates, etc.), please investigate before re-enabling the agent.\n\n")
	b.WriteString("— Verification Portal\n")
	return b.String()
}

// ─── HTTP handlers: lift the lockout ──────────────────────────────────

// superadminEnableAgent lifts any disable (manual or auto_streak) on
// the target user, and resets the streak counter.
//
//	POST /api/superadmin/agents/:id/enable
func (s *Server) superadminEnableAgent(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE users
		    SET disabled_at         = NULL,
		        disable_reason      = NULL,
		        consecutive_denials = 0
		  WHERE id = $1 AND role = 'client'`,
		id,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db: "+err.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		writeErr(w, http.StatusNotFound, "agent not found")
		return
	}
	s.auditFromRequest(r, "agent.enable", "user", id, map[string]any{"source": "superadmin"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// reviewerListAgents returns every operator (role='client') under an
// org this reviewer's client owns via COA. Used by the reviewer's
// Agents tab — one row per agent with org name, status pill data, and
// enough to render the Enable button on disabled rows.
//
//	GET /api/client/agents
func (s *Server) reviewerListAgents(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.ClientID == nil {
		writeErr(w, http.StatusForbidden, "reviewer client scope required")
		return
	}
	rows, err := s.deps.DB.QueryContext(r.Context(),
		`SELECT u.id, u.username, u.display_name, COALESCE(u.email,''),
		        u.disabled_at, COALESCE(u.disable_reason,''), COALESCE(u.consecutive_denials, 0),
		        u.org_id, o.name AS org_name, u.created_at
		   FROM users u
		   JOIN organizations o ON o.id = u.org_id
		   JOIN client_organization_approvals coa
		     ON coa.org_id = u.org_id
		    AND coa.client_id = $1
		    AND coa.status = 'approved'
		  WHERE u.role = 'client'
		  ORDER BY (u.disabled_at IS NOT NULL) DESC,
		           u.disabled_at DESC NULLS LAST,
		           u.created_at DESC`,
		*claims.ClientID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db: "+err.Error())
		return
	}
	defer rows.Close()

	type examSummary struct {
		ID       int64  `json:"id"`
		Name     string `json:"name"`
		ExamCode string `json:"exam_code"`
	}
	type item struct {
		ID                 int64         `json:"id"`
		Username           string        `json:"username"`
		DisplayName        string        `json:"display_name"`
		Email              string        `json:"email"`
		DisabledAt         *time.Time    `json:"disabled_at,omitempty"`
		DisableReason      string        `json:"disable_reason,omitempty"`
		ConsecutiveDenials int           `json:"consecutive_denials"`
		OrgID              int64         `json:"org_id"`
		OrgName            string        `json:"org_name"`
		CreatedAt          time.Time     `json:"created_at"`
		Status             string        `json:"status"` // active | disabled
		// V30 (2026-09-14): the exams this agent is assigned to via
		// operator_exams. Scoped to the reviewer's client so an exam
		// under another client never leaks into the response. The FE
		// uses this to drive the exam filter chip on the Agents page
		// and to show the exam name inline on each row.
		AssignedExams []examSummary `json:"assigned_exams"`
	}
	out := []item{}
	byID := map[int64]*item{}
	for rows.Next() {
		var it item
		var disabledAt sql.NullTime
		if err := rows.Scan(&it.ID, &it.Username, &it.DisplayName, &it.Email,
			&disabledAt, &it.DisableReason, &it.ConsecutiveDenials,
			&it.OrgID, &it.OrgName, &it.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "row: "+err.Error())
			return
		}
		it.Status = "active"
		if disabledAt.Valid {
			it.Status = "disabled"
			it.DisabledAt = &disabledAt.Time
		}
		it.AssignedExams = []examSummary{}
		out = append(out, it)
		byID[it.ID] = &out[len(out)-1]
	}

	// Second round trip — pull all operator_exams for the returned
	// agents in one grouped query, then fold into the items above.
	// Scoped to the caller's client_id so an admin cross-assigning an
	// operator to another client's exam (shouldn't happen, but the
	// gate is cheap) never surfaces here.
	if len(byID) > 0 {
		erows, err := s.deps.DB.QueryContext(r.Context(),
			`SELECT oe.user_id, e.id, e.name, e.exam_code
			   FROM operator_exams oe
			   JOIN exams e ON e.id = oe.exam_id
			   JOIN users u ON u.id = oe.user_id
			   JOIN client_organization_approvals coa
			     ON coa.org_id = u.org_id
			    AND coa.client_id = $1
			    AND coa.status = 'approved'
			  WHERE u.role = 'client'
			    AND e.client_id = $1
			  ORDER BY e.name`,
			*claims.ClientID,
		)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "exams: "+err.Error())
			return
		}
		defer erows.Close()
		for erows.Next() {
			var uid int64
			var es examSummary
			if err := erows.Scan(&uid, &es.ID, &es.Name, &es.ExamCode); err != nil {
				continue
			}
			if it, ok := byID[uid]; ok {
				it.AssignedExams = append(it.AssignedExams, es)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// reviewerEnableAgent lifts any disable on an agent that belongs to the
// caller's client (via the COA join through the agent's org). Reviewers
// are scoped to one client; the query enforces that scope in-line so a
// reviewer for client A can't lift an agent under client B.
//
//	POST /api/client/agents/:id/enable
func (s *Server) reviewerEnableAgent(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil || claims.ClientID == nil {
		writeErr(w, http.StatusForbidden, "reviewer client scope required")
		return
	}
	id, err := parseInt64(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad id")
		return
	}
	res, err := s.deps.DB.ExecContext(r.Context(),
		`UPDATE users u
		    SET disabled_at         = NULL,
		        disable_reason      = NULL,
		        consecutive_denials = 0
		  WHERE u.id = $1
		    AND u.role = 'client'
		    AND EXISTS (
		        SELECT 1 FROM client_organization_approvals coa
		         WHERE coa.org_id = u.org_id
		           AND coa.client_id = $2
		           AND coa.status = 'approved'
		    )`,
		id, *claims.ClientID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db: "+err.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// Either not an agent, or not in an org this reviewer owns.
		// 404 rather than 403 so we don't leak which org an agent-id
		// belongs to.
		writeErr(w, http.StatusNotFound, "agent not found in your client scope")
		return
	}
	s.auditFromRequest(r, "agent.enable", "user", id, map[string]any{"source": "reviewer"})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
