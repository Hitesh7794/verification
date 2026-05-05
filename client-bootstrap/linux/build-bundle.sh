#!/usr/bin/env bash
# build-bundle.sh — assemble the Linux operator-laptop install bundle.
#
# Output: dist/verification-portal-client_<version>_linux.tar.gz
#
# The bundle contains:
#   - install.sh                            (bootstrap entry point)
#   - morfinauth-client-service.deb         (vendor; passed in or sourced)
#   - mantra-iris-service_<ver>_all.deb     (built from ../iris-service)
#   - verification-portal-client_<ver>.deb  (built from ./meta-deb)
#
# Run on a Linux build host with `mvn`, `dpkg-deb` available. macOS dev
# can do everything except the dpkg-deb step — for that, use a Linux
# container or VM. Vendor JAR (Marvis_Auth.jar) must be staged in
# ../../iris-service/lib/ before running.

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

VERSION="1.0.0"
BUNDLE_NAME="verification-portal-client_${VERSION}_linux"

# Resolve the vendor MorFin .deb. Default location is the SDK folder
# alongside the project; override via MORFIN_DEB env var.
MORFIN_DEB="${MORFIN_DEB:-${ROOT}/../MorfinAuth_Linux_Web_SDK_1.0.0.0/Setup/MorfinAuthClientService.deb}"
if [ ! -f "$MORFIN_DEB" ]; then
    echo "✗ MorFin .deb not found at $MORFIN_DEB" >&2
    echo "  Set MORFIN_DEB=/path/to/MorfinAuthClientService.deb and re-run." >&2
    exit 1
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "✗ dpkg-deb required; run this script on a Linux host (or container)." >&2
    exit 1
fi

OUT="dist/$BUNDLE_NAME"
rm -rf "$OUT" && mkdir -p "$OUT"

# 1. Bundle the vendor MorFin .deb verbatim.
cp "$MORFIN_DEB" "$OUT/morfinauth-client-service.deb"

# 2. Build the iris service .deb.
echo "→ building iris service .deb"
( cd "${ROOT}/iris-service" && ./build-deb.sh )
cp "${ROOT}/iris-service/dist/mantra-iris-service_"*"_all.deb" "$OUT/"

# 3. Build this meta-package .deb.
echo "→ building verification-portal-client meta-deb"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -a meta-deb/. "$STAGE/"
sed -i "s/^Version: .*/Version: ${VERSION}/" "$STAGE/DEBIAN/control"
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm"
find "$STAGE/usr" -type d -exec chmod 0755 {} \;
find "$STAGE/usr" -type f -exec chmod 0644 {} \;
META_DEB="verification-portal-client_${VERSION}_all.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT/$META_DEB"

# 4. Drop in the bootstrap install.sh and a README.
cp install.sh "$OUT/install.sh"
chmod 0755 "$OUT/install.sh"
cat > "$OUT/README.txt" <<EOF
Verification Portal — operator-laptop install bundle (Linux)
Version: ${VERSION}

To install on a fresh Ubuntu 18.04+ laptop:

  sudo ./install.sh https://your-portal-url

What this installs:
  - morfinauth-client-service  (Mantra fingerprint daemon, port 8030)
  - mantra-iris-service        (Mantra iris service, port 8031)
  - verification-portal-client (browser homepage + desktop launcher)

After install:
  - Verify daemons: systemctl status morfinauth-client-service mantra-iris-service
  - Test in browser: visit the portal URL; the device dot should turn green
    when a Mantra reader is plugged in.
EOF

# 5. Tarball.
mkdir -p dist
tar -C dist -czf "dist/${BUNDLE_NAME}.tar.gz" "$BUNDLE_NAME"
echo "✓ built dist/${BUNDLE_NAME}.tar.gz"
echo "  contents:"
( cd "$OUT" && ls -la )
