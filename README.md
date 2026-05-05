# NEET Verification Portal

A biometric verification portal for high-stakes examinations. Center
operators verify candidate identity by capturing a live face photo and a
live fingerprint, comparing both against pre-enrolled records on file.

> **Status.** Fingerprint verification (1:1) is wired end-to-end against
> the **MorFin Auth Linux Web SDK** (devices: MELO041 / MFS500 / MARC10).
> A faithful **mock daemon** stands in for the real SDK during local dev,
> so you can run and test the whole flow without USB hardware. Iris
> capture (Marvis MIS100V2) and face matching (Luxand) layer on later —
> their slots in the schema and frontend are already in place.

> **Architectural decisions, hardware-blocked unknowns, vendor questions
> still open, and the OS-of-choice rationale all live in
> [`CONTEXT.md`](./CONTEXT.md). Read it before making non-trivial
> changes.**

---

## Highlights

- **Three role-based portals** — client (center operator), admin
  (organization controller), superadmin (platform owner). Each has its own
  login page and scoped data view.
- **Real candidate data** — on startup the backend walks the
  `gndu27_enrollments_data_*` (or just `gndu27/`) directory, indexes every
  enrolled candidate (roll → photo / fingerprint image / ISO template),
  and **sniffs the template wire format** (FMR_V2005 / FMR_V2011 /
  ANSI_V378) per record so the matcher always uses the right `TmpFormat`.
- **Zero-config operator UX** — no device dropdown, no "init" button. The
  daemon is polled silently; when a USB scanner is plugged in, a green dot
  appears, the device is initialised in the background, and the operator
  just clicks "Capture & match". Mid-shift unplug auto-recovers.
- **Idempotent verification submit** — every attempt carries a UUID; a
  network blip + retry returns the original row instead of double-recording.
- **Live dashboards** — admin and superadmin dashboards poll every 4 s.
- **Built for scale** — stateless JWT auth, indexed queries, in-memory
  candidate index, connection pooling. Schema is portable from SQLite
  (dev) to PostgreSQL (prod) with no code change.

---

## Project layout

```
Verification_portal/
├── backend/                       Go API (chi + SQLite + JWT)
│   ├── cmd/
│   │   ├── server/                Main API server
│   │   └── morfin-mock/           Local stand-in for the MorFin daemon
│   └── internal/
│       ├── api/                   HTTP handlers, candidate + verification + admin
│       ├── auth/                  JWT issue / parse
│       ├── config/                Env-based config + threshold defaults
│       ├── data/                  Filesystem index + template-format detection
│       └── db/                    SQLite open + versioned migrations + seed
│
├── frontend/                      React 18 + Vite + Tailwind v4 + recharts
│   ├── index.html
│   ├── vite.config.js             Proxies /api → :8080
│   └── src/
│       ├── components/
│       │   ├── AppShell.jsx
│       │   ├── LoginShell.jsx
│       │   ├── FingerprintCapture.jsx   ← drives the MorFin daemon
│       │   └── ui.jsx
│       ├── lib/
│       │   ├── api.js                   ← portal API client
│       │   ├── auth.jsx
│       │   ├── morfin.js                ← MorFin daemon client
│       │   └── useDeviceStatus.js       ← polling state machine
│       └── pages/
│           ├── Landing.jsx
│           ├── client/                  Center operator portal
│           ├── admin/                   Organization admin portal
│           └── superadmin/              Platform-wide portal
│
└── README.md
```

The bundled candidate data sits alongside `Verification_portal/`, e.g. at
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

> No C compiler required. The backend uses `modernc.org/sqlite`, a pure-Go
> SQLite driver, so there is no CGO / gcc dependency.

---

## How to run (local dev — three terminals)

You need three processes:

1. **MorFin mock daemon** (impersonates the operator-side SDK)
2. **Backend API** (the central server)
3. **Frontend dev server** (Vite)

### Terminal 1 — MorFin mock daemon

```bash
cd backend
go run ./cmd/morfin-mock
```

Listens on `:8030` (the same port the real MorFin daemon binds to). The
frontend's MorFin client points at this by default. When real hardware is
available, install the vendor `.deb` instead and the frontend code stays
unchanged.

The mock has a `/control` endpoint to flip failure modes mid-session:

```bash
# pretend the device just got unplugged
curl -X POST http://localhost:8030/control \
  -H 'Content-Type: application/json' \
  -d '{"deviceConnected":false}'

# inject a non-match score for the next match call
curl -X POST http://localhost:8030/control \
  -H 'Content-Type: application/json' \
  -d '{"matchSucceeds":false,"matchScore":22}'

# fail the next 3 calls with a generic error
curl -X POST http://localhost:8030/control \
  -H 'Content-Type: application/json' \
  -d '{"failNextN":3}'

# inspect current state
curl http://localhost:8030/control
```

### Terminal 2 — Backend API

```bash
cd backend
go mod tidy        # one-time, downloads dependencies
go run ./cmd/server
```

You should see:

```
loading candidate index from /Users/.../gndu27 ...
indexed 2847 candidates across 11 centers
listening on :8080
```

On first launch the backend:

1. Creates `verification.db` (SQLite, WAL mode).
2. Runs the **versioned migration set** (`schema_migrations` table tracks
   what's applied, so re-running is a no-op).
3. Walks the candidate data tree and builds the in-memory index, sniffing
   the wire format of every `.iso` file.
4. Syncs orgs / centers / demo users.
5. Starts serving on `:8080`.

The seed and migrations are idempotent — re-running the server is safe.
To start completely fresh, delete `backend/verification.db*` before launch.

#### Environment overrides

| Variable                | Default                                | Purpose                                    |
|-------------------------|----------------------------------------|--------------------------------------------|
| `HTTP_ADDR`             | `:8080`                                | Listen address                             |
| `DB_PATH`               | `verification.db`                      | SQLite file path                           |
| `DATA_DIR`              | auto-detected sample data folder       | Candidate data root                        |
| `JWT_SECRET`            | `dev-only-secret-change-me`            | Token signing secret                       |
| `FP_MATCH_THRESHOLD`    | `140`                                  | Default fingerprint match score threshold (matches vendor default) |
| `IRIS_MATCH_THRESHOLD`  | `0.6`                                  | Default iris score threshold (per eye)     |
| `FACE_MATCH_THRESHOLD`  | `0.7`                                  | Default Luxand face score threshold        |
| `ARTIFACT_RETENTION`    | `none`                                 | `none` / `metadata` / `full`               |
| `ARTIFACT_DIR`          | `artifacts`                            | Where captured bytes go when retention=full |

### Terminal 3 — Frontend

```bash
cd frontend
npm install        # one-time, ~10s
npm run dev
```

```
VITE v5.x  ready in xxx ms
➜  Local:   http://localhost:5173/
```

Vite proxies `/api/*` to the backend on `:8080`. The MorFin client talks
directly to `localhost:8030` (i.e. the mock daemon, or the real one once
it's installed on the operator's PC).

### Open the app

http://localhost:5173/ — pick a portal, sign in with one of the demo
accounts above.

---

## End-to-end verification flow (with the mock)

1. **Sign in as `client`** at `http://localhost:5173/client/login`.
2. **Enter a roll number** — try `10001`. The candidate's photo, center,
   and on-file template flags load instantly. The fingerprint gallery
   template is fetched in the background.
3. **Capture face** — click **Capture photo**. (Luxand integration will
   replace the snapshot with a template extraction later; the layout
   already accommodates it.)
4. **Fingerprint** — the green status banner says **Device ready** because
   the mock claims a `MFS500` is plugged in. Click **Capture & match**.
   The mock returns a successful 1:1 match against the real FMR_V2005
   gallery template, plus quality, NFIQ and liveness fields. Score and
   threshold are shown inline.
5. **Decide** — click **Verified** or **Not verified**. The submit body
   carries the full audit trail (device serial/model, scores, threshold,
   `via=fingerprint|manual`, `decision_ms`, an idempotency key).
6. **Open the admin tab** in another window → `/admin/login` as `admin`.
   Within ~4 s the dashboard ticks up.

### Test failure modes

While the verification is on the fingerprint step, in another terminal:

```bash
# pretend the device got unplugged
curl -X POST http://localhost:8030/control -d '{"deviceConnected":false}' -H 'Content-Type: application/json'
```

The status banner flips amber to "Plug in the fingerprint device". Plug
back in (`{"deviceConnected":true}`) — it auto-recovers without a reload.

```bash
# force a non-match
curl -X POST http://localhost:8030/control -d '{"matchSucceeds":false,"matchScore":22}' -H 'Content-Type: application/json'
```

Click "Capture & match" — the result panel shows "No match · score 22 /
threshold 140" in red.

---

## Architecture overview

```
┌──────────────────────────────┐  HTTPS    ┌──────────────────────────────┐
│  Operator laptop (Linux)     │──────────▶│  Backend API (Go)            │
│                              │           │  - candidate index           │
│  ┌────────────────────────┐  │           │  - JWT auth                  │
│  │ Browser (React portal) │──┼─ HTTP ─▶  │  - verifications + audit log │
│  └─────────┬──────────────┘  │           │  - SQLite (dev) / Postgres   │
│            │                 │           └──────────────────────────────┘
│            │ POST /morfinauth/*  (localhost:8030)
│            ▼
│  ┌────────────────────────┐  │
│  │ MorFin daemon (.deb)   │  │
│  │   - real on hardware   │  │
│  │   - mock on dev box    │  │
│  └────────────────────────┘  │
│            │ USB             │
│            ▼                 │
│  Fingerprint reader          │
└──────────────────────────────┘
```

- **Capture and 1:1 match happen on the operator's laptop**, not on the
  central server. The portal backend never touches the device.
- **The central server's job** is candidate enrollment lookup, gallery
  template service, and decision recording.
- **Stateless** — JWTs let any number of API instances sit behind a load
  balancer.

---

## Schema

`backend/internal/db/migrate.go` is a versioned migration runner. Three
migrations to date:

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
cd backend
go test ./...
```

Currently 18 tests across the migration runner, format detector, the
mock daemon, and the candidate / verification / artifact handlers.

---

## What's pending

1. **Iris capture & 1:1 match** — wrap the Marvis SDK in a `.deb` mirroring
   the MorFin pattern, expose `/iris/match`, wire as a fallback when
   fingerprint match fails.
2. **Luxand face 1:1** — adds a third score channel; schema slot already
   exists (`face_match_score`).
3. **Operator-laptop bootstrap** — `client-bootstrap/{linux,windows}`
   builds platform-specific install bundles. Linux ships
   `verification-portal-client_*_linux.tar.gz` (an `install.sh` that
   `apt-get install`s the vendor MorFin .deb + our iris .deb + a
   meta-package that pins the browser homepage and adds a desktop
   launcher); Windows ships `VerificationPortalClient-*-windows.zip`
   (an `install.ps1` that registers both JARs as Windows Services via
   `nssm`, imports the vendor TLS certs into `Cert:\LocalMachine\Root`,
   pins Chrome/Edge homepage in `HKLM` policy, and drops Start Menu +
   Desktop shortcuts). Same JARs run on both OSes; the bundle is what
   differs. See `client-bootstrap/README.md`.
4. **Server deploy** — Postgres + nginx + TLS on the EC2 box. Needs a DNS
   name pointed at the EIP.

See the in-repo task tracker for the full plan.

---

## Troubleshooting

| Symptom                                  | Fix                                                                                                                          |
|------------------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `go: command not found`                  | Install Go from https://go.dev/dl/ and open a fresh terminal.                                                                |
| Login fails / 401                        | Delete `backend/verification.db*` and restart the backend to re-seed users.                                                  |
| Status banner says "Device service not running" | Make sure the mock daemon is running (`go run ./cmd/morfin-mock`) — or the real MorFin daemon if you're on operator hardware. |
| Status stays "No device plugged in"      | The mock starts with `deviceConnected=true`. If you toggled it off via `/control`, toggle it back on.                        |
| `Unable to access webcam` in client UI   | Make sure you're on `http://localhost:5173` (not an IP); browsers block `getUserMedia` on plain HTTP from non-localhost hosts. |
| Port 8080 already in use                 | Either `lsof -i :8080 -t \| xargs kill -9` to free the port, or change the listen address with **`HTTP_ADDR=:8081 go run ./cmd/server`** (the env var is `HTTP_ADDR`, not `PORT`). If you change the port, also update `frontend/vite.config.js` proxy. |
| Stale `go run` server keeps reappearing  | Use `lsof -i :8030 -i :8031 -i :8080 -i :5173 -t \| xargs kill -9` to flush all four dev ports at once. |
| Frontend can't reach backend             | Confirm the backend log shows `listening on :8080`. The Vite dev server proxies `/api` there.                                |
| Verification DB row missing scores       | Confirm the operator is using the new client (look for `via` / `idempotency_key` in the submit body in DevTools Network tab).|
