package db

import (
	"database/sql"
	"strings"
	"time"

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

	// Ensure default demo org GNDU27 exists if no orgs found in data tree
	if len(orgIDs) == 0 {
		if _, err := tx.Exec(
			`INSERT INTO organizations(code, name) VALUES($1, $2) ON CONFLICT (code) DO NOTHING`,
			"GNDU27", "Guru Nanak Dev University",
		); err != nil {
			return err
		}
		var gnduID int64
		if err := tx.QueryRow(`SELECT id FROM organizations WHERE code=$1`, "GNDU27").Scan(&gnduID); err == nil {
			orgIDs["GNDU27"] = gnduID
			_, _ = tx.Exec(
				`INSERT INTO wallets(org_id, balance_paise) VALUES($1, 50000) ON CONFLICT (org_id) DO NOTHING`,
				gnduID,
			)
		}
	}

	// 2. Ensure superadmin user exists (idempotent, every boot).
	superHash, err := bcrypt.GenerateFromPassword([]byte("super123"), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO users(username, password_hash, role, display_name, activated_at)
		 VALUES($1, $2, 'superadmin', $3, CURRENT_TIMESTAMP)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
		"super", string(superHash), "System Superadmin",
	); err != nil {
		return err
	}

	// Seed demo admin & client operator if org is available
	var firstOrgID *int64
	for _, oid := range orgIDs {
		idCopy := oid
		firstOrgID = &idCopy
		break
	}

	if firstOrgID != nil {
		adminHash, err := bcrypt.GenerateFromPassword([]byte("admin123"), bcrypt.DefaultCost)
		if err == nil {
			_, _ = tx.Exec(
				`INSERT INTO users(username, password_hash, role, org_id, display_name, activated_at)
				 VALUES($1, $2, 'admin', $3, $4, CURRENT_TIMESTAMP)
				 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
				"admin", string(adminHash), firstOrgID, "Exam Controller",
			)
		}

		clientHash, err := bcrypt.GenerateFromPassword([]byte("client123"), bcrypt.DefaultCost)
		if err == nil {
			_, _ = tx.Exec(
				`INSERT INTO users(username, password_hash, password_plaintext, role, org_id, display_name, activated_at)
				 VALUES($1, $2, 'client123', 'client', $3, $4, CURRENT_TIMESTAMP)
				 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, password_plaintext = EXCLUDED.password_plaintext`,
				"client", string(clientHash), firstOrgID, "GNDU Operator",
			)
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

	// 5. Idempotent: seed a default exam board (client) and 3 exams for the catalog
	var clientID int64
	err = tx.QueryRow(`SELECT id FROM clients WHERE name = 'National Testing Agency'`).Scan(&clientID)
	if err == sql.ErrNoRows {
		err = tx.QueryRow(`
			INSERT INTO clients(name, notes, visible, closed)
			VALUES('National Testing Agency', 'Central testing agency for national level entrance examinations', 1, 0)
			RETURNING id
		`).Scan(&clientID)
	}
	if err != nil && err != sql.ErrNoRows {
		return err
	}

	if clientID > 0 {
		catalogExams := []struct {
			name     string
			code     string
			ref      string
			fromDays int
			toDays   int
		}{
			{"NEET UG 2026", "NEET-UG-2026", "TV-NEET-2026", -30, 90},
			{"JEE Main 2026", "JEE-MAIN-2026", "TV-JEE-2026", -15, 60},
			{"CUET UG 2026", "CUET-UG-2026", "TV-CUET-2026", -5, 45},
		}

		today := time.Now()
		for _, ex := range catalogExams {
			vFrom := today.AddDate(0, 0, ex.fromDays).Format("2006-01-02")
			vTo := today.AddDate(0, 0, ex.toDays).Format("2006-01-02")
			_, _ = tx.Exec(`
				INSERT INTO exams(client_id, name, exam_code, trustview_ref, verification_from, verification_to, visible, closed, requires_face, requires_fp, requires_iris)
				VALUES($1, $2, $3, $4, $5, $6, 1, 0, 1, 1, 0)
				ON CONFLICT (exam_code) DO NOTHING
			`, clientID, ex.name, ex.code, ex.ref, vFrom, vTo)
		}
	}

	return tx.Commit()
}
