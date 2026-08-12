# `client-bootstrap/windows/vendor/` — vendor payloads

Drop the Marvis Auth Client Service installer here before running
`install.ps1` or `build-bundle.sh`. The `.exe` is not committed
(gitignored) because the vendor doesn't permit redistribution.

## Expected file

```
client-bootstrap/windows/vendor/MarvisAuthClientService.exe
```

Version **1.4.0.0** or newer, from Mantra's `Marvis_Auth_Web_SDK_*`
bundle (folder `Setup/` inside the vendor zip). The `.exe` is
~200 MB and self-registers a Windows service on `localhost:8031`
that exposes the iris capture API at `/marvisauth/*`.

The `install.ps1` script will:

1. Look for the installer at this path.
2. Try silent install first (`/S`). If the vendor uses an installer
   engine that doesn't respect `/S`, fall back to interactive so the
   operator clicks through once.
3. Verify the service is registered and reachable at
   `http://localhost:8031/marvisauth/info`.

If the file is missing, `install.ps1` warns and skips the iris phase
so fingerprint-only builds still work.

## Historical context

Before v1.4 (April 2025), iris ran through a WSL2 + `usbipd-win` +
Java daemon workaround because Mantra's Windows JNI DLL crashed on
init. See `../../../IRIS_NOTES.md` for the full story and the
retired WSL2 setup that we no longer ship.
