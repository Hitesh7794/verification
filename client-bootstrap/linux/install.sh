#!/usr/bin/env bash
# install.sh — operator-laptop bootstrap (Linux).
#
# Usage:  sudo ./install.sh <portal-url>
#
# Run from inside the unpacked bundle. Installs the three .debs in
# dependency order and writes the portal URL to a config file the
# meta-package's postinst reads.

set -euo pipefail

if [ "${1:-}" = "" ]; then
    echo "Usage: sudo $0 <portal-url>" >&2
    echo "Example: sudo $0 https://portal.example.com" >&2
    exit 2
fi
PORTAL_URL="$1"

if [ "$EUID" -ne 0 ]; then
    echo "✗ must run as root (sudo)." >&2
    exit 1
fi

cd "$(dirname "$0")"

# Sanity: bundle should hold all three .debs.
for deb in \
  morfinauth-client-service.deb \
  mantra-iris-service_*_all.deb \
  verification-portal-client_*_all.deb
do
  if ! ls $deb >/dev/null 2>&1; then
      echo "✗ $deb missing from bundle directory $(pwd)" >&2
      exit 1
  fi
done

echo "→ writing portal URL to /etc/verification-portal/portal.conf"
mkdir -p /etc/verification-portal
cat > /etc/verification-portal/portal.conf <<EOF
# Read by verification-portal-client postinst + the desktop launcher.
# Re-run 'sudo dpkg-reconfigure verification-portal-client' after editing.
PORTAL_URL="${PORTAL_URL}"
EOF
chmod 0644 /etc/verification-portal/portal.conf

# 1. MorFin daemon (vendor) — provides the iris .deb's transitive helpers.
echo "→ installing MorFin fingerprint daemon"
apt-get install -y ./morfinauth-client-service.deb

# 2. Iris service — depends on a JRE which apt will pull in.
echo "→ installing Mantra iris service"
apt-get install -y ./mantra-iris-service_*_all.deb

# 3. Meta-package — sets browser homepage, adds desktop launcher.
echo "→ installing verification-portal-client meta-package"
apt-get install -y ./verification-portal-client_*_all.deb

echo
echo "✓ Operator laptop is ready."
echo "  Portal:     ${PORTAL_URL}"
echo "  Fingerprint daemon: $(systemctl is-active morfinauth-client-service 2>/dev/null || echo unknown) (:8030)"
echo "  Iris service:       $(systemctl is-active mantra-iris-service 2>/dev/null || echo unknown) (:8031)"
echo "  Open the browser — homepage will be the portal."
