#!/usr/bin/env bash
# build-deb.sh — assemble fp-match-service.deb. Requires:
#   - Maven (mvn)
#   - dpkg-deb
#
# No vendor staging step (unlike luxand-service): SourceAFIS is a pure-
# Java Maven dependency, included in the shaded fat jar.
#
# Output: dist/fp-match-service_<version>_all.deb

set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(awk -F'[<>]' '/<version>/{print $3; exit}' pom.xml)"
PKG=fp-match-service
DEB="${PKG}_${VERSION}_all.deb"

echo "→ building shaded jar"
mvn -q clean package

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -a packaging/debian/. "$STAGE/"

INSTALL_DIR="$STAGE/usr/local/${PKG}"
mkdir -p "$INSTALL_DIR"

cp "target/${PKG}-${VERSION}.jar" "$INSTALL_DIR/${PKG}.jar"

sed -i "s/^Version: .*/Version: ${VERSION}/" "$STAGE/DEBIAN/control"
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm"
find "$STAGE/etc" "$STAGE/usr" -type d -exec chmod 0755 {} \;
find "$STAGE/etc" "$STAGE/usr" -type f -exec chmod 0644 {} \;

mkdir -p dist
dpkg-deb --build --root-owner-group "$STAGE" "dist/${DEB}"
echo "✓ built dist/${DEB}"
