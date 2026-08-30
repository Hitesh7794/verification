package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	dpapi "github.com/veni/neet-verification/internal/api"
	"github.com/veni/neet-verification/internal/auth"
	dpconfig "github.com/veni/neet-verification/internal/config"
	cpapi "github.com/veni/neet-verification/internal/controlplane/api"
	cpconfig "github.com/veni/neet-verification/internal/controlplane/config"
	cpdb "github.com/veni/neet-verification/internal/controlplane/db"
	"github.com/veni/neet-verification/internal/data"
	dpdb "github.com/veni/neet-verification/internal/db"
)

func main() {
	log.Println("==================================================")
	log.Println("🚀 STARTING MULTI-TENANT END-TO-END SMOKE TEST")
	log.Println("==================================================")

	dsn := "postgres://portal:portal-dev@127.0.0.1:5434/verification?sslmode=disable"
	dbConn, err := dpdb.Open(dsn)
	if err != nil {
		log.Fatalf("failed to open test database: %v", err)
	}
	defer dbConn.Close()

	if err := dpdb.Migrate(dbConn); err != nil {
		log.Fatalf("failed dp migrations: %v", err)
	}
	if err := cpdb.Migrate(dbConn); err != nil {
		log.Fatalf("failed cp migrations: %v", err)
	}

	ctx := context.Background()

	// 1. Setup Control Plane in memory
	cpCfg := cpconfig.Load()
	cpCfg.DatabaseURL = dsn
	cpCfg.JWTSecret = "test-cp-secret"
	cpJWT := auth.NewJWTService("test-cp-secret", 24*time.Hour)

	cpServer := cpapi.NewServer(cpapi.Deps{
		DB:  dbConn,
		JWT: cpJWT,
		Cfg: cpCfg,
	})
	cpHTTP := httptest.NewServer(cpServer.Router())
	defer cpHTTP.Close()
	log.Printf("✓ Control Plane test server running at %s", cpHTTP.URL)

	// 2. Setup Data Plane in memory
	dpCfg := dpconfig.Load()
	dpCfg.DatabaseURL = dsn
	dpCfg.JWTSecret = "test-dp-secret"
	dpCfg.ControlPlaneURL = cpHTTP.URL
	dpCfg.DataPlaneClientID = 1
	dpCfg.DataPlaneAPIKey = "test-internal-key"
	dpCfg.InternalAPIKey = "test-internal-key"
	dpCfg.ServeKYCLocally = false // PROXY MODE ACTIVE!

	dpJWT := auth.NewJWTService("test-dp-secret", 24*time.Hour)
	idx, err := data.LoadIndex(dpCfg.DataDir)
	if err != nil {
		log.Fatalf("failed load index: %v", err)
	}

	dpServer := dpapi.NewServer(dpapi.Deps{
		DB:    dbConn,
		Index: idx,
		JWT:   dpJWT,
		Cfg:   dpCfg,
	})
	dpHTTP := httptest.NewServer(dpServer.Router())
	defer dpHTTP.Close()
	log.Printf("✓ Data Plane test server running at %s (ServeKYCLocally=false)", dpHTTP.URL)

	// Seed Client in Control Plane clients_registry with Data Plane URL
	var clientID int64
	err = dbConn.QueryRowContext(ctx, "SELECT id FROM clients_registry WHERE code = 'NTA'").Scan(&clientID)
	if err != nil {
		err = dbConn.QueryRowContext(ctx, `
			INSERT INTO clients_registry(name, code, domain, api_url, api_key, kyc_review_mode, status, updated_at)
			VALUES('National Testing Agency', 'NTA', 'nta.verification.in', $1, 'test-internal-key', 'both', 'active', NOW())
			RETURNING id`,
			dpHTTP.URL,
		).Scan(&clientID)
		if err != nil {
			log.Fatalf("failed to insert clients_registry: %v", err)
		}
	} else {
		_, _ = dbConn.ExecContext(ctx, `
			UPDATE clients_registry
			   SET code = 'NTA', domain = 'nta.verification.in', api_url = $1, api_key = 'test-internal-key', status = 'active', updated_at = NOW()
			 WHERE id = $2`,
			dpHTTP.URL, clientID,
		)
	}

	dpCfg.DataPlaneClientID = clientID

	// Also ensure Client exists in Data Plane clients table
	_, _ = dbConn.ExecContext(ctx, `
		INSERT INTO clients(id, name, code, domain, visible, closed, portal_enabled, updated_at)
		OVERRIDING SYSTEM VALUE
		VALUES($1, 'National Testing Agency', 'NTA', 'nta.verification.in', 1, 0, TRUE, NOW())
		ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
		clientID,
	)

	// Seed at least 1 exam under NTA so subscription fanout is verified
	_, _ = dbConn.ExecContext(ctx, `
		INSERT INTO exams(client_id, name, exam_code, verification_from, verification_to, visible, closed, requires_face, requires_fp, updated_at)
		VALUES($1, 'NEET-UG-2026 Test', 'NEET-SMOKE-2026', '2026-05-01', '2026-05-30', 1, 0, 1, 1, NOW())
		ON CONFLICT (exam_code) DO NOTHING`,
		clientID,
	)

	// Select or insert reviewer user for this client in Data Plane DB
	var (
		reviewerID       int64
		reviewerUsername string
	)
	err = dbConn.QueryRowContext(ctx, `
		SELECT id, username FROM users WHERE client_id = $1 AND role = 'client_reviewer'
	`, clientID).Scan(&reviewerID, &reviewerUsername)
	if err != nil {
		err = dbConn.QueryRowContext(ctx, `
			INSERT INTO users(username, password_hash, role, client_id, display_name)
			VALUES('nta_smoke_reviewer', '$2a$10$dummyhashplaceholder', 'client_reviewer', $1, 'NTA Smoke Reviewer')
			RETURNING id, username`,
			clientID,
		).Scan(&reviewerID, &reviewerUsername)
		if err != nil {
			log.Fatalf("failed to get/insert reviewer user: %v", err)
		}
	}

	// Mint token for NTA Reviewer
	reviewerToken, err := dpJWT.Issue(auth.Claims{
		UserID:   reviewerID,
		Username: reviewerUsername,
		Role:     "client_reviewer",
		ClientID: int64Ptr(clientID),
	})
	if err != nil {
		log.Fatalf("mint reviewer token: %v", err)
	}

	// ── TEST 1: Direct Data Plane Internal API Check ──
	log.Println("\n[TEST 1] Testing Data Plane Internal Health & Metrics API...")
	req, _ := http.NewRequest("GET", dpHTTP.URL+"/api/internal/health", nil)
	req.Header.Set("X-Internal-API-Key", "test-internal-key")
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		log.Fatalf("FAILED /api/internal/health: status=%v err=%v", resp.StatusCode, err)
	}
	log.Println("✓ /api/internal/health returned 200 OK")

	// ── TEST 2: Submit Registration via Data Plane Proxy ──
	log.Println("\n[TEST 2] Submitting KYC Application through Data Plane Proxy (/api/register/submit)...")
	testSuffix := time.Now().UnixNano()
	uniqueMobile := fmt.Sprintf("98%08d", testSuffix%100000000)
	regPayload := map[string]any{
		"institution_name":       fmt.Sprintf("Smoke Test Medical College %d", testSuffix%10000),
		"institution_type":       "college",
		"aishe_code":             fmt.Sprintf("C-%d", testSuffix%100000),
		"pan":                    fmt.Sprintf("ABCDE%04dF", testSuffix%10000),
		"state":                  "Delhi",
		"city":                   "New Delhi",
		"head_name":              "Dr. Smoke Tester",
		"head_designation":       "Dean",
		"head_email":             fmt.Sprintf("dean_%d@smoketest.ac.in", testSuffix%10000),
		"head_mobile":            uniqueMobile,
		"approx_student_count":   1500,
		"address_line1":          "Medical Enclave Phase 1",
		"pin_code":               "110001",
		"authorized_name":        "Dr. Smoke Tester",
		"authorized_email":       fmt.Sprintf("dean_%d@smoketest.ac.in", testSuffix%10000),
		"authorized_mobile":      uniqueMobile,
		"authorized_designation": "Dean",
		"email_otp":              "123456",
		"sms_otp":                "123456",
	}
	bodyBytes, _ := json.Marshal(regPayload)
	req, _ = http.NewRequest("POST", dpHTTP.URL+"/api/register/999/submit", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		log.Fatalf("submit request failed: %v", err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		log.Fatalf("FAILED /api/register/submit: status=%d body=%s", resp.StatusCode, string(respBody))
	}
	var submitResult struct {
		ID            int64  `json:"id"`
		ApplicationID int64  `json:"application_id"`
		Status        string `json:"status"`
	}
	_ = json.Unmarshal(respBody, &submitResult)
	appID := submitResult.ApplicationID
	if appID == 0 {
		appID = submitResult.ID
	}
	log.Printf("✓ Registration proxied to Control Plane successfully! Application ID: #%d (status=%s)", appID, submitResult.Status)

	// Verify Control Plane DB has the pending record
	var cpStatus string
	err = dbConn.QueryRowContext(ctx, "SELECT status FROM institution_applications WHERE id = $1", appID).Scan(&cpStatus)
	if err != nil || cpStatus != "pending" {
		log.Fatalf("FAILED: Control Plane DB record status=%s err=%v", cpStatus, err)
	}
	log.Printf("✓ Confirmed record stored in Control Plane DB with status: %s", cpStatus)

	// ── TEST 3: Reviewer Lists Applications via Proxy ──
	log.Println("\n[TEST 3] Fetching Reviewer Inbox via Data Plane Proxy (/api/client/applications)...")
	req, _ = http.NewRequest("GET", dpHTTP.URL+"/api/client/applications?status=pending", nil)
	req.Header.Set("Authorization", "Bearer "+reviewerToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		log.Fatalf("FAILED /api/client/applications: status=%v err=%v", resp.StatusCode, err)
	}
	respBody, _ = io.ReadAll(resp.Body)
	var listResp struct {
		Items []struct {
			ID              int64  `json:"id"`
			InstitutionName string `json:"institution_name"`
			Status          string `json:"status"`
		} `json:"items"`
	}
	_ = json.Unmarshal(respBody, &listResp)
	found := false
	for _, a := range listResp.Items {
		if a.ID == appID {
			found = true
			break
		}
	}
	if !found {
		log.Fatalf("FAILED: Application #%d not found in proxied reviewer list (total=%d)", appID, len(listResp.Items))
	}
	log.Printf("✓ Reviewer proxy fetched inbox from Control Plane successfully! (Found application #%d)", appID)

	// ── TEST 4: Reviewer Approves & Verifies Provisioning Fan-Out ──
	log.Println("\n[TEST 4] Reviewer Approves Application (/api/client/applications/:id/approve)...")
	approveBody, _ := json.Marshal(map[string]string{
		"note": "Smoke test automated verification approval",
	})
	req, _ = http.NewRequest("POST", dpHTTP.URL+fmt.Sprintf("/api/client/applications/%d/approve", appID), bytes.NewReader(approveBody))
	req.Header.Set("Authorization", "Bearer "+reviewerToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		log.Fatalf("FAILED approval: status=%d body=%s", resp.StatusCode, string(b))
	}
	respBody, _ = io.ReadAll(resp.Body)
	var approveResult struct {
		ApplicationID int64  `json:"application_id"`
		Status        string `json:"status"`
		OrgID         int64  `json:"org_id"`
		AdminUsername string `json:"admin_username"`
		MagicLinkURL  string `json:"magic_link_url"`
	}
	_ = json.Unmarshal(respBody, &approveResult)
	log.Printf("✓ Application approved! OrgID=%d, AdminUsername=%s", approveResult.OrgID, approveResult.AdminUsername)

	// ── TEST 5: Verify Data Plane Database Provisioning State ──
	log.Println("\n[TEST 5] Verifying Provisioning State inside Data Plane DB...")
	if approveResult.OrgID == 0 {
		log.Fatalf("FAILED: Provisioning did not return a valid OrgID")
	}

	// 5a. Organization exists
	var orgName string
	err = dbConn.QueryRowContext(ctx, "SELECT name FROM organizations WHERE id = $1", approveResult.OrgID).Scan(&orgName)
	if err != nil {
		log.Fatalf("FAILED: organizations record missing: %v", err)
	}
	log.Printf("  ✓ Organization provisioned: %s (ID: %d)", orgName, approveResult.OrgID)

	// 5b. Admin user exists
	var userRole string
	err = dbConn.QueryRowContext(ctx, "SELECT role FROM users WHERE org_id = $1 AND role = 'admin'", approveResult.OrgID).Scan(&userRole)
	if err != nil || userRole != "admin" {
		log.Fatalf("FAILED: admin user record missing: %v", err)
	}
	log.Printf("  ✓ Tenant admin user provisioned with role: %s", userRole)

	// 5c. Client Organization Approval exists
	var clientApprovalStatus string
	err = dbConn.QueryRowContext(ctx, "SELECT status FROM client_organization_approvals WHERE org_id = $1 AND client_id = $2", approveResult.OrgID, clientID).Scan(&clientApprovalStatus)
	if err != nil || clientApprovalStatus != "approved" {
		log.Fatalf("FAILED: client_organization_approvals record missing or status=%s: %v", clientApprovalStatus, err)
	}
	log.Printf("  ✓ Client Board approval granted: status=%s", clientApprovalStatus)

	// 5d. Organization Exam Subscriptions exist
	var subCount int64
	err = dbConn.QueryRowContext(ctx, "SELECT COUNT(*) FROM organization_exam_subscriptions WHERE org_id = $1 AND status = 'approved'", approveResult.OrgID).Scan(&subCount)
	if err != nil || subCount == 0 {
		log.Fatalf("FAILED: organization_exam_subscriptions not created (count=%d): %v", subCount, err)
	}
	log.Printf("  ✓ Exam catalog subscriptions automatically active: %d exam(s)", subCount)

	// 5e. Wallet exists
	var walletBal int64
	err = dbConn.QueryRowContext(ctx, "SELECT balance_paise FROM wallets WHERE org_id = $1", approveResult.OrgID).Scan(&walletBal)
	if err != nil {
		log.Fatalf("FAILED: wallet record missing: %v", err)
	}
	log.Printf("  ✓ Wallet provisioned with balance: %d paise", walletBal)

	// ── TEST 6: Federated Dashboard Telemetry Check ──
	log.Println("\n[TEST 6] Testing SuperAdmin Federated Dashboard (/api/superadmin/dashboard)...")
	var superUserID int64
	err = dbConn.QueryRowContext(ctx, "SELECT id FROM platform_users WHERE username = 'super'").Scan(&superUserID)
	if err != nil {
		err = dbConn.QueryRowContext(ctx, `
			INSERT INTO platform_users(username, password_hash, role, display_name)
			VALUES('super', '$2a$10$dummyhashplaceholder', 'superadmin', 'Super Admin')
			RETURNING id`,
		).Scan(&superUserID)
		if err != nil {
			log.Fatalf("failed to insert platform super user: %v", err)
		}
	}

	superToken, _ := cpJWT.Issue(auth.Claims{
		UserID:   superUserID,
		Username: "super",
		Role:     "superadmin",
	})
	req, _ = http.NewRequest("GET", cpHTTP.URL+"/api/superadmin/dashboard", nil)
	req.Header.Set("Authorization", "Bearer "+superToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		log.Fatalf("FAILED /api/superadmin/dashboard: status=%v err=%v", resp.StatusCode, err)
	}
	respBody, _ = io.ReadAll(resp.Body)
	var dashResp struct {
		Summary struct {
			TotalClients   int `json:"total_clients"`
			HealthyClients int `json:"healthy_clients"`
		} `json:"summary"`
		Clients []struct {
			ID          int64  `json:"id"`
			Name        string `json:"name"`
			IsReachable bool   `json:"is_reachable"`
		} `json:"clients"`
	}
	_ = json.Unmarshal(respBody, &dashResp)
	log.Printf("✓ Federated Dashboard fan-out succeeded! HealthyClients=%d/%d", dashResp.Summary.HealthyClients, dashResp.Summary.TotalClients)

	log.Println("\n==================================================")
	log.Println("🎉 ALL MULTI-TENANT E2E CHECKS PASSED (100% SUCCESS)")
	log.Println("==================================================")
}

func int64Ptr(v int64) *int64 {
	return &v
}
