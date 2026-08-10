package db

// migration012AuditLog introduces an append-only audit trail of the
// security-sensitive actions in the portal. Filling the "who did what,
// when" gap that came up during the pre-prod audit.
//
// What gets logged (write call-sites scattered through the API
// handlers — see audit.go for the write helper):
//
//   - login.success / login.failure  — surface credential-stuffing
//   - password.change                — self-service rotation
//   - operator.password.set          — admin's "Set/Reset operator pw"
//   - operator.disable / enable      — admin's revoke/restore
//   - wallet.deposit                 — Razorpay-funded top-up
//   - wallet.admin_credit            — superadmin manual credit
//   - application.approve / reject   — onboarding decisions
//
// The action field is an open string so we can add new event kinds
// without a migration. metadata is JSON for action-specific extras
// (amount_paise, target_username, etc.). actor_user_id is NULL for
// pre-auth events (login failures where we don't yet know who).
//
// The table is append-only by convention; we never UPDATE or DELETE
// rows. Indexes target the common access patterns: per-org timeline
// (admin's audit view) and per-action filter (superadmin support).
var migration012AuditLog = migration{
	version: 12,
	name:    "audit_log",
	stmts: []string{
		`CREATE TABLE audit_log (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			-- ON DELETE SET NULL on both FK columns so the audit row
			-- survives a user / org deletion. The point of an audit
			-- log is to outlive its referents; the actor_username +
			-- actor_role text fields preserve identity even after
			-- the FK is nulled.
			actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
			actor_username  TEXT,
			actor_role      TEXT,
			org_id          INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
			action          TEXT NOT NULL,
			target_type     TEXT,
			target_id       INTEGER,
			metadata        TEXT,
			ip              TEXT,
			created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX idx_audit_org_created ON audit_log(org_id, created_at DESC)`,
		`CREATE INDEX idx_audit_action_created ON audit_log(action, created_at DESC)`,
		`CREATE INDEX idx_audit_actor_created ON audit_log(actor_user_id, created_at DESC)`,
	},
}
