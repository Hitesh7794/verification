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
const schemaVersion = 3

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

	if !applied[1] {
		if err := applyInitialSchema(ctx, d); err != nil {
			return fmt.Errorf("apply initial schema: %w", err)
		}
	}

	if !applied[2] {
		if err := applyV2ClientPortal(ctx, d); err != nil {
			return fmt.Errorf("apply v2 client_portal: %w", err)
		}
	}

	if !applied[3] {
		if err := applyV3Liveness(ctx, d); err != nil {
			return fmt.Errorf("apply v3 liveness: %w", err)
		}
	}

	return nil
}

// applyV3Liveness adds the audit + gating table for the active-liveness
// pre-step that sits in front of face-match. Each row records the
// browser session that passed liveness, the roll it was against, and
// an expiry so /face-match can refuse anything older than the policy
// window (default 90s — see cfg.LivenessMaxAgeSeconds).
//
//	id             — surrogate PK
//	org_id         — the operator's org, from JWT
//	roll_no        — normalised
//	session_id     — the same idempotency key the browser passes to
//	                 /face-match, so the gate check is a direct lookup
//	passive_mean   — Luxand's averaged 0..1 score, kept for audit
//	challenges_passed — JSONB list, e.g. ["blink"] or ["blink","turn_left"]
//	created_at     — server clock at insert
//	expires_at     — created_at + policy window; a WHERE ... > NOW()
//	                 predicate on the gate query cheap-drops stale rows
func applyV3Liveness(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`CREATE TABLE IF NOT EXISTS liveness_checks (
		    id              BIGSERIAL PRIMARY KEY,
		    org_id          BIGINT NOT NULL REFERENCES organizations(id),
		    roll_no         TEXT   NOT NULL,
		    session_id      TEXT   NOT NULL UNIQUE,
		    passive_mean    REAL   NOT NULL,
		    challenges_passed JSONB NOT NULL DEFAULT '[]'::jsonb,
		    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    expires_at      TIMESTAMPTZ NOT NULL
		)`,
		// Gate lookup on face-match: (org_id, roll_no, session_id) hitting
		// the UNIQUE index on session_id is O(1); expires_at is checked
		// against NOW() in the WHERE clause.
		`CREATE INDEX IF NOT EXISTS idx_liveness_org_roll_expires
		    ON liveness_checks(org_id, roll_no, expires_at DESC)`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		3, "liveness_checks",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV2ClientPortal adds the schema needed for the per-client review
// portal (clients like NTA can now log in and approve their own KYC
// intake, alongside the existing superadmin queue).
//
//   clients.portal_enabled          — off by default; superadmin toggles
//   users.client_id                 — set for role='client_reviewer'
//   users role check                — adds 'client_reviewer'
//   institution_applications.client_id — routes the KYC to a client's
//                                       inbox; NULL = legacy superadmin
//   index on (client_id, status)    — client dashboards paginate on it
func applyV2ClientPortal(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN NOT NULL DEFAULT false`,
		`ALTER TABLE users   ADD COLUMN IF NOT EXISTS client_id BIGINT REFERENCES clients(id)`,
		// Widen the role CHECK. Postgres won't let us edit a constraint
		// in place, so drop + re-add with the new value list. If the
		// constraint has been renamed (e.g. a previous manual fix), the
		// DROP no-ops harmlessly.
		`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
		`ALTER TABLE users ADD  CONSTRAINT users_role_check
		    CHECK (role IN ('client','admin','superadmin','ops_admin','client_reviewer'))`,
		`ALTER TABLE institution_applications
		    ADD COLUMN IF NOT EXISTS client_id BIGINT REFERENCES clients(id)`,
		`CREATE INDEX IF NOT EXISTS idx_apps_client_status
		    ON institution_applications(client_id, status)`,
		// A reviewer must have both role='client_reviewer' AND a client_id
		// set (otherwise their scope is undefined). Enforce it at the row
		// level so a stray INSERT can't create an unscoped reviewer.
		`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_client_reviewer_scope`,
		`ALTER TABLE users ADD  CONSTRAINT users_client_reviewer_scope
		    CHECK (role <> 'client_reviewer' OR client_id IS NOT NULL)`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		2, "client_portal",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// firstLine returns the first line of s for error messages so a
// multi-statement failure prints the failing DDL header, not the whole
// blob.
func firstLine(s string) string {
	for i, c := range s {
		if c == '\n' {
			return s[:i]
		}
	}
	return s
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

	// Version 1 is *this* file — schema.sql. Later versions live below
	// as guarded follow-ups. Hard-coded to 1 (rather than schemaVersion)
	// so bumping schemaVersion later doesn't cause a fresh install to
	// skip the follow-up migrations by stamping itself already-at-latest.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		1, "initial_schema",
	); err != nil {
		return err
	}
	return tx.Commit()
}
