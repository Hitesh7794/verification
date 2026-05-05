# `client-bootstrap/` — operator-laptop install bundles

This directory builds the **single-command install bundle** that IT runs
on each operator laptop. The bundle takes a fresh laptop from "no
software" to "browser opens with the portal homepage and both vendor
daemons listening on `:8030` and `:8031`".

```
client-bootstrap/
├── linux/         → verification-portal-client_<ver>_linux.tar.gz
└── windows/       → VerificationPortalClient-<ver>-windows.zip
```

Both bundles ship the same three things, just packaged for the host OS:

1. **MorFin daemon** (vendor `.deb` payload, or its JAR on Windows) on
   `:8030`. The vendor daemon JAR is multi-platform — same binary runs
   on Linux and Windows, only the install glue differs.
2. **Mantra iris service** (our `mantra-iris-service.jar`) on `:8031`,
   wrapping `Marvis_Auth.jar`.
3. **Browser homepage + desktop launcher** pointing at the portal URL.

## Why a bundle and not an APT/`winget` repo?

In the field, operator centers may not have reliable internet, and IT is
often handed a USB stick, not a managed deployment pipeline. A
self-contained bundle that installs in one command from a thumb drive
is the lowest-friction install story.

For a future fleet-managed deployment, the per-component `.deb`s and
`.msi` can also be served from a private APT repo / Intune package, but
that's not the default path.

## Linux

See [`linux/README.md`](./linux/README.md). Build artifact:

```
verification-portal-client_<version>_linux.tar.gz
├── install.sh
├── morfinauth-client-service.deb        (vendor)
├── mantra-iris-service_<ver>_all.deb    (built from ../iris-service)
└── verification-portal-client_<ver>_all.deb  (this directory's meta-package)
```

IT command on a fresh Ubuntu 18.04+ laptop:

```bash
tar xzf verification-portal-client_*_linux.tar.gz
cd verification-portal-client_*_linux/
sudo ./install.sh https://portal.example.com
```

## Windows

See [`windows/README.md`](./windows/README.md). Build artifact:

```
VerificationPortalClient-<version>-windows.zip
├── install.ps1
├── morfin/morfinauth-client-service-1.0.0.0.jar
├── morfin/certs/*.crt
├── iris/mantra-iris-service-<ver>.jar
├── iris/Marvis_Auth.jar
├── tools/nssm.exe                       (Windows service registrar)
└── README.txt
```

IT command on a fresh Windows 10/11 laptop (PowerShell as Administrator):

```powershell
Expand-Archive VerificationPortalClient-*-windows.zip .
cd VerificationPortalClient-*-windows
.\install.ps1 -PortalUrl https://portal.example.com
```

## Java runtime

Both bundles assume Java 11+ is available (`java -version` works).
- Linux: declared as a `Depends:` (`default-jre | openjdk-17-jre`); apt
  pulls it from the host's package repository.
- Windows: the installer checks for `java` on `PATH` and prints a
  download link if missing. Bundling a JRE in the zip is possible (use
  `jlink` to slim it to ~50 MB) but adds a maintenance surface; we
  defer it until field experience justifies it.
