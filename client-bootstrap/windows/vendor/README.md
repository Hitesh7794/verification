# `client-bootstrap/windows/vendor/` — vendor payloads

Drop these installers here before running `install.ps1` or
`build-bundle.sh`. Both are gitignored because their vendors don't
permit redistribution.

## Expected files

```
client-bootstrap/windows/vendor/MarvisAuthClientService.exe   # ~200 MB
client-bootstrap/windows/vendor/MIS100V2_Driver.exe           # ~90 MB
client-bootstrap/windows/vendor/MorFinDriver_1.5.0.0.exe      # ~19 MB
```

### `MorFinDriver_1.5.0.0.exe` (or newer)

Mantra MorFin USB driver for fingerprint hardware (VID 2C0F). Ships
alongside the MorFin daemon so first-time laptops install the driver
before nssm registers the daemon service. `build-bundle.sh` globs
`MorFinDriver_*.exe` and picks the newest by version, so dropping a
newer point release into vendor/ is enough to ship it.

### `MarvisAuthClientService.exe`

Version **1.4.0.0** or newer, from Mantra's `Marvis_Auth_Web_SDK_*`
bundle (folder `Setup/` inside the vendor zip). Self-registers a
Windows service on `localhost:8031` that exposes the iris capture API
at `/marvisauth/*`.

### `MIS100V2_Driver.exe`

Version **2.2.0.0** or newer. The IriTech USB driver for the IriShield
scanner (Mantra rebrands this as MIS100V2). Covers **VID 1F63 PID
F001** — Mantra's MYUSB driver bundled with the fingerprint SDK does
NOT install this, which is why new operator laptops show the iris
device with `Status: Error` in Device Manager until this .exe runs.
Downloadable from IriTech's support portal or Mantra's MIS100V2
package.

The `install.ps1` script will:

1. Look for both installers at these paths.
2. **Driver first**: try silent (`/S`), fall back to interactive if the
   installer engine ignores it. Verify a VID 1F63 device is bound (or
   note that the .inf is cached for first plug-in).
3. **Service second**: same silent-first / interactive-fallback pattern.
   Verify the service is registered and reachable at
   `http://localhost:8031/marvisauth/info`.

If either file is missing, `install.ps1` warns and continues so
fingerprint-only builds and service-only upgrades still work.

## Historical context

Before v1.4 (April 2025), iris ran through a WSL2 + `usbipd-win` +
Java daemon workaround because Mantra's Windows JNI DLL crashed on
init. See `../../../IRIS_NOTES.md` for the full story and the
retired WSL2 setup that we no longer ship.
