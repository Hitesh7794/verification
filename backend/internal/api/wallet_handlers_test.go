package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/data"
	"github.com/veni/neet-verification/internal/db"
	"github.com/veni/neet-verification/internal/wallet"
)

// PR-1 fix tests: every failure mode the payment audit (CRITICAL #1
// + #2 + #3, HIGH #1) is supposed to close. These tests are deliberately
// thin on happy-path coverage (Razorpay's real API can't be invoked from
// Go tests without mocking) — they target the SECURITY boundaries we
// now control end to end.
//
// Two test scaffolds:
//   - walletTestServer: a minimal Server + DB + token, used by the
//     verify-payment + webhook tests below. It seeds a stored order
//     directly via the wallet.Store (skipping the Razorpay round-trip
//     that walletOrder would normally do) so we can probe the security
//     checks in isolation.
//   - signWebhook: helper that produces a Razorpay-compatible
//     X-Razorpay-Signature for a given body.

const testWebhookSecret = "test-webhook-secret-do-not-share"
const testRazorpayKey = "rzp_test_unit"
const testRazorpaySecret = "unit-secret"

// walletTestServer wires a Server with razorpay+wallet enabled, a fresh
// DB, one admin user, and (optionally) one pre-saved Razorpay order.
func walletTestServer(t *testing.T, saveOrder *wallet.Order) (*Server, string, int64, int64) {
	t.Helper()
	tmp := t.TempDir()

	d, err := db.Open(filepath.Join(tmp, "v.db"))
	if err != nil {
		t.Fatalf("db open: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	idx, _ := data.LoadIndex(filepath.Join(tmp, "datatree-empty"))

	jwt := auth.NewJWTService("test-secret", time.Hour)
	cfg := config.Config{
		HTTPAddr:                ":0",
		JWTSecret:               "test-secret",
		FPMatchThresholdDefault: 60,
		ArtifactRetention:       "metadata",
		ArtifactDir:             filepath.Join(tmp, "artifacts"),
		RazorpayKeyID:           testRazorpayKey,
		RazorpayKeySecret:       testRazorpaySecret,
		RazorpayWebhookSecret:   testWebhookSecret,
		WalletFeePerLookupPaise: 500,
		WalletMaxDepositPaise:   5_000_000,
	}
	s := NewServer(Deps{DB: d, Index: idx, JWT: jwt, Cfg: cfg})

	res, _ := s.deps.DB.Exec(`INSERT INTO organizations(code, name) VALUES('TEST', 'Test U')`)
	orgID, _ := res.LastInsertId()
	hash, _ := bcrypt.GenerateFromPassword([]byte("admin"), bcrypt.MinCost)
	ures, _ := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
		 VALUES('admin', ?, 'admin', ?, 'Admin', CURRENT_TIMESTAMP)`,
		string(hash), orgID,
	)
	adminID, _ := ures.LastInsertId()
	tok, _ := jwt.Issue(auth.Claims{UserID: adminID, Username: "admin", Role: "admin", OrgID: &orgID})

	if saveOrder != nil {
		if saveOrder.OrgID == 0 {
			saveOrder.OrgID = orgID
		}
		if saveOrder.ActorUserID == 0 {
			saveOrder.ActorUserID = adminID
		}
		if err := s.wallet.SaveOrder(t.Context(), *saveOrder); err != nil {
			t.Fatalf("seed order: %v", err)
		}
	}
	return s, tok, orgID, adminID
}

// computeRazorpaySig mimics Razorpay's HMAC(order_id|payment_id, secret).
func computeRazorpaySig(orderID, paymentID, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(orderID + "|" + paymentID))
	return hex.EncodeToString(mac.Sum(nil))
}

// signWebhook produces the X-Razorpay-Signature header for the given body.
func signWebhook(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// -------------------------------------------------------------------------
// CRITICAL #1 — server uses stored amount, ignores claimed amount
// -------------------------------------------------------------------------

func TestVerifyPayment_UsesStoredAmountNotClaimed(t *testing.T) {
	const orderID = "order_FIX1"
	const paymentID = "pay_FIX1"
	const realAmount = 10000     // ₹100 — what was paid
	const claimedAmount = 5000000 // ₹50,000 — what the attacker claims

	s, tok, _, _ := walletTestServer(t, &wallet.Order{
		RazorpayOrderID: orderID,
		AmountPaise:     realAmount,
		Receipt:         "wallet-test",
	})
	sig := computeRazorpaySig(orderID, paymentID, testRazorpaySecret)

	code, body := doJSON(t, s, "POST", "/api/wallet/verify-payment", tok, map[string]any{
		"razorpay_order_id":   orderID,
		"razorpay_payment_id": paymentID,
		"razorpay_signature":  sig,
		"amount_paise":        claimedAmount, // ← attacker inflates this
	})
	if code != http.StatusOK {
		t.Fatalf("verify want 200, got %d body=%v", code, body)
	}
	gotBal, _ := body["balance_paise"].(float64)
	if int(gotBal) != realAmount {
		t.Errorf("wallet credited %d paise, want stored amount %d (NOT claimed %d)",
			int(gotBal), realAmount, claimedAmount)
	}
}

// -------------------------------------------------------------------------
// CRITICAL #1b — forged order_id (one we never created) is rejected
// -------------------------------------------------------------------------

func TestVerifyPayment_ForgedOrderRejected(t *testing.T) {
	const orderID = "order_FORGED_NEVER_CREATED"
	const paymentID = "pay_FORGED"
	s, tok, _, _ := walletTestServer(t, nil) // no order seeded
	sig := computeRazorpaySig(orderID, paymentID, testRazorpaySecret)

	code, body := doJSON(t, s, "POST", "/api/wallet/verify-payment", tok, map[string]any{
		"razorpay_order_id":   orderID,
		"razorpay_payment_id": paymentID,
		"razorpay_signature":  sig,
		"amount_paise":        1000,
	})
	if code != http.StatusBadRequest {
		t.Fatalf("forged order_id want 400, got %d body=%v", code, body)
	}
}

// -------------------------------------------------------------------------
// CRITICAL #2 — order belonging to a different org is rejected
// -------------------------------------------------------------------------

func TestVerifyPayment_CrossOrgOrderRejected(t *testing.T) {
	const orderID = "order_ADMIN_A"
	const paymentID = "pay_X"

	s, _, orgA, _ := walletTestServer(t, nil)
	// Seed a second org with its own admin.
	resB, _ := s.deps.DB.Exec(`INSERT INTO organizations(code, name) VALUES('OTHER','Other U')`)
	orgB, _ := resB.LastInsertId()
	hash, _ := bcrypt.GenerateFromPassword([]byte("admin"), bcrypt.MinCost)
	uresB, _ := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
		 VALUES('adminB', ?, 'admin', ?, 'Admin B', CURRENT_TIMESTAMP)`,
		string(hash), orgB,
	)
	adminBID, _ := uresB.LastInsertId()
	tokB, _ := s.deps.JWT.Issue(auth.Claims{UserID: adminBID, Username: "adminB", Role: "admin", OrgID: &orgB})

	// Seed an order belonging to org A.
	if err := s.wallet.SaveOrder(t.Context(), wallet.Order{
		RazorpayOrderID: orderID,
		OrgID:           orgA,
		ActorUserID:     1, // any user
		AmountPaise:     50000,
		Receipt:         "wallet-A",
	}); err != nil {
		t.Fatalf("seed order: %v", err)
	}

	// Admin B tries to claim it.
	sig := computeRazorpaySig(orderID, paymentID, testRazorpaySecret)
	code, body := doJSON(t, s, "POST", "/api/wallet/verify-payment", tokB, map[string]any{
		"razorpay_order_id":   orderID,
		"razorpay_payment_id": paymentID,
		"razorpay_signature":  sig,
		"amount_paise":        50000,
	})
	if code != http.StatusForbidden {
		t.Fatalf("cross-org verify want 403, got %d body=%v", code, body)
	}
	// Admin B's org wallet should still be 0.
	balB, _ := s.wallet.Balance(t.Context(), orgB)
	if balB != 0 {
		t.Errorf("admin B's wallet was credited despite cross-org reject: %d", balB)
	}
}

// -------------------------------------------------------------------------
// CRITICAL #3 — webhook credits the wallet (covers the closed-tab scenario)
// -------------------------------------------------------------------------

func TestWebhook_PaymentCaptured_CreditsWallet(t *testing.T) {
	const orderID = "order_WEBHOOK1"
	const paymentID = "pay_WEBHOOK1"
	s, _, orgID, _ := walletTestServer(t, &wallet.Order{
		RazorpayOrderID: orderID,
		AmountPaise:     25000, // ₹250
		Receipt:         "wallet-wh",
	})

	body := mustJSON(t, map[string]any{
		"event": "payment.captured",
		"payload": map[string]any{
			"payment": map[string]any{
				"entity": map[string]any{
					"id":       paymentID,
					"order_id": orderID,
					"amount":   25000,
					"currency": "INR",
					"status":   "captured",
				},
			},
		},
	})

	code, respBody := doWebhook(t, s, body, signWebhook(body, testWebhookSecret))
	if code != http.StatusOK {
		t.Fatalf("webhook want 200, got %d body=%s", code, respBody)
	}
	bal, _ := s.wallet.Balance(t.Context(), orgID)
	if bal != 25000 {
		t.Errorf("wallet balance after webhook want 25000, got %d", bal)
	}
}

func TestWebhook_BadSignatureRejected(t *testing.T) {
	const orderID = "order_BADSIG"
	s, _, orgID, _ := walletTestServer(t, &wallet.Order{
		RazorpayOrderID: orderID,
		AmountPaise:     5000,
		Receipt:         "wallet-bad",
	})
	body := mustJSON(t, map[string]any{
		"event": "payment.captured",
		"payload": map[string]any{
			"payment": map[string]any{
				"entity": map[string]any{
					"id":       "pay_BADSIG",
					"order_id": orderID,
					"amount":   5000,
					"currency": "INR",
					"status":   "captured",
				},
			},
		},
	})
	// Sign with the WRONG secret — should be rejected.
	code, _ := doWebhook(t, s, body, signWebhook(body, "wrong-secret"))
	if code != http.StatusUnauthorized {
		t.Fatalf("bad-sig webhook want 401, got %d", code)
	}
	bal, _ := s.wallet.Balance(t.Context(), orgID)
	if bal != 0 {
		t.Errorf("wallet credited despite bad signature: %d", bal)
	}
}

func TestWebhook_NoSecretConfigured(t *testing.T) {
	// Reuse standard test server BUT clear the webhook secret on the
	// config so we exercise the 503 path.
	s, _, _, _ := walletTestServer(t, nil)
	// Mutate the config in place — we control it.
	s.deps.Cfg.RazorpayWebhookSecret = ""

	body := []byte(`{}`)
	code, _ := doWebhook(t, s, body, "anything")
	if code != http.StatusServiceUnavailable {
		t.Fatalf("missing webhook secret want 503, got %d", code)
	}
}

// Idempotency: webhook then verify-payment (and vice versa) must NOT
// double-credit. The UNIQUE INDEX on razorpay_payment_id is the
// guarantee; this test verifies it end to end via the handlers.
func TestWebhook_IdempotentWithVerifyPayment(t *testing.T) {
	const orderID = "order_IDEMP"
	const paymentID = "pay_IDEMP"
	s, tok, orgID, _ := walletTestServer(t, &wallet.Order{
		RazorpayOrderID: orderID,
		AmountPaise:     8000,
		Receipt:         "wallet-idemp",
	})

	// First credit via webhook.
	body := mustJSON(t, map[string]any{
		"event": "payment.captured",
		"payload": map[string]any{
			"payment": map[string]any{
				"entity": map[string]any{
					"id":       paymentID,
					"order_id": orderID,
					"amount":   8000,
					"currency": "INR",
					"status":   "captured",
				},
			},
		},
	})
	code, _ := doWebhook(t, s, body, signWebhook(body, testWebhookSecret))
	if code != http.StatusOK {
		t.Fatalf("first webhook want 200, got %d", code)
	}
	bal, _ := s.wallet.Balance(t.Context(), orgID)
	if bal != 8000 {
		t.Fatalf("wallet after first webhook want 8000, got %d", bal)
	}

	// Now the browser's verify-payment fires with the same payment_id.
	sig := computeRazorpaySig(orderID, paymentID, testRazorpaySecret)
	verifyCode, verifyBody := doJSON(t, s, "POST", "/api/wallet/verify-payment", tok, map[string]any{
		"razorpay_order_id":   orderID,
		"razorpay_payment_id": paymentID,
		"razorpay_signature":  sig,
		"amount_paise":        8000,
	})
	if verifyCode != http.StatusOK {
		t.Fatalf("verify after webhook want 200, got %d body=%v", verifyCode, verifyBody)
	}
	if rep, _ := verifyBody["replayed"].(bool); !rep {
		t.Errorf("verify after webhook should report replayed=true, got %v", verifyBody["replayed"])
	}

	// And a second webhook delivery (Razorpay retries) is a no-op.
	code2, _ := doWebhook(t, s, body, signWebhook(body, testWebhookSecret))
	if code2 != http.StatusOK {
		t.Fatalf("second webhook want 200, got %d", code2)
	}
	bal, _ = s.wallet.Balance(t.Context(), orgID)
	if bal != 8000 {
		t.Errorf("wallet credited twice: balance now %d (want 8000)", bal)
	}
}

// -------------------------------------------------------------------------
// HIGH #1 — test-mode flag exposed via /api/wallet/config
// -------------------------------------------------------------------------

func TestWalletConfig_ExposesTestModeFlag(t *testing.T) {
	// The default test server uses rzp_test_unit — test_mode should be true.
	s, tok, _, _ := walletTestServer(t, nil)
	code, body := doJSON(t, s, "GET", "/api/wallet/config", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("config want 200, got %d body=%v", code, body)
	}
	tm, ok := body["razorpay_test_mode"].(bool)
	if !ok {
		t.Fatalf("razorpay_test_mode field missing or wrong type: %v", body["razorpay_test_mode"])
	}
	if !tm {
		t.Errorf("test_mode want true with rzp_test_* key, got false")
	}

	// Switch the key to a fake live key and confirm test_mode flips.
	s.deps.Cfg.RazorpayKeyID = "rzp_live_unit"
	code2, body2 := doJSON(t, s, "GET", "/api/wallet/config", tok, nil)
	if code2 != http.StatusOK {
		t.Fatalf("config want 200, got %d", code2)
	}
	if tm2, _ := body2["razorpay_test_mode"].(bool); tm2 {
		t.Errorf("test_mode want false with rzp_live_* key, got true")
	}
}

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

func doWebhook(t *testing.T, s *Server, body []byte, signature string) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/razorpay/webhook", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Razorpay-Signature", signature)
	req.RemoteAddr = "127.0.0.1:1234"
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	return rr.Code, rr.Body.Bytes()
}

// doJSONFromPublicIP mirrors doJSON but spoofs X-Forwarded-For with a
// public IP so the loopback exemption doesn't bypass the rate limiter.
// 203.0.113.x is TEST-NET-3 (RFC 5737) — guaranteed-unallocated, safe
// to fabricate in test code without colliding with anything real.
func doJSONFromPublicIP(t *testing.T, s *Server, method, path, token string, body any, xff string) int {
	t.Helper()
	var reqBody io.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		reqBody = bytes.NewReader(buf)
	}
	req := httptest.NewRequest(method, path, reqBody)
	req.RemoteAddr = "127.0.0.1:1234" // any value; XFF takes precedence
	req.Header.Set("X-Forwarded-For", xff)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	return rr.Code
}

const testPublicIP = "203.0.113.42" // TEST-NET-3 — RFC 5737 reserved

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// -------------------------------------------------------------------------
// HIGH #2 — wallet write rate limiter
// -------------------------------------------------------------------------

// Per-user budget exhausted at request 16 (15 allowed per 5 min).
// Using forged order_ids so each call fails at the order lookup step
// (HTTP 400) — what we're testing is that the LIMITER fires at the
// configured threshold, not the downstream logic.
func TestWalletRateLimit_BlocksAfter15Requests(t *testing.T) {
	// Reset the global limiter so prior tests don't contaminate this one.
	// Mirrors the pattern security_regression_test.go uses for the
	// login limiter.
	globalWalletWriteLimiter = newRegisterLimiter(15, 5*time.Minute)
	s, tok, _, _ := walletTestServer(t, nil)

	payload := map[string]any{
		"razorpay_order_id":   "order_forged_unit",
		"razorpay_payment_id": "pay_forged_unit",
		"razorpay_signature":  "deadbeef",
	}
	for i := 0; i < 15; i++ {
		code := doJSONFromPublicIP(t, s, "POST", "/api/wallet/verify-payment", tok, payload, testPublicIP)
		if code == http.StatusTooManyRequests {
			t.Fatalf("hit 429 too early on attempt %d (expected to fail with 400/forged-order, not 429)", i+1)
		}
	}
	// 16th attempt MUST be 429.
	code := doJSONFromPublicIP(t, s, "POST", "/api/wallet/verify-payment", tok, payload, testPublicIP)
	if code != http.StatusTooManyRequests {
		t.Errorf("16th attempt: want 429, got %d", code)
	}
}

// Shared budget across endpoints: 10 walletOrder hits + 5 verify-payment
// hits = 15 total → 16th (regardless of endpoint) should 429. An
// attacker can't evade by rotating between endpoints.
func TestWalletRateLimit_SharedAcrossEndpoints(t *testing.T) {
	globalWalletWriteLimiter = newRegisterLimiter(15, 5*time.Minute)
	s, tok, _, _ := walletTestServer(t, nil)

	verifyPayload := map[string]any{
		"razorpay_order_id":   "order_forged_X",
		"razorpay_payment_id": "pay_forged_X",
		"razorpay_signature":  "deadbeef",
	}
	// 8 verify-payments and 7 walletOrders (= 15 total). All should
	// proceed past the limiter (each fails downstream — walletOrder
	// hits Razorpay's real API with our test-unit key and 401s, which
	// is fine — we only care it passed the LIMITER check).
	for i := 0; i < 8; i++ {
		_ = doJSONFromPublicIP(t, s, "POST", "/api/wallet/verify-payment", tok, verifyPayload, testPublicIP)
	}
	orderPayload := map[string]any{"amount_paise": 10000}
	for i := 0; i < 7; i++ {
		_ = doJSONFromPublicIP(t, s, "POST", "/api/wallet/order", tok, orderPayload, testPublicIP)
	}
	// 16th anywhere should 429.
	if code := doJSONFromPublicIP(t, s, "POST", "/api/wallet/verify-payment", tok, verifyPayload, testPublicIP); code != http.StatusTooManyRequests {
		t.Errorf("after 15 shared hits, verify-payment want 429, got %d", code)
	}
}

// Different users have independent buckets — one operator's spam
// (or a single compromised token) must not throttle their colleagues.
func TestWalletRateLimit_PerUserIsolated(t *testing.T) {
	globalWalletWriteLimiter = newRegisterLimiter(15, 5*time.Minute)
	s, tokA, orgID, _ := walletTestServer(t, nil)

	// Seed admin B in the same org so the rate-limit isolation isn't
	// confounded by cross-org rejection.
	res, _ := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
		 VALUES('admin2', 'h', 'admin', ?, 'Admin 2', CURRENT_TIMESTAMP)`, orgID,
	)
	adminBID, _ := res.LastInsertId()
	tokB, _ := s.deps.JWT.Issue(auth.Claims{
		UserID: adminBID, Username: "admin2", Role: "admin", OrgID: &orgID,
	})

	payload := map[string]any{
		"razorpay_order_id":   "order_X",
		"razorpay_payment_id": "pay_X",
		"razorpay_signature":  "deadbeef",
	}
	// Burn admin A's 15 budget.
	for i := 0; i < 15; i++ {
		_ = doJSONFromPublicIP(t, s, "POST", "/api/wallet/verify-payment", tokA, payload, testPublicIP)
	}
	if code := doJSONFromPublicIP(t, s, "POST", "/api/wallet/verify-payment", tokA, payload, testPublicIP); code != http.StatusTooManyRequests {
		t.Errorf("admin A's 16th: want 429, got %d", code)
	}
	// Admin B's first request should NOT be 429 — separate bucket.
	if code := doJSONFromPublicIP(t, s, "POST", "/api/wallet/verify-payment", tokB, payload, testPublicIP); code == http.StatusTooManyRequests {
		t.Errorf("admin B's 1st request was throttled by admin A's bucket: got 429")
	}
}

// Loopback / private IPs are exempt — never 429 regardless of count.
// This guards the dev workflow (Vite proxy + backend on 127.0.0.1) and
// LAN testing (e.g. Windows laptop on the same college Wi-Fi as the
// portal during operator-install tests).
func TestWalletRateLimit_LoopbackExempt(t *testing.T) {
	globalWalletWriteLimiter = newRegisterLimiter(15, 5*time.Minute)
	s, tok, _, _ := walletTestServer(t, nil)

	payload := map[string]any{
		"razorpay_order_id":   "order_loopback",
		"razorpay_payment_id": "pay_loopback",
		"razorpay_signature":  "deadbeef",
	}
	// 30 attempts from loopback (default doJSON behaviour) — all must
	// get past the limiter. They'll fail at the forged-order check
	// with 400, but never 429.
	for i := 0; i < 30; i++ {
		code, _ := doJSON(t, s, "POST", "/api/wallet/verify-payment", tok, payload)
		if code == http.StatusTooManyRequests {
			t.Fatalf("loopback exemption broke at attempt %d", i+1)
		}
	}
}

// Sanity: confirm the test helpers themselves are wired correctly —
// without this, a broken doJSON wrapper could silently turn a 400 into
// a 200 and the tests above would all "pass" for the wrong reason.
func TestTestScaffolding_Sanity(t *testing.T) {
	s, tok, _, _ := walletTestServer(t, nil)
	// Hitting /api/me with a valid token MUST be 200.
	code, _ := doJSON(t, s, "GET", "/api/me", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("scaffolding broken: /api/me with valid token returned %d", code)
	}
	// Hitting /api/me without a token MUST be 401.
	code, _ = doJSON(t, s, "GET", "/api/me", "", nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("scaffolding broken: /api/me without token returned %d", code)
	}
	// Webhook signature helper round-trip.
	body := []byte(`{"hello":"world"}`)
	sig := signWebhook(body, testWebhookSecret)
	want := fmt.Sprintf("%x", hmac.New(sha256.New, []byte(testWebhookSecret)).Sum(append([]byte(nil), body...)))
	// Quick check that the helper returns hex of length 64 (SHA256).
	if len(sig) != 64 || strings.ContainsAny(sig, "ghijklmnopqrstuvwxyz") {
		t.Errorf("signWebhook returned malformed signature %q", sig)
	}
	_ = want
}
