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

### 5.3 1:1 matching, browser-driven, server is record-keeper

- Frontend calls MorFin `match` with the gallery template fetched
  from our backend. Score + decision come back; frontend posts the
  decision + scores to backend.
- Backend never talks to the device, never matches.
- **Why:** keeps capture latency local (no round-trip to EC2 mid-
  capture); makes the central server stateless and trivially scalable.

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
```

### What's still genuinely open

- **Luxand face 1:1** — third score channel; schema slot exists,
  webcam capture works, awaiting the Luxand SDK.
- **Server deploy (#12)** — see ISSUES.md §3.
- **Install model decision** — the bundle exists but who runs it
  (IT pre-image / per-laptop pre-flight / operator self-service) is
  still a tech-lead decision. See ISSUES.md §2.
- **Mantra vendor email** — six questions consolidated, not yet sent.
  See §4 of this document.

### Hardware-test learnings (recorded 2026-05-06)

**Marvis Auth SDK does NOT actually run on Windows from the Linux
package**, despite the JAR bundling `win/x64/*.dll` natives. This was
verified on a Windows 11 laptop with the MIS100V2 device + Mantra's
official MYUSB driver installed; both our wrapper AND Mantra's own
`Marvis_Auth_Sample.jar` crash identically:

```
java.lang.NoSuchMethodError: CompleteCallback
    at com.mantra.marvisauth.NativeUtils.ExtractLibraryFromJar(NativeUtils.java:169)
    at com.mantra.marvisauth.MarvisAuthNative.<clinit>(MarvisAuthNative.java:570)
    at com.mantra.marvisauth.MarvisAuth.<init>(MarvisAuth.java:46)
```

Tested across Java 11 and Java 17, same failure. The native DLLs
inside the JAR fail JNI registration — almost certainly because Mantra
shipped Windows binaries that don't match the Java classes in the same
JAR.

**Resolution path:** vendor email sent to `servico@mantratec.com` for
a Windows-specific SDK. Until then, **iris hardware testing on Windows
is blocked on Mantra**. Linux operator laptops should work fine
(unchanged code). The iris flow against the Go-based `iris-mock` is
fully functional for development.

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
