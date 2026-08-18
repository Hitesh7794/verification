package sms

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// AuthKeyConfig holds credentials and settings for AuthKey.io SMS service.
type AuthKeyConfig struct {
	BaseURL     string        // Default: https://api.authkey.io/request
	AuthKey     string        // AuthKey API key
	SID         string        // Sender / Template ID, e.g. 44529
	Company     string        // Company name, e.g. seQRview
	CountryCode string        // Default: 91
	Timeout     time.Duration // Default: 10s
}

// AuthKeySender implements Sender by making HTTP GET requests to AuthKey.io.
type AuthKeySender struct {
	cfg    AuthKeyConfig
	client *http.Client
}

// NewAuthKeySender creates a new AuthKeySender with provided configuration.
func NewAuthKeySender(cfg AuthKeyConfig) *AuthKeySender {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.authkey.io/request"
	}
	if cfg.CountryCode == "" {
		cfg.CountryCode = "91"
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}
	return &AuthKeySender{
		cfg: cfg,
		client: &http.Client{
			Timeout: cfg.Timeout,
		},
	}
}

// Send dispatches an OTP SMS to the target mobile number.
func (s *AuthKeySender) Send(ctx context.Context, mobile, otp string) error {
	mobile = strings.TrimSpace(mobile)
	// Strip country code if included
	if strings.HasPrefix(mobile, "+91") {
		mobile = strings.TrimPrefix(mobile, "+91")
	} else if strings.HasPrefix(mobile, "91") && len(mobile) == 12 {
		mobile = mobile[2:]
	}
	mobile = strings.TrimSpace(mobile)

	if mobile == "" {
		return fmt.Errorf("authkey: mobile is required")
	}
	if otp == "" {
		return fmt.Errorf("authkey: OTP is required")
	}
	if s.cfg.AuthKey == "" {
		return fmt.Errorf("authkey: missing AuthKey API key")
	}

	q := url.Values{}
	q.Set("authkey", s.cfg.AuthKey)
	q.Set("mobile", mobile)
	q.Set("country_code", s.cfg.CountryCode)
	q.Set("company", s.cfg.Company)
	q.Set("sid", s.cfg.SID)
	q.Set("var", otp)

	reqURL := fmt.Sprintf("%s?%s", strings.TrimRight(s.cfg.BaseURL, "?"), q.Encode())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return fmt.Errorf("authkey create request: %w", err)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("authkey request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	bodyStr := string(respBody)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("authkey error: status=%d body=%s", resp.StatusCode, bodyStr)
		return fmt.Errorf("authkey returned HTTP %d: %s", resp.StatusCode, bodyStr)
	}

	log.Printf("authkey SMS OTP dispatched to %s (status %d): %s", mobile, resp.StatusCode, bodyStr)
	return nil
}
