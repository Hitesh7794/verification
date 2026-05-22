package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/veni/neet-verification/internal/wallet"
)

// Wallet endpoints — client-role only (admin/superadmin don't have
// wallets in this design). Routes are wired in server.go.
//
// All amounts on the wire are paise (integer). The frontend formats
// these as ₹ X.YZ for display.

// walletConfigResp tells the frontend the deployment's wallet tunables
// so the UI knows what amount to debit per lookup, the deposit cap, and
// whether the wallet feature is even available (key_id present).
type walletConfigResp struct {
	FeePerLookupPaise int    `json:"fee_per_lookup_paise"`
	MaxDepositPaise   int    `json:"max_deposit_paise"`
	Currency          string `json:"currency"`
	RazorpayKeyID     string `json:"razorpay_key_id"`     // public key
	RazorpayEnabled   bool   `json:"razorpay_enabled"`    // false → DepositModal disabled
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
		SameRollCacheMin:  cfg.WalletSameRollCacheMin,
	})
}

type walletBalanceResp struct {
	BalancePaise int                `json:"balance_paise"`
	Transactions []walletTxView     `json:"transactions"`
}

type walletTxView struct {
	ID                int64  `json:"id"`
	Kind              string `json:"kind"`
	AmountPaise       int    `json:"amount_paise"`
	BalanceAfterPaise int    `json:"balance_after_paise"`
	RelatedRoll       string `json:"related_roll,omitempty"`
	Description       string `json:"description,omitempty"`
	CreatedAt         string `json:"created_at"`
}

func (s *Server) walletBalance(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if s.wallet == nil {
		writeErr(w, http.StatusServiceUnavailable, "wallet feature not enabled")
		return
	}
	bal, err := s.wallet.Balance(r.Context(), claims.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "balance: "+err.Error())
		return
	}
	hist, err := s.wallet.History(r.Context(), claims.UserID, 50)
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
			Description:       t.Description,
			CreatedAt:         t.CreatedAt.UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	writeJSON(w, http.StatusOK, walletBalanceResp{
		BalancePaise: bal,
		Transactions: txs,
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
// Checkout against it. We don't credit the wallet yet — that happens
// in verify-payment after Razorpay tells us the payment cleared.
func (s *Server) walletOrder(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if s.razorpayCl == nil {
		writeErr(w, http.StatusServiceUnavailable, "razorpay not configured")
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
	receipt := fmt.Sprintf("wallet-u%d-%d", claims.UserID, nowUnix())
	o, err := s.razorpayCl.CreateOrder(r.Context(), req.AmountPaise, receipt)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "razorpay order: "+err.Error())
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
type verifyReqBody struct {
	RazorpayOrderID   string `json:"razorpay_order_id"`
	RazorpayPaymentID string `json:"razorpay_payment_id"`
	RazorpaySignature string `json:"razorpay_signature"`
	AmountPaise       int    `json:"amount_paise"` // the amount the user thought they paid
}

type verifyResp struct {
	BalancePaise  int   `json:"balance_paise"`
	TransactionID int64 `json:"transaction_id"`
	Replayed      bool  `json:"replayed"` // true if this payment was already credited
}

// walletVerifyPayment verifies the Razorpay HMAC signature and credits
// the wallet. Idempotent: replaying the same razorpay_payment_id (e.g.
// because the browser refreshed before we replied) returns the original
// row instead of double-crediting. The DB-level UNIQUE INDEX on
// razorpay_payment_id is the ultimate guarantee.
func (s *Server) walletVerifyPayment(w http.ResponseWriter, r *http.Request) {
	claims := claimsFrom(r)
	if s.razorpayCl == nil || s.wallet == nil {
		writeErr(w, http.StatusServiceUnavailable, "wallet not configured")
		return
	}
	var req verifyReqBody
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.RazorpayOrderID == "" || req.RazorpayPaymentID == "" ||
		req.RazorpaySignature == "" || req.AmountPaise <= 0 {
		writeErr(w, http.StatusBadRequest, "missing fields")
		return
	}
	// First: idempotency. If we already credited this payment, return
	// the existing transaction without re-touching anything.
	if existing, err := s.wallet.FindByRazorpayPaymentID(r.Context(), req.RazorpayPaymentID); err != nil {
		writeErr(w, http.StatusInternalServerError, "history: "+err.Error())
		return
	} else if existing != nil {
		if existing.UserID != claims.UserID {
			// Defensive: payment_id should never appear for two users.
			writeErr(w, http.StatusForbidden, "payment_id belongs to a different user")
			return
		}
		bal, _ := s.wallet.Balance(r.Context(), claims.UserID)
		writeJSON(w, http.StatusOK, verifyResp{
			BalancePaise:  bal,
			TransactionID: existing.ID,
			Replayed:      true,
		})
		return
	}
	// Verify the HMAC signature against the configured KeySecret. If it
	// doesn't match, the payment_id is either forged or the order_id
	// got mangled in transit — refuse to credit.
	if !s.razorpayCl.VerifySignature(req.RazorpayOrderID, req.RazorpayPaymentID, req.RazorpaySignature) {
		writeErr(w, http.StatusBadRequest, "signature verification failed")
		return
	}
	// Credit the wallet.
	tx, err := s.wallet.Credit(r.Context(), claims.UserID, req.AmountPaise,
		wallet.KindDeposit, req.RazorpayOrderID, req.RazorpayPaymentID,
		"Razorpay top-up")
	if err != nil {
		if errors.Is(err, wallet.ErrInvalidAmount) {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "credit: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, verifyResp{
		BalancePaise:  tx.BalanceAfterPaise,
		TransactionID: tx.ID,
		Replayed:      false,
	})
}

// adminCreditReq lets an admin or superadmin manually top up another
// user's wallet. Useful for "operator ran out mid-exam, give them ₹500."
type adminCreditReq struct {
	UserID      int64  `json:"user_id"`
	AmountPaise int    `json:"amount_paise"`
	Note        string `json:"note"`
}

func (s *Server) adminWalletCredit(w http.ResponseWriter, r *http.Request) {
	if s.wallet == nil {
		writeErr(w, http.StatusServiceUnavailable, "wallet feature not enabled")
		return
	}
	var req adminCreditReq
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.UserID <= 0 || req.AmountPaise <= 0 {
		writeErr(w, http.StatusBadRequest, "user_id and amount_paise required")
		return
	}
	note := strings.TrimSpace(req.Note)
	if note == "" {
		note = "Admin manual credit"
	}
	tx, err := s.wallet.Credit(r.Context(), req.UserID, req.AmountPaise,
		wallet.KindAdminCredit, "", "", note)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "credit: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"transaction_id": tx.ID,
		"new_balance":    tx.BalanceAfterPaise,
		"user_id":        req.UserID,
	})
}

func nowUnix() int64 {
	return time.Now().Unix()
}
