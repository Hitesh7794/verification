package api

import (
	"net/http"
	"net/http/httptest"
	"os"
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

// Tests for the admin Downloads page backend (download_handlers.go).
//
// Headline concerns:
//   1. Multi-tenant isolation — admin A's "last download" entry must
//      never leak into admin B's manifest view.
//   2. Manifest correctness — SHA256 / size / version_from_filename
//      match the file on disk.
//   3. Audit suppression for Range resumes — flaky network resumes
//      must NOT create one audit row per chunk.
//   4. 404 contract — an empty DOWNLOADS_DIR returns 404 on the
//      download endpoint and an empty `items` array on the manifest.

// downloadsServer wires a single-tenant server with a DownloadsDir set
// to a fresh temp dir. Helper drops a small fake .zip in that dir if
// `bundleBytes` is non-nil. Returns the server, the admin's JWT, the
// admin's org_id, and the absolute downloads dir.
func downloadsServer(t *testing.T, bundleName string, bundleBytes []byte) (s *Server, adminTok string, orgID int64, dlDir string) {
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

	dlDir = filepath.Join(tmp, "downloads")
	if err := os.MkdirAll(dlDir, 0o755); err != nil {
		t.Fatalf("mkdir downloads: %v", err)
	}
	if bundleName != "" && bundleBytes != nil {
		if err := os.WriteFile(filepath.Join(dlDir, bundleName), bundleBytes, 0o644); err != nil {
			t.Fatalf("write bundle: %v", err)
		}
	}

	jwt := auth.NewJWTService("test-secret", time.Hour)
	cfg := config.Config{
		HTTPAddr:                ":0",
		JWTSecret:               "test-secret",
		ArtifactRetention:       "metadata",
		ArtifactDir:             filepath.Join(tmp, "artifacts"),
		DownloadsDir:            dlDir,
	}
	s = NewServer(Deps{DB: d, Index: idx, JWT: jwt, Cfg: cfg})

	// One org, one admin.
	res, _ := s.deps.DB.Exec(`INSERT INTO organizations(code, name) VALUES('TEST', 'Test University')`)
	orgID, _ = res.LastInsertId()
	hash, _ := bcrypt.GenerateFromPassword([]byte("admin"), bcrypt.MinCost)
	ures, _ := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
		 VALUES('admin', ?, 'admin', ?, 'Admin', CURRENT_TIMESTAMP)`,
		string(hash), orgID,
	)
	adminID, _ := ures.LastInsertId()
	tok, err := jwt.Issue(auth.Claims{UserID: adminID, Username: "admin", Role: "admin", OrgID: &orgID})
	if err != nil {
		t.Fatalf("issue jwt: %v", err)
	}
	return s, tok, orgID, dlDir
}

func TestDownloadsManifest_EmptyDir(t *testing.T) {
	s, tok, _, _ := downloadsServer(t, "", nil)
	code, body := doJSON(t, s, "GET", "/api/downloads", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%v", code, body)
	}
	items, _ := body["items"].([]any)
	if len(items) != 0 {
		t.Errorf("items: want empty, got %d items", len(items))
	}
}

func TestDownloadsDownload_NotPublished(t *testing.T) {
	s, tok, _, _ := downloadsServer(t, "", nil)
	code, _ := doJSON(t, s, "GET", "/api/downloads/operator-client", tok, nil)
	if code != http.StatusNotFound {
		t.Fatalf("want 404 when no bundle, got %d", code)
	}
}

func TestDownloadsManifest_WithBundle(t *testing.T) {
	payload := []byte("PK\x03\x04 — pretend zip bytes go here")
	s, tok, _, _ := downloadsServer(t, "VerificationPortalClient-2.3.4-windows.zip", payload)

	code, body := doJSON(t, s, "GET", "/api/downloads", tok, nil)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d body=%v", code, body)
	}
	items, _ := body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	item := items[0].(map[string]any)
	if item["filename"] != "VerificationPortalClient-2.3.4-windows.zip" {
		t.Errorf("filename: %v", item["filename"])
	}
	if item["version"] != "2.3.4" {
		t.Errorf("version: want 2.3.4, got %v", item["version"])
	}
	if int(item["size_bytes"].(float64)) != len(payload) {
		t.Errorf("size_bytes: want %d, got %v", len(payload), item["size_bytes"])
	}
	if sha, _ := item["sha256"].(string); len(sha) != 64 {
		t.Errorf("sha256 should be 64 hex chars, got %q", sha)
	}
}

func TestDownloadsDownload_FullGetAuditsOnce(t *testing.T) {
	payload := []byte("PK\x03\x04 hello world bytes")
	s, tok, orgID, _ := downloadsServer(t, "VerificationPortalClient-1.0.0-windows.zip", payload)

	// Full GET (no Range header).
	req := httptest.NewRequest("GET", "/api/downloads/operator-client", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("full GET want 200, got %d", rr.Code)
	}
	if !bytesEqual(rr.Body.Bytes(), payload) {
		t.Errorf("body mismatch: got %d bytes, want %d", rr.Body.Len(), len(payload))
	}
	if got := rr.Header().Get("X-Sha256"); len(got) != 64 {
		t.Errorf("X-SHA256 missing or wrong length: %q", got)
	}
	if cd := rr.Header().Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Errorf("Content-Disposition: want attachment, got %q", cd)
	}
	assertAuditCount(t, s, orgID, 1)
}

func TestDownloadsDownload_RangeResumeSuppressesAudit(t *testing.T) {
	payload := make([]byte, 4096)
	for i := range payload {
		payload[i] = byte(i)
	}
	s, tok, orgID, _ := downloadsServer(t, "VerificationPortalClient-1.0.0-windows.zip", payload)

	// Range resume mid-file (no admin-intent — just a resumed transfer).
	req := httptest.NewRequest("GET", "/api/downloads/operator-client", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Range", "bytes=2048-3071")
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusPartialContent {
		t.Fatalf("resume Range want 206, got %d", rr.Code)
	}
	assertAuditCount(t, s, orgID, 0)

	// Range starting at 0 SHOULD audit (some download managers always
	// use Range even on first fetch).
	req2 := httptest.NewRequest("GET", "/api/downloads/operator-client", nil)
	req2.RemoteAddr = "127.0.0.1:1234"
	req2.Header.Set("Authorization", "Bearer "+tok)
	req2.Header.Set("Range", "bytes=0-1023")
	rr2 := httptest.NewRecorder()
	s.Router().ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusPartialContent {
		t.Fatalf("Range=0- want 206, got %d", rr2.Code)
	}
	assertAuditCount(t, s, orgID, 1)
}

func TestDownloadsManifest_LastDownloadOrgIsolation(t *testing.T) {
	// Two admins in two orgs — A downloads, B's view should NOT see
	// A's last_download timestamp.
	payload := []byte("PK\x03\x04")
	s, tokA, orgIDA, dlDir := downloadsServer(t, "VerificationPortalClient-1.0.0-windows.zip", payload)

	// Seed a second org + admin manually on the same server.
	res, _ := s.deps.DB.Exec(`INSERT INTO organizations(code, name) VALUES('OTHER', 'Other University')`)
	orgIDB, _ := res.LastInsertId()
	hash, _ := bcrypt.GenerateFromPassword([]byte("admin"), bcrypt.MinCost)
	ures, _ := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
		 VALUES('adminB', ?, 'admin', ?, 'Admin B', CURRENT_TIMESTAMP)`,
		string(hash), orgIDB,
	)
	adminIDB, _ := ures.LastInsertId()
	tokB, _ := s.deps.JWT.Issue(auth.Claims{UserID: adminIDB, Username: "adminB", Role: "admin", OrgID: &orgIDB})

	_ = dlDir
	_ = orgIDA

	// Admin A downloads.
	req := httptest.NewRequest("GET", "/api/downloads/operator-client", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Authorization", "Bearer "+tokA)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("admin A download want 200, got %d", rr.Code)
	}

	// Admin B views the manifest — must NOT see A's last_download.
	_, bodyB := doJSON(t, s, "GET", "/api/downloads", tokB, nil)
	if _, hasLast := bodyB["last_download"]; hasLast {
		t.Errorf("admin B sees admin A's last_download: %v", bodyB["last_download"])
	}

	// Admin A's manifest SHOULD show last_download.
	_, bodyA := doJSON(t, s, "GET", "/api/downloads", tokA, nil)
	if _, hasLast := bodyA["last_download"]; !hasLast {
		t.Errorf("admin A should see own last_download: %v", bodyA)
	}
}

// Client (operator) role must be able to download the installer
// self-serve — that's the whole point of opening this beyond admin.
// Same artefact, same org-scoped audit, just a different role hitting
// the endpoint.
func TestDownloadsDownload_ClientRoleCanDownload(t *testing.T) {
	payload := []byte("PK\x03\x04 operator bytes")
	s, _, orgID, _ := downloadsServer(t, "VerificationPortalClient-1.0.0-windows.zip", payload)

	// Seed a client operator in the same org as the admin the helper
	// created. Post migration 021 there's no centre column.
	hash, _ := bcrypt.GenerateFromPassword([]byte("op"), bcrypt.MinCost)
	ores, _ := s.deps.DB.Exec(
		`INSERT INTO users(username, password_hash, password_plaintext, role,
		                   org_id, display_name, activated_at)
		 VALUES('op', ?, 'op', 'client', ?, 'Centre Operator', CURRENT_TIMESTAMP)`,
		string(hash), orgID,
	)
	opID, _ := ores.LastInsertId()
	cliTok, _ := s.deps.JWT.Issue(auth.Claims{
		UserID: opID, Username: "op", Role: "client", OrgID: &orgID,
	})

	// Manifest as client — must succeed.
	mcode, mbody := doJSON(t, s, "GET", "/api/downloads", cliTok, nil)
	if mcode != http.StatusOK {
		t.Fatalf("client manifest want 200, got %d body=%v", mcode, mbody)
	}
	items, _ := mbody["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("client manifest items: want 1, got %d", len(items))
	}

	// Stream download as client.
	req := httptest.NewRequest("GET", "/api/downloads/operator-client", nil)
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Authorization", "Bearer "+cliTok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("client download want 200, got %d", rr.Code)
	}
	if !bytesEqual(rr.Body.Bytes(), payload) {
		t.Errorf("client got wrong bytes: %d vs %d", rr.Body.Len(), len(payload))
	}

	// Audit row exists for the client's download.
	var n int
	_ = s.deps.DB.QueryRow(
		`SELECT COUNT(*) FROM audit_log
		 WHERE action='downloads.operator_client.get'
		   AND org_id=? AND actor_role='client'`, orgID,
	).Scan(&n)
	if n != 1 {
		t.Errorf("expected 1 client-role audit row, got %d", n)
	}
}

func TestParseVersionFromFilename(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"VerificationPortalClient-1.0.0-windows.zip", "1.0.0"},
		{"OperatorPortalSetup-2.3.4.exe", "2.3.4"},
		{"OperatorPortalSetup-2.3.4.msi", "2.3.4"},
		{"OperatorPortalSetup-10.0.0-rc1.exe", "10.0.0"},
		{"no_version_here.zip", ""},
		{"", ""},
	}
	for _, tc := range cases {
		got := parseVersionFromFilename(tc.in)
		if got != tc.want {
			t.Errorf("parseVersionFromFilename(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// assertAuditCount queries audit_log for download events scoped to the
// given org and fails the test if the count diverges from `want`.
func assertAuditCount(t *testing.T, s *Server, orgID int64, want int) {
	t.Helper()
	var n int
	err := s.deps.DB.QueryRow(
		`SELECT COUNT(*) FROM audit_log
		 WHERE action='downloads.operator_client.get' AND org_id=?`, orgID,
	).Scan(&n)
	if err != nil {
		t.Fatalf("count audit: %v", err)
	}
	if n != want {
		t.Errorf("audit rows: want %d, got %d", want, n)
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
