package db

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
)

//go:embed schema.sql
var schemaSQL string

// schemaVersion is the version stamped in schema_migrations after the
// initial schema has been applied. Bump this only when new post-1
// migrations are added below.
const schemaVersion = 1

// Migrate applies schema.sql to an empty database, or is a no-op if
// the schema has already been applied. Safe to call on every startup.
//
// The previous 23 SQLite-specific migration files were collapsed into
// schema.sql when we moved to Postgres. Any post-Postgres schema
// change should be added as a small, ordered follow-up statement in
// this file (bumping schemaVersion + guarding by version).
func Migrate(d *sql.DB) error {
	ctx := context.Background()

	// Bootstrap the version table; safe to run every time.
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

	if !applied[schemaVersion] {
		if err := applyInitialSchema(ctx, d); err != nil {
			return fmt.Errorf("apply initial schema: %w", err)
		}
	}

	return nil
}

func loadApplied(ctx context.Context, d *sql.DB) (map[int]bool, error) {
	rows, err := d.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
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

func applyInitialSchema(ctx context.Context, d *sql.DB) error {
	// Postgres can execute the entire multi-statement schema in one
	// Exec since the wire protocol supports it. Wrapping in a tx keeps
	// partial application from ever surviving a mid-file error.
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("exec schema.sql: %w", err)
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		schemaVersion, "initial_schema",
	); err != nil {
		return err
	}
	return tx.Commit()
}
