// Package email is a thin sender interface so the rest of the codebase
// can call email.Send(...) without caring about the transport. Today the
// only implementation logs to the backend console (perfect for dev). To
// add real SMTP / SES / SendGrid later, write a new implementation of
// Sender and wire it up in cmd/server/main.go.
//
// Magic-link emails contain a one-time URL the recipient clicks to set
// their password. The URL is printed plainly in the console so a
// developer can copy-paste it. In production, log levels should suppress
// the link from console output and the real Sender should handle delivery.
package email

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

// Message is the minimal envelope a Sender accepts. Body is plain text
// today; HTML can be layered later via a multipart wrapper.
type Message struct {
	To      string
	Subject string
	Body    string
}

// Sender is the swap point. A real implementation talks to SMTP / a
// transactional API; the console implementation just logs.
type Sender interface {
	Send(ctx context.Context, msg Message) error
}

// ConsoleSender writes every message to the standard logger in a clearly
// delimited block so it's easy to spot in mixed-output dev logs.
//
// Concurrency-safe: log.Printf is internally locked, so concurrent Sends
// don't interleave.
type ConsoleSender struct{}

func NewConsoleSender() *ConsoleSender { return &ConsoleSender{} }

func (c *ConsoleSender) Send(_ context.Context, msg Message) error {
	if msg.To == "" {
		return fmt.Errorf("email: missing To")
	}
	if msg.Subject == "" {
		return fmt.Errorf("email: missing Subject")
	}
	var b strings.Builder
	b.WriteString("\n")
	b.WriteString("=====================================================================\n")
	b.WriteString(fmt.Sprintf("📧 EMAIL  (dev-mode console sender)  %s\n", time.Now().Format(time.RFC3339)))
	b.WriteString("---------------------------------------------------------------------\n")
	b.WriteString(fmt.Sprintf("To:      %s\n", msg.To))
	b.WriteString(fmt.Sprintf("Subject: %s\n", msg.Subject))
	b.WriteString("---------------------------------------------------------------------\n")
	b.WriteString(msg.Body)
	if !strings.HasSuffix(msg.Body, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("=====================================================================\n")
	log.Print(b.String())
	return nil
}
