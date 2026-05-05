#!/usr/bin/env bash
# build-bundle.sh — assemble the Windows operator-laptop install bundle.
#
# Cross-platform: runs on macOS / Linux / Windows (under WSL or git-bash)
# because everything inside the Windows bundle is data, not built. We
# extract the vendor MorFin .deb to lift its JAR + certs, build our iris
# service jar with mvn, and zip the result.
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
    echo "✗ mvn required to build mantra-iris-service.jar" >&2
    exit 1
fi

# --- iris jar -------------------------------------------------------------
echo "→ building iris service shaded jar"
( cd "${ROOT}/iris-service" && mvn -q clean package -DskipTests=false )
IRIS_JAR=$(ls "${ROOT}/iris-service/target/mantra-iris-service-"*.jar | head -n1)
if [ ! -f "$IRIS_JAR" ]; then
    echo "✗ iris jar build failed" >&2
    exit 1
fi

# --- vendor JARs + certs (extracted from the .deb's data tarball) ---------
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

# Marvis JAR (used by iris service at runtime — bundled alongside our jar
# and pulled into classpath via the `Class-Path` manifest attribute that
# `mvn package`'s shade plugin emits, OR loaded via reflection when the
# iris service runs in IRIS_PROVIDER=marvis-strict mode).
MARVIS_JAR="${ROOT}/iris-service/lib/Marvis_Auth.jar"
if [ ! -f "$MARVIS_JAR" ]; then
    echo "✗ Marvis_Auth.jar missing at $MARVIS_JAR" >&2
    echo "  Copy it from Marvis_Auth_Linux_Java_1.0.0.0/Libs/" >&2
    exit 1
fi

# --- assemble bundle ------------------------------------------------------
OUT="dist/$BUNDLE_NAME"
rm -rf "$OUT" && mkdir -p "$OUT/morfin/certs" "$OUT/iris" "$OUT/tools"

cp "$MORFIN_JAR" "$OUT/morfin/"
[ -d "$CERT_DIR" ] && cp "$CERT_DIR"/*.crt "$OUT/morfin/certs/" || true
cp "$IRIS_JAR"    "$OUT/iris/"
cp "$MARVIS_JAR"  "$OUT/iris/"
[ -f "$NSSM_EXE" ] && cp "$NSSM_EXE" "$OUT/tools/" || true

cp install.ps1 "$OUT/install.ps1"

cat > "$OUT/README.txt" <<EOF
Verification Portal — operator-laptop install bundle (Windows)
Version: ${VERSION}

Prerequisites on the operator laptop:
  - Windows 10 or 11
  - Adoptium Temurin JRE 17 on PATH (https://adoptium.net/)

Install in an *elevated* PowerShell (Run as Administrator):

  Set-ExecutionPolicy -Scope Process Bypass
  .\install.ps1 -PortalUrl https://your-portal-url

What this installs:
  - MorfinAuthClientService  (Windows service, port 8030)
  - MantraIrisService         (Windows service, port 8031)
  - Verification Portal       (Desktop + Start Menu shortcut)
  - Pinned browser homepage in Chrome + Edge policy
  - Vendor TLS certs imported into Cert:\\LocalMachine\\Root

After install:
  Get-Service MorfinAuthClientService, MantraIrisService
  curl http://localhost:8030/
  curl http://localhost:8031/iris/supporteddevicelist -Method POST

Uninstall:
  Stop-Service MorfinAuthClientService, MantraIrisService
  & "C:\Program Files\VerificationPortal\tools\nssm.exe" remove MorfinAuthClientService confirm
  & "C:\Program Files\VerificationPortal\tools\nssm.exe" remove MantraIrisService confirm
  Remove-Item -Recurse "C:\Program Files\VerificationPortal"
  Remove-Item HKLM:\SOFTWARE\Policies\Google\Chrome\HomepageLocation
  Remove-Item HKLM:\SOFTWARE\Policies\Microsoft\Edge\HomepageLocation
EOF

# --- zip ------------------------------------------------------------------
mkdir -p dist
( cd dist && rm -f "${BUNDLE_NAME}.zip" && zip -qr "${BUNDLE_NAME}.zip" "$BUNDLE_NAME" )
echo "✓ built dist/${BUNDLE_NAME}.zip"
echo "  contents:"
( cd "$OUT" && find . -type f -maxdepth 3 | sort )
