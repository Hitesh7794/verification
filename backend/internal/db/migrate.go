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
const schemaVersion = 11

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

	if !applied[11] {
		if err := applyV11SubscriptionRevoked(ctx, d); err != nil {
			return fmt.Errorf("apply v11 subscription_revoked: %w", err)
		}
	}

	// V12 was V10 on Rahul's branch, but our V10/V11 shipped first and
	// are already applied on prod. Renumbered on merge so the migration
	// still runs on any DB that missed the rahul-branch slot.
	if !applied[12] {
		if err := applyV12SingleClientReviewerConstraint(ctx, d); err != nil {
			return fmt.Errorf("apply v12 single_client_reviewer: %w", err)
		}
	}

	if !applied[14] {
		if err := applyV14UsersPhone(ctx, d); err != nil {
			return fmt.Errorf("apply v14 users_phone: %w", err)
		}
	}

	if !applied[15] {
		if err := applyV15KYCReviewMode(ctx, d); err != nil {
			return fmt.Errorf("apply v15 kyc_review_mode: %w", err)
		}
	}

	if !applied[16] {
		if err := applyV16VerificationWindowTimestamps(ctx, d); err != nil {
			return fmt.Errorf("apply v16 verification_window_timestamps: %w", err)
		}
	}

	if !applied[17] {
		if err := applyV17OrgApplicationLink(ctx, d); err != nil {
			return fmt.Errorf("apply v17 org_application_link: %w", err)
		}
	}

	if !applied[18] {
		if err := applyV18MultiExamOperator(ctx, d); err != nil {
			return fmt.Errorf("apply v18 multi_exam_operator: %w", err)
		}
	}

	return nil
}

// applyV18MultiExamOperator drops the UNIQUE index on operator_exams
// that limited each operator to exactly one exam. Composite PK
// (user_id, exam_id) stays so duplicate rows are still refused; the
// unique-on-user_id-alone constraint is what forbade multi-assignment.
//
// Data isolation between exams is enforced at the handler layer
// (resolveExamCodeForOperator honours the X-Exam-Id header +
// lookupExamCandidate filters by the resolved exam_id) — the schema
// change alone can't leak data, it just permits the second row.
func applyV18MultiExamOperator(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`DROP INDEX IF EXISTS ux_operator_exams_user`,
	); err != nil {
		return fmt.Errorf("drop ux_operator_exams_user: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		18, "multi_exam_operator",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV17OrgApplicationLink wires organizations back to the
// institution_applications row that spawned them, and hardens the
// "one identity, one application" uniqueness so a rejected applicant
// can't just re-register with the same head_email / head_mobile / PAN
// / AISHE and start over.
//
// Two schema changes:
//
//  1. organizations.application_id (nullable BIGINT FK) — the KYC
//     gate middleware reads this to answer "is this org's KYC still
//     pending / rejected / approved?" without a name-match join.
//     Nullable so legacy orgs (created before V17, when the KYC-
//     approve flow was the org-creator) stay valid.
//
//  2. The four unique partial indexes on institution_applications
//     (head_email, head_mobile, pan, aishe) previously filtered
//     `WHERE status IN ('approved','pending')`. That let a rejected
//     applicant register again with the same identity. Widen to
//     include 'rejected' so identity is locked once you've registered,
//     regardless of the decision — matches the 'no re-register on
//     reject' rule (2026-08-25 UX call).
func applyV17OrgApplicationLink(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE organizations
		    ADD COLUMN IF NOT EXISTS application_id BIGINT
		    REFERENCES institution_applications(id) ON DELETE SET NULL`,
		`CREATE INDEX IF NOT EXISTS idx_organizations_application_id
		    ON organizations(application_id)
		    WHERE application_id IS NOT NULL`,
		// Rebuild the four partial unique indexes so 'rejected' rows
		// also block re-registration. Drop + recreate is the only
		// portable way to change the WHERE predicate on a partial
		// index in postgres.
		`DROP INDEX IF EXISTS idx_inst_apps_head_email_active`,
		`CREATE UNIQUE INDEX idx_inst_apps_head_email_active
		    ON institution_applications(head_email)
		    WHERE status IN ('approved','pending','rejected')`,
		`DROP INDEX IF EXISTS idx_inst_apps_head_mobile_active`,
		`CREATE UNIQUE INDEX idx_inst_apps_head_mobile_active
		    ON institution_applications(head_mobile)
		    WHERE status IN ('approved','pending','rejected')`,
		`DROP INDEX IF EXISTS idx_inst_apps_pan_active`,
		`CREATE UNIQUE INDEX idx_inst_apps_pan_active
		    ON institution_applications(pan)
		    WHERE pan IS NOT NULL AND status IN ('approved','pending','rejected')`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		17, "org_application_link",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV15KYCReviewMode adds the per-client KYC review mode + the
// per-application pending_reviewer routing column (2026-08-24 rebuild).
//
//   clients.kyc_review_mode              — 'admin' | 'client' | 'both'
//   institution_applications.pending_reviewer  — 'admin' | 'client' | NULL
//
// mode drives routing at submit time. pending_reviewer says which queue
// the row currently sits in; NULL once the app reaches a terminal state.
//
// 'both' semantics: submit lands in the superadmin queue
// (pending_reviewer='admin'). Superadmin approve flips it to
// pending_reviewer='client' (still status='pending', no org yet — just
// moves to the client reviewer's inbox). Client reviewer's approve
// finalizes: status='approved', org+admin created, exams fanned out.
// Either reviewer's reject → status='rejected'.
//
// Back-fill sets pending_reviewer NULL for terminal rows and 'admin'
// for anything still pending — pre-migration behaviour was
// superadmin-only, so nothing moves silently.
func applyV15KYCReviewMode(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE clients
		    ADD COLUMN IF NOT EXISTS kyc_review_mode TEXT NOT NULL DEFAULT 'admin'`,
		`ALTER TABLE clients
		    DROP CONSTRAINT IF EXISTS clients_kyc_review_mode_check`,
		`ALTER TABLE clients
		    ADD CONSTRAINT clients_kyc_review_mode_check
		    CHECK (kyc_review_mode IN ('admin','client','both'))`,
		`ALTER TABLE institution_applications
		    ADD COLUMN IF NOT EXISTS pending_reviewer TEXT`,
		`ALTER TABLE institution_applications
		    DROP CONSTRAINT IF EXISTS institution_applications_pending_reviewer_check`,
		`ALTER TABLE institution_applications
		    ADD CONSTRAINT institution_applications_pending_reviewer_check
		    CHECK (pending_reviewer IS NULL OR pending_reviewer IN ('admin','client'))`,
		// Back-fill routing: anything still pending goes to admin queue
		// (matches pre-migration behaviour); terminal rows have NULL.
		`UPDATE institution_applications
		    SET pending_reviewer = 'admin'
		  WHERE status = 'pending' AND pending_reviewer IS NULL`,
		`UPDATE institution_applications
		    SET pending_reviewer = NULL
		  WHERE status IN ('approved','rejected','draft')`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		15, "kyc_review_mode",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV16VerificationWindowTimestamps converts verification_from/to on exams
// and valid_from/to on users from plain DATE to TIMESTAMPTZ, enabling exact
// date + time window scheduling for superadmins and college administrators.
func applyV16VerificationWindowTimestamps(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE exams ALTER COLUMN verification_from TYPE TIMESTAMPTZ USING verification_from::timestamptz`,
		`ALTER TABLE exams ALTER COLUMN verification_to TYPE TIMESTAMPTZ USING verification_to::timestamptz`,
		`ALTER TABLE users ALTER COLUMN valid_from TYPE TIMESTAMPTZ USING valid_from::timestamptz`,
		`ALTER TABLE users ALTER COLUMN valid_to TYPE TIMESTAMPTZ USING valid_to::timestamptz`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		16, "verification_window_timestamps",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV14UsersPhone adds an optional phone column to the users table.
// Used by the admin's per-agent create/edit form: OTP verification was
// dropped 2026-08-24 in favor of a plain email + phone-number pair the
// admin fills in for their own records. Additive, nullable — existing
// rows and existing code paths are unaffected.
func applyV14UsersPhone(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`); err != nil {
		return fmt.Errorf("add users.phone: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		14, "users_phone",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV12SingleClientReviewerConstraint enforces that each client can
// have at most one active reviewer account (role='client_reviewer').
//
// Was V10 on Rahul's branch, renumbered to V12 on merge because V10
// and V11 slots were already taken by veni-dev migrations shipped to
// prod earlier this session. `ON users(client_id) WHERE role=... AND
// disabled_at IS NULL` — partial unique index so a soft-deleted
// reviewer (disabled_at set) doesn't block a fresh one from being
// created, matching the pattern V4 uses for head_mobile.
func applyV12SingleClientReviewerConstraint(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_users_client_reviewer_single
		    ON users(client_id)
		    WHERE role = 'client_reviewer' AND disabled_at IS NULL`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		12, "single_client_reviewer",
	); err != nil {
		return err
	}
	return tx.Commit()
}

// applyV11SubscriptionRevoked widens the CHECK constraint on
// organization_exam_subscriptions.status to include 'revoked' — a
// state distinct from 'rejected'. A reviewer approves an org for
// their exam, then later flips the row to 'revoked' to pull that
// access back. The college admin can then resubscribe (the existing
// UPSERT flow re-sets status='pending'), separating "was approved
// then taken back" from "never approved in the first place". Notes:
//
//   - rejected: reviewer said no at the first review pass. Historical.
//   - revoked:  reviewer changed their mind after approving. Also historical
//               but the row was live for some period; audit trail matters.
//
// Existing rows all keep their current status; only the CHECK is
// widened. Backward-compat: any old client sending status='rejected'
// still works.
func applyV11SubscriptionRevoked(ctx context.Context, d *sql.DB) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Postgres has no ALTER CHECK — drop + re-add. Constraint name
	// comes from the auto-generated name Rahul's V9 produced;
	// DROP IF EXISTS keeps the rename-safe.
	stmts := []string{
		`ALTER TABLE organization_exam_subscriptions
		    DROP CONSTRAINT IF EXISTS organization_exam_subscriptions_status_check`,
		`ALTER TABLE organization_exam_subscriptions
		    ADD CONSTRAINT organization_exam_subscriptions_status_check
		    CHECK (status IN ('pending','approved','rejected','revoked'))`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("exec %q: %w", firstLine(s), err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, name) VALUES($1, $2)`,
		11, "subscription_revoked",
	); err != nil {
		return err
	}
	return tx.Commit()
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
