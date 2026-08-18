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
		                   org_id, display_name, activated_at)
		 VALUES(?, ?, ?, 'client', ?, 'Centre Operator', CURRENT_TIMESTAMP)`,
		opUser, string(opHash), opPassword, orgID,
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
// Approval flow — end-to-end (only surviving high-level test in this file;
// the legacy /admin/operator-access GET/reset/disable tests were removed
// with their handlers as part of the Phase-2 cleanup.)
// -----------------------------------------------------------------------


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
	// center_id was removed from the login response along with the
	// centers table in migration 021.
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
