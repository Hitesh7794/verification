// SMTPSender — sends mail via any STARTTLS SMTP relay using only the
// Go stdlib. Works identically for Gmail (smtp.gmail.com:587), Office
// 365, AWS SES SMTP, Zoho, Resend SMTP, etc. — only the host:port and
// auth credentials change.
//
// The send is synchronous but bounded by sendTimeout (15s) so a hung
// SMTP server can't pin the HTTP request thread forever. Callers
// (currently the approve/reject handlers) treat Send errors as
// non-fatal: the approval still succeeds, the magic link is still in
// the JSON response, the operator can copy it manually from the
// backend log if the email never lands.

package email

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

const sendTimeout = 15 * time.Second

type SMTPSender struct {
	host     string // e.g. smtp.gmail.com
	port     string // e.g. 587
	username string // SMTP AUTH user
	password string // SMTP AUTH password (Gmail App Password / SES SMTP secret / ...)
	from     string // RFC 5322 From header — "Name <you@x.com>" or bare "you@x.com"
}

func NewSMTPSender(host, port, username, password, from string) *SMTPSender {
	if port == "" {
		port = "587"
	}
	if from == "" {
		from = username
	}
	return &SMTPSender{
		host: host, port: port,
		username: username, password: password,
		from: from,
	}
}

func (s *SMTPSender) Send(ctx context.Context, msg Message) error {
	if msg.To == "" {
		return fmt.Errorf("smtp: missing To")
	}
	if msg.Subject == "" {
		return fmt.Errorf("smtp: missing Subject")
	}
	addr := net.JoinHostPort(s.host, s.port)

	// Honour either the caller's deadline or our internal 15s cap,
	// whichever fires first.
	deadline := time.Now().Add(sendTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	dialer := &net.Dialer{Deadline: deadline}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)

	client, err := smtp.NewClient(conn, s.host)
	if err != nil {
		return fmt.Errorf("smtp client: %w", err)
	}
	defer client.Quit()

	// STARTTLS — every modern public SMTP relay requires it on port
	// 587. If the server doesn't advertise STARTTLS we bail rather
	// than send credentials over plaintext.
	if ok, _ := client.Extension("STARTTLS"); !ok {
		return fmt.Errorf("smtp: server doesn't advertise STARTTLS")
	}
	if err := client.StartTLS(&tls.Config{ServerName: s.host}); err != nil {
		return fmt.Errorf("smtp starttls: %w", err)
	}

	auth := smtp.PlainAuth("", s.username, s.password, s.host)
	if err := client.Auth(auth); err != nil {
		return fmt.Errorf("smtp auth: %w", err)
	}

	// Envelope: bare address (no display name) on MAIL FROM/RCPT TO.
	fromAddr := extractAddr(s.from)
	if fromAddr == "" {
		fromAddr = s.username
	}
	if err := client.Mail(fromAddr); err != nil {
		return fmt.Errorf("smtp mail-from: %w", err)
	}
	if err := client.Rcpt(msg.To); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}

	// Build a minimal RFC 5322 message — headers, blank line, body.
	// Date header is required by Gmail or it'll mark as spam.
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", s.from)
	fmt.Fprintf(&b, "To: %s\r\n", msg.To)
	fmt.Fprintf(&b, "Subject: %s\r\n", msg.Subject)
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=\"utf-8\"\r\n")
	b.WriteString("Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("\r\n")
	b.WriteString(msg.Body)

	if _, err := w.Write([]byte(b.String())); err != nil {
		return fmt.Errorf("smtp write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp finalize: %w", err)
	}
	return nil
}

// extractAddr pulls "you@x.com" out of "Name <you@x.com>", or returns
// the input unchanged if no brackets are present.
func extractAddr(from string) string {
	if i := strings.Index(from, "<"); i >= 0 {
		if j := strings.Index(from[i:], ">"); j > 0 {
			return from[i+1 : i+j]
		}
	}
	return from
}
