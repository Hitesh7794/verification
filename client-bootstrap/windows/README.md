# `client-bootstrap/windows/`

Builds the operator-laptop install bundle for Windows 10 / 11.

## How the Windows side works

The vendor's `MorfinAuthClientService` and our `mantra-iris-service` are
both **plain Java JARs**. The Linux `.deb` ships them with a systemd
unit; on Windows we register the same JARs as Windows Services using
[`nssm`](https://nssm.cc/) (the Non-Sucking Service Manager). Same JAR
on both OSes — the JVM loads `linux/x86_64/*.so` or `win/x64/*.dll`
from inside the JAR depending on `os.name`.

| Concern        | Linux                                    | Windows |
|----------------|------------------------------------------|---------|
| Runtime        | systemd unit                             | Windows Service via `nssm` |
| Cert trust     | `update-ca-certificates` + per-browser NSS DB | `Cert:\LocalMachine\Root` (single store, all browsers honour it) |
| Homepage pin   | `/etc/opt/chrome/policies/managed/*.json` | `HKLM:\SOFTWARE\Policies\{Google\Chrome,Microsoft\Edge}` |
| Launcher       | `.desktop` + `xdg-open`                  | `.url` shortcut on Desktop + Start Menu |

## Bundle contents

```
VerificationPortalClient-<ver>-windows.zip
├── install.ps1                     ← entry point, run as Admin
├── morfin/
│   ├── morfinauth-client-service-1.0.0.0.jar  (vendor)
│   └── certs/                                   (vendor TLS certs)
├── iris/
│   ├── mantra-iris-service-<ver>.jar           (ours)
│   └── Marvis_Auth.jar                          (vendor)
├── tools/
│   └── nssm.exe                                 (Windows service registrar)
└── README.txt                                   (operator-laptop instructions)
```

## Building

Prerequisites on the build host (any OS that has `bash`, `mvn`, `tar`,
`ar`, `zip`):

- `mvn` (used by `iris-service/build-deb.sh` chain)
- `Marvis_Auth.jar` staged at `Portal-main/iris-service/lib/`
- The vendor `MorfinAuthClientService.deb` accessible — defaults to
  `verification-portal/MorfinAuth_Linux_Web_SDK_1.0.0.0/Setup/`,
  override via `MORFIN_DEB=/path/to.deb`
- `nssm.exe` (64-bit) staged at
  `Portal-main/client-bootstrap/windows/tools/nssm.exe`. Download from
  [nssm.cc/download](https://nssm.cc/download) (BSD-style licence; safe
  to ship). It's a single ~250 KB executable.

Then:

```bash
cd Portal-main/client-bootstrap/windows
./build-bundle.sh
# → dist/VerificationPortalClient-1.0.0-windows.zip
```

The script:

1. Builds `mantra-iris-service-<ver>.jar` via `mvn package`.
2. Extracts the vendor MorFin `.deb` to lift the daemon JAR + the three
   `.crt` files from its NSS bundle.
3. Copies `Marvis_Auth.jar` from the staged location.
4. Stages `nssm.exe` if present (warns and continues otherwise — the
   bundle won't install on Windows without it).
5. Zips everything into `dist/`.

## Field install (operator laptop)

1. **Install Java** — Adoptium Temurin JRE 17 from
   [adoptium.net](https://adoptium.net/), tick "Add to PATH".
2. Unzip the bundle anywhere.
3. Open PowerShell **as Administrator** in the unzipped folder.
4. Run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1 -PortalUrl https://portal.example.com
   ```

What `install.ps1` does, in order:

| Step | Action | Why |
|------|--------|-----|
| 1    | Verifies Admin + `java` on PATH | Services + `Cert:\LocalMachine\Root` need elevation; JAR needs JVM. |
| 2    | Copies bundle to `C:\Program Files\VerificationPortal\` | Stable install root, survives user logout. |
| 3    | Imports vendor `.crt` files into `Cert:\LocalMachine\Root` | Lets browsers trust the daemon's HTTPS cert. |
| 4    | Registers `MorfinAuthClientService` (port 8030) via `nssm` | Auto-start on boot, restart on crash. |
| 5    | Registers `MantraIrisService` (port 8031) with `IRIS_PROVIDER=marvis-strict` | Fail-closed if the SDK can't load — better than fake scores. |
| 6    | Writes Chrome + Edge `HomepageLocation` policy in `HKLM` | Locks the homepage for every user on the machine. |
| 7    | Drops `.url` shortcuts on Desktop + Start Menu | Visible launcher. |

Idempotent: re-running `install.ps1` updates everything in place
(services are stopped + re-registered, certs re-imported, policy
overwritten).

## Why we don't ship an `.msi`

`.msi` is the conventional Windows enterprise format and tools like
`jpackage` can produce one from the same JAR. The reason we ship a zip
+ PowerShell installer instead:

- Two services with their own env / logging configuration are awkward
  to express in WiX/MSI without a lot of custom-action XML; a script is
  simpler to read and audit.
- Field IT can edit `install.ps1` if a center has unusual paths or
  policy needs — much harder to patch a signed `.msi`.
- The bundle is portable from a USB stick to an offline machine; an
  `.msi` would still need PowerShell post-actions for the cert + policy
  steps anyway.

If a future deployment target requires `.msi` (Intune, SCCM), wrap
`install.ps1` in a `jpackage --type msi` shell or author a small WiX
project that calls into the same script. The pieces in this bundle are
the inputs either way.
