package api

// Tests for the admin "Operator access" surface — the shared
// client-role credential each org uses for all its operator machines.
//
// The headline security concern stays multi-tenant isolation: admin A
// must never see, reset, or disable admin B's operator credential.
// These tests probe each endpoint with same-org calls AND adversarial
// cross-org attempts.
//
// Centres are 1:1 with orgs and auto-created at approval; there is no
// admin centre-management surface to test.

import (
	"bytes"
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
)

// orgFixture is a fully-formed tenant: one organisation, one centre,
// one admin user (token pre-minted), and one shared operator user with
// a known plaintext password.
type orgFixture struct {
	OrgID            int64
	OrgCode          string
	CenterID         int64
	AdminID          int64
	AdminUser        string
	AdminToken       string
	OperatorID       int64
	OperatorUsername string
	OperatorPassword string
}

// twoOrgServer wires a fresh Server with two independent tenants, each
// pre-loaded with a shared operator credential. Tests don't need to
// invent operators — they use the ones the fixture provides.
func twoOrgServer(t *testing.T) (*Server, orgFixture, orgFixture) {
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
	}
	s := NewServer(Deps{DB: d, Index: idx, JWT: jwt, Cfg: cfg})

	orgA := seedOrgFixture(t, s, jwt, "ALPHA", "Alpha University", "alpha_admin", "alpha_op", "AlphaPass1234")
	orgB := seedOrgFixture(t, s, jwt, "BETA", "Beta College", "beta_admin", "beta_op", "BetaPass5678")
	return s, orgA, orgB
}

func seedOrgFixture(t *testing.T, s *Server, jwt *auth.JWTService, orgCode, orgName, adminUser, opUser, opPassword string) orgFixture {
	t.Helper()
	res, err := s.deps.DB.Exec(
		`INSERT INTO organizations(code, name) VALUES(?, ?)`, orgCode, orgName)
	if err != nil {
		t.Fatalf("insert org %s: %v", orgCode, err)
	}
	orgID, _ := res.LastInsertId()

	cres, err := s.deps.DB.Exec(
		`INSERT INTO centers(org_id, code, name) VALUES(?, 'MAIN', ?)`, orgID, orgName,
	)
	if err != nil {
		t.Fatalf("insert center: %v", err)
	}
	centerID, _ := cres.LastInsertId()

	adminHash, _ := bcrypt.GenerateFromPassword([]byte("admin-test-pw"), bcrypt.MinCost)
	ures, err := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
		 VALUES(?, ?, 'admin', ?, ?, CURRENT_TIMESTAMP)`,
		adminUser, string(adminHash), orgID, "Admin of "+orgName,
	)
	if err != nil {
		t.Fatalf("insert admin: %v", err)
	}
	adminID, _ := ures.LastInsertId()

	opHash, _ := bcrypt.GenerateFromPassword([]byte(opPassword), bcrypt.MinCost)
	opRes, err := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, password_plaintext, role,
		                   org_id, center_id, display_name, activated_at)
		 VALUES(?, ?, ?, 'client', ?, ?, 'Centre Operator', CURRENT_TIMESTAMP)`,
		opUser, string(opHash), opPassword, orgID, centerID,
	)
	if err != nil {
		t.Fatalf("insert operator: %v", err)
	}
	opID, _ := opRes.LastInsertId()

	tok, err := jwt.Issue(auth.Claims{
		UserID:   adminID,
		Username: adminUser,
		Role:     "admin",
		OrgID:    &orgID,
	})
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}
	return orgFixture{
		OrgID: orgID, OrgCode: orgCode,
		CenterID:         centerID,
		AdminID:          adminID,
		AdminUser:        adminUser,
		AdminToken:       tok,
		OperatorID:       opID,
		OperatorUsername: opUser,
		OperatorPassword: opPassword,
	}
}

func doJSON(t *testing.T, s *Server, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	var reqBody io.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		reqBody = bytes.NewReader(buf)
	}
	req := httptest.NewRequest(method, path, reqBody)
	// Pin RemoteAddr to loopback so the per-IP rate limiters
	// (shouldRateLimit exempts loopback) don't bite a test that
	// happens to hit login or register many times in a row. The
	// rate-limit behaviour itself is tested separately by spoofing
	// X-Forwarded-For with a public IP.
	req.RemoteAddr = "127.0.0.1:1234"
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	var out map[string]any
	if rr.Body.Len() > 0 {
		_ = json.Unmarshal(rr.Body.Bytes(), &out)
	}
	return rr.Code, out
}

// -----------------------------------------------------------------------
// Operator access — view, reset, disable/enable
// -----------------------------------------------------------------------

func TestAdminGetOperatorAccess_HappyPath(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	code, body := doJSON(t, s, "GET", "/api/admin/operator-access", a.AdminToken, nil)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%v", code, body)
	}
	if body["username"] != a.OperatorUsername {
		t.Errorf("username: want %q, got %v", a.OperatorUsername, body["username"])
	}
	if body["password"] != a.OperatorPassword {
		t.Errorf("password must be visible to admin; want %q, got %v", a.OperatorPassword, body["password"])
	}
	if body["status"] != "active" {
		t.Errorf("status: want active, got %v", body["status"])
	}
}

// The critical multi-tenant test: admin A's GET must show A's operator,
// never B's. We assert by username because the password strings differ
// per fixture too — either field leaking would be a security incident.
func TestAdminGetOperatorAccess_OrgIsolation(t *testing.T) {
	s, a, b := twoOrgServer(t)
	_, bodyA := doJSON(t, s, "GET", "/api/admin/operator-access", a.AdminToken, nil)
	_, bodyB := doJSON(t, s, "GET", "/api/admin/operator-access", b.AdminToken, nil)
	if bodyA["username"] == b.OperatorUsername || bodyA["password"] == b.OperatorPassword {
		t.Errorf("admin A leaked org B's operator: %v", bodyA)
	}
	if bodyB["username"] == a.OperatorUsername || bodyB["password"] == a.OperatorPassword {
		t.Errorf("admin B leaked org A's operator: %v", bodyB)
	}
	if bodyA["username"] != a.OperatorUsername {
		t.Errorf("admin A should see own operator, got %v", bodyA["username"])
	}
	if bodyB["username"] != b.OperatorUsername {
		t.Errorf("admin B should see own operator, got %v", bodyB["username"])
	}
}

func TestAdminResetOperatorAccess_ChangesBothHashAndPlaintext(t *testing.T) {
	s, a, _ := twoOrgServer(t)

	// Before reset: operator can log in with the original password.
	beforeCode, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	if beforeCode != http.StatusOK {
		t.Fatalf("operator login before reset: want 200, got %d", beforeCode)
	}

	// Reset.
	rcode, rbody := doJSON(t, s, "POST", "/api/admin/operator-access/reset-password", a.AdminToken, nil)
	if rcode != http.StatusOK {
		t.Fatalf("reset: %d %v", rcode, rbody)
	}
	newPassword := rbody["password"].(string)
	if newPassword == a.OperatorPassword {
		t.Fatal("reset must yield a different password")
	}
	if len(newPassword) < 8 {
		t.Errorf("new password looks suspiciously short: %q", newPassword)
	}

	// Old password no longer works (hash was rotated).
	oldCode, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	if oldCode != http.StatusUnauthorized {
		t.Errorf("old password should be rejected; got %d", oldCode)
	}

	// New password works.
	newCode, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": newPassword,
	})
	if newCode != http.StatusOK {
		t.Errorf("new password should log in; got %d", newCode)
	}

	// Subsequent GET reflects the new plaintext — they must stay in sync.
	_, getBody := doJSON(t, s, "GET", "/api/admin/operator-access", a.AdminToken, nil)
	if getBody["password"] != newPassword {
		t.Errorf("GET after reset should reflect new password; got %v", getBody["password"])
	}
}

func TestAdminDisableEnableOperatorAccess_LoginCycle(t *testing.T) {
	s, a, _ := twoOrgServer(t)

	// Disable.
	dcode, _ := doJSON(t, s, "POST", "/api/admin/operator-access/disable", a.AdminToken, nil)
	if dcode != http.StatusOK {
		t.Fatalf("disable: %d", dcode)
	}

	// Operator login refused with 403 + "disabled" message (not 401, so
	// the legitimate operator knows their creds are right and the
	// problem is access policy).
	code, body := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	if code != http.StatusForbidden {
		t.Errorf("disabled login: want 403, got %d", code)
	}
	if msg, _ := body["error"].(string); !strings.Contains(msg, "disabled") {
		t.Errorf("disabled login error must mention 'disabled', got %q", msg)
	}

	// Re-enable.
	ecode, _ := doJSON(t, s, "POST", "/api/admin/operator-access/enable", a.AdminToken, nil)
	if ecode != http.StatusOK {
		t.Fatalf("enable: %d", ecode)
	}
	code2, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	if code2 != http.StatusOK {
		t.Errorf("login after re-enable: want 200, got %d", code2)
	}
}

// Admin sets a custom (non-random) password for the shared operator.
// The new password must work for login, the old one must not, and the
// dashboard's subsequent GET must reflect it.
func TestAdminSetOperatorPassword_HappyPath(t *testing.T) {
	s, a, _ := twoOrgServer(t)

	const newPw = "OperatorPick42!"
	code, body := doJSON(t, s, "POST", "/api/admin/operator-access/set-password", a.AdminToken,
		map[string]any{"password": newPw})
	if code != http.StatusOK {
		t.Fatalf("set-password: %d %v", code, body)
	}
	if body["password"] != newPw {
		t.Errorf("response must echo the new password; got %v", body["password"])
	}

	// Old password rejected.
	oldCode, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": a.OperatorPassword,
	})
	if oldCode != http.StatusUnauthorized {
		t.Errorf("old password should be rejected; got %d", oldCode)
	}

	// New password works.
	newCode, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": a.OperatorUsername, "password": newPw,
	})
	if newCode != http.StatusOK {
		t.Errorf("new password should log in; got %d", newCode)
	}

	// GET reflects the new plaintext.
	_, getBody := doJSON(t, s, "GET", "/api/admin/operator-access", a.AdminToken, nil)
	if getBody["password"] != newPw {
		t.Errorf("GET after set must reflect new password; got %v", getBody["password"])
	}
}

// Validation: weak passwords are rejected with 400. Matches the
// strength floor used elsewhere in the product.
func TestAdminSetOperatorPassword_ValidationRejects(t *testing.T) {
	s, a, _ := twoOrgServer(t)
	for _, bad := range []string{
		"",               // empty
		"short1",         // too short
		"onlyletters!!!", // no digit
		"1234567890",     // no letter
	} {
		code, _ := doJSON(t, s, "POST", "/api/admin/operator-access/set-password", a.AdminToken,
			map[string]any{"password": bad})
		if code != http.StatusBadRequest {
			t.Errorf("expected 400 for %q, got %d", bad, code)
		}
	}
}

// Admin A's set-password must not touch admin B's operator credential.
func TestAdminSetOperatorPassword_OrgScoped(t *testing.T) {
	s, a, b := twoOrgServer(t)
	_, _ = doJSON(t, s, "POST", "/api/admin/operator-access/set-password", a.AdminToken,
		map[string]any{"password": "AdminAPick99!"})

	// Admin B's operator must still log in with its original password.
	code, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": b.OperatorUsername, "password": b.OperatorPassword,
	})
	if code != http.StatusOK {
		t.Errorf("admin A's set-password must not affect admin B's operator; got %d", code)
	}
}

// Cross-org adversarial: admin A calling reset/disable/enable should
// only ever affect their own org's operator, never admin B's.
func TestAdminOperatorAccess_ResetIsOrgScoped(t *testing.T) {
	s, a, b := twoOrgServer(t)
	_, _ = doJSON(t, s, "POST", "/api/admin/operator-access/reset-password", a.AdminToken, nil)

	// Admin B's operator must STILL log in with its original password —
	// admin A's reset must not have touched the row.
	code, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": b.OperatorUsername, "password": b.OperatorPassword,
	})
	if code != http.StatusOK {
		t.Errorf("admin A's reset must not affect admin B's operator (got login code %d)", code)
	}
}

func TestAdminOperatorAccess_DisableIsOrgScoped(t *testing.T) {
	s, a, b := twoOrgServer(t)
	_, _ = doJSON(t, s, "POST", "/api/admin/operator-access/disable", a.AdminToken, nil)

	// Admin B's operator should still log in.
	code, _ := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": b.OperatorUsername, "password": b.OperatorPassword,
	})
	if code != http.StatusOK {
		t.Errorf("admin A's disable must not affect admin B's operator (got login code %d)", code)
	}
}

// If an admin's org has no shared operator row (defensive — production
// orgs always have one via the approval flow, but a hand-seeded org
// might not), the GET should 404 cleanly, not panic.
func TestAdminGetOperatorAccess_NoOperator_404(t *testing.T) {
	s, _, _ := twoOrgServer(t)
	// Manually create a fresh org + admin with no shared operator.
	res, _ := s.deps.DB.Exec(`INSERT INTO organizations(code, name) VALUES('NEWORG', 'New Org')`)
	orgID, _ := res.LastInsertId()
	hash, _ := bcrypt.GenerateFromPassword([]byte("x"), bcrypt.MinCost)
	ures, _ := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
		 VALUES('lonely_admin', ?, 'admin', ?, 'Admin', CURRENT_TIMESTAMP)`,
		string(hash), orgID,
	)
	loneID, _ := ures.LastInsertId()
	tok, _ := s.deps.JWT.Issue(auth.Claims{
		UserID: loneID, Username: "lonely_admin", Role: "admin", OrgID: &orgID,
	})
	code, body := doJSON(t, s, "GET", "/api/admin/operator-access", tok, nil)
	if code != http.StatusNotFound {
		t.Errorf("no-operator GET should be 404, got %d body=%v", code, body)
	}
}

// Full integration: the registration approval flow auto-creates the
// shared operator and the returned credentials immediately work for
// login. This is the headline "I approved an institution and they can
// onboard their team" check.
func TestApprovalFlow_ReturnsWorkingSharedOperator(t *testing.T) {
	s := approvalTestServer(t)

	// Seed an institution_application row in pending state.
	appID := seedPendingApplication(t, s)

	// Mint a superadmin token to call the approve endpoint.
	tok := mintSuperadminToken(t, s)

	code, body := doJSON(t, s, "POST", fmt.Sprintf("/api/superadmin/applications/%d/approve", appID),
		tok, map[string]any{"note": ""})
	if code != http.StatusOK {
		t.Fatalf("approve: %d %v", code, body)
	}

	opUser, _ := body["operator_username"].(string)
	opPass, _ := body["operator_password"].(string)
	if opUser == "" || opPass == "" {
		t.Fatalf("approval response must include operator credentials; got user=%q pass=%q", opUser, opPass)
	}

	// Operator should be able to log in immediately with no separate
	// activation flow — that was the whole point of switching off
	// per-operator email invites.
	loginCode, loginBody := doJSON(t, s, "POST", "/api/auth/login", "", map[string]any{
		"username": opUser, "password": opPass,
	})
	if loginCode != http.StatusOK {
		t.Fatalf("operator login after approval: want 200, got %d body=%v", loginCode, loginBody)
	}
	user := loginBody["user"].(map[string]any)
	if user["role"] != "client" {
		t.Errorf("role: want client, got %v", user["role"])
	}
	if user["org_id"] == nil {
		t.Errorf("operator must carry org_id claim")
	}
	if user["center_id"] == nil {
		t.Errorf("operator must be bound to the auto-created MAIN centre")
	}
}

// approvalTestServer is a minimal server with one superadmin user
// pre-seeded so we can hit /api/superadmin/applications/{id}/approve.
func approvalTestServer(t *testing.T) *Server {
	t.Helper()
	tmp := t.TempDir()
	d, err := db.Open(filepath.Join(tmp, "v.db"))
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	idx, _ := data.LoadIndex(filepath.Join(tmp, "datatree-empty"))
	jwt := auth.NewJWTService("test-secret", time.Hour)
	cfg := config.Config{
		JWTSecret:         "test-secret",
		ArtifactRetention: "metadata",
		ArtifactDir:       filepath.Join(tmp, "artifacts"),
	}
	return NewServer(Deps{DB: d, Index: idx, JWT: jwt, Cfg: cfg})
}

// seedPendingApplication inserts a fully-formed institution_applications
// row in 'pending' state. Returns the row's ID. The field set mirrors
// what the public registration endpoints produce; we hand-seed here so
// the test stays focused on approval behaviour, not registration parsing.
func seedPendingApplication(t *testing.T, s *Server) int64 {
	t.Helper()
	res, err := s.deps.DB.Exec(
		`INSERT INTO institution_applications(
		    status, institution_name, institution_type, tier,
		    aishe_code, address_line1, city, state, pin_code,
		    head_name, head_designation, head_email, head_mobile
		 ) VALUES('pending','Approval-Test University','university','tier_1',
		          'U-TEST-001','1 Test Road','Testville','TestState','000000',
		          'Test Head','Vice-Chancellor','head@example.com','9000000000')`,
	)
	if err != nil {
		t.Fatalf("seed application: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func mintSuperadminToken(t *testing.T, s *Server) string {
	t.Helper()
	hash, _ := bcrypt.GenerateFromPassword([]byte("super"), bcrypt.MinCost)
	res, err := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, role, display_name, activated_at)
		 VALUES('super_test', ?, 'superadmin', 'Test Super', CURRENT_TIMESTAMP)`,
		string(hash),
	)
	if err != nil {
		t.Fatalf("seed superadmin: %v", err)
	}
	id, _ := res.LastInsertId()
	tok, err := s.deps.JWT.Issue(auth.Claims{
		UserID: id, Username: "super_test", Role: "superadmin",
	})
	if err != nil {
		t.Fatalf("issue super token: %v", err)
	}
	return tok
}
