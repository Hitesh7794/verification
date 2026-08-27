// db-reset — completely wipe all local development database data and reset sequences.
//
// Usage:
//   cd backend && go run ./cmd/db-reset
package main

import (
	"context"
	"log"
	"os"
	"path/filepath"

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

	log.Printf("Connecting to database at %s ...", dsn)
	d, err := db.Open(dsn)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer d.Close()

	if err := db.Migrate(d); err != nil {
		log.Fatalf("failed to run migrations: %v", err)
	}

	ctx := context.Background()

	log.Println("Wiping all database tables and resetting identity counters...")
	truncateSQL := `
		TRUNCATE TABLE 
			verifications,
			audit_log,
			magic_links,
			operator_exams,
			exam_candidates,
			exam_centres,
			exam_csv_uploads,
			organization_exam_subscriptions,
			client_organization_approvals,
			institution_application_documents,
			institution_applications,
			exams,
			clients,
			wallet_transactions,
			razorpay_orders,
			wallets,
			users,
			organizations
		RESTART IDENTITY CASCADE;
	`
	if _, err := d.ExecContext(ctx, truncateSQL); err != nil {
		log.Fatalf("failed to truncate tables: %v", err)
	}

	log.Println("Creating default Superadmin user (username: super, password: super123)...")
	superHash, err := bcrypt.GenerateFromPassword([]byte("super123"), bcrypt.DefaultCost)
	if err != nil {
		log.Fatalf("failed to hash password: %v", err)
	}

	if _, err := d.ExecContext(ctx, `
		INSERT INTO users(username, password_hash, role, display_name, activated_at)
		VALUES('super', $1, 'superadmin', 'System Superadmin', NOW())
	`, string(superHash)); err != nil {
		log.Fatalf("failed to create superadmin: %v", err)
	}

	// Clean up local uploaded files if data dir exists
	dataDir := cfg.DataDir
	if dataDir == "" {
		dataDir = "./data"
	}
	subDirs := []string{"candidates", "uploads", "kyc_docs", "artifacts"}
	for _, sub := range subDirs {
		p := filepath.Join(dataDir, sub)
		if err := os.RemoveAll(p); err == nil {
			_ = os.MkdirAll(p, 0755)
		}
	}

	log.Println("Database successfully wiped and reset to clean slate!")
	log.Println("You can now log in as superadmin with super / super123.")
}
