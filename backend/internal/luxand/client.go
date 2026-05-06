// Package luxand is a thin HTTP client for the localhost luxand-service.
//
// The service is on the same Linux host as the Go backend (loopback only,
// 127.0.0.1:8040). Talking to it over HTTP rather than CGO/JNI means we
// keep the Go process pure, can recycle the Java service independently,
// and avoid pulling Luxand's 70 MB native library into our Go build.
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

// Client wraps the localhost luxand-service. Concurrency-safe: net/http
// handles connection pooling for us.
type Client struct {
	base string
	http *http.Client
}

func New(base string) *Client {
	if base == "" {
		base = "http://127.0.0.1:8040/face/"
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return &Client{
		base: base,
		// Generous timeouts: face extraction can take up to ~80 ms on
		// libfsdk.so + ONNX, plus JNA hop. 5 s gives us plenty of margin
		// without letting a hung backend wedge a request thread forever.
		http: &http.Client{Timeout: 5 * time.Second},
	}
}

// Envelope mirrors the JSON shape every face/* endpoint returns. Fields
// for optional payloads use pointer types so we can distinguish "absent"
// from "zero".
type Envelope struct {
	ErrorCode        string  `json:"ErrorCode"`
	ErrorDescription string  `json:"ErrorDescription"`
	FaceFound        *bool   `json:"FaceFound,omitempty"`
	Template         string  `json:"Template,omitempty"`
	Score            *float64 `json:"Score,omitempty"`
	Threshold        *float64 `json:"Threshold,omitempty"`
	Status           *bool   `json:"Status,omitempty"`
	Activated        *bool   `json:"Activated,omitempty"`
}

// ErrService is returned when the luxand-service is unreachable. Distinct
// type so handlers can map it to a clean 503 instead of leaking the raw
// network error to the operator.
type ErrService struct{ Err error }

func (e *ErrService) Error() string { return "luxand-service unreachable: " + e.Err.Error() }
func (e *ErrService) Unwrap() error { return e.Err }

// ErrSDK wraps a non-zero ErrorCode from the service (face not found,
// invalid template, license rejected, etc.).
type ErrSDK struct {
	Code        string
	Description string
}

func (e *ErrSDK) Error() string { return fmt.Sprintf("luxand %s: %s", e.Code, e.Description) }

// Health returns the service's self-report. Used by /api/health and as a
// startup probe — if the service isn't activated we don't want to silently
// serve face-match requests that would all return -2.
func (c *Client) Health(ctx context.Context) (*Envelope, error) {
	return c.post(ctx, "health", nil)
}

// ExtractTemplate runs FSDK.GetFaceTemplate on the supplied image and
// returns the 1040-byte face template (already base64-decoded). Returns
// (nil, nil) when no face was detected — distinct from an error so the
// caller can render a clean "please look at the camera" message.
func (c *Client) ExtractTemplate(ctx context.Context, imageBytes []byte, mime string) ([]byte, error) {
	body := map[string]any{
		"Image": base64.StdEncoding.EncodeToString(imageBytes),
		"Mime":  mime,
	}
	env, err := c.post(ctx, "extract", body)
	if err != nil {
		return nil, err
	}
	if env.FaceFound != nil && !*env.FaceFound {
		return nil, nil
	}
	if env.Template == "" {
		return nil, errors.New("luxand: extract returned empty Template field")
	}
	return base64.StdEncoding.DecodeString(env.Template)
}

// MatchImageResult bundles everything we want to record on the
// verifications row after a successful match.
type MatchImageResult struct {
	FaceFound bool
	Score     float64
	Threshold float64
	Status    bool
}

// MatchImage runs FSDK.GetFaceTemplate on probeImage, then 1:1 matches
// the resulting probe template against galleryTemplate. Single round trip.
func (c *Client) MatchImage(ctx context.Context, probeImage []byte, probeMime string, galleryTemplate []byte) (*MatchImageResult, error) {
	body := map[string]any{
		"ProbeImage":      base64.StdEncoding.EncodeToString(probeImage),
		"ProbeMime":       probeMime,
		"GalleryTemplate": base64.StdEncoding.EncodeToString(galleryTemplate),
	}
	env, err := c.post(ctx, "match-image", body)
	if err != nil {
		return nil, err
	}
	r := &MatchImageResult{}
	if env.FaceFound != nil {
		r.FaceFound = *env.FaceFound
	}
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

// post does a JSON POST and unwraps the envelope. Non-zero ErrorCode
// becomes ErrSDK; transport errors become ErrService.
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
		return nil, fmt.Errorf("luxand %s: HTTP %d: %s", method, resp.StatusCode, string(raw))
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
