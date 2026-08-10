package db

// migration009UserOnboarding adds the columns + indexes needed to
// support admin-driven operator onboarding at scale:
//
//   - email          — destination for the magic link, also shown in
//                      the admin's operator list. Nullable for back-
//                      compat with users created before this migration
//                      (the seeded super/admin/clients + admin rows
//                      that come from the institution-approval flow).
//   - disabled_at    — soft-delete marker. Set to a timestamp when an
//                      admin disables an operator; the login handler
//                      rejects users where this is non-NULL. NULL means
//                      the account is active.
//   - activated_at   — set when the user consumes their magic link and
//                      picks a password. Lets the operator list show
//                      "Pending invite" vs "Active" without inspecting
//                      bcrypt hashes. Backfilled to created_at for all
//                      pre-existing users so they show as active.
//
// Indexes:
//
//   - idx_users_org_role          — admin lists operators via
//                                   WHERE org_id=? AND role='client';
//                                   without this index that's a full
//                                   table scan once tenants scale.
//   - idx_users_email             — used during /api/admin/operators
//                                   creation to detect duplicate emails
//                                   in the admin's own org before
//                                   inserting.
var migration009UserOnboarding = migration{
	version: 9,
	name:    "user_onboarding",
	stmts: []string{
		`ALTER TABLE users ADD COLUMN email TEXT`,
		`ALTER TABLE users ADD COLUMN disabled_at DATETIME`,
		`ALTER TABLE users ADD COLUMN activated_at DATETIME`,

		// Backfill: every existing user is "active" — they either set
		// their own password (institution admin via magic link, or the
		// initial superadmin seed) or are seeded demo accounts that the
		// new onboarding flow should treat as already-activated.
		`UPDATE users SET activated_at = created_at WHERE activated_at IS NULL`,

		`CREATE INDEX idx_users_org_role ON users(org_id, role)`,
		`CREATE INDEX idx_users_email    ON users(email) WHERE email IS NOT NULL`,
	},
}
