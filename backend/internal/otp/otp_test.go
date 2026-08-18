package otp

import (
	"testing"
)

func TestOTPGenerateAndVerify(t *testing.T) {
	store := NewStore("test-secret-key-12345")
	email := "registrar@testuniv.ac.in"
	purpose := "registration"

	code, err := store.Generate(purpose, email)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	if len(code) != 6 {
		t.Fatalf("expected 6-digit code, got %s", code)
	}

	// Immediate re-request should fail cooldown
	_, err = store.Generate(purpose, email)
	if err == nil {
		t.Fatal("expected error on immediate re-generation due to cooldown, got nil")
	}

	// Verify with incorrect code
	_, err = store.Verify(purpose, email, "000000")
	if err == nil {
		t.Fatal("expected error on wrong code, got nil")
	}

	// Verify with correct code
	token, err := store.Verify(purpose, email, code)
	if err != nil {
		t.Fatalf("Verify failed with valid code: %v", err)
	}
	if token == "" {
		t.Fatal("expected non-empty token")
	}

	// Token validation
	if err := store.ValidateProofToken(purpose, email, token); err != nil {
		t.Fatalf("ValidateProofToken failed: %v", err)
	}

	// Token validation with different target should fail
	if err := store.ValidateProofToken(purpose, "other@test.com", token); err == nil {
		t.Fatal("expected error when validating token for different target")
	}

	// Token validation with different purpose should fail
	if err := store.ValidateProofToken("login", email, token); err == nil {
		t.Fatal("expected error when validating token for different purpose")
	}
}

func TestOTPExpiredOrMaxTries(t *testing.T) {
	store := NewStore("test-secret-key")
	store.maxTries = 2
	mobile := "9876543210"
	purpose := "registration"

	code, err := store.Generate(purpose, mobile)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	// Try 1 (fail)
	_, _ = store.Verify(purpose, mobile, "111111")
	// Try 2 (fail)
	_, _ = store.Verify(purpose, mobile, "222222")
	// Try 3 (should be locked out)
	_, err = store.Verify(purpose, mobile, code)
	if err == nil {
		t.Fatal("expected lockout after max tries")
	}
}
