package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/veni/neet-verification/internal/wallet"
)

// Wallet endpoints — admin/superadmin only. The wallet belongs to the
// organisation; admins of that org see and top it up. Superadmin can
// query any org by passing ?org_id=N. Operators (client role) charge
// against the org wallet transparently via walletCharge middleware
// but never see balance, deposit, or history.
//
// All amounts on the wire are paise (integer). The frontend formats
// these as ₹ X.YZ for display.

// walletConfigResp tells the frontend the deployment's wallet tunables
// so the UI knows what amount to debit per lookup, the deposit cap, and
// whether the Razorpay deposit flow is available (key_id present).
//
// RazorpayTestMode lets the DepositModal show / hide the "test mode" hint
// (test card number 4111... etc) based on whether we're pointing at
// Razorpay's test environment. Derived from the key prefix:
// `rzp_test_*` = test, `rzp_live_*` = live. Showing the test hint in
// production would be embarrassing — operators would try the test card
// against live Razorpay and get rejected.
type walletConfigResp struct {
	FeePerLookupPaise int    `json:"fee_per_lookup_paise"`
	MaxDepositPaise   int    `json:"max_deposit_paise"`
	Currency          string `json:"currency"`
	RazorpayKeyID     string `json:"razorpay_key_id"`   // public key
	RazorpayEnabled   bool   `json:"razorpay_enabled"`  // false → DepositModal disabled
	RazorpayTestMode  bool   `json:"razorpay_test_mode"` // true → show test-card hint
	SameRollCacheMin  int    `json:"same_roll_cache_min"`
}

func (s *Server) walletConfig(w http.ResponseWriter, r *http.Request) {
	cfg := s.deps.Cfg
	writeJSON(w, http.StatusOK, walletConfigResp{
		FeePerLookupPaise: cfg.WalletFeePerLookupPaise,
		MaxDepositPaise:   cfg.WalletMaxDepositPaise,
		Currency:          "INR",
		RazorpayKeyID:     cfg.RazorpayKeyID,
		RazorpayEnabled:   cfg.RazorpayKeyID != "" && cfg.RazorpayKeySecret != "",
		RazorpayTestMode:  strings.HasPrefix(cfg.RazorpayKeyID, "rzp_test_"),
		SameRollCacheMin:  cfg.WalletSameRollCacheMin,
	})
}

type walletBalanceResp struct {
	OrgID        int64          `json:"org_id"`
	BalancePaise int            `json:"balance_paise"`
	Transactions []walletTxView `json:"transactions"`
	// NextCursor is the `id` to pass as ?before=N on the next call
	// to fetch the page of older transactions. 0 = no more pages.
	NextCursor int64 `json:"next_cursor"`
}

type walletTxView struct {
	ID                int64  `json:"id"`
	Kind              string `json:"kind"`
	AmountPaise       int    `json:"amount_paise"`
	BalanceAfterPaise int    `json:"balance_after_paise"`
	RelatedRoll       string `json:"related_roll,omitempty"`
	ActorUsername     string `json:"actor_username,omitempty"`
	ActorDisplayName  string `json:"actor_display_name,omitempty"`
	Description       string `json:"description,omitempty"`
	CreatedAt         string `json:"created_at"`
}

// resolveOrgID picks the org whose wallet the caller is asking about:
//   - admin role  → forced to claims.OrgID (cannot view other orgs)
//   - superadmin  → ?org_id=N if provided, else 400 (no implicit org)
//
// Returns 0 + a written-error if the caller is not allowed to act on
// the requested org or the request is malformed.
func (s *Server) resolveOrgID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	claims := claimsFrom(r)
	q := strings.TrimSpace(r.URL.Query().Get("org_id"))
	switch claims.Role {
	case "admin":
		if claims.OrgID == nil {
			writeErr(w, http.StatusForbidden, "admin without org context")
			return 0, false
		}
		// Admin can omit the query param (resolves to own org). If they
		// pass one, it must match their own org — otherwise reject so
		// the URL accurately reflects what they're seeing.
		if q != "" {
			n, err := strconv.ParseInt(q, 10, 64)
			if err != nil || n != *claims.OrgID {
				writeErr(w, http.StatusForbidden, "admins can only view their own org")
				return 0, false
			}
		}
		return *claims.OrgID, true
	case "superadmin":
		if q == "" {
			writeErr(w, http.StatusBadRequest, "org_id query param required for superadmin")
			return 0, false
		}
		n, err := strconv.ParseInt(q, 10, 64)
		if err != nil || n <= 0 {
			writeErr(w, http.StatusBadRequest, "invalid org_id")
			return 0, false
		}
		return n, true
	case "client":
		// Operators view only their own org's wallet balance -- never
		// with an org_id override. Prevents cross-tenant enumeration
		// even if a client token somehow reached this endpoint.
		if claims.OrgID == nil {
			writeErr(w, http.StatusForbidden, "operator without org context")
			return 0, false
		}
		return *claims.OrgID, true
	default:
		writeErr(w, http.StatusForbidden, "forbidden")
		return 0, false
	}
}

// walletSummary is the operator-facing wallet endpoint. Returns the
// operator's personal allocation (cap + spent) + the fee. Falls back
// to org balance when the operator has no personal cap so the UI
// always has SOMETHING meaningful to render.
//
// Admin + superadmin also get this shape but their cap is always null
// (they don't consume the wallet themselves); the org balance is
// what they care about anyway.
type walletSummaryResp struct {
	// Per-operator allocation. cap_paise=null means "no cap set --
	// operator spends against the shared org wallet with no personal
	// ceiling". spent_paise is this operator's lifetime total across
	// every verification they've submitted.
	CapPaise   *int `json:"cap_paise,omitempty"`
	SpentPaise int  `json:"spent_paise"`
	// Shared org wallet balance. The middleware charges against this
	// on every face-match; it's the ultimate ceiling even for uncapped
	// operators, so we always surface it.
	OrgBalancePaise   int `json:"org_balance_paise"`
	FeePerLookupPaise int `json:"fee_per_lookup_paise"`
}

func (s *Server) walletSummary(w http.ResponseWriter, r *http.Request) {
	if s.wallet == nil {
		writeErr(w, http.StatusServiceUnavailable, "wallet feature not enabled")
		return
	}
	orgID, ok := s.resolveOrgID(w, r)
	if !ok {
		return
	}
	claims := claimsFrom(r)
	// Load this user's cap + spent. Admin/superadmin rows may not have
	// these (they don't spend), so we tolerate NULL cap + zero spent.
	var (
		cap   sql.NullInt64
		spent int
	)
	if claims != nil && claims.UserID != 0 {
		if err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT spending_cap_paise, COALESCE(spent_paise, 0) FROM users WHERE id = ?`,
			claims.UserID,
		).Scan(&cap, &spent); err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusInternalServerError, "user read: "+err.Error())
			return
		}
	}
	bal, err := s.wallet.Balance(r.Context(), orgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "balance: "+err.Error())
		return
	}
	resp := walletSummaryResp{
		SpentPaise:        spent,
		OrgBalancePaise:   bal,
		FeePerLookupPaise: s.deps.Cfg.WalletFeePerLookupPaise,
	}
	if cap.Valid {
		v := int(cap.Int64)
		resp.CapPaise = &v
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) walletBalance(w http.ResponseWriter, r *http.Request) {
	if s.wallet == nil {
		writeErr(w, http.StatusServiceUnavailable, "wallet feature not enabled")
		return
	}
	orgID, ok := s.resolveOrgID(w, r)
	if !ok {
		return
	}
	bal, err := s.wallet.Balance(r.Context(), orgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "balance: "+err.Error())
		return
	}
	// Pagination: ?before=<id> walks backward through history. limit
	// is clamped server-side (1-200). Default page is 50.
	const pageSize = 50
	beforeID, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	hist, err := s.wallet.History(r.Context(), orgID, pageSize, beforeID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "history: "+err.Error())
		return
	}
	txs := make([]walletTxView, 0, len(hist))
	for _, t := range hist {
		txs = append(txs, walletTxView{
			ID:                t.ID,
			Kind:              string(t.Kind),
			AmountPaise:       t.AmountPaise,
			BalanceAfterPaise: t.BalanceAfterPaise,
			RelatedRoll:       t.RelatedRoll,
			ActorUsername:     t.ActorUsername,
			ActorDisplayName:  t.ActorDisplayName,
			Description:       t.Description,
			CreatedAt:         t.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	var nextCursor int64
	// Only emit a cursor when this page filled — a short page means
	// we hit the tail and there's nothing older to fetch.
	if len(hist) == pageSize {
		nextCursor = hist[len(hist)-1].ID
	}
	writeJSON(w, http.StatusOK, walletBalanceResp{
		OrgID:        orgID,
		BalancePaise: bal,
		Transactions: txs,
		NextCursor:   nextCursor,
	})
}

// orderReq is the body the frontend sends when starting a top-up.
type orderReq struct {
	AmountPaise int `json:"amount_paise"`
}

// orderResp is what the frontend feeds into Razorpay Checkout's
// options object — order id is the link between this call and the
// later verify-payment call.
type orderResp struct {
	RazorpayOrderID string `json:"razorpay_order_id"`
	RazorpayKeyID   string `json:"razorpay_key_id"`
	AmountPaise     int    `json:"amount_paise"`
	Currency        string `json:"currency"`
}

// walletOrder creates a Razorpay order so the frontend can launch
// Checkout against it. Admin role only — admins top up their own org
// wallet. Superadmins use adminWalletCredit for manual top-ups
// instead. We don't credit the wallet yet — that happens in
// verify-payment after Razorpay tells us the payment cleared.
func (s *Server) walletOrder(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if s.razorpayCl == nil {
		writeErr(w, http.StatusServiceUnavailable, "razorpay not configured")
		return
	}
	if claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin without org context")
		return
	}
	// Rate limit BEFORE the body parse and the (paid) Razorpay call.
	// Loopback IPs are exempt — see wallet_rate_limit.go for rationale.
	if !s.walletWriteRateOK(w, r, claims.UserID) {
		return
	}
	var req orderReq
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.AmountPaise <= 0 {
		writeErr(w, http.StatusBadRequest, "amount_paise must be > 0")
		return
	}
	maxDeposit := s.deps.Cfg.WalletMaxDepositPaise
	if maxDeposit > 0 && req.AmountPaise > maxDeposit {
		writeErr(w, http.StatusBadRequest,
			fmt.Sprintf("amount_paise exceeds max single deposit of %d paise", maxDeposit))
		return
	}
	// Receipt includes user_id so two admins of the same org topping up
	// in the same second don't collide. Razorpay doesn't enforce
	// receipt uniqueness, but downstream reconciliation against
	// Razorpay's settlement reports does, so distinct receipts matter.
	receipt := fmt.Sprintf("wallet-org%d-u%d-%d", *claims.OrgID, claims.UserID, nowUnix())
	o, err := s.razorpayCl.CreateOrder(r.Context(), req.AmountPaise, receipt)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "razorpay order: "+err.Error())
		return
	}
	// Record the order server-side so verify-payment + webhook can
	// validate against canonical values (org, amount) instead of
	// trusting the browser. Failure here is fatal — without the
	// stored row, verify-payment would later refuse this order_id
	// and the user would never get credited. Better to refuse the
	// order up front; the user retries, gets a fresh order, the
	// orphan order at Razorpay auto-expires in 15 min. See orders.go
	// for the ordering rationale.
	if err := s.wallet.SaveOrder(r.Context(), wallet.Order{
		RazorpayOrderID: o.ID,
		OrgID:           *claims.OrgID,
		ActorUserID:     claims.UserID,
		AmountPaise:     o.Amount,
		Receipt:         receipt,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "save order: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, orderResp{
		RazorpayOrderID: o.ID,
		RazorpayKeyID:   s.razorpayCl.KeyID(),
		AmountPaise:     o.Amount,
		Currency:        o.Currency,
	})
}

// verifyReqBody carries the three values Razorpay Checkout hands back
// to the browser after a successful payment.
//
// AmountPaise is now informational only — the server uses the canonical
// amount stored in razorpay_orders at order-creation time. We still
// accept the field (frontend back-compat) but never trust it. See
// CRITICAL #1 in the payment audit and migration_013_razorpay_orders.
type verifyReqBody struct {
	RazorpayOrderID   string `json:"razorpay_order_id"`
	RazorpayPaymentID string `json:"razorpay_payment_id"`
	RazorpaySignature string `json:"razorpay_signature"`
	AmountPaise       int    `json:"amount_paise"` // CLIENT CLAIM — NOT TRUSTED
}

type verifyResp struct {
	BalancePaise  int   `json:"balance_paise"`
	TransactionID int64 `json:"transaction_id"`
	Replayed      bool  `json:"replayed"` // true if this payment was already credited
}

// walletVerifyPayment verifies the Razorpay HMAC signature and credits
// the admin's org wallet. Idempotent: replaying the same razorpay_payment_id
// (e.g. because the browser refreshed before we replied) returns the
// original row instead of double-crediting. The DB-level UNIQUE INDEX on
// razorpay_payment_id is the ultimate guarantee.
func (s *Server) walletVerifyPayment(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if s.razorpayCl == nil || s.wallet == nil {
		writeErr(w, http.StatusServiceUnavailable, "wallet not configured")
		return
	}
	if claims.OrgID == nil {
		writeErr(w, http.StatusForbidden, "admin without org context")
		return
	}
	// Same shared limiter as walletOrder — burns the same per-user
	// budget. An attacker can't evade by rotating between endpoints.
	if !s.walletWriteRateOK(w, r, claims.UserID) {
		return
	}
	var req verifyReqBody
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	// AmountPaise is intentionally NOT checked here — see comment on
	// verifyReqBody. The canonical amount comes from razorpay_orders.
	if req.RazorpayOrderID == "" || req.RazorpayPaymentID == "" ||
		req.RazorpaySignature == "" {
		writeErr(w, http.StatusBadRequest, "missing fields")
		return
	}
	// First: idempotency. If we already credited this payment, return
	// the existing transaction without re-touching anything.
	if existing, err := s.wallet.FindByRazorpayPaymentID(r.Context(), req.RazorpayPaymentID); err != nil {
		writeErr(w, http.StatusInternalServerError, "history: "+err.Error())
		return
	} else if existing != nil {
		if existing.OrgID != *claims.OrgID {
			// Defensive: payment_id should never appear for two orgs.
			writeErr(w, http.StatusForbidden, "payment_id belongs to a different org")
			return
		}
		bal, _ := s.wallet.Balance(r.Context(), *claims.OrgID)
		writeJSON(w, http.StatusOK, verifyResp{
			BalancePaise:  bal,
			TransactionID: existing.ID,
			Replayed:      true,
		})
		return
	}
	// Look up the canonical order we created during /api/wallet/order.
	// This is the security-critical step that fixes the "claimed amount"
	// exploit (CRITICAL #1) and the cross-org replay (CRITICAL #2). All
	// downstream values — amount, target org — come from this row, not
	// from `req`. A forged order_id (one we never created) is rejected
	// with 400 here. We return a generic message that doesn't leak
	// whether the order_id exists at all.
	order, err := s.wallet.FindOrder(r.Context(), req.RazorpayOrderID)
	if err != nil {
		if errors.Is(err, wallet.ErrOrderNotFound) {
			writeErr(w, http.StatusBadRequest, "unknown order")
			return
		}
		writeErr(w, http.StatusInternalServerError, "order lookup: "+err.Error())
		return
	}
	if order.OrgID != *claims.OrgID {
		// Admin B trying to claim admin A's order. Possible only via
		// XSS / shared-device / leaked logs. Refuse hard.
		writeErr(w, http.StatusForbidden, "order belongs to a different org")
		return
	}
	// Verify the HMAC signature against the configured KeySecret. If it
	// doesn't match, the payment_id is either forged or the order_id
	// got mangled in transit — refuse to credit.
	if !s.razorpayCl.VerifySignature(req.RazorpayOrderID, req.RazorpayPaymentID, req.RazorpaySignature) {
		writeErr(w, http.StatusBadRequest, "signature verification failed")
		return
	}
	// Credit the wallet using the server-stored amount. The client's
	// claim in req.AmountPaise is intentionally discarded.
	tx, err := s.wallet.Credit(r.Context(), *claims.OrgID, claims.UserID, order.AmountPaise,
		wallet.KindDeposit, req.RazorpayOrderID, req.RazorpayPaymentID,
		"Razorpay top-up")
	if err != nil {
		if errors.Is(err, wallet.ErrInvalidAmount) {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		// Race recovery: two concurrent verify-payment calls with the
		// same payment_id could both pass the idempotency check above
		// before either inserts a transaction. The UNIQUE index on
		// razorpay_payment_id catches the loser; we re-resolve the
		// committed row and return it as a replay rather than a 500.
		if existing, lookupErr := s.wallet.FindByRazorpayPaymentID(r.Context(), req.RazorpayPaymentID); lookupErr == nil && existing != nil {
			if existing.OrgID == *claims.OrgID {
				bal, _ := s.wallet.Balance(r.Context(), *claims.OrgID)
				writeJSON(w, http.StatusOK, verifyResp{
					BalancePaise:  bal,
					TransactionID: existing.ID,
					Replayed:      true,
				})
				return
			}
		}
		writeErr(w, http.StatusInternalServerError, "credit: "+err.Error())
		return
	}
	// Flip the order's status to 'verified' — best-effort. If this fails
	// the wallet credit (the security-critical bit) is already done.
	_ = s.wallet.MarkOrderVerified(r.Context(), req.RazorpayOrderID)
	s.auditFromRequest(r, "wallet.deposit", "org", *claims.OrgID, map[string]any{
		"amount_paise":        order.AmountPaise,
		"client_claimed_paise": req.AmountPaise, // for forensic audit if it diverges
		"transaction_id":      tx.ID,
		"razorpay_payment_id": req.RazorpayPaymentID,
		"razorpay_order_id":   req.RazorpayOrderID,
	})
	writeJSON(w, http.StatusOK, verifyResp{
		BalancePaise:  tx.BalanceAfterPaise,
		TransactionID: tx.ID,
		Replayed:      false,
	})
}

// adminCreditReq lets a superadmin manually top up an org's wallet
// for support cases ("org ran out mid-exam, credit them ₹500 while
// they sort out a Razorpay issue").
type adminCreditReq struct {
	OrgID       int64  `json:"org_id"`
	AmountPaise int    `json:"amount_paise"`
	Note        string `json:"note"`
}

func (s *Server) adminWalletCredit(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if s.wallet == nil {
		writeErr(w, http.StatusServiceUnavailable, "wallet feature not enabled")
		return
	}
	// Superadmin manual credit is a privileged, low-frequency action
	// (a few times per month max). The same 15/5min budget is overkill
	// for normal use and still tight against a compromised superadmin
	// token spamming credits to a colluding org.
	if !s.walletWriteRateOK(w, r, claims.UserID) {
		return
	}
	var req adminCreditReq
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.OrgID <= 0 || req.AmountPaise <= 0 {
		writeErr(w, http.StatusBadRequest, "org_id and amount_paise required")
		return
	}
	note := strings.TrimSpace(req.Note)
	if note == "" {
		note = "Superadmin manual credit"
	}
	tx, err := s.wallet.Credit(r.Context(), req.OrgID, claims.UserID, req.AmountPaise,
		wallet.KindAdminCredit, "", "", note)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "credit: "+err.Error())
		return
	}
	s.auditFromRequest(r, "wallet.admin_credit", "org", req.OrgID, map[string]any{
		"amount_paise":   req.AmountPaise,
		"transaction_id": tx.ID,
		"note":           note,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"transaction_id": tx.ID,
		"new_balance":    tx.BalanceAfterPaise,
		"org_id":         req.OrgID,
	})
}

func nowUnix() int64 {
	return time.Now().Unix()
}
