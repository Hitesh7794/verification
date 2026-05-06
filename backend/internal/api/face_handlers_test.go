package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
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
	"github.com/veni/neet-verification/internal/luxand"
)

// fakeLuxandSvc spins up a real httptest server that mimics the
// luxand-service envelopes. We feed it canned responses keyed by request
// method so a single test can exercise extract + match in sequence.
type fakeLuxandSvc struct {
	mu sync.Mutex

	// Behaviour knobs.
	noFaceOnExtract bool
	matchScore      float64
	matchThreshold  float64
	matchStatus     bool

	// Tracking.
	extractCalls int
	matchCalls   int
}

func (f *fakeLuxandSvc) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/face/extract", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.extractCalls++
		noFace := f.noFaceOnExtract
		f.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if noFace {
			fmt.Fprint(w, `{"ErrorCode":"0","ErrorDescription":"face not detected","FaceFound":false}`)
			return
		}
		// 1040 zero bytes for the template.
		tpl := make([]byte, 1040)
		fmt.Fprintf(w,
			`{"ErrorCode":"0","ErrorDescription":"OK","FaceFound":true,"Template":"%s"}`,
			base64.StdEncoding.EncodeToString(tpl))
	})
	mux.HandleFunc("/face/match-image", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.matchCalls++
		score := f.matchScore
		thr := f.matchThreshold
		st := f.matchStatus
		f.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w,
			`{"ErrorCode":"0","ErrorDescription":"OK","FaceFound":true,"Score":%f,"Threshold":%f,"Status":%t}`,
			score, thr, st)
	})
	return mux
}

func newFaceTestServer(t *testing.T) (*Server, string, string, *fakeLuxandSvc, func()) {
	t.Helper()

	tmp := t.TempDir()
	root := filepath.Join(tmp, "datatree", "GNDU27", "2026-01-01", "C001__Test Center")
	for _, sub := range []string{"photo", "iso", "fps"} {
		if err := os.MkdirAll(filepath.Join(root, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	roll := "10001"
	// Pretend-JPEG with a recognisable byte pattern.
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

	fake := &fakeLuxandSvc{
		matchScore:     0.82,
		matchThreshold: 0.7,
		matchStatus:    true,
	}
	httpSrv := httptest.NewServer(fake.handler())

	cfg := config.Config{
		HTTPAddr:                  ":0",
		JWTSecret:                 "test-secret",
		FPMatchThresholdDefault:   140,
		ArtifactRetention:         "metadata",
		ArtifactDir:               filepath.Join(tmp, "artifacts"),
		LuxandBase:                httpSrv.URL + "/face/",
		FaceTemplateDir:           filepath.Join(tmp, "face_templates"),
	}
	s := &Server{deps: Deps{DB: d, Index: idx, JWT: jwt, Cfg: cfg}}
	s.luxand = luxand.New(cfg.LuxandBase)

	var uid, orgID, centerID int64
	if err := d.QueryRow(`SELECT id, org_id, center_id FROM users WHERE username='client'`).
		Scan(&uid, &orgID, &centerID); err != nil {
		t.Fatal(err)
	}
	tok, err := jwt.Issue(auth.Claims{
		UserID: uid, Username: "client", Role: "client",
		OrgID: &orgID, CenterID: &centerID,
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
	if got["score"].(float64) < 0.8 {
		t.Errorf("score %v unexpected", got["score"])
	}
	// First call extracts (gallery cache miss) + matches.
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.extractCalls != 1 || fake.matchCalls != 1 {
		t.Errorf("expected 1 extract + 1 match, got %d / %d", fake.extractCalls, fake.matchCalls)
	}
}

func TestFaceMatchUsesGalleryCache(t *testing.T) {
	s, tok, roll, fake, cleanup := newFaceTestServer(t)
	defer cleanup()

	makeReq := func() {
		body, _ := json.Marshal(map[string]any{
			"roll_no":   roll,
			"image_b64": base64.StdEncoding.EncodeToString([]byte("fake")),
		})
		req := httptest.NewRequest("POST", "/api/face-match", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		rr := httptest.NewRecorder()
		s.Router().ServeHTTP(rr, req)
		if rr.Code != 200 {
			t.Fatalf("status %d body %s", rr.Code, rr.Body)
		}
	}
	makeReq()
	makeReq()
	makeReq()

	// First call: 1 extract (cache miss) + 1 match.
	// Subsequent calls: 0 extract + 1 match each.
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.extractCalls != 1 {
		t.Errorf("gallery extract should run once, got %d", fake.extractCalls)
	}
	if fake.matchCalls != 3 {
		t.Errorf("expected 3 match calls, got %d", fake.matchCalls)
	}

	// And the .tpl file should be on disk.
	tplPath := filepath.Join(s.deps.Cfg.FaceTemplateDir, roll+".tpl")
	if _, err := os.Stat(tplPath); err != nil {
		t.Errorf("cached gallery template not on disk: %v", err)
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

func TestFaceMatchFaceMissingInEnrollment(t *testing.T) {
	s, tok, roll, fake, cleanup := newFaceTestServer(t)
	defer cleanup()
	fake.mu.Lock()
	fake.noFaceOnExtract = true
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
		t.Errorf("expected 422, got %d body %s", rr.Code, rr.Body)
	}
}

func TestFaceTemplateEndpoint(t *testing.T) {
	s, tok, roll, _, cleanup := newFaceTestServer(t)
	defer cleanup()

	req := httptest.NewRequest("GET", "/api/candidates/"+roll+"/face-template", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rr := httptest.NewRecorder()
	s.Router().ServeHTTP(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body)
	}
	var got map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got["size_bytes"].(float64) != 1040 {
		t.Errorf("expected 1040-byte template, got %v", got["size_bytes"])
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
