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
const schemaVersion = 10

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

	if !applied[4] {
		if err := applyV4HeadMobileUniqueness(ctx, d); err != nil {
			return fmt.Errorf("apply v4 head_mobile uniqueness: %w", err)
		}
	}

	if !applied[5] {
		if err := applyV5CandidateBiometricFlags(ctx, d); err != nil {
			return fmt.Errorf("apply v5 candidate biometric flags: %w", err)
		}
	}

	if !applied[6] {
		if err := applyV6PerOrgEmailUniqueness(ctx, d); err != nil {
			return fmt.Errorf("apply v6 per-org email uniqueness: %w", err)
		}
	}

	if !applied[7] {
		if err := applyV7AllowOtherInstitutionType(ctx, d); err != nil {
			return fmt.Errorf("apply v7 allow_other_institution_type: %w", err)
		}
	}

	if !applied[8] {
		if err := applyV8AllowCustomInstitutionType(ctx, d); err != nil {
			return fmt.Errorf("apply v8 allow_custom_institution_type: %w", err)
		}
	}

	if !applied[9] {
		if err := applyV9ExamSubscriptionApprovals(ctx, d); err != nil {
			return fmt.Errorf("apply v9 exam_subscription_approvals: %w", err)
		}
	}

	if !applied[10] {
		if err := applyV10CaptureAuditS3Keys(ctx, d); err != nil {
			return fmt.Errorf("apply v10 capture_audit_s3_keys: %w", err)
		}
	}

	return nil
}

// applyV10CaptureAuditS3Keys adds nullable columns to `verifications`
// pointing at S3 keys where the captured (probe) biometric bytes for
// that verification live — face frame, FP template, iris payload.
//
// Layout the API side writes to (see internal/storage/captures.go):
//
//	<ORG_CODE>/<EXAM_CODE>/captures/YYYY-MM/<verification_id>/{face.jpg,fp.<ext>,iris.<ext>,meta.json}
//
// One prefix scan per institute gives a regulator every capture that
// institute ever took, which is why the layout is institute-scoped
// rather than exam-scoped (matches user's preference — see
// [[project-s3-photo-storage]] audit-blob discussion 2026-08-22).
// Columns are nullable + additive so existing rows (including the 3
// pre-V10 verifications with disk-only probe paths) stay valid.
func applyV10CaptureAuditS3Keys(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE verifications ADD COLUMN IF NOT EXISTS face_probe_s3_key TEXT`,
		`ALTER TABLE verifications ADD COLUMN IF NOT EXISTS fp_probe_s3_key   TEXT`,
		`ALTER TABLE verifications ADD COLUMN IF NOT EXISTS iris_probe_s3_key TEXT`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		10, "capture_audit_s3_keys",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV9ExamSubscriptionApprovals adds approval lifecycle fields to
// organization_exam_subscriptions and creates client_organization_approvals
// so Client Reviewers can approve subscriptions per-exam or blanket client-wide.
func applyV9ExamSubscriptionApprovals(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE organization_exam_subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved'`,
		`ALTER TABLE organization_exam_subscriptions ADD COLUMN IF NOT EXISTS approval_type TEXT`,
		`ALTER TABLE organization_exam_subscriptions ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
		`ALTER TABLE organization_exam_subscriptions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
		`ALTER TABLE organization_exam_subscriptions ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id)`,
		`ALTER TABLE organization_exam_subscriptions ADD COLUMN IF NOT EXISTS review_note TEXT`,
		`CREATE TABLE IF NOT EXISTS client_organization_approvals (
			client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
			org_id      BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			approved_by BIGINT REFERENCES users(id),
			note        TEXT,
			PRIMARY KEY (client_id, org_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_client_org_approvals_org ON client_organization_approvals(org_id)`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		9, "exam_subscription_approvals",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV8AllowCustomInstitutionType drops the CHECK constraint on
// institution_applications.institution_type so user-entered custom
// institution types (when Other is picked) can be stored directly.
func applyV8AllowCustomInstitutionType(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE institution_applications DROP CONSTRAINT IF EXISTS institution_applications_institution_type_check`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		8, "allow_custom_institution_type",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV7AllowOtherInstitutionType widens the CHECK constraint on
// institution_applications.institution_type to include 'other', so
// the public register form can accept institutions that don't fit
// the school/college/university/coaching taxonomy.
//
// Was originally authored as V5 on the rahul-FE branch; renumbered to
// V7 at merge time so it slots after the V5 (biometric flags) and V6
// (per-org email uniqueness) that were already on prod.
func applyV7AllowOtherInstitutionType(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE institution_applications DROP CONSTRAINT IF EXISTS institution_applications_institution_type_check`,
		`ALTER TABLE institution_applications ADD CONSTRAINT institution_applications_institution_type_check
		    CHECK (institution_type IN ('school','college','university','coaching','other'))`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		7, "allow_other_institution_type",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV6PerOrgEmailUniqueness scopes the users.email uniqueness
// constraint to (org_id, email) instead of globally unique. Lets the
// same physical person exist as an operator/admin under multiple
// organisations — a legitimate case (agent working two centres run by
// different clients) that the old global-unique index blocked.
//
// Username stays globally unique — that's the login identifier and
// two users with the same username would fight the JWT flow. If a
// person needs to belong to two orgs, they get two usernames
// (e.g. "john_nta", "john_ntakolkata") but can reuse the same email.
//
// Migration is safe because every existing row satisfies the new
// constraint: if `(email)` was globally unique before, then
// `(org_id, email)` is also unique after — the new tuple is strictly
// more permissive.
func applyV6PerOrgEmailUniqueness(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`DROP INDEX IF EXISTS ux_users_email_ci`,
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_users_org_email_ci
		    ON users(org_id, LOWER(email))
		    WHERE email IS NOT NULL AND email <> ''`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		6, "per_org_email_uniqueness",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV5CandidateBiometricFlags adds per-modality presence flags on
// exam_candidates. Historically the runtime derived "does this candidate
// have a photo / FP / iris?" by walking the local filesystem
// (data/uploaded/<exam_id>/{photo,fps,iso,iris}/) at Index refresh time.
// With the S3 migration new uploads no longer touch disk, so the Index
// can't see them. These flags are the DB-side source of truth going
// forward — the Index overlays them after the disk walk.
//
// All flags default false. Legacy candidates whose files exist on disk
// stay reachable through the disk walk in scanUploaded/scanCenter, so
// no backfill is needed at migration time — only new uploads flip the
// flag. When a bulk backfill is desired, a follow-up script can UPDATE
// the flags from the S3 ListObjects output.
func applyV5CandidateBiometricFlags(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE exam_candidates ADD COLUMN IF NOT EXISTS has_photo       BOOLEAN NOT NULL DEFAULT false`,
		`ALTER TABLE exam_candidates ADD COLUMN IF NOT EXISTS has_fp_image    BOOLEAN NOT NULL DEFAULT false`,
		`ALTER TABLE exam_candidates ADD COLUMN IF NOT EXISTS has_fp_template BOOLEAN NOT NULL DEFAULT false`,
		`ALTER TABLE exam_candidates ADD COLUMN IF NOT EXISTS has_iris        BOOLEAN NOT NULL DEFAULT false`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		5, "candidate_biometric_flags",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV4HeadMobileUniqueness enforces that head_mobile must be unique across
// all active (approved or pending) institution applications.
func applyV4HeadMobileUniqueness(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`CREATE INDEX IF NOT EXISTS idx_inst_apps_head_mobile ON institution_applications(head_mobile)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_inst_apps_head_mobile_active
		    ON institution_applications(head_mobile) WHERE status IN ('approved','pending')`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		4, "head_mobile_uniqueness",
	); err != nil {
		return err
	}
	return tx.Commit()
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
