// Support handler — the in-portal "Report a problem" form used by
// admins, reviewers and agents.
//
// Why a server-side send rather than a mailto: link: exam-centre
// machines are frequently locked down with no mail client configured,
// so a mailto: would open nothing and the report would be lost with no
// signal to the user. Posting through the API also lets us attach who
// sent it, from which role and org, and from which page — the three
// things a support reply always needs and the three things a person
// describing a problem never thinks to include.
//
// The caller supplies only free text and the page they were on. Every
// identifying field is taken from the JWT, never from the body, so a
// report cannot be forged to look like it came from another user.

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/veni/neet-verification/internal/db"
	"github.com/veni/neet-verification/internal/email"
)

const (
	supportMaxMessageBytes = 4000
	supportMinMessageChars = 10
	// A person reporting a genuine fault sends one, maybe two. Five per
	// hour per IP leaves room for a follow-up and a couple of retries
	// after a network failure, while keeping the mailbox from being
	// usable as a relay if a token ever leaks.
	supportRateMax    = 5
	supportRateWindow = time.Hour
)

var globalSupportLimiter = newRegisterLimiter(supportRateMax, supportRateWindow)

type supportReportReq struct {
	Message string `json:"message"`
	// Page is the in-app path the user was on. Advisory only — it is
	// echoed into the mail body, never trusted or acted on.
	Page string `json:"page"`
}

// POST /api/support/report
//
// Deliberately mounted with requireRoleOpen: an admin whose KYC is
// pending or rejected is exactly the person most likely to need to ask
// a question, and the ordinary KYC gate would refuse them.
func (s *Server) supportReport(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "Sign in first.")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, supportMaxMessageBytes+2048)
	var req supportReportReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "Could not read that message.")
		return
	}

	msg := strings.TrimSpace(req.Message)
	if len([]rune(msg)) < supportMinMessageChars {
		writeErr(w, http.StatusBadRequest,
			"Please describe the problem in a little more detail.")
		return
	}
	if len(msg) > supportMaxMessageBytes {
		msg = msg[:supportMaxMessageBytes] + "\n\n[truncated]"
	}

	to := strings.TrimSpace(s.deps.Cfg.SupportEmail)
	if to == "" {
		// Nothing to send to. Say so plainly rather than reporting a
		// success the user would wait on.
		log.Printf("support: SUPPORT_EMAIL is empty, dropping report from %s", claims.Username)
		writeErr(w, http.StatusServiceUnavailable,
			"Problem reporting isn't set up yet. Please contact your administrator.")
		return
	}

	org := "—"
	if claims.OrgID != nil {
		org = fmt.Sprintf("%d", *claims.OrgID)
		if name, err := s.orgName(r.Context(), *claims.OrgID); err == nil && name != "" {
			org = fmt.Sprintf("%s (id %d)", name, *claims.OrgID)
		}
	}
	client := "—"
	if claims.ClientID != nil {
		client = fmt.Sprintf("%d", *claims.ClientID)
	}

	page := strings.TrimSpace(req.Page)
	if page == "" {
		page = "—"
	}
	if len(page) > 200 {
		page = page[:200]
	}

	ist := time.FixedZone("IST", 5*3600+1800)
	body := strings.Join([]string{
		msg,
		"",
		strings.Repeat("─", 46),
		"Sent from the Verification Portal",
		"",
		"Role:          " + roleLabel(claims.Role),
		"User:          " + claims.Username,
		"Organisation:  " + org,
		"Client:        " + client,
		"Page:          " + page,
		"Time:          " + time.Now().In(ist).Format("2 Jan 2006, 15:04 IST"),
		"Browser:       " + clipStr(r.UserAgent(), 160),
	}, "\n")

	// Rate limit here rather than at the top of the handler: a message
	// rejected for being too short never sends mail, so it must not cost
	// the user one of their five. Otherwise someone who mistypes twice
	// then hits a real fault has already spent their quota.
	if !globalSupportLimiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests,
			"You've sent several reports already. Please wait a little before sending another.")
		return
	}

	subject := fmt.Sprintf("[Portal] %s reported a problem", roleLabel(claims.Role))

	// Synchronous, unlike the fire-and-forget welcome mails: the user is
	// watching a spinner and needs to be told whether it actually went.
	// A silent failure here means someone sits waiting for a reply that
	// will never come.
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if err := s.emailer.Send(ctx, email.Message{To: to, Subject: subject, Body: body}); err != nil {
		// Log the whole report so it is recoverable from the server log
		// even though the mail did not leave.
		log.Printf("support: send failed for %s: %v\nreport was:\n%s", claims.Username, err, body)
		writeErr(w, http.StatusBadGateway,
			"We couldn't send that just now. Please try again in a moment.")
		return
	}

	s.auditFromRequest(r, "support.report", "", 0, map[string]any{
		"role": claims.Role, "page": page, "bytes": len(msg),
	})
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "to": to})
}

// roleLabel turns an internal role name into what the reader calls it.
// 'client' is the operator/agent role — a support inbox reading
// "client reported a problem" would be actively misleading, since a
// client in this product is an exam board.
func roleLabel(role string) string {
	switch role {
	case "admin":
		return "Institution admin"
	case "client":
		return "Verification agent"
	case "client_reviewer":
		return "Reviewer"
	case "superadmin":
		return "Superadmin"
	default:
		return role
	}
}

func clipStr(s string, n int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "—"
	}
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func (s *Server) orgName(ctx context.Context, orgID int64) (string, error) {
	var name string
	err := s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT name FROM organizations WHERE id = ?`), orgID).Scan(&name)
	return name, err
}
