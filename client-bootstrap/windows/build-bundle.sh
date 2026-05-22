#!/usr/bin/env bash
# build-bundle.sh — assemble the Windows operator-laptop install bundle.
#
# Cross-platform: runs on macOS / Linux / Windows (under WSL or git-bash).
# Pulls together:
#   - vendor MorFin JAR + TLS certs extracted from the vendor .deb
#     (Windows hosts the MorFin daemon natively — its DLLs work on Windows)
#   - Startek/ACPL Capture API MSI + VC++ redist (from Setup_ACPL_L1_API/)
#     (Windows-native MSI; registers its own Windows service on install)
#   - mantra-iris-service .deb built from ../../iris-service
#     (the iris service runs INSIDE WSL2 because the Marvis SDK's Windows
#     DLL has a JNI signature mismatch — see IRIS_VENDOR_ISSUE.md)
#   - install.ps1 + wsl-iris-setup.sh + tools/nssm.exe
#
# Output: dist/VerificationPortalClient-<version>-windows.zip

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

VERSION="1.0.0"
BUNDLE_NAME="VerificationPortalClient-${VERSION}-windows"

# --- inputs ---------------------------------------------------------------
MORFIN_DEB="${MORFIN_DEB:-${ROOT}/../MorfinAuth_Linux_Web_SDK_1.0.0.0/Setup/MorfinAuthClientService.deb}"
NSSM_EXE="${NSSM_EXE:-${ROOT}/client-bootstrap/windows/tools/nssm.exe}"
# Startek/ACPL Capture API package — vendor-supplied tree containing the
# MSI, the VC++ redist, and demo HTML test pages. Optional: if absent, the
# bundle still builds, install.ps1 just skips the Startek phase.
STARTEK_DIR="${STARTEK_DIR:-${ROOT}/Setup_ACPL_L1_API}"

if [ ! -f "$MORFIN_DEB" ]; then
    echo "✗ MorFin .deb not found at $MORFIN_DEB" >&2
    echo "  Set MORFIN_DEB=/path/to/MorfinAuthClientService.deb" >&2
    exit 1
fi

if [ ! -f "$NSSM_EXE" ]; then
    echo "⚠ tools/nssm.exe missing." >&2
    echo "  Download nssm 2.24+ from https://nssm.cc/download" >&2
    echo "  Place the 64-bit nssm.exe at $NSSM_EXE" >&2
    echo "  (Continuing — bundle will fail to install on Windows without it.)" >&2
fi

if ! command -v mvn >/dev/null 2>&1; then
    echo "✗ mvn required to build mantra-iris-service.deb" >&2
    exit 1
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "✗ dpkg-deb required to build mantra-iris-service.deb" >&2
    echo "  On macOS: brew install dpkg" >&2
    echo "  On Linux: apt-get install dpkg" >&2
    exit 1
fi

# --- iris .deb (will be installed inside WSL2 on the operator laptop) ----
echo "→ building mantra-iris-service .deb"
( cd "${ROOT}/iris-service" && ./build-deb.sh )
IRIS_DEB=$(ls "${ROOT}/iris-service/dist/mantra-iris-service_"*"_all.deb" | head -n1)
if [ ! -f "$IRIS_DEB" ]; then
    echo "✗ iris .deb build failed" >&2
    exit 1
fi

# --- vendor JARs + certs (extracted from MorFin .deb) --------------------
echo "→ extracting MorFin .deb"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
( cd "$WORK" && ar x "$MORFIN_DEB" )
mkdir -p "$WORK/data"
tar -xf "$WORK/data.tar.xz" -C "$WORK/data"

MORFIN_JAR=$(find "$WORK/data" -name "morfinauth-client-service-*.jar" | head -n1)
CERT_DIR=$(find "$WORK/data" -type d -name "morfinauth-client-service" -path "*/ca-certificates/*" | head -n1)
if [ -z "$MORFIN_JAR" ] || [ ! -f "$MORFIN_JAR" ]; then
    echo "✗ couldn't find MorFin JAR inside the .deb" >&2
    exit 1
fi

# --- assemble bundle ------------------------------------------------------
OUT="dist/$BUNDLE_NAME"
rm -rf "$OUT" && mkdir -p "$OUT/morfin/certs" "$OUT/iris-wsl" "$OUT/tools" "$OUT/startek"

# Windows-side: MorFin daemon JAR + certs (works native on Windows)
cp "$MORFIN_JAR" "$OUT/morfin/"
[ -d "$CERT_DIR" ] && cp "$CERT_DIR"/*.crt "$OUT/morfin/certs/" || true

# WSL-side: iris service .deb (gets dpkg-installed inside the WSL distro)
cp "$IRIS_DEB" "$OUT/iris-wsl/"

# Windows-side: Startek/ACPL Capture API MSI + VC++ redist prereq.
# Both files come from the vendor SDK package shipped by ACPL
# (Setup_ACPL_L1_API/). Optional — if STARTEK_DIR is missing or the
# MSI isn't there, install.ps1 just skips the Startek phase.
if [ -d "$STARTEK_DIR" ]; then
    STARTEK_MSI=$(ls "$STARTEK_DIR"/L1_API_Setup_*.msi 2>/dev/null | head -n1 || true)
    if [ -n "$STARTEK_MSI" ] && [ -f "$STARTEK_MSI" ]; then
        cp "$STARTEK_MSI" "$OUT/startek/"
        echo "  staged startek MSI: $(basename "$STARTEK_MSI")"
    else
        echo "  ⚠ Startek MSI not found in $STARTEK_DIR (L1_API_Setup_*.msi)" >&2
    fi
    # VC++ 2017 x86 redist (required by ACPLAPI.DLL). Prefer the
    # VC17_redist build that ACPL bundles; fall back to vcredist_x86 if
    # only the older one is staged.
    if [ -f "$STARTEK_DIR/Dependencies/VC17_redist.x86.exe" ]; then
        cp "$STARTEK_DIR/Dependencies/VC17_redist.x86.exe" "$OUT/startek/"
    elif [ -f "$STARTEK_DIR/Dependencies/vcredist_x86.exe" ]; then
        cp "$STARTEK_DIR/Dependencies/vcredist_x86.exe" "$OUT/startek/VC17_redist.x86.exe"
        echo "  ⚠ using older vcredist_x86.exe (VC17_redist.x86.exe not found)" >&2
    fi
else
    echo "  (Setup_ACPL_L1_API/ not present at $STARTEK_DIR — bundling without Startek)"
fi

# Tooling
[ -f "$NSSM_EXE" ] && cp "$NSSM_EXE" "$OUT/tools/" || true

# Scripts (install.ps1 + the WSL provisioning script it invokes)
cp install.ps1         "$OUT/install.ps1"
cp wsl-iris-setup.sh   "$OUT/wsl-iris-setup.sh"

cat > "$OUT/README.txt" <<EOF
Verification Portal — operator-laptop install bundle (Windows)
Version: ${VERSION}

Prerequisites on the operator laptop:
  - Windows 10 (build 19041 / version 2004 May 2020 Update or newer)
    or Windows 11 — 64-bit only.
  - Virtualization enabled in BIOS/UEFI (most modern laptops on by default).
  - Adoptium Temurin JRE 17 on PATH (https://adoptium.net/temurin/releases/?version=17)
  - Internet for first install (downloads WSL kernel + Ubuntu image).

Install in an *elevated* PowerShell (Run as Administrator):

  Set-ExecutionPolicy -Scope Process Bypass
  .\install.ps1 -PortalUrl https://your-portal-url

If WSL2 isn't already enabled, the script enables the Windows features and
asks you to reboot. After reboot, re-run the same command — it picks up
where it left off.

What this installs:
  - MorfinAuthClientService    (Mantra MorFin fingerprint daemon, native
                                Windows service, port 8030)
  - ACPL Capture API service   (Startek FM220U L1 / AST300 fingerprint
                                daemon, native Windows service, MSI-installed,
                                ports 4443 HTTPS + 8090 HTTP)
  - WSL2 Ubuntu-22.04 distro hosting mantra-iris-service (iris, port 8031)
  - usbipd-win — passes the MIS100V2 iris USB device into WSL
  - VerificationPortal-IrisUsbAttach scheduled task — auto-attaches the
    iris device to WSL on every boot
  - Browser homepage policy (Chrome + Edge), Cert:\LocalMachine\Root
    cert imports, Desktop + Start Menu shortcuts.

Both fingerprint vendors run side-by-side. The frontend polls both
daemons in parallel and binds to whichever has a device plugged in —
the operator never has to pick. If a deployment only uses one vendor,
pass -SkipStartek or remove the corresponding service afterwards.

Startek prerequisite NOT bundled (must be installed separately):
  - Windows Certified RD Service for L1 Devices
    Download from https://acpl.in.net/RdService.html and run its setup.
    Required for the Capture API to take exclusive USB access. install.ps1
    warns if it's missing.

Why iris runs in WSL:
  Mantra's Marvis_Auth.jar bundles native Windows DLLs whose JNI
  callback signatures don't match the Java classes in the same JAR
  (verified against bytecode — see IRIS_VENDOR_ISSUE.md). The Linux
  .so files in the same JAR work correctly. WSL2 + usbipd lets us
  use the working Linux binaries even on a Windows operator laptop.
  When Mantra ships a corrected Windows DLL, switching back to a
  Windows-native iris service is a one-flag change in install.ps1.

After install — smoke tests:
  curl http://localhost:8030/                                  # Mantra MorFin
  curl http://localhost:8090/FM220/getserial                   # Startek (HTTP)
  curl -k https://localhost:4443/FM220/getserial               # Startek (HTTPS)
  curl -X POST http://localhost:8031/iris/supporteddevicelist  # Iris (via WSL)
  Get-Service MorfinAuthClientService                          # native MorFin
  Get-Service *ACPL* -ErrorAction SilentlyContinue             # native Capture API
  wsl -d Ubuntu-22.04 -- systemctl status mantra-iris-service  # WSL iris
  Get-ScheduledTask VerificationPortal-IrisUsbAttach           # USB attacher

Uninstall:
  # Windows-side services + policies
  Stop-Service MorfinAuthClientService -Force
  & "C:\Program Files\VerificationPortal\tools\nssm.exe" remove MorfinAuthClientService confirm
  Unregister-ScheduledTask -TaskName VerificationPortal-IrisUsbAttach -Confirm:\$false
  Remove-Item -Recurse "C:\Program Files\VerificationPortal"
  Remove-Item HKLM:\SOFTWARE\Policies\Google\Chrome\HomepageLocation
  Remove-Item HKLM:\SOFTWARE\Policies\Microsoft\Edge\HomepageLocation
  # WSL-side iris service
  wsl -d Ubuntu-22.04 -- sudo apt-get purge -y mantra-iris-service
  # Optional — full WSL distro removal:
  # wsl --unregister Ubuntu-22.04
EOF

# --- zip ------------------------------------------------------------------
mkdir -p dist
( cd dist && rm -f "${BUNDLE_NAME}.zip" && zip -qr "${BUNDLE_NAME}.zip" "$BUNDLE_NAME" )
echo "✓ built dist/${BUNDLE_NAME}.zip"
echo "  contents:"
( cd "$OUT" && find . -type f -maxdepth 3 | sort )
