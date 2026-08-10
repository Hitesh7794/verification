package api

// Regression tests for the pre-deploy hardening pass. Each test in
// this file pins down a specific bug that was fixed; failing one means
// a regression is shipping. Names start with the security/feature
// area so `go test -run` is easy to scope.

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/veni/neet-verification/internal/auth"
)

// -----------------------------------------------------------------------
// Mid-session disable: a user with a still-valid JWT must be rejected
// as soon as their disabled_at column is set. Pre-fix the JWT alone
// kept them in until 12-hour expiry.
// -----------------------------------------------------------------------

func TestAuthMiddleware_DisabledMidSessionRejected(t *testing.T) {
	s, a, _ := twoOrgServer(t)

	// Operator token is already minted in the fixture. Confirm it
	// works against a representative authed endpoint first.
	code, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	if code != http.StatusOK {
		t.Fatalf("operator login before disable: %d", code)
	}
	loginCode, loginBody := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	if loginCode != http.StatusOK {
		t.Fatalf("operator login: %d", loginCode)
	}
	opToken := loginBody["token"].(string)

	// Operator is authed. Now disable them DB-side while their token
	// stays valid in JWT terms.
	if _, err := s.deps.DB.Exec(
		`UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = ?`, a.OperatorID,
	); err != nil {
		t.Fatal(err)
	}

	// Next request with the same token must 401. We hit /api/me
	// because it's the cheapest authed endpoint.
	code2, body2 := doJSON(t, s, "GET", "/api/me", opToken, nil)
	if code2 != http.StatusUnauthorized {
		t.Errorf("disabled-mid-session must 401, got %d", code2)
	}
	if msg, _ := body2["error"].(string); !strings.Contains(msg, "disabled") {
		t.Errorf("expected 'disabled' in error, got %q", msg)
	}
}

// A user who has been DELETED entirely (not just disabled) must also
// 401 their existing token, not crash the server or grant access.
func TestAuthMiddleware_DeletedUserRejected(t *testing.T) {
	s, a, _ := twoOrgServer(t)

	// Sign in to get a fresh operator token.
	_, loginBody := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	opToken := loginBody["token"].(string)

	if _, err := s.deps.DB.Exec(`DELETE FROM users WHERE id = ?`, a.OperatorID); err != nil {
		t.Fatal(err)
	}
	code, body := doJSON(t, s, "GET", "/api/me", opToken, nil)
	if code != http.StatusUnauthorized {
		t.Errorf("deleted-user must 401, got %d", code)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "no longer exists") {
		t.Errorf("expected 'no longer exists' in error, got %q", msg)
	}
}

// -----------------------------------------------------------------------
// Approval race: concurrent approvals of one application must result
// in exactly one approval + one admin + one operator. Previously two
// approvers could both pass the status='pending' check, then both
// proceed and create duplicate user rows.
// -----------------------------------------------------------------------

func TestApprovalRace_OnlyOneSucceeds(t *testing.T) {
	s := approvalTestServer(t)
	appID := seedPendingApplication(t, s)
	tok := mintSuperadminToken(t, s)

	const concurrency = 8
	var wg sync.WaitGroup
	results := make([]int, concurrency)
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			code, _ := doJSON(t, s, "POST",
				fmt.Sprintf("/api/superadmin/applications/%d/approve", appID),
				tok, map[string]any{"note": ""})
			results[idx] = code
		}(i)
	}
	wg.Wait()

	successes, conflicts := 0, 0
	for _, c := range results {
		switch c {
		case http.StatusOK:
			successes++
		case http.StatusConflict:
			conflicts++
		default:
			t.Errorf("unexpected status %d", c)
		}
	}
	if successes != 1 {
		t.Errorf("want exactly 1 success, got %d", successes)
	}
	if conflicts != concurrency-1 {
		t.Errorf("want %d conflicts, got %d", concurrency-1, conflicts)
	}

	// One admin + one operator created in total — no duplicates.
	var adminCount, opCount int
	_ = s.deps.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE role='admin'`).Scan(&adminCount)
	_ = s.deps.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE role='client'`).Scan(&opCount)
	if adminCount != 1 {
		t.Errorf("race must create exactly 1 admin, got %d", adminCount)
	}
	if opCount != 1 {
		t.Errorf("race must create exactly 1 operator, got %d", opCount)
	}
}

// -----------------------------------------------------------------------
// Wallet middleware: a candidate lookup that 404s must NOT debit the
// org wallet. Pre-fix the debit ran before the inner handler.
// -----------------------------------------------------------------------

func TestWalletCharge_FailedLookupDoesNotDebit(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	// Make sure the fee is positive and the wallet has funds.
	s.deps.Cfg.WalletFeePerLookupPaise = 500
	if _, err := s.deps.DB.Exec(
		`INSERT INTO wallets(org_id, balance_paise) VALUES(?, 50000)
		 ON CONFLICT(org_id) DO UPDATE SET balance_paise = excluded.balance_paise`,
		a.OrgID,
	); err != nil {
		t.Fatal(err)
	}

	// Sign in as the operator (its JWT carries the correct org_id +
	// center_id so the wallet middleware actually runs).
	_, loginBody := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	opToken := loginBody["token"].(string)

	// Look up a roll that definitely doesn't exist (empty data tree).
	code, _ := doJSON(t, s, "GET", "/api/candidates/does-not-exist", opToken, nil)
	if code == http.StatusOK {
		t.Fatalf("test invariant: lookup should fail (empty index), got 200")
	}
	if code == http.StatusPaymentRequired {
		t.Fatalf("test invariant: wallet was funded, should not 402; got 402")
	}

	// Wallet balance unchanged + no charge row.
	var bal int
	_ = s.deps.DB.QueryRow(`SELECT balance_paise FROM wallets WHERE org_id=?`, a.OrgID).Scan(&bal)
	if bal != 50000 {
		t.Errorf("balance must not move on failed lookup; want 50000, got %d", bal)
	}
	var charges int
	_ = s.deps.DB.QueryRow(
		`SELECT COUNT(*) FROM wallet_transactions WHERE org_id=? AND kind='charge'`, a.OrgID,
	).Scan(&charges)
	if charges != 0 {
		t.Errorf("failed lookup must not write a charge row; got %d", charges)
	}
}

// Pre-check rejects the lookup when the wallet is empty without
// invoking the inner handler — confirms the early 402 path still
// fires after the buffered refactor.
func TestWalletCharge_EmptyWalletRejected(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	s.deps.Cfg.WalletFeePerLookupPaise = 500
	// Force wallet to 0 explicitly.
	if _, err := s.deps.DB.Exec(
		`INSERT INTO wallets(org_id, balance_paise) VALUES(?, 0)
		 ON CONFLICT(org_id) DO UPDATE SET balance_paise = 0`, a.OrgID,
	); err != nil {
		t.Fatal(err)
	}
	_, loginBody := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	opToken := loginBody["token"].(string)
	code, _ := doJSON(t, s, "GET", "/api/candidates/anything", opToken, nil)
	if code != http.StatusPaymentRequired {
		t.Errorf("empty wallet lookup must 402, got %d", code)
	}
}

// -----------------------------------------------------------------------
// Login rate limit: an attacker hitting login from a public IP gets
// blocked after the configured window's threshold (10 / 15 minutes).
// -----------------------------------------------------------------------

func TestLoginRateLimit_BlocksAfterThreshold(t *testing.T) {
	s, _, _ := twoOrgServer(t)
	// Use a doJSON variant that fakes a public IP via X-Forwarded-For.
	// shouldRateLimit only honours non-loopback / non-private; using
	// 198.51.100.1 (TEST-NET-2, public per RFC 5737) trips the limiter.
	exec := func() int {
		req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{"username":"x","password":"y"}`))
		req.Header.Set("X-Forwarded-For", "198.51.100.42")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		s.Router().ServeHTTP(rr, req)
		return rr.Code
	}

	// Reset the global limiter so other tests don't pollute this one.
	globalLoginLimiter = newRegisterLimiter(10, 15*time.Minute)

	for i := 0; i < 10; i++ {
		c := exec()
		if c == http.StatusTooManyRequests {
			t.Fatalf("attempt %d hit 429 too early", i+1)
		}
	}
	// 11th attempt must be 429.
	if c := exec(); c != http.StatusTooManyRequests {
		t.Errorf("attempt 11 should be rate-limited, got %d", c)
	}
}

// -----------------------------------------------------------------------
// /readyz endpoint reports DB status. Smoke-test it returns 200 when
// the DB is healthy.
// -----------------------------------------------------------------------

func TestReadyz_DBHealthy(t *testing.T) {
	s, _, _ := twoOrgServer(t)
	req := httptest.NewRequest("GET", "/api/readyz", nil)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("readyz: want 200, got %d body=%s", rr.Code, rr.Body.String())
	}
}

// -----------------------------------------------------------------------
// Self password change: any logged-in user can rotate their own
// password. Verifies current_password before updating; syncs the
// plaintext column for shared-operator accounts so the admin's
// dashboard reflects it.
// -----------------------------------------------------------------------

func TestChangePassword_HappyPathAdmin(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	const newPw = "NewAdminPw99!"
	code, body := doJSON(t, s, "POST", "/api/me/change-password", a.AdminToken, map[string]any{
		"current_password": "admin-test-pw",
		"new_password":     newPw,
	})
	if code != http.StatusOK {
		t.Fatalf("change-password: %d %v", code, body)
	}
	// New password works.
	loginCode, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.AdminUser, "password": newPw,
	})
	if loginCode != http.StatusOK {
		t.Errorf("login with new password should work; got %d", loginCode)
	}
	// Old password rejected.
	oldCode, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.AdminUser, "password": "admin-test-pw",
	})
	if oldCode != http.StatusUnauthorized {
		t.Errorf("old password should be rejected; got %d", oldCode)
	}
}

// Operator changes their own password → the plaintext column is
// updated too so the admin's Operator-access view stays accurate.
func TestChangePassword_OperatorSyncsPlaintext(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	_, loginBody := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	opTok := loginBody["token"].(string)
	const newPw = "OpRotated77!"
	code, _ := doJSON(t, s, "POST", "/api/me/change-password", opTok, map[string]any{
		"current_password": a.OperatorPassword,
		"new_password":     newPw,
	})
	if code != http.StatusOK {
		t.Fatalf("operator change-password: %d", code)
	}
	// Admin's GET should see the new plaintext.
	_, getBody := doJSON(t, s, "GET", "/api/admin/operator-access", a.AdminToken, nil)
	if getBody["password"] != newPw {
		t.Errorf("admin view must show synced plaintext; got %v", getBody["password"])
	}
}

func TestChangePassword_WrongCurrentRejected(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	code, body := doJSON(t, s, "POST", "/api/me/change-password", a.AdminToken, map[string]any{
		"current_password": "wrong-password",
		"new_password":     "ValidNewPw99!",
	})
	if code != http.StatusUnauthorized {
		t.Errorf("wrong current_password should be 401, got %d body=%v", code, body)
	}
}

func TestChangePassword_WeakNewRejected(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	for _, weak := range []string{"", "short1A", "onlyletters", "1234567890"} {
		code, _ := doJSON(t, s, "POST", "/api/me/change-password", a.AdminToken, map[string]any{
			"current_password": "admin-test-pw",
			"new_password":     weak,
		})
		if code != http.StatusBadRequest {
			t.Errorf("weak password %q should 400, got %d", weak, code)
		}
	}
}

// Adminʼs password_plaintext column must STAY NULL after a self
// password change — only client-role accounts get plaintext storage
// by design.
func TestChangePassword_AdminPlaintextStaysNull(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	doJSON(t, s, "POST", "/api/me/change-password", a.AdminToken, map[string]any{
		"current_password": "admin-test-pw",
		"new_password":     "AdminRotation99!",
	})
	var plaintextIsNotNull int
	if err := s.deps.DB.QueryRow(
		`SELECT password_plaintext IS NOT NULL FROM users WHERE id = ?`, a.AdminID,
	).Scan(&plaintextIsNotNull); err != nil {
		t.Fatal(err)
	}
	if plaintextIsNotNull != 0 {
		t.Errorf("admin password_plaintext must stay NULL; got populated")
	}
}

// -----------------------------------------------------------------------
// Role-change-since-issue: a JWT minted as 'admin' must be rejected if
// the user's role was changed to something else server-side. Forces
// re-login so the new role is reflected.
// -----------------------------------------------------------------------

func TestAuthMiddleware_RoleChangeForcesReLogin(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	// Forge a token that claims the admin user has role='ops_admin'.
	// In production this would be the historical token from before a
	// role change. Easiest to mint directly from the test JWT service.
	tok, err := s.deps.JWT.Issue(auth.Claims{
		UserID:   a.AdminID,
		Username: a.AdminUser,
		Role:     "ops_admin", // stale role
		OrgID:    &a.OrgID,
	})
	if err != nil {
		t.Fatal(err)
	}
	code, body := doJSON(t, s, "GET", "/api/me", tok, nil)
	if code != http.StatusUnauthorized {
		t.Errorf("stale-role token must 401, got %d body=%v", code, body)
	}
}
