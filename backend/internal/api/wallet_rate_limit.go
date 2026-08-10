package api

import (
	"net/http"
	"strconv"
	"time"
)

// Wallet write-operations rate limiter.
//
// Targets the three "money-moving" wallet endpoints — walletOrder,
// walletVerifyPayment, adminWalletCredit — that either burn a
// Razorpay API call (order creation costs us quota + carries a small
// per-call fee even when no payment completes) or touch the wallet
// ledger directly (admin credit). The audit (PR-1 §HIGH #2) flagged
// these as DoSable from a compromised admin token: an attacker
// holding a valid JWT could spam thousands of order creations,
// blowing through our Razorpay quota and racking up costs.
//
// Keyed by user_id, NOT by IP. Why: a college's operators sit
// behind one NAT, so an IP-based limit would throttle the whole
// institution when one operator (or attacker) misbehaves. User-id
// keying isolates the blast radius.
//
// Loopback / private-network exemption (via shouldRateLimit) keeps
// dev + LAN testing flowing without spurious 429s. Production
// deployments behind nginx are seen as the X-Forwarded-For client
// (public IP), so real internet traffic is throttled normally.
//
// 15 requests per 5 minutes per user is the chosen budget:
//   - normal use ~ 1-2 deposits per day per admin → nowhere near
//   - typo correction / card-decline retry ~ 2-3 in a row → still fine
//   - flaky network triggering browser-side verify retries ~ 5-10 → fine
//   - compromised-token spam → 15 attempts then 429 for 5 min
//     = max 180 Razorpay order creations / hour from one user
//
// Lives in a single shared limiter rather than per-endpoint so the
// overall budget is what counts; we don't want an attacker rotating
// between order + verify to evade.
var globalWalletWriteLimiter = newRegisterLimiter(15, 5*time.Minute)

// walletWriteRateOK returns true if the request should proceed. If
// false, a 429 has already been written and the caller must return
// without doing more work.
//
// Call AFTER extracting claims (so we know the user_id), BEFORE any
// expensive work like body parse, DB read, or upstream API call.
func (s *Server) walletWriteRateOK(w http.ResponseWriter, r *http.Request, userID int64) bool {
	if !shouldRateLimit(clientIP(r)) {
		// Loopback / private / LAN traffic — never throttled.
		return true
	}
	key := strconv.FormatInt(userID, 10)
	if !globalWalletWriteLimiter.allow(key) {
		writeErr(w, http.StatusTooManyRequests,
			"too many wallet operations; please wait a minute and try again")
		return false
	}
	return true
}
