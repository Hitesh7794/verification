package wallet

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Razorpay-order tracking. The wallet handlers store every order we
// create with Razorpay here, so verify-payment + webhook can validate
// (a) the order_id was ours (not forged or replayed from another
// account), (b) which org it belongs to, and (c) the canonical
// amount we asked Razorpay for — the only number the wallet credit
// should ever trust.
//
// The HMAC signature Razorpay sends back only covers (order_id|
// payment_id); it does NOT cover the amount. Before this table
// existed, the browser claimed an amount and we believed it — which
// made wallet credit forgery a one-line exploit (see CONTEXT.md §21).

// ErrOrderNotFound — no row for the given razorpay_order_id. Handlers
// map this to 400 (not 404) so we don't leak existence of arbitrary
// order IDs to unauthenticated probing.
var ErrOrderNotFound = errors.New("wallet: razorpay order not found")

// Order is one row in razorpay_orders. The amount_paise here is the
// canonical, server-set figure; verify-payment must use it, never the
// client's claimed value.
type Order struct {
	RazorpayOrderID string
	OrgID           int64
	ActorUserID     int64
	AmountPaise     int
	Receipt         string
	Status          string // "created" | "verified" | "expired"
	CreatedAt       time.Time
	VerifiedAt      *time.Time
}

// SaveOrder records a freshly-created Razorpay order. Called after
// Razorpay's /v1/orders endpoint returns success — at that point
// Razorpay has issued the order_id and we capture (orgID, amount)
// for later verification.
//
// Ordering note: handlers call this AFTER the Razorpay API call
// succeeds. A failure here leaves an "orphan" order at Razorpay but
// no row in our DB; that's harmless because Razorpay auto-expires
// unpaid orders in 15 minutes, the user never opens Checkout (we
// return 500), and they retry, getting a fresh order. Inserting
// BEFORE the Razorpay call would be cleaner transactionally but
// would clutter the DB with orders that never made it to Razorpay
// (transient network errors, Razorpay outage).
func (s *Store) SaveOrder(ctx context.Context, o Order) error {
	if o.RazorpayOrderID == "" || o.OrgID <= 0 || o.ActorUserID <= 0 || o.AmountPaise <= 0 {
		return errors.New("wallet: SaveOrder requires order_id, org_id, actor_user_id, amount_paise")
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO razorpay_orders(
			razorpay_order_id, org_id, actor_user_id,
			amount_paise, receipt, status
		) VALUES (?, ?, ?, ?, ?, 'created')`,
		o.RazorpayOrderID, o.OrgID, o.ActorUserID,
		o.AmountPaise, nullable(o.Receipt),
	)
	return err
}

// FindOrder returns the row for razorpayOrderID, or ErrOrderNotFound
// if nothing matches. Used by verify-payment and the webhook to
// canonicalise the amount + org for a given order.
func (s *Store) FindOrder(ctx context.Context, razorpayOrderID string) (*Order, error) {
	if razorpayOrderID == "" {
		return nil, ErrOrderNotFound
	}
	var o Order
	var receipt sql.NullString
	var verifiedAt sql.NullTime
	err := s.db.QueryRowContext(ctx,
		`SELECT razorpay_order_id, org_id, actor_user_id,
		        amount_paise, COALESCE(receipt,''), status,
		        created_at, verified_at
		 FROM razorpay_orders
		 WHERE razorpay_order_id = ?`,
		razorpayOrderID,
	).Scan(
		&o.RazorpayOrderID, &o.OrgID, &o.ActorUserID,
		&o.AmountPaise, &receipt, &o.Status,
		&o.CreatedAt, &verifiedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrOrderNotFound
	}
	if err != nil {
		return nil, err
	}
	o.Receipt = receipt.String
	if verifiedAt.Valid {
		t := verifiedAt.Time
		o.VerifiedAt = &t
	}
	return &o, nil
}

// MarkOrderVerified flips the order's status from 'created' to
// 'verified' and stamps verified_at. Best-effort: a failure here
// doesn't undo the wallet credit (which is the security-critical
// bit). The status field is for reconciliation reports, not auth.
func (s *Store) MarkOrderVerified(ctx context.Context, razorpayOrderID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE razorpay_orders
		 SET status = 'verified', verified_at = CURRENT_TIMESTAMP
		 WHERE razorpay_order_id = ? AND status = 'created'`,
		razorpayOrderID,
	)
	return err
}
