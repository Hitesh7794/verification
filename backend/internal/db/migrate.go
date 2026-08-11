package db

import (
	"context"
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
//
// Individual migrations live in their own files (migration_NNN_*.go) so
// this runner stays readable. To add one, create migration_008_*.go with
// a `var migration008X = migration{...}` and append it to the slice below.
type migration struct {
	version int
	name    string
	stmts   []string

	// needsFKOff signals that this migration rebuilds a table that other
	// tables have foreign-key references into (e.g., the SQLite "12-step
	// rename to widen a CHECK constraint" pattern). SQLite ignores PRAGMA
	// foreign_keys changes inside an open transaction, so the migration
	// runner toggles it on a dedicated connection around the tx and
	// restores it after.
	needsFKOff bool
}

var migrations = []migration{
	migration001InitialSchema,
	migration002BiometricScoreFields,
	migration003VerificationArtifacts,
	migration004FingerprintVendor,
	migration005Wallets,
	migration006InstitutionApplications,
	migration007OpsAdminRole,
	migration008OrgWallets,
	migration009UserOnboarding,
	migration010OperatorPlaintext,
	migration011ForcePasswordChange,
	migration012AuditLog,
	migration013RazorpayOrders,
	migration014UniquePanEmail,
	migration015ClientsExams,
	migration016SubscriptionsOperatorScoping,
	migration017CenterOptional,
	migration018RepairUserFKs,
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
	// For migrations that rebuild a table that other tables reference,
	// pin to a dedicated connection so we can toggle the per-connection
	// PRAGMA foreign_keys around the rename. SQLite ignores changes to
	// that pragma inside an open transaction.
	if m.needsFKOff {
		ctx := context.Background()
		conn, err := d.Conn(ctx)
		if err != nil {
			return err
		}
		defer conn.Close()
		if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
			return fmt.Errorf("disable FK: %w", err)
		}
		// Best-effort restore. Even if the migration commits or rolls
		// back, leaving FK on for the next caller is the safe default.
		defer func() { _, _ = conn.ExecContext(ctx, "PRAGMA foreign_keys = ON") }()
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		for _, s := range m.stmts {
			if _, err := tx.ExecContext(ctx, s); err != nil {
				return fmt.Errorf("exec %q: %w", firstLine(s), err)
			}
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations(version, name) VALUES(?, ?)`,
			m.version, m.name,
		); err != nil {
			return err
		}
		return tx.Commit()
	}

	// Normal migration path — no FK toggling.
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
