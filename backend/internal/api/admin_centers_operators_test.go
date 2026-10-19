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
	"github.com/veni/neet-verification/internal/testsupport"
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

	d := testsupport.FreshDB(t)
	idx, _ := data.LoadIndex(filepath.Join(tmp, "datatree-empty"))

	jwt := auth.NewJWTService("test-secret", time.Hour)
	cfg := config.Config{
		HTTPAddr:                ":0",
		JWTSecret:               "test-secret",
		ArtifactDir:             filepath.Join(tmp, "artifacts"),
	}
	s := NewServer(Deps{DB: d, Index: idx, JWT: jwt, Cfg: cfg})

	orgA := seedOrgFixture(t, s, jwt, "ALPHA", "Alpha University", "alpha_admin", "alpha_op", "AlphaPass1234")
	orgB := seedOrgFixture(t, s, jwt, "BETA", "Beta College", "beta_admin", "beta_op", "BetaPass5678")
	return s, orgA, orgB
}

func seedOrgFixture(t *testing.T, s *Server, jwt *auth.JWTService, orgCode, orgName, adminUser, opUser, opPassword string) orgFixture {
	t.Helper()
	var orgID int64
	if err := s.deps.DB.QueryRow(db.Q(
		`INSERT INTO organizations(code, name) VALUES(?, ?) RETURNING id`),
		orgCode, orgName,
	).Scan(&orgID); err != nil {
		t.Fatalf("insert org %s: %v", orgCode, err)
	}

	adminHash, _ := bcrypt.GenerateFromPassword([]byte("admin-test-pw"), bcrypt.MinCost)
	var adminID int64
	if err := s.deps.DB.QueryRow(db.Q(
		`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
		 VALUES(?, ?, 'admin', ?, ?, CURRENT_TIMESTAMP) RETURNING id`),
		adminUser, string(adminHash), orgID, "Admin of "+orgName,
	).Scan(&adminID); err != nil {
		t.Fatalf("insert admin: %v", err)
	}

	opHash, _ := bcrypt.GenerateFromPassword([]byte(opPassword), bcrypt.MinCost)
	var opID int64
	if err := s.deps.DB.QueryRow(db.Q(
		`INSERT INTO users(username, password_hash, password_plaintext, role,
		                   org_id, display_name, activated_at, spending_cap_paise)
		 VALUES(?, ?, ?, 'client', ?, 'Centre Operator', CURRENT_TIMESTAMP, 10000000)
		 RETURNING id`),
		opUser, string(opHash), opPassword, orgID,
	).Scan(&opID); err != nil {
		t.Fatalf("insert operator: %v", err)
	}

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
// login. This is the headline "I approved an institution and it is now a
// tenant" check.
//
// Approval used to hand back a ready-made shared "Centre Operator" and its
// plaintext password. That was removed in b05d5a1 ("remove auto Centre
// Operator") because the institute admin creates their own agents from the
// operator page. What approval owes the caller now is the tenant itself:
// the org, its admin user, and the link that admin sets a password with.
func TestApprovalFlow_ProvisionsOrgAndAdmin(t *testing.T) {
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

	adminUser, _ := body["admin_username"].(string)
	if adminUser == "" {
		t.Errorf("approval must name the admin it provisioned; got %v", body)
	}
	if link, _ := body["magic_link_url"].(string); link == "" {
		t.Errorf("approval must return a set-password link; got %v", body["magic_link_url"])
	}

	var status string
	if err := s.deps.DB.QueryRow(db.Q(
		`SELECT status FROM institution_applications WHERE id = ?`), appID,
	).Scan(&status); err != nil {
		t.Fatalf("read application: %v", err)
	}
	if status != "approved" {
		t.Errorf("application status: want approved, got %q", status)
	}

	var adminCount int
	if err := s.deps.DB.QueryRow(db.Q(
		`SELECT COUNT(*)
		   FROM users u
		   JOIN organizations o ON o.id = u.org_id
		  WHERE o.application_id = ? AND u.role = 'admin' AND u.username = ?`),
		appID, adminUser,
	).Scan(&adminCount); err != nil {
		t.Fatalf("count admin: %v", err)
	}
	if adminCount != 1 {
		t.Errorf("want exactly 1 provisioned admin for the application, got %d", adminCount)
	}

	// And no agent is conjured on the institute's behalf.
	var opCount int
	if err := s.deps.DB.QueryRow(db.Q(
		`SELECT COUNT(*)
		   FROM users u
		   JOIN organizations o ON o.id = u.org_id
		  WHERE o.application_id = ? AND u.role = 'client'`), appID,
	).Scan(&opCount); err != nil {
		t.Fatalf("count operators: %v", err)
	}
	if opCount != 0 {
		t.Errorf("approval must not auto-create agents, got %d", opCount)
	}
}

// approvalTestServer is a minimal server with one superadmin user
// pre-seeded so we can hit /api/superadmin/applications/{id}/approve.
func approvalTestServer(t *testing.T) *Server {
	t.Helper()
	tmp := t.TempDir()
	d := testsupport.FreshDB(t)
	idx, _ := data.LoadIndex(filepath.Join(tmp, "datatree-empty"))
	jwt := auth.NewJWTService("test-secret", time.Hour)
	cfg := config.Config{
		JWTSecret:         "test-secret",
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
	var id int64
	if err := s.deps.DB.QueryRow(
		`INSERT INTO institution_applications(
		    status, institution_name, institution_type, tier,
		    aishe_code, address_line1, city, state, pin_code,
		    head_name, head_designation, head_email, head_mobile
		 ) VALUES('pending','Approval-Test University','university','tier_1',
		          'U-TEST-001','1 Test Road','Testville','TestState','000000',
		          'Test Head','Vice-Chancellor','head@example.com','9000000000')
		 RETURNING id`,
	).Scan(&id); err != nil {
		t.Fatalf("seed application: %v", err)
	}
	return id
}

func mintSuperadminToken(t *testing.T, s *Server) string {
	t.Helper()
	hash, _ := bcrypt.GenerateFromPassword([]byte("super"), bcrypt.MinCost)
	var id int64
	if err := s.deps.DB.QueryRow(db.Q(
		`INSERT INTO users(username, password_hash, role, display_name, activated_at)
		 VALUES('super_test', ?, 'superadmin', 'Test Super', CURRENT_TIMESTAMP)
		 RETURNING id`),
		string(hash),
	).Scan(&id); err != nil {
		t.Fatalf("seed superadmin: %v", err)
	}
	tok, err := s.deps.JWT.Issue(auth.Claims{
		UserID: id, Username: "super_test", Role: "superadmin",
	})
	if err != nil {
		t.Fatalf("issue super token: %v", err)
	}
	return tok
}
