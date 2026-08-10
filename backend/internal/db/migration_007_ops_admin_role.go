package db

var migration007OpsAdminRole = migration{
	version:    7,
	name:       "ops_admin_role",
	needsFKOff: true,
	stmts: []string{
		// SQLite doesn't allow ALTER on an existing CHECK
		// constraint, so we rebuild the users table with the
		// wider role enum. needsFKOff above tells the runner to
		// disable foreign-key enforcement around this rebuild —
		// without that, DROP TABLE users fails because other
		// tables (verifications, wallets) hold FK refs to it.
		// After the swap, SQLite re-resolves those refs by name
		// to the new table.
		`CREATE TABLE users_new (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			username      TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role          TEXT NOT NULL CHECK (role IN ('client','admin','superadmin','ops_admin')),
			org_id        INTEGER REFERENCES organizations(id),
			center_id     INTEGER REFERENCES centers(id),
			display_name  TEXT NOT NULL,
			created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO users_new(id, username, password_hash, role, org_id, center_id, display_name, created_at)
		 SELECT id, username, password_hash, role, org_id, center_id, display_name, created_at FROM users`,
		`DROP TABLE users`,
		`ALTER TABLE users_new RENAME TO users`,
	},
}
