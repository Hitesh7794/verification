package db

// migration018RepairUserFKs repairs the collateral damage from
// migration 017. Migration 017 rebuilt the `users` table (rename →
// new schema → copy → drop old) so that `users.center_id` could be
// nullable. But it didn't set `PRAGMA legacy_alter_table = ON` before
// the rename, so SQLite's default "helpful" behaviour rewrote every
// foreign key that referenced `users(id)` to point at `users_old(id)`
// instead. After DROP TABLE users_old finished, all 8 of those FKs
// were dangling — any INSERT into them errors with
// "no such table: main.users_old".
//
// This migration rebuilds each affected table with a fresh CREATE
// TABLE that explicitly references `users(id)`, preserving every row
// and every index. Order doesn't matter because needsFKOff turns off
// FK enforcement for the duration.
//
// Affected tables (all had FK columns pointing at users):
//   wallet_transactions             actor_user_id
//   magic_links                     user_id                   (ON DELETE CASCADE)
//   audit_log                       actor_user_id             (ON DELETE SET NULL)
//   razorpay_orders                 actor_user_id
//   exam_csv_uploads                uploaded_by
//   organization_exam_subscriptions subscribed_by
//   operator_exams                  user_id                   (ON DELETE CASCADE)
//   institution_applications        reviewed_by_user_id
//
// PRAGMA legacy_alter_table = ON is set at the top so the RENAME
// steps do the same thing on every SQLite version — leave FK
// references string-untouched. On a fresh install where migration 017
// already used the pragma correctly, this migration is a harmless
// full-table rebuild (no schema change, no data loss).
var migration018RepairUserFKs = migration{
	version:    18,
	name:       "repair_user_fks",
	needsFKOff: true,
	stmts: []string{
		`PRAGMA legacy_alter_table = ON`,

		// ── wallet_transactions ────────────────────────────────
		`ALTER TABLE wallet_transactions RENAME TO wallet_transactions_old`,
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
		`INSERT INTO wallet_transactions SELECT * FROM wallet_transactions_old`,
		`DROP TABLE wallet_transactions_old`,
		`CREATE INDEX idx_wallet_tx_org_created
			ON wallet_transactions(org_id, created_at)`,
		`CREATE INDEX idx_wallet_tx_org_roll_created
			ON wallet_transactions(org_id, related_roll, created_at)
			WHERE related_roll IS NOT NULL`,
		`CREATE UNIQUE INDEX idx_wallet_tx_razorpay_payment
			ON wallet_transactions(razorpay_payment_id)
			WHERE razorpay_payment_id IS NOT NULL`,

		// ── magic_links ────────────────────────────────────────
		`ALTER TABLE magic_links RENAME TO magic_links_old`,
		`CREATE TABLE magic_links (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			token_hash   TEXT NOT NULL UNIQUE,
			purpose      TEXT NOT NULL CHECK (purpose IN ('set_password','reset_password')),
			expires_at   DATETIME NOT NULL,
			used_at      DATETIME,
			created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO magic_links SELECT * FROM magic_links_old`,
		`DROP TABLE magic_links_old`,
		`CREATE INDEX idx_magic_links_user    ON magic_links(user_id)`,
		`CREATE INDEX idx_magic_links_expires ON magic_links(expires_at) WHERE used_at IS NULL`,

		// ── audit_log ──────────────────────────────────────────
		`ALTER TABLE audit_log RENAME TO audit_log_old`,
		`CREATE TABLE audit_log (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
			actor_username  TEXT,
			actor_role      TEXT,
			org_id          INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
			action          TEXT NOT NULL,
			target_type     TEXT,
			target_id       INTEGER,
			metadata        TEXT,
			ip              TEXT,
			created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO audit_log SELECT * FROM audit_log_old`,
		`DROP TABLE audit_log_old`,
		`CREATE INDEX idx_audit_org_created    ON audit_log(org_id, created_at DESC)`,
		`CREATE INDEX idx_audit_action_created ON audit_log(action, created_at DESC)`,
		`CREATE INDEX idx_audit_actor_created  ON audit_log(actor_user_id, created_at DESC)`,

		// ── razorpay_orders ────────────────────────────────────
		`ALTER TABLE razorpay_orders RENAME TO razorpay_orders_old`,
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
		`INSERT INTO razorpay_orders SELECT * FROM razorpay_orders_old`,
		`DROP TABLE razorpay_orders_old`,
		`CREATE INDEX idx_razorpay_orders_org_created
			ON razorpay_orders(org_id, created_at DESC)`,

		// ── exam_csv_uploads ───────────────────────────────────
		`ALTER TABLE exam_csv_uploads RENAME TO exam_csv_uploads_old`,
		`CREATE TABLE exam_csv_uploads (
			id             INTEGER PRIMARY KEY AUTOINCREMENT,
			exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
			filename       TEXT NOT NULL,
			storage_path   TEXT NOT NULL,
			size_bytes     INTEGER NOT NULL,
			sha256         TEXT NOT NULL,
			uploaded_by    INTEGER NOT NULL REFERENCES users(id),
			uploaded_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			rows_seeded    INTEGER NOT NULL DEFAULT 0
		)`,
		`INSERT INTO exam_csv_uploads SELECT * FROM exam_csv_uploads_old`,
		`DROP TABLE exam_csv_uploads_old`,
		`CREATE INDEX idx_exam_csv_uploads_exam
			ON exam_csv_uploads(exam_id, uploaded_at DESC)`,

		// ── organization_exam_subscriptions ────────────────────
		`ALTER TABLE organization_exam_subscriptions RENAME TO organization_exam_subscriptions_old`,
		`CREATE TABLE organization_exam_subscriptions (
			org_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
			subscribed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			subscribed_by  INTEGER REFERENCES users(id),
			PRIMARY KEY (org_id, exam_id)
		)`,
		`INSERT INTO organization_exam_subscriptions
			SELECT * FROM organization_exam_subscriptions_old`,
		`DROP TABLE organization_exam_subscriptions_old`,
		`CREATE INDEX idx_org_exam_subs_exam
			ON organization_exam_subscriptions(exam_id)`,

		// ── operator_exams ─────────────────────────────────────
		`ALTER TABLE operator_exams RENAME TO operator_exams_old`,
		`CREATE TABLE operator_exams (
			user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			exam_id  INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
			PRIMARY KEY (user_id, exam_id)
		)`,
		`INSERT INTO operator_exams SELECT * FROM operator_exams_old`,
		`DROP TABLE operator_exams_old`,
		`CREATE INDEX idx_operator_exams_exam ON operator_exams(exam_id)`,

		// ── institution_applications ───────────────────────────
		`ALTER TABLE institution_applications RENAME TO institution_applications_old`,
		`CREATE TABLE institution_applications (
			id                    INTEGER PRIMARY KEY AUTOINCREMENT,
			status                TEXT NOT NULL DEFAULT 'pending'
				CHECK (status IN ('draft','pending','approved','rejected')),
			institution_name      TEXT NOT NULL,
			institution_type      TEXT NOT NULL
				CHECK (institution_type IN ('school','college','university','coaching')),
			tier                  TEXT
				CHECK (tier IS NULL OR tier IN ('tier_1','tier_2','tier_3')),
			aishe_code            TEXT,
			pan                   TEXT,
			year_established      INTEGER,
			affiliation_body      TEXT,
			address_line1         TEXT NOT NULL,
			address_line2         TEXT,
			city                  TEXT NOT NULL,
			district              TEXT,
			state                 TEXT NOT NULL,
			pin_code              TEXT NOT NULL,
			approx_student_count  INTEGER,
			expected_centres      INTEGER NOT NULL DEFAULT 1,
			head_name             TEXT NOT NULL,
			head_designation      TEXT NOT NULL,
			head_email            TEXT NOT NULL,
			head_mobile           TEXT NOT NULL,
			reviewed_by_user_id   INTEGER REFERENCES users(id),
			reviewed_at           DATETIME,
			review_note           TEXT,
			submitter_ip          TEXT,
			created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO institution_applications SELECT * FROM institution_applications_old`,
		`DROP TABLE institution_applications_old`,
		`CREATE INDEX idx_inst_apps_status  ON institution_applications(status, created_at DESC)`,
		`CREATE INDEX idx_inst_apps_created ON institution_applications(created_at DESC)`,
		`CREATE UNIQUE INDEX idx_inst_apps_aishe
			ON institution_applications(aishe_code) WHERE aishe_code IS NOT NULL`,
		`CREATE INDEX idx_inst_apps_head_email ON institution_applications(head_email)`,
		`CREATE UNIQUE INDEX idx_inst_apps_pan_active
			ON institution_applications(pan)
			WHERE pan IS NOT NULL AND status IN ('approved','pending')`,
		`CREATE UNIQUE INDEX idx_inst_apps_head_email_active
			ON institution_applications(head_email) WHERE status IN ('approved','pending')`,
	},
}
