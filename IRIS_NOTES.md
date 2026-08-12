# Iris on Windows — native, since v1.4 of the Marvis Auth Web SDK

Iris capture runs as a **native Windows service** on operator
laptops. Install `MarvisAuthClientService.exe` from Mantra's Marvis
Auth Web SDK 1.4.0.0 package (or newer) and it binds `localhost:8031`
with the `/marvisauth/*` API. Frontend `frontend/src/lib/verify/iris.js`
talks to it directly.

There is no WSL2, no `usbipd-win`, no Java daemon in this path.

## What the frontend uses

| Endpoint | Purpose |
|---|---|
| `POST /marvisauth/info` | health check + device metadata |
| `POST /marvisauth/capture` | one-shot iris capture (single eye) |
| `POST /marvisauth/getimage` | fetch last capture as ISO/ANSI template |
| `POST /marvisauth/match` | capture + 1:1 match against a supplied gallery template |
| `POST /marvisauth/verify` | 1:1 match between two supplied templates |
| `POST /marvisauth/uninit` | release device |
| `POST /marvisauth/setblueled` | LED indicator |

Vendor sample HTML + `marvisauth.js` shipped inside the SDK zip
(`SDKSample/`) is the canonical wire-shape reference.

## Deployment

1. Drop `MarvisAuthClientService.exe` into
   `client-bootstrap/windows/vendor/` (gitignored — vendor's terms
   forbid redistribution).
2. Run `client-bootstrap/windows/install.ps1 -PortalUrl <url>` as
   Administrator on the operator laptop. Phase 1 handles the iris
   install; skip it with `-SkipIris` on fingerprint-only builds.
3. Verify:
   ```powershell
   curl.exe -X POST http://localhost:8031/marvisauth/info
   Get-Service *Marvis*
   ```
4. Plug in an MIS100V2 (or any Marvis-supported iris device) and
   the daemon will auto-init on first `/capture` call.

## Retired: WSL2 workaround (v1.0 SDK, April 2025 – Aug 2026)

v1.0 of the Marvis SDK crashed at JNI init on Windows because the
vendor's Windows DLL and Java classes didn't match:

```
java.lang.NoSuchMethodError: CompleteCallback
    at com.mantra.marvisauth.NativeUtils.ExtractLibraryFromJar(...)
```

That mismatch is present in the vendor's own sample too, so
integration code was ruled out. Workaround was to install WSL2
Ubuntu, `usbipd-win` for USB passthrough, and run the Linux `.so`
inside a Java daemon (`iris-service/` package, now deleted). The
Windows-side install script provisioned all of that, plus a
scheduled task to re-attach the USB device after WSL VM idle-timeouts.

Everything above went away in **August 2026** when vendor shipped v1.4
of the Web SDK as a precompiled Windows service. If you're spelunking
for the old code, `git log --follow iris-service/pom.xml` finds it.

## Troubleshooting

**Daemon isn't running**
```powershell
Get-Service *Marvis*
Start-Service MarvisAuthClientService   # or whatever name the vendor registered
```

**Port already in use**
```powershell
Get-NetTCPConnection -LocalPort 8031
```

**Mixed-content browser warnings** — the daemon defaults to plain HTTP
(`http://localhost:8031`). If the portal is served over HTTPS,
modern browsers may block the cross-content request. Same trap as
Mantra MorFin's daemon; the fix is the same: install the vendor's
self-signed cert on the operator laptop so `https://localhost:8031`
resolves, then edit `frontend/src/lib/verify/iris.js`'s `DEFAULT_BASE`
(or set `VITE_IRIS_BASE`) to the HTTPS URL.
