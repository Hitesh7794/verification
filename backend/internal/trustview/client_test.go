package trustview

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// mustNew constructs a Client aimed at the given test server. Token is
// non-empty so we never fall into the "no token" preflight path.
func mustNew(base string) *Client {
	return New(Config{BaseURL: base, Token: "test-token"})
}

func TestCompareHappyPathFace(t *testing.T) {
	var seen atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Add(1)
		if r.Method != "POST" || r.URL.Path != "/api/v1/ext/compare" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("wrong Authorization %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("wrong Content-Type %q", got)
		}
		var body comparePayload
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body.Modality != "face" {
			t.Errorf("modality = %q", body.Modality)
		}
		if body.Image1.Data == "" || body.Image2.Data == "" {
			t.Errorf("missing image data")
		}
		if body.Image1.Format != "" || body.Image2.Format != "" {
			t.Errorf("face should not carry fp format")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"matched":true,"score":71.5,"modality":"face","engine":"iiv","raw":{"iiv_similarity":0.812}}`)
	}))
	defer srv.Close()

	res, err := mustNew(srv.URL).Compare(context.Background(),
		Face, []byte("probe-bytes"), nil, []byte("gallery-bytes"), nil, nil)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
	if !res.Matched || res.Score != 71.5 || res.Engine != "iiv" {
		t.Errorf("bad result: %+v", res)
	}
	if got, _ := res.Raw["iiv_similarity"].(float64); got != 0.812 {
		t.Errorf("raw score not preserved: %v", res.Raw)
	}
	if seen.Load() != 1 {
		t.Errorf("expected 1 call, got %d", seen.Load())
	}
}

func TestCompareFingerprintFormatDefaulting(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body comparePayload
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Image1.Format != "iso" || body.Image2.Format != "iso" {
			t.Errorf("expected default format=iso, got %q / %q", body.Image1.Format, body.Image2.Format)
		}
		if body.Threshold == nil || *body.Threshold != 0.6 {
			t.Errorf("threshold not passed through: %+v", body.Threshold)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"matched":true,"score":60,"modality":"fingerprint","engine":"sourceafis"}`)
	}))
	defer srv.Close()

	thr := 0.6
	_, err := mustNew(srv.URL).Compare(context.Background(),
		Fingerprint, []byte("p"), nil, []byte("g"), nil, &thr)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
}

func TestCompareFingerprintImageAddsDPI(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body comparePayload
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Image1.Format != "image" || body.Image1.DPI != 500 {
			t.Errorf("expected image+dpi500 on image1, got %+v", body.Image1)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"matched":false,"score":10,"modality":"fingerprint","engine":"sourceafis"}`)
	}))
	defer srv.Close()

	imgFmt := FormatImage
	_, err := mustNew(srv.URL).Compare(context.Background(),
		Fingerprint, []byte("p"), &imgFmt, []byte("g"), &imgFmt, nil)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
}

func TestCompareIrisDropsThreshold(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body comparePayload
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Threshold != nil {
			t.Errorf("iris must ignore threshold, got %+v", body.Threshold)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"matched":true,"score":80,"modality":"iris","engine":"openiris"}`)
	}))
	defer srv.Close()

	thr := 0.6
	if _, err := mustNew(srv.URL).Compare(context.Background(),
		Iris, []byte("p"), nil, []byte("g"), nil, &thr); err != nil {
		t.Fatalf("Compare: %v", err)
	}
}

func TestCompareRateLimitHonoursRetryAfter(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := attempts.Add(1)
		if n < 3 {
			w.Header().Set("Retry-After", "1")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			fmt.Fprint(w, `{"error":"rate limited","code":"rate_limited"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"matched":true,"score":75,"modality":"face","engine":"iiv"}`)
	}))
	defer srv.Close()

	// Cap the test at 5 s so a bug in the backoff loop trips a failure
	// instead of hanging the test binary.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	start := time.Now()
	res, err := mustNew(srv.URL).Compare(ctx, Face,
		[]byte("p"), nil, []byte("g"), nil, nil)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
	if !res.Matched {
		t.Errorf("bad result: %+v", res)
	}
	if attempts.Load() != 3 {
		t.Errorf("expected 3 attempts, got %d", attempts.Load())
	}
	// Two Retry-After: 1s each; jitter <100ms. Should be ~2s, definitely
	// under 5s. Guard on a lower bound so we know Retry-After was honoured.
	if elapsed := time.Since(start); elapsed < 1500*time.Millisecond {
		t.Errorf("finished too fast — Retry-After not honoured (%s)", elapsed)
	}
}

func TestCompareTokenExpired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"token has expired","code":"token_expired"}`)
	}))
	defer srv.Close()

	_, err := mustNew(srv.URL).Compare(context.Background(), Face,
		[]byte("p"), nil, []byte("g"), nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("wrong error type: %T", err)
	}
	if e.Kind != KindTokenExpired || e.Code != "token_expired" || e.HTTP != 401 {
		t.Errorf("wrong classification: %+v", e)
	}
}

func TestCompareNoFace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		fmt.Fprint(w, `{"error":"no face detected","code":"no_face"}`)
	}))
	defer srv.Close()

	_, err := mustNew(srv.URL).Compare(context.Background(), Face,
		[]byte("p"), nil, []byte("g"), nil, nil)
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindNoFace {
		t.Fatalf("expected KindNoFace, got %+v", err)
	}
}

func TestCompareEngineBusyRetriesThenGivesUp(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":"engine busy","code":"engine_busy"}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := mustNew(srv.URL).Compare(ctx, Face,
		[]byte("p"), nil, []byte("g"), nil, nil)
	if err == nil {
		t.Fatal("expected engine_busy error after retries")
	}
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindEngineBusy {
		t.Fatalf("wrong error: %+v", err)
	}
	if attempts.Load() != 3 {
		t.Errorf("expected 3 attempts (max), got %d", attempts.Load())
	}
}

func TestCompareBadRequestNotRetried(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":"bad payload","code":"bad_payload"}`)
	}))
	defer srv.Close()

	_, err := mustNew(srv.URL).Compare(context.Background(), Face,
		[]byte("p"), nil, []byte("g"), nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if attempts.Load() != 1 {
		t.Errorf("400s must not be retried, got %d attempts", attempts.Load())
	}
}

func TestCompareRejectsMissingToken(t *testing.T) {
	c := New(Config{BaseURL: "http://127.0.0.1:0", Token: ""})
	_, err := c.Compare(context.Background(), Face,
		[]byte("p"), nil, []byte("g"), nil, nil)
	if err == nil {
		t.Fatal("expected NoToken error")
	}
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindNoToken {
		t.Errorf("wrong error: %+v", err)
	}
}

func TestCompareRejectsEmptyPayloads(t *testing.T) {
	c := mustNew("http://127.0.0.1:0")
	if _, err := c.Compare(context.Background(), Face, nil, nil, []byte("g"), nil, nil); err == nil {
		t.Error("expected error for empty probe")
	}
	if _, err := c.Compare(context.Background(), Face, []byte("p"), nil, nil, nil, nil); err == nil {
		t.Error("expected error for empty gallery")
	}
}

func TestBase64Encoding(t *testing.T) {
	// Regression: ensure we send base64 and not raw bytes / hex.
	var body comparePayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"matched":true,"score":80,"modality":"face","engine":"iiv"}`)
	}))
	defer srv.Close()

	probe := []byte{0x00, 0xFF, 0x42}
	if _, err := mustNew(srv.URL).Compare(context.Background(), Face,
		probe, nil, []byte("gg"), nil, nil); err != nil {
		t.Fatal(err)
	}
	got, err := base64.StdEncoding.DecodeString(body.Image1.Data)
	if err != nil {
		t.Fatalf("image1.data not valid base64: %v", err)
	}
	if string(got) != string(probe) {
		t.Errorf("round-trip mismatch: %x vs %x", got, probe)
	}
	if strings.Contains(body.Image1.Data, "\n") {
		t.Errorf("unexpected newline in base64 payload")
	}
}

func TestClassifyMappings(t *testing.T) {
	cases := []struct {
		status int
		code   string
		want   ErrorKind
	}{
		{401, "token_expired", KindTokenExpired},
		{401, "token_disabled", KindTokenDisabled},
		{401, "unauthorized", KindUnauthorized},
		{403, "modality_not_allowed", KindNotAllowed},
		{413, "payload_too_large", KindPayloadTooBig},
		{422, "no_face", KindNoFace},
		{429, "rate_limited", KindRateLimit},
		{429, "too_many_attempts", KindTooMany},
		{503, "engine_busy", KindEngineBusy},
		{503, "modality_unavailable", KindUnavail},
		{500, "match_failed", KindServer},
	}
	for _, c := range cases {
		if got := classify(c.status, c.code); got != c.want {
			t.Errorf("classify(%d,%q) = %q, want %q", c.status, c.code, got, c.want)
		}
	}
}
