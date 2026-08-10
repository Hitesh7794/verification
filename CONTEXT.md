# Context, Decisions & Open Issues

This file captures the **why** behind architectural choices, things we
can't verify without hardware, vendor questions still outstanding, and
how to revisit decisions if the situation changes. Read this before
making non-trivial changes — most of the surprising design choices are
explained below rather than in the code.

Last updated: 2026-06-10

> **For the next agent picking this up:** sections 1-9 below are the
> historical context (May 2026). Sections 10-16 at the bottom cover the
> June 2026 work — the most recent being section 12 (actual Mantra
> daemon API contract, discovered by reading the JAR's bytecode) and
> section 13 (the agreed-but-not-yet-done switch of Mantra to
> server-side matching). Read 10-16 first if you're new.

---

## 1. Operator-side OS — both Linux and Windows are supportable from one JAR

**Updated finding (2026-05-05):** The vendor "Linux SDK" naming is
misleading. Both `MorfinAuthClientService.deb`'s payload JAR and
`Marvis_Auth.jar` already ship Windows `.dll` and Linux `.so` natives
inside, and dispatch on `os.name`/`os.arch` at runtime:

```
morfinauth-client-service-1.0.0.0.jar
  ├── linux/x86/        libMorfin_Auth.so + friends
  ├── linux/x86_64/     libMorfin_Auth.so + friends
  ├── win/x86/          Morfin_Auth.dll  + friends
  └── win/x64/          Morfin_Auth.dll  + friends
```

`Marvis_Auth.jar` has the same shape (Linux `.so`, Windows `.dll`).
The dispatch logic lives in `com.mantra.morfinauth.MorfinAuthNative` /
`com.mantra.marvisauth.NativeUtils` — verified by reading the constant
pool of those classes.

**What this means for our packaging:**

- The same JARs run on Linux and Windows operator laptops; there is no
  Windows-only SDK to chase from Mantra.
- Only the **packaging** is OS-specific: the `.deb` installs to
  `/usr/local/...`, registers a systemd unit, and imports the vendor
  TLS certs into Linux trust stores. A Windows installer needs to do
  the same three things via `nssm` (or Windows Service API), the
  Windows certificate store, and a Start Menu shortcut.

**Decision (2026-05-05, supersedes 2026-05-02):**

Default operator target is still Ubuntu 18.04+ for the first
deployment, since that's where the existing vendor `.deb` lands without
custom work. **Windows is no longer blocked on a Mantra deliverable** —
it's blocked on us writing a Windows installer that bundles the same
JARs. Tools to consider:

- `jpackage` (JDK 14+) — same input, emits both `.deb` and `.msi`.
- WiX Toolset — proper MSI authoring if `jpackage` defaults are too
  coarse.
- Inno Setup / NSIS — simpler `.exe` installers, popular for Java apps.

**What's NOT affected:**
- Frontend (React + Vite) — runs in any browser on any OS
- Backend (Go) — builds for any OS, deploys on Linux EC2
- `morfin-mock` / `iris-mock` dev servers — Go, cross-compile
- The wire protocols on `localhost:8030` / `:8031` — same JSON on every
  platform the vendor JARs ship for

**Open question that still goes to Mantra:** the Linux `.deb` ships
three certificates (`CEIS1602167783Cer.crt`, `mantrardca.crt`,
`msiplrdca.crt`) and uses `certutil`/`update-ca-certificates` to import
them. We need the equivalent Windows certmgr import step (PowerShell
`Import-Certificate -CertStoreLocation Cert:\LocalMachine\Root`) —
Mantra likely has this scripted in their Windows installer if/when they
share one, otherwise we can write it ourselves from the same `.crt`
files.

---

## 2. Why a local native daemon exists at all

It's a web app. So why does the operator need to install anything?

**Browsers are sandboxed and cannot drive USB devices.** Their access is
limited to: network (`fetch`/WebSocket), webcam/mic (`getUserMedia`),
clipboard, file pickers. They cannot enumerate USB endpoints, talk to
HID devices via vendor-specific protocols, or load kernel drivers.

The Mantra fingerprint readers (MELO041 / MFS500 / MARC10) use vendor
USB protocols not exposed via WebUSB. So **the only way to bridge browser
↔ USB is a small native helper running on the laptop**.

```
[ Browser (web app) ] ── HTTP JSON ──▶ [ localhost:8030 daemon ] ── USB ──▶ [ device ]
   OS-agnostic                              OS-specific binary
```

The daemon is exactly what the vendor's `.deb` installs. We never
re-implement the matcher; we just talk to it.

**Could the matcher run server-side instead?** Capture *must* happen on
the laptop because USB is a local-machine bus. Matching could move to
the server, but the local daemon would still be needed for capture, so
the OS dependency doesn't go away. Not worth the complexity right now.

**Face matching (Luxand, future) is different.** The browser CAN access
the webcam, so face capture happens in-browser, the JPEG ships to the
server, and Luxand matches server-side. Face is the only fully
OS-independent channel.

---

## 3. Hardware-blocked unknowns

These are things the code currently assumes; correctness can only be
confirmed when a real device is plugged in. None are architectural;
all are either env-var tunables or one-line code adjustments.

| # | Assumption | Risk if wrong | How we'd find out | Fix |
|---|---|---|---|---|
| 1 | `FP_MATCH_THRESHOLD=140` matches the vendor's own `DEFAULT_MATCH_THRESHOLD = 140` constant in `MorfinAuthClientService` (verified 2026-05-05 in the daemon JAR's bytecode). **Still tunable** — first real captures should confirm the score distribution and let us pick a per-deployment value. | False positives or false negatives | First real captures will show the score distribution | Adjust the env var; per-org override later |
| 2 | `ClientKey: ''` (empty) is accepted by `info`/`init` | If Mantra requires a license key, all calls fail with a non-zero `ErrorCode` | First call to `/info` with real daemon | Add a `ClientKey` config and surface in operator setup |
| 3 | Daemon's HTTP listener accepts cross-origin requests with permissive CORS | Browser blocks calls | DevTools console shows CORS errors | Use HTTPS and rely on the .deb's installed cert; or contact Mantra |
| 4 | `connecteddevicelist` returns the device name in a parseable format like `"Found Devices: MFS500"` | Frontend's parser returns empty list, status sticks at `no_device` | Look at raw `ErrorDescription` in DevTools | Adjust `parseDeviceList` |
| 5 | Liveness `-1 / 0 / 1` matches the JS sample's mapping | UI shows wrong liveness label | Check `LiveNess_Result` value in the response | Adjust the mapping in `FingerprintCapture.jsx` |
| 6 | Marvis `MatchImage` returns a `float[]` of length 2 (left + right eye scores) | Index out of bounds, or one-eye scores misinterpreted | Run a real `MatchImage` call against captured + gallery iris bytes | Adjust iris-service wrapper signature |
| 7 | Marvis K7 is the right gallery-side template format. **Note (2026-05-05):** verified against the JAR — `com.mantra.marvisauth.enums.ImageFormat` exposes `BMP, RAW, K7, IIR_K7, K1`. "K3" and "JPEG2000" mentioned in earlier docs do not exist in this SDK. | Bigger files / poor match quality / format mismatch error | Compare match scores across the actual formats above | Per-org config; document recommended choice |

Items 1–5 unblock once we have a fingerprint device. 6–7 unblock once
we have an iris device. Plan: bring up the iris .deb (Phase 2) on a
hardware-equipped laptop and exercise each item with a known good
sample.

---

## 4. Outstanding vendor questions for Mantra

Send a single email to `servico@mantratec.com` covering:

```
Subject: MorFin Auth + Marvis Auth integration questions

For the MorfinAuth_Linux_Web_SDK_1.0.0.0 (MELO041 / MFS500 / MARC10):
1. We see your `morfinauth-client-service-1.0.0.0.jar` already bundles
   both `linux/{x86,x86_64}/libMorfin_Auth.so` and
   `win/{x86,x64}/Morfin_Auth.dll` and dispatches on `os.name`. Can we
   confirm the same JAR is your supported deliverable for Windows
   operator laptops too, or do you ship a Windows-specific binary?
2. The Linux `.deb`'s `postinst` imports three certificates
   (`CEIS1602167783Cer.crt`, `mantrardca.crt`, `msiplrdca.crt`) into
   Firefox / Chrome NSS DBs and the system trust store. Do you have a
   matching Windows installer / PowerShell script for `certmgr`
   (`Cert:\LocalMachine\Root`) we can adopt, or should we author our
   own from the same `.crt` files?
3. Your `MorfinAuthClientService` class has
   `private static final int DEFAULT_MATCH_THRESHOLD = 140`. Is 140 the
   recommended threshold for 1:1 verification, and what's the full
   `MatchScore` range it's compared against (0..255? 0..1000?)?
4. Is the `ClientKey` parameter required, or only when license-bound
   features are in use? What activates a key requirement?
5. What is the expected wire shape of `connecteddevicelist` and
   `info` when a license is invalid vs when no device is plugged in?

For the Marvis_Auth_Linux_Java_1.0.0.0 (MIS100V2):
6. The `MatchImage(byte[] probImage, byte[] galleryImage,
   ImageFormat format, float[] matchScore)` method is in the JAR
   but not in the published PDF. Please confirm:
   a. Is it production-ready or experimental?
   b. What's the score range and recommended threshold?
   c. Does `matchScore` carry left + right eye scores (length 2),
      or a single combined score (length 1)?
   d. Of the published `ImageFormat` values (BMP, RAW, K7, IIR_K7, K1),
      which is recommended for the gallery side (compact + reliable)?
7. Are there published per-eye quality minimums for a reliable match?
```

---

## 5. Architectural decisions (and why)

### 5.1 Database — SQLite (dev) → Postgres (prod), same schema

- **Why:** SQLite has zero ops cost for local dev; Postgres scales for
  many concurrent operators. Every SQL we write is portable: `CREATE
  TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`, partial unique indexes
  with `WHERE ... IS NOT NULL` (Postgres native, SQLite ≥3.8.0).
- **Migration runner:** versioned in `internal/db/migrate.go`; adding
  new schema is appending an entry, never editing an existing one.

### 5.2 Verification stored as wide row, not many tables

- Decision columns and biometric scores all live on `verifications`.
- Captured bytes (face JPEG, fp BMP, iris image) live in
  `verification_artifacts` only when `ARTIFACT_RETENTION != "none"`.
- **Why:** the audit query — "show me every decision for org X with
  scores" — is a single indexed scan. Splitting into per-channel
  tables would require joins that the dashboards run every 4 s.

### 5.3 1:1 matching — vendor-dependent (local vs server-side)

> **Update 2026-06-10:** We're consolidating Mantra onto the server-side
> matcher too (same code path as Startek). The table below documents
> the state at time of writing; **section 13 has the rationale + plan**
> for the switch. Until that change lands, Mantra matching is still
> local; after, both vendors run through `fp-match-service` and the
> Mantra MatchScore drops out of the audit row in favour of a SourceAFIS
> score.

Originally the design was "matching always on the operator laptop"
(Mantra MorFin's daemon does capture+match in one call). That stayed
the default for MorFin but doesn't generalise to all vendors:

| Vendor | Capture | Matching (today) | Matching (after section 13) | Why |
|---|---|---|---|---|
| Mantra MorFin | Operator laptop | Operator laptop | **Server (`fp-match-service` / SourceAFIS)** | Consistency across vendors, comparable scores, centralised threshold tuning, vendor-neutral audit. The CPU win on operator laptops is real but tiny (~50 ms blip). |
| Startek/ACPL FM220U | Operator laptop | **Server (`fp-match-service` / SourceAFIS)** | Server (unchanged) | ACPL's L1 Capture API only matches same-session templates — verified to reject stored gallery FMR templates with errorCode 104. Server-side SourceAFIS accepts any FMR template regardless of source SDK. |
| Luxand face | Browser webcam | Server (`luxand-service`) | Server (unchanged; planned swap to a tuned cloud API — see section 14) | Browser does its own webcam capture (no daemon needed); central matching means no per-laptop install. |

In all cases the **backend never talks to a device**, the operator
laptop never stores gallery templates persistently, and the score lands
on the same `verifications` audit row. Stateless central server stays
trivially horizontally scalable; per-laptop daemons stay focused on USB
+ capture; templates flow probe→server (no PII on the laptop after the
session ends).

### 5.3b Server-side fingerprint matcher (SourceAFIS, added 2026-05-16)

`fp-match-service` is the structural analogue of `luxand-service`:

- Pure-Java Javalin service on `127.0.0.1:8050`
- Wraps SourceAFIS 3.18.1 (Apache 2.0, no licence, no native libs)
- Accepts FMR_V2005 / FMR_V2011 / ANSI 378 templates via
  `FingerprintCompatibility.importTemplate(byte[])` — vendor-neutral
- Returns a similarity score; threshold 40 = SourceAFIS's documented
  1-in-1000 FMR
- Runs as a Docker container on Mac for dev, a systemd unit on EC2 for
  prod — same deploy pattern as luxand

**Why SourceAFIS over the alternatives:**

| Alternative | Why not |
|---|---|
| Use ACPL's Capture API GetMatchResult | Verified empirically (2026-05-15) to only match same-session templates. Stored gallery → errorCode 104, all device-info fields blanked out. Vendor confirmed the L1 RD package is for Aadhaar auth, not 1:1 verification. |
| Wrap ACPL's `ISOminutiaMatchEx` via P/Invoke from a per-laptop Windows service | Vendor-locked to Startek; Windows-only; per-laptop service to install + maintain; same template-rejection risk as the WebApi. |
| Wait for ACPL's non-L1 Bio-API SDK | Weeks of vendor turnaround. Costs licensing. Still vendor-locked. |
| Pay for Innovatrics / Aware / Neurotechnology | Licence fees, vendor lock-in, no improvement in accuracy for the score gap we observe. |
| NIST NBIS Bozorth3 | C/CLI shell-out, more integration friction than the pure-Java SourceAFIS, comparable accuracy. |

SourceAFIS wins on every axis: free, open, pure Java (mirrors our
existing Java services), vendor-neutral, mature (10+ years), accuracy
verified on our actual data.

**Threshold reference (FAR = false-accept rate):**

| Threshold | FAR (1 in N) | When to use |
|---|---|---|
| 22 | 1 / 100 | Demo, casual unlock |
| **40** ⭐ | **1 / 1,000** | **Default — our `FP_MATCH_THRESHOLD=40`** |
| 52 | 1 / 10,000 | Higher-assurance |
| 64 | 1 / 100,000 | Government / banking |
| 84 | 1 / 1,000,000 | Forensic / very high security |

For NEET exam impersonation prevention, 40 is the right default. On our
observed data the gap between match (300-500) and non-match (0-5) is
~50×, so anything between 30 and 80 separates cleanly. Don't go above
~70 without calibration — operator-laptop sensor variance starts
producing false rejects on legitimate candidates.

### 5.4 Idempotent verification submit

- Every attempt carries `idempotency_key` (client-generated UUID).
- Backend has a unique partial index on it; replay returns the
  original row with `X-Idempotent-Replay: true`.
- **Why:** flaky last-mile network in exam centers. Without this, an
  operator's retry creates two rows.

### 5.5 Mock on `localhost:8030`, same port as the real daemon

- **Why:** the swap is "kill the mock, start the real daemon".
  No env vars, no code change, no rebuild. The frontend can't tell
  which is which.

### 5.6 No vendor's jQuery, our own promise/fetch wrapper

- The vendor's reference JS uses `$.ajax({async:false})` which blocks
  the main thread. Our wrapper is async fetch, with typed
  `MorfinError(kind, code, description)`.
- **Why:** the synchronous version freezes the operator's tab during
  every capture. Async unblocks recovery flows.

### 5.7 Zero-config device UX (no dropdown, no init button)

- `useDeviceStatus` polls `connecteddevicelist` every 2 s. First
  supported device becomes "the device". Init runs silently.
- **Why:** the user explicitly asked for "plug in, log in, work" UX.

### 5.8 Wallet — per-lookup billing via Razorpay test mode (added 2026-05-18)

- Every `GET /api/candidates/{roll}` issued by a `client`-role user
  passes through a charge middleware (`internal/api/wallet_middleware.go`)
  that atomically debits `WALLET_FEE_PER_LOOKUP_PAISE` (default ₹5).
  Admin and superadmin lookups skip the charge entirely.
- Top-ups go through **Razorpay Checkout in test mode**. The backend
  calls `POST api.razorpay.com/v1/orders` to register an intent, the
  browser drives the hosted Checkout, then sends the resulting
  `(order_id, payment_id, signature)` triple to
  `POST /api/wallet/verify-payment`. The backend verifies the HMAC
  signature server-side before crediting; a unique partial index on
  `wallet_transactions.razorpay_payment_id` makes replays idempotent.
- A 5-minute **same-roll cache** (`WALLET_SAME_ROLL_CACHE_MIN`) prevents
  double-billing when the operator refreshes a page or quickly re-
  searches the same candidate.
- **Why Razorpay over a self-serve "fake deposit" button:** test mode
  is identical to live mode at every layer except the keys (fake card
  4111 1111 1111 1111 always succeeds, no real money). Switching to
  production is one env-var change. The HMAC verification, replay
  defence, idempotency, and atomic SQL transaction we wrote in test
  mode are the same code that runs in production.
- **Why store paise as integers:** floating-point money is a bug
  category. `wallets.balance_paise` is `INTEGER CHECK (… >= 0)`; the
  debit uses `UPDATE … WHERE balance_paise >= ?` so concurrent debits
  can never oversell (verified via a 50-way concurrent-debit test in
  `wallet/wallet_test.go`).
- **Why only client gets a wallet:** the user explicitly chose this in
  the planning conversation. Admin/superadmin are oversight roles; in
  the current threat model they don't pay per lookup. The schema
  doesn't prevent extending the feature to other roles later (the
  `wallet_handlers.go` admin-credit path already uses the same store).

---

## 6. Phase plan & status

```
Phase 0 — Schema & API extensions           [DONE]
  #5 Template format detection (FMR_V2005/2011/ANSI_V378)
  #6 Biometric score columns + artifacts table
  #7 /fp-template + extended POST /verifications + /artifacts

Phase 1 — Fingerprint integration            [DONE]
  #8 Frontend zero-config flow
  #9 morfin-mock dev server with fault injection

Phase 2 — Iris fallback                      [DONE]
  #10 mantra-iris-service (Java/Javalin wrapper around Marvis JAR;
      localhost:8031; /iris/match using MatchImage). Reflective
      loader so the SDK isn't a build-time dep; falls back to mock
      when JAR is absent. Packaging script lives in iris-service/.
      Frontend iris fallback wired in components/IrisCapture.jsx.
      Go-based iris-mock under backend/cmd/iris-mock for dev parity
      with morfin-mock.

Phase 3 — Production rollout                 [PARTIAL]
  #11 client-bootstrap/{linux,windows} — DONE.
      • linux/install.sh + meta-deb + 3 vendor .debs
      • windows/install.ps1 + same JARs + nssm.exe + cert imports
      Same JARs run on both OSes (verified by reading the JAR
      contents — bundles linux/x86_64/*.so AND win/x64/*.dll, dispatches
      on os.name). Only the install glue differs between OSes.
      See client-bootstrap/README.md.
  #12 EC2 deploy: Postgres, nginx + TLS, systemd, deploy.sh — PENDING.
      Needs a DNS name pointed at the EIP for Let's Encrypt + webcam.

Phase 5 — Multi-vendor fingerprint            [DONE 2026-05-15]
  #17 Startek / ACPL Capture API added as a second fingerprint vendor
      alongside Mantra MorFin. Both daemons run concurrently on Windows
      operator laptops; frontend polls both via the registry in
      frontend/src/lib/fingerprint/registry.js and binds to whichever
      vendor has a device plugged in. Schema column fp_vendor records
      which SDK matched (migration 4). Windows MSI added to install.ps1;
      Go-based startek-mock under backend/cmd/startek-mock provides
      dev-time parity with morfin-mock (port 8090, same /control surface).
      Linux operator laptops continue to use MorFin only until ACPL
      ships a Linux Capture API variant — vendor question outstanding.
      See STARTEK_INTEGRATION.md.

Phase 5b — Server-side fingerprint matcher   [DONE 2026-05-16]
  #18 fp-match-service: a Java/Javalin service wrapping SourceAFIS
      3.18.1 (Apache 2.0, pure Java). Runs server-side on EC2 (or in
      Docker on Mac for dev), parallel to luxand-service. Backend
      endpoint POST /api/fp-match accepts {roll_no, probe_b64,
      fp_vendor}, looks up the gallery via the candidate index, forwards
      probe+gallery to fp-match-service, returns the similarity score.
      Why: ACPL's L1 Capture API can only match templates captured in
      the same live session (verified empirically — gndu27 + stored
      Startek galleries both rejected with errorCode 104; see §"Hardware
      learnings" below). SourceAFIS accepts arbitrary FMR_V2005 / ANSI
      378 templates regardless of which SDK extracted them. Vendor-
      neutral by design: the same /api/fp-match could later route Mantra-
      captured probes if a deployment wants unified scoring.
      Verified end-to-end 2026-05-16 with real FM220U L1 hardware:
        - same finger, same gallery → score 373-571 (threshold 40)
        - different fingers (gndu27 candidate vs operator's finger)
          → score 0.02-5 (well below threshold)
      Default threshold 40 = SourceAFIS's documented 1-in-1000 FMR.

Phase 6 — Wallet + Razorpay billing            [DONE 2026-05-18]
  #19 Per-client wallet billing for candidate lookups.
      • Schema: migration 5 adds `wallets` (balance_paise INTEGER NOT NULL
        CHECK (balance_paise >= 0)) and `wallet_transactions` (signed
        amount_paise ledger). Unique partial index on
        razorpay_payment_id makes top-ups idempotent.
      • Charge middleware (internal/api/wallet_middleware.go) gates
        GET /api/candidates/{roll}: skips admin/superadmin, checks a
        5-minute same-roll cache, atomically debits via
        UPDATE … WHERE balance_paise >= ?, returns HTTP 402 if the
        wallet is empty. Response includes X-Wallet-Balance-Paise /
        X-Wallet-Charged-Paise headers on every successful charge.
      • Top-up flow uses Razorpay Checkout in test mode:
        POST /api/wallet/order creates a server-side Razorpay order,
        the browser drives the hosted Checkout via window.Razorpay,
        then POST /api/wallet/verify-payment HMAC-verifies the
        signature server-side and credits the wallet.
      • Admin manual credit: POST /api/admin/wallet/credit (admin or
        superadmin only) for offline top-ups + corrections.
      • Concurrent debit race-tested with 50 parallel goroutines:
        exactly N succeed when budget = N × fee. File-backed SQLite +
        WAL + busy_timeout makes the test deterministic.
      • Frontend: WalletWidget (prominent balance pill + Deposit
        button) in the navbar for client role only; LowBalanceModal
        opens on 402 and retries the failed lookup after a successful
        deposit. DepositModal offers presets (₹100/500/1000/5000) and
        loads checkout.js from the CDN on demand.
      • Default fee ₹5 / lookup (WALLET_FEE_PER_LOOKUP_PAISE=500).
        Switching to production = swap the two RAZORPAY_KEY_* env vars;
        same code path. KEY_SECRET stays server-side only.
      See WALLET.md.

Phase 6b — UI polish                             [DONE 2026-05-18]
  • Stripped navbar to wallet widget + clickable avatar circle with
    dropdown (Sign out). Removed NV logo + center name from the
    top bar — operators don't need a marketing reminder of where
    they work on every page.
  • Login pages reworked into a clean centered card on slate-50,
    per-role accent only on the role chip + primary button.
    No gradients, no orbs, no marketing copy.
  • Candidate-on-file card simplified to photo + roll number only;
    other metadata moved out of the operator's primary scan path.
  • Webcam unavailable → friendly message instead of "undefined is
    not an object" (mediaDevices is gated behind a secure context;
    LAN IPs over plain HTTP don't qualify).
  • Retake button: video element unmounts when the snap renders,
    so srcObject was lost on remount. streamRef + an effect that
    re-attaches the stream on snap → null fixes the blank preview.
```

### Multi-vendor fingerprint abstraction (added 2026-05-15)

The frontend layer that talks to fingerprint daemons was split into a
vendor-neutral registry so new vendors slot in cleanly:

```
frontend/src/lib/
├── morfin.js                     unchanged — Mantra MorFin client
└── fingerprint/
    ├── types.js                  Vendor enum + DefaultThresholds map
    ├── startek.js                ACPL Capture API client
    └── registry.js               pollConnected() — parallel probe + winner
```

`useDeviceStatus.js` and `FingerprintCapture.jsx` are now
vendor-agnostic: the hook returns `{vendor, name, info, threshold, client}`
on the active device; the component dispatches `client.match()` to the
right vendor. Output shape (`fpResult`) gains a `vendor` field that
flows into the audit row via `verifications.fp_vendor`.

**Probe order:** Mantra first (longer in production), Startek second.
If both have devices connected, Mantra wins. To flip, edit
`PROBE_ORDER` in `frontend/src/lib/fingerprint/registry.js`.

**Threshold scales differ per vendor.** MorFin default is 140 (the
constant `DEFAULT_MATCH_THRESHOLD` in the JAR's bytecode). Startek
default is 60 — a placeholder; real-world calibration needs ~20 captures
against known-match / known-non-match pairs once hardware is in hand.
Tunables live in `frontend/src/lib/fingerprint/types.js`.

**Linux operator laptops:** no Startek SDK from the vendor yet; the
Linux bundle continues to ship only MorFin. The `STARTEK_DIR` build
input in `client-bootstrap/windows/build-bundle.sh` is optional, so
build hosts without the SDK still produce a working bundle (just
without the Startek phase).

### What's still genuinely open

- **Luxand face 1:1** — third score channel; schema slot exists,
  webcam capture works, awaiting the Luxand SDK.
- **Server deploy (#12)** — see ISSUES.md §3.
- **Install model decision** — the bundle exists but who runs it
  (IT pre-image / per-laptop pre-flight / operator self-service) is
  still a tech-lead decision. See ISSUES.md §2.
- **Mantra vendor email** — six questions consolidated, not yet sent.
  See §4 of this document.

### Hardware-test learnings (recorded 2026-05-06, updated 2026-05-07)

**Marvis Auth SDK does NOT run natively on Windows from the Linux
package**, despite the JAR bundling `win/x64/*.dll` natives. Verified
on a Windows 11 laptop with the MIS100V2 device + Mantra's official
MYUSB driver installed; both our wrapper AND Mantra's own
`Marvis_Auth_Sample.jar` crash identically:

```
java.lang.NoSuchMethodError: CompleteCallback
    at com.mantra.marvisauth.NativeUtils.ExtractLibraryFromJar(NativeUtils.java:169)
    at com.mantra.marvisauth.MarvisAuthNative.<clinit>(MarvisAuthNative.java:570)
    at com.mantra.marvisauth.MarvisAuth.<init>(MarvisAuth.java:46)
```

Tested across Java 11 and Java 17, same failure. The native DLLs
inside the JAR fail JNI registration — Mantra shipped Windows binaries
whose JNI signatures don't match the Java classes in the same JAR.

**Resolution path (2026-05-07): WSL2 + usbipd-win workaround verified
working end-to-end.** Rather than wait on Mantra, `install.ps1`
provisions WSL2 Ubuntu on the Windows laptop, installs the iris `.deb`
inside it (which uses the working `linux/x86_64/*.so` natives in the
same JAR), and uses Microsoft's [`usbipd-win`](https://github.com/dorssel/usbipd-win)
to pass the MIS100V2 USB device through to WSL. The browser still
talks to `localhost:8031` because WSL2's NAT-mode forwarder bridges
Windows → WSL transparently — provided the JVM inside WSL binds to a
non-loopback address (we use `IRIS_BIND=0.0.0.0` via a systemd drop-in;
the WSL VM has no LAN-routed interface, so the security cost is zero).

End-to-end verified on Win10 19045 with real MIS100V2:

```
PS> curl.exe -X POST http://localhost:8031/iris/connecteddevicelist
{"ErrorCode":"0","ErrorDescription":"Found Devices: MIS100V2"}
```

This proves: Windows host curl → WSL2 NAT forwarder → Javalin →
MarvisIrisProvider (real SDK in marvis-strict mode) → JNI → Linux
`Marvis_Auth.so` → libusb → usbipd → physical iris device.

**Vendor email** still goes out to `servico@mantratec.com` because a
corrected Windows JAR would let us simplify the bundle (drop WSL2 +
usbipd, register the iris JAR via `nssm` like the MorFin daemon).
That's a future cleanup, not a blocker. Linux operator laptops are
unchanged; Windows operator laptops use the WSL2 path.

**Operational caveats discovered on first end-to-end test
(2026-05-07):**

- `vmIdleTimeout=-1` in `.wslconfig` isn't honored on Win10 19045 —
  the VM idles out after ~60s, taking the iris service + USB
  attachment with it. Need to investigate WSL version compatibility
  or use a large int (`2147483647`) instead of `-1`.
- `usbipd-win` scheduled task fires at Windows logon but doesn't
  re-fire when the WSL VM cycles. After a VM idle-out + re-launch,
  the device must be manually re-attached. Production fix: keep VM
  alive (above), or add a startup script in WSL that calls back to
  Windows via `wsl.exe`.
- First-call latency from cold WSL VM is ~5-10s (VM boot + JVM
  startup + Marvis SDK init); subsequent calls are <100ms forwarder
  + ~1-3s actual capture.

These are operational hardening items, not blockers — the
fundamental "Windows operator laptops can run iris hardware via the
WSL2 workaround" is proven. See `client-bootstrap/windows/README.md`
for the full operator-laptop architecture and remediation options.

---

## 7. Things explicitly *out of scope* right now

- 1:N (one-to-many) identification — too expensive at exam scale,
  and 1:1 with the roll number is what the workflow needs.
- Server-side fingerprint matching — captures stay on laptop.
- WebUSB — incompatible with vendor protocols.
- Mobile (Android/iOS operator) — the SDKs and devices target
  desktop OSes.
- Re-enrolment of candidates — gallery comes from the existing data
  tree; we read, never write enrollments.

---

## 8. Things to verify on the EC2 server before deploy

When Phase 3 starts, the server needs:
- Ubuntu version + Go runtime
- A DNS name pointed at the EIP (for TLS via Let's Encrypt)
- Postgres install + dedicated DB user
- nginx as TLS terminator + static frontend host
- systemd unit for the Go binary
- `/var/lib/neet-verification/artifacts/` for retention=full
- Backup story for the DB (cron-driven `pg_dump` to S3 or similar)

The server has not been touched yet — it's an empty Ubuntu box
(verified 2026-05-02 via SSH read-only inspection).

---

## 9. Glossary of vendor terms

- **MorFin** — Mantra's fingerprint SDK family
- **Marvis** — Mantra's iris SDK family
- **FMR** — Finger Minutiae Record (ISO/IEC 19794-2). Tiny binary
  template extracted from a fingerprint image.
- **FMC** — Finger Minutiae Card (ANSI INCITS 378). Sister format.
- **NFIQ** — NIST Fingerprint Image Quality, 1–5 (1 best).
- **K3 / K7** — Mantra-proprietary compact iris template formats.
- **MIS100V2** — Mantra's iris device model.
- **MELO041 / MFS500 / MARC10** — Mantra fingerprint device models.
- **MatchScore** — vendor-proprietary score returned by `match`/`verify`.
- **LiveNess_Result** — `-1` unknown, `0` spoof detected, `1` genuine.

---

## 10. Multi-tenant pivot (June 3-4, 2026)

The system was originally designed with per-operator user accounts.
Real-world customer feedback drove a rebuild to **org-level shared
operator credentials**, plus a series of changes that hang off that
decision. Schema migrations 008-012 ship the new model.

### 10.1 Wallet → org-level (migration 008)

`wallets.user_id` is gone. Now `wallets.org_id` is the primary key —
one balance per institution. `wallet_transactions` has `org_id` and
a new `actor_user_id` so the admin's dashboard can still attribute
each charge to the operator who triggered it (the operator who looked
up the candidate, the admin who initiated the Razorpay deposit, the
superadmin who issued an admin_credit).

The same-roll dedup window (default 5 min) now keys on `(org_id,
roll_no)` instead of `(user_id, roll_no)` — so if two operators in
the same exam centre look up the same candidate within 5 minutes,
only the first lookup is charged. This is desirable, not a bug.

Wallet management UI:
- **Admin only**: deposit via Razorpay, view balance, view paginated
  transaction history (cursor pagination via `?before=<id>`, 50/page)
- **Superadmin**: can credit any org's wallet manually via
  `POST /api/admin/wallet/credit { org_id, amount_paise }` — used for
  refunds, goodwill credits, ops support
- **Operator portal**: no wallet UI at all. On HTTP 402 (insufficient
  balance), operators see a banner saying "contact your admin"

### 10.2 Shared operator credential (migrations 009, 010)

One client-role user per org. Every operator machine signs in with
the SAME username/password. The admin sees and manages this single
credential.

- `users.password_plaintext` (migration 010) — only populated for
  shared-operator users so the admin's "Operator access" page can
  display the actual password. Admin-role and superadmin-role users
  still go through bcrypt-only. **This is a deliberate security
  trade-off**: a leaked admin session leaks the operator credential.
  Customer accepted this in exchange for no email-onboarding of
  individual operators.
- `users.email`, `users.disabled_at`, `users.activated_at` (migration
  009) added with an `(org_id, role)` composite index for admin's
  operator lookups.
- Shared operator is auto-created at registration approval in
  `superadminApproveApplication` (along with the org's `MAIN` centre).
  Returns `{operator_username, operator_password}` in the approval
  response so the superadmin can hand off to the institution head.

Admin actions on `/admin/operator-access`:
- View username + password (toggleable show/hide, copy-to-clipboard)
- `POST /api/admin/operator-access/reset-password` — auto-generate
  new 12-char password
- `POST /api/admin/operator-access/set-password { password }` —
  admin chooses a custom password (≥10 chars, letter + digit)
- Disable / enable (login refused with 403 + "account disabled"
  while disabled)

### 10.3 One centre per org (migration unchanged, logic only)

Customer requirement: each college is one centre. No multi-centre
management UI for admin. Approval handler auto-inserts one `centers`
row per approved org with `code='MAIN'` and `name = institution name`.
Operator creation server-side picks the org's lowest-id centre — no
centre dropdown in the UI.

### 10.4 Force password change (migration 011)

`users.password_change_required` flag. Set on the seeded `super` and
`ops` accounts every boot via idempotent seed step. Login response +
`/api/me` carry the flag. Frontend's `RequireRole` redirects to
`/<scope>/force-password-change` (scope-prefixed so the
path-scoped-storage AuthProvider finds the right session — see 10.6)
until the user rotates.

### 10.5 Audit log (migration 012)

`audit_log` table with `ON DELETE SET NULL` on user/org FKs so rows
outlive their referents. Write helpers in `internal/api/audit.go`:

- `s.audit(ctx, claims, action, ...)` — primary
- `s.auditFromRequest(r, action, ...)` — convenience
- `s.auditAnonymous(r, action, ...)` — for pre-auth events (login
  failures)

Write call-sites already wired: login.success, login.failure,
password.change, operator.password.set, operator.disable, operator.enable,
wallet.deposit, wallet.admin_credit, application.approve. Read endpoint
`GET /api/super/audit?action=<filter>&before=<id>&limit=N`. Best-effort
writes — failed audit never blocks the originating request.

### 10.6 Path-scoped session storage

`localStorage` keys are now namespaced by URL scope:
`nv_token_admin`, `nv_user_admin`, `nv_token_client`, `nv_user_client`,
`nv_token_superadmin`, `nv_user_superadmin`. `lib/authStorage.js`
derives the scope from `window.location.pathname`'s first segment.
`api.js` sends the token for the **current page's** scope. Result:
admin and operator can sign in side-by-side in different tabs on the
same browser without stomping each other's sessions.

Cross-tab `storage` event listener still in place — when a session is
rotated in another tab of the same scope, the current tab re-reads and
re-routes via RequireRole.

### 10.7 Verification history + CSV export

`/admin/history` page with roll/status/date filters + quick presets
(Today / Last 7 days / Last 30 days). Backend endpoints:

- `GET /api/admin/verifications?roll=&status=&from=&to=&before=<id>` —
  cursor-paginated JSON, 50/page max 200
- `GET /api/admin/verifications.csv` — streamed download, hard-capped
  at 100k rows (forces admin to narrow date range past that)

### 10.8 Misc UX fixes (June 4)

- `usePolling` hook (lib/usePolling.js) — pauses on `document.hidden`,
  fires fn immediately on identity change so tab/filter changes don't
  wait up to N seconds for the next poll. Applied to admin dashboard,
  superadmin dashboard, pending applications, wallet widget.
- Verification flow state persisted to `sessionStorage` per tab —
  refresh in the middle of a verification restores step/roll/captures.
- Idempotency key minted once at lookup, reused across all submit
  retries within the verification — browser-back + resubmit doesn't
  create duplicates.
- `LoginShell` accepts a `rememberKey` prop. Operator login uses
  `nv_last_client_username` to pre-fill the username on subsequent
  visits.
- Avatar dropdown has a Change-password modal — calls
  `POST /api/me/change-password { current_password, new_password }`.
  For shared-operator users, the plaintext column is synced too.
- 401 auto-logout via `api.js` `onUnauthorized()` — clears scoped
  storage, redirects to that scope's login with `?session_expired=1`,
  login pages show a clear banner.

---

## 11. Production hardening (June 4, 2026)

Pre-deploy security/correctness audit + fixes. All shipped.

### 11.1 Boot-time enforcement

- `JWT_SECRET` defaults to a public constant in dev. In prod (when
  `APP_ENV` is anything other than `""`/`"development"`/`"dev"`),
  `cmd/server/main.go` refuses to boot if the secret is still the dev
  default. Logs warning in dev so the misconfiguration is visible.
- `ALLOWED_ORIGINS` env (comma-separated) feeds CORS. Default still
  permits `localhost:5173`/`127.0.0.1:5173` for dev.
- `PUBLIC_BASE_URL` env feeds the magic-link URL builder. Falls back
  to `X-Forwarded-Proto`+`X-Forwarded-Host`, then `Origin`, then
  `r.Host`. Production should set this explicitly.

### 11.2 authMiddleware re-checks per request

JWT validity is no longer enough. Every authenticated request does a
single indexed PK lookup that rejects:
- Deleted user (`sql.ErrNoRows` → 401 "account no longer exists")
- `disabled_at IS NOT NULL` → 401 "account disabled"
- Role mismatch between JWT claim and current DB row → 401
  "session role mismatch"

Cost: ~1 ms per request. Eliminates the up-to-12-hour stale-session
window from JWT-only validation.

### 11.3 Approval race fix

Concurrent superadmin approvals of the same application used to both
pass the `status='pending'` check and create duplicate admin/operator
rows. Now: atomic `UPDATE institution_applications SET status='approved'
... WHERE id = ? AND status='pending'` BEFORE doing any other work.
0 rows affected → 409 conflict. Confirmed by 8-concurrent-VU test.

### 11.4 Verify-payment race recovery

`walletVerifyPayment` could 500 if two concurrent calls with the same
`razorpay_payment_id` both passed the `FindByRazorpayPaymentID` check
before either inserted. Now: on `Credit()` failing with a unique-
constraint error, re-fetch the existing transaction and return
`replayed=true` instead of erroring.

### 11.5 Wallet charge only on successful lookup

`walletCharge` middleware now uses a buffered response writer.
Inner handler runs against the buffer; debit fires only if the
inner status is 2xx. A 404 / "candidate not found" no longer leaves
an orphan charge. Pre-check (cheap balance read) still rejects
underfunded orgs with 402 before doing the lookup work.

### 11.6 Login + setpassword rate limiting + cleanup

`globalLoginLimiter` — 10 attempts per 15 min per public IP.
Loopback + RFC1918 private addresses exempt (preserves dev /
LAN-testing workflow). `StartLimiterCleanup` goroutine prunes expired
entries every 10 min — bounded memory under botnet floods.

### 11.7 Magic-link cleanup + /readyz

`startMagicLinkCleanup` goroutine runs hourly, deletes rows where
`used_at` is non-NULL and older than 30 days OR `used_at` is NULL and
`expires_at` more than 30 days past. `/api/readyz` pings the DB and
returns 503 if unreachable — orchestrator-friendly health check
distinct from `/api/health` (the latter is just "process alive").

### 11.8 Regression tests

`backend/internal/api/security_regression_test.go` has tests pinning
down each of the above. Especially:

- `TestAuthMiddleware_DisabledMidSessionRejected`
- `TestAuthMiddleware_DeletedUserRejected`
- `TestAuthMiddleware_RoleChangeForcesReLogin`
- `TestApprovalRace_OnlyOneSucceeds` (8 concurrent goroutines)
- `TestWalletCharge_FailedLookupDoesNotDebit`
- `TestWalletCharge_EmptyWalletRejected`
- `TestLoginRateLimit_BlocksAfterThreshold`
- `TestReadyz_DBHealthy`

All passing as of 2026-06-04.

---

## 12. Mantra fingerprint daemon — actual API contract (June 9-10, 2026)

**This is the most important June discovery.** What `frontend/src/lib/
verify/morfin.js` was written against does NOT match what the real
MorFin daemon JAR
(`morfinauth-client-service-1.0.0.0.jar` — extracted from
`MorfinAuth_Linux_Web_SDK_1.0.0.0`) actually exposes. We verified end-
to-end on real hardware (Windows 10 19045, MFS500 + MARC10) by reading
the JAR's bytecode and the daemon's runtime startup hints.

### 12.1 Routes (definitive — from `MorfinAuthClientService.class` const pool)

```
/morfinauth/supporteddevicelist
/morfinauth/connecteddevicelist
/morfinauth/checkdevice         ← real init (sets isDeviceInit flag)
/morfinauth/info
/morfinauth/capture
/morfinauth/getimage
/morfinauth/gettemplate
/morfinauth/verify              ← 1:1 template-vs-template match
/morfinauth/match               ← capture-from-device + match (combo)
/morfinauth/uninitdevice
```

**There is NO `/morfinauth/initdevice`.** Calling it returns
`{ErrorCode: 404, ErrorDescription: "Unknown", LiveNess_Result: 0}` —
the daemon's generic "unknown route" envelope. The original
`morfin.js` was written assuming this endpoint existed. **Init is
implicit via `/checkdevice`** — that's the call that flips the
internal `isDeviceInit` boolean field.

### 12.2 Request body field names (definitive — from bytecode)

The daemon parses bodies via `JsonObject.get("FieldName").getAsString()`
— **all fields are STRINGS**, even numeric-looking ones. The
`CaptureRequest`/`InfoRequest` POJOs in `models/` are dead code from a
different build; the runtime parser uses literal `JsonObject.get` keys
on the field names below.

| Route | Required body fields |
|---|---|
| `/checkdevice` | `ConnectedDvc` (string, e.g. `"MFS500"`) |
| `/info` | `ConnectedDvc` (string), `ClientKey` (string, may be `""`) |
| `/capture` | `Quality` (string), `TimeOut` (string) |
| `/gettemplate` | `TmpFormat` (string `"0"`=FMR_V2005, `"1"`=FMR_V2011, `"2"`=ANSI_V378) |
| `/verify` | `ProbTemplate`, `GalleryTemplate` (both base64 strings), `TmpFormat` |
| `/match` | `Quality`, `TimeOut`, `GalleryTemplate`, `TmpFormat` (all strings) |

Numeric JSON values for `Quality` / `TimeOut` cause **400 "Quality is
missing in request body"** because `getAsString()` returns null on
primitive numbers in Gson.

### 12.3 Response envelope quirks

- `ErrorCode` comes back **inconsistently typed**: JSON string `"0"`
  for some endpoints, JSON number `0` for others. Frontend normalizes:
  `String(env.ErrorCode) === '0'` is success.
- `BitmapData` is the captured-image field on `/capture` + `/match`.
- `ImgData` (not `Template`!) is the base64 template returned by
  `/gettemplate`.
- `Quality` (int), `Nfiq` (int), `LiveNess_Result` (int -1/0/1) are
  standard across capture-bearing endpoints.
- `/match` returns `Status` (bool), `MatchScore` (int), plus all
  capture fields.

### 12.4 Frontend patches that landed

`frontend/src/lib/verify/morfin.js` in its current form on disk
reflects all of the above. The `init()` method calls `/checkdevice`;
all request fields are coerced to strings; the error check accepts
both `"0"` and `0`.

### 12.5 Operator-laptop installer (Windows)

Bundle: `client-bootstrap/windows/dist/VerificationPortalClient-1.0.0-
windows.zip` — 222 MB. Includes:

- `morfin/morfinauth-client-service-1.0.0.0.jar` — the daemon
- `morfin/MorFinDriver_1.4.1.1.exe` — USB driver (vendor-provided
  installer, run by Phase 4 of `install.ps1`)
- `morfin/certs/*.crt` — 3 vendor TLS certs for the daemon's HTTPS
- `tools/nssm.exe` — service registrar
- `install.ps1` — orchestrates: cert import → driver install →
  nssm-register `MorfinAuthClientService` (uses
  `nssm set AppParameters` separately to handle install-root paths
  with spaces; older quoting approach was broken)
- `iris-wsl/` + `startek/` — irrelevant for fingerprint-only test;
  installer supports `-SkipIris -SkipStartek`

**Verified working 2026-06-09/10** with Java 17 (JRE 17 on PATH),
Windows 10 build 19045, both MFS500 and MARC10 devices, end-to-end
flow including 1:1 match against a planted template (we wrote the
user's actual finger as `gndu27/.../iso/10001.iso` and the operator
portal matched it correctly via the local Mantra path).

`10001.iso.original` is the backup of the seeded demo template — if
you ever want to restore the demo data, copy that back over `10001.iso`.

### 12.6 Things that AREN'T blockers but should be cleaned up

- The vendor's `/info` returns a sensible-looking `DeviceInfo`
  sub-object — but we haven't confirmed the field names for serial /
  firmware match what `FingerprintCapture.jsx` reads (`SerialNo`,
  `Model`, `Firmware`). On a real device these should be inspected to
  make sure the banner doesn't show "undefined" for one of them.
- `models/*.class` POJOs are dead code (the runtime parser doesn't use
  them). Not worth touching but if a future agent gets confused by
  them, they're a red herring.
- Mantra's iris SDK is still on the WSL2 workaround for the same JNI
  bug discussed in `IRIS_VENDOR_ISSUE.md`. Fingerprint working
  natively on Windows doesn't change iris. We may drop iris entirely;
  see section 16.

---

## 13. PLANNED: Switch Mantra to server-side matching

**Agreed 2026-06-10. Not implemented yet.** This is the next concrete
piece of work when the next agent picks up.

### 13.1 Motivation

Currently Mantra runs capture+match locally on the operator laptop via
`/morfinauth/match`. Switching to server-side (same path as Startek):

- **Consistency**: Both vendors land into the same SourceAFIS-scored
  audit row. Comparable thresholds, comparable false-match rates,
  comparable forensics.
- **Algorithm transparency**: Mantra's MatchScore is a black box; we
  can't reproduce a match later from stored templates. SourceAFIS is
  open and re-runnable.
- **Threshold flexibility**: Change `FP_MATCH_THRESHOLD` once on the
  backend; no per-laptop redeploy.
- **Operationally one code path** in the frontend instead of vendor-
  branching on every match decision.

The often-cited CPU win on operator laptops is real but tiny — the
match itself is ~50 ms of CPU. The chronic load on the laptop is the
JVM daemon (~250-350 MB resident) which doesn't go away.

### 13.2 Implementation sketch

1. **Frontend** (`frontend/src/lib/verify/morfin.js`): change `match()`
   to a two-step:
   - Call `/morfinauth/capture` locally to capture
   - Call `/morfinauth/gettemplate {TmpFormat:"0"}` to extract the
     probe FMR template
   - POST `{roll_no, probe_b64, fp_vendor:"mantra"}` to backend's
     `/api/fp-match` (same as Startek today)
   - Frontend response shape adapter: keep returning the same
     `{ok, score, threshold, bitmapBase64, ...}` shape to
     `FingerprintCapture.jsx`, just with the score coming from
     SourceAFIS instead of MorFin's `MatchScore`.

2. **Backend** (`backend/internal/api/verify_fp_handlers.go`): the
   existing `/api/fp-match` handler already accepts `fp_vendor` as a
   tag — should already work for Mantra without code change. Verify
   that `fp-match-service` accepts the Mantra-extracted FMR_V2005
   template the same way it accepts Startek's (both are FMR_V2005
   per spec, but vendor implementation quirks possible).

3. **DefaultThresholds** in `frontend/src/lib/verify/fingerprint/
   types.js`: Mantra's threshold drops from 140 (Mantra scale) to 40
   (SourceAFIS scale). Same as Startek.

4. **Tests**: an existing test in `frontend/src/lib/verify/` family
   that simulates a successful Startek match should be adaptable for
   Mantra by swapping the vendor tag.

### 13.3 Risk / caveats

- The bitmap preview shown in the UI comes from `/capture`'s
  `BitmapData`. That path is unchanged. Capture quality / NFIQ /
  liveness fields still come from the local daemon; only the score
  source moves.
- Slight latency tax — local match is ~150 ms total, server-side will
  be ~400-500 ms. Operators won't perceive a difference.
- `fp-match-service` becomes the hot path for every match at scale.
  At 5000 concurrent operators × 1 match/min, that's ~83 matches/sec
  — about 2 SourceAFIS instances behind a load balancer. Plan for it
  in capacity, but it's not a launch blocker.
- The daemon's vendor MatchScore stops landing in the audit row.
  `verifications.fp_match_score` becomes a SourceAFIS score for both
  vendors. Any historical data already there stays as-is; queries
  filtering on `fp_vendor` will get apples-to-oranges scores across
  the cutover point. Document in the release notes.

### 13.4 Test plan after implementation

1. Same `10001.iso` planted-template test we already did for the
   local path. Capture self-match → expect SourceAFIS score in the
   300-500 range, well above threshold 40.
2. Different-finger test → expect score 0-30, well below.
3. Confirm `verifications.fp_vendor='mantra'` and
   `verifications.fp_match_score` carries a SourceAFIS-scale value
   (not a Mantra-scale value) on the audit row.
4. Confirm Startek still works unchanged.

---

## 14. PENDING: Luxand cloud face-match API

User mentioned they will provide an API later that wraps Luxand with
pre-tuned 1:1 matching + liveness, eliminating the need for the
licensed Luxand SDK + the in-process `luxand-service` we run today.

When the API spec lands:

- Swap point: `backend/internal/luxand/client.go`
- Likely just changes `LUXAND_BASE` env var to the new URL + minor
  request/response shape mapping
- Lets us delete the `luxand-service/` Docker container + the Luxand
  license-key handling

Deferred until the user has the API endpoint, auth model, and
request/response docs.

---

## 15. PENDING: Postgres migration

Plan documented in chat (2026-06-04). Not started.

- 12 migration files to rewrite for Postgres dialect (AUTOINCREMENT
  → IDENTITY, INSERT OR IGNORE → ON CONFLICT, drop migration 7's
  PRAGMA gymnastics in favour of a clean ALTER TABLE)
- Add `pgx` driver
- Add `DATABASE_URL` env
- ~2-3 days of focused work
- Recommended: dual-driver (env-var selects SQLite or Postgres) so
  local dev keeps SQLite, prod uses Postgres. Tests run both via CI
  matrix.

Trigger: any of multi-instance deployment, hitting ~50 concurrent
users, signed customer requiring backup SLA, or analytics replicas.
Single-instance SQLite is genuinely fine until then.

---

## 16. PENDING: Iris cleanup (and possibly removal)

Status quo (per `IRIS_VENDOR_ISSUE.md`): Mantra's iris (Marvis) SDK's
Windows DLL is broken at the vendor level. We ship via WSL2 + usbipd-
win, which is working but adds ~700 MB to the bundle, requires a
reboot during install, and has operational sharp edges (WSL idle
sleep, USB reattach on VM cycle).

User has signalled (2026-06-04) that **iris is being deprioritized**
because of the operational complexity. Options:

- **Option A** — wait for Mantra to ship a corrected Windows JAR.
  Vendor email outstanding since May 2025; no response in over a
  year. Don't bank on it.
- **Option B** — cloud iris API (analogous to the Luxand swap in
  section 14). Removes the WSL stack entirely. Best technical answer
  if a vendor is available.
- **Option C** — drop iris fallback entirely. If real production data
  shows fingerprint match rate >95%, the iris-as-fallback complexity
  isn't earning its keep.

If Option C is chosen, deletions:
- `iris-service/` Java service
- `backend/cmd/iris-mock/`
- `frontend/src/components/verify/IrisCapture.jsx` + the iris flow in
  `pages/client/Dashboard.jsx`
- `frontend/src/lib/verify/iris.js`
- `client-bootstrap/windows/wsl-iris-setup.sh`
- WSL2 phases of `client-bootstrap/windows/install.ps1`
- Iris-related DB columns can stay (NULL for new rows); no breaking
  schema change

Saves ~700 MB bundle weight, ~290 lines of install.ps1, the WSL
operational caveats, and a whole class of future Mantra-iris-DLL
escalations. Worth doing if iris usage in real production stays low.

---

## 17. Load-testing setup notes (June 5, 2026)

k6 binary downloaded to `/tmp/k6/k6-v0.50.0-macos-arm64/k6`. Test
script at `/tmp/k6/portal-loadtest.js` — three-tier (10 / 100 / 500
VUs over 2.5 min). Sample run: ~1000 RPS sustained against local
SQLite, p95 ~11 ms successful-response, p99 ~34 ms. Confirms the
backend Go layer is not the bottleneck at single-instance scale; the
limit will be SQLite write contention at burst.

When re-running:

1. Stop the live backend on :8080
2. `cp backend/verification.db backend/verification-loadtest.db` so
   the real DB isn't polluted with synthetic verifications
3. Start backend with `DB_PATH=verification-loadtest.db
   WALLET_SAME_ROLL_CACHE_MIN=0 go run ./cmd/server`
4. Top up demo org wallet to ~₹10 cr via direct SQL (otherwise the
   wallet drains at ~₹5 × 1000 rps = ~₹3 lakh/min and the test starts
   getting 402s mid-run)
5. Run `/tmp/k6/k6-v0.50.0-macos-arm64/k6 run /tmp/k6/portal-loadtest.js`
6. After: kill the test backend, delete the copy, restart normal one

---

## 18. State on disk as of 2026-06-10 (for the next agent)

Local development environment:

- Mac: `172.16.62.147` on LAN (matters for the Windows-laptop hardware
  test below)
- Backend: `go run ./cmd/server` from `backend/` with `.env` sourced
  (SMTP via Gmail App Password, Razorpay test keys, etc.)
- Frontend: `npm run dev -- --host 0.0.0.0` to be LAN-reachable
- `verification.db` is the dev SQLite at `backend/verification.db`.
- `10001.iso` in `~/Downloads/portal/gndu27/22 Mar'26/101__.../iso/`
  is currently the user's actual fingerprint template (planted for the
  match test). `10001.iso.original` is the original demo. Swap if you
  need a clean demo.
- Active admin demo password is `admin12345` (rotated during testing
  from `admin123`). Shared operator password `client123A` (rotated
  during testing from `client123` because the new validator requires
  10+ chars with letter + digit). Use the admin's "Operator access"
  page to view/rotate further.

Windows operator-laptop test machine:

- `MorfinAuthClientService` registered via nssm at
  `C:\VerificationPortal\` (not Program Files — install was run with
  `-InstallRoot C:\VerificationPortal` to dodge the spaces-in-path
  bug; the install.ps1 in the rebundled zip fixes this so the
  workaround isn't required anymore)
- Driver `MorFinDriver_1.4.1.1` installed natively
- MFS500 + MARC10 both verified working end-to-end

---

## 19. Glossary additions

- **RD Service** — UIDAI-certified background daemon for Aadhaar
  Registered Devices. Mantra's MorFin daemon JAR plays the SDK-client
  role; for fingerprint deployment our daemon is sufficient (verified
  June 2026). Iris devices may need a separate Mantra RD service
  binary that wasn't on the public downloads page when we looked —
  outstanding question for vendor.
- **fp-match-service** — our Java/SourceAFIS service at
  `127.0.0.1:8050`. Today handles Startek matches; planned to handle
  Mantra too (section 13).
- **luxand-service** — our Java/Luxand container for server-side face
  matching. Planned to be replaced by a cloud API (section 14).
- **shared operator credential** — one client-role login per org,
  see section 10.2. Password viewable in admin's "Operator access".
- **APP_ENV** — controls strict-mode boot checks. Set to `production`
  in prod; refuse-to-boot if `JWT_SECRET` is the dev default.
- **DOWNLOADS_DIR** — server-side path holding the operator-install
  artefact streamed by `/api/admin/downloads`. Default `./downloads/`
  in dev (symlinked to the existing zip), prod sets it to an absolute
  path like `/opt/portal/downloads`. See section 20.

---

## 20. Admin Downloads page (June 10, 2026)

Status: **DONE** Phase 1; **PENDING** Phase 2.

The college admin needs a one-stop way to get the operator-laptop
install bundle once their org is approved. Before today there was no
way — the zip sat in the repo at `client-bootstrap/windows/dist/` and
got shared by hand. Now there's a Downloads tab in the admin portal.

### Phase 1 (today, shipped)

The admin Downloads page lives at `/admin/downloads`, gated on
`role=admin`. UI shows: filename, version (parsed from filename),
size, SHA256 (copyable), the SmartScreen "what to expect" callout
(see section 20.5), and a collapsible install guide. The big button
streams the artefact with a live progress bar + cancel.

**Backend:**
- `backend/internal/api/download_handlers.go` — `findOperatorClient()`
  scans DOWNLOADS_DIR with a preference order (`.exe` > `.msi` > `.zip`,
  newest mtime within tier). Manifest endpoint is the cheap one
  (cached SHA256 keyed on path/mtime/size). Download endpoint uses
  `http.ServeContent` so Range requests / If-Modified-Since / ETag
  Just Work — flaky-network resumability for free.
- Mounted in `server.go` next to operator-access routes.
- Audit: `downloads.operator_client.get` action with filename/size/sha256
  metadata. Range resumes (`bytes=N-` where N>0) are NOT audited so a
  paused-and-resumed transfer registers as ONE admin intent, not N
  chunks. Range starting at 0 OR no-Range full GET DOES audit.
- 7 unit tests in `download_handlers_test.go` cover: empty dir, no
  bundle = 404, manifest happy path, full-GET audit count = 1, Range
  resume audit count = 0, cross-org last_download isolation, and a
  table-driven `parseVersionFromFilename` test.

**Frontend:**
- New `frontend/src/lib/admin/downloads.js` — hand-rolled fetch + reader
  + blob + anchor click pipeline. Not via shared `api()` because the
  response is a 200+ MB binary, not JSON. Takes `{ signal, onProgress }`
  so the page can show a progress bar and cancel mid-download.
- New `frontend/src/pages/admin/Downloads.jsx` — page + progress
  bar + speed/ETA estimator + SmartScreen callout + collapsible
  install guide.
- `AdminTabs.jsx`: added Downloads tab.
- `App.jsx`: registered `/admin/downloads` route, gated `admin`-only.

**Config:**
- `DOWNLOADS_DIR` env var, default `./downloads/`. Added to
  `backend/internal/config/config.go`. `.gitignore` excludes
  `backend/downloads/`, `/downloads/`, `**/downloads/` so the 200 MB
  artefact never gets committed. Dev symlinks the existing bundle
  into `backend/downloads/`.

**Verification:**
- All backend tests (`go test ./...`) green.
- E2E curl tests confirmed: 401 for unauth, 403 for wrong role
  (client), 200 + Content-Disposition: attachment + X-SHA256 header +
  Accept-Ranges: bytes for valid admin GET, 206 for Range requests,
  416 for out-of-bounds Range, 404 for empty downloads dir,
  audit_log rows populated correctly, last_download populated after
  download.
- `vite build` green.

### Phase 2 (pending, ~4–5 days work)

Replace the 222 MB zip with a single signed `OperatorPortalSetup.exe`
built via **Inno Setup**. The page does not need any changes — drop
the `.exe` into `DOWNLOADS_DIR` next to (or replacing) the zip and
the selection rule picks the `.exe` automatically.

Plan:
1. Inno Setup script (`.iss`) embeds: `MorFinDriver_1.4.1.1.exe`,
   `morfinauth-client-service.jar`, `nssm.exe`, 3 cert files, Startek
   MSI (optional component), browser homepage registry tweaks,
   Desktop shortcut. Iris is DROPPED from the default installer —
   per section 16, most colleges don't need it and the WSL2 reboot
   breaks the "one double-click" promise. Iris ships as a separate
   `OperatorPortalIrisAddon-.exe` for the rare site that needs it.
2. Optionally translate `install.ps1` step-by-step into Inno Setup's
   Pascal scripting (cleaner) OR shell out to a bundled `install.ps1`
   (faster to wrap; we already know it works).
3. Code signing: **deliberately skipped** for Phase 2 per user choice
   2026-06-10. Operators will see Windows SmartScreen "Unknown
   publisher" warning. The Downloads page already explains the
   3-click dismissal. Re-evaluate signing (~₹15k/yr Authenticode)
   after the first 10+ colleges or when SmartScreen blocks a real
   deployment.
4. Heartbeat ping at install completion → admin sees ✓ in their
   portal that the operator laptop came online.

### 20.5 The SmartScreen UX bet

Unsigned installers get blocked by SmartScreen with a scary blue
"Windows protected your PC" warning. Three clicks dismiss it:
**More info → Run anyway → Yes** to UAC. The Downloads page surfaces
this prominently with a yellow callout so college admins can warn
their operators ahead of time. Rationale: ₹15k/yr signing cert isn't
worth it until volume justifies it, and Indian operators are slightly
more tolerant of these warnings than US/EU ones. If field reports
show the warning actually blocking deployments, buy the cert.

### 20.5.5 Bundled JRE (June 10 — eliminates the #1 install failure mode)

The original 222 MB bundle expected operators to install Adoptium
Temurin JRE 17 themselves and add it to PATH. Field-testing showed
this was the most common install failure: operators either skipped
the "Add to PATH" checkbox or didn't reopen PowerShell after the
Java install. install.ps1 then failed with "Java not found on PATH"
and the operator gave up.

Fix: **bundle the JRE inside our zip**. The bundle now embeds a
private Adoptium Temurin JRE 17 under `morfin/jre/`, copied to
`C:\Program Files\VerificationPortal\morfin\jre\` at install time.
`install.ps1` calls `Resolve-BundledJava` (replaces the old
`Require-Java`) which returns the absolute path to the bundled
`java.exe`. `nssm install MorfinAuthClientService` registers the
service with that exact binary — no dependency on system PATH, no
risk of conflict with whatever Java the operator may already have.

**Cost**: bundle grew 222 MB → 264 MB compressed (42 MB JRE) /
350 MB extracted (130 MB JRE on disk under `Program Files\`).

**Operator-laptop net change**: PRE-install dependencies dropped from
"Windows 10 19041+ AND Adoptium JRE 17 AND PATH configured AND
PowerShell restarted" to just "Windows 10 19041+". The bundled-Java
fallback path in `Resolve-BundledJava` still finds a system Java if
the bundle has been hand-trimmed; nobody is forced into the bundled
path, but everyone defaults to it.

**Build pipeline**: `build-bundle.sh` now downloads the JRE from
Adoptium's release API (`api.adoptium.net/v3/binary/latest/17/ga/
windows/x64/jre/hotspot/normal/eclipse`) on first build, caches it
in `client-bootstrap/windows/.cache/`, and unpacks into the staging
dir on every build. `.gitignore` excludes both the cache and the
unpacked tree.

### 20.6 Memory budget

The download path holds the full 222 MB in a `Uint8Array` while the
chunks accumulate, then `new Blob([...])` to trigger the save. Fine
on any modern admin laptop (peak ~500 MB JS heap). If artefacts ever
exceed ~1 GB we'd switch to streamSaver.js which writes directly to
disk via a service worker — but we are nowhere near that threshold.

---

## 21. Payment security hardening — PR-1 (June 10, 2026)

Status: **DONE**.

Audit of the payment code found one exploitable vulnerability and two
must-fix-before-live gaps. All three fixed in a single PR.

### 21.1 CRITICAL — client-controlled deposit amount

**Bug**: `walletVerifyPayment` credited `req.AmountPaise` (from the browser)
after HMAC verification. But the Razorpay HMAC covers `(order_id|payment_id)`
only, NOT the amount. Attacker paid ₹1, called verify with `amount_paise=5000000`,
wallet credited ₹50,000. Full exploit takes 3 lines of DevTools JS.

**Fix**: new migration `013_razorpay_orders` adds a `razorpay_orders` table.
`walletOrder` inserts a row with the canonical amount at order-creation time.
`walletVerifyPayment` looks the order up by ID and credits `stored.AmountPaise`,
ignoring the browser's claim. Also validates `order.OrgID == claims.OrgID`
(prevents cross-org replay of a leaked triple).

Files: `backend/internal/db/migration_013_razorpay_orders.go`,
`backend/internal/wallet/orders.go` (new), edits to `wallet_handlers.go`.

### 21.2 CRITICAL — no webhook (orphaned payments)

**Bug**: only path to credit wallet was the browser-side `verify-payment` POST.
Browser closes mid-redirect → money leaves card, wallet stays at 0.

**Fix**: `POST /api/razorpay/webhook` — PUBLIC route (Razorpay can't carry
JWTs), HMAC-authed via body signature. Handles `payment.captured` idempotently
using the existing UNIQUE INDEX on `razorpay_payment_id`. Config:
`RAZORPAY_WEBHOOK_SECRET` env var (default empty → endpoint returns 503).

Files: `backend/internal/api/razorpay_webhook.go` (new),
`backend/internal/razorpay/razorpay.go` (added `VerifyWebhookSignature`).

### 21.3 HIGH — "Test mode" hint visible in production

**Bug**: DepositModal always rendered "use test card 4111...". Would show
after live-key swap.

**Fix**: added `razorpay_test_mode` field to `/api/wallet/config` response,
derived from `strings.HasPrefix(KeyID, "rzp_test_")`. Modal gates the hint
behind this flag.

### 21.4 Test coverage

9 new tests in `wallet_handlers_test.go` cover:
- stored-amount used vs claimed-amount ignored
- forged order_id rejected (400)
- cross-org replay rejected (403)
- webhook payment.captured credits wallet
- webhook bad signature → 401
- webhook missing secret → 503
- browser + webhook idempotency (either can fire first)
- test-mode flag flips with key prefix

All backend tests green. Frontend build clean.

---

## 22. Payment rate limiting — PR-2 #1 (June 10, 2026)

Status: **DONE**. Other PR-2 items (refund endpoint, CSV export,
receipts) explicitly deferred by user.

Added `globalWalletWriteLimiter` (15 requests / 5 min per user_id) shared
across `walletOrder`, `walletVerifyPayment`, `adminWalletCredit`. Reuses
the existing `registerLimiter` sliding-window struct from
`onboarding_register_handlers.go`. Keyed by `user_id` (not IP) so a
college's operators behind one NAT aren't collectively throttled. Loopback
+ RFC1918 IPs exempt via existing `shouldRateLimit`.

Files: `backend/internal/api/wallet_rate_limit.go` (new), edits to three
handlers, `StartLimiterCleanup` now prunes the new limiter too.

4 tests cover: 16th request → 429, shared budget across endpoints,
per-user isolation, loopback exempt.

---

## 23. Operator install robustness — the big install.ps1 audit (June 11, 2026)

Status: **DONE**. Two full days of Windows install debugging + code hardening.

### 23.1 The three root causes we hit

1. **Mantra's NSIS installer ignores `/S` silent flag** on Windows 10/11.
   `install.ps1` fired it, checked exit code (0), assumed success. Driver
   never landed. Operator saw ErrorCode 2027 hours later when trying
   fingerprint capture and thought the whole install was broken.

2. **Windows doesn't re-bind drivers to already-plugged devices.** If
   MFS500 was plugged in when `install.ps1` ran, Windows never re-evaluated
   drivers after they were installed. Manual unplug + replug required —
   which operators don't know about.

3. **PowerShell 5.1 + nssm CLI mangles quoted arguments containing spaces.**
   `nssm set AppParameters "-jar `"C:\Program Files\...`""` stored
   `-jar C:\Program Files\...` (no quotes). CreateProcess tokenized at
   the space → java got `-jar C:\Program` → "Unable to access jarfile"
   → service crashed → nssm restart-throttled → Status=Paused.
   Tried `--%` stop-parsing, backslash-escaping — nothing worked because
   Windows argv tokenizer strips quotes before nssm ever sees them.

### 23.2 The three fixes in install.ps1

1. **`Test-MorfinDriverInstalled`** — fast `pnputil /enum-drivers` grep.
   If silent install didn't take, we launch the vendor installer
   interactively (`-Verb RunAs`) and re-verify. Throws with a clear
   error if even interactive install failed.

2. **`Invoke-PnpRebind`** — `Disable-PnpDevice` + `Enable-PnpDevice` on
   any USB\VID_2C0F* device currently plugged in. Windows treats this
   as a plug event and re-evaluates driver binding. Zero manual replug
   needed. Filter is intentionally narrow (Mantra VID only) so we don't
   disturb other peripherals.

3. **Registry write instead of `nssm set`.** After `nssm install` creates
   the service skeleton, we directly write `Application`, `AppParameters`,
   `AppDirectory` via `Set-ItemProperty` to
   `HKLM:\SYSTEM\CurrentControlSet\Services\<svc>\Parameters`. PowerShell
   single-quoted strings preserve the inner `"` characters literally.
   nssm reads the registry on service start, hands the properly-quoted
   string to CreateProcess, Windows tokenizes correctly, service runs.
   Post-install verify reads back the stored value and throws if quotes
   are missing.

Also added post-install `Get-Service` status check that throws if service
didn't reach Running (was Paused before).

### 23.3 install.ps1 code-quality audit — 15 latent bugs closed

Python-based scan of `install.ps1` for:

- **220 non-ASCII characters** (em-dashes, box-drawing chars, BOM) → all
  replaced with ASCII. Mojibake under PS 5.1's Windows-1252 codepage was
  breaking string parsing on some machines.
- **4 `$var:` drive-reference ambiguities** (like `"$InstallRoot: $_"`) →
  all wrapped as `${var}:`. Distinguishes from PS scope refs (`$env:`,
  `$script:` preserved correctly).
- **12 brittle stderr redirects** (`2>&1 | Out-Null` and `2>$null | Out-Null`)
  → converted to `*>$null` (redirect-all-streams). Under EAP=Stop, native
  command stderr can trip NativeCommandError even when redirected. `*>$null`
  is bulletproof.

Same cleanup applied to `uninstall.ps1`.

### 23.4 uninstall.ps1 created

Full removal script. Idempotent, EAP=Continue (best-effort cleanup),
9 phases: service, install dir, browser policies, shortcuts, tasks, certs
(with `-RemoveCerts` flag), MorFin driver (with `-RemoveDriver`), Startek
(with `-RemoveStartek`), WSL iris (with `-RemoveWsl`). Uses `pnputil
/delete-driver /uninstall /force` for driver removal.

Path: `client-bootstrap/windows/uninstall.ps1`. Also served via Vite at
`http://<mac>:5173/uninstall.ps1` for one-line curl+run testing.

### 23.5 Bundle SHA history (last 24h of iteration)

Each row = a re-zip after a fix landed. Backend `Downloads` manifest
auto-updates on the file-mtime cache invalidation:

| SHA | What changed |
|---|---|
| `4af1c510` | initial after install.ps1 + registry fix + rebind |
| `585a4445` | added SmartScreen guidance to README |
| `a77ce16e` | uninstall.ps1 EAP=Continue + `*>$null` |
| `a8808da9` | README em-dash cleanup |

Current bundle: SHA depends on latest re-zip. Check `/api/downloads`
manifest for authoritative value.

---

## 24. Face-match tuning + Luxand cloud API evaluation (June 11 → July 2)

### 24.1 Threshold tuned 0.99 → 0.95 (June 11)

Local `luxand-service` used FAR=0.01 → threshold 0.99 by default. Too
strict for real webcam variance (lighting, glasses, angle) — real matches
landed at 0.92-0.97 and failed. Tuned FAR=0.05 → threshold 0.95 via
`.env`. Required `docker compose down` + `up` (compose `restart` doesn't
re-read env).

Trade-off: FAR 0.05 = 1-in-20 false-match rate at algorithm level. For
NEET/exam-fraud, 0.95 is the industry sweet spot. Well-known reference
tables:

| FAR | Threshold |
|---|---|
| 0.0001 | 0.9999 |
| 0.001  | 0.999  |
| 0.01   | 0.99   |
| 0.05   | 0.95   ← current |
| 0.10   | 0.90   |

### 24.2 Luxand cloud API evaluated — plan drafted, NOT executed

User shared a cloud face-match endpoint:
`https://reports.uptet.upessc.org/liveness/api/v1/face/match`
(FastAPI/nginx on AWS Mumbai, HTTPS TLS 1.3, valid Let's Encrypt cert).

Endpoint contract: multipart/form-data with `image1` + `image2` files,
returns `{is_same_person, similarity, similarity_percent, error}`.
Threshold hardcoded server-side at 0.75. **No authentication** — user
explicitly opted out.

Migration plan captured (see prior conversation): rewrite
`backend/internal/luxand/client.go` from JSON+base64 to multipart HTTPS,
delete `luxand-service/` Docker container + `backend/face_templates/`
cache, ~4 hours of work. Frontend zero changes. Threshold moves
client-side to `FACE_MATCH_THRESHOLD` env (keep 0.95).

**Not executed yet.** Next agent: user needs to green-light before
starting. Plan is in the prior conversation transcript, not in the
codebase yet.

---

## 25. Institution registration UI redesign — Step 1 only (June 11, 2026)

**PARTIAL** — Step 1 (Institution details) restyled to new sidebar
layout with dense 6-column form. Steps 2 & 3 still on old card layout.
Deliberate — user wanted to see Step 1 first before committing to the
rest.

Files: `frontend/src/pages/register/Register.jsx`. New components:
`StepSidebar` (vertical step nav, left rail, 260px), `CompactChoice`
(button picker), `Divider` (labelled). Old horizontal `Stepper`
component deleted.

To finish: Step 1 pattern needs applying to Step 2 (Address + Head)
and Step 2 (Documents). ~1-2 hours per step.

---

## 26. Razorpay live-mode preparation (July 2, 2026)

Status: **PREPPED, awaiting user's live keys**.

User asked to switch to real Razorpay keys and drop wallet fee ₹5 → ₹1.

Done by me:
- Changed `.env`: `WALLET_FEE_PER_LOOKUP_PAISE=100` (was 500). Wallet
  balance ₹10,425 → ~10,425 lookups instead of ~2,081.

Waiting on user:
- Paste `RAZORPAY_KEY_ID=rzp_live_xxx` into `backend/.env`
- Paste `RAZORPAY_KEY_SECRET=xxx` into `backend/.env`
- Generate + paste `RAZORPAY_WEBHOOK_SECRET=xxx` (64-char hex) into
  `.env` AND configure the same in Razorpay dashboard → Settings →
  Webhooks with URL `https://<domain>/api/razorpay/webhook`

**Blocker on webhook**: requires public HTTPS with valid CA-signed cert.
Options discussed with user: buy a domain (~₹800/year, cleanest),
use nip.io + Let's Encrypt (free, ugly URL), or Cloudflare Tunnel (free,
random URL). Not yet decided.

Test-mode cleanup: user hasn't decided whether to wipe existing test
transactions (`wallet_transactions WHERE razorpay_payment_id LIKE
'rzp_test_%'`) before switching live. Recommended wipe for clean history
but nothing forces it.

---

## 27. Deferred / discussed but not started

Items proposed to the user and either explicitly deferred or awaiting
green-light. Included here so the next agent doesn't re-propose them:

- **Inno Setup `.exe` operator installer** — `.iss` script drafted at
  `client-bootstrap/windows/installer/OperatorPortalSetup.iss`, needs
  compile on a Windows machine (~30 sec with Inno Setup 6). Would
  replace the PowerShell install with a double-click experience.
- **Refund endpoint** — deferred to PR-2. Currently refunds happen
  via Razorpay dashboard with no matching wallet entry.
- **CSV wallet export** — deferred to PR-2. Accountant/audit use case.
- **Same-roll cache audit trail** — deferred. Cache hits currently
  don't log a "who looked up X" trail.
- **Install heartbeat** — proposed but not built. install.ps1 would
  POST to `/api/install/heartbeat` so admin sees "operator laptop
  ABC123 is online" in their Downloads tab.
- **Portal-URL bake-in** — proposed but not built. Would embed the
  admin's org-specific portal URL into the download so install.ps1
  doesn't have to prompt.
- **Auto-open browser at end of install.ps1** — proposed but not
  applied. One-line `Start-Process $PortalUrl` at the end.
- **Pre-flight checks in install.ps1** — proposed but not applied.
  Fail-fast on bad Windows / no MFS500 / no portal connectivity.

---

## 28. Working test setup (as of July 2, 2026)

For a fresh agent testing the flow end-to-end:

**Services on the Mac (all should be running for full flow):**
- `portal-server` binary at `/tmp/portal-server` (from `go build`).
  Started via `cd backend && set -a; . ./.env; set +a; export
  RAZORPAY_WEBHOOK_SECRET=...; export DOWNLOADS_DIR=./downloads;
  /tmp/portal-server &`
- Vite: `cd frontend && VITE_ALLOW_TUNNEL=1 npm run dev &` (the
  env var makes it bind on 0.0.0.0 for LAN reach)
- luxand-service: `cd luxand-service && ./dev-up.sh` (Docker Compose)
- fp-match-service: same pattern (Docker Compose)

**Test credentials:**
- Admin: `admin` / `admin12345`
- Operator: `client` / `client123A` (org_id=1, Saragarhi centre)
- Superadmin: existing creds (varies)

**Planted test candidate: roll `809999`**. Has user's own selfie photo
+ FMR_V2005 fingerprint template (258 bytes). Files at
`/Users/veni/Downloads/portal/gndu27/22 Mar'26/101__Saragarhi.../photo/809999.jpg`
and `.../iso/809999.iso`. See §5.4-ish for the candidate-index layout
convention (`<root>/<org>/<date>/<centre>/{photo,fps,iso}/<roll>.*`).
Wallet balance ~₹10,425 (fee is now ₹1/lookup after §26).

**Mac LAN IP has been unstable** — was `172.16.62.147` on June 10,
`172.16.62.177` on June 17. DHCP lease keeps changing. When it changes,
the Windows test machine's install.ps1 baked homepage becomes stale.
Fix: re-run install.ps1 with new URL (idempotent), or type the new URL
in Chrome directly.

**Watch out for oasis-server on :8080** — user has another local project
that grabs port 8080 on Mac startup. When our `portal-server` exits,
oasis-server rebinds and our /api/health returns "route not found" JSON
that isn't ours. Kill oasis-server and restart portal-server if this
happens.

---

## 29. Environment on disk — as of 2026-07-02 (for the next agent)

Files that matter for continuing work, most recent first:

- `backend/.env` — live-keys prep in progress (§26). Test-key values
  still present. `WALLET_FEE_PER_LOOKUP_PAISE=100` (changed from 500).
- `luxand-service/.env` — `FACE_MATCH_FAR=0.05` (tuned from 0.01, §24.1).
- `client-bootstrap/windows/dist/VerificationPortalClient-1.0.0-windows.zip`
  — latest bundle. SHA changes per iteration; check
  `/api/downloads` manifest for authoritative value.
- `backend/downloads/` — symlink to the above zip; served by admin
  Downloads page.
- `frontend/public/uninstall.ps1` — standalone copy served by Vite for
  one-line curl+run testing of the uninstaller.
- `frontend/public/build-kit/operator-installer-build-kit.zip` — bundle
  of installer source + staging dir for Inno Setup compile on Windows
  (see §27 first bullet).

Nothing meaningful in git working tree that should be committed as-is
without user review — payment security tests are green and could be
committed cleanly; the install.ps1 fixes and uninstall.ps1 are on
disk but not committed. User has been iterating live, not through PRs.

---

## 30. Recurring gotchas for the next agent

- **Mac LAN IP drifts** — DHCP-assigned, changes every few days. If the
  Windows test machine can't reach the portal, check `ifconfig` first,
  update install.ps1 -PortalUrl or type new URL in Chrome.
- **Docker Desktop needs starting after Mac reboot** — luxand-service and
  fp-match-service both live in Docker. Run `docker info` to check; if
  daemon isn't up, `open -a Docker` and wait ~30 sec.
- **`.env` changes don't apply to running Docker** — compose `restart`
  reuses env; must do `down` + `up -d`. Applies to luxand-service esp.
- **`oasis-server` grabs :8080** — user's other project. `pkill -f
  /tmp/oasis-server` and restart our portal-server.
- **PowerShell 5.1 argument quoting** — when writing install.ps1 fixes,
  never trust `& $exe "$arg with spaces"` to preserve quotes through
  native commands. Use `Set-ItemProperty` on the registry directly,
  `*>$null` for redirects, and `${var}:` for var-colon in strings.
- **Windows unicode** — install.ps1 and uninstall.ps1 must be pure ASCII
  or PS 5.1's Windows-1252 codepage mojibakes them. No em-dashes, no
  smart quotes, no box-drawing.
- **Backend restarts wipe running-server state** — `/tmp/portal-server`
  binary gets deleted between sessions on Mac reboots. Rebuild with
  `go build -o /tmp/portal-server ./cmd/server`.
