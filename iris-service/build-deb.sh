#!/usr/bin/env bash
# build-deb.sh — assemble mantra-iris-service.deb on a Linux host.
#
# Run from the iris-service/ directory. Requires:
#   - Maven  (mvn)
#   - dpkg-deb
#   - Marvis_Auth.jar copied into ./lib/ (acquired separately from
#     vendor; not redistributable, hence not committed)
#
# Output: dist/mantra-iris-service_<version>_all.deb

set -euo pipefail

cd "$(dirname "$0")"

VERSION="$(awk -F'[<>]' '/<version>/{print $3; exit}' pom.xml)"
PKG_NAME="mantra-iris-service"
DEB_NAME="${PKG_NAME}_${VERSION}_all.deb"

if [ ! -f lib/Marvis_Auth.jar ]; then
    echo "✗ lib/Marvis_Auth.jar missing — copy it from the vendor SDK" >&2
    echo "  (Marvis_Auth_Linux_Java_1.0.0.0/Libs/Marvis_Auth.jar)" >&2
    exit 1
fi

echo "→ building shaded jar"
mvn -q clean package -DskipTests=false

# Stage the .deb file tree.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -a packaging/debian/. "$STAGE/"

INSTALL_DIR="$STAGE/usr/local/${PKG_NAME}"
mkdir -p "$INSTALL_DIR"
cp "target/${PKG_NAME}-${VERSION}.jar" "$INSTALL_DIR/${PKG_NAME}.jar"
cp lib/Marvis_Auth.jar "$INSTALL_DIR/Marvis_Auth.jar"

# Stamp the version into the control file so dpkg uses the pom value.
sed -i "s/^Version: .*/Version: ${VERSION}/" "$STAGE/DEBIAN/control"

# Permissions matter to dpkg.
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm"
find "$STAGE/etc" "$STAGE/usr" -type d -exec chmod 0755 {} \;
find "$STAGE/etc" "$STAGE/usr" -type f -exec chmod 0644 {} \;

mkdir -p dist
dpkg-deb --build --root-owner-group "$STAGE" "dist/${DEB_NAME}"

echo "✓ built dist/${DEB_NAME}"
