// Package wallet implements the per-organisation wallet — balance, atomic
// debit/credit, transaction history. All money is stored as int paise to
// avoid floating-point money bugs.
//
// One wallet per organisation. Operators (client role) trigger charges
// against their org's wallet when they look up candidates; the admin
// owns the balance, deposits funds via Razorpay, and sees the full
// transaction history with operator attribution. Superadmin can view +
// credit any org's wallet for support cases.
//
// Concurrency: each org's balance is updated via
//
//	UPDATE wallets SET balance_paise = balance_paise - ? WHERE org_id = ? AND balance_paise >= ?
//
// so two simultaneous charges can't oversell. The transaction-history
// insert + balance update happen in a single SQL transaction, which is
// rolled back on any error including the balance-check failure.
//
// Wallet rows are created lazily — the first time someone tries to
// read/charge/credit an org's wallet, an upsert ensures a 0-balance row
// exists. This means newly-approved institutions get a wallet on first
// interaction without any separate provisioning step.
package wallet

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
	"github.com/veni/neet-verification/internal/db"
)

// Errors. Handlers map these to specific HTTP status codes — see
// wallet_handlers.go.
var (
	// ErrInsufficient is returned by Debit when the org's balance is
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
	KindDeposit     Kind = "deposit"      // Razorpay-funded top-up
	KindCharge      Kind = "charge"       // candidate-lookup fee
	KindAdminCredit Kind = "admin_credit" // superadmin manual top-up
	KindRefund      Kind = "refund"       // future use; not exposed yet
)

// Transaction is one row of the audit ledger.
type Transaction struct {
	ID                int64
	OrgID             int64
	ActorUserID       *int64 // operator who triggered a charge, or admin who deposited; nullable
	ActorUsername     string // joined from users; empty if actor_user_id is NULL
	ActorDisplayName  string // joined from users; empty if actor_user_id is NULL
	Kind              Kind
	AmountPaise       int    // signed: + for credits, - for charges
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

// Balance returns the org's current balance in paise, creating the
// wallet row on first use.
func (s *Store) Balance(ctx context.Context, orgID int64) (int, error) {
	if err := s.ensureWallet(ctx, orgID); err != nil {
		return 0, err
	}
	var bal int
	err := s.db.QueryRowContext(ctx,
		`SELECT balance_paise FROM wallets WHERE org_id = $1`, orgID).Scan(&bal)
	if err != nil {
		return 0, err
	}
	return bal, nil
}

// History returns the most recent N transactions for an org, newest
// first, joined with users so the admin UI can render the operator
// attribution without N+1 queries. limit is clamped to [1, 200].
//
// beforeID enables cursor pagination: pass 0 to get the newest page,
// or the smallest `id` from the previous page to fetch the next
// (older) page. Cursor-by-id is stable under concurrent inserts —
// new transactions land with higher IDs and never disturb the
// older pages the admin is scrolling through.
func (s *Store) History(ctx context.Context, orgID int64, limit int, beforeID int64) ([]Transaction, error) {
	if limit < 1 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	// SQL uses `?` throughout and gets rebound to $N by db.Q. Cursor +
	// limit are appended in order so their slot numbers stay correct
	// under both `orgID+limit` and `orgID+beforeID+limit` shapes.
	q := `SELECT t.id, t.org_id, t.actor_user_id,
	             COALESCE(u.username,''), COALESCE(u.display_name,''),
	             t.kind, t.amount_paise, t.balance_after_paise,
	             COALESCE(t.related_roll,''), COALESCE(t.razorpay_order_id,''),
	             COALESCE(t.razorpay_payment_id,''), COALESCE(t.description,''),
	             t.created_at
	      FROM wallet_transactions t
	      LEFT JOIN users u ON u.id = t.actor_user_id
	      WHERE t.org_id = ?`
	args := []any{orgID}
	if beforeID > 0 {
		q += ` AND t.id < ?`
		args = append(args, beforeID)
	}
	q += ` ORDER BY t.id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, db.Q(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Transaction
	for rows.Next() {
		var t Transaction
		var k string
		var actorID sql.NullInt64
		if err := rows.Scan(
			&t.ID, &t.OrgID, &actorID,
			&t.ActorUsername, &t.ActorDisplayName,
			&k, &t.AmountPaise, &t.BalanceAfterPaise,
			&t.RelatedRoll, &t.RazorpayOrderID, &t.RazorpayPaymentID,
			&t.Description, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		if actorID.Valid {
			id := actorID.Int64
			t.ActorUserID = &id
		}
		t.Kind = Kind(k)
		out = append(out, t)
	}
	return out, rows.Err()
}

// HasRecentChargeForRoll returns true if the org has already paid for
// this specific roll within the last `windowMinutes` minutes. Used by
// the candidate-lookup middleware to implement the same-roll cache —
// avoids double-charging when any operator in the org refreshes a page
// or two operators happen to look up the same candidate close together.
func (s *Store) HasRecentChargeForRoll(ctx context.Context, orgID int64, roll string, windowMinutes int) (bool, error) {
	if roll == "" || windowMinutes <= 0 {
		return false, nil
	}
	cutoff := time.Now().UTC().Add(-time.Duration(windowMinutes) * time.Minute)
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM wallet_transactions
		 WHERE org_id = $1 AND related_roll = $2 AND kind = 'charge'
		   AND created_at >= $3`,
		orgID, roll, cutoff,
	).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Debit subtracts `amountPaise` from the org's balance and records a
// 'charge' transaction attributed to `actorUserID` (the operator who
// triggered the lookup). The whole thing is one DB transaction so we
// can't get a debit without a ledger entry (or vice versa). Returns
// ErrInsufficient if the balance would go below 0; in that case
// nothing is written.
func (s *Store) Debit(ctx context.Context, orgID, actorUserID int64, amountPaise int, relatedRoll, description string) (Transaction, error) {
	if amountPaise <= 0 {
		return Transaction{}, ErrInvalidAmount
	}
	if err := s.ensureWallet(ctx, orgID); err != nil {
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
		db.Q(`UPDATE wallets
		 SET balance_paise = balance_paise - $1,
		     updated_at    = CURRENT_TIMESTAMP
		 WHERE org_id = $2 AND balance_paise >= $3`),
		amountPaise, orgID, amountPaise,
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
		db.Q(`SELECT balance_paise FROM wallets WHERE org_id = $1`), orgID,
	).Scan(&newBal); err != nil {
		return Transaction{}, err
	}

	var id int64
	if err := tx.QueryRowContext(ctx,
		db.Q(`INSERT INTO wallet_transactions(
			org_id, actor_user_id, kind, amount_paise, balance_after_paise,
			related_roll, description
		) VALUES ($1, $2, 'charge', $3, $4, $5, $6)
		RETURNING id`),
		orgID, actorUserID, -amountPaise, newBal,
		nullable(relatedRoll), nullable(description),
	).Scan(&id); err != nil {
		return Transaction{}, err
	}

	// Fold the actor's personal spent_paise counter into the SAME tx as
	// the org wallet debit + ledger row. Previously this UPDATE lived
	// outside the tx and logged-and-continued on failure — a DB blip
	// mid-request left the wallet charged but the operator's spent
	// counter unmoved, so `spent + fee > cap` never tripped and their
	// cap could be silently bypassed indefinitely. Atomic tx means
	// either both happen or neither, so the cap check at pre-charge
	// time is now always reading a truthful running total.
	//
	// actorUserID = 0 is a valid "system-initiated debit with no
	// personal actor" — skip the bump in that case. UPDATE ... WHERE id
	// = ? affecting 0 rows (deleted user) is a no-op, not an error,
	// which is intentional.
	if actorUserID != 0 {
		if _, err := tx.ExecContext(ctx,
			db.Q(`UPDATE users SET spent_paise = spent_paise + $1 WHERE id = $2`),
			amountPaise, actorUserID,
		); err != nil {
			return Transaction{}, fmt.Errorf("bump spent_paise: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return Transaction{}, err
	}
	actor := actorUserID
	return Transaction{
		ID:                id,
		OrgID:             orgID,
		ActorUserID:       &actor,
		Kind:              KindCharge,
		AmountPaise:       -amountPaise,
		BalanceAfterPaise: newBal,
		RelatedRoll:       relatedRoll,
		Description:       description,
		CreatedAt:         time.Now(),
	}, nil
}

// Credit adds `amountPaise` to the org's balance and records a
// transaction with the given kind. Used for Razorpay-funded deposits
// (actorUserID = the admin who initiated the deposit) and superadmin
// manual top-ups (actorUserID = the superadmin). For Razorpay deposits,
// pass the order_id + payment_id; the unique index on razorpay_payment_id
// makes the call idempotent (network retries from the browser are safe
// — they fail with a unique-violation that the caller can map to
// "already credited, here's the existing row").
func (s *Store) Credit(ctx context.Context, orgID, actorUserID int64, amountPaise int, kind Kind, razorpayOrderID, razorpayPaymentID, description string) (Transaction, error) {
	if amountPaise <= 0 {
		return Transaction{}, ErrInvalidAmount
	}
	if kind != KindDeposit && kind != KindAdminCredit && kind != KindRefund {
		return Transaction{}, fmt.Errorf("wallet: invalid credit kind %q", kind)
	}
	if err := s.ensureWallet(ctx, orgID); err != nil {
		return Transaction{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Transaction{}, err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		db.Q(`UPDATE wallets
		 SET balance_paise = balance_paise + $1,
		     updated_at    = CURRENT_TIMESTAMP
		 WHERE org_id = $2`),
		amountPaise, orgID,
	); err != nil {
		return Transaction{}, err
	}
	var newBal int
	if err := tx.QueryRowContext(ctx,
		db.Q(`SELECT balance_paise FROM wallets WHERE org_id = $1`), orgID,
	).Scan(&newBal); err != nil {
		return Transaction{}, err
	}
	var id int64
	if err := tx.QueryRowContext(ctx,
		db.Q(`INSERT INTO wallet_transactions(
			org_id, actor_user_id, kind, amount_paise, balance_after_paise,
			razorpay_order_id, razorpay_payment_id, description
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id`),
		orgID, nullableID(actorUserID), string(kind), amountPaise, newBal,
		nullable(razorpayOrderID), nullable(razorpayPaymentID), nullable(description),
	).Scan(&id); err != nil {
		return Transaction{}, err
	}
	if err := tx.Commit(); err != nil {
		return Transaction{}, err
	}
	var actor *int64
	if actorUserID > 0 {
		v := actorUserID
		actor = &v
	}
	return Transaction{
		ID:                id,
		OrgID:             orgID,
		ActorUserID:       actor,
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
	var actorID sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT id, org_id, actor_user_id, kind, amount_paise, balance_after_paise,
		        COALESCE(related_roll,''), COALESCE(razorpay_order_id,''),
		        COALESCE(razorpay_payment_id,''), COALESCE(description,''),
		        created_at
		 FROM wallet_transactions
		 WHERE razorpay_payment_id = $1`,
		paymentID,
	).Scan(
		&t.ID, &t.OrgID, &actorID, &k, &t.AmountPaise, &t.BalanceAfterPaise,
		&t.RelatedRoll, &t.RazorpayOrderID, &t.RazorpayPaymentID,
		&t.Description, &t.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if actorID.Valid {
		id := actorID.Int64
		t.ActorUserID = &id
	}
	t.Kind = Kind(k)
	return &t, nil
}

// ensureWallet creates a 0-balance row for `orgID` if one doesn't exist
// yet. Safe to call repeatedly — the INSERT OR IGNORE is idempotent.
func (s *Store) ensureWallet(ctx context.Context, orgID int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO wallets(org_id, balance_paise) VALUES ($1, 0) ON CONFLICT (org_id) DO NOTHING`,
		orgID,
	)
	return err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
}
