package api

// Email dispatch for exam-subscription-request lifecycle (V16, 2026-09-10).
//
// Three moments generate mail:
//   1. Institute admin clicks "Request access" on an exam.
//      → notifyReviewersOfSubscriptionRequest
//      → email(s) to every active client_reviewer under that client.
//   2. Reviewer approves the request.
//      → notifyInstituteOfSubscriptionDecision(approved=true)
//      → email to the institute's head_email.
//   3. Reviewer rejects the request.
//      → notifyInstituteOfSubscriptionDecision(approved=false)
//      → email to the institute's head_email with the rejection note.
//
// Every helper below is safe to call from a `go` block (fire-and-forget).
// They short-circuit if the emailer isn't configured, catch their own
// errors and log — they never panic and never return through the API
// response path.

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/veni/neet-verification/internal/email"
)

// ─── Notify reviewers when an institute requests access ──────────────

func (s *Server) notifyReviewersOfSubscriptionRequest(clientID, orgID, examID int64) {
	if s.emailer == nil {
		return
	}
	// Use a fresh context — the caller's request context is likely
	// already cancelled by the time this goroutine runs.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Look up institute + exam + reviewer recipients in one round trip
	// each. All three queries are indexed and single-row / short-list.
	var orgName, examName, examCode, clientName string
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT o.name, e.name, e.exam_code, c.name
		   FROM exams e
		   JOIN clients c ON c.id = e.client_id
		   JOIN organizations o ON o.id = $1
		  WHERE e.id = $2`,
		orgID, examID,
	).Scan(&orgName, &examName, &examCode, &clientName); err != nil {
		log.Printf("subscription email: metadata lookup failed org=%d exam=%d: %v", orgID, examID, err)
		return
	}

	// Reviewer recipients. There's usually exactly one active reviewer
	// per client (V12 unique index), but we handle the multi-row case
	// safely for orgs that permit multiple — send to each.
	rows, err := s.deps.DB.QueryContext(ctx,
		`SELECT email FROM users
		  WHERE role = 'client_reviewer'
		    AND client_id = $1
		    AND disabled_at IS NULL
		    AND COALESCE(email, '') <> ''`,
		clientID,
	)
	if err != nil {
		log.Printf("subscription email: reviewer lookup failed client=%d: %v", clientID, err)
		return
	}
	defer rows.Close()

	var recipients []string
	for rows.Next() {
		var addr string
		if err := rows.Scan(&addr); err != nil {
			continue
		}
		if addr = strings.TrimSpace(addr); addr != "" {
			recipients = append(recipients, addr)
		}
	}
	if len(recipients) == 0 {
		log.Printf("subscription email: no active reviewer for client=%d — request from %s for exam %s not notified",
			clientID, orgName, examCode)
		return
	}

	subject := fmt.Sprintf("[Verification Portal] New exam access request: %s → %s", orgName, examCode)
	body := buildSubscriptionRequestEmail(orgName, examName, examCode, clientName)
	for _, to := range recipients {
		if err := s.emailer.Send(ctx, email.Message{
			To:      to,
			Subject: subject,
			Body:    body,
		}); err != nil {
			log.Printf("subscription email: send to reviewer %s failed: %v", to, err)
		}
	}
}

// ─── Notify institute when reviewer decides ──────────────────────────

func (s *Server) notifyInstituteOfSubscriptionDecision(orgID, examID int64, approved bool, reviewerNote string) {
	if s.emailer == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var (
		orgName, examName, examCode, clientName string
		headEmail                               sql.NullString
	)
	// head_email lives on the institution_applications row that was
	// matched to this org at KYC approval. Falls back to the admin
	// user's email if the app row can't be located (renamed org, etc.).
	if err := s.deps.DB.QueryRowContext(ctx,
		`SELECT o.name, e.name, e.exam_code, c.name,
		        COALESCE(app.head_email,
		                 (SELECT u.email FROM users u
		                    WHERE u.org_id = o.id AND u.role = 'admin'
		                      AND COALESCE(u.email,'') <> '' AND u.disabled_at IS NULL
		                    ORDER BY u.id LIMIT 1))
		   FROM organizations o
		   JOIN exams e ON e.id = $2
		   JOIN clients c ON c.id = e.client_id
		   LEFT JOIN institution_applications app
		     ON LOWER(TRIM(app.institution_name)) = LOWER(TRIM(o.name))
		    AND app.status = 'approved'
		  WHERE o.id = $1`,
		orgID, examID,
	).Scan(&orgName, &examName, &examCode, &clientName, &headEmail); err != nil {
		log.Printf("subscription email: metadata lookup failed org=%d exam=%d: %v", orgID, examID, err)
		return
	}
	to := strings.TrimSpace(headEmail.String)
	if to == "" {
		log.Printf("subscription email: no head/admin email for org=%d — decision on exam %s not notified", orgID, examCode)
		return
	}

	var subject, body string
	if approved {
		subject = fmt.Sprintf("[Verification Portal] Access approved: %s", examCode)
		body = buildSubscriptionApprovedEmail(orgName, examName, examCode, clientName)
	} else {
		subject = fmt.Sprintf("[Verification Portal] Access request rejected: %s", examCode)
		body = buildSubscriptionRejectedEmail(orgName, examName, examCode, clientName, reviewerNote)
	}
	if err := s.emailer.Send(ctx, email.Message{
		To:      to,
		Subject: subject,
		Body:    body,
	}); err != nil {
		log.Printf("subscription email: send to institute %s failed: %v", to, err)
	}
}

// ─── Body templates ──────────────────────────────────────────────────
//
// Plain-text, deliberately short. The portal is the source of truth;
// email is just a nudge to open it. Match the tone of buildKYCApprovedEmail.

func buildSubscriptionRequestEmail(orgName, examName, examCode, clientName string) string {
	return fmt.Sprintf(`Hi,

An institute has requested access to one of your exams:

  Institute : %s
  Exam      : %s (%s)
  Client    : %s

Sign in to the Verification Portal reviewer console to review this request:

  Open the institute page → the request is listed under "Exam subscription requests."
  Approve to grant access, or reject with a note if the institute should not run this exam.

— Verification Portal
`, orgName, examName, examCode, clientName)
}

func buildSubscriptionApprovedEmail(orgName, examName, examCode, clientName string) string {
	return fmt.Sprintf(`Hi %s team,

Your request for access to the following exam has been APPROVED:

  Exam    : %s (%s)
  Client  : %s

You can now assign operators to this exam and start running verifications.
Sign in to the admin portal → Catalog to see it listed as Subscribed.

— Verification Portal
`, orgName, examName, examCode, clientName)
}

func buildSubscriptionRejectedEmail(orgName, examName, examCode, clientName, note string) string {
	noteLine := ""
	if strings.TrimSpace(note) != "" {
		noteLine = fmt.Sprintf("\nReviewer note:\n  %s\n", strings.TrimSpace(note))
	}
	return fmt.Sprintf(`Hi %s team,

Your request for access to the following exam has been REJECTED:

  Exam    : %s (%s)
  Client  : %s
%s
You may request access again from the admin portal → Catalog if the
reason has been addressed.

— Verification Portal
`, orgName, examName, examCode, clientName, noteLine)
}
