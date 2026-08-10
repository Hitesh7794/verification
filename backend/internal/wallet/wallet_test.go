package wallet

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/veni/neet-verification/internal/db"
)

// freshDB returns a temporary file-backed SQLite database with all
// migrations applied + a test org and operator user seeded. We use the
// production db.Open helper rather than a bare sql.Open so the test
// sees the same WAL / busy_timeout pragmas the real backend runs with
// — that's what lets the concurrent-debit test pass under high
// contention without spurious SQLITE_BUSY errors.
//
// Returns (db, orgID, operatorUserID). Operator is the "actor" for
// charge rows; tests that need a separate admin actor can pass 0.
func freshDB(t *testing.T) (*sql.DB, int64, int64) {
	t.Helper()
	dir := t.TempDir()
	dsn := filepath.Join(dir, "wallet-test.db")
	d, err := db.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	orgRes, err := d.Exec(
		`INSERT INTO organizations(code, name) VALUES(?,?)`,
		"TESTORG", "Test University",
	)
	if err != nil {
		t.Fatalf("seed org: %v", err)
	}
	orgID, _ := orgRes.LastInsertId()
	userRes, err := d.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name) VALUES(?,?,?,?,?)`,
		"client-test", "ignored", "client", orgID, "Test Operator",
	)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	uid, _ := userRes.LastInsertId()
	return d, orgID, uid
}

func TestBalance_DefaultZero(t *testing.T) {
	d, orgID, _ := freshDB(t)
	s := New(d)
	bal, err := s.Balance(context.Background(), orgID)
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if bal != 0 {
		t.Errorf("want 0, got %d", bal)
	}
}

func TestCreditThenDebit(t *testing.T) {
	d, orgID, uid := freshDB(t)
	s := New(d)
	ctx := context.Background()

	tx, err := s.Credit(ctx, orgID, uid, 50000 /* ₹500 */, KindDeposit, "ord_xyz", "pay_abc", "test deposit")
	if err != nil {
		t.Fatalf("credit: %v", err)
	}
	if tx.BalanceAfterPaise != 50000 {
		t.Errorf("after credit, balance want 50000, got %d", tx.BalanceAfterPaise)
	}

	tx, err = s.Debit(ctx, orgID, uid, 500 /* ₹5 charge */, "10001", "candidate-lookup")
	if err != nil {
		t.Fatalf("debit: %v", err)
	}
	if tx.BalanceAfterPaise != 49500 {
		t.Errorf("after debit, balance want 49500, got %d", tx.BalanceAfterPaise)
	}
	if tx.AmountPaise != -500 {
		t.Errorf("debit amount should be -500 (signed), got %d", tx.AmountPaise)
	}
	if tx.ActorUserID == nil || *tx.ActorUserID != uid {
		t.Errorf("debit actor_user_id should be %d, got %v", uid, tx.ActorUserID)
	}
}

func TestDebit_InsufficientBalance(t *testing.T) {
	d, orgID, uid := freshDB(t)
	s := New(d)
	ctx := context.Background()

	if _, err := s.Credit(ctx, orgID, uid, 1000, KindDeposit, "", "pay_1", "small"); err != nil {
		t.Fatalf("credit: %v", err)
	}

	_, err := s.Debit(ctx, orgID, uid, 2000, "10001", "overspend")
	if !errors.Is(err, ErrInsufficient) {
		t.Errorf("want ErrInsufficient, got %v", err)
	}

	// Balance must not have moved.
	bal, _ := s.Balance(ctx, orgID)
	if bal != 1000 {
		t.Errorf("balance after failed debit should be 1000, got %d", bal)
	}

	// No charge row should have been written either.
	hist, _ := s.History(ctx, orgID, 10, 0)
	for _, t2 := range hist {
		if t2.Kind == KindCharge {
			t.Errorf("a failed debit must not write a charge row, got %+v", t2)
		}
	}
}

func TestDebit_AtomicUnderConcurrency(t *testing.T) {
	d, orgID, uid := freshDB(t)
	s := New(d)
	ctx := context.Background()

	// Credit exactly enough for 10 debits.
	if _, err := s.Credit(ctx, orgID, uid, 10*500, KindDeposit, "", "pay_atomic", ""); err != nil {
		t.Fatalf("credit: %v", err)
	}

	// Fire 50 concurrent debit attempts — only 10 must succeed.
	const attempts = 50
	var wg sync.WaitGroup
	var success, fail int
	var mu sync.Mutex
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Debit(ctx, orgID, uid, 500, "", "concurrency-test")
			mu.Lock()
			if err == nil {
				success++
			} else if errors.Is(err, ErrInsufficient) {
				fail++
			} else {
				t.Errorf("unexpected error: %v", err)
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	if success != 10 {
		t.Errorf("want exactly 10 successful debits, got %d (fail=%d)", success, fail)
	}
	bal, _ := s.Balance(ctx, orgID)
	if bal != 0 {
		t.Errorf("balance should be 0 after exactly 10 debits, got %d", bal)
	}
}

func TestHasRecentChargeForRoll(t *testing.T) {
	d, orgID, uid := freshDB(t)
	s := New(d)
	ctx := context.Background()
	_, _ = s.Credit(ctx, orgID, uid, 5000, KindDeposit, "", "pay_r", "")

	// No charge yet for roll 10001.
	hit, err := s.HasRecentChargeForRoll(ctx, orgID, "10001", 5)
	if err != nil || hit {
		t.Errorf("want false, got %v / %v", hit, err)
	}

	// After a charge it should hit.
	if _, err := s.Debit(ctx, orgID, uid, 500, "10001", ""); err != nil {
		t.Fatalf("debit: %v", err)
	}
	hit, err = s.HasRecentChargeForRoll(ctx, orgID, "10001", 5)
	if err != nil || !hit {
		t.Errorf("want true after charge, got %v / %v", hit, err)
	}

	// A different roll should not hit.
	hit, _ = s.HasRecentChargeForRoll(ctx, orgID, "10002", 5)
	if hit {
		t.Error("different roll should not register a hit")
	}

	// Empty roll / 0 window are always false (cache disabled).
	hit, _ = s.HasRecentChargeForRoll(ctx, orgID, "", 5)
	if hit {
		t.Error("empty roll should not hit")
	}
	hit, _ = s.HasRecentChargeForRoll(ctx, orgID, "10001", 0)
	if hit {
		t.Error("zero window should disable the cache")
	}
}

func TestCredit_IdempotentPaymentID(t *testing.T) {
	d, orgID, uid := freshDB(t)
	s := New(d)
	ctx := context.Background()

	if _, err := s.Credit(ctx, orgID, uid, 1000, KindDeposit, "ord_1", "pay_dup", ""); err != nil {
		t.Fatalf("first credit: %v", err)
	}
	// Replay with same payment_id should fail (unique constraint).
	_, err := s.Credit(ctx, orgID, uid, 1000, KindDeposit, "ord_1", "pay_dup", "")
	if err == nil {
		t.Error("duplicate razorpay_payment_id should be rejected by the unique index")
	}
	// Balance should be the single credit only.
	bal, _ := s.Balance(ctx, orgID)
	if bal != 1000 {
		t.Errorf("balance want 1000 after dedup, got %d", bal)
	}
}

// Cross-operator dedup: two different operators in the same org looking
// up the same roll within the cache window should only result in one
// charge. This is the headline benefit of moving wallets org-level.
func TestHasRecentChargeForRoll_CrossOperator(t *testing.T) {
	d, orgID, op1 := freshDB(t)
	s := New(d)
	ctx := context.Background()

	// Seed a second operator in the same org.
	res, err := d.Exec(
		`INSERT INTO users(username, password_hash, role, org_id, display_name) VALUES(?,?,?,?,?)`,
		"client-test-2", "ignored", "client", orgID, "Test Operator 2",
	)
	if err != nil {
		t.Fatalf("seed second user: %v", err)
	}
	op2, _ := res.LastInsertId()

	_, _ = s.Credit(ctx, orgID, op1, 5000, KindDeposit, "", "pay_x", "")
	if _, err := s.Debit(ctx, orgID, op1, 500, "10001", ""); err != nil {
		t.Fatalf("op1 debit: %v", err)
	}
	// op2 looking up the same roll — cache should report a hit.
	hit, _ := s.HasRecentChargeForRoll(ctx, orgID, "10001", 5)
	if !hit {
		t.Error("cache should hit across operators in the same org")
	}
	_ = op2 // satisfy linter; the cache check above is the assertion
}
