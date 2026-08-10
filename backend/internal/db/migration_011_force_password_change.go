package db

// migration011ForcePasswordChange adds a flag the server uses to make
// users (superadmin, ops_admin) rotate their seeded default password
// before they can use the system. Without this column, anyone who reads
// the source / docs / seed file knows `super123` and `ops123` work in
// production until manually changed.
//
// password_change_required:
//
//	NULL or 0 → normal account, no forced rotation
//	1         → /api/me returns the flag; frontend redirects to the
//	            forced "change password" screen until they update.
//
// The seed sets this to 1 for the two demo accounts on every boot
// (idempotent; flipped back to 0 once the user changes their password).
// Admins created via the approval flow start with 0 — they choose
// their own password on first activation via the magic link, so a
// further "you must change it" loop would be redundant.
var migration011ForcePasswordChange = migration{
	version: 11,
	name:    "force_password_change",
	stmts: []string{
		`ALTER TABLE users ADD COLUMN password_change_required INTEGER NOT NULL DEFAULT 0`,
	},
}
