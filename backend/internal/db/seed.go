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
//   - One organization per orgCode found in the sample data tree
//     (via the filesystem index that boots the process).
//   - A minimal set of demo users on first-run only (super, admin,
//     two client operators) wired to the first discovered organization.
//   - An ops_admin user (idempotent, every boot).
//
// What it does NOT create anymore:
//   - The legacy `centers` table (dropped by migration 021). The
//     filesystem index still surfaces per-centre folders, but the DB
//     no longer stores that concept — exam_centres (per-exam CSV
//     upload) is the modern replacement.
//   - Synthetic verifications — the table starts empty so dashboards
//     reflect only real decisions made through the client portal.
//
// Seed is idempotent: it skips if a user already exists, and uses
// INSERT OR IGNORE for orgs so it can be re-run safely.
func Seed(d *sql.DB, idx *data.Index) error {
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 1. Sync organizations discovered under the sample data tree.
	orgIDs := map[string]int64{}
	for _, c := range idx.Centers() {
		if _, seen := orgIDs[c.OrgCode]; seen {
			continue
		}
		orgCode := strings.ToUpper(c.OrgCode)
		if _, err := tx.Exec(
			`INSERT INTO organizations(code,name) VALUES($1,$2) ON CONFLICT (code) DO NOTHING`,
			orgCode, orgCode,
		); err != nil {
			return err
		}
		var orgID int64
		if err := tx.QueryRow(
			`SELECT id FROM organizations WHERE code=$1`, orgCode,
		).Scan(&orgID); err != nil {
			return err
		}
		orgIDs[c.OrgCode] = orgID
	}

	// 2. Seed demo users — only if there are no users yet.
	var userCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&userCount); err != nil {
		return err
	}
	if userCount == 0 && len(idx.Centers()) > 0 {
		centers := idx.Centers()
		firstOrgID := orgIDs[centers[0].OrgCode]

		mkUser := func(username, pwd, role, display string, orgID *int64) error {
			hash, err := bcrypt.GenerateFromPassword([]byte(pwd), bcrypt.DefaultCost)
			if err != nil {
				return err
			}
			// Shared operator (client role) needs the plaintext column
			// populated so the admin's operators dashboard can surface
			// it. Human roles (admin/superadmin) intentionally do not
			// store plaintext — see migration 010.
			var plaintext any
			if role == "client" {
				plaintext = pwd
			}
			_, err = tx.Exec(`INSERT INTO users(username,password_hash,password_plaintext,role,org_id,display_name,activated_at)
			                  VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)`,
				username, string(hash), plaintext, role, orgID, display)
			return err
		}

		if err := mkUser("super", "super123", "superadmin", "System Superadmin", nil); err != nil {
			return err
		}
		if err := mkUser("admin", "admin123", "admin", "Exam Controller", &firstOrgID); err != nil {
			return err
		}
		if err := mkUser("client", "client123", "client",
			centers[0].Name+" Operator", &firstOrgID); err != nil {
			return err
		}
		if len(centers) > 1 {
			if err := mkUser("client2", "client123", "client",
				centers[1].Name+" Operator", &firstOrgID); err != nil {
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
		`INSERT INTO users(username, password_hash, role, display_name)
		 VALUES($1, $2, 'ops_admin', $3)
		 ON CONFLICT (username) DO NOTHING`,
		"ops", string(hash), "Onboarding Ops Admin",
	); err != nil {
		return err
	}

	// 4. Idempotent: backfill password_plaintext for the demo client
	//    seed users so the demo admin's operators dashboard surfaces
	//    a working credential. Only touches rows where plaintext is
	//    NULL — never overwrites an admin-set value.
	if _, err := tx.Exec(
		`UPDATE users
		 SET password_plaintext = 'client123'
		 WHERE role = 'client'
		   AND username IN ('client', 'client2')
		   AND password_plaintext IS NULL`,
	); err != nil {
		return err
	}

	// 5. Was: idempotent re-flag of super/ops needing password rotation.
	//    Removed 2026-08-13 -- the condition `activated_at = created_at`
	//    stays TRUE forever on the seeded row (nothing updates
	//    activated_at), so every backend restart flipped
	//    password_change_required back to 1 and locked the operator
	//    out of super login. Demo boxes are fine with the seeded
	//    credential; production deployments should rotate super
	//    manually and rely on password_change_required only at
	//    initial-invite time (mig 011 semantics).

	return tx.Commit()
}
