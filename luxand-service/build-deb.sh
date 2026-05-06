#!/usr/bin/env bash
# build-deb.sh — assemble luxand-service.deb. Linux-only. Requires:
#   - Maven (mvn)
#   - dpkg-deb
#   - lib/FaceSDK.jar + lib/jna-5.18.1.jar (vendor wrappers, copied locally)
#   - native/linux-x86_64/libfsdk.so (vendor native, copied locally)
#
# Output: dist/luxand-service_<version>_amd64.deb

set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(awk -F'[<>]' '/<version>/{print $3; exit}' pom.xml)"
PKG=luxand-service
DEB="${PKG}_${VERSION}_amd64.deb"

for f in lib/FaceSDK.jar lib/jna-5.18.1.jar native/linux-x86_64/libfsdk.so; do
    [ -f "$f" ] || { echo "✗ missing: $f" >&2; exit 1; }
done

echo "→ building shaded jar"
mvn -q clean package

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -a packaging/debian/. "$STAGE/"

INSTALL_DIR="$STAGE/usr/local/${PKG}"
mkdir -p "$INSTALL_DIR/native"

cp "target/${PKG}-${VERSION}.jar" "$INSTALL_DIR/${PKG}.jar"
cp lib/FaceSDK.jar              "$INSTALL_DIR/"
cp lib/jna-5.18.1.jar           "$INSTALL_DIR/"
cp native/linux-x86_64/libfsdk.so "$INSTALL_DIR/native/"

sed -i "s/^Version: .*/Version: ${VERSION}/" "$STAGE/DEBIAN/control"
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm"
find "$STAGE/etc" "$STAGE/usr" -type d -exec chmod 0755 {} \;
find "$STAGE/etc" "$STAGE/usr" -type f -exec chmod 0644 {} \;
chmod 0755 "$INSTALL_DIR/native/libfsdk.so"

mkdir -p dist
dpkg-deb --build --root-owner-group "$STAGE" "dist/${DEB}"
echo "✓ built dist/${DEB}"
