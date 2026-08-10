package db

// migration008OrgWallets rebuilds the wallet schema so the wallet
// belongs to the organisation, not the individual operator. Rationale:
// money is owned by the institution; operators (client role) act on
// behalf of the org but never see or manage funds. Admin/superadmin
// are the only roles that see a balance, deposit, or view history.
//
// Schema change:
//   - wallets.user_id  → wallets.org_id    (one wallet per institution)
//   - wallet_transactions.user_id          → wallet_transactions.org_id
//   - wallet_transactions.actor_user_id    (new, nullable)
//
// actor_user_id records who triggered a transaction (which operator's
// candidate lookup caused this charge; which admin clicked Deposit).
// Useful for the admin's "who spent the money" view, and nullable so
// system-driven rows (e.g. refunds) don't need a synthetic user.
//
// Data preservation: there is no live deployment to preserve data for.
// Earlier dev/test transactions on the per-user model are discarded.
// We DROP and recreate; cleaner than the SQLite 12-step rename dance
// and the only cost is local devs needing to re-fund a test org wallet.
var migration008OrgWallets = migration{
	version: 8,
	name:    "org_wallets",
	stmts: []string{
		`DROP INDEX IF EXISTS idx_wallet_tx_user_created`,
		`DROP INDEX IF EXISTS idx_wallet_tx_user_roll_created`,
		`DROP INDEX IF EXISTS idx_wallet_tx_razorpay_payment`,
		`DROP TABLE IF EXISTS wallet_transactions`,
		`DROP TABLE IF EXISTS wallets`,

		`CREATE TABLE wallets (
			org_id        INTEGER PRIMARY KEY REFERENCES organizations(id),
			balance_paise INTEGER NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
			created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		// Same kinds as before: deposit (Razorpay), charge (lookup fee),
		// admin_credit (manual superadmin top-up), refund (reserved).
		// actor_user_id is the operator who looked up a candidate (for
		// charge rows) or the admin who initiated the deposit / credit.
		// Nullable so a future system-driven row can leave it empty.
		`CREATE TABLE wallet_transactions (
			id                   INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id               INTEGER NOT NULL REFERENCES organizations(id),
			actor_user_id        INTEGER REFERENCES users(id),
			kind                 TEXT NOT NULL CHECK (kind IN ('deposit','charge','admin_credit','refund')),
			amount_paise         INTEGER NOT NULL,
			balance_after_paise  INTEGER NOT NULL,
			related_roll         TEXT,
			razorpay_order_id    TEXT,
			razorpay_payment_id  TEXT,
			description          TEXT,
			created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX idx_wallet_tx_org_created
			ON wallet_transactions(org_id, created_at)`,
		// Same-roll dedup: was (user_id, related_roll, created_at); now
		// (org_id, related_roll, created_at). Bonus: two operators in the
		// same org looking up the same candidate within the cache window
		// only get charged once — desirable behaviour.
		`CREATE INDEX idx_wallet_tx_org_roll_created
			ON wallet_transactions(org_id, related_roll, created_at)
			WHERE related_roll IS NOT NULL`,
		`CREATE UNIQUE INDEX idx_wallet_tx_razorpay_payment
			ON wallet_transactions(razorpay_payment_id)
			WHERE razorpay_payment_id IS NOT NULL`,
	},
}
