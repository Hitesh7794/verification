package otp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultTTL         = 10 * time.Minute
	defaultCooldown    = 30 * time.Second
	defaultMaxAttempts = 5
	tokenValidity      = 30 * time.Minute
)

type otpEntry struct {
	target      string
	purpose     string
	code        string
	attempts    int
	createdAt   time.Time
	expiresAt   time.Time
	lastSentAt  time.Time
}

// Store manages in-memory OTPs and HMAC verification proof tokens.
type Store struct {
	mu         sync.Mutex
	entries    map[string]*otpEntry // key: "purpose:target"
	hmacSecret []byte
	ttl        time.Duration
	cooldown   time.Duration
	maxTries   int
}

// NewStore initializes an OTP store with an HMAC signing secret.
func NewStore(hmacSecret string) *Store {
	if hmacSecret == "" {
		hmacSecret = "default-otp-secret-key"
	}
	s := &Store{
		entries:    make(map[string]*otpEntry),
		hmacSecret: []byte(hmacSecret),
		ttl:        defaultTTL,
		cooldown:   defaultCooldown,
		maxTries:   defaultMaxAttempts,
	}
	// Background cleanup of expired entries
	go s.cleanupLoop()
	return s
}

func (s *Store) key(purpose, target string) string {
	return strings.ToLower(strings.TrimSpace(purpose)) + ":" + strings.ToLower(strings.TrimSpace(target))
}

// Generate creates a new 6-digit numeric OTP code for the given target and purpose.
func (s *Store) Generate(purpose, target string) (string, error) {
	purpose = strings.TrimSpace(purpose)
	target = strings.TrimSpace(target)
	if target == "" {
		return "", errors.New("otp: target cannot be empty")
	}
	if purpose == "" {
		return "", errors.New("otp: purpose cannot be empty")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	k := s.key(purpose, target)
	now := time.Now()

	if entry, exists := s.entries[k]; exists {
		if now.Before(entry.lastSentAt.Add(s.cooldown)) {
			remainingSec := int(entry.lastSentAt.Add(s.cooldown).Sub(now).Seconds())
			if remainingSec < 1 {
				remainingSec = 1
			}
			return "", fmt.Errorf("please wait %d seconds before requesting another code", remainingSec)
		}
	}

	// Generate secure 6-digit random code (100000 - 999999)
	nBig, err := rand.Int(rand.Reader, big.NewInt(900000))
	if err != nil {
		return "", fmt.Errorf("otp crypto rand: %w", err)
	}
	code := strconv.FormatInt(nBig.Int64()+100000, 10)

	s.entries[k] = &otpEntry{
		target:     target,
		purpose:    purpose,
		code:       code,
		attempts:   0,
		createdAt:  now,
		expiresAt:  now.Add(s.ttl),
		lastSentAt: now,
	}

	return code, nil
}

// Verify validates the OTP code and returns a signed verification proof token on success.
func (s *Store) Verify(purpose, target, code string) (string, error) {
	purpose = strings.TrimSpace(purpose)
	target = strings.TrimSpace(target)
	code = strings.TrimSpace(code)

	if target == "" || code == "" {
		return "", errors.New("target and code are required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	k := s.key(purpose, target)
	entry, exists := s.entries[k]
	if !exists {
		return "", errors.New("no OTP requested or code expired. Please request a new code")
	}

	if time.Now().After(entry.expiresAt) {
		delete(s.entries, k)
		return "", errors.New("OTP has expired. Please request a new code")
	}

	entry.attempts++
	if entry.attempts > s.maxTries {
		delete(s.entries, k)
		return "", errors.New("maximum verification attempts exceeded. Please request a new code")
	}

	if entry.code != code {
		remaining := s.maxTries - entry.attempts
		if remaining > 0 {
			return "", fmt.Errorf("invalid OTP code. %d attempts remaining", remaining)
		}
		delete(s.entries, k)
		return "", errors.New("invalid OTP code. Please request a new code")
	}

	// Code matched! Delete consumed OTP
	delete(s.entries, k)

	// Issue signed proof token
	token := s.SignProofToken(purpose, target)
	return token, nil
}

// SignProofToken creates an HMAC-SHA256 signed verification proof token valid for tokenValidity (30 mins).
func (s *Store) SignProofToken(purpose, target string) string {
	issuedAt := time.Now().Unix()
	expiresAt := time.Now().Add(tokenValidity).Unix()
	payload := fmt.Sprintf("%s|%s|%d|%d",
		strings.ToLower(strings.TrimSpace(purpose)),
		strings.ToLower(strings.TrimSpace(target)),
		issuedAt,
		expiresAt,
	)

	h := hmac.New(sha256.New, s.hmacSecret)
	h.Write([]byte(payload))
	sig := h.Sum(nil)

	payloadB64 := base64.RawURLEncoding.EncodeToString([]byte(payload))
	sigB64 := base64.RawURLEncoding.EncodeToString(sig)
	return payloadB64 + "." + sigB64
}

// ValidateProofToken validates that a verification proof token is genuine, matches target and purpose, and has not expired.
func (s *Store) ValidateProofToken(purpose, target, token string) error {
	purpose = strings.ToLower(strings.TrimSpace(purpose))
	target = strings.ToLower(strings.TrimSpace(target))
	token = strings.TrimSpace(token)

	if token == "" {
		return errors.New("missing verification token")
	}

	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return errors.New("malformed verification token")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return errors.New("invalid token payload encoding")
	}
	expectedSig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return errors.New("invalid token signature encoding")
	}

	// Verify HMAC signature
	h := hmac.New(sha256.New, s.hmacSecret)
	h.Write(payloadBytes)
	actualSig := h.Sum(nil)

	if !hmac.Equal(expectedSig, actualSig) {
		return errors.New("verification token signature mismatch")
	}

	// Parse payload fields: purpose|target|issuedAt|expiresAt
	fields := strings.Split(string(payloadBytes), "|")
	if len(fields) != 4 {
		return errors.New("invalid token payload format")
	}

	tokenPurpose := fields[0]
	tokenTarget := fields[1]
	expStr := fields[3]

	if tokenPurpose != purpose {
		return fmt.Errorf("token purpose mismatch: expected %s, got %s", purpose, tokenPurpose)
	}
	if tokenTarget != target {
		return fmt.Errorf("token target mismatch: expected %s, got %s", target, tokenTarget)
	}

	expUnix, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return errors.New("invalid expiration in token")
	}
	if time.Now().Unix() > expUnix {
		return errors.New("verification token has expired. Please verify again")
	}

	return nil
}

func (s *Store) cleanupLoop() {
	ticker := time.NewTicker(2 * time.Minute)
	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for k, entry := range s.entries {
			if now.After(entry.expiresAt) {
				delete(s.entries, k)
			}
		}
		s.mu.Unlock()
	}
}
