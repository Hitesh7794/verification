# Wallet & Razorpay billing

Phase 6 — operations-facing doc for the per-client wallet that bills
every candidate lookup. Test-mode integration with Razorpay Checkout;
flipping to production is a key swap, nothing else.

---

## What it does

- Every `GET /api/candidates/{roll}` made by a **client**-role user
  debits a fixed fee (default ₹5 = 500 paise) from that user's wallet.
- Admin and superadmin lookups are free — the middleware short-circuits
  on role.
- If the wallet can't cover the fee, the backend returns **HTTP 402
  Payment Required**. The frontend catches it, opens the deposit
  modal, and retries the failed lookup automatically once the
  top-up succeeds.
- A 5-minute same-roll cache prevents double-billing when the operator
  refreshes / re-searches the same candidate immediately.
- Top-ups go through **Razorpay Checkout** (test mode today; one env
  flip away from production).

---

## Pricing knobs (env vars)

| Variable | Default | Notes |
|---|---|---|
| `WALLET_FEE_PER_LOOKUP_PAISE`  | `500`     | ₹5 per lookup. Integer paise. |
| `WALLET_MAX_DEPOSIT_PAISE`     | `5000000` | ₹50 000 single-deposit cap. |
| `WALLET_SAME_ROLL_CACHE_MIN`   | `5`       | Minutes the same roll stays free after a paid lookup. |
| `RAZORPAY_KEY_ID`              | —         | `rzp_test_…` in dev, `rzp_live_…` in prod. |
| `RAZORPAY_KEY_SECRET`          | —         | **Server-side only.** Never reaches the browser. |

Set these in `backend/.env` (gitignored). `backend/.env.example` ships
as the template.

---

## Database schema (migration 5)

```sql
CREATE TABLE wallets (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_paise INTEGER NOT NULL DEFAULT 0
                CHECK (balance_paise >= 0),
  updated_at    INTEGER NOT NULL
);

CREATE TABLE wallet_transactions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                 TEXT    NOT NULL,           -- deposit | charge | admin_credit | refund
  amount_paise         INTEGER NOT NULL,           -- signed: +deposit, -charge
  balance_after_paise  INTEGER NOT NULL,
  note                 TEXT,
  razorpay_order_id    TEXT,
  razorpay_payment_id  TEXT,
  related_roll_no      TEXT,
  created_at           INTEGER NOT NULL
);

CREATE UNIQUE INDEX wallet_tx_unique_payment_id
  ON wallet_transactions(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;
```

**Why integer paise:** float money is a known bug source. Every amount
in the system is integer paise; `formatRupees(paise)` formats for
display.

**Why a CHECK + atomic UPDATE:** the debit is
`UPDATE wallets SET balance_paise = balance_paise - ? WHERE balance_paise >= ?`.
SQLite's row-level locking + the WHERE guard makes it impossible to
oversell, even under concurrent goroutines. Verified by
`TestDebit_AtomicUnderConcurrency` in `wallet/wallet_test.go` — 50
parallel workers, exactly N succeed when balance = N × fee.

**Why the unique partial index on `razorpay_payment_id`:** double-
submitting the same verify-payment call (network retry, page reload
during verification) must not credit twice. The UNIQUE constraint
makes the second INSERT fail; the handler treats that as a no-op.

---

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/api/wallet/config`           | any signed-in user | Returns `{fee_paise, key_id, enabled}`. `enabled=false` if Razorpay creds aren't set. |
| `GET`  | `/api/wallet/balance`          | any signed-in user | Returns `{balance_paise, transactions[]}` (last 50 tx). |
| `POST` | `/api/wallet/order`            | client             | `{amount_paise}` → `{order_id, amount, currency, key_id}`. Calls Razorpay Orders API. |
| `POST` | `/api/wallet/verify-payment`   | client             | `{order_id, payment_id, signature}` → HMAC verify + credit. Idempotent. |
| `POST` | `/api/admin/wallet/credit`     | admin / superadmin | `{user_id, amount_paise, note}` — offline top-up or correction. |

Every successful `GET /api/candidates/{roll}` for a client adds:

- `X-Wallet-Balance-Paise: <new balance>`
- `X-Wallet-Charged-Paise: <fee or 0 if same-roll cached>`

A wallet-empty response is:

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{"error":"wallet_empty","balance_paise":120,"fee_paise":500}
```

---

## Razorpay flow (browser ↔ backend ↔ Razorpay)

```
┌──────────┐  1.create order   ┌─────────┐  2. POST /v1/orders   ┌──────────┐
│ Browser  │ ────────────────► │ Backend │ ────────────────────► │ Razorpay │
│          │                   │         │ ◄──────────────────── │          │
│          │ ◄──────────────── │         │   order_id            │          │
│          │   {order_id,key}  └─────────┘                       │          │
│          │                                                     │          │
│          │  3. open Checkout (key_id + order_id, hosted UI)    │          │
│          │ ──────────────────────────────────────────────────► │          │
│          │  4. card + OTP, Razorpay confirms payment           │          │
│          │ ◄────────────────────────────────────────────────── │          │
│          │   {order_id, payment_id, signature}                 │          │
│          │                                                     │          │
│          │  5.verify-payment ┌─────────┐                       │          │
│          │ ────────────────► │ Backend │  HMAC-SHA256          │          │
│          │                   │         │  (order|payment, key) │          │
│          │ ◄──────────────── │         │  → credit wallet      │          │
└──────────┘   {balance}       └─────────┘                       └──────────┘
```

**Signature verification** (server-side, in `razorpay/razorpay.go`):

```
expected = HMAC_SHA256(key_secret, order_id + "|" + payment_id)
if !hmac.Equal(expected, signature_from_client) { reject }
```

The KEY_SECRET never leaves the server. Anything signed with it is
proof-of-payment that Razorpay has already accepted the funds. If the
signature is valid and the (idempotency-keyed) credit hasn't happened
yet, the wallet is credited and the transaction row is inserted.

---

## Test mode → production switch

1. Get live keys from the Razorpay dashboard.
2. In `backend/.env` replace:
   - `RAZORPAY_KEY_ID=rzp_test_…` → `rzp_live_…`
   - `RAZORPAY_KEY_SECRET=<test secret>` → `<live secret>`
3. Restart the backend.

That's it. Same code path, same DB schema. The only mode-aware bit is
the keys themselves; Razorpay routes test keys to a sandbox and live
keys to real PSPs.

---

## Test cards (Razorpay test mode)

- **Card number:** `4111 1111 1111 1111`
- **CVV:** any 3 digits
- **Expiry:** any future date
- **OTP:** `1111` (when prompted)
- **UPI:** `success@razorpay`

Failure cases for testing the error surface:

- **Declined card:** `5104 0600 0000 0008`
- **Insufficient funds:** `4012 0010 3714 1112`

No real money moves in test mode. The dashboard at
`dashboard.razorpay.com` shows test payments under a "Test mode" toggle.

---

## Operator UX (frontend)

- **Navbar wallet widget** (client role only): coloured balance pill +
  Deposit button. Tier colours:
  - **emerald** when balance ≥ 5 lookups
  - **amber** when balance < 5 lookups
  - **rose** when wallet is empty
- **Deposit modal:** presets (₹100 / 500 / 1000 / 5000) + freeform.
  Loads `checkout.js` from CDN on demand (no bundle bloat for users
  who never deposit).
- **Low-balance modal:** auto-opens on HTTP 402. "Add money" launches
  the deposit modal; the failed candidate lookup retries automatically
  after a successful top-up.

---

## Admin manual credit

For phone-paid or invoiced operators, admins can credit wallets
directly:

```bash
curl -X POST https://portal.example.com/api/admin/wallet/credit \
  -H "Content-Type: application/json" \
  -H "Cookie: session=…" \
  -d '{"user_id":42, "amount_paise":250000, "note":"Invoice INV-2026-014"}'
```

The transaction is logged with `kind=admin_credit` and a note —
visible in the operator's wallet history.

---

## Files

```
backend/
├── .env                              # gitignored — real keys
├── .env.example                      # template (committed)
└── internal/
    ├── config/config.go              # WALLET_* + RAZORPAY_* env vars
    ├── db/migrate.go                 # migration 5 (wallets, wallet_transactions)
    ├── razorpay/
    │   ├── razorpay.go               # CreateOrder + VerifySignature (HMAC-SHA256)
    │   └── razorpay_test.go          # signature roundtrip
    ├── wallet/
    │   ├── wallet.go                 # Store: Debit, Credit, History, idempotency
    │   └── wallet_test.go            # 6 tests incl. 50-way concurrent debit
    └── api/
        ├── wallet_handlers.go        # /api/wallet/{config,balance,order,verify-payment} + admin/credit
        ├── wallet_middleware.go      # walletCharge — gates GET /api/candidates/{roll}
        └── server.go                 # wires wallet store + Razorpay client into routes

frontend/src/
├── lib/
│   ├── api.js                        # ApiError + isWalletEmptyError
│   └── wallet.js                     # getWalletConfig / getWallet / createWalletOrder /
│                                     # verifyWalletPayment / deposit (Razorpay Checkout)
└── components/
    ├── WalletWidget.jsx              # navbar composite (balance + Deposit button)
    ├── WalletBalanceBadge.jsx        # tiered coloured pill
    ├── DepositModal.jsx              # preset amounts + Razorpay Checkout
    └── LowBalanceModal.jsx           # opens on HTTP 402, retries on top-up
```

---

## Gotchas

- **KEY_SECRET in the browser:** the `key_id` is public (it's literally
  passed to the Checkout JS in clear), but the **key secret** must
  never reach the browser. It's only used server-side for signing the
  order request (HTTP Basic) and verifying the post-payment signature.
- **`razorpay_*api_keys*.csv`** is gitignored — never commit the raw
  key dump Razorpay emails you.
- **Test-mode dashboard separation:** the Razorpay dashboard has a
  "Test mode" toggle in the top-right. Switching keys without
  switching the toggle leaves you looking at the wrong ledger.
- **402 vs 401:** 402 means "auth is fine, you just can't afford
  this." Don't add a global 401 → logout interceptor that also
  catches 402 — the frontend distinguishes them in `api.js`.
- **Same-roll cache is per-process** — restarting the backend resets
  it. That's fine: worst case the operator pays twice for one lookup
  during a deploy.
