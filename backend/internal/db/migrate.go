package db

import (
	"database/sql"
	"fmt"
)

// migration is one ordered change to the database schema.
//
// Each migration runs exactly once per database. Once applied, its row in
// schema_migrations prevents re-application. New schema changes must be
// appended to the end of the migrations slice with a fresh, monotonically
// increasing version — never edit an existing migration after it has been
// shipped, since some databases will already have applied it.
type migration struct {
	version int
	name    string
	stmts   []string
}

var migrations = []migration{
	{
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
	},
	{
		version: 2,
		name:    "biometric_score_fields",
		stmts: []string{
			// Hardware identity captured at decision time.
			`ALTER TABLE verifications ADD COLUMN device_serial TEXT`,
			`ALTER TABLE verifications ADD COLUMN device_model TEXT`,

			// Fingerprint signals from MorFin: capture quality (1-100), NFIQ
			// (1-5, NIST quality), match score (vendor scale, threshold-tested
			// at decision time), liveness (-1 unknown / 0 spoof / 1 live),
			// and the template format used for the gallery side of the match.
			`ALTER TABLE verifications ADD COLUMN fp_template_format TEXT`,
			`ALTER TABLE verifications ADD COLUMN fp_quality INTEGER`,
			`ALTER TABLE verifications ADD COLUMN fp_nfiq INTEGER`,
			`ALTER TABLE verifications ADD COLUMN fp_match_score INTEGER`,
			`ALTER TABLE verifications ADD COLUMN fp_liveness INTEGER`,

			// Iris signals from Marvis MatchImage. Two scores (left/right eye)
			// plus per-eye quality from IrisAnatomy.
			`ALTER TABLE verifications ADD COLUMN iris_left_score REAL`,
			`ALTER TABLE verifications ADD COLUMN iris_right_score REAL`,
			`ALTER TABLE verifications ADD COLUMN iris_left_quality INTEGER`,
			`ALTER TABLE verifications ADD COLUMN iris_right_quality INTEGER`,

			// Face score reserved for Luxand integration (later). Single
			// similarity score (0..100 in vendor's scale).
			`ALTER TABLE verifications ADD COLUMN face_match_score REAL`,

			// Decision audit: which channel produced the verified/denied
			// result, what threshold was applied at that moment (thresholds
			// can change over time — log the value used), and how long the
			// whole verification took (UX/SLA telemetry).
			`ALTER TABLE verifications ADD COLUMN via TEXT`,
			`ALTER TABLE verifications ADD COLUMN match_threshold INTEGER`,
			`ALTER TABLE verifications ADD COLUMN decision_ms INTEGER`,
			`ALTER TABLE verifications ADD COLUMN client_app_version TEXT`,

			// Idempotency: client supplies a UUID; a retried POST returns
			// the original row instead of inserting a duplicate.
			`ALTER TABLE verifications ADD COLUMN idempotency_key TEXT`,
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_idempotency
				ON verifications(idempotency_key)
				WHERE idempotency_key IS NOT NULL`,
		},
	},
	{
		version: 3,
		name:    "verification_artifacts",
		stmts: []string{
			`CREATE TABLE IF NOT EXISTS verification_artifacts (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				verification_id INTEGER NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
				kind            TEXT NOT NULL CHECK (kind IN (
					'captured_face',
					'captured_fp_image',
					'captured_fp_template',
					'captured_iris_left',
					'captured_iris_right'
				)),
				mime            TEXT NOT NULL,
				sha256          TEXT NOT NULL,
				size_bytes      INTEGER NOT NULL,
				storage_path    TEXT,
				created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
			`CREATE INDEX IF NOT EXISTS idx_artifacts_verification ON verification_artifacts(verification_id)`,
			`CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON verification_artifacts(kind)`,
		},
	},
}

// Migrate applies every pending migration inside its own transaction.
// Safe to call on a fresh database, an already-migrated database, or a
// database in any intermediate state.
func Migrate(d *sql.DB) error {
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[int]bool{}
	rows, err := d.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()

	for _, m := range migrations {
		if applied[m.version] {
			continue
		}
		if err := applyMigration(d, m); err != nil {
			return fmt.Errorf("migration %d (%s): %w", m.version, m.name, err)
		}
	}
	return nil
}

func applyMigration(d *sql.DB, m migration) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, s := range m.stmts {
		if _, err := tx.Exec(s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}
	if _, err := tx.Exec(
		`INSERT INTO schema_migrations(version, name) VALUES(?, ?)`,
		m.version, m.name,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func firstLine(s string) string {
	for i, c := range s {
		if c == '\n' {
			return s[:i]
		}
	}
	return s
}
