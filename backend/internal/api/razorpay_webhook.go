package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"github.com/veni/neet-verification/internal/razorpay"
	"github.com/veni/neet-verification/internal/wallet"
)

// Razorpay webhook endpoint.
//
// Why this exists alongside /api/wallet/verify-payment: the browser-side
// verify-payment call is best-effort. If the user closes the tab right
// after Razorpay Checkout reports success (or hits a JS error, or loses
// Wi-Fi mid-redirect), money LEFT their card, Razorpay's records show the
// payment, but our wallet never credits. The webhook is the server-to-
// server safety net: Razorpay POSTs `payment.captured` directly to this
// endpoint after every successful capture and retries for 24 hours if
// our server is down.
//
// Authentication: this endpoint is PUBLIC — Razorpay calls it without
// any token. The HMAC of the body (with RAZORPAY_WEBHOOK_SECRET) is the
// only authentication. We refuse any POST whose signature doesn't
// verify against the configured secret. If no secret is configured, we
// 503 — better to refuse webhooks we can't verify than to silently
// accept unauthenticated POSTs.
//
// Idempotency: both the verify-payment handler AND this webhook end up
// in wallet.Credit with the same razorpay_payment_id, and the UNIQUE
// INDEX on razorpay_payment_id catches the duplicate. So whoever wins
// first credits the wallet; the loser sees the UNIQUE violation and
// we return 200 ("already processed") to stop Razorpay's retries.

// razorpayWebhookEnvelope captures only the fields we use from
// Razorpay's webhook payload. Razorpay sends many more fields; we
// deliberately ignore them so we don't fail on shape changes.
//
// Reference: https://razorpay.com/docs/webhooks/payloads/payments/captured/
type razorpayWebhookEnvelope struct {
	Event   string `json:"event"`
	Payload struct {
		Payment struct {
			Entity razorpayPaymentEntity `json:"entity"`
		} `json:"payment"`
	} `json:"payload"`
}

type razorpayPaymentEntity struct {
	ID       string `json:"id"`       // pay_XXX
	OrderID  string `json:"order_id"` // order_XXX
	Amount   int    `json:"amount"`   // paise
	Currency string `json:"currency"`
	Status   string `json:"status"`   // "captured" for the event we care about
}

// razorpayWebhook is the single entry point for all Razorpay webhook
// events. Mounted PUBLICLY at POST /api/razorpay/webhook outside the
// auth middleware group.
//
// Response contract: Razorpay considers any 2xx as "delivered, stop
// retrying", any non-2xx as a transient failure to be retried (up to
// 24h with exponential backoff). We return:
//   - 200: event accepted (credited, replayed, or unhandled event type)
//   - 400: malformed body
//   - 401: HMAC verification failed (logged loudly — possible attack)
//   - 404: order_id we've never heard of (logged — Razorpay account mismatch?)
//   - 500: actual server error (DB down etc) — Razorpay retries
//   - 503: webhook secret not configured (no retries help — admin
//          must set the env var)
func (s *Server) razorpayWebhook(w http.ResponseWriter, r *http.Request) {
	secret := s.deps.Cfg.RazorpayWebhookSecret
	if secret == "" {
		writeErr(w, http.StatusServiceUnavailable, "razorpay webhook not configured")
		return
	}

	// MaxBytes cap so a hostile pretender can't make us OOM. Razorpay
	// payloads are < 8 KB in practice; 64 KB is comfortably above that.
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	signature := r.Header.Get("X-Razorpay-Signature")
	if !razorpay.VerifyWebhookSignature(body, signature, secret) {
		// Logged loudly because the only ways this fires legitimately are
		// (a) we rotated the secret without telling Razorpay or (b) someone
		// is probing for an unauthenticated webhook entry point.
		log.Printf("razorpay webhook: signature verification failed from %s (sig=%q, body_len=%d)",
			clientIP(r), signature, len(body))
		writeErr(w, http.StatusUnauthorized, "signature verification failed")
		return
	}

	var env razorpayWebhookEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		writeErr(w, http.StatusBadRequest, "parse: "+err.Error())
		return
	}

	switch env.Event {
	case "payment.captured":
		s.handlePaymentCaptured(w, r, env.Payload.Payment.Entity)
	case "payment.failed":
		// Logged for visibility; nothing to do (the wallet was never credited).
		log.Printf("razorpay webhook: payment.failed payment_id=%s order_id=%s amount=%d",
			env.Payload.Payment.Entity.ID, env.Payload.Payment.Entity.OrderID,
			env.Payload.Payment.Entity.Amount)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": "payment.failed"})
	default:
		// Razorpay sends many events we don't care about (refund.created,
		// order.paid, etc.). Acknowledge to stop retries; do nothing.
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": env.Event})
	}
}

// handlePaymentCaptured credits the wallet for a payment.captured
// event. Idempotent: replays are caught by the UNIQUE INDEX on
// wallet_transactions.razorpay_payment_id (whether the prior credit
// came from the browser verify-payment path or an earlier webhook
// delivery), and we treat the UNIQUE violation as success.
func (s *Server) handlePaymentCaptured(w http.ResponseWriter, r *http.Request, e razorpayPaymentEntity) {
	if e.ID == "" || e.OrderID == "" || e.Amount <= 0 {
		writeErr(w, http.StatusBadRequest, "malformed payment entity")
		return
	}
	if e.Status != "" && e.Status != "captured" {
		// Razorpay shouldn't send a payment.captured for a non-captured
		// payment, but defend against the field being something
		// unexpected — refuse rather than guess.
		log.Printf("razorpay webhook: payment.captured with unexpected status=%q payment_id=%s",
			e.Status, e.ID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": "unexpected status"})
		return
	}

	// Look up the canonical order. If we don't have a row, it means the
	// payment is for an order we never created — possible if the
	// webhook is wired to the wrong Razorpay account, or if (somehow)
	// someone else's order_id leaked through. Refuse to credit; log loud.
	order, err := s.wallet.FindOrder(r.Context(), e.OrderID)
	if err != nil {
		if errors.Is(err, wallet.ErrOrderNotFound) {
			log.Printf("razorpay webhook: payment.captured for unknown order order_id=%s payment_id=%s amount=%d",
				e.OrderID, e.ID, e.Amount)
			writeErr(w, http.StatusNotFound, "unknown order")
			return
		}
		writeErr(w, http.StatusInternalServerError, "order lookup: "+err.Error())
		return
	}

	// Sanity check: Razorpay's payment amount should match the order
	// amount we asked for. If they diverge it's either a Razorpay bug
	// or someone modifying amounts in transit (MITM, compromised CA).
	// Log loud, but credit the order.AmountPaise (our truth, not theirs)
	// — we'd rather underpay than overpay in this edge case.
	if e.Amount != order.AmountPaise {
		log.Printf("razorpay webhook: amount mismatch order_id=%s order_amount=%d razorpay_amount=%d (using order_amount)",
			e.OrderID, order.AmountPaise, e.Amount)
	}

	// Fast idempotency: if we already have a transaction row for this
	// payment_id, return success without re-touching anything. This is
	// the common case — verify-payment fired from the browser first and
	// the webhook is just confirming. Without this short-circuit we'd
	// still be safe (UNIQUE INDEX catches the dup) but we'd churn a
	// failed INSERT for no reason.
	if existing, err := s.wallet.FindByRazorpayPaymentID(r.Context(), e.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "history: "+err.Error())
		return
	} else if existing != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       true,
			"replayed": true,
		})
		return
	}

	tx, err := s.wallet.Credit(r.Context(), order.OrgID, order.ActorUserID, order.AmountPaise,
		wallet.KindDeposit, e.OrderID, e.ID, "Razorpay top-up (webhook)")
	if err != nil {
		// Race recovery: the verify-payment handler could have committed
		// the row between our FindByRazorpayPaymentID and our Credit. The
		// UNIQUE INDEX would fire here. Re-resolve and treat as replay.
		if existing, lookupErr := s.wallet.FindByRazorpayPaymentID(r.Context(), e.ID); lookupErr == nil && existing != nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":       true,
				"replayed": true,
			})
			return
		}
		log.Printf("razorpay webhook: credit failed order_id=%s payment_id=%s: %v",
			e.OrderID, e.ID, err)
		writeErr(w, http.StatusInternalServerError, "credit: "+err.Error())
		return
	}
	_ = s.wallet.MarkOrderVerified(r.Context(), e.OrderID)
	// Audit row with a synthetic actor (the webhook has no user context;
	// we use the admin who initiated the order). Distinct action name
	// so reports can distinguish browser-credited vs webhook-credited
	// deposits — useful for telling whether the browser-side flow is
	// reliable or the webhook is doing most of the heavy lifting.
	s.audit(r.Context(), nil, "wallet.deposit.webhook", "org", order.OrgID, clientIP(r), map[string]any{
		"amount_paise":        order.AmountPaise,
		"actor_user_id":       order.ActorUserID,
		"transaction_id":      tx.ID,
		"razorpay_payment_id": e.ID,
		"razorpay_order_id":   e.OrderID,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"transaction_id": tx.ID,
		"balance_paise":  tx.BalanceAfterPaise,
	})
}
