package db

var migration001InitialSchema = migration{
	version: 1,
	name:    "initial_schema",
	stmts: []string{
		`CREATE TABLE IF NOT EXISTS organizations (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			code        TEXT NOT NULL UNIQUE,
			name        TEXT NOT NULL,
			created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS centers (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id      INTEGER NOT NULL REFERENCES organizations(id),
			code        TEXT NOT NULL,
			name        TEXT NOT NULL,
			created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(org_id, code)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_centers_org ON centers(org_id)`,
		`CREATE TABLE IF NOT EXISTS users (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			username      TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role          TEXT NOT NULL CHECK (role IN ('client','admin','superadmin')),
			org_id        INTEGER REFERENCES organizations(id),
			center_id     INTEGER REFERENCES centers(id),
			display_name  TEXT NOT NULL,
			created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS verifications (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			roll_no       TEXT NOT NULL,
			org_id        INTEGER NOT NULL,
			center_id     INTEGER NOT NULL,
			operator_id   INTEGER NOT NULL,
			face_match    INTEGER NOT NULL DEFAULT 0,
			fp_match      INTEGER NOT NULL DEFAULT 0,
			status        TEXT NOT NULL CHECK (status IN ('verified','denied')),
			note          TEXT,
			created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_verifications_org_created ON verifications(org_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_verifications_center_created ON verifications(center_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_verifications_roll ON verifications(roll_no)`,
		`CREATE INDEX IF NOT EXISTS idx_verifications_status ON verifications(status)`,
	},
}
