package api

// Shared plumbing for the package's tests.
//
// Every test that needs a database calls testsupport.FreshDB, which hands
// back a migrated database of that test's own and drops it afterwards. The
// helpers here cover the two things that follow from running on Postgres
// rather than the SQLite file the tests were first written against:
// the template database has to be torn down once the package finishes,
// and inserts have to read their new row's id back with RETURNING, because
// Postgres has no LastInsertId.

import (
	"database/sql"
	"os"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"github.com/veni/neet-verification/internal/db"
	"github.com/veni/neet-verification/internal/testsupport"
)

func TestMain(m *testing.M) { os.Exit(testsupport.Main(m)) }

// seedClientOperator creates one organisation and one activated client
// operator inside it — the pair the roll-lookup and face-match fixtures
// authenticate as. db.Seed only creates the superadmin, so the operator has
// to be seeded here rather than taken from the seed data.
//
// The operator's password is returned as well, for the tests that sign in
// over /api/auth/login instead of using a pre-minted token.
func seedClientOperator(t *testing.T, d *sql.DB, orgCode, orgName, username string) (orgID, userID int64, password string) {
	t.Helper()
	password = "OperatorPass123"
	orgID = insertID(t, d,
		`INSERT INTO organizations(code, name) VALUES(?, ?) RETURNING id`,
		orgCode, orgName)
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash operator password: %v", err)
	}
	// A non-NULL spending_cap_paise means an allocation exists. A NULL
	// cap means "nothing allocated", and the money gate then refuses the
	// roll lookup outright (see operatorHasPurse) - not the state most
	// tests want to start from.
	userID = insertID(t, d,
		`INSERT INTO users(username, password_hash, password_plaintext, role,
		                   org_id, display_name, activated_at, spending_cap_paise)
		 VALUES(?, ?, ?, 'client', ?, 'Centre Operator', CURRENT_TIMESTAMP, 10000000)
		 RETURNING id`,
		username, string(hash), password, orgID)
	return orgID, userID, password
}

// seedLivenessPass records a passing active-liveness check so a face-match
// on the candidate-scoped route gets past the 412 gate. Real operators get
// this row from POST /candidates/{roll}/liveness-check; the face tests are
// about the matcher, not the blink challenge.
func seedLivenessPass(t *testing.T, d *sql.DB, orgID int64, roll, sessionID string) {
	t.Helper()
	if _, err := d.Exec(db.Q(
		`INSERT INTO liveness_checks(org_id, roll_no, session_id, passive_mean, expires_at)
		 VALUES(?, ?, ?, 0.9, NOW() + INTERVAL '10 minutes')`),
		orgID, roll, sessionID,
	); err != nil {
		t.Fatalf("seed liveness pass: %v", err)
	}
}

// insertID runs an insert ending in RETURNING id and hands back the new
// row's id, rewriting ? placeholders to $n on the way. It stops the test on
// failure: an insert that silently did nothing produces a confusing failure
// several assertions later.
func insertID(t *testing.T, d *sql.DB, query string, args ...any) int64 {
	t.Helper()
	var id int64
	if err := d.QueryRow(db.Q(query), args...).Scan(&id); err != nil {
		t.Fatalf("insert: %v\nquery: %s", err, strings.TrimSpace(query))
	}
	return id
}
