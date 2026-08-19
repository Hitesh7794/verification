package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/veni/neet-verification/internal/auth"
	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/data"
	"github.com/veni/neet-verification/internal/db"
	"github.com/veni/neet-verification/internal/trustview"
)

// fakeTrustViewSvc spins up an httptest server that speaks the TrustView
// compare wire shape. We feed it a canned envelope so a single test can
// drive multiple face-match calls with predictable results.
//
// Replaced fakeLuxandSvc as part of the Aug 2026 TrustView migration:
// hosted matcher, no on-prem template extraction / caching step, no
// LuxandBase config. The handler now sends raw gallery + probe JPEG
// bytes end-to-end.
type fakeTrustViewSvc struct {
	mu sync.Mutex

	// Behaviour knobs.
	nextStatus int          // HTTP status to reply with (default 200)
	nextBody   any          // JSON body (compareOK or compareErr, marshalled)
	nextCode   string       // stable slug for non-200 responses

	// Match happy-path defaults (unified 0..100, 50 = threshold).
	score   float64
	matched bool

	// Tracking.
	calls int
}

func (f *fakeTrustViewSvc) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/ext/compare", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls++
		w.Header().Set("Content-Type", "application/json")

		if f.nextStatus != 0 && f.nextStatus != 200 {
			w.WriteHeader(f.nextStatus)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": "canned test error",
				"code":  f.nextCode,
			})
			return
		}

		body := f.nextBody
		if body == nil {
			body = map[string]any{
				"matched":  f.matched,
				"score":    f.score,
				"modality": "face",
				"engine":   "iiv",
				"raw":      map[string]any{"similarity": 0.9},
			}
		}
		_ = json.NewEncoder(w).Encode(body)
	})
	return mux
}

func newFaceTestServer(t *testing.T) (*Server, string, string, *fakeTrustViewSvc, func()) {
	t.Helper()

	tmp := t.TempDir()
	root := filepath.Join(tmp, "datatree", "GNDU27", "2026-01-01", "C001__Test Center")
	for _, sub := range []string{"photo", "iso", "fps"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	roll := "10001"
	// Minimal valid-ish JPEG (the fake TrustView never actually decodes it).
	if err := os.WriteFile(filepath.Join(root, "photo", roll+".jpg"),
		[]byte{0xFF, 0xD8, 0xFF, 0xD9}, 0o644); err != nil {
		t.Fatal(err)
	}
	tpl := []byte{'F', 'M', 'R', 0, ' ', '2', '0', 0, 0, 0, 0, 0}
	if err := os.WriteFile(filepath.Join(root, "iso", roll+".iso"), tpl, 0o644); err != nil {
		t.Fatal(err)
	}

	d, err := db.Open(filepath.Join(tmp, "v.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	idx, err := data.LoadIndex(filepath.Join(tmp, "datatree"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Seed(d, idx); err != nil {
		t.Fatal(err)
	}

	jwt := auth.NewJWTService("test-secret", time.Hour)

	fake := &fakeTrustViewSvc{
		score:   85, // safely above threshold
		matched: true,
	}
	httpSrv := httptest.NewServer(fake.handler())

	cfg := config.Config{
		HTTPAddr:          ":0",
		JWTSecret:         "test-secret",
		ArtifactDir:       filepath.Join(tmp, "artifacts"),
		TrustViewBaseURL:  httpSrv.URL,
		TrustViewToken:    "tvx_test_token",
	}
	s := &Server{deps: Deps{DB: d, Index: idx, JWT: jwt, Cfg: cfg}}
	s.trustview = trustview.New(trustview.Config{
		BaseURL: cfg.TrustViewBaseURL,
		Token:   cfg.TrustViewToken,
	})

	var uid, orgID int64
	if err := d.QueryRow(`SELECT id, org_id FROM users WHERE username='client'`).
		Scan(&uid, &orgID); err != nil {
		t.Fatal(err)
	}
	tok, err := jwt.Issue(auth.Claims{
		UserID: uid, Username: "client", Role: "client",
		OrgID: &orgID,
	})
	if err != nil {
		t.Fatal(err)
	}

	cleanup := func() {
		httpSrv.Close()
		d.Close()
	}
	return s, tok, roll, fake, cleanup
}

func TestFaceMatchHappyPath(t *testing.T) {
	s, tok, roll, fake, cleanup := newFaceTestServer(t)
	defer cleanup()

	body, _ := json.Marshal(map[string]any{
		"roll_no":   roll,
		"image_b64": base64.StdEncoding.EncodeToString([]byte("fake-live-jpeg")),
	})
	req := httptest.NewRequest("POST", "/api/face-match", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body)
	}
	var got map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got["status"] != true {
		t.Errorf("expected status true, got %v", got)
	}
	if got["score"].(float64) < 50 {
		t.Errorf("score %v below unified threshold", got["score"])
	}
	// Exactly one call to TrustView per face-match request now — no
	// separate template-extract call.
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.calls != 1 {
		t.Errorf("expected 1 TrustView call, got %d", fake.calls)
	}
}

func TestFaceMatchNoFace(t *testing.T) {
	s, tok, roll, fake, cleanup := newFaceTestServer(t)
	defer cleanup()
	fake.mu.Lock()
	fake.nextStatus = 422
	fake.nextCode = "no_face"
	fake.mu.Unlock()

	body, _ := json.Marshal(map[string]any{
		"roll_no":   roll,
		"image_b64": base64.StdEncoding.EncodeToString([]byte("x")),
	})
	req := httptest.NewRequest("POST", "/api/face-match", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusUnprocessableEntity {
		t.Errorf("expected 422 on no_face, got %d body %s", rr.Code, rr.Body)
	}
}

func TestFaceMatchUnknownCandidate(t *testing.T) {
	s, tok, _, _, cleanup := newFaceTestServer(t)
	defer cleanup()

	body, _ := json.Marshal(map[string]any{
		"roll_no":   "99999",
		"image_b64": base64.StdEncoding.EncodeToString([]byte("x")),
	})
	req := httptest.NewRequest("POST", "/api/face-match", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rr.Code)
	}
}

// TestFaceTemplateEndpoint verifies the deprecated /face-template
// endpoint returns 410 Gone (loud failure) instead of silently serving
// stale cached bytes after the TrustView migration retired server-side
// template extraction.
func TestFaceTemplateEndpoint(t *testing.T) {
	s, tok, roll, _, cleanup := newFaceTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/api/candidates/"+roll+"/face-template", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)

	if rr.Code != http.StatusGone {
		t.Fatalf("expected 410 Gone, got %d body %s", rr.Code, rr.Body)
	}
}

func TestDecodeDataURL(t *testing.T) {
	cases := []struct {
		in   string
		want []byte
	}{
		{"data:image/jpeg;base64,SGVsbG8=", []byte("Hello")},
		{"SGVsbG8=", []byte("Hello")},
		{"  SGVsbG8=  ", []byte("Hello")},
	}
	for _, c := range cases {
		got, err := decodeDataURL(c.in)
		if err != nil {
			t.Errorf("%q: err %v", c.in, err)
			continue
		}
		if !bytes.Equal(got, c.want) {
			t.Errorf("%q: got %s want %s", c.in, got, c.want)
		}
	}
}
