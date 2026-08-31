package sms

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

// Sender is the interface for sending SMS OTP messages.
type Sender interface {
	Send(ctx context.Context, mobile, otp string) error
}

// ConsoleSender prints SMS messages to the logger (useful for local dev and testing).
type ConsoleSender struct{}

func NewConsoleSender() *ConsoleSender {
	return &ConsoleSender{}
}

func (c *ConsoleSender) Send(_ context.Context, mobile, otp string) error {
	if mobile == "" {
		return fmt.Errorf("sms: missing mobile number")
	}
	if otp == "" {
		return fmt.Errorf("sms: missing OTP code")
	}

	var b strings.Builder
	b.WriteString("\n")
	b.WriteString("=====================================================================\n")
	b.WriteString(fmt.Sprintf("📱 SMS OTP (dev-mode console sender)  %s\n", time.Now().Format(time.RFC3339)))
	b.WriteString("---------------------------------------------------------------------\n")
	b.WriteString(fmt.Sprintf("Mobile:  +91 %s\n", mobile))
	b.WriteString(fmt.Sprintf("OTP:     %s\n", otp))
	b.WriteString("---------------------------------------------------------------------\n")
	b.WriteString(fmt.Sprintf("Your verification code is %s. Valid for 5 minutes.\n", otp))
	b.WriteString("=====================================================================\n")
	log.Print(b.String())
	return nil
}
