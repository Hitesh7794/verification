// dev-seed — populate local PostgreSQL dev database with realistic multi-tenant data.
//
// Seeds:
//   - Superadmin (super / super123)
//   - 4 Clients / Exam Boards (NTA, AIIMS, UPSC, CBSE) with dedicated Client Reviewer logins
//   - 8 Universities & Colleges with Admin accounts & Wallets
//   - Multiple open Exams with Candidate rosters
//   - Various Subscription Requests across institutions (Pending, Approved per-exam, Blanket Partner)
//
// Usage:
//   cd backend && go run ./cmd/dev-seed
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/config"
	"github.com/veni/neet-verification/internal/db"
)

func main() {
	cfg := config.Load()
	dsn := cfg.DatabaseURL
	if dsn == "" {
		dsn = "postgres://portal:portal-dev@127.0.0.1:5434/verification?sslmode=disable"
	}

	log.Printf("Connecting to PostgreSQL at %s ...", dsn)
	d, err := db.Open(dsn)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer d.Close()

	if err := db.Migrate(d); err != nil {
		log.Fatalf("failed to migrate database: %v", err)
	}

	ctx := context.Background()
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		log.Fatalf("failed to start tx: %v", err)
	}
	defer tx.Rollback()

	log.Println("Seeding core superadmin...")
	superHash, _ := bcrypt.GenerateFromPassword([]byte("super123"), bcrypt.DefaultCost)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users(username, password_hash, role, display_name, activated_at)
		VALUES('super', $1, 'superadmin', 'System Superadmin', NOW())
		ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
		string(superHash),
	); err != nil {
		log.Fatalf("seed superadmin: %v", err)
	}

	_, _ = tx.ExecContext(ctx, `
		INSERT INTO platform_users(username, password_hash, role, display_name)
		VALUES('super', $1, 'superadmin', 'System Superadmin')
		ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
		string(superHash),
	)

	// ─────────────────────────────────────────────────────────────────────────
	// 1. SEED CLIENTS (EXAM BOARDS) & REVIEWER LOGINS
	// ─────────────────────────────────────────────────────────────────────────
	log.Println("Seeding clients & reviewers...")
	type clientDef struct {
		name         string
		notes        string
		reviewerUser string
		reviewerName string
		reviewerPass string
	}

	clients := []clientDef{
		{
			name:         "National Testing Agency (NTA)",
			notes:        "Premier testing organization for higher educational institutions",
			reviewerUser: "nta_reviewer",
			reviewerName: "NTA Examination Reviewer",
			reviewerPass: "reviewer123",
		},
		{
			name:         "All India Institute of Medical Sciences (AIIMS)",
			notes:        "Autonomous institutes of national importance for medical education",
			reviewerUser: "aiims_reviewer",
			reviewerName: "AIIMS Medical Board Reviewer",
			reviewerPass: "reviewer123",
		},
		{
			name:         "Union Public Service Commission (UPSC)",
			notes:        "Central recruiting agency for civil services and defence forces",
			reviewerUser: "upsc_reviewer",
			reviewerName: "UPSC Verification Officer",
			reviewerPass: "reviewer123",
		},
		{
			name:         "Central Board of Secondary Education (CBSE)",
			notes:        "National board of education for public and private schools",
			reviewerUser: "cbse_reviewer",
			reviewerName: "CBSE Accreditation Reviewer",
			reviewerPass: "reviewer123",
		},
	}

	clientIDs := map[string]int64{}
	reviewerHash, _ := bcrypt.GenerateFromPassword([]byte("reviewer123"), bcrypt.DefaultCost)

	for _, c := range clients {
		var cid int64
		err := tx.QueryRowContext(ctx, `SELECT id FROM clients WHERE name = $1`, c.name).Scan(&cid)
		if err == sql.ErrNoRows {
			err = tx.QueryRowContext(ctx, `
				INSERT INTO clients(name, notes, visible, closed, portal_enabled, created_at, updated_at)
				VALUES($1, $2, 1, 0, TRUE, NOW(), NOW())
				RETURNING id`,
				c.name, c.notes,
			).Scan(&cid)
		} else if err == nil {
			_, err = tx.ExecContext(ctx, `
				UPDATE clients SET notes = $1, portal_enabled = TRUE, visible = 1, closed = 0, updated_at = NOW()
				WHERE id = $2`,
				c.notes, cid,
			)
		}
		if err != nil {
			log.Fatalf("seed client %s: %v", c.name, err)
		}
		clientIDs[c.name] = cid

		// Create reviewer user scoped to this client
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO users(username, password_hash, role, display_name, email, activated_at, client_id)
			VALUES($1, $2, 'client_reviewer', $3, $4, NOW(), $5)
			ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, client_id = EXCLUDED.client_id, role = 'client_reviewer'`,
			c.reviewerUser, string(reviewerHash), c.reviewerName, c.reviewerUser+"@exam.gov.in", cid,
		); err != nil {
			log.Fatalf("seed reviewer %s: %v", c.reviewerUser, err)
		}

		// Also ensure client exists in Control Plane clients_registry
		_, _ = tx.ExecContext(ctx, `
			INSERT INTO clients_registry(name, kyc_review_mode, status, api_url, api_key, notes)
			VALUES($1, 'both', 'active', 'http://localhost:8080', 'dev-internal-secret', $2)
			ON CONFLICT (name) DO UPDATE SET status = 'active', api_url = EXCLUDED.api_url`,
			c.name, c.notes,
		)
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 2. SEED EXAMS UNDER CLIENTS
	// ─────────────────────────────────────────────────────────────────────────
	log.Println("Seeding exams...")
	type examDef struct {
		clientName string
		examCode   string
		name       string
		from       string
		to         string
	}

	exams := []examDef{
		// NTA Exams
		{"National Testing Agency (NTA)", "NEET-UG-2026", "National Eligibility cum Entrance Test (UG) 2026", "2026-05-01", "2026-05-30"},
		{"National Testing Agency (NTA)", "JEE-MAIN-2026", "Joint Entrance Examination (Main) Session 2", "2026-04-10", "2026-04-28"},
		{"National Testing Agency (NTA)", "CUET-UG-2026", "Common University Entrance Test (UG) 2026", "2026-05-15", "2026-06-10"},
		{"National Testing Agency (NTA)", "UGC-NET-2026", "National Eligibility Test for Assistant Professor", "2026-06-15", "2026-07-05"},

		// AIIMS Exams
		{"All India Institute of Medical Sciences (AIIMS)", "INI-CET-2026", "Institute of National Importance Combined Entrance Test", "2026-05-20", "2026-06-05"},
		{"All India Institute of Medical Sciences (AIIMS)", "AIIMS-MSC-2026", "AIIMS M.Sc & Post-Graduate Nursing Entrance", "2026-06-01", "2026-06-20"},

		// UPSC Exams
		{"Union Public Service Commission (UPSC)", "CSE-PRELIMS-2026", "Civil Services (Preliminary) Examination 2026", "2026-05-25", "2026-05-25"},
		{"Union Public Service Commission (UPSC)", "NDA-NA-2026", "National Defence Academy & Naval Academy Exam", "2026-09-01", "2026-09-01"},

		// CBSE Exams
		{"Central Board of Secondary Education (CBSE)", "CTET-2026", "Central Teacher Eligibility Test July 2026", "2026-07-01", "2026-07-15"},
		{"Central Board of Secondary Education (CBSE)", "CBSE-ACAD-2026", "CBSE Senior School Certificate Practical Exams", "2026-03-01", "2026-03-25"},
	}

	examIDs := map[string]int64{}
	for _, e := range exams {
		cid := clientIDs[e.clientName]
		var eid int64
		err := tx.QueryRowContext(ctx, `SELECT id FROM exams WHERE exam_code = $1`, e.examCode).Scan(&eid)
		if err == sql.ErrNoRows {
			err = tx.QueryRowContext(ctx, `
				INSERT INTO exams(client_id, name, exam_code, verification_from, verification_to, visible, closed, requires_face, requires_fp, created_at, updated_at)
				VALUES($1, $2, $3, $4, $5, 1, 0, 1, 1, NOW(), NOW())
				RETURNING id`,
				cid, e.name, e.examCode, e.from, e.to,
			).Scan(&eid)
		} else if err == nil {
			_, err = tx.ExecContext(ctx, `
				UPDATE exams SET client_id = $1, name = $2, verification_from = $3, verification_to = $4, updated_at = NOW()
				WHERE id = $5`,
				cid, e.name, e.from, e.to, eid,
			)
		}
		if err != nil {
			log.Fatalf("seed exam %s: %v", e.examCode, err)
		}
		examIDs[e.examCode] = eid

		// Seed demo candidates for each exam
		for cIdx := 1; cIdx <= 15; cIdx++ {
			roll := fmt.Sprintf("%s-ROLL-%04d", e.examCode, cIdx)
			candName := fmt.Sprintf("Candidate %03d (%s)", cIdx, e.examCode)
			_, _ = tx.ExecContext(ctx, `
				INSERT INTO exam_candidates(exam_id, roll_no, name, registration_id, gender, father_name, created_at)
				VALUES($1, $2, $3, $4, 'M', 'Father Name', NOW())
				ON CONFLICT (exam_id, roll_no) DO NOTHING`,
				eid, roll, candName, fmt.Sprintf("REG-%d-%04d", eid, cIdx),
			)
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 3. SEED ORGANIZATIONS (UNIVERSITIES & COLLEGES)
	// ─────────────────────────────────────────────────────────────────────────
	log.Println("Seeding universities & colleges...")
	type orgDef struct {
		code      string
		name      string
		instType  string
		aishe     string
		state     string
		city      string
		headName  string
		headEmail string
		headMob   string
		adminUser string
		adminPass string
	}

	orgs := []orgDef{
		{
			code:      "st_lawrance_2",
			name:      "St. Lawrence University",
			instType:  "university",
			aishe:     "U-0123",
			state:     "Delhi",
			city:      "New Delhi",
			headName:  "Dr. Robert Miller",
			headEmail: "registrar@stlawrence.edu.in",
			headMob:   "9876543210",
			adminUser: "st_lawrance_admin",
			adminPass: "admin123",
		},
		{
			code:      "dtu_delhi",
			name:      "Delhi Technological University",
			instType:  "university",
			aishe:     "U-0456",
			state:     "Delhi",
			city:      "Delhi",
			headName:  "Prof. Prateek Sharma",
			headEmail: "vc@dtu.ac.in",
			headMob:   "9811223344",
			adminUser: "dtu_admin",
			adminPass: "admin123",
		},
		{
			code:      "amity_univ",
			name:      "Amity University Noida",
			instType:  "university",
			aishe:     "U-0789",
			state:     "Uttar Pradesh",
			city:      "Noida",
			headName:  "Dr. Balvinder Shukla",
			headEmail: "vc@amity.edu",
			headMob:   "9822334455",
			adminUser: "amity_admin",
			adminPass: "admin123",
		},
		{
			code:      "manipal_univ",
			name:      "Manipal Academy of Higher Education",
			instType:  "university",
			aishe:     "U-0999",
			state:     "Karnataka",
			city:      "Manipal",
			headName:  "Lt. Gen. M.D. Venkatesh",
			headEmail: "registrar@manipal.edu",
			headMob:   "9833445566",
			adminUser: "manipal_admin",
			adminPass: "admin123",
		},
		{
			code:      "xaviers_mumbai",
			name:      "St. Xavier's College Mumbai",
			instType:  "college",
			aishe:     "C-1122",
			state:     "Maharashtra",
			city:      "Mumbai",
			headName:  "Dr. Rajendra Shinde",
			headEmail: "principal@xaviers.edu",
			headMob:   "9844556677",
			adminUser: "xaviers_admin",
			adminPass: "admin123",
		},
		{
			code:      "bit_mesra",
			name:      "Birla Institute of Technology (BIT Mesra)",
			instType:  "university",
			aishe:     "U-3344",
			state:     "Jharkhand",
			city:      "Ranchi",
			headName:  "Prof. Indranil Manna",
			headEmail: "vc@bitmesra.ac.in",
			headMob:   "9855667788",
			adminUser: "bit_admin",
			adminPass: "admin123",
		},
		{
			code:      "vit_vellore",
			name:      "Vellore Institute of Technology (VIT)",
			instType:  "university",
			aishe:     "U-5566",
			state:     "Tamil Nadu",
			city:      "Vellore",
			headName:  "Dr. G. Viswanathan",
			headEmail: "chancellor@vit.ac.in",
			headMob:   "9866778899",
			adminUser: "vit_admin",
			adminPass: "admin123",
		},
		{
			code:      "loyola_chennai",
			name:      "Loyola College Chennai",
			instType:  "college",
			aishe:     "C-7788",
			state:     "Tamil Nadu",
			city:      "Chennai",
			headName:  "Rev. Dr. A. Thomas",
			headEmail: "principal@loyolacollege.edu",
			headMob:   "9877889900",
			adminUser: "loyola_admin",
			adminPass: "admin123",
		},
	}

	adminHash, _ := bcrypt.GenerateFromPassword([]byte("admin123"), bcrypt.DefaultCost)
	orgIDs := map[string]int64{}

	for _, o := range orgs {
		var oid int64
		err := tx.QueryRowContext(ctx, `
			INSERT INTO organizations(code, name, created_at)
			VALUES($1, $2, NOW())
			ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
			RETURNING id`,
			o.code, o.name,
		).Scan(&oid)
		if err != nil {
			log.Fatalf("seed org %s: %v", o.code, err)
		}
		orgIDs[o.code] = oid

		// Wallet for organization
		_, _ = tx.ExecContext(ctx, `
			INSERT INTO wallets(org_id, balance_paise, updated_at)
			VALUES($1, 100000, NOW())
			ON CONFLICT (org_id) DO NOTHING`,
			oid,
		)

		// University Admin user
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO users(username, password_hash, role, org_id, display_name, email, activated_at)
			VALUES($1, $2, 'admin', $3, $4, $5, NOW())
			ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, org_id = EXCLUDED.org_id, role = 'admin'`,
			o.adminUser, string(adminHash), oid, o.name+" Administrator", o.headEmail,
		); err != nil {
			log.Fatalf("seed admin %s: %v", o.adminUser, err)
		}

		// Operator user for this university
		opUser := o.code + "_op1"
		opHash, _ := bcrypt.GenerateFromPassword([]byte("pass123"), bcrypt.DefaultCost)
		_, _ = tx.ExecContext(ctx, `
			INSERT INTO users(username, password_hash, role, org_id, display_name, email, activated_at, spending_cap_paise, spent_paise)
			VALUES($1, $2, 'client', $3, $4, $5, NOW(), 50000, 0)
			ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, org_id = EXCLUDED.org_id, role = 'client'`,
			opUser, string(opHash), oid, o.name+" Operator 1", opUser+"@exam.local",
		)

		// Create matching approved institution application for rich metadata
		var appId int64
		err = tx.QueryRowContext(ctx, `SELECT id FROM institution_applications WHERE LOWER(TRIM(institution_name)) = LOWER(TRIM($1))`, o.name).Scan(&appId)
		if err == sql.ErrNoRows {
			_, _ = tx.ExecContext(ctx, `
				INSERT INTO institution_applications(
					status, institution_name, institution_type, aishe_code, state, city,
					head_name, head_email, head_mobile, approx_student_count, address_line1, pin_code, head_designation, created_at, reviewed_at
				) VALUES('approved', $1, $2, $3, $4, $5, $6, $7, $8, 5000, 'Campus Road', '110001', 'Head', NOW() - INTERVAL '5 days', NOW() - INTERVAL '4 days')`,
				o.name, o.instType, o.aishe, o.state, o.city, o.headName, o.headEmail, o.headMob,
			)
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 4. SEED SUBSCRIPTIONS & CLIENT BLANKET APPROVALS
	// ─────────────────────────────────────────────────────────────────────────
	log.Println("Seeding exam subscription requests & blanket approvals...")

	// 4a. Manipal is blanket partner of NTA
	ntaID := clientIDs["National Testing Agency (NTA)"]
	manipalID := orgIDs["manipal_univ"]
	_, _ = tx.ExecContext(ctx, `
		INSERT INTO client_organization_approvals(client_id, org_id, approved_at, approved_by, note)
		VALUES($1, $2, NOW() - INTERVAL '2 days', 1, 'Premier Institutional Accreditation Partner')
		ON CONFLICT (client_id, org_id) DO NOTHING`,
		ntaID, manipalID,
	)

	// Subscriptions table:
	type subDef struct {
		orgCode      string
		examCode     string
		status       string // "pending", "approved", "rejected"
		approvalType string // "per_exam", "blanket_client", ""
		note         string
	}

	subs := []subDef{
		// St. Lawrence University (Pending 2 NTA exams)
		{"st_lawrance_2", "NEET-UG-2026", "pending", "", ""},
		{"st_lawrance_2", "JEE-MAIN-2026", "pending", "", ""},

		// DTU (Pending 2 NTA exams)
		{"dtu_delhi", "CUET-UG-2026", "pending", "", ""},
		{"dtu_delhi", "JEE-MAIN-2026", "pending", "", ""},

		// Amity (1 Pending NTA, 1 Approved Per-Exam NTA)
		{"amity_univ", "NEET-UG-2026", "pending", "", ""},
		{"amity_univ", "CUET-UG-2026", "approved", "per_exam", "Approved for campus verification venue"},

		// Manipal (Blanket Partner — 2 Approved NTA exams)
		{"manipal_univ", "CUET-UG-2026", "approved", "blanket_client", "Pre-approved via client partner status"},
		{"manipal_univ", "NEET-UG-2026", "approved", "blanket_client", "Pre-approved via client partner status"},

		// St. Xavier's (Pending NTA + Pending AIIMS)
		{"xaviers_mumbai", "NEET-UG-2026", "pending", "", ""},
		{"xaviers_mumbai", "INI-CET-2026", "pending", "", ""},

		// BIT Mesra (Pending NTA + Pending UPSC)
		{"bit_mesra", "JEE-MAIN-2026", "pending", "", ""},
		{"bit_mesra", "CSE-PRELIMS-2026", "pending", "", ""},

		// VIT (Pending 2 NTA exams)
		{"vit_vellore", "NEET-UG-2026", "pending", "", ""},
		{"vit_vellore", "JEE-MAIN-2026", "pending", "", ""},

		// Loyola (1 Pending NTA + 1 Pending CBSE)
		{"loyola_chennai", "CUET-UG-2026", "pending", "", ""},
		{"loyola_chennai", "CTET-2026", "pending", "", ""},
	}

	for _, s := range subs {
		oid := orgIDs[s.orgCode]
		eid := examIDs[s.examCode]
		if oid == 0 || eid == 0 {
			continue
		}

		var reviewedAt any = nil
		if s.status == "approved" || s.status == "rejected" {
			reviewedAt = time.Now().Add(-24 * time.Hour)
		}

		_, err := tx.ExecContext(ctx, `
			INSERT INTO organization_exam_subscriptions(
				org_id, exam_id, status, approval_type, requested_at, subscribed_at, subscribed_by, reviewed_at, review_note
			) VALUES($1, $2, $3, $4, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 1, $5, $6)
			ON CONFLICT (org_id, exam_id) DO UPDATE SET
				status = EXCLUDED.status,
				approval_type = EXCLUDED.approval_type,
				reviewed_at = EXCLUDED.reviewed_at,
				review_note = EXCLUDED.review_note`,
			oid, eid, s.status, s.approvalType, reviewedAt, s.note,
		)
		if err != nil {
			log.Fatalf("seed subscription %s -> %s: %v", s.orgCode, s.examCode, err)
		}
	}

	if err := tx.Commit(); err != nil {
		log.Fatalf("commit seed: %v", err)
	}

	fmt.Println("\n================================================================================")
	fmt.Println("  DATABASE SEEDED SUCCESSFULLY!")
	fmt.Println("================================================================================")
	fmt.Println("\n--- Superadmin ---")
	fmt.Println("  URL:      http://localhost:5173/superadmin/login")
	fmt.Println("  Username: super")
	fmt.Println("  Password: super123")

	fmt.Println("\n--- Client Reviewers (Use to test Reviewer Dashboard) ---")
	fmt.Println("  URL: http://localhost:5173/reviewer/login")
	for _, c := range clients {
		fmt.Printf("  • %-45s -> Username: %-15s Password: %s\n", c.name, c.reviewerUser, c.reviewerPass)
	}

	fmt.Println("\n--- University Admins (Use to test Catalog & Subscriptions) ---")
	fmt.Println("  URL: http://localhost:5173/admin/login")
	for _, o := range orgs {
		fmt.Printf("  • %-45s -> Username: %-18s Password: %s\n", o.name, o.adminUser, o.adminPass)
	}
	fmt.Println("================================================================================")
}
