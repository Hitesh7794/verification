// dev-seed — populate a local dev database with demo data.
//
// Why this exists: the normal Seed() in internal/db only creates demo
// users when the bundled candidate tree (gndu27/) is present on disk.
// That tree is gitignored and lives outside the repo, so anyone who
// gets the code as a ZIP or a fresh clone boots into an empty portal —
// no organizations, no admin login, and therefore no way to reach the
// admin-side pages at all.
//
// Clients, exams and candidates are never seeded by the app under any
// circumstance (they're superadmin-authored through the UI), so this
// also lays down a small catalog so the Phase 1-2 screens have
// something to render.
//
// Safe to re-run: every insert is idempotent on a natural key.
// Local development only — never point this at a real database.
//
//	cd backend && go run ./cmd/dev-seed
package main

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	_ "modernc.org/sqlite"
	"golang.org/x/crypto/bcrypt"
)

const dbPath = "verification.db"

func main() {
	d, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer d.Close()

	// Foreign keys off during seeding: we insert parents and children in
	// dependency order anyway, and SQLite's FK enforcement plus the
	// ON CONFLICT upserts below interact badly on re-runs.
	if _, err := d.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		log.Fatal(err)
	}

	// Ensure required tables exist
	if _, err := d.Exec(`
		CREATE TABLE IF NOT EXISTS organizations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			code TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS wallets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id INTEGER NOT NULL UNIQUE,
			balance_paise INTEGER NOT NULL DEFAULT 0,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			password_plaintext TEXT,
			role TEXT NOT NULL,
			org_id INTEGER,
			client_id INTEGER,
			display_name TEXT NOT NULL,
			email TEXT,
			disabled_at DATETIME,
			activated_at DATETIME,
			password_change_required INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS clients (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			notes TEXT,
			visible INTEGER NOT NULL DEFAULT 1,
			closed INTEGER NOT NULL DEFAULT 0,
			closed_at DATETIME,
			portal_enabled INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS exams (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			client_id INTEGER NOT NULL,
			name TEXT NOT NULL,
			exam_code TEXT NOT NULL UNIQUE,
			trustview_ref TEXT,
			verification_from DATE NOT NULL,
			verification_to DATE NOT NULL,
			visible INTEGER NOT NULL DEFAULT 1,
			closed INTEGER NOT NULL DEFAULT 0,
			closed_at DATETIME,
			requires_face INTEGER NOT NULL DEFAULT 1,
			requires_fp INTEGER NOT NULL DEFAULT 1,
			requires_iris INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS exam_candidates (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			exam_id INTEGER NOT NULL,
			roll_no TEXT NOT NULL,
			name TEXT NOT NULL,
			verification_date DATE,
			registration_id TEXT,
			father_name TEXT,
			dob DATE,
			gender TEXT,
			shift_name TEXT,
			centre_code TEXT,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (exam_id, roll_no)
		);
		CREATE TABLE IF NOT EXISTS organization_exam_subscriptions (
			org_id INTEGER NOT NULL,
			exam_id INTEGER NOT NULL,
			subscribed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			subscribed_by INTEGER,
			PRIMARY KEY (org_id, exam_id)
		);
		CREATE TABLE IF NOT EXISTS centers (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id INTEGER NOT NULL,
			code TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE (org_id, code)
		);
		CREATE TABLE IF NOT EXISTS verifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			roll_no TEXT NOT NULL,
			org_id INTEGER NOT NULL,
			center_id INTEGER,
			operator_id INTEGER NOT NULL,
			face_match INTEGER NOT NULL DEFAULT 0,
			fp_match INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			note TEXT,
			via TEXT,
			fp_match_score INTEGER,
			face_match_score REAL,
			match_threshold INTEGER,
			decision_ms INTEGER,
			client_app_version TEXT,
			idempotency_key TEXT,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`); err != nil {
		log.Fatal("create tables: ", err)
	}

	// Safe alter table for existing SQLite databases
	cols := []string{
		"ALTER TABLE verifications ADD COLUMN center_id INTEGER",
		"ALTER TABLE verifications ADD COLUMN operator_id INTEGER DEFAULT 1",
		"ALTER TABLE verifications ADD COLUMN fp_match_score INTEGER",
		"ALTER TABLE verifications ADD COLUMN face_match_score REAL",
		"ALTER TABLE verifications ADD COLUMN match_threshold INTEGER",
		"ALTER TABLE verifications ADD COLUMN decision_ms INTEGER",
		"ALTER TABLE verifications ADD COLUMN client_app_version TEXT",
		"ALTER TABLE verifications ADD COLUMN via TEXT",
		"ALTER TABLE users ADD COLUMN password_plaintext TEXT",
		"ALTER TABLE users ADD COLUMN activated_at DATETIME",
		"ALTER TABLE users ADD COLUMN password_change_required INTEGER DEFAULT 0",
		"ALTER TABLE users ADD COLUMN client_id INTEGER",
	}
	for _, colStmt := range cols {
		_, _ = d.Exec(colStmt)
	}

	tx, err := d.Begin()
	if err != nil {
		log.Fatal(err)
	}
	defer tx.Rollback()

	// ── 1. Organization (the college that logs in and holds the wallet)
	orgID, err := upsertOrg(tx, "GNDU27", "Guru Nanak Dev University")
	if err != nil {
		log.Fatal("org: ", err)
	}

	// Wallet with ₹500 so candidate lookups aren't blocked by the 402 path.
	if _, err := tx.Exec(
		`INSERT INTO wallets(org_id, balance_paise) VALUES(?, 50000)
		 ON CONFLICT(org_id) DO UPDATE SET balance_paise = 50000`,
		orgID,
	); err != nil {
		log.Fatal("wallet: ", err)
	}

	// ── 2. Users. Mirrors what internal/db/seed.go would have created,
	// minus the centre wiring — migration 017 made center_id nullable,
	// so operators no longer need one.
	for _, u := range []struct {
		username, password, role, display string
		org                               *int64
	}{
		{"admin", "admin123", "admin", "Exam Controller", &orgID},
		{"client", "client123", "client", "GNDU Operator", &orgID},
	} {
		if err := upsertUser(tx, u.username, u.password, u.role, u.display, u.org); err != nil {
			log.Fatalf("user %s: %v", u.username, err)
		}
	}

	// ── 3. Clients (exam-conducting bodies) + their exams.
	// Dates are relative to today so the verification window is open and
	// the exams are actually searchable rather than expired.
	today := time.Now()
	window := func(fromDays, toDays int) (string, string) {
		const d = "2006-01-02"
		return today.AddDate(0, 0, fromDays).Format(d),
			today.AddDate(0, 0, toDays).Format(d)
	}

	type exam struct {
		name, code, trustview string
		fromDays, toDays      int
		candidates            int
	}
	catalog := []struct {
		client, notes string
		exams         []exam
	}{
		{
			client: "National Testing Agency",
			notes:  "Central body — NEET, JEE, CUET",
			exams: []exam{
				{"NEET UG 2026", "EXAM-2026-01", "TV-NEET-UG-2026", -5, 25, 12},
				{"CUET UG 2026", "EXAM-2026-02", "TV-CUET-UG-2026", 3, 40, 8},
			},
		},
		{
			client: "Punjab School Education Board",
			notes:  "State board — class XII certification",
			exams: []exam{
				{"PSEB Class XII 2026", "EXAM-2026-03", "TV-PSEB-XII-2026", -10, 15, 10},
			},
		},
		{
			client: "Uttar Pradesh Government",
			notes:  "State recruitment examinations",
			exams: []exam{
				// Deliberately already-expired, so the UI has a window
				// that has closed to render differently.
				{"UP Police Constable 2025", "EXAM-2025-77", "TV-UPP-2025", -120, -60, 5},
			},
		},
	}

	rollSeq := 10001
	var nClients, nExams, nCands int

	for _, entry := range catalog {
		clientID, err := upsertClient(tx, entry.client, entry.notes)
		if err != nil {
			log.Fatalf("client %s: %v", entry.client, err)
		}
		nClients++

		for _, e := range entry.exams {
			from, to := window(e.fromDays, e.toDays)
			examID, err := upsertExam(tx, clientID, e.name, e.code, e.trustview, from, to)
			if err != nil {
				log.Fatalf("exam %s: %v", e.code, err)
			}
			nExams++

			for i := 0; i < e.candidates; i++ {
				roll := fmt.Sprintf("%d", rollSeq)
				rollSeq++
				if _, err := tx.Exec(
					`INSERT INTO exam_candidates(exam_id, roll_no, name, verification_date)
					 VALUES(?,?,?,?)
					 ON CONFLICT(exam_id, roll_no) DO NOTHING`,
					examID, roll, fmt.Sprintf("Candidate %s", roll), to,
				); err != nil {
					log.Fatalf("candidate %s: %v", roll, err)
				}
				nCands++
			}

			// Subscribe the demo college to every open exam so the
			// admin's "My exams" page isn't empty on first look.
			if e.toDays > 0 {
				if _, err := tx.Exec(
					`INSERT INTO organization_exam_subscriptions(org_id, exam_id)
					 VALUES(?,?) ON CONFLICT(org_id, exam_id) DO NOTHING`,
					orgID, examID,
				); err != nil {
					log.Fatalf("subscription %s: %v", e.code, err)
				}
			}
		}
	}

	// ── 4. More organizations + centers + verification history, so the
	// superadmin Overview has something to plot. Without this the
	// dashboard renders empty axes: `verifications` starts at zero by
	// design (seed.go deliberately creates no synthetic history) and
	// `centers` only ever came from the candidate tree.
	nOrgs, nCenters, nVerifs, err := seedTelemetry(tx, orgID)
	if err != nil {
		log.Fatal("telemetry: ", err)
	}

	if err := tx.Commit(); err != nil {
		log.Fatal(err)
	}

	fmt.Printf(`dev-seed complete

  organizations   %d  (GNDU27 wallet ₹500.00)
  centers         %d
  clients         %d
  exams           %d
  candidates      %d  (rolls 10001-%d)
  verifications   %d  (last 14 days)

logins
  super  / superadmin123   superadmin
  admin  / admin123        admin
  client / client123       operator
`, nOrgs, nCenters, nClients, nExams, nCands, rollSeq-1, nVerifs)
}

// seedTelemetry lays down the cross-organization data the superadmin
// Overview charts read: several colleges, centres under each, and a
// spread of verifications over the last 14 days.
//
// Volumes are deliberately uneven between organizations — a share chart
// of five near-identical slices tells you nothing, and would be the kind
// of chart that looks fine and says nothing.
//
// Idempotent: demo verifications are tagged client_app_version='dev-seed'
// and cleared before re-inserting, so a re-run replaces rather than
// compounds. Real rows written through the portal are never touched.
func seedTelemetry(tx *sql.Tx, primaryOrgID int64) (int, int, int, error) {
	if _, err := tx.Exec(
		`DELETE FROM verifications WHERE client_app_version = 'dev-seed'`,
	); err != nil {
		return 0, 0, 0, err
	}

	type orgSpec struct {
		code, name string
		centers    []string
		// weight drives this org's share of total volume.
		weight int
		// successRate in percent — varied so the per-org success column
		// isn't a flat 90% down the table.
		successRate int
	}
	specs := []orgSpec{
		{"GNDU27", "Guru Nanak Dev University",
			[]string{"Saragarhi Memorial", "Khalsa College SS School"}, 34, 94},
		{"PU-CHD", "Panjab University Chandigarh",
			[]string{"Sector 14 Campus", "Sector 25 Annexe"}, 26, 91},
		{"DU-NORTH", "Delhi University North Campus",
			[]string{"Hansraj Hall", "Kirori Mal Block C"}, 19, 88},
		{"BHU-VNS", "Banaras Hindu University",
			[]string{"Main Examination Hall"}, 13, 82},
		{"AMU-ALG", "Aligarh Muslim University",
			[]string{"Kennedy Hall"}, 8, 76},
	}

	// Channel mix. Fingerprint dominates because it's the highest-assurance
	// path and the one the operator flow tries first; manual is the small
	// tail where no biometric matched but the operator passed the candidate.
	channels := []struct {
		via    string
		weight int
	}{
		{"fingerprint", 62},
		{"face", 21},
		{"iris", 11},
		{"manual", 6},
	}

	const totalVerifications = 1450
	// Deterministic pseudo-random: a plain LCG rather than math/rand so a
	// re-run produces byte-identical data and screenshots stay comparable.
	seed := uint64(20260811)
	next := func(n int) int {
		seed = seed*6364136223846793005 + 1442695040888963407
		return int((seed >> 33) % uint64(n))
	}

	nOrgs, nCenters, nVerifs := 0, 0, 0
	totalWeight := 0
	for _, s := range specs {
		totalWeight += s.weight
	}

	for _, spec := range specs {
		oid := primaryOrgID
		if spec.code != "GNDU27" {
			var err error
			oid, err = upsertOrg(tx, spec.code, spec.name)
			if err != nil {
				return 0, 0, 0, err
			}
			// Every college gets a wallet so the admin view is coherent.
			if _, err := tx.Exec(
				`INSERT INTO wallets(org_id, balance_paise) VALUES(?, ?)
				 ON CONFLICT(org_id) DO NOTHING`,
				oid, 25000,
			); err != nil {
				return 0, 0, 0, err
			}
		}
		nOrgs++

		// An operator to attribute the verifications to. One per org.
		opUser := "op_" + strings.ToLower(spec.code)
		if err := upsertUser(tx, opUser, "client123", "client",
			spec.name+" Operator", &oid); err != nil {
			return 0, 0, 0, err
		}
		var opID int64
		if err := tx.QueryRow(
			`SELECT id FROM users WHERE username=?`, opUser,
		).Scan(&opID); err != nil {
			return 0, 0, 0, err
		}

		var centerIDs []int64
		for i, cname := range spec.centers {
			code := fmt.Sprintf("%s-C%d", spec.code, i+1)
			if _, err := tx.Exec(
				`INSERT INTO centers(org_id, code, name) VALUES(?,?,?)
				 ON CONFLICT(org_id, code) DO UPDATE SET name = excluded.name`,
				oid, code, cname,
			); err != nil {
				return 0, 0, 0, err
			}
			var cid int64
			if err := tx.QueryRow(
				`SELECT id FROM centers WHERE org_id=? AND code=?`, oid, code,
			).Scan(&cid); err != nil {
				return 0, 0, 0, err
			}
			centerIDs = append(centerIDs, cid)
			nCenters++
		}

		count := totalVerifications * spec.weight / totalWeight
		for i := 0; i < count; i++ {
			verified := next(100) < spec.successRate
			status := "denied"
			if verified {
				status = "verified"
			}

			// Weighted channel pick. Denied rows keep a channel too —
			// the attempt happened, it just didn't clear threshold.
			roll := next(100)
			via := channels[len(channels)-1].via
			acc := 0
			for _, ch := range channels {
				acc += ch.weight
				if roll < acc {
					via = ch.via
					break
				}
			}

			// Spread over 14 days with a weekday-ish rhythm: day 0 is
			// today. Bias toward recent days so the trend line rises.
			day := next(14)
			if next(100) < 35 {
				day = next(5) // recency bump
			}
			hour := 8 + next(11) // exam hours, 08:00-18:00
			minute := next(60)

			cid := centerIDs[next(len(centerIDs))]

			fpScore := 0
			if via == "fingerprint" {
				if verified {
					fpScore = 180 + next(320)
				} else {
					fpScore = next(35)
				}
			}
			faceScore := 0.0
			if via == "face" {
				if verified {
					faceScore = 0.990 + float64(next(9))/1000
				} else {
					faceScore = 0.70 + float64(next(250))/1000
				}
			}

			if _, err := tx.Exec(
				`INSERT INTO verifications
					(roll_no, org_id, center_id, operator_id,
					 face_match, fp_match, status, via,
					 fp_match_score, face_match_score, match_threshold,
					 decision_ms, client_app_version, created_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'dev-seed',
					 datetime('now', ?, ?, ?))`,
				fmt.Sprintf("%d", 10001+next(500)),
				oid, cid, opID,
				boolInt(via == "face" && verified),
				boolInt(via == "fingerprint" && verified),
				status, via,
				nullZeroInt(fpScore), nullZeroFloat(faceScore), 40,
				1200+next(9000),
				fmt.Sprintf("-%d days", day),
				fmt.Sprintf("%d hours", hour-12),
				fmt.Sprintf("%d minutes", minute),
			); err != nil {
				return 0, 0, 0, err
			}
			nVerifs++
		}
	}
	return nOrgs, nCenters, nVerifs, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// The dashboards treat 0 and NULL differently in a few averages, so keep
// "not measured" as NULL rather than a real zero.
func nullZeroInt(v int) any {
	if v == 0 {
		return nil
	}
	return v
}

func nullZeroFloat(v float64) any {
	if v == 0 {
		return nil
	}
	return v
}

func upsertOrg(tx *sql.Tx, code, name string) (int64, error) {
	if _, err := tx.Exec(
		`INSERT INTO organizations(code, name) VALUES(?,?)
		 ON CONFLICT(code) DO UPDATE SET name = excluded.name`,
		code, name,
	); err != nil {
		return 0, err
	}
	var id int64
	err := tx.QueryRow(`SELECT id FROM organizations WHERE code=?`, code).Scan(&id)
	return id, err
}

// upsertUser writes a login. password_plaintext is populated only for
// the operator role, matching seed.go — the admin's "Operator access"
// page reads that column to show the shared credential.
func upsertUser(tx *sql.Tx, username, pwd, role, display string, orgID *int64) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(pwd), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	var plaintext any
	if role == "client" {
		plaintext = pwd
	}
	// created_at is backdated so seed.go's step-5 rotation sweep
	// (which matches on activated_at = created_at) leaves these alone
	// and we don't get bounced to the password-change screen on boot.
	_, err = tx.Exec(
		`INSERT INTO users
			(username, password_hash, password_plaintext, role, org_id,
			 display_name, created_at, activated_at, password_change_required)
		 VALUES (?,?,?,?,?,?, datetime('now','-1 hour'), CURRENT_TIMESTAMP, 0)
		 ON CONFLICT(username) DO UPDATE SET
			password_hash            = excluded.password_hash,
			password_plaintext       = excluded.password_plaintext,
			role                     = excluded.role,
			org_id                   = excluded.org_id,
			password_change_required = 0,
			disabled_at              = NULL`,
		username, string(hash), plaintext, role, orgID, display)
	return err
}

func upsertClient(tx *sql.Tx, name, notes string) (int64, error) {
	var id int64
	err := tx.QueryRow(`SELECT id FROM clients WHERE name=?`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	res, err := tx.Exec(`INSERT INTO clients(name, notes) VALUES(?,?)`, name, notes)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func upsertExam(tx *sql.Tx, clientID int64, name, code, trustview, from, to string) (int64, error) {
	var id int64
	err := tx.QueryRow(`SELECT id FROM exams WHERE exam_code=?`, code).Scan(&id)
	if err == nil {
		_, err = tx.Exec(
			`UPDATE exams SET verification_from=?, verification_to=? WHERE id=?`,
			from, to, id)
		return id, err
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	res, err := tx.Exec(
		`INSERT INTO exams(client_id, name, exam_code, trustview_ref,
		                   verification_from, verification_to)
		 VALUES(?,?,?,?,?,?)`,
		clientID, name, code, trustview, from, to)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}
