// Package razorpay is a tiny client for Razorpay's REST API — JUST enough
// to (a) create a payment order and (b) verify the HMAC signature
// Razorpay sends back after Checkout completes. We deliberately don't
// pull in the official Go SDK because it brings transitive deps we don't
// need; both endpoints are a single net/http call each.
//
// Test vs Live: identical endpoint URLs; the keys are what distinguish
// modes. Test keys begin with `rzp_test_`, live keys with `rzp_live_`.
// In test mode, fake card numbers (4111 1111 1111 1111) always succeed
// — no real money moves.
//
// Security: KeySecret is the HMAC key. Never log it, never send it to
// the browser, never store it in the DB. Config loads it from the
// RAZORPAY_KEY_SECRET env var, which the gitignored backend/.env file
// supplies in dev.
package razorpay

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client wraps a single Razorpay account's credentials.
type Client struct {
	keyID     string
	keySecret string
	http      *http.Client
	baseURL   string // overridable for tests; defaults to api.razorpay.com
}

// New returns a configured client. keyID + keySecret come from the
// Razorpay dashboard (Settings → API Keys). Both must be present;
// callers should already be checking against Config.RazorpayKeyID
// before constructing this.
func New(keyID, keySecret string) *Client {
	return &Client{
		keyID:     keyID,
		keySecret: keySecret,
		http:      &http.Client{Timeout: 10 * time.Second},
		baseURL:   "https://api.razorpay.com/v1",
	}
}

// KeyID returns the public key — safe to send to the browser to init
// Razorpay Checkout.
func (c *Client) KeyID() string { return c.keyID }

// Order is the response shape from POST /v1/orders. We only care about
// the fields the frontend needs to drive Razorpay Checkout.
type Order struct {
	ID       string `json:"id"`       // "order_<14 chars>"
	Amount   int    `json:"amount"`   // paise
	Currency string `json:"currency"` // "INR"
	Status   string `json:"status"`   // "created" right after creation
	Receipt  string `json:"receipt"`  // our internal idempotency hint, echoed back
}

// CreateOrder calls POST /v1/orders to register an intended payment.
// Razorpay returns an Order ID; the frontend embeds it in Checkout so
// the eventual payment is bound to this specific order. amountPaise
// must be positive; Razorpay rejects 0-amount orders.
//
// receipt is a free-text identifier (up to 40 chars) that we echo back
// when verifying — useful for our own audit logs. We pass the local
// user_id + timestamp so the same operator triggering two top-ups in
// the same second doesn't collide.
func (c *Client) CreateOrder(ctx context.Context, amountPaise int, receipt string) (*Order, error) {
	if amountPaise <= 0 {
		return nil, errors.New("razorpay: amount must be > 0")
	}
	body := map[string]any{
		"amount":   amountPaise,
		"currency": "INR",
		"receipt":  receipt,
		// payment_capture: 1 = auto-capture on success. Default for new
		// accounts, but we set it explicitly so behaviour is consistent
		// across accounts that might have manual capture toggled on.
		"payment_capture": 1,
	}
	buf, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/orders", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth(c.keyID, c.keySecret)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("razorpay: order POST: %w", err)
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		// Razorpay returns {"error":{"code":"...","description":"..."}}
		// on failure. Pass description through; never the secret.
		return nil, fmt.Errorf("razorpay: HTTP %d: %s", resp.StatusCode, string(rawBody))
	}
	var o Order
	if err := json.Unmarshal(rawBody, &o); err != nil {
		return nil, fmt.Errorf("razorpay: order body parse: %w", err)
	}
	return &o, nil
}

// VerifySignature checks that the (order_id, payment_id, signature)
// triple Razorpay sends back to the frontend is genuinely from our
// account. The signature is HMAC-SHA256 over `order_id|payment_id`,
// keyed with our KeySecret.
//
// This is THE security guarantee — without it, a hostile frontend
// could POST any made-up payment_id and we'd happily credit the wallet.
// Constant-time equality (hmac.Equal) makes the comparison itself safe
// against timing attacks.
func (c *Client) VerifySignature(orderID, paymentID, signature string) bool {
	if orderID == "" || paymentID == "" || signature == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(c.keySecret))
	mac.Write([]byte(orderID + "|" + paymentID))
	expected := hex.EncodeToString(mac.Sum(nil))
	// Razorpay sends the signature hex-lowercased; normalise just in case.
	return hmac.Equal([]byte(expected), []byte(strings.ToLower(signature)))
}

// VerifyWebhookSignature checks that an incoming Razorpay webhook POST
// is genuine. The signature is HMAC-SHA256 of the RAW request body
// (the exact bytes Razorpay sent), keyed with the *webhook secret*
// (NOT the same as KeySecret — webhooks have their own secret set per-
// endpoint in the Razorpay dashboard). The signature is delivered in
// the X-Razorpay-Signature request header, hex-encoded.
//
// Crucially, the body must be the unmodified bytes: any reformatting
// (re-marshalling the JSON, normalising whitespace) breaks the HMAC.
// Callers should read the body once into a []byte and pass it here
// before unmarshalling.
func VerifyWebhookSignature(body []byte, signature, webhookSecret string) bool {
	if len(body) == 0 || signature == "" || webhookSecret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(webhookSecret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(strings.ToLower(signature)))
}
