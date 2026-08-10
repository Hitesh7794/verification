package db

import (
	"database/sql"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/data"
)

// Seed populates the database from the candidate index discovered on disk.
//
// What it creates:
//   - One organization per orgCode found in the sample data tree.
//   - One center per (orgCode, centerCode) found on disk, with the real name.
//   - A small set of demo users (super, admin, two clients) wired to the
//     first organization and its first two centers.
//
// What it does NOT create:
//   - Any synthetic verification history. The verifications table starts
//     empty so the admin and superadmin dashboards reflect only real
//     decisions made through the client portal.
//
// Seed is idempotent: it skips if a user already exists, and uses
// INSERT OR IGNORE for orgs/centers so it can be re-run safely.
func Seed(d *sql.DB, idx *data.Index) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 1. Sync organizations + centers from the candidate index.
	orgIDs := map[string]int64{}
	centerIDs := map[string]int64{} // key: orgCode + "/" + centerCode

	for _, c := range idx.Centers() {
		orgID, ok := orgIDs[c.OrgCode]
		if !ok {
			orgCode := strings.ToUpper(c.OrgCode)
			if _, err := tx.Exec(
				`INSERT OR IGNORE INTO organizations(code,name) VALUES(?,?)`,
				orgCode, orgCode,
			); err != nil {
				return err
			}
			if err := tx.QueryRow(
				`SELECT id FROM organizations WHERE code=?`, orgCode,
			).Scan(&orgID); err != nil {
				return err
			}
			orgIDs[c.OrgCode] = orgID
		}

		var centerID int64
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO centers(org_id,code,name) VALUES(?,?,?)`,
			orgID, c.Code, c.Name,
		); err != nil {
			return err
		}
		if err := tx.QueryRow(
			`SELECT id FROM centers WHERE org_id=? AND code=?`, orgID, c.Code,
		).Scan(&centerID); err != nil {
			return err
		}
		centerIDs[c.OrgCode+"/"+c.Code] = centerID
	}

	// 2. Seed demo users — only if there are no users yet.
	var userCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&userCount); err != nil {
		return err
	}
	if userCount == 0 && len(idx.Centers()) > 0 {
		centers := idx.Centers()
		firstOrgID := orgIDs[centers[0].OrgCode]
		firstCenterID := centerIDs[centers[0].OrgCode+"/"+centers[0].Code]
		secondCenterID := firstCenterID
		if len(centers) > 1 {
			secondCenterID = centerIDs[centers[1].OrgCode+"/"+centers[1].Code]
		}

		mkUser := func(username, pwd, role, display string, orgID, centerID *int64) error {
			hash, err := bcrypt.GenerateFromPassword([]byte(pwd), bcrypt.DefaultCost)
			if err != nil {
				return err
			}
			// Shared operator (client role) needs the plaintext column
			// populated so the admin's "Operator access" dashboard can
			// surface it. Human roles (admin/superadmin) intentionally
			// do not store plaintext — see migration 010.
			var plaintext any
			if role == "client" {
				plaintext = pwd
			}
			_, err = tx.Exec(`INSERT INTO users(username,password_hash,password_plaintext,role,org_id,center_id,display_name,activated_at)
			                  VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
				username, string(hash), plaintext, role, orgID, centerID, display)
			return err
		}

		if err := mkUser("super", "super123", "superadmin", "System Superadmin", nil, nil); err != nil {
			return err
		}
		if err := mkUser("admin", "admin123", "admin", "Exam Controller", &firstOrgID, nil); err != nil {
			return err
		}
		if err := mkUser("client", "client123", "client",
			centers[0].Name+" Operator", &firstOrgID, &firstCenterID); err != nil {
			return err
		}
		if len(centers) > 1 {
			if err := mkUser("client2", "client123", "client",
				centers[1].Name+" Operator", &firstOrgID, &secondCenterID); err != nil {
				return err
			}
		}
	}

	// 3. Idempotent: ensure an ops_admin user exists. Runs on every
	//    boot (not just first-run) so introducing migration 7 on an
	//    existing DB still seeds the new role. INSERT OR IGNORE on
	//    UNIQUE(username) makes this safe to re-run.
	hash, err := bcrypt.GenerateFromPassword([]byte("ops123"), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT OR IGNORE INTO users(username, password_hash, role, display_name)
		 VALUES(?, ?, 'ops_admin', ?)`,
		"ops", string(hash), "Onboarding Ops Admin",
	); err != nil {
		return err
	}

	// 4. Idempotent: backfill password_plaintext for the demo client
	//    seed users so the demo admin's "Operator access" dashboard
	//    surfaces a working credential. Only touches rows where
	//    plaintext is NULL — never overwrites an admin-set value. The
	//    constant "client123" mirrors what mkUser would have set on
	//    first-run for these specific seeded users.
	if _, err := tx.Exec(
		`UPDATE users
		 SET password_plaintext = 'client123'
		 WHERE role = 'client'
		   AND username IN ('client', 'client2')
		   AND password_plaintext IS NULL`,
	); err != nil {
		return err
	}

	// 5. Idempotent: mark the seeded super + ops accounts as needing
	//    a password rotation on next login. Anyone with the source
	//    code knows `super123` / `ops123`, so we refuse to let those
	//    accounts do anything until a real password is set. Only
	//    touches users whose password_hash hasn't been changed away
	//    from the seeded bcrypt — if the operator has already rotated
	//    (the flag was cleared), we don't re-set it.
	if _, err := tx.Exec(
		`UPDATE users
		 SET password_change_required = 1
		 WHERE username IN ('super', 'ops')
		   AND password_change_required = 0
		   -- Only on bcrypt of original seed, never after a real change.
		   -- We can't check the cleartext, but we can check that the
		   -- user has never updated activated_at past created_at.
		   AND activated_at = created_at`,
	); err != nil {
		return err
	}

	return tx.Commit()
}
