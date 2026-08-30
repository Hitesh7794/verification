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

	if !applied[2] {
		if err := applyV2CrossPlaneReferences(ctx, d); err != nil {
			return fmt.Errorf("apply v2 cross_plane_references: %w", err)
		}
	}

	if !applied[3] {
		if err := applyV3DpClientIdColumn(ctx, d); err != nil {
			return fmt.Errorf("apply v3 dp_client_id_column: %w", err)
		}
	}

	if !applied[4] {
		if err := applyV4InfraLifecycleStatus(ctx, d); err != nil {
			return fmt.Errorf("apply v4 infra_lifecycle_status: %w", err)
		}
	}

	if !applied[5] {
		if err := applyV5ClientNameSoftDeleteAware(ctx, d); err != nil {
			return fmt.Errorf("apply v5 client_name_soft_delete_aware: %w", err)
		}
	}

	if !applied[6] {
		if err := applyV6ClientPortalEnabled(ctx, d); err != nil {
			return fmt.Errorf("apply v6 client_portal_enabled: %w", err)
		}
	}

	if !applied[7] {
		if err := applyV7PendingReviewer(ctx, d); err != nil {
			return fmt.Errorf("apply v7 pending_reviewer: %w", err)
		}
	}

	if !applied[8] {
		if err := applyV8ClientDomain(ctx, d); err != nil {
			return fmt.Errorf("apply v8 client_domain: %w", err)
		}
	}

	return nil
}

// applyV8ClientDomain mirrors DP's V26 on the CP so the superadmin
// UI can capture the domain when creating a client, and CP can push
// it to the target DP via /api/internal/clients/{id}/domain.
func applyV8ClientDomain(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE clients_registry ADD COLUMN IF NOT EXISTS domain TEXT`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_registry_domain
		    ON clients_registry(LOWER(domain))
		    WHERE domain IS NOT NULL AND domain <> '' AND status <> 'deleted'`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("v8 stmt: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)
		 ON CONFLICT (version) DO NOTHING`,
		8, "client_domain",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV7PendingReviewer mirrors Rahul's DP-side V15 flow on the CP.
// pending_reviewer routes an application to a specific desk:
//   'admin'  — superadmin sees it in the review queue
//   'client' — client reviewer sees it in their inbox
//   NULL     — legacy / unrouted
//
// For kyc_review_mode='both' clients, the initial value is 'admin':
// superadmin looks first, and on approve the row is flipped to 'client'
// so the client's reviewer takes the final call. For 'admin' mode
// approve is terminal (status='approved'). For 'client' mode the row
// is 'client' from the start and superadmin never has approve rights.
func applyV7PendingReviewer(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE institution_applications
		    ADD COLUMN IF NOT EXISTS pending_reviewer TEXT`,
		`ALTER TABLE institution_applications
		    DROP CONSTRAINT IF EXISTS institution_applications_pending_reviewer_check`,
		`ALTER TABLE institution_applications
		    ADD CONSTRAINT institution_applications_pending_reviewer_check
		    CHECK (pending_reviewer IS NULL OR pending_reviewer IN ('admin','client'))`,
		// Back-fill: existing pending rows go to admin queue.
		`UPDATE institution_applications
		    SET pending_reviewer = 'admin'
		  WHERE pending_reviewer IS NULL AND status = 'pending'`,
		`CREATE INDEX IF NOT EXISTS idx_cp_inst_apps_pending_reviewer
		    ON institution_applications(pending_reviewer, status)
		    WHERE status = 'pending'`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("v7 stmt: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)
		 ON CONFLICT (version) DO NOTHING`,
		7, "pending_reviewer",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV6ClientPortalEnabled adds clients_registry.portal_enabled — the
// "is this client's register form open to applicants" flag that Rahul's
// FE toggles from the ClientDetail page's PortalToggle switch.
//
// Before this migration the setClientPortal handler was a no-op stub
// returning 200 without persisting anything, so the toggle would
// visually flip but revert to the initial value on next page refresh.
//
// DEFAULT TRUE means every existing client is "open" by default —
// matches operator expectations (they'd rather explicitly close a
// client than have them all silently off after a migration).
func applyV6ClientPortalEnabled(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`ALTER TABLE clients_registry
		    ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
	); err != nil {
		return fmt.Errorf("add portal_enabled: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)
		 ON CONFLICT (version) DO NOTHING`,
		6, "client_portal_enabled",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV5ClientNameSoftDeleteAware widens clients_registry.name
// uniqueness to be soft-delete-aware.
//
// Before: `name TEXT NOT NULL UNIQUE` — the constraint indexes ALL
// rows including status='deleted' ones, so a superadmin who deletes
// a client and tries to re-create it with the same name gets a 409.
// The DELETE handler is a soft-delete (status flip, row retained for
// audit) which makes this even more surprising.
//
// After: partial unique index over (LOWER(name)) WHERE status is not
// 'deleted'. Active rows still can't collide; deleted rows are
// invisible to the constraint so their names can be reused. LOWER()
// also normalises case so "NTA" and "nta" collide (matches how humans
// think about board names).
func applyV5ClientNameSoftDeleteAware(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		// Drop the auto-generated UNIQUE constraint from the initial
		// schema. The constraint name follows Postgres's default
		// pattern (clients_registry_name_key).
		`ALTER TABLE clients_registry DROP CONSTRAINT IF EXISTS clients_registry_name_key`,
		// Case-insensitive partial unique index over active names.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_registry_name_active
		    ON clients_registry (LOWER(name))
		    WHERE status <> 'deleted'`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("v5 stmt failed: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)
		 ON CONFLICT (version) DO NOTHING`,
		5, "client_name_soft_delete_aware",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV4InfraLifecycleStatus widens clients_registry.status to model the
// per-client DP provisioning lifecycle:
//
//     infra_pending  -- superadmin registered client, DP not yet reachable
//     ready          -- DP reachable (health probe green), safe to route
//     active         -- ready + explicitly turned on for user traffic
//     suspended      -- temporarily excluded from federation
//     deleted        -- soft delete for audit
//
// Older rows in ('active','suspended','deleted') stay valid — the CHECK
// is widened not narrowed. `POST /api/superadmin/clients` will start
// defaulting to 'infra_pending' for new rows (handler change lives in
// clients_handlers.go, not this migration).
//
// Split from V3 so the two concerns migrate independently: dp_client_id
// affects the fan-out path; status widening affects the CP UI's client
// list. If either goes wrong the other still applies cleanly.
func applyV4InfraLifecycleStatus(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE clients_registry
		    DROP CONSTRAINT IF EXISTS clients_registry_status_check`,
		`ALTER TABLE clients_registry
		    ADD CONSTRAINT clients_registry_status_check
		    CHECK (status IN ('infra_pending','ready','active','suspended','deleted'))`,
		// Update the federated-dashboard scoping index to also skip
		// 'infra_pending' rows — they have no reachable DP yet, so
		// including them in the fan-out would only add timeouts.
		`DROP INDEX IF EXISTS idx_clients_registry_status`,
		`CREATE INDEX IF NOT EXISTS idx_clients_registry_status
		    ON clients_registry(status)
		    WHERE status IN ('active','ready')`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("v4 stmt failed: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)
		 ON CONFLICT (version) DO NOTHING`,
		4, "infra_lifecycle_status",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV3DpClientIdColumn adds institution_applications.dp_client_id.
//
// Motivation: target_client_id on this table already exists but FKs to
// clients_registry(id) — i.e. it identifies WHICH Data Plane the KYC
// belongs to. That's different from the DP-side clients.id (which
// identifies which exam board on that DP — NTA vs SSC vs UP Board).
//
// The fan-out step in /internal/orgs/create needs the DP-side exam
// board id so it can INSERT client_organization_approvals + fan out
// organization_exam_subscriptions. Without this column, the CP has
// nowhere to store the applicant's exam-board choice between /submit
// and /approve, and the fan-out silently gets NULL → new institute
// admins land in an empty catalog on first login.
//
// The column is nullable — legacy rows and applicants who registered
// without picking a board stay NULL, and the fan-out is skipped
// gracefully in that case.
func applyV3DpClientIdColumn(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`ALTER TABLE institution_applications
		    ADD COLUMN IF NOT EXISTS dp_client_id BIGINT`,
	); err != nil {
		return fmt.Errorf("add dp_client_id: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`CREATE INDEX IF NOT EXISTS idx_cp_inst_apps_dp_client
		    ON institution_applications(dp_client_id)
		    WHERE dp_client_id IS NOT NULL`,
	); err != nil {
		return fmt.Errorf("index dp_client_id: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)
		 ON CONFLICT (version) DO NOTHING`,
		3, "dp_client_id_column",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV2CrossPlaneReferences extends the CP so it can accept a KYC
// submission that carries the Data Plane's own application id plus the
// full list of documents the DP has already uploaded to S3. Adds:
//
//   - institution_applications.external_application_id BIGINT
//     — the DP's own application row id. Idempotency key when the DP
//       proxy retries a submit.
//   - institution_applications.dp_submitted_at TIMESTAMPTZ
//     — timestamp the DP finalised the draft. Purely informational;
//       useful for reviewer UIs when the CP row's created_at is later
//       than when the applicant actually clicked Submit.
//   - unique partial index (target_client_id, external_application_id)
//     WHERE external_application_id IS NOT NULL — enforces at most one
//     CP row per DP-side draft, per target client. A retry with the
//     same (client, external_id) surfaces as ON CONFLICT and the
//     handler returns the pre-existing row.
//   - institution_application_documents — mirror of the DP table,
//     minus the bytes. Stores the S3 storage_path so the CP-side
//     reviewer UI can render / download docs without proxying blobs.
//
// Applied inside a single transaction so the CP is never partially
// migrated (e.g. columns exist but docs table doesn't, or vice versa).
func applyV2CrossPlaneReferences(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE institution_applications
		    ADD COLUMN IF NOT EXISTS external_application_id BIGINT`,
		`ALTER TABLE institution_applications
		    ADD COLUMN IF NOT EXISTS dp_submitted_at TIMESTAMPTZ`,
		// Idempotency: one CP row per (target_client_id, external_id).
		// Partial index — legacy rows (no external id) don't collide.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_cp_inst_apps_external_ref
		    ON institution_applications(target_client_id, external_application_id)
		    WHERE external_application_id IS NOT NULL`,

		`CREATE TABLE IF NOT EXISTS institution_application_documents (
		    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		    application_id  BIGINT NOT NULL REFERENCES institution_applications(id) ON DELETE CASCADE,
		    doc_kind        TEXT NOT NULL
		        CHECK (doc_kind IN (
		            'recognition_letter',
		            'pan_card',
		            'authorization_letter',
		            'naac_certificate',
		            'other'
		        )),
		    original_name   TEXT NOT NULL,
		    storage_path    TEXT NOT NULL,
		    mime            TEXT NOT NULL,
		    size_bytes      BIGINT NOT NULL,
		    sha256          TEXT NOT NULL,
		    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_cp_inst_app_docs_app
		    ON institution_application_documents(application_id)`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("v2 stmt failed: %w", err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)
		 ON CONFLICT (version) DO NOTHING`,
		2, "cross_plane_references",
	); err != nil {
		return err
	}
	return tx.Commit()
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
