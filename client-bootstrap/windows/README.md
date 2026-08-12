# `client-bootstrap/windows/`

Builds the operator-laptop install bundle for **Windows 10 (build 17763+) / Windows 11**.

Everything runs as **native Windows services**. Three daemons on three
ports; the frontend talks to `localhost` for all of them.

## Architecture

```
┌─ Windows host ────────────────────────────────────────────────────┐
│                                                                    │
│  Browser ─→ localhost:8030            (MorFin FP daemon, native)   │
│         ─→ localhost:4443 / :8090     (Startek/ACPL FP, native)    │
│         ─→ localhost:8031             (Marvis iris daemon, native) │
│                                                                    │
└─────────────┬────────────────────────────────────────┬────────────┘
              │ USB                                    │ USB
     ┌────────▼────────┐                    ┌──────────▼──────────┐
     │  MorFin readers │                    │  MIS100V2 iris      │
     │  (2C0F:*)       │                    │  (2C0F:2100)        │
     └─────────────────┘                    └─────────────────────┘

              │ USB
     ┌────────▼────────┐
     │  Startek FM220U │
     │  L1 (0BCA:8230) │
     └─────────────────┘
```

**Two fingerprint vendors ship side-by-side.** Operator laptops get
both the Mantra MorFin daemon and the Startek/ACPL Capture API. The
frontend polls both and binds to whichever has a device plugged in —
operators never pick a vendor. See [`STARTEK_INTEGRATION.md`](../../STARTEK_INTEGRATION.md)
for Startek details.

**Iris is native as of Aug 2026.** Historical note: v1.0 of Mantra's
Marvis iris SDK crashed on Windows due to a JNI signature mismatch, so
we ran the daemon inside WSL2 with USB passthrough via `usbipd-win`.
That whole workaround retired when the vendor shipped their Marvis
Auth **Web SDK v1.4.0.0** — a precompiled Windows service. See
[`IRIS_NOTES.md`](../../IRIS_NOTES.md) for the retirement story.

To deploy a Mantra-only fleet: `.\install.ps1 -PortalUrl ... -SkipStartek`.
To deploy without iris hardware: add `-SkipIris`.

## Bundle contents

```
VerificationPortalClient-<ver>-windows.zip
├── install.ps1                                       ← entry point (admin)
├── morfin/
│   ├── morfinauth-client-service-1.0.0.0.jar        (Mantra FP daemon; Win-native via nssm)
│   ├── jre/                                          (bundled Adoptium Temurin JRE 17)
│   └── certs/                                        (vendor TLS certs)
├── startek/                                          (optional — added 2026-05-15)
│   ├── L1_API_Setup_*.msi                            (ACPL Capture API MSI; self-registers service)
│   └── VC17_redist.x86.exe                           (VS2017 redist prereq)
├── vendor/
│   └── MarvisAuthClientService.exe                  (Mantra iris installer; self-registers service)
├── tools/
│   └── nssm.exe                                      (Windows service registrar for MorFin)
└── README.txt
```

## Prerequisites — operator laptop

| Requirement | Why |
|------|-----|
| Windows 10 build 17763+ (1809 / October 2018) **or** Windows 11 | Vendor daemons need modern .NET + Installer engines |
| 64-bit Windows | Vendor DLLs are 64-bit |
| **For Startek devices only:** Windows Certified RD Service for L1 Devices, installed separately from https://acpl.in.net/RdService.html | The ACPL Capture API can't talk to FM220U without it |

Java is bundled (Adoptium Temurin JRE 17 under `morfin/jre/`) — operators
don't need to install it separately.

The installer fails fast with a clear message if any of these aren't met.
The Startek L1 RD prereq is checked but only warned, not enforced.

## Building (build host)

Prerequisites:

- Vendor `MorfinAuthClientService.deb` accessible (auto-detected at the
  project's typical layout; override via `MORFIN_DEB=`)
- Vendor `MarvisAuthClientService.exe` staged at
  `client-bootstrap/windows/vendor/MarvisAuthClientService.exe`
  (see [`vendor/README.md`](./vendor/README.md))
- *(Optional — for Startek support)* `Setup_ACPL_L1_API/` package
  containing the ACPL Capture API MSI + VC++ redist (auto-detected at
  repo root; override via `STARTEK_DIR=`). Bundle still succeeds without
  it — the resulting bundle just omits the Startek phase.
- `nssm.exe` (64-bit) at `client-bootstrap/windows/tools/nssm.exe`
  ([nssm.cc/download](https://nssm.cc/download), BSD-licensed)

```bash
cd Portal-main/client-bootstrap/windows
./build-bundle.sh
# → dist/VerificationPortalClient-1.0.0-windows.zip
```

## Field install (operator laptop)

1. Unzip the bundle anywhere.
2. Open PowerShell **as Administrator** in the unzipped folder.
3. Run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1 -PortalUrl https://portal.example.com
   ```

### What `install.ps1` does, in order

| # | Step | Reversible? |
|---|------|-------------|
| 1 | Pre-flight: admin, OS build | yes |
| 2 | Stage bundle into `$InstallRoot` | yes (`Remove-Item -Recurse`) |
| 3 | Install Marvis iris daemon (`vendor/MarvisAuthClientService.exe`) | yes (Programs & Features → uninstall) |
| 4 | Import vendor TLS certs into `Cert:\LocalMachine\Root` | yes |
| 5 | Install MorFin USB driver + register MorFin daemon via `nssm` | yes (`nssm remove`) |
| 6 | Install ACPL Capture API MSI (registers its own service) | yes (msiexec /x) |
| 7 | Pin Chrome + Edge homepage in `HKLM` policy | yes |
| 8 | Drop Desktop + Start Menu `.url` shortcuts | yes |

Idempotent: re-running updates everything in place (services stopped +
re-registered, certs re-imported, policies overwritten).

### CLI flags

```powershell
.\install.ps1 -PortalUrl https://portal.example.com `
              -InstallRoot "C:\Program Files\VerificationPortal"

.\install.ps1 -PortalUrl ... -SkipIris       # no iris hardware
.\install.ps1 -PortalUrl ... -SkipStartek    # Mantra-only deployments
```

## Verifying the install

```powershell
# Services
Get-Service MorfinAuthClientService                                # Mantra MorFin
Get-Service *ACPL* -ErrorAction SilentlyContinue                   # Startek/ACPL Capture API
Get-Service *Marvis*                                               # Marvis iris

# HTTP smoke tests
curl.exe http://localhost:8030/                                    # Mantra MorFin
curl.exe http://localhost:8090/FM220/getserial                     # Startek (HTTP)
curl.exe -k https://localhost:4443/FM220/getserial                 # Startek (HTTPS)
curl.exe -X POST http://localhost:8031/marvisauth/info             # Marvis iris
```

If the iris endpoint times out: check `Get-Service *Marvis*` — the
vendor installer sometimes leaves the service registered but stopped.
`Start-Service <name>` fixes it.

## Uninstall

```powershell
# Stop + remove our nssm-registered service
Stop-Service MorfinAuthClientService -Force
& "C:\Program Files\VerificationPortal\tools\nssm.exe" remove MorfinAuthClientService confirm

# Vendor-registered services (uninstall via Programs & Features or msiexec)
Get-Service *Marvis* | Stop-Service -Force
# then: Settings → Apps → "MarvisAuthClientService" → Uninstall
# or:   msiexec /x <ProductCode>

Get-Service *ACPL*   | Stop-Service -Force
# ACPL Capture API uninstalls the same way.

Remove-Item -Recurse "C:\Program Files\VerificationPortal"
Remove-Item HKLM:\SOFTWARE\Policies\Google\Chrome\HomepageLocation
Remove-Item HKLM:\SOFTWARE\Policies\Microsoft\Edge\HomepageLocation
```

## Why we don't ship a `.msi`

A PowerShell installer that IT can read, audit, and patch in the field
is a better fit for this stack than an opaque `.msi`. If a future
deployment target requires `.msi` (Intune / SCCM), wrap `install.ps1`
in a custom-action MSI — the script itself is the source of truth.
