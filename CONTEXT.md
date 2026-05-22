# Context, Decisions & Open Issues

This file captures the **why** behind architectural choices, things we
can't verify without hardware, vendor questions still outstanding, and
how to revisit decisions if the situation changes. Read this before
making non-trivial changes — most of the surprising design choices are
explained below rather than in the code.

Last updated: 2026-05-05

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

Originally the design was "matching always on the operator laptop"
(Mantra MorFin's daemon does capture+match in one call). That stayed
the default for MorFin but doesn't generalise to all vendors:

| Vendor | Capture | Matching | Why |
|---|---|---|---|
| Mantra MorFin | Operator laptop | Operator laptop | Vendor daemon does capture+match in one call. Local latency, no extra server hop. |
| Startek/ACPL FM220U | Operator laptop | **Server (`fp-match-service` / SourceAFIS)** | ACPL's L1 Capture API can only match same-session templates — verified to reject stored gallery FMR templates with errorCode 104. Server-side SourceAFIS accepts any FMR template regardless of source SDK. |
| Luxand face | Browser webcam | Server (`luxand-service`) | Browser does its own webcam capture (no daemon needed); central matching means no per-laptop install. |

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
