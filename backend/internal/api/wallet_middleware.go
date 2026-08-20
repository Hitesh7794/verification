package api

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/veni/neet-verification/internal/wallet"
)

// walletCharge wraps a handler so that client-role lookups are billed
// against the operator's *organisation* wallet. Admin / superadmin
// lookups pass through without charge.
//
// The charge happens AFTER the wrapped handler returns a 2xx response.
// Previously we debited before the handler ran, which had the nasty
// property that a 404 (e.g. roll not found, candidate index missing
// the photo file) still cost the operator money. We now buffer the
// inner handler's response, inspect the status, and:
//
//   - response 2xx     → debit, flush response with X-Wallet headers
//   - response 4xx/5xx → no debit, flush response untouched
//   - cache hit        → no debit, flush response (already paid)
//   - insufficient pre-check OR atomic debit failure → 402, don't flush
//
// The buffered approach trades a small response-latency tax for
// guaranteed "no charge for failed lookups" behaviour. The lookup
// payload (a small JSON of candidate metadata) easily fits in memory,
// so buffering is cheap.
func (s *Server) walletCharge(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := claimsFrom(r)

		// Charge applies to client role only. Admin / superadmin lookups
		// stay free.
		if claims.Role != "client" || s.wallet == nil || s.deps.Cfg.WalletFeePerLookupPaise <= 0 {
			next(w, r)
			return
		}
		if claims.OrgID == nil {
			writeErr(w, http.StatusInternalServerError, "verification agent missing org context")
			return
		}
		orgID := *claims.OrgID
		fee := s.deps.Cfg.WalletFeePerLookupPaise
		roll := chi.URLParam(r, "roll")

		// 0. Operator-level pre-checks (date window). The cap check
		// happens later — after the same-roll cache — so a free
		// re-check doesn't get blocked by an exhausted cap.
		var (
			cap   sql.NullInt64
			spent int64
			vFrom sql.NullString
			vTo   sql.NullString
		)
		err := s.deps.DB.QueryRowContext(r.Context(),
			`SELECT spending_cap_paise, spent_paise, valid_from, valid_to
			   FROM users WHERE id = $1`, claims.UserID,
		).Scan(&cap, &spent, &vFrom, &vTo)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusInternalServerError, "verification agent lookup: "+err.Error())
			return
		}
		today := time.Now().UTC().Format("2006-01-02")
		if vFrom.Valid && today < normaliseYMD(vFrom.String) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(fmt.Sprintf(
				`{"error":"operator not active until %s","valid_from":"%s"}`,
				normaliseYMD(vFrom.String), normaliseYMD(vFrom.String))))
			return
		}
		if vTo.Valid && today > normaliseYMD(vTo.String) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(fmt.Sprintf(
				`{"error":"operator access expired on %s","valid_to":"%s"}`,
				normaliseYMD(vTo.String), normaliseYMD(vTo.String))))
			return
		}

		// 1. Same-roll cache: any operator in this org already paid for
		// this roll recently → no debit, run the handler normally.
		// Cap doesn't apply here — this operator (or a colleague at the
		// same org) already paid.
		if cacheMin := s.deps.Cfg.WalletSameRollCacheMin; cacheMin > 0 && roll != "" {
			hit, err := s.wallet.HasRecentChargeForRoll(r.Context(), orgID, roll, cacheMin)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "wallet cache: "+err.Error())
				return
			}
			if hit {
				bal, _ := s.wallet.Balance(r.Context(), orgID)
				setWalletHeaders(w, bal, 0)
				next(w, r)
				return
			}
		}

		// 1.5. Cap check runs AFTER the cache. Purpose: block only new
		// spend, not free re-checks. Same message shape the frontend
		// expects for wallet-empty (402).
		if cap.Valid && spent+int64(fee) > cap.Int64 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusPaymentRequired)
			_, _ = w.Write([]byte(fmt.Sprintf(
				`{"error":"verification agent spending cap reached; ask your admin to raise it","spent_paise":%d,"cap_paise":%d,"fee_paise":%d}`,
				spent, cap.Int64, fee)))
			return
		}

		// 2. Pre-check funds so an underfunded org fails fast without
		// burning a database lookup on the inner handler. The atomic
		// Debit later still protects against concurrent overdraws.
		bal, err := s.wallet.Balance(r.Context(), orgID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "wallet balance: "+err.Error())
			return
		}
		if bal < fee {
			setWalletHeaders(w, bal, 0)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusPaymentRequired)
			_, _ = w.Write([]byte(fmt.Sprintf(
				`{"error":"insufficient organisation wallet balance","balance_paise":%d,"fee_paise":%d}`,
				bal, fee)))
			return
		}

		// 3. Run the inner handler against a buffered writer so we can
		// decide whether to debit based on the response status.
		buf := newBufferedResponseWriter(w)
		next(buf, r)

		// 4. Inner handler failed → flush untouched, no debit.
		if buf.status < 200 || buf.status >= 300 {
			buf.flush()
			return
		}

		// 5. Inner handler succeeded → debit. Atomic UPDATE handles
		// concurrent debits; the only realistic failure is a race
		// where another operator drained the wallet between our
		// pre-check and now. In that edge case we still serve the
		// data we already produced (the work is done, the cost to
		// the org is zero — operator got one effectively-free
		// lookup) and log the warning via the wallet header.
		tx, err := s.wallet.Debit(r.Context(), orgID, claims.UserID, fee, roll,
			fmt.Sprintf("Candidate lookup roll=%s", roll))
		if err != nil {
			if errors.Is(err, wallet.ErrInsufficient) {
				// Race-rare: serve the buffered response anyway, but
				// mark X-Wallet-Charged-Paise = 0 so observers know
				// no money moved. Pre-check passed but concurrent
				// debit drained us.
				setWalletHeaders(buf.ResponseWriter, bal, 0)
				buf.flush()
				return
			}
			// Genuine error path — bail before flushing so the
			// caller sees the failure, not a stale candidate body.
			writeErr(w, http.StatusInternalServerError, "wallet debit: "+err.Error())
			return
		}
		// spent_paise is now bumped atomically inside wallet.Debit(),
		// tied to the same tx as the org wallet debit + ledger row.
		// See the comment there for why the split was removed.
		setWalletHeaders(buf.ResponseWriter, tx.BalanceAfterPaise, fee)
		buf.flush()
	}
}

// normaliseYMD accepts either a raw YYYY-MM-DD or a SQLite DATETIME
// string (`YYYY-MM-DD HH:MM:SS`) and returns just the date component.
// SQLite is lax about the DATE type: values inserted as `2026-08-15`
// come back verbatim, but values that went through a DATETIME column
// promotion or `CURRENT_TIMESTAMP` default may include a time part.
func normaliseYMD(s string) string {
	if len(s) >= 10 {
		return s[:10]
	}
	return s
}

func setWalletHeaders(w http.ResponseWriter, balance, charged int) {
	w.Header().Set("X-Wallet-Balance-Paise", fmt.Sprintf("%d", balance))
	w.Header().Set("X-Wallet-Charged-Paise", fmt.Sprintf("%d", charged))
}

// bufferedResponseWriter buffers the inner handler's headers, status
// code, and body so a wrapping middleware can decide post-hoc whether
// to emit them. Headers added on this writer are NOT yet visible on
// the underlying ResponseWriter; flush() copies them across and writes
// the buffered body. Headers added directly on ResponseWriter between
// next() and flush() are preserved (the wallet middleware uses this
// to add X-Wallet-* headers after deciding to charge).
type bufferedResponseWriter struct {
	http.ResponseWriter
	hdr         http.Header
	body        bytes.Buffer
	status      int
	wroteHeader bool
}

func newBufferedResponseWriter(w http.ResponseWriter) *bufferedResponseWriter {
	return &bufferedResponseWriter{
		ResponseWriter: w,
		hdr:            http.Header{},
		status:         http.StatusOK,
	}
}

func (b *bufferedResponseWriter) Header() http.Header {
	return b.hdr
}

func (b *bufferedResponseWriter) WriteHeader(code int) {
	if b.wroteHeader {
		return
	}
	b.status = code
	b.wroteHeader = true
}

func (b *bufferedResponseWriter) Write(p []byte) (int, error) {
	if !b.wroteHeader {
		b.wroteHeader = true
	}
	return b.body.Write(p)
}

// flush copies buffered headers + status + body to the underlying
// ResponseWriter. Safe to call exactly once after the inner handler
// returns.
func (b *bufferedResponseWriter) flush() {
	dst := b.ResponseWriter.Header()
	for k, vs := range b.hdr {
		// Don't overwrite headers that the wrapping middleware set
		// (e.g. X-Wallet-* added between next() and flush()).
		if _, exists := dst[k]; exists {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
	b.ResponseWriter.WriteHeader(b.status)
	_, _ = b.ResponseWriter.Write(b.body.Bytes())
}
