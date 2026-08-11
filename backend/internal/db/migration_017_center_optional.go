package db

// migration017CenterOptional lifts the NOT NULL constraint on
// verifications.center_id and users.center_id.
//
// Background — the "centre" concept came from the original design where
// a college had multiple physical exam venues, each tagged per operator
// and per verification. The new exam-catalog model (Phase 1/2) scopes
// operators by exam assignment, not by venue, so `center_id` is
// vestigial. Making it nullable is the smallest change that lets
// centre-less operators (created via /api/admin/operators) write
// verifications without a synthetic centre stub.
//
// The `centers` table itself stays for now — dropping it would break
// the legacy dashboard queries that still JOIN on it. Those get
// rewritten as we replace centre-scoped reporting with exam-scoped
// reporting.
//
// SQLite ALTER TABLE can't drop a NOT NULL constraint in place, so we
// take the standard "rebuild" path: rename → new schema → copy → drop.
// needsFKOff tells the runner to turn foreign_keys OFF for the swap so
// child rows don't get cascade-nulled mid-migration.
var migration017CenterOptional = migration{
	version:    17,
	name:       "center_optional",
	needsFKOff: true,
	stmts: []string{
		// SQLite's default RENAME behaviour rewrites every FK that points
		// at the renamed table to use the new name. That means our
		// RENAME users → users_old would silently repoint
		// wallet_transactions.actor_user_id (and every other FK to
		// users) at users_old — and then DROP TABLE users_old leaves
		// those FKs dangling, breaking every subsequent INSERT that
		// touches them.
		//
		// legacy_alter_table = ON restores the pre-3.25 behaviour: the
		// RENAME touches only the table itself, so FKs keep pointing at
		// the string "users" — which resolves to the fresh table we
		// create below. Set inside the migration txn (SQLite allows this
		// PRAGMA mid-transaction, unlike foreign_keys).
		`PRAGMA legacy_alter_table = ON`,

		// ── users.center_id (existing 17-column schema, NULL allowed) ──
		`ALTER TABLE users RENAME TO users_old`,
		`CREATE TABLE users (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			username      TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role          TEXT NOT NULL CHECK (role IN ('client','admin','superadmin','ops_admin')),
			org_id        INTEGER REFERENCES organizations(id),
			center_id     INTEGER REFERENCES centers(id),
			display_name  TEXT NOT NULL,
			created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			email         TEXT,
			disabled_at   DATETIME,
			activated_at  DATETIME,
			password_plaintext       TEXT,
			password_change_required INTEGER NOT NULL DEFAULT 0,
			spending_cap_paise       INTEGER,
			spent_paise              INTEGER NOT NULL DEFAULT 0,
			valid_from               DATE,
			valid_to                 DATE
		)`,
		`INSERT INTO users(id, username, password_hash, role, org_id, center_id,
		                    display_name, created_at, email, disabled_at, activated_at,
		                    password_plaintext, password_change_required,
		                    spending_cap_paise, spent_paise, valid_from, valid_to)
		 SELECT id, username, password_hash, role, org_id, center_id,
		        display_name, created_at, email, disabled_at, activated_at,
		        password_plaintext, password_change_required,
		        spending_cap_paise, spent_paise, valid_from, valid_to
		   FROM users_old`,
		`DROP TABLE users_old`,
		`CREATE INDEX idx_users_org_role ON users(org_id, role)`,
		`CREATE INDEX idx_users_email    ON users(email) WHERE email IS NOT NULL`,

		// ── verifications.center_id (28-column real schema) ──
		`ALTER TABLE verifications RENAME TO verifications_old`,
		`CREATE TABLE verifications (
			id                  INTEGER PRIMARY KEY AUTOINCREMENT,
			roll_no             TEXT NOT NULL,
			org_id              INTEGER NOT NULL,
			center_id           INTEGER,
			operator_id         INTEGER NOT NULL,
			face_match          INTEGER NOT NULL DEFAULT 0,
			fp_match            INTEGER NOT NULL DEFAULT 0,
			status              TEXT NOT NULL CHECK (status IN ('verified','denied')),
			note                TEXT,
			created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			device_serial       TEXT,
			device_model        TEXT,
			fp_template_format  TEXT,
			fp_quality          INTEGER,
			fp_nfiq             INTEGER,
			fp_match_score      INTEGER,
			fp_liveness         INTEGER,
			iris_left_score     REAL,
			iris_right_score    REAL,
			iris_left_quality   INTEGER,
			iris_right_quality  INTEGER,
			face_match_score    REAL,
			via                 TEXT,
			match_threshold     INTEGER,
			decision_ms         INTEGER,
			client_app_version  TEXT,
			idempotency_key     TEXT,
			fp_vendor           TEXT
		)`,
		`INSERT INTO verifications SELECT * FROM verifications_old`,
		`DROP TABLE verifications_old`,
		`CREATE INDEX idx_verifications_org_created    ON verifications(org_id, created_at)`,
		`CREATE INDEX idx_verifications_center_created ON verifications(center_id, created_at) WHERE center_id IS NOT NULL`,
		`CREATE INDEX idx_verifications_roll           ON verifications(roll_no)`,
		`CREATE INDEX idx_verifications_status         ON verifications(status)`,
		`CREATE UNIQUE INDEX idx_verifications_idempotency
		    ON verifications(idempotency_key) WHERE idempotency_key IS NOT NULL`,
	},
}
