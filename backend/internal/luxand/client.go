// Package luxand talks to the loopback luxand-service Java daemon for
// active-liveness checks. Face matching does NOT go through here — that
// moved to TrustView in the Aug 2026 migration. This client exists
// only for the /face/liveness endpoint that scores a short sequence of
// operator-webcam frames for anti-spoof.
package luxand

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client is safe to construct even when the BaseURL is unset —
// LivenessCheck will return ErrDisabled cleanly in that case so the
// caller can 503 without a nil-pointer panic.
type Client struct {
	baseURL string
	http    *http.Client
}

// Config carries just what the client needs. Kept separate from
// config.Config so tests can construct a client without pulling the
// whole app config.
type Config struct {
	BaseURL string
	Timeout time.Duration // per-request, default 20s (liveness has ~15-30 frames)
}

// New builds a client. A blank BaseURL is not an error at construction
// time — LivenessCheck decides how to fail for it.
func New(cfg Config) *Client {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	return &Client{
		baseURL: strings.TrimRight(cfg.BaseURL, "/"),
		http:    &http.Client{Timeout: timeout},
	}
}

// LivenessResult mirrors the JSON envelope /face/liveness returns.
// ErrorCode "0" means success; anything else is a service-side
// rejection (e.g. "-4" too few frames). Callers that want to
// discriminate should switch on ErrorCode; AllPassed is only trustworthy
// when ErrorCode == "0".
type LivenessResult struct {
	ErrorCode        string   `json:"ErrorCode"`
	ErrorDescription string   `json:"ErrorDescription"`
	FacesFound       int      `json:"FacesFound"`
	PassiveMean      float64  `json:"PassiveMean"`
	PassivePassed    bool     `json:"PassivePassed"`
	BlinksDetected   int      `json:"BlinksDetected"`
	ChallengesPassed []string `json:"ChallengesPassed"`
	AllPassed        bool     `json:"AllPassed"`
}

// Sentinels — every failure is distinguishable so the HTTP layer can
// produce a helpful status code without string-matching.
var (
	ErrDisabled    = errors.New("luxand base URL not configured")
	ErrBadResponse = errors.New("luxand returned an unparseable response")
	ErrUpstream    = errors.New("luxand upstream error")
)

// LivenessCheck posts the frame sequence to /face/liveness and returns
// the parsed result. Callers pass raw JPEG bytes; the client handles
// base64 encoding.
//
// The context deadline overrides the client's timeout for that call.
// If callers hand us a nil ctx we default to context.Background() so
// this is safe from test paths that forget it.
func (c *Client) LivenessCheck(
	ctx context.Context,
	frames [][]byte,
	challenges []string,
) (*LivenessResult, error) {
	if c == nil || c.baseURL == "" {
		return nil, ErrDisabled
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if len(challenges) == 0 {
		challenges = []string{"blink"}
	}

	encoded := make([]string, len(frames))
	for i, f := range frames {
		encoded[i] = base64.StdEncoding.EncodeToString(f)
	}

	body, err := json.Marshal(map[string]any{
		"Frames":     encoded,
		"Mime":       "image/jpeg",
		"Challenges": challenges,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/face/liveness", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: HTTP %d: %s",
			ErrUpstream, resp.StatusCode, string(raw))
	}
	var out LivenessResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("%w: %v (%s)", ErrBadResponse, err, string(raw))
	}
	return &out, nil
}
