package api

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/wallet"
)

// walletCharge wraps a handler so that client-role users are billed
// WalletFeePerLookupPaise before the wrapped handler runs. Admin /
// superadmin users pass through without charge (this matches the
// requirement: "only the client gets the wallet").
//
// Cache: if the same client looks up the same roll within
// WalletSameRollCacheMin minutes, no extra charge. Prevents
// double-billing on browser refreshes and accidental double-clicks.
//
// Failure modes:
//   - balance below fee   → HTTP 402 { error, balance_paise } + X-Wallet headers
//   - wallet store error  → HTTP 500
//   - fee == 0            → middleware is a no-op (wallet feature
//                           disabled for this deployment)
//
// On success the response gains:
//   X-Wallet-Balance-Paise: <new balance>
//   X-Wallet-Charged-Paise: <amount charged this request, 0 if cached/free>
//
// The frontend reads those headers (also re-fetches /api/wallet on
// success) to keep the WalletWidget in sync.
func (s *Server) walletCharge(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := claimsFrom(r)

		// Charge applies to client role only. Admin / superadmin lookups
		// (for audit, support, etc.) stay free.
		if claims.Role != "client" || s.wallet == nil || s.deps.Cfg.WalletFeePerLookupPaise <= 0 {
			next(w, r)
			return
		}

		fee := s.deps.Cfg.WalletFeePerLookupPaise
		roll := chi.URLParam(r, "roll")

		// Cache check: did this user already pay for this roll recently?
		// If so, skip the charge but still record the request.
		if cacheMin := s.deps.Cfg.WalletSameRollCacheMin; cacheMin > 0 && roll != "" {
			hit, err := s.wallet.HasRecentChargeForRoll(r.Context(), claims.UserID, roll, cacheMin)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "wallet cache: "+err.Error())
				return
			}
			if hit {
				bal, _ := s.wallet.Balance(r.Context(), claims.UserID)
				setWalletHeaders(w, bal, 0)
				next(w, r)
				return
			}
		}

		// Debit. ErrInsufficient → 402 with the current balance so the
		// frontend's LowBalanceModal can render meaningfully.
		tx, err := s.wallet.Debit(r.Context(), claims.UserID, fee, roll,
			fmt.Sprintf("Candidate lookup roll=%s", roll))
		if err != nil {
			if errors.Is(err, wallet.ErrInsufficient) {
				bal, _ := s.wallet.Balance(r.Context(), claims.UserID)
				setWalletHeaders(w, bal, 0)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusPaymentRequired)
				_, _ = w.Write([]byte(fmt.Sprintf(
					`{"error":"insufficient wallet balance","balance_paise":%d,"fee_paise":%d}`,
					bal, fee)))
				return
			}
			writeErr(w, http.StatusInternalServerError, "wallet debit: "+err.Error())
			return
		}
		setWalletHeaders(w, tx.BalanceAfterPaise, fee)
		next(w, r)
	}
}

func setWalletHeaders(w http.ResponseWriter, balance, charged int) {
	w.Header().Set("X-Wallet-Balance-Paise", fmt.Sprintf("%d", balance))
	w.Header().Set("X-Wallet-Charged-Paise", fmt.Sprintf("%d", charged))
}
