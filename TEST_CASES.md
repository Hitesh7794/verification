# Test Cases & Edge Cases

Short checklist of scenarios worth exercising before sign-off. Each
point lists the trigger, the expected behaviour, and where to verify it.

## Authentication & roles

### 1. Login — valid and invalid credentials
Sign in as `client / client123`, `admin / admin123`, or `super / super123`
to land on the matching dashboard. A 12-hour token is issued. With a
wrong password or unknown user, the UI shows "invalid credentials"
inline; no token is issued and the same generic error is shown either
way so the response doesn't leak which half was wrong.

### 2. Role-based route protection
While signed in as `client`, manually visit `/admin` or `/superadmin`
in the URL bar. App redirects to the role's own login page. Backend
endpoints under `/api/admin/*` and `/api/super/*` return HTTP 403 if a
client token is forwarded.

## Wallet & payment

### 3. Empty wallet blocks lookup
With balance ₹0, search any roll. Backend returns HTTP 402; the UI
opens the low-balance modal showing current balance vs the per-lookup
fee. Candidate page does not load until the wallet has enough.

### 4. Successful top-up via Razorpay test mode (with idempotency)
From the low-balance modal click "Add money", pick an amount, complete
checkout with card `4111 1111 1111 1111`, any future expiry, any CVV,
OTP `1111`. Backend HMAC-verifies Razorpay's signature and credits the
wallet. The failed lookup retries automatically. Replaying the same
verify-payment call (network retry) returns `replayed: true` and credits
the wallet only once — confirmed via the unique index on
`razorpay_payment_id`.

### 5. Same-roll cache (no double-billing on refresh)
Look up roll `99100`, then refresh the candidate page or search the
same roll again within 5 minutes. Balance does not change on the
second hit. After 5 minutes the same roll charges again.

### 6. Concurrent debits cannot oversell
With balance set to exactly `N × fee`, fire `N + 5` parallel candidate
lookups for distinct rolls. Exactly `N` succeed (200), the rest fail
with 402. Balance lands at zero, ledger has exactly `N` charge rows.
The `CHECK >= 0` constraint + atomic `UPDATE … WHERE balance >= ?`
prevent overselling.

## Candidate lookup & verification

### 7. Unknown roll number
Search a roll that doesn't exist (e.g., `00000`). Backend returns 404
"candidate not found". UI shows a clean inline message. Wallet is
**not** charged on this path (charge fires only after a successful
lookup, so a typo doesn't burn money).

### 8. Fingerprint match — same finger
Place the same finger on the scanner that was used to enrol the demo
candidate (roll `99100`). Score should be well above the per-vendor
threshold (Startek/SourceAFIS: 300+ vs threshold 40; Mantra MorFin:
typically > 140). Banner turns green, "Match · score X / threshold Y"
shown inline.

### 9. Fingerprint mismatch — falls through to iris fallback
Place a different finger on the same scanner. Score should be near
zero (Startek: < 5; Mantra: well below 140). Red "No match" banner
appears, plus an inline card offering "Try iris instead". Clicking it
opens the iris capture flow; a successful iris capture lets the
operator mark the candidate Verified, with the audit row recording
`via = iris`.

### 10. Manual override (no biometric matched)
Operator clicks **Verified** without any biometric match (face missed,
fingerprint failed, iris failed or skipped). Row is saved with
`via = manual`. Lets a supervisor audit exactly which decisions had no
biometric backing.

### 11. Idempotent verification submit
Submit a verification, then submit it again with the same
`idempotency_key` (simulate a network retry mid-submit). Backend
returns the original row with header `X-Idempotent-Replay: true`. No
duplicate rows in the `verifications` table.

## Multi-vendor fingerprint

### 12. Vendor auto-detect and live swap
With only Mantra plugged in, banner reads "Mantra · MFS500" and match
runs on the operator laptop. With only Startek plugged in, banner
reads "Startek · FM220U L1" and match runs on the central server via
SourceAFIS. Audit row records the right `fp_vendor` either way.
Unplugging one and plugging in the other re-arbitrates within ~2 s on
the next poll tick — no reload, no page refresh.

## Resilience & UI edge cases

### 13. Device unplugged mid-shift / daemon not running
Pull the fingerprint USB cable mid-session, or stop the
`ACPL_TEMPLATE_API_SERVICE` / `MorfinAuthClientService`. Status banner
flips from green to "No device plugged in" or "Device service not
running" within ~2 s. Plug back / restart service → banner returns to
green automatically. State machine never wedges.

### 14. Webcam unavailable (browser blocks getUserMedia)
Open the portal over plain HTTP from a LAN IP (not localhost). Browser
blocks webcam. UI shows a friendly "Unable to access webcam" message
instead of an undefined-error crash; operator can still complete a
manual verification or proceed to the fingerprint step.

---

## "Pass" definition

A test passes if the documented behaviour holds AND no error appears
in the backend log AND the verification ledger reflects only the
intended rows. For wallet tests, the ledger's running
`balance_after_paise` column must also match the wallet table's
`balance_paise` at every step.

