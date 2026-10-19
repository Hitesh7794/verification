// Package testsupport builds the database fixtures the backend's tests run
// against.
//
// Each test gets a database of its own: created from a migrated template,
// handed over migrated and empty, and dropped when the test finishes. Tests
// therefore never read or write the dev database, and no two tests can see
// each other's rows — which is what lets the concurrency tests (approval
// race, wallet debit) assert on exact balances and row counts.
//
// Only _test.go files import this package, so none of it is compiled into
// cmd/server or cmd/control-plane.
package testsupport

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/veni/neet-verification/internal/db"
)

// The local docker container from docker-compose. Point TEST_DATABASE_URL
// somewhere else when Postgres lives elsewhere; it has to name a database
// that already exists, because that is the connection the helpers create
// and drop the per-test databases from.
const defaultAdminDSN = "postgres://portal:portal-dev@127.0.0.1:5434/postgres?sslmode=disable"

// AdminDSN is the maintenance DSN tests connect to in order to create and
// drop their own databases.
func AdminDSN() string {
	if v := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); v != "" {
		return v
	}
	return defaultAdminDSN
}

var (
	tplOnce sync.Once
	tplName string
	tplErr  error
	seq     atomic.Int64
)

// FreshDB returns a migrated, empty database belonging to this test alone,
// and drops it when the test ends.
//
// A machine with no Postgres reachable skips the test rather than failing
// it, so `go test ./...` stays useful without the container running.
func FreshDB(t *testing.T) *sql.DB {
	t.Helper()

	tpl, err := ensureTemplate()
	if err != nil {
		t.Skipf("skipping: no test database at %s: %v", AdminDSN(), err)
	}

	admin, err := openAdmin()
	if err != nil {
		t.Skipf("skipping: no test database at %s: %v", AdminDSN(), err)
	}
	defer admin.Close()

	name := fmt.Sprintf("vptest_%d_%d", os.Getpid(), seq.Add(1))
	if _, err := admin.Exec(fmt.Sprintf(
		`CREATE DATABASE %s TEMPLATE %s`, quoteIdent(name), quoteIdent(tpl),
	)); err != nil {
		t.Fatalf("create test database %s: %v", name, err)
	}

	dsn, err := withDatabase(AdminDSN(), name)
	if err != nil {
		t.Fatalf("build dsn for %s: %v", name, err)
	}
	d, err := db.Open(dsn)
	if err != nil {
		dropDatabase(admin, name)
		t.Fatalf("open test database %s: %v", name, err)
	}

	t.Cleanup(func() {
		d.Close()
		a, err := openAdmin()
		if err != nil {
			return
		}
		defer a.Close()
		dropDatabase(a, name)
	})

	return d
}

// Main runs a package's tests and then drops the migrated template. Every
// package that calls FreshDB wires it up:
//
//	func TestMain(m *testing.M) { os.Exit(testsupport.Main(m)) }
func Main(m *testing.M) int {
	code := m.Run()
	if tplName != "" {
		if admin, err := openAdmin(); err == nil {
			dropDatabase(admin, tplName)
			admin.Close()
		}
	}
	return code
}

// ensureTemplate migrates one database per test process and leaves it idle
// to be copied. Migrating still costs what it always did, but once for the
// whole package instead of once per test: CREATE DATABASE ... TEMPLATE is a
// file copy.
func ensureTemplate() (string, error) {
	tplOnce.Do(func() {
		admin, err := openAdmin()
		if err != nil {
			tplErr = err
			return
		}
		defer admin.Close()

		name := fmt.Sprintf("vptest_tpl_%d", os.Getpid())
		if err := dropDatabase(admin, name); err != nil {
			tplErr = fmt.Errorf("clear stale template: %w", err)
			return
		}
		if _, err := admin.Exec(`CREATE DATABASE ` + quoteIdent(name)); err != nil {
			tplErr = fmt.Errorf("create template: %w", err)
			return
		}

		dsn, err := withDatabase(AdminDSN(), name)
		if err != nil {
			tplErr = err
			return
		}
		d, err := db.Open(dsn)
		if err != nil {
			tplErr = fmt.Errorf("open template: %w", err)
			return
		}
		if err := db.Migrate(d); err != nil {
			d.Close()
			tplErr = fmt.Errorf("migrate template: %w", err)
			return
		}
		// CREATE DATABASE ... TEMPLATE refuses to copy a database that
		// still has a client attached, so hand the template back idle.
		if err := d.Close(); err != nil {
			tplErr = fmt.Errorf("close template: %w", err)
			return
		}
		tplName = name
	})
	return tplName, tplErr
}

func openAdmin() (*sql.DB, error) { return db.Open(AdminDSN()) }

// withDatabase rewrites a DSN to name a different database on the same
// server, keeping credentials and query parameters as they were.
func withDatabase(dsn, name string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", fmt.Errorf("parse dsn: %w", err)
	}
	u.Path = "/" + name
	return u.String(), nil
}

// dropDatabase removes a database if it is there, disconnecting anything
// still attached: Postgres refuses a plain DROP while a connection is open,
// and a test that failed half way through may well have left one.
func dropDatabase(admin *sql.DB, name string) error {
	_, err := admin.Exec(`DROP DATABASE IF EXISTS ` + quoteIdent(name) + ` WITH (FORCE)`)
	if err == nil {
		return nil
	}
	// WITH (FORCE) needs Postgres 13; evict by hand on anything older.
	admin.Exec(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, name)
	_, err = admin.Exec(`DROP DATABASE IF EXISTS ` + quoteIdent(name))
	return err
}

// quoteIdent double-quotes a generated database name. The names are built
// from a pid and a counter, but a database name cannot be a bind parameter,
// so quote it rather than interpolate it bare.
func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}
