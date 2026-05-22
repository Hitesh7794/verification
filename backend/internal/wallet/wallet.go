// Package wallet implements the per-client wallet — balance, atomic
// debit/credit, transaction history. All money is stored as int paise
// to avoid floating-point money bugs.
//
// Concurrency: each user's balance is updated via
//
//	UPDATE wallets SET balance_paise = balance_paise - ? WHERE user_id = ? AND balance_paise >= ?
//
// so two simultaneous charges can't oversell. The transaction-history
// insert + balance update happen in a single SQL transaction, which is
// rolled back on any error including the balance-check failure.
//
// Wallet rows are created lazily — the first time someone tries to
// read/charge/credit a user's wallet, an upsert ensures a 0-balance row
// exists. This means the db.Seed step doesn't need to know which users
// are clients; the wallet appears on first interaction.
package wallet

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Errors. Handlers map these to specific HTTP status codes — see
// wallet_handlers.go.
var (
	// ErrInsufficient is returned by Debit when the user's balance is
	// below the requested amount. HTTP handler maps this to 402.
	ErrInsufficient = errors.New("wallet: insufficient balance")

	// ErrInvalidAmount: amount must be positive. We accept signed values
	// internally (to make the ledger easy) but callers shouldn't pass
	// negative or zero amounts.
	ErrInvalidAmount = errors.New("wallet: amount must be > 0")
)

// Kind enumerates the transaction types. The DB CHECK constraint enforces
// these literal strings.
type Kind string

const (
	KindDeposit      Kind = "deposit"       // Razorpay-funded top-up
	KindCharge       Kind = "charge"        // candidate-lookup fee
	KindAdminCredit  Kind = "admin_credit"  // admin manual top-up of another user
	KindRefund       Kind = "refund"        // future use; not exposed yet
)

// Transaction is one row of the audit ledger.
type Transaction struct {
	ID                int64
	UserID            int64
	Kind              Kind
	AmountPaise       int   // signed: + for credits, - for charges
	BalanceAfterPaise int
	RelatedRoll       string // empty when not applicable
	RazorpayOrderID   string // empty when not applicable
	RazorpayPaymentID string // empty when not applicable
	Description       string
	CreatedAt         time.Time
}

// Store wraps a *sql.DB and exposes the wallet operations. Concurrency-
// safe; share one Store across goroutines.
type Store struct {
	db *sql.DB
}

func New(db *sql.DB) *Store { return &Store{db: db} }

// Balance returns the user's current balance in paise, creating the
// wallet row on first use.
func (s *Store) Balance(ctx context.Context, userID int64) (int, error) {
	if err := s.ensureWallet(ctx, userID); err != nil {
		return 0, err
	}
	var bal int
	err := s.db.QueryRowContext(ctx,
		`SELECT balance_paise FROM wallets WHERE user_id = ?`, userID).Scan(&bal)
	if err != nil {
		return 0, err
	}
	return bal, nil
}

// History returns the most recent N transactions for a user, newest
// first. limit is clamped to [1, 200].
func (s *Store) History(ctx context.Context, userID int64, limit int) ([]Transaction, error) {
	if limit < 1 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, kind, amount_paise, balance_after_paise,
		        COALESCE(related_roll,''), COALESCE(razorpay_order_id,''),
		        COALESCE(razorpay_payment_id,''), COALESCE(description,''),
		        created_at
		 FROM wallet_transactions
		 WHERE user_id = ?
		 ORDER BY id DESC
		 LIMIT ?`,
		userID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Transaction
	for rows.Next() {
		var t Transaction
		var k string
		if err := rows.Scan(
			&t.ID, &t.UserID, &k, &t.AmountPaise, &t.BalanceAfterPaise,
			&t.RelatedRoll, &t.RazorpayOrderID, &t.RazorpayPaymentID,
			&t.Description, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		t.Kind = Kind(k)
		out = append(out, t)
	}
	return out, rows.Err()
}

// HasRecentChargeForRoll returns true if user has already paid for this
// specific roll within the last `windowMinutes` minutes. Used by the
// candidate-lookup middleware to implement the "5-min same-roll cache" —
// avoids double-charging when an operator refreshes a page or briefly
// switches tabs.
func (s *Store) HasRecentChargeForRoll(ctx context.Context, userID int64, roll string, windowMinutes int) (bool, error) {
	if roll == "" || windowMinutes <= 0 {
		return false, nil
	}
	cutoff := time.Now().UTC().Add(-time.Duration(windowMinutes) * time.Minute)
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM wallet_transactions
		 WHERE user_id = ? AND related_roll = ? AND kind = 'charge'
		   AND created_at >= ?`,
		userID, roll, cutoff,
	).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Debit subtracts `amountPaise` from user's balance and records a
// 'charge' transaction. The whole thing is one DB transaction so we
// can't get a debit without a ledger entry (or vice versa). Returns
// ErrInsufficient if the balance would go below 0; in that case
// nothing is written.
func (s *Store) Debit(ctx context.Context, userID int64, amountPaise int, relatedRoll, description string) (Transaction, error) {
	if amountPaise <= 0 {
		return Transaction{}, ErrInvalidAmount
	}
	if err := s.ensureWallet(ctx, userID); err != nil {
		return Transaction{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Transaction{}, err
	}
	defer tx.Rollback()

	// Atomic balance check + debit. The `balance_paise >= ?` clause is
	// what makes this safe under concurrent debits: two transactions
	// can't both succeed when the remaining balance is below the sum
	// of their amounts.
	res, err := tx.ExecContext(ctx,
		`UPDATE wallets
		 SET balance_paise = balance_paise - ?,
		     updated_at    = CURRENT_TIMESTAMP
		 WHERE user_id = ? AND balance_paise >= ?`,
		amountPaise, userID, amountPaise,
	)
	if err != nil {
		return Transaction{}, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return Transaction{}, err
	}
	if affected == 0 {
		return Transaction{}, ErrInsufficient
	}

	// Read the post-debit balance so we can stamp it on the ledger row.
	var newBal int
	if err := tx.QueryRowContext(ctx,
		`SELECT balance_paise FROM wallets WHERE user_id = ?`, userID,
	).Scan(&newBal); err != nil {
		return Transaction{}, err
	}

	res, err = tx.ExecContext(ctx,
		`INSERT INTO wallet_transactions(
			user_id, kind, amount_paise, balance_after_paise,
			related_roll, description
		) VALUES (?, 'charge', ?, ?, ?, ?)`,
		userID, -amountPaise, newBal, nullable(relatedRoll), nullable(description),
	)
	if err != nil {
		return Transaction{}, err
	}
	id, _ := res.LastInsertId()
	if err := tx.Commit(); err != nil {
		return Transaction{}, err
	}
	return Transaction{
		ID:                id,
		UserID:            userID,
		Kind:              KindCharge,
		AmountPaise:       -amountPaise,
		BalanceAfterPaise: newBal,
		RelatedRoll:       relatedRoll,
		Description:       description,
		CreatedAt:         time.Now(),
	}, nil
}

// Credit adds `amountPaise` to user's balance and records a transaction
// with the given kind. Used for Razorpay-funded deposits and admin
// manual top-ups. For Razorpay deposits, pass the order_id + payment_id;
// the unique index on razorpay_payment_id makes the call idempotent
// (network retries from the browser are safe — they fail with a unique-
// violation that the caller can map to "already credited, here's the
// existing row").
func (s *Store) Credit(ctx context.Context, userID int64, amountPaise int, kind Kind, razorpayOrderID, razorpayPaymentID, description string) (Transaction, error) {
	if amountPaise <= 0 {
		return Transaction{}, ErrInvalidAmount
	}
	if kind != KindDeposit && kind != KindAdminCredit && kind != KindRefund {
		return Transaction{}, fmt.Errorf("wallet: invalid credit kind %q", kind)
	}
	if err := s.ensureWallet(ctx, userID); err != nil {
		return Transaction{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Transaction{}, err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`UPDATE wallets
		 SET balance_paise = balance_paise + ?,
		     updated_at    = CURRENT_TIMESTAMP
		 WHERE user_id = ?`,
		amountPaise, userID,
	); err != nil {
		return Transaction{}, err
	}
	var newBal int
	if err := tx.QueryRowContext(ctx,
		`SELECT balance_paise FROM wallets WHERE user_id = ?`, userID,
	).Scan(&newBal); err != nil {
		return Transaction{}, err
	}
	res, err := tx.ExecContext(ctx,
		`INSERT INTO wallet_transactions(
			user_id, kind, amount_paise, balance_after_paise,
			razorpay_order_id, razorpay_payment_id, description
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		userID, string(kind), amountPaise, newBal,
		nullable(razorpayOrderID), nullable(razorpayPaymentID), nullable(description),
	)
	if err != nil {
		return Transaction{}, err
	}
	id, _ := res.LastInsertId()
	if err := tx.Commit(); err != nil {
		return Transaction{}, err
	}
	return Transaction{
		ID:                id,
		UserID:            userID,
		Kind:              kind,
		AmountPaise:       amountPaise,
		BalanceAfterPaise: newBal,
		RazorpayOrderID:   razorpayOrderID,
		RazorpayPaymentID: razorpayPaymentID,
		Description:       description,
		CreatedAt:         time.Now(),
	}, nil
}

// FindByRazorpayPaymentID returns an existing transaction for the given
// Razorpay payment_id, or nil if none exists. The verify-payment handler
// uses this to detect retries.
func (s *Store) FindByRazorpayPaymentID(ctx context.Context, paymentID string) (*Transaction, error) {
	if paymentID == "" {
		return nil, nil
	}
	var t Transaction
	var k string
	err := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, kind, amount_paise, balance_after_paise,
		        COALESCE(related_roll,''), COALESCE(razorpay_order_id,''),
		        COALESCE(razorpay_payment_id,''), COALESCE(description,''),
		        created_at
		 FROM wallet_transactions
		 WHERE razorpay_payment_id = ?`,
		paymentID,
	).Scan(
		&t.ID, &t.UserID, &k, &t.AmountPaise, &t.BalanceAfterPaise,
		&t.RelatedRoll, &t.RazorpayOrderID, &t.RazorpayPaymentID,
		&t.Description, &t.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t.Kind = Kind(k)
	return &t, nil
}

// ensureWallet creates a 0-balance row for `userID` if one doesn't exist
// yet. Safe to call repeatedly — the INSERT OR IGNORE is idempotent.
func (s *Store) ensureWallet(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO wallets(user_id, balance_paise) VALUES (?, 0)`,
		userID,
	)
	return err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
