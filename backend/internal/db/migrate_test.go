package db

import (
	"path/filepath"
	"testing"
)

// TestMigrateFresh applies the full migration set to a brand new database
// and verifies the schema_migrations table records every step.
func TestMigrateFresh(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "v.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer d.Close()

	if err := Migrate(d); err != nil {
		t.Fatalf("migrate fresh: %v", err)
	}

	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != len(migrations) {
		t.Fatalf("recorded %d migrations, expected %d", n, len(migrations))
	}
}

// TestMigrateIdempotent ensures re-running migrate on an already-migrated
// database is a no-op (no duplicate ALTERs, no error).
func TestMigrateIdempotent(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "v.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer d.Close()

	if err := Migrate(d); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	if err := Migrate(d); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if err := Migrate(d); err != nil {
		t.Fatalf("third migrate: %v", err)
	}

	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != len(migrations) {
		t.Fatalf("recorded %d migrations after re-runs, expected %d", n, len(migrations))
	}
}

// TestBiometricColumnsExist sanity-checks that the columns added in
// migration 2 are actually addressable. Catches a typo'd ALTER TABLE.
func TestBiometricColumnsExist(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "v.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer d.Close()
	if err := Migrate(d); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	cols := []string{
		"device_serial", "device_model", "fp_template_format",
		"fp_quality", "fp_nfiq", "fp_match_score", "fp_liveness",
		"iris_left_score", "iris_right_score",
		"iris_left_quality", "iris_right_quality",
		"face_match_score", "via", "match_threshold",
		"decision_ms", "client_app_version", "idempotency_key",
	}
	for _, c := range cols {
		var v any
		err := d.QueryRow(`SELECT ` + c + ` FROM verifications LIMIT 1`).Scan(&v)
		// ErrNoRows is fine — table is empty. Anything else is a missing column.
		if err != nil && err.Error() != "sql: no rows in result set" {
			t.Errorf("column %q: %v", c, err)
		}
	}
}

// TestIdempotencyKeyUnique verifies the unique partial index actually
// prevents duplicate keys but allows multiple NULLs (legacy rows / clients
// that don't supply a key).
func TestIdempotencyKeyUnique(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "v.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer d.Close()
	if err := Migrate(d); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Seed minimal rows so the FK paths exist (we only need the verifications
	// table itself; the FKs are advisory for sqlite without ON conflict).
	// The centers table + verifications.center_id column were removed by
	// migration 021.
	_, _ = d.Exec(`INSERT INTO organizations(code,name) VALUES('X','x')`)
	_, _ = d.Exec(`INSERT INTO users(username,password_hash,role,display_name)
		VALUES('u','x','client','u')`)

	ins := `INSERT INTO verifications(roll_no,org_id,operator_id,status,idempotency_key)
	        VALUES('1',1,1,'verified',?)`

	if _, err := d.Exec(ins, "abc"); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if _, err := d.Exec(ins, "abc"); err == nil {
		t.Fatalf("duplicate idempotency_key should have failed")
	}
	// NULLs must be allowed multiple times.
	if _, err := d.Exec(ins, nil); err != nil {
		t.Fatalf("nil key 1: %v", err)
	}
	if _, err := d.Exec(ins, nil); err != nil {
		t.Fatalf("nil key 2: %v", err)
	}
}
