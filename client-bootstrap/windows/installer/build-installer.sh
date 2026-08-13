#!/usr/bin/env bash
# build-installer.sh -- compile OperatorPortalSetup.iss into a signed-ish
# .exe using Inno Setup 6 running inside Docker (amake/innosetup image).
#
# Cross-compiles on macOS / Linux without needing a Windows box.
#
# Prerequisites:
#   1. Docker Desktop running.
#   2. build-bundle.sh has been run so the payload sits at
#      client-bootstrap/windows/dist/VerificationPortalClient-1.0.0-windows/
#
# Output:
#   client-bootstrap/windows/installer/output/OperatorPortalSetup-1.0.0.exe
#
# Portal URL override (optional):
#   PORTAL_URL=https://staging.example.com ./build-installer.sh
#   -- default is baked in via the .iss file's #define PortalUrl.

set -euo pipefail

cd "$(dirname "$0")"
INSTALLER_DIR="$(pwd)"
WINDOWS_DIR="$(cd .. && pwd)"

BUNDLE_DIR="${WINDOWS_DIR}/dist/VerificationPortalClient-1.0.0-windows"
if [ ! -d "$BUNDLE_DIR" ]; then
    echo "✗ Bundle payload not found at $BUNDLE_DIR" >&2
    echo "  Run ../build-bundle.sh first." >&2
    exit 1
fi

# Sanity-check the bundle has the iris payloads the .iss expects.
for f in vendor/MarvisAuthClientService.exe vendor/MIS100V2_Driver.exe; do
    if [ ! -f "$BUNDLE_DIR/$f" ]; then
        echo "⚠ Bundle missing $f -- installer will fail to compile the iris component" >&2
    fi
done

# Docker daemon reachable?
if ! docker version >/dev/null 2>&1; then
    echo "✗ Docker daemon isn't reachable. Start Docker Desktop and retry." >&2
    exit 1
fi

# The Inno Setup image expects the working tree mounted somewhere; we
# mount the whole windows/ dir so the .iss's relative ..\dist path
# resolves correctly.
IMAGE="amake/innosetup:latest"
echo "→ pulling $IMAGE (first run only)"
docker pull "$IMAGE" >/dev/null

# Optional URL override for one-off staging builds.
DEFINE_ARGS=()
if [ -n "${PORTAL_URL:-}" ]; then
    DEFINE_ARGS+=(/DPortalUrl="$PORTAL_URL")
    echo "→ overriding baked portal URL with: $PORTAL_URL"
fi

echo "→ compiling installer via Inno Setup 6 (Docker)"
mkdir -p "$INSTALLER_DIR/output"
docker run --rm \
    -v "$WINDOWS_DIR":/work \
    -w /work/installer \
    "$IMAGE" \
    ${DEFINE_ARGS[@]+"${DEFINE_ARGS[@]}"} \
    OperatorPortalSetup.iss

OUT="$INSTALLER_DIR/output/OperatorPortalSetup-1.0.0.exe"
if [ ! -f "$OUT" ]; then
    echo "✗ Compilation succeeded but output .exe not found at $OUT" >&2
    exit 1
fi

echo ""
echo "✓ built $OUT"
echo "  size: $(du -h "$OUT" | cut -f1)"
echo "  md5:  $(md5 -q "$OUT" 2>/dev/null || md5sum "$OUT" | cut -d' ' -f1)"
