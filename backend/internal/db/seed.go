package db

import (
	"database/sql"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/data"
)

// Seed sets up the two system-baked accounts the portal needs to boot:
// the superadmin (`super`) and the onboarding ops admin (`ops`). Both
// use INSERT ... ON CONFLICT DO NOTHING so that first-run seeds them
// but subsequent boots leave any password change intact.
//
// History note (2026-08-24 cleanup):
//   - Removed the filesystem-index → organizations sync (auto-created
//     any orgcode folder under DATA_DIR into `organizations`).
//   - Removed the GNDU27 demo-org fallback (auto-created a Guru Nanak
//     Dev University row + ₹500 wallet when no orgs were present).
//   - Removed the demo `admin` / `client` users (auto-reset their
//     passwords to admin123 / client123 on every boot, with client's
//     plaintext exposed).
//   - Removed the client/client2 password_plaintext backfill.
//   - Removed the demo NTA client + NEET/JEE/CUET exams.
//   - Changed `super` from DO UPDATE → DO NOTHING so the superadmin
//     password isn't silently reverted to super123 on every restart.
// Real tenants come through the /register flow now; nothing here
// creates demo state anymore.
//
// The `idx` parameter is retained for API stability with cmd/server.
func Seed(d *sql.DB, idx *data.Index) error {
	_ = idx // no longer used; kept in signature to avoid touching main.go

	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 1. Ensure superadmin user exists on first-run. On subsequent
	//    boots DO NOTHING — never overwrite a password change made
	//    via the UI or SQL.
	superHash, err := bcrypt.GenerateFromPassword([]byte("super123"), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO users(username, password_hash, role, display_name, activated_at)
		 VALUES($1, $2, 'superadmin', $3, CURRENT_TIMESTAMP)
		 ON CONFLICT (username) DO NOTHING`,
		"super", string(superHash), "System Superadmin",
	); err != nil {
		return err
	}

	// 2. Ensure onboarding ops_admin exists. Same DO NOTHING pattern.
	opsHash, err := bcrypt.GenerateFromPassword([]byte("ops123"), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO users(username, password_hash, role, display_name)
		 VALUES($1, $2, 'ops_admin', $3)
		 ON CONFLICT (username) DO NOTHING`,
		"ops", string(opsHash), "Onboarding Ops Admin",
	); err != nil {
		return err
	}

	return tx.Commit()
}
