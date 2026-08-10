package db

var migration005Wallets = migration{
	version: 5,
	name:    "wallets",
	stmts: []string{
		// Per-user wallet. One row per user; only client-role users
		// actually have a balance (we still create rows lazily so
		// admin/superadmin can be credited if business logic ever
		// extends). Currency is stored in paise (integer) to avoid
		// floating-point money bugs — ₹10.50 = 1050 paise. Balance
		// can never go negative thanks to the CHECK constraint;
		// the debit path uses an UPDATE ... WHERE balance >= N
		// pattern so concurrent debits can never oversell.
		`CREATE TABLE IF NOT EXISTS wallets (
			user_id       INTEGER PRIMARY KEY REFERENCES users(id),
			balance_paise INTEGER NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
			created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		// Full audit ledger. amount_paise is signed: positive for
		// credits (deposit, admin_credit, refund), negative for
		// charges. balance_after_paise lets an auditor reconstruct
		// the running balance without summing the whole history.
		//
		// Razorpay fields are populated only on deposit rows that
		// came through Checkout. razorpay_payment_id has a unique
		// partial index so a replayed verify-payment call (network
		// retry by the browser) can't double-credit.
		//
		// related_roll links a charge row back to the specific roll
		// number that triggered it — useful for the operator's "what
		// did I just pay for?" question and for the 5-minute same-
		// roll cache (we check whether the same user already paid
		// for this roll within the last 5 min before charging again).
		`CREATE TABLE IF NOT EXISTS wallet_transactions (
			id                   INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id              INTEGER NOT NULL REFERENCES users(id),
			kind                 TEXT NOT NULL CHECK (kind IN ('deposit','charge','admin_credit','refund')),
			amount_paise         INTEGER NOT NULL,
			balance_after_paise  INTEGER NOT NULL,
			related_roll         TEXT,
			razorpay_order_id    TEXT,
			razorpay_payment_id  TEXT,
			description          TEXT,
			created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_created
			ON wallet_transactions(user_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_roll_created
			ON wallet_transactions(user_id, related_roll, created_at)
			WHERE related_roll IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_razorpay_payment
			ON wallet_transactions(razorpay_payment_id)
			WHERE razorpay_payment_id IS NOT NULL`,
	},
}
