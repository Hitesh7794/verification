# Startek / ACPL fingerprint integration

End-to-end notes for the Startek FM220U L1 / AST300 fingerprint vendor,
added 2026-05-15 as a second fingerprint vendor alongside the existing
Mantra MorFin path. Both vendors run **side-by-side** on Windows
operator laptops; the frontend polls both daemons in parallel and binds
to whichever vendor has a device plugged in.

> **Status (2026-05-16): verified working end-to-end with real hardware.**
> Captured a finger on an FM220U L1 (serial M240477055), stored as gallery
> for test roll 99999, re-verified through the portal: **score 373 /
> threshold 40 / status:true**. Same finger against a gndu27-enrolled
> candidate (roll 10001, Mantra-extracted) correctly scores ~0 → no
> match. The full pipeline is documented below.

This document is the Startek analogue of `IRIS_TEST_WINDOWS.md` — vendor
specifics, install ordering, ports, troubleshooting. The cross-vendor
architecture and the "why" of the abstraction is documented in
`CONTEXT.md` §"Multi-vendor fingerprint".

## TL;DR for operators

1. Install **Windows Certified RD Service for L1 Devices** from
   <https://acpl.in.net/RdService.html>. (Not bundled — separate ACPL
   distribution.)
2. Run our installer in elevated PowerShell:
   ```powershell
   .\install.ps1 -PortalUrl https://verify.example.com
   ```
   This installs (among other things) the ACPL Capture API via
   `L1_API_Setup_30072025.msi`.
3. Plug in the FM220U device. The browser's verification flow auto-
   detects it via the registry — no UI change for the operator.

## What's in the SDK

`Setup_ACPL_L1_API/` (vendor-supplied):

```
Setup_ACPL_L1_API/
├── L1_API_Setup_30072025.msi          ACPL CAPTURE API — 4.4 MB MSI
│                                       Publisher: Access Computech Pvt Ltd
│                                       Installs: ACPLAPI.DLL, FM220API.DLL,
│                                                 fm220drv.dll, ACPL_ISOTemplate_Utility.exe
│                                       Registers a Windows service that
│                                       listens on :4443 (HTTPS) and :8090 (HTTP).
├── Dependencies/
│   ├── VC17_redist.x86.exe             VS2017 x86 runtime — REQUIRED before MSI install
│   └── vcredist_x86.exe                Older fallback redist
├── Documents/
│   └── Fingerprint API Guide_Windows_Linux.pdf
└── TestPages/
    ├── test_fm220_api_Capture_match_JScript.html        (HTTP demo, ports 8090 + 11080)
    └── test_fm220_api_Capture_match_https_jscript.html  (HTTPS demo, ports 4443 + 11200)
```

> Note the PDF says "Windows_Linux" but only the Windows MSI is in the
> package; no Linux build. Linux operator laptops use Mantra MorFin
> until a Linux variant of the ACPL Capture API is obtained.

## Wire protocol

The ACPL Capture API uses **HTTP GET** with query-string params and
returns JSON. Three endpoints we exercise:

```
GET /FM220/getserial
  → {errorCode:0, status:"OK", serialNumber, dc, mi}

GET /FM220/gettmpl                  (one-shot capture)
  → {errorCode:0, status, serialNumber, dc, mi,
     templateBase64, isoImgBase64}

GET /FM220/GetMatchResult?MatchTmpl=<urlencoded base64>
  → {errorCode:0, status, serialNumber, mi,
     matchSuccess: bool, matchScore: number}
```

`MatchTmpl` is the **gallery** template. The service captures a new
probe from the device and matches it against the supplied gallery in a
single call — same pattern as Mantra MorFin's `match` endpoint.

Plus an auxiliary call to the **L1 RD Service** (a separate ACPL
package, prerequisite — must be installed first):

```
RELEASEFM220 https://localhost:11200/rd/releasefm220
              (HTTP method is the custom string "RELEASEFM220", not GET)
```

The L1 RD service holds exclusive USB access to the FM220 by default;
this call releases the device to the Capture API. Our `startek.js`
client issues it from `init()` on a best-effort basis (silently
tolerates failure when L1 RD isn't running — e.g. dev mock).

## Architecture

```
┌─ Windows operator laptop ──────────────────┐    ┌─ Central server (EC2) ─────────┐
│                                             │    │                                 │
│  Browser ── localhost:8030 ─ Mantra MorFin ─USB→ MELO041/MFS500/MARC10              │
│         (Mantra: capture + match locally)   │    │   Go backend on :8080           │
│                                             │    │       │                         │
│  Browser ── localhost:4443 ─ ACPL Capture ──USB→ FM220U L1 / AST300                 │
│  (HTTPS; also :8090 HTTP)                   │    │       ├─→ luxand-service :8040 │ (face)
│  Startek: capture-only locally;             │    │       │                         │
│           match server-side via /api/fp-match│HTTPS│       └─→ fp-match-service     │ (SourceAFIS)
│           ──────────────────────────────────┼────▶│            :8050                │
│                                             │    │                                 │
│  Browser ── /api/*  ───────────────────────HTTPS→ Go backend orchestrates           │
└─────────────────────────────────────────────┘    └─────────────────────────────────┘
```

Both fingerprint daemons run side-by-side on the operator laptop. The
registry (`frontend/src/lib/fingerprint/registry.js`) probes both every
2 s; first daemon to report a connected device wins the session.

| Vendor | Daemon | Port | OS support | Devices | Matching site |
|---|---|---|---|---|---|
| Mantra | MorFin Auth | 8030 (HTTP) | Linux + Windows native | MELO041, MFS500, MARC10 | **Operator laptop** (vendor daemon does capture + match) |
| Startek | ACPL Capture API | 4443 (HTTPS) / 8090 (HTTP) | Windows native | FM220U L1, AST300 | **Central server** via `fp-match-service` (SourceAFIS) |

**Why Startek matches server-side:** ACPL's `GetMatchResult` endpoint
only accepts templates captured in the same live session — verified
empirically 2026-05-15. Sending the gndu27 gallery (Mantra-extracted)
OR even the laptop's own previous capture as `MatchTmpl` returns
errorCode 104 with all device-info fields blank. To enable 1:1
verification against pre-enrolled gallery templates, we use ACPL's
Capture API for capture only (`gettmpl`) and route the resulting probe
+ the gallery FMR template to our server-side SourceAFIS matcher via
`POST /api/fp-match`. See `fp-match-service/README.md` for the matcher
service details.

## Frontend integration

The component layer (`FingerprintCapture.jsx`) is vendor-agnostic.
`useDeviceStatus.js` polls the registry, which fans out to per-vendor
clients in `frontend/src/lib/fingerprint/`:

```
frontend/src/lib/
├── morfin.js               existing Mantra MorFin client (untouched)
└── fingerprint/
    ├── types.js            Vendor enum + per-vendor default thresholds
    ├── startek.js          ACPL Capture API client
    └── registry.js         parallel probe + active-client dispatch
```

The active vendor is recorded on every fingerprint verification:

```sql
ALTER TABLE verifications ADD COLUMN fp_vendor TEXT;
-- 'mantra' | 'startek' | NULL (legacy / manual rows)
```

## Per-vendor differences worth knowing

| | Mantra MorFin | Startek / ACPL |
|---|---|---|
| Vendor daemon protocol | POST + JSON body | GET + query params |
| Vendor `ErrorCode` type | string ("0", "-2027") | int (0, -2) |
| Capture quality / NFIQ | exposed in vendor envelope | exposed (NFIQ field) |
| Liveness | -1 / 0 / 1 flag | not exposed |
| Preview bitmap | BitmapData on match | only on gettmpl, not on match |
| **Matcher** | **Mantra MorFin (operator laptop)** | **SourceAFIS (server, via /api/fp-match)** |
| Match score scale | MorFin int, ~0..255 | SourceAFIS double, ~0..600+ |
| **Default threshold** | **140** (vendor-bytecode-verified `DEFAULT_MATCH_THRESHOLD`) | **40** (SourceAFIS 1-in-1000 FMR; see threshold table in `CONTEXT.md` §5.3b) |
| Match-call shape (frontend) | `client.match({gallery, format, ...})` — vendor daemon does the work | `client.match({rollNo})` — captures via gettmpl, posts probe to /api/fp-match |
| Template format | FMR_V2005 / FMR_V2011 / ANSI_V378 (negotiated by daemon) | FMR_V2005 (UIDAI L1 mandate); SourceAFIS accepts all three |
| Linux supported? | yes | not yet — need vendor Linux SDK; Linux laptops use MorFin only |
| Windows supported? | yes (cross-platform JAR) | yes (MSI installs Capture API for capture-only role) |

## Bundle build

`client-bootstrap/windows/build-bundle.sh` stages the SDK from
`Setup_ACPL_L1_API/`:

```bash
cd Portal-main/client-bootstrap/windows
./build-bundle.sh                                    # auto-finds Setup_ACPL_L1_API/
# or:
STARTEK_DIR=/path/to/Setup_ACPL_L1_API ./build-bundle.sh
```

The resulting `VerificationPortalClient-*-windows.zip` adds a
`startek/` folder with the MSI and VC++ redist. `install.ps1` runs the
new `Install-StartekCaptureApi` phase to lay both down.

Skip Startek entirely (Mantra-only deployments):
```powershell
.\install.ps1 -PortalUrl ... -SkipStartek
```

## Local dev — no hardware

A Go-based mock at `backend/cmd/startek-mock` mimics the ACPL Capture
API on `localhost:8090` (HTTP). Same `/control` fault-injection
contract as `morfin-mock` so tests + dev flows can flip state on the
fly:

```bash
cd backend && go run ./cmd/startek-mock
# in another terminal:
curl http://localhost:8090/FM220/getserial
curl 'http://localhost:8090/FM220/GetMatchResult?MatchTmpl=<base64>'

# flip state for fault testing:
curl -X POST http://localhost:8090/control \
  -H 'Content-Type: application/json' \
  -d '{"deviceConnected":false}'
curl -X POST http://localhost:8090/control \
  -H 'Content-Type: application/json' \
  -d '{"matchSucceeds":false,"matchScore":18}'
curl -X POST http://localhost:8090/control \
  -H 'Content-Type: application/json' \
  -d '{"failNextN":3}'   # next 3 calls return -1
```

Run both fingerprint mocks alongside the backend + frontend (six
terminals total when iris-mock + luxand-service are also running) to
exercise the multi-vendor frontend without any devices in hand.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `errorCode: -2, status: "device not connected"` from `/getserial` despite device being plugged in | L1 RD Service hasn't booted yet OR the device is genuinely unplugged. Confirm L1 RD is running: `Get-Service ACPL_L1_RDSERVICE`. Unplug + replug the FM220U + give Windows 5-10 s to enumerate. Do NOT call `RELEASEFM220` — that puts the Capture API into a "Pl wait for closing of earlier process" cooldown (verified 2026-05-15). The `releaseFromRD()` function in our `startek.js` client is intentionally a no-op for this reason. |
| Browser console shows CORS error against `https://localhost:4443` | Self-signed cert not trusted. Open `https://localhost:4443/FM220/getserial` in the browser once, accept the cert prompt. For fleet rollout, install the ACPL cert into `Cert:\LocalMachine\Root`. Dev workaround: use the HTTP variant on :8090 (frontend defaults to HTTP — see `VITE_STARTEK_BASE`). |
| `ACPLAPI.DLL` fails to load (service won't start) | VC++ 2017 redist missing. Re-run `Dependencies/VC17_redist.x86.exe /install /quiet`. |
| MSI install reports exit code 1638 | "Another version already installed" — that's success; the MSI is using its UpgradeCode. install.ps1 treats 1638 as OK. |
| Portal returns `errorCode 104, status:"N"` from old code paths | You're on a stale frontend bundle. Hard-refresh (Ctrl+Shift+R) with DevTools open + "Disable cache" ticked. The current code path doesn't call ACPL's `GetMatchResult` anymore — it calls our `/api/fp-match` server-side matcher. |
| `/api/fp-match` returns 503 | `fp-match-service` isn't running on the backend host. On Mac dev: `cd fp-match-service && ./dev-up.sh`. On EC2: `systemctl status fp-match-service`. |
| `/api/fp-match` returns 422 "candidate has no enrolled fingerprint template" | Roll exists in the candidate index but has no `.iso` file. Either pick a different roll or stage a gallery template under the candidate's `iso/<roll>.iso`. |
| Frontend banner says "Mantra · MFS500" but you plugged in an FM220 | Mantra's daemon happens to report a (mock?) MFS500 first; in the registry's probe order Mantra wins ties. Either unplug the MFS500 / stop MorFin, or flip `PROBE_ORDER` in `frontend/src/lib/fingerprint/registry.js` to prefer Startek. |
| Threshold seems wrong | Startek's threshold is 40 (SourceAFIS 1-in-1000 FMR). Real captures should score 80-500+ for matches and 0-5 for non-matches. To tune: set `FP_MATCH_THRESHOLD=N` in fp-match-service's environment (defaults to 40). Frontend's `DefaultThresholds[Vendor.Startek]` in `types.js` is the fallback when the backend's response doesn't carry a threshold. |
| Same finger captured twice doesn't match across sessions | Variance in finger placement is real but SourceAFIS still scores 80-500+ on the SAME finger in normal conditions. If you see <20 consistently, finger pressure / sensor cleanliness is the likely culprit. |

## Open vendor questions (Startek / ACPL) — non-blocking

These are nice-to-have clarifications; the integration works today via
the server-side matcher path, so none are blocking:

1. Is there a **Linux variant** of the ACPL Capture API service? The
   integration PDF title says "Windows_Linux" but only the Windows MSI
   was shipped. Currently Linux operator laptops can't use Startek
   devices at all — they're MorFin-only.
2. Does ACPL have a non-L1 **Bio-API / FA SDK** that supports stored-
   gallery 1:1 matching? Today we work around this via SourceAFIS; if
   they ship something equivalent we could move matching back to the
   operator laptop for ~150 ms lower latency. Not urgent.
3. Does the ACPL Capture API service install a **TLS certificate** for
   `https://localhost:4443` into `Cert:\LocalMachine\Root` at MSI-install
   time, or do we need to do that ourselves? We use the HTTP variant
   on :8090 in dev to sidestep this.
4. Are there **liveness detection** endpoints we missed? Mantra exposes
   a `-1/0/1` liveness flag; the ACPL public API doesn't appear to.
   For high-stakes deployments we may want to gate on liveness server-
   side via a different signal.

Send to ACPL support — point of contact TBD.
