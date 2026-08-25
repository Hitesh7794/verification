package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/data"
	"github.com/veni/neet-verification/internal/db"
)

// testServer wires a Server backed by a fresh sqlite DB, an in-memory data
// index seeded with one synthetic candidate, and a one-org/one-center/one-
// client user setup. Returns the server, the client's bearer token, and
// the candidate roll that has a fingerprint template on disk.
func testServer(t *testing.T) (s *Server, token, roll string, cleanup func()) {
	t.Helper()

	tmp := t.TempDir()

	// Synthetic enrolled candidate: photo (1-byte placeholder) and an FMR_V2005
	// template (8-byte FMR magic).
	root := filepath.Join(tmp, "datatree", "GNDU27", "2026-01-01", "C001__Test Center")
	for _, sub := range []string{"photo", "iso", "fps"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	roll = "10001"
	if err := os.WriteFile(filepath.Join(root, "photo", roll+".jpg"), []byte{0xFF, 0xD8, 0xFF, 0xD9}, 0o644); err != nil {
		t.Fatal(err)
	}
	tpl := []byte{'F', 'M', 'R', 0, ' ', '2', '0', 0, 0, 0, 0, 0}
	if err := os.WriteFile(filepath.Join(root, "iso", roll+".iso"), tpl, 0o644); err != nil {
		t.Fatal(err)
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://portal:portal-dev@127.0.0.1:5434/verification?sslmode=disable"
	}
	d, err := db.Open(dbURL)
	if err != nil {
		t.Skipf("skipping test: db connect (%s): %v", dbURL, err)
	}
	if err := db.Migrate(d); err != nil {
		t.Skipf("skipping test: db migrate: %v", err)
	}

	idx, err := data.LoadIndex(filepath.Join(tmp, "datatree"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Seed(d, idx); err != nil {
		t.Fatal(err)
	}

	jwt := auth.NewJWTService("test-secret", time.Hour)
	cfg := config.Config{
		HTTPAddr:                ":0",
		DatabaseURL:             "",
		JWTSecret:               "test-secret",
		ArtifactDir:             filepath.Join(tmp, "artifacts"),
	}

	s = NewServer(Deps{DB: d, Index: idx, JWT: jwt, Cfg: cfg})

	// Mint a token for the seeded "client" user (operator_id=3 from the seed
	// order: super=1, admin=2, client=3). Resolve it dynamically to avoid
	// relying on autoincrement order.
	var (
		uid int64
	)
	if err := d.QueryRow(`SELECT id FROM users WHERE username='client'`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	var orgID int64
	if err := d.QueryRow(db.Q(`SELECT org_id FROM users WHERE id=?`), uid).Scan(&orgID); err != nil {
		t.Fatal(err)
	}
	tok, err := jwt.Issue(auth.Claims{
		UserID: uid, Username: "client", Role: "client",
		OrgID: &orgID,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Phase 3a — the operator's roll lookup now goes through
	// exam_candidates JOIN operator_exams. Seed a client + exam +
	// exam_candidate for the test roll and assign it to the operator
	// so every test that uses this fixture keeps working. Photos and
	// templates still live on the filesystem (legacy artifact path).
	if _, err := d.Exec(`INSERT INTO clients(name, notes) VALUES('Test Board', 'seed')`); err != nil {
		t.Fatal(err)
	}
	var clientRowID int64
	if err := d.QueryRow(`SELECT id FROM clients ORDER BY id DESC LIMIT 1`).Scan(&clientRowID); err != nil {
		t.Fatal(err)
	}
	examCode := fmt.Sprintf("TEST-EXAM-%d", time.Now().UnixNano())
	var examID int64
	if err := d.QueryRow(db.Q(`
		INSERT INTO exams(client_id, name, exam_code, verification_from, verification_to)
		VALUES(?, 'Test Exam', ?, '2020-01-01', '2099-12-31')
		RETURNING id`),
		clientRowID, examCode).Scan(&examID); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(db.Q(`
		INSERT INTO exam_candidates(exam_id, roll_no, name, verification_date)
		VALUES(?, ?, 'Test Candidate', '2026-06-01')`), examID, roll); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(db.Q(`
		INSERT INTO organization_exam_subscriptions(org_id, exam_id, subscribed_by)
		VALUES(?, ?, ?)`), orgID, examID, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(db.Q(`DELETE FROM operator_exams WHERE user_id=?`), uid); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(db.Q(`
		INSERT INTO operator_exams(user_id, exam_id) VALUES(?, ?)`),
		uid, examID); err != nil {
		t.Fatal(err)
	}

	cleanup = func() { d.Close() }
	return s, tok, roll, cleanup
}

func TestGetCandidateExposesTemplateFormat(t *testing.T) {
	s, tok, roll, cleanup := testServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/api/candidates/"+roll, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body)
	}
	var got map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got["fp_template_format"] != "FMR_V2005" {
		t.Errorf("fp_template_format = %v, want FMR_V2005", got["fp_template_format"])
	}
}

func TestFPTemplateEndpoint(t *testing.T) {
	s, tok, roll, cleanup := testServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/api/candidates/"+roll+"/fp-template", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body)
	}
	var got map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["format"] != "FMR_V2005" {
		t.Errorf("format = %v", got["format"])
	}
	b64, ok := got["template_b64"].(string)
	if !ok || b64 == "" {
		t.Fatalf("template_b64 missing")
	}
	dec, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !bytes.HasPrefix(dec, []byte{'F', 'M', 'R', 0}) {
		t.Errorf("decoded template has wrong magic")
	}
}

func TestFPTemplateMissingCandidate(t *testing.T) {
	s, tok, _, cleanup := testServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/api/candidates/99999/fp-template", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != 404 {
		t.Errorf("expected 404, got %d", rr.Code)
	}
}

func TestCreateVerificationWithBiometricScores(t *testing.T) {
	s, tok, roll, cleanup := testServer(t)
	defer cleanup()

	body := map[string]any{
		"roll_no":            roll,
		"status":             "verified",
		"face_match":         true,
		"fp_match":           true,
		"device_serial":      "SN12345",
		"device_model":       "MFS500",
		"fp_template_format": "FMR_V2005",
		"fp_quality":         82,
		"fp_nfiq":            2,
		"fp_match_score":     74,
		"fp_liveness":        1,
		"via":                "fingerprint",
		"match_threshold":    60,
		"decision_ms":        4321,
		"client_app_version": "1.0.0",
		"idempotency_key":    "550e8400-e29b-41d4-a716-446655440000",
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/api/verifications", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status %d body %s", rr.Code, rr.Body)
	}

	// Replay must return the same id with X-Idempotent-Replay header.
	req2 := httptest.NewRequest("POST", "/api/verifications", bytes.NewReader(b))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Authorization", "Bearer "+tok)
	rr2 := httptest.NewRecorder()
	s.Router().ServeHTTP(rr2, req2)

	if rr2.Code != http.StatusOK {
		t.Fatalf("replay status %d body %s", rr2.Code, rr2.Body)
	}
	if rr2.Header().Get("X-Idempotent-Replay") != "true" {
		t.Errorf("missing X-Idempotent-Replay")
	}

	var first, second map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &first)
	_ = json.Unmarshal(rr2.Body.Bytes(), &second)
	if fmt.Sprint(first["id"]) != fmt.Sprint(second["id"]) {
		t.Errorf("replay returned different id: %v vs %v", first["id"], second["id"])
	}

	// Verify the row actually has the score fields populated.
	var quality, nfiq, score int
	if err := s.deps.DB.QueryRow(
		`SELECT fp_quality, fp_nfiq, fp_match_score FROM verifications WHERE id=?`, first["id"],
	).Scan(&quality, &nfiq, &score); err != nil {
		t.Fatalf("readback: %v", err)
	}
	if quality != 82 || nfiq != 2 || score != 74 {
		t.Errorf("scores not stored: q=%d nfiq=%d score=%d", quality, nfiq, score)
	}
}

func TestCreateVerificationRejectsBadVia(t *testing.T) {
	s, tok, roll, cleanup := testServer(t)
	defer cleanup()

	body := map[string]any{
		"roll_no": roll,
		"status":  "verified",
		"via":     "telepathy",
	}
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/verifications", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body %s", rr.Code, rr.Body)
	}
}

func TestUploadArtifactStoresMetadata(t *testing.T) {
	s, tok, roll, cleanup := testServer(t)
	defer cleanup()

	// First create a verification to attach to.
	body, _ := json.Marshal(map[string]any{
		"roll_no": roll, "status": "verified",
	})
	req := httptest.NewRequest("POST", "/api/verifications", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body)
	}
	var created map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &created)
	verID := fmt.Sprint(created["id"])

	// Build a multipart upload.
	payload := []byte("fake jpeg bytes")
	wantSHA := hex.EncodeToString(sha256.New().Sum(nil)[:0]) // placeholder
	{
		h := sha256.New()
		h.Write(payload)
		wantSHA = hex.EncodeToString(h.Sum(nil))
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("kind", "captured_face")
	fw, _ := mw.CreateFormFile("file", "face.jpg")
	fw.Write(payload)
	mw.Close()

	req2 := httptest.NewRequest("POST", "/api/verifications/"+verID+"/artifacts", &buf)
	req2.Header.Set("Content-Type", mw.FormDataContentType())
	req2.Header.Set("Authorization", "Bearer "+tok)
	rr2 := httptest.NewRecorder()
	s.Router().ServeHTTP(rr2, req2)

	if rr2.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rr2.Code, rr2.Body)
	}

	var got map[string]any
	_ = json.Unmarshal(rr2.Body.Bytes(), &got)
	if got["sha256"] != wantSHA {
		t.Errorf("sha256 = %v, want %v", got["sha256"], wantSHA)
	}
}

func TestUploadArtifactRejectsBadKind(t *testing.T) {
	s, tok, roll, cleanup := testServer(t)
	defer cleanup()

	body, _ := json.Marshal(map[string]any{"roll_no": roll, "status": "verified"})
	req := httptest.NewRequest("POST", "/api/verifications", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	var created map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &created)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("kind", "selfie")
	fw, _ := mw.CreateFormFile("file", "x.bin")
	io.WriteString(fw, "x")
	mw.Close()

	req2 := httptest.NewRequest("POST", "/api/verifications/"+fmt.Sprint(created["id"])+"/artifacts", &buf)
	req2.Header.Set("Content-Type", mw.FormDataContentType())
	req2.Header.Set("Authorization", "Bearer "+tok)
	rr2 := httptest.NewRecorder()
	s.Router().ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr2.Code)
	}
}

func TestGetCandidateFutureWindowReturnsReminder(t *testing.T) {
	s, tok, roll, cleanup := testServer(t)
	defer cleanup()

	// Update exam to have a future verification window
	if _, err := s.deps.DB.Exec(`UPDATE exams SET verification_from = '2099-01-01', verification_to = '2099-12-31'`); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/api/candidates/"+roll, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden, got %d (body: %s)", rr.Code, rr.Body)
	}
	var got map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got["code"] != "EXAM_WINDOW_FUTURE" {
		t.Errorf("code = %v, want EXAM_WINDOW_FUTURE", got["code"])
	}
	if vFrom, ok := got["verification_from"].(string); !ok || !strings.HasPrefix(vFrom, "2099-01-01") {
		t.Errorf("verification_from = %v, want prefix 2099-01-01", got["verification_from"])
	}
}

