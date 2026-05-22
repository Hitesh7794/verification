// Package fpmatch is a thin HTTP client for the localhost fp-match-service.
//
// The service runs on the same Linux host as the Go backend (loopback only,
// 127.0.0.1:8050). Mirrors the luxand client almost exactly — same shape,
// same error taxonomy, same pattern — so the codebase stays uniform across
// biometric services.
package fpmatch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client wraps the localhost fp-match-service. Concurrency-safe: net/http
// handles connection pooling for us.
type Client struct {
	base string
	http *http.Client
}

func New(base string) *Client {
	if base == "" {
		base = "http://127.0.0.1:8050/fp/"
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return &Client{
		base: base,
		// SourceAFIS match latency is typically 10-30 ms; the Javalin hop
		// adds another ~10 ms. 5 seconds is plenty of headroom for slow
		// hosts (Apple Silicon emulated runs, cold JVM) without letting a
		// hung backend wedge a request thread forever.
		http: &http.Client{Timeout: 5 * time.Second},
	}
}

// Envelope mirrors the JSON shape every fp/* endpoint returns. Pointer
// fields distinguish "absent" from "zero" — important because a real
// Score of 0.0 means "totally different fingerprints," not "no result."
type Envelope struct {
	ErrorCode        string   `json:"ErrorCode"`
	ErrorDescription string   `json:"ErrorDescription"`
	Version          string   `json:"Version,omitempty"`
	Score            *float64 `json:"Score,omitempty"`
	Threshold        *float64 `json:"Threshold,omitempty"`
	Status           *bool    `json:"Status,omitempty"`
}

// ErrService is returned when the fp-match-service is unreachable. Distinct
// type so handlers can map it to a clean 503 instead of leaking the raw
// network error to the operator.
type ErrService struct{ Err error }

func (e *ErrService) Error() string { return "fp-match-service unreachable: " + e.Err.Error() }
func (e *ErrService) Unwrap() error { return e.Err }

// ErrSDK wraps a non-zero ErrorCode from the service (template unparseable,
// empty inputs, etc.).
type ErrSDK struct {
	Code        string
	Description string
}

func (e *ErrSDK) Error() string { return fmt.Sprintf("fp-match %s: %s", e.Code, e.Description) }

// MatchResult bundles everything we want to record on the verifications row
// after a successful match.
type MatchResult struct {
	Score     float64
	Threshold float64
	Status    bool
}

// Health returns the service's self-report. Used by /api/health and as a
// startup probe.
func (c *Client) Health(ctx context.Context) (*Envelope, error) {
	return c.post(ctx, "health", nil)
}

// Match takes two raw FMR/ANSI template byte slices, base64-encodes them,
// sends them to /fp/match, and returns the SourceAFIS similarity score and
// the server-side pass/fail flag.
func (c *Client) Match(ctx context.Context, probe, gallery []byte) (*MatchResult, error) {
	body := map[string]any{
		"ProbeTemplate":   base64.StdEncoding.EncodeToString(probe),
		"GalleryTemplate": base64.StdEncoding.EncodeToString(gallery),
	}
	env, err := c.post(ctx, "match", body)
	if err != nil {
		return nil, err
	}
	r := &MatchResult{}
	if env.Score != nil {
		r.Score = *env.Score
	}
	if env.Threshold != nil {
		r.Threshold = *env.Threshold
	}
	if env.Status != nil {
		r.Status = *env.Status
	}
	return r, nil
}

// post does a JSON POST and unwraps the envelope. Non-zero ErrorCode becomes
// ErrSDK; transport errors become ErrService.
func (c *Client) post(ctx context.Context, method string, body any) (*Envelope, error) {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.base+method, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &ErrService{Err: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("fp-match %s: HTTP %d: %s", method, resp.StatusCode, string(raw))
	}
	var env Envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return nil, err
	}
	if env.ErrorCode != "0" {
		return nil, &ErrSDK{Code: env.ErrorCode, Description: env.ErrorDescription}
	}
	return &env, nil
}
