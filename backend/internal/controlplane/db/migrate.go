// Package db owns the Control Plane's Postgres schema management.
// Separate from the Data Plane's db package (backend/internal/db)
// because the two run against different databases and have entirely
// different schemas — sharing a package would be more confusing than
// duplicating the ~50 lines of migration bookkeeping.
package db

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
)

//go:embed schema.sql
var schemaSQL string

// Migrate applies schema.sql to an empty Control Plane DB, or is a
// no-op if the schema has already been applied. Safe to call on every
// startup. Bumps + additive migrations land as guarded `if !applied[N]`
// blocks below, same convention as the Data Plane.
func Migrate(d *sql.DB) error {
	ctx := context.Background()

	// Bootstrap the version table so we can check applied migrations
	// even on a totally fresh DB. Same statement lives in schema.sql;
	// running it here means the pre-schema branch (fresh DB) doesn't
	// error out reading a non-existent table.
	if _, err := d.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`); err != nil {
		return fmt.Errorf("bootstrap schema_migrations: %w", err)
	}

	applied, err := loadApplied(ctx, d)
	if err != nil {
		return err
	}

	if !applied[1] {
		if err := applyInitialSchema(ctx, d); err != nil {
			return fmt.Errorf("apply initial schema: %w", err)
		}
	}

	return nil
}

// applyInitialSchema executes schema.sql as one big block. Wraps in a
// transaction so a partial failure leaves the DB in the pre-migration
// state, not half-schema'd.
func applyInitialSchema(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("exec schema.sql: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)
		 ON CONFLICT (version) DO NOTHING`,
		1, "initial_control_plane_schema",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// loadApplied reads the schema_migrations table into a set for the
// `!applied[N]` guards above. Returns an empty set on a fresh DB.
func loadApplied(ctx context.Context, d *sql.DB) (map[int]bool, error) {
	rows, err := d.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]bool{}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out[v] = true
	}
	return out, rows.Err()
}
