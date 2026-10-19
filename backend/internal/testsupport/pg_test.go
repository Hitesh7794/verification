package testsupport

import (
	"os"
	"testing"
)

func TestMain(m *testing.M) { os.Exit(Main(m)) }

// Two databases, each its own: a row written in one must not be visible in
// the other, and the schema must already be there.
func TestFreshDB_IsolatedAndMigrated(t *testing.T) {
	a := FreshDB(t)
	b := FreshDB(t)

	if _, err := a.Exec(`INSERT INTO organizations(code, name) VALUES($1,$2)`, "ISO1", "Only In A"); err != nil {
		t.Fatalf("insert into a: %v", err)
	}

	var inA, inB int
	if err := a.QueryRow(`SELECT count(*) FROM organizations WHERE code='ISO1'`).Scan(&inA); err != nil {
		t.Fatalf("count in a: %v", err)
	}
	if err := b.QueryRow(`SELECT count(*) FROM organizations WHERE code='ISO1'`).Scan(&inB); err != nil {
		t.Fatalf("count in b: %v", err)
	}
	if inA != 1 {
		t.Errorf("own database: want 1 row, got %d", inA)
	}
	if inB != 0 {
		t.Errorf("other database: want 0 rows, got %d", inB)
	}
}
