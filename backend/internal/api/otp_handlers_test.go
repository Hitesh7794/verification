package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/email"
	"github.com/veni/neet-verification/internal/otp"
	"github.com/veni/neet-verification/internal/sms"
)

func TestOTPHandlersFlow(t *testing.T) {
	cfg := config.Config{
		JWTSecret: "test-jwt-secret-for-otp",
	}
	s := &Server{
		deps:       Deps{Cfg: cfg},
		emailer:    email.NewConsoleSender(),
		smsSender:  sms.NewConsoleSender(),
		otpStore:   otp.NewStore(cfg.JWTSecret),
	}

	handler := s.Router()

	// 1. Send Email OTP
	sendEmailBody, _ := json.Marshal(map[string]string{
		"email":   "testuser@example.com",
		"purpose": "registration",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/otp/send-email", bytes.NewReader(sendEmailBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("send-email failed with status %d: %s", rec.Code, rec.Body.String())
	}

	// 2. Generate a known OTP or get it from store to verify
	// We can inspect the store directly or generate one
	code, err := s.otpStore.Generate("registration", "direct@example.com")
	if err != nil {
		t.Fatalf("failed to generate OTP: %v", err)
	}

	// 3. Verify Email OTP
	verifyEmailBody, _ := json.Marshal(map[string]string{
		"email":   "direct@example.com",
		"code":    code,
		"purpose": "registration",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/otp/verify-email", bytes.NewReader(verifyEmailBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("verify-email failed with status %d: %s", rec.Code, rec.Body.String())
	}

	var resp otpVerifyResp
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode verify response: %v", err)
	}
	if !resp.Verified || resp.Token == "" {
		t.Fatalf("expected verified=true and non-empty token, got %+v", resp)
	}

	// 4. Send SMS OTP
	sendSmsBody, _ := json.Marshal(map[string]string{
		"mobile":  "9876543210",
		"purpose": "registration",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/otp/send-sms", bytes.NewReader(sendSmsBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("send-sms failed with status %d: %s", rec.Code, rec.Body.String())
	}

	// 5. Verify SMS OTP with invalid code
	verifySmsBody, _ := json.Marshal(map[string]string{
		"mobile":  "9876543210",
		"code":    "000000",
		"purpose": "registration",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/otp/verify-sms", bytes.NewReader(verifySmsBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on wrong SMS OTP, got %d: %s", rec.Code, rec.Body.String())
	}

	// 6. Send SMS OTP with invalid non-Indian mobile numbers (e.g. starting with 1, 2, or less than 10 digits)
	invalidMobiles := []string{"1234567890", "5555555555", "98765", "abcdefghij"}
	for _, inv := range invalidMobiles {
		invBody, _ := json.Marshal(map[string]string{
			"mobile":  inv,
			"purpose": "registration",
		})
		req = httptest.NewRequest(http.MethodPost, "/api/otp/send-sms", bytes.NewReader(invBody))
		req.Header.Set("Content-Type", "application/json")
		rec = httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 on invalid mobile %q, got %d: %s", inv, rec.Code, rec.Body.String())
		}
	}
}
