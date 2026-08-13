#!/usr/bin/env bash
# build-bundle.sh — assemble the Windows operator-laptop install bundle.
#
# Cross-platform: runs on macOS / Linux / Windows (under WSL or git-bash).
# Pulls together:
#   - vendor MorFin JAR + TLS certs extracted from the vendor .deb
#     (Windows hosts the MorFin daemon natively via nssm — its DLLs work)
#   - Startek/ACPL Capture API MSI + VC++ redist (from Setup_ACPL_L1_API/)
#     (Windows-native MSI; registers its own Windows service on install)
#   - Marvis Auth Client Service installer (MarvisAuthClientService.exe)
#     from Mantra's Marvis Auth Web SDK 1.4.0.0+ package. Native Windows
#     service — no WSL, no JAR. Retired the old WSL2 workaround, see
#     IRIS_NOTES.md for the story.
#   - install.ps1 + tools/nssm.exe + Adoptium Temurin JRE 17 for MorFin
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
# Marvis Auth Client Service installer (native Windows iris daemon).
# Not committed to git — see client-bootstrap/windows/vendor/README.md
# for the download source. Falls back to skipping the iris payload if
# absent so fingerprint-only builds still succeed.
MARVIS_EXE="${MARVIS_EXE:-${ROOT}/client-bootstrap/windows/vendor/MarvisAuthClientService.exe}"
# IriTech / Mantra IriShield (MIS100V2) USB driver installer. Mantra's
# MYUSB driver only covers their fingerprint devices (VID 2C0F);
# IriShield uses IriTech's USB stack (VID 1F63) which needs this
# separate installer. Optional — if absent, install.ps1 warns and
# falls back to "install the driver manually" instructions.
MIS100V2_DRIVER_EXE="${MIS100V2_DRIVER_EXE:-${ROOT}/client-bootstrap/windows/vendor/MIS100V2_Driver.exe}"
# Mantra MorFin fingerprint USB driver installer. Newest version wins;
# install.ps1 globs MorFinDriver_*.exe so any 1.x version is picked up.
# Optional — an already-deployed laptop with the driver in the Windows
# driver store doesn't need a re-install.
MORFIN_DRIVER_EXE="${MORFIN_DRIVER_EXE:-$(ls "${ROOT}/client-bootstrap/windows/vendor/"MorFinDriver_*.exe 2>/dev/null | sort -Vr | head -n1)}"
# Startek/ACPL Capture API package — vendor-supplied tree containing the
# MSI, the VC++ redist, and demo HTML test pages. Optional: if absent, the
# bundle still builds, install.ps1 just skips the Startek phase.
STARTEK_DIR="${STARTEK_DIR:-${ROOT}/Setup_ACPL_L1_API}"

# Bundled JRE for the MorFin daemon. The operator laptop's Java install
# story used to be a manual prereq ("Adoptium JRE 17 on PATH" — a step
# operators routinely got wrong). We now ship a private JRE inside the
# bundle so install.ps1 can point nssm directly at a known java.exe.
#
# The redistributable URL from Adoptium's release API returns the latest
# GA build for the requested version+platform. The download is cached
# under .cache/ so re-builds are fast and offline-friendly.
JRE_VERSION="${JRE_VERSION:-17}"
JRE_URL="${JRE_URL:-https://api.adoptium.net/v3/binary/latest/${JRE_VERSION}/ga/windows/x64/jre/hotspot/normal/eclipse}"
JRE_CACHE_DIR="${JRE_CACHE_DIR:-${ROOT}/client-bootstrap/windows/.cache}"
JRE_CACHE_FILE="${JRE_CACHE_DIR}/adoptium-jre${JRE_VERSION}-windows-x64.zip"

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

# --- bundled JRE (fetched once, cached) -----------------------------------
mkdir -p "$JRE_CACHE_DIR"
if [ ! -f "$JRE_CACHE_FILE" ]; then
    echo "→ fetching Adoptium Temurin JRE ${JRE_VERSION} (Windows x64)"
    if ! curl -fsSL --retry 3 -o "${JRE_CACHE_FILE}.partial" "$JRE_URL"; then
        echo "✗ JRE download failed from $JRE_URL" >&2
        rm -f "${JRE_CACHE_FILE}.partial"
        exit 1
    fi
    mv "${JRE_CACHE_FILE}.partial" "$JRE_CACHE_FILE"
    echo "  cached at $JRE_CACHE_FILE ($(du -h "$JRE_CACHE_FILE" | cut -f1))"
else
    echo "→ using cached JRE at $JRE_CACHE_FILE ($(du -h "$JRE_CACHE_FILE" | cut -f1))"
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
rm -rf "$OUT" && mkdir -p "$OUT/morfin/certs" "$OUT/vendor" "$OUT/tools" "$OUT/startek"

# Windows-side: MorFin daemon JAR + certs (works native on Windows)
cp "$MORFIN_JAR" "$OUT/morfin/"
[ -d "$CERT_DIR" ] && cp "$CERT_DIR"/*.crt "$OUT/morfin/certs/" || true

# Windows-side: MorFin USB fingerprint driver installer. install.ps1
# looks for MorFinDriver_*.exe in the morfin/ dir and runs it silently
# on first install; skipped if the driver is already in Windows'
# driver store. Optional — if absent, install.ps1 warns and assumes
# a prior install left the driver in place.
if [ -n "${MORFIN_DRIVER_EXE:-}" ] && [ -f "$MORFIN_DRIVER_EXE" ]; then
    cp "$MORFIN_DRIVER_EXE" "$OUT/morfin/$(basename "$MORFIN_DRIVER_EXE")"
    echo "  staged MorFin driver: $(basename "$MORFIN_DRIVER_EXE") ($(du -h "$MORFIN_DRIVER_EXE" | cut -f1))"
else
    echo "  ⚠ MorFinDriver_*.exe not found under vendor/ (driver install will be skipped on fresh laptops)" >&2
fi

# Windows-side: bundled JRE (private, used only by the MorFin service).
# We extract into a temp dir, then move the single top-level "jdk-...-jre/"
# folder to morfin/jre/ — install.ps1 expects bin/java.exe at exactly
# morfin/jre/bin/java.exe regardless of which Temurin point release we
# pulled. Flattening here means install.ps1 never has to glob a version
# suffix at runtime.
echo "→ unpacking JRE into $OUT/morfin/jre/"
JRE_TMP="$(mktemp -d)"
trap 'rm -rf "$JRE_TMP" "$WORK"' EXIT
unzip -q "$JRE_CACHE_FILE" -d "$JRE_TMP"
JRE_INNER_DIR=$(find "$JRE_TMP" -maxdepth 1 -mindepth 1 -type d | head -n1)
if [ -z "$JRE_INNER_DIR" ] || [ ! -d "$JRE_INNER_DIR/bin" ]; then
    echo "✗ unpacked JRE didn't contain the expected jdk-*-jre/bin/ tree" >&2
    exit 1
fi
mv "$JRE_INNER_DIR" "$OUT/morfin/jre"
echo "  jre/bin/java.exe -> $(ls "$OUT/morfin/jre/bin/java.exe" 2>/dev/null || echo MISSING)"

# Windows-side: Marvis Auth iris installer.
# Optional — if absent, install.ps1 warns and skips the iris phase so
# fingerprint-only fleets can still deploy from a partial bundle.
if [ -f "$MARVIS_EXE" ]; then
    cp "$MARVIS_EXE" "$OUT/vendor/MarvisAuthClientService.exe"
    echo "  staged Marvis iris installer: $(du -h "$MARVIS_EXE" | cut -f1)"
else
    echo "  ⚠ MarvisAuthClientService.exe not found at $MARVIS_EXE (iris phase will be skipped on install)" >&2
    echo "     See client-bootstrap/windows/vendor/README.md for the download source." >&2
fi

# Windows-side: IriShield / MIS100V2 USB driver installer.
# Ships alongside the Marvis service installer so first-time operator
# laptops get the driver + service in one pass. Also optional — an
# already-deployed laptop that just needs a service upgrade doesn't
# need it.
if [ -f "$MIS100V2_DRIVER_EXE" ]; then
    cp "$MIS100V2_DRIVER_EXE" "$OUT/vendor/MIS100V2_Driver.exe"
    echo "  staged IriShield driver: $(du -h "$MIS100V2_DRIVER_EXE" | cut -f1)"
else
    echo "  ⚠ MIS100V2_Driver.exe not found at $MIS100V2_DRIVER_EXE (iris driver install will be skipped)" >&2
    echo "     See client-bootstrap/windows/vendor/README.md for the download source." >&2
fi

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

# Scripts
cp install.ps1   "$OUT/install.ps1"
cp uninstall.ps1 "$OUT/uninstall.ps1"

cat > "$OUT/README.txt" <<EOF
Verification Portal — operator-laptop install bundle (Windows)
Version: ${VERSION}

Prerequisites on the operator laptop:
  - Windows 10 (build 17763 / 1809 October 2018 update or newer)
    or Windows 11 — 64-bit only.
  - Java is BUNDLED — no separate JRE install needed. The bundle ships
    its own Adoptium Temurin JRE 17 under morfin/jre/, used privately
    by the MorFin daemon. Operator PATH is not modified.
  - Internet is NOT required for install — everything is bundled.

Install in an *elevated* PowerShell (Run as Administrator):

  Set-ExecutionPolicy -Scope Process Bypass
  .\install.ps1 -PortalUrl https://your-portal-url

What this installs:
  - IriShield / MIS100V2 driver  (IriTech USB driver for VID 1F63, must
                                  be installed before the Marvis service
                                  registers or the scanner reports -1307)
  - Marvis Auth Client Service   (Mantra iris daemon, native Windows
                                  service, port 8031, self-registered
                                  by MarvisAuthClientService.exe)
  - MorfinAuthClientService      (Mantra MorFin fingerprint daemon,
                                  native Windows service via nssm,
                                  port 8030)
  - ACPL Capture API service     (Startek FM220U L1 / AST300 daemon,
                                  MSI-installed native service, ports
                                  4443 HTTPS + 8090 HTTP)
  - Browser homepage policy (Chrome + Edge), Cert:\LocalMachine\Root
    cert imports, Desktop + Start Menu shortcuts.

Both fingerprint vendors run side-by-side. The frontend polls both
daemons in parallel and binds to whichever has a device plugged in —
the operator never has to pick. If a deployment only uses one vendor,
pass -SkipStartek.

Iris hardware not part of the deployment? Pass -SkipIris.

Startek prerequisite NOT bundled (must be installed separately):
  - Windows Certified RD Service for L1 Devices
    Download from https://acpl.in.net/RdService.html and run its setup.
    Required for the Capture API to take exclusive USB access. install.ps1
    warns if it's missing.

After install — smoke tests:
  curl.exe http://localhost:8030/                                # Mantra MorFin
  curl.exe http://localhost:8090/FM220/getserial                 # Startek (HTTP)
  curl.exe -k https://localhost:4443/FM220/getserial             # Startek (HTTPS)
  curl.exe -X POST http://localhost:8031/marvisauth/info         # Marvis iris
  Get-Service MorfinAuthClientService                            # native MorFin
  Get-Service *ACPL* -ErrorAction SilentlyContinue               # native Capture API
  Get-Service *Marvis*                                           # native iris

Uninstall:
  .\uninstall.ps1 -RemoveDriver -RemoveStartek -RemoveIris -RemoveCerts
EOF

# --- zip ------------------------------------------------------------------
mkdir -p dist
( cd dist && rm -f "${BUNDLE_NAME}.zip" && zip -qr "${BUNDLE_NAME}.zip" "$BUNDLE_NAME" )
echo "✓ built dist/${BUNDLE_NAME}.zip"
echo "  contents:"
( cd "$OUT" && find . -type f -maxdepth 3 | sort )
