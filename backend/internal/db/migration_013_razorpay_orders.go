package db

// migration013RazorpayOrders adds a server-side record of every Razorpay
// order we create, so the verify-payment + webhook handlers can validate
// (a) that an order_id is one WE created (not forged or replayed across
// accounts), (b) which org it belongs to, and (c) what amount we asked
// Razorpay for.
//
// Background — why this table exists:
//   Before migration 013, walletVerifyPayment trusted the browser's
//   `amount_paise` field. HMAC signed `(order_id|payment_id)` but NOT
//   the amount, so a malicious admin could pay ₹1 then call verify with
//   amount_paise=5000000 and have the wallet credited ₹50,000. Storing
//   the canonical amount at order-creation time means we never have to
//   ask the browser; verify-payment looks the amount up here.
//
// Cross-org defence in depth:
//   The org_id column lets verify-payment reject "admin B uses admin A's
//   order_id triple" — the stored org_id wouldn't match B's claims.OrgID.
//
// Schema notes:
//   - razorpay_order_id is the natural PK; Razorpay guarantees its IDs
//     are globally unique within an account so we don't need a synthetic
//     id column.
//   - status: 'created' on insert, 'verified' once payment is credited.
//     A separate 'expired' state is reserved for a future sweeper that
//     would mop up orders we never heard back on (Razorpay expires
//     unpaid orders after 15 minutes by default).
//   - receipt is the same string we pass to Razorpay (`wallet-orgN-ts`).
//     Storing it makes reconciliation against Razorpay's settlement
//     reports trivial: search by receipt to find the matching org row.
//   - actor_user_id captures which admin clicked Deposit — useful for
//     the wallet history and matches the convention used by
//     wallet_transactions.actor_user_id.
//   - verified_at is NULL until the order is credited; non-NULL after.
var migration013RazorpayOrders = migration{
	version: 13,
	name:    "razorpay_orders",
	stmts: []string{
		`CREATE TABLE razorpay_orders (
			razorpay_order_id   TEXT PRIMARY KEY,
			org_id              INTEGER NOT NULL REFERENCES organizations(id),
			actor_user_id       INTEGER NOT NULL REFERENCES users(id),
			amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
			receipt             TEXT NOT NULL,
			status              TEXT NOT NULL DEFAULT 'created'
				CHECK (status IN ('created','verified','expired')),
			created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			verified_at         DATETIME
		)`,
		// Admin history view ("which deposits did we initiate?") + the
		// audit query "show me all orders for org N this month".
		`CREATE INDEX idx_razorpay_orders_org_created
			ON razorpay_orders(org_id, created_at DESC)`,
	},
}
