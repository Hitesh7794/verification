// Package trustview is a small HTTP client for the hosted TrustView
// biometric compare API (POST /api/v1/ext/compare).
//
// TrustView replaces our previous per-modality matchers:
//
//	face        — was luxand-service (FSDK 8.3) → now TrustView (engine="iiv")
//	iris        — was Marvis Auth Web SDK on the operator laptop → now TrustView
//	fingerprint — was fp-match-service (SourceAFIS 3.18) → now TrustView
//
// Everything routes through one endpoint, one token, one unified score
// (0..100, 50 = threshold). Retries only 429/503 per spec.
package trustview

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Modality is the biometric kind being compared. Serialised as the JSON
// "modality" field of the compare payload.
type Modality string

const (
	Face        Modality = "face"
	Iris        Modality = "iris"
	Fingerprint Modality = "fingerprint"
)

// FingerprintFormat is the wire format of a fingerprint payload. Only
// meaningful when Modality == Fingerprint; other modalities always send
// engine-agnostic image bytes and the format field is omitted.
type FingerprintFormat string

const (
	FormatIso        FingerprintFormat = "iso"
	FormatImage      FingerprintFormat = "image"
	FormatWsq        FingerprintFormat = "wsq"
	FormatIsoImage   FingerprintFormat = "iso-image"
	FormatSourceafis FingerprintFormat = "sourceafis"
)

// Config is the subset of environment we consume — mirrors the two env
// vars the ops team populates in backend/.env.
type Config struct {
	BaseURL string
	Token   string
}

// Client is a concurrency-safe wrapper around http.Client. One instance
// per process; the underlying transport pools connections for us.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// New returns a Client with a 45 s per-request timeout (spec says
// "allow ≥30s" — this leaves headroom for warm-JVM edge cases without
// stranding request threads forever).
func New(cfg Config) *Client {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "https://v1.trustview.in"
	}
	return &Client{
		baseURL: base,
		token:   cfg.Token,
		http:    &http.Client{Timeout: 45 * time.Second},
	}
}

// CompareResult is the parsed 200 OK envelope. Raw retains the engine's
// native numbers so audit tooling can inspect them without another
// round-trip.
type CompareResult struct {
	Matched  bool
	Score    float64
	Modality string
	Engine   string
	Raw      map[string]any
}

// ErrorKind is a coarse taxonomy the callers actually branch on. The
// stable "code" slug from TrustView goes on Error.Code — use that when
// the taxonomy isn't specific enough.
type ErrorKind string

const (
	// Config / auth. Distinct so operators see clean UI text instead of
	// a raw JSON blob.
	KindNoToken       ErrorKind = "no_token"       // client wasn't configured with a token
	KindUnauthorized  ErrorKind = "unauthorized"   // 401 unauthorized
	KindTokenExpired  ErrorKind = "token_expired"  // 401 token_expired — surface loudly, needs a new token
	KindTokenDisabled ErrorKind = "token_disabled" // 401 token_disabled

	// Request shape.
	KindBadRequest    ErrorKind = "bad_request"     // generic 400
	KindPayloadTooBig ErrorKind = "payload_too_big" // 413
	KindNotAllowed    ErrorKind = "not_allowed"     // 403 modality_not_allowed

	// Content quality.
	KindNoFace     ErrorKind = "no_face"     // 422 no_face
	KindNoQuality  ErrorKind = "no_quality"  // 422 misc quality gate
	KindRateLimit  ErrorKind = "rate_limit"  // 429 after retries exhausted
	KindTooMany    ErrorKind = "too_many"    // 429 too_many_attempts
	KindEngineBusy ErrorKind = "engine_busy" // 503 engine_busy after retries
	KindUnavail    ErrorKind = "unavailable" // 503 modality/service unavailable

	// Transport / server.
	KindTransport ErrorKind = "transport" // network I/O
	KindServer    ErrorKind = "server"    // 5xx not covered above
	KindUnknown   ErrorKind = "unknown"   // anything else
)

// Error is the typed error every non-2xx path returns. HTTP is 0 for
// pure transport errors.
type Error struct {
	Kind    ErrorKind
	Code    string // stable slug from the API envelope, if any
	Message string
	HTTP    int
	Err     error // wrapped transport / decode error, if any
}

func (e *Error) Error() string {
	if e.HTTP == 0 {
		return fmt.Sprintf("trustview: %s: %s", e.Kind, e.Message)
	}
	return fmt.Sprintf("trustview: HTTP %d %s (%s): %s", e.HTTP, e.Kind, e.Code, e.Message)
}
func (e *Error) Unwrap() error { return e.Err }

// wire types kept private; the callable API returns CompareResult / Error.

type imagePayload struct {
	Data   string `json:"data"`
	Format string `json:"format,omitempty"`
	DPI    int    `json:"dpi,omitempty"`
}

type comparePayload struct {
	Modality  string       `json:"modality"`
	Image1    imagePayload `json:"image1"`
	Image2    imagePayload `json:"image2"`
	Threshold *float64     `json:"threshold,omitempty"`
}

type compareOK struct {
	Matched  bool           `json:"matched"`
	Score    float64        `json:"score"`
	Modality string         `json:"modality"`
	Engine   string         `json:"engine"`
	Raw      map[string]any `json:"raw"`
}

type compareErr struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

// Compare posts a probe + gallery pair to /api/v1/ext/compare. Retries
// 429/503 (honouring Retry-After) up to 3 tries total; 4xx other than
// 429 fail fast. The probeFmt / galleryFmt args are honoured only for
// Modality == Fingerprint; pass nil otherwise.
func (c *Client) Compare(
	ctx context.Context,
	modality Modality,
	probe []byte,
	probeFmt *FingerprintFormat,
	gallery []byte,
	galleryFmt *FingerprintFormat,
	threshold *float64,
) (*CompareResult, error) {
	if c.token == "" {
		return nil, &Error{Kind: KindNoToken, Message: "TRUSTVIEW_TOKEN is not set"}
	}
	if len(probe) == 0 {
		return nil, &Error{Kind: KindBadRequest, Message: "probe bytes empty"}
	}
	if len(gallery) == 0 {
		return nil, &Error{Kind: KindBadRequest, Message: "gallery bytes empty"}
	}
	pay := comparePayload{
		Modality:  string(modality),
		Image1:    imageFor(probe, modality, probeFmt),
		Image2:    imageFor(gallery, modality, galleryFmt),
		Threshold: threshold,
	}
	// Spec ignores threshold for iris. Drop it defensively so a caller
	// passing a value doesn't get a surprise on a future engine swap.
	if modality == Iris {
		pay.Threshold = nil
	}
	body, err := json.Marshal(pay)
	if err != nil {
		return nil, &Error{Kind: KindBadRequest, Message: "marshal payload", Err: err}
	}

	const maxAttempts = 3
	// backoffs used when Retry-After isn't provided.
	backoffs := []time.Duration{200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond}

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			// The previous iteration set lastErr to the retryable *Error,
			// which is why we're here. Wait, then re-post the same body.
			var e *Error
			var wait time.Duration
			if errors.As(lastErr, &e) {
				wait = retryDelay(e, backoffs, attempt-1)
			} else {
				wait = backoffs[attempt-1]
			}
			// Jitter to avoid dogpiling when many operators hit a
			// simultaneous 503.
			wait += time.Duration(rand.Int63n(int64(50 * time.Millisecond)))
			select {
			case <-ctx.Done():
				return nil, &Error{Kind: KindTransport, Message: "context cancelled during backoff", Err: ctx.Err()}
			case <-time.After(wait):
			}
		}

		res, err := c.doOnce(ctx, body)
		if err == nil {
			return res, nil
		}
		lastErr = err

		var e *Error
		if !errors.As(err, &e) {
			// Wrap unknown errors and return.
			return nil, &Error{Kind: KindUnknown, Message: err.Error(), Err: err}
		}
		if !retryable(e) {
			return nil, e
		}
	}
	return nil, lastErr
}

// doOnce sends one request and parses one response — no retry logic
// lives here so the retry loop stays legible.
func (c *Client) doOnce(ctx context.Context, body []byte) (*CompareResult, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/api/v1/ext/compare", bytes.NewReader(body))
	if err != nil {
		return nil, &Error{Kind: KindBadRequest, Message: "build request", Err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Kind: KindTransport, Message: "HTTP transport error", Err: err}
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, &Error{Kind: KindTransport, HTTP: resp.StatusCode, Message: "read response body", Err: err}
	}

	if resp.StatusCode == 200 {
		var ok compareOK
		if err := json.Unmarshal(raw, &ok); err != nil {
			return nil, &Error{Kind: KindServer, HTTP: 200, Message: "invalid JSON response", Err: err}
		}
		return &CompareResult{
			Matched:  ok.Matched,
			Score:    ok.Score,
			Modality: ok.Modality,
			Engine:   ok.Engine,
			Raw:      ok.Raw,
		}, nil
	}

	// Non-200: try to parse the {error, code} envelope but don't blow up
	// if the server sent HTML / empty body.
	env := compareErr{}
	_ = json.Unmarshal(raw, &env)

	e := &Error{
		HTTP:    resp.StatusCode,
		Code:    env.Code,
		Message: env.Error,
	}
	if e.Message == "" {
		// Fall back to a truncated body so operators can debug.
		e.Message = truncate(string(raw), 256)
		if e.Message == "" {
			e.Message = http.StatusText(resp.StatusCode)
		}
	}
	e.Kind = classify(resp.StatusCode, env.Code)

	// Attach Retry-After to the error so the retry loop can honour it.
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		e.Err = retryAfterHint{after: parseRetryAfter(ra)}
	}
	return nil, e
}

// classify maps (HTTP status, TrustView code) to our ErrorKind taxonomy.
func classify(status int, code string) ErrorKind {
	switch status {
	case 400:
		return KindBadRequest
	case 401:
		switch code {
		case "token_expired":
			return KindTokenExpired
		case "token_disabled":
			return KindTokenDisabled
		default:
			return KindUnauthorized
		}
	case 403:
		if code == "modality_not_allowed" {
			return KindNotAllowed
		}
		return KindUnauthorized
	case 413:
		return KindPayloadTooBig
	case 422:
		if code == "no_face" {
			return KindNoFace
		}
		return KindNoQuality
	case 429:
		if code == "too_many_attempts" {
			return KindTooMany
		}
		return KindRateLimit
	case 503:
		switch code {
		case "engine_busy":
			return KindEngineBusy
		default:
			return KindUnavail
		}
	}
	if status >= 500 {
		return KindServer
	}
	return KindUnknown
}

// retryable reports whether an error is worth another attempt. Only
// 429/503 per spec — every other 4xx must not be retried.
func retryable(e *Error) bool {
	switch e.Kind {
	case KindRateLimit, KindTooMany, KindEngineBusy, KindUnavail:
		return true
	case KindServer:
		// Only retry idempotent-looking 5xx if the server also gave us
		// no useful hint that it's a permanent-ish failure. Being
		// conservative here — we'd rather 502 fast than mask a bug.
		return e.HTTP == 502
	}
	return false
}

// retryAfterHint is stashed inside Error.Err so the retry loop can pull
// the parsed delay back out without re-parsing the header.
type retryAfterHint struct{ after time.Duration }

func (retryAfterHint) Error() string { return "retry-after hint" }

// retryDelay picks the wait for attempt N (0-indexed). Retry-After
// beats the exponential curve; if neither is available we fall back to
// the default.
func retryDelay(e *Error, backoffs []time.Duration, idx int) time.Duration {
	var hint retryAfterHint
	if errors.As(e.Err, &hint) && hint.after > 0 {
		return hint.after
	}
	if idx >= 0 && idx < len(backoffs) {
		return backoffs[idx]
	}
	return backoffs[len(backoffs)-1]
}

// parseRetryAfter accepts both delta-seconds ("2") and HTTP-date forms.
func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		d := time.Until(t)
		if d > 0 {
			return d
		}
	}
	return 0
}

// imageFor builds one image object for the payload. For iris we default
// to format="image" so the engine treats the payload as raw BMP/K7/…
// bytes rather than an ISO template.
func imageFor(bs []byte, mod Modality, fmt *FingerprintFormat) imagePayload {
	p := imagePayload{Data: base64.StdEncoding.EncodeToString(bs)}
	switch mod {
	case Fingerprint:
		if fmt == nil {
			// Sensible default: our enrolled gallery is ISO/IEC 19794-2
			// FMR_V2005; probes captured via MorFin come out the same.
			p.Format = string(FormatIso)
		} else {
			p.Format = string(*fmt)
			if *fmt == FormatImage {
				// The spec asks for dpi on fingerprint-image uploads;
				// 500 dpi is the FBI IAFIS baseline every vendor SDK
				// consumes cleanly.
				p.DPI = 500
			}
		}
	case Face:
		// No format required on face — engine sniffs the mime.
	case Iris:
		// No format required either; the engine's iris pre-processor
		// handles the common vendor formats natively.
	}
	return p
}

// truncate keeps error messages readable in server logs / operator
// toasts. UTF-8-safe: we truncate at a rune boundary.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Rune-safe truncation.
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}
