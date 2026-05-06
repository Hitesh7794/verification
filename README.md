# NEET Verification Portal

A biometric verification portal for high-stakes examinations. Center
operators verify candidate identity by capturing a live face photo, a
live fingerprint (and optionally iris as fallback), comparing each
against pre-enrolled records on file.

> **Status (2026-05-05).**
> - **Fingerprint 1:1 verification** — wired end-to-end against the
>   **MorFin Auth Web SDK** (devices: MELO041 / MFS500 / MARC10).
> - **Iris 1:1 verification** — wired end-to-end against the
>   **Marvis Auth SDK** (device: MIS100V2). Used as automatic
>   fallback when fingerprint match fails.
> - **Cross-platform daemons** — the same vendor JARs run on
>   **both Linux and Windows** (verified by reading the JAR contents:
>   they bundle `linux/x86_64/*.so` and `win/x64/*.dll` and dispatch
>   on `os.name` at runtime). No separate Windows SDK to chase.
> - **Operator-laptop install bundles** — `client-bootstrap/{linux,
>   windows}` ship a one-command installer per OS.
> - **Mock daemons** stand in for the real SDKs during local dev, so
>   the entire flow can be tested on macOS without USB hardware.
> - **Pending:** Luxand face matching, EC2 server deploy.

> **Read this first if you're new to the project:**
> - [`CONTEXT.md`](./CONTEXT.md) — architectural decisions, vendor-blocked unknowns, the "why" behind every non-obvious choice.
> - [`ISSUES.md`](./ISSUES.md) — the 5 open decisions for the tech lead.
> - [`TECH_LEAD_QUESTIONS.md`](./TECH_LEAD_QUESTIONS.md) — longer Q&A version of the above.
> - [`client-bootstrap/README.md`](./client-bootstrap/README.md) — operator-laptop install bundle internals.
> - [`iris-service/README.md`](./iris-service/README.md) — Java service wrapping the Marvis SDK.
> - [`IRIS_TEST_WINDOWS.md`](./IRIS_TEST_WINDOWS.md) — step-by-step guide for testing the MIS100V2 iris device on a Windows laptop.

---

## Highlights

- **Three role-based portals** — client (center operator), admin
  (organization controller), superadmin (platform owner). Each has its own
  login page and scoped data view.
- **Real candidate data** — on startup the backend walks the bundled
  candidate tree (`gndu27_enrollments_data_*` or `gndu27/`), indexes
  every enrolled candidate (roll → photo / fingerprint image / ISO
  template), and **sniffs the template wire format** (FMR_V2005 /
  FMR_V2011 / ANSI_V378) per record so the matcher always sends the
  right `TmpFormat`.
- **Zero-config operator UX** — no device dropdown, no "init" button.
  Both daemons are polled silently; when a USB scanner is plugged in,
  a green dot appears, the device is initialised in the background,
  and the operator just clicks **Capture & match**. Mid-shift unplug
  auto-recovers.
- **Iris fallback** — if fingerprint match fails, an inline card
  offers iris-based verification using the Marvis MIS100V2 device
  via the undocumented but bytecode-verified `MatchImage` API.
- **Idempotent verification submit** — every attempt carries a UUID;
  a network blip + retry returns the original row instead of
  double-recording.
- **Live dashboards** — admin and superadmin dashboards poll every 4 s.
- **Cross-OS by construction** — frontend is browser-based, backend
  is Go (cross-compiles), vendor daemon JARs are multi-platform
  in a single artifact.
- **Built for scale** — stateless JWT auth, indexed queries, in-memory
  candidate index, connection pooling. Schema is portable from SQLite
  (dev) to PostgreSQL (prod) with no code change.

---

## Project layout

```
Portal-main/
├── backend/                       Go API + dev mocks
│   ├── cmd/
│   │   ├── server/                Main API server (:8080)
│   │   ├── morfin-mock/           Fingerprint daemon stand-in (:8030)
│   │   └── iris-mock/             Iris service stand-in (:8031)
│   └── internal/
│       ├── api/                   HTTP handlers
│       ├── auth/                  JWT issue / parse
│       ├── config/                Env-based config + threshold defaults
│       ├── data/                  Filesystem index + template-format detection
│       └── db/                    SQLite open + versioned migrations + seed
│
├── frontend/                      React 18 + Vite + Tailwind v4 + recharts
│   └── src/
│       ├── components/
│       │   ├── AppShell.jsx
│       │   ├── LoginShell.jsx
│       │   ├── FingerprintCapture.jsx   ← drives the MorFin daemon
│       │   ├── IrisCapture.jsx          ← drives the iris service
│       │   └── ui.jsx
│       ├── lib/
│       │   ├── api.js                   ← portal API client
│       │   ├── auth.jsx
│       │   ├── morfin.js                ← MorFin daemon client
│       │   ├── iris.js                  ← iris service client
│       │   └── useDeviceStatus.js       ← polling state machine
│       └── pages/                       Landing / client / admin / superadmin
│
├── iris-service/                  Java + Javalin wrapper around Marvis SDK
│   ├── src/main/java/.../         IrisProvider interface, Mock + Marvis impls
│   ├── packaging/debian/          .deb files (control, postinst, systemd unit)
│   ├── pom.xml                    Maven build
│   └── build-deb.sh               Linux-only .deb packager
│
├── client-bootstrap/              Operator-laptop install bundles
│   ├── linux/                     verification-portal-client_*_linux.tar.gz
│   │                              (install.sh + 3 .debs + meta-deb)
│   └── windows/                   VerificationPortalClient-*-windows.zip
│                                  (install.ps1 + JARs + nssm.exe + certs)
│
├── CONTEXT.md                     Architectural decisions + open issues
├── ISSUES.md                      5 short blockers for tech lead
├── TECH_LEAD_QUESTIONS.md         Longer Q&A for tech lead
└── README.md                      (this file)
```

The bundled candidate data sits alongside `Portal-main/`, e.g. at
`<parent>/gndu27/22 Mar'26/<center>/{photo,fps,iso}/<roll>.{jpg,iso}`.
The backend probes a few common locations and picks the first one that
actually contains the photo/fps/iso layout.

---

## Three portals & demo credentials

| Portal      | URL                  | Username  | Password    |
|-------------|----------------------|-----------|-------------|
| Client      | `/client/login`      | `client`  | `client123` |
| Client (2)  | `/client/login`      | `client2` | `client123` |
| Admin       | `/admin/login`       | `admin`   | `admin123`  |
| Superadmin  | `/superadmin/login`  | `super`   | `super123`  |

`client` is wired to the first center (Saragarhi Memorial), `client2` to
the second (Khalsa College SS School). The admin sees stats scoped to its
organization; the superadmin sees everything.

---

## Prerequisites

- **Go 1.22+** — https://go.dev/dl/
- **Node.js 18+** and npm — https://nodejs.org/
- (Production / operator laptops only) **Java 11+** — to run the
  vendor daemons. Not needed for local dev on macOS.

> No C compiler required. The backend uses `modernc.org/sqlite`, a pure-Go
> SQLite driver, so there is no CGO / gcc dependency.

---

## How to run (local dev — four terminals + optional Docker for face)

You need four processes:

1. **MorFin mock daemon** — fingerprint daemon stand-in
2. **Iris mock daemon** — iris service stand-in
3. **Backend API** — central server
4. **Frontend dev server** — Vite

For the **face-match flow** (Luxand), there's a fifth piece: the Java
`luxand-service`. On macOS this runs in a Linux Docker container because
the vendor `libfsdk.so` is x86_64-only. The backend reaches it on
`localhost:8040`. See [`luxand-service/README.md`](./luxand-service/README.md)
for the full Docker setup; quick path:

```bash
cd luxand-service
cp .env.example .env       # edit, paste FSDK_LICENSE_KEY
./dev-up.sh                # builds image + starts container, ~3 min first time
```

If you don't run the luxand container, the four terminals below still
work — face matching simply returns a 503 in the UI, but every other
flow (fingerprint, iris fallback, dashboards, idempotency, etc.)
operates normally.

All commands below assume you're at the repo root.

```bash
# Terminal 1 — fingerprint mock (replaces vendor daemon on :8030)
cd backend && go run ./cmd/morfin-mock
```

```bash
# Terminal 2 — iris mock (replaces our Java service on :8031)
cd backend && go run ./cmd/iris-mock
```

```bash
# Terminal 3 — backend API (:8080)
cd backend && go mod tidy   # one-time, downloads dependencies
cd backend && go run ./cmd/server
```

```bash
# Terminal 4 — frontend (:5173)
cd frontend && npm install   # one-time, ~10 s
cd frontend && npm run dev
```

Open **http://localhost:5173/** — pick a portal, sign in with one of
the demo accounts above.

### What you'll see in the backend log

```
loading candidate index from /Users/.../gndu27 ...
indexed 2847 candidates across 11 centers
listening on :8080
```

On first launch the backend creates `verification.db` (SQLite, WAL),
runs the versioned migrations, syncs orgs/centers/users, and starts
serving. Re-running is a no-op (migrations + seeds are idempotent).
To start completely fresh, delete `backend/verification.db*` first.

#### Environment overrides

| Variable                | Default                                | Purpose                                    |
|-------------------------|----------------------------------------|--------------------------------------------|
| `HTTP_ADDR`             | `:8080`                                | Listen address                             |
| `DB_PATH`               | `verification.db`                      | SQLite file path                           |
| `DATA_DIR`              | auto-detected sample data folder       | Candidate data root                        |
| `JWT_SECRET`            | `dev-only-secret-change-me`            | Token signing secret                       |
| `FP_MATCH_THRESHOLD`    | `140`                                  | Fingerprint match score threshold (matches the vendor's own `DEFAULT_MATCH_THRESHOLD = 140` constant verified in the daemon JAR's bytecode) |
| `IRIS_MATCH_THRESHOLD`  | `0.6`                                  | Iris score threshold (per eye)             |
| `FACE_MATCH_THRESHOLD`  | `0.7`                                  | Luxand face score threshold (placeholder)  |
| `ARTIFACT_RETENTION`    | `none`                                 | `none` / `metadata` / `full`               |
| `ARTIFACT_DIR`          | `artifacts`                            | Where captured bytes go when retention=full |

---

## End-to-end verification flow (with the mocks)

1. **Sign in as `client`** at `http://localhost:5173/client/login`.
2. **Enter a roll number** — try `10001`. The candidate's photo,
   center, on-file template flags load instantly. The fingerprint
   gallery template is fetched in the background.
3. **Capture face** — click **Capture photo**. (Luxand integration
   will replace the snapshot with a template extraction later.)
4. **Fingerprint** — green status banner says **Device ready** because
   the mock claims an `MFS500` is plugged in. Click **Capture & match**.
   ~900 ms later: "Match · score 74 / threshold 140" plus quality, NFIQ
   and liveness shown inline.
5. **Decide** — click **Verified** or **Not verified**. The submit
   carries the full audit trail (device serial/model, scores,
   threshold, `via=fingerprint|iris|manual`, `decision_ms`,
   idempotency key).
6. **Open the admin tab** in another window → `/admin/login` as
   `admin/admin123`. Within ~4 s the dashboard ticks up.

### Iris fallback path (when fingerprint fails)

Force the fingerprint mock to fail before clicking **Capture & match**:

```bash
curl -X POST http://localhost:8030/control \
  -H 'Content-Type: application/json' \
  -d '{"matchSucceeds":false,"matchScore":18}'
```

In the browser:
1. Click **Capture & match** → red "No match · score 18 / threshold 140".
2. New card appears: "Fingerprint did not match. You can try iris as a fallback." → click **Try iris instead**.
3. Iris card auto-detects the (mock) iris device → click **Capture iris** → ~1.5 s → both eyes captured. Sample data has no enrolled iris template, so it's audit-only with quality scores.
4. Decide. Submit body now carries `via=iris` (if scored) or `via=manual`, plus iris quality scores.

### Test failure modes mid-session (no restart)

```bash
# Pretend the FP device just got unplugged
curl -X POST http://localhost:8030/control -d '{"deviceConnected":false}' -H 'Content-Type: application/json'

# Plug it back in
curl -X POST http://localhost:8030/control -d '{"deviceConnected":true}' -H 'Content-Type: application/json'

# Iris device unplugged
curl -X POST http://localhost:8031/control -d '{"deviceConnected":false}' -H 'Content-Type: application/json'

# Spoof detected on next capture
curl -X POST http://localhost:8030/control -d '{"liveness":0}' -H 'Content-Type: application/json'

# Fail the next 3 calls with a generic error
curl -X POST http://localhost:8030/control -d '{"failNextN":3}' -H 'Content-Type: application/json'

# Reset to defaults
curl -X POST http://localhost:8030/control -d '{"deviceConnected":true,"matchSucceeds":true,"matchScore":140,"liveness":1}' -H 'Content-Type: application/json'
curl -X POST http://localhost:8031/control -d '{"deviceConnected":true,"matchSucceeds":true}' -H 'Content-Type: application/json'
```

Status banner reflects each change within ~2 s (next poll tick) — no
reload required.

#### Alternative: DevTools console (no extra terminal)

If you don't want a 5th terminal open, do the same from the browser's
DevTools console (F12):

```javascript
fetch('http://localhost:8030/control', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceConnected: false })
})
```

---

## Architecture overview

```
┌──────────────────────────────┐  HTTPS    ┌──────────────────────────────┐
│  Operator laptop             │──────────▶│  Backend API (Go)            │
│  (Linux 18+ or Windows 10/11)│           │  - candidate index           │
│                              │           │  - JWT auth                  │
│  ┌────────────────────────┐  │           │  - verifications + audit log │
│  │ Browser (React portal) │──┼─ HTTP ─▶  │  - SQLite (dev) / Postgres   │
│  └────┬──────────────┬────┘  │           └──────────────────────────────┘
│       │              │       │
│  POST /morfinauth/   POST /iris/    (both on localhost)
│       │ :8030        │ :8031
│       ▼              ▼
│  ┌────────────┐  ┌────────────┐
│  │ MorFin     │  │ Mantra iris│  ← Both ship as cross-platform JARs.
│  │ daemon     │  │ service    │  ← Linux .so + Windows .dll bundled
│  └─────┬──────┘  └─────┬──────┘     inside, dispatched at runtime.
│        │ USB           │ USB
│        ▼               ▼
│   FP reader        Iris device
└──────────────────────────────┘
```

- **Capture and 1:1 match happen on the operator's laptop**, not on
  the central server. The portal backend never touches a device.
- **The central server's job** is candidate enrollment lookup,
  gallery template service, and decision recording.
- **Stateless** — JWTs let any number of API instances sit behind a
  load balancer.

### Cross-OS support — same code, different installer

The web app, backend, and dev mocks are OS-agnostic. The vendor
daemons are also OS-agnostic at the JAR level: a single
`morfinauth-client-service-1.0.0.0.jar` bundles
`linux/{x86,x86_64}/libMorfin_Auth.so` AND `win/{x86,x64}/Morfin_Auth.dll`
inside, dispatching on `os.name` at runtime. `Marvis_Auth.jar` has the
same shape.

The only OS-specific work is the **install glue**:

| Concern             | Linux                                             | Windows                                                |
|---------------------|---------------------------------------------------|--------------------------------------------------------|
| Service registration | `systemd` unit                                    | `nssm.exe` wraps `java -jar` as a Windows service       |
| Cert trust          | `update-ca-certificates` + Firefox/Chrome NSS DBs | `Import-Certificate -CertStoreLocation Cert:\LocalMachine\Root` |
| Browser homepage    | Per-browser Policies JSON                         | `HKLM:\SOFTWARE\Policies\<Vendor>\<Browser>` registry  |
| Launcher            | `.desktop` file in `/usr/share/applications/`     | `.url` shortcut on Desktop + Start Menu                |

Both lanes ship as a single-command bundle in `client-bootstrap/`.

---

## Operator-laptop install (production)

Once a real fingerprint / iris device is in hand and the EC2 server
is deployed, IT runs **one command per laptop**:

### Linux (Ubuntu 18.04+)

```bash
tar xzf verification-portal-client_*_linux.tar.gz
cd verification-portal-client_*_linux/
sudo ./install.sh https://portal.example.com
```

### Windows 10/11

```powershell
# Elevated PowerShell
Expand-Archive VerificationPortalClient-*-windows.zip .
cd VerificationPortalClient-*-windows
.\install.ps1 -PortalUrl https://portal.example.com
```

Both lanes leave the laptop with: vendor daemons running on `:8030`
and `:8031` as auto-start services, vendor TLS certs trusted, browser
homepage pinned, desktop launcher created. The operator double-clicks
the launcher and is on the login page.

Build the bundles on a Linux box (the EC2 will do):
[`client-bootstrap/README.md`](./client-bootstrap/README.md).

---

## Schema

`backend/internal/db/migrate.go` is a versioned migration runner.
Three migrations to date:

1. `initial_schema` — orgs / centers / users / verifications + indexes
2. `biometric_score_fields` — adds device identity, fingerprint scores
   (quality / NFIQ / match / liveness), iris per-eye scores + quality,
   face match score, decision audit (`via`, `match_threshold`,
   `decision_ms`, `client_app_version`), and a unique partial index on
   `idempotency_key`.
3. `verification_artifacts` — optional storage of captured face / fp /
   iris bytes alongside the verification row, with sha256 + size.

All `CREATE TABLE`s use `IF NOT EXISTS`; all `ALTER TABLE`s are additive.
Migrations run inside a transaction; partial application is impossible.
Re-running the server replays only what's missing.

---

## API surface

```
POST   /api/auth/login
GET    /api/me

GET    /api/candidates/{roll}                    candidate metadata
GET    /api/candidates/{roll}/photo              JPEG bytes
GET    /api/candidates/{roll}/fp-template        {template_b64, format, size_bytes}

POST   /api/verifications                        record a decision (idempotent)
POST   /api/verifications/{id}/artifacts         multipart capture upload (gated by retention)

GET    /api/admin/stats         /recent  /by-center  /timeline
GET    /api/super/stats         /organizations  /top-centers
```

---

## Tests

```bash
cd backend && go test ./...           # 23+ Go tests
cd iris-service && mvn test           # 7 JUnit tests for the iris service
```

Coverage: migration runner, format detector, both mock daemons,
candidate / verification / artifact handlers, iris HTTP layer, mock
provider behaviour. Real-SDK integration is out of scope for unit
tests — covered by a separate hardware run on the operator laptop.

---

## What's pending

1. **Luxand face 1:1** — adds a third score channel; schema slot
   already exists (`face_match_score`), frontend webcam capture
   already runs. Just needs the Luxand SDK plugged in server-side.
2. **EC2 server deploy** — Postgres + nginx + TLS + systemd unit.
   Needs a DNS name pointed at the EIP for Let's Encrypt and webcam
   HTTPS.

See [`ISSUES.md`](./ISSUES.md) for the 5 specific blockers needing
tech-lead decisions, and the in-repo task tracker for the full plan.

---

## Troubleshooting

| Symptom                                  | Fix                                                                                                                          |
|------------------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `go: command not found`                  | Install Go from https://go.dev/dl/ and open a fresh terminal.                                                                |
| Login fails / 401                        | Delete `backend/verification.db*` and restart the backend to re-seed users.                                                  |
| Status banner says "Device service not running" | The relevant mock daemon isn't running. `cd backend && go run ./cmd/morfin-mock` (or `./cmd/iris-mock`).                     |
| Status stays "No device plugged in"      | The mocks start with `deviceConnected=true`. If you toggled it off via `/control`, toggle it back on.                        |
| `Unable to access webcam` in client UI   | Make sure you're on `http://localhost:5173` (not an IP); browsers block `getUserMedia` on plain HTTP from non-localhost hosts. |
| Port 8080 already in use                 | Either `lsof -i :8080 -t \| xargs kill -9` to free the port, or change the listen address with **`HTTP_ADDR=:8081 go run ./cmd/server`** (the env var is `HTTP_ADDR`, not `PORT`). If you change the port, also update `frontend/vite.config.js` proxy. |
| Stale `go run` server keeps reappearing  | Use `lsof -i :8030 -i :8031 -i :8080 -i :5173 -t \| xargs kill -9` to flush all four dev ports at once. |
| Frontend can't reach backend             | Confirm the backend log shows `listening on :8080`. The Vite dev server proxies `/api` there.                                |
| Verification DB row missing scores       | Confirm the operator is using the new client (look for `via` / `idempotency_key` in the submit body in DevTools Network tab).|
