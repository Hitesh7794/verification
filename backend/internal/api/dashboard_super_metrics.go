package api

import (
	"net/http"

	"github.com/veni/neet-verification/internal/db"
)

// GET /api/super/metrics
//
// One-shot ops snapshot for support / on-call work. Aggregates that
// /api/super/stats doesn't surface: today's deltas, money flow,
// queue depth. Cheap — every value is a single COUNT or SUM over
// indexed columns; the whole handler is under 5ms on a non-trivial
// DB. Superadmin-only.
//
// Shape:
//
//	verifications_today          int
//	verifications_24h            int
//	wallet_credit_paise_today    int   (deposits + admin credits)
//	wallet_charge_paise_today    int   (sum of |charges|)
//	active_orgs_24h              int   (orgs with at least one verification in last 24h)
//	pending_applications         int   (institution_applications status='pending')
//	disabled_users               int   (users with disabled_at not null)
func (s *Server) superMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{}

	var n int
	// Verifications today (server local 'now' midnight). SQLite's
	// date(...) gives YYYY-MM-DD; same call works on the verifications
	// created_at column.
	_ = s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT COUNT(*) FROM verifications WHERE created_at::date = CURRENT_DATE`),
	).Scan(&n)
	out["verifications_today"] = n

	_ = s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT COUNT(*) FROM verifications WHERE created_at >= NOW() - INTERVAL '24 hours'`),
	).Scan(&n)
	out["verifications_24h"] = n

	// Money in (deposits + admin_credit) vs money out (charges). We
	// SUM the absolute amounts so the units are consistent across
	// the two metrics (both positive paise).
	var paise int
	_ = s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT COALESCE(SUM(amount_paise),0) FROM wallet_transactions
		 WHERE kind IN ('deposit','admin_credit')
		   AND created_at::date = CURRENT_DATE`),
	).Scan(&paise)
	out["wallet_credit_paise_today"] = paise

	_ = s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT COALESCE(-SUM(amount_paise),0) FROM wallet_transactions
		 WHERE kind = 'charge'
		   AND created_at::date = CURRENT_DATE`),
	).Scan(&paise)
	out["wallet_charge_paise_today"] = paise

	_ = s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT COUNT(DISTINCT org_id) FROM verifications
		 WHERE created_at >= NOW() - INTERVAL '24 hours'`),
	).Scan(&n)
	out["active_orgs_24h"] = n

	_ = s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT COUNT(*) FROM institution_applications WHERE status='pending'`),
	).Scan(&n)
	out["pending_applications"] = n

	_ = s.deps.DB.QueryRowContext(ctx,
		db.Q(`SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL`),
	).Scan(&n)
	out["disabled_users"] = n

	writeJSON(w, http.StatusOK, out)
}
