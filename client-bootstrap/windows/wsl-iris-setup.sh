#!/usr/bin/env bash
# wsl-iris-setup.sh — runs INSIDE the WSL Ubuntu distro to provision
# mantra-iris-service. Invoked by install.ps1 via:
#   wsl -d Ubuntu-22.04 --user root -- bash /mnt/c/.../wsl-iris-setup.sh /mnt/c/.../iris-wsl
#
# What this does:
#   1. Enables systemd inside WSL (one-time, requires `wsl --shutdown`).
#   2. Installs JRE 17 + usbip user-tools (for USB passthrough).
#   3. Installs the mantra-iris-service .deb staged on the Windows side.
#   4. Verifies the service starts and reports listening on :8031.
#
# Idempotent — safe to re-run for upgrades or partial recovery.

set -euo pipefail

DEB_DIR="${1:-}"
if [ -z "$DEB_DIR" ] || [ ! -d "$DEB_DIR" ]; then
    echo "✗ usage: wsl-iris-setup.sh <path-to-iris-wsl-dir>" >&2
    echo "  expected to contain mantra-iris-service_*_all.deb" >&2
    exit 1
fi

DEB_FILE=$(ls "$DEB_DIR"/mantra-iris-service_*_all.deb 2>/dev/null | head -n1 || true)
if [ -z "$DEB_FILE" ]; then
    echo "✗ no mantra-iris-service*.deb found in $DEB_DIR" >&2
    echo "  run client-bootstrap/windows/build-bundle.sh on the build host first" >&2
    exit 1
fi

echo "→ provisioning iris service from $(basename "$DEB_FILE")"

# 1. Enable systemd in WSL ---------------------------------------------------
# Without systemd, the .deb's postinst can't `systemctl enable/start` and
# the service won't survive WSL restarts. The `[boot] systemd=true` flag is
# honoured by WSL2 on Win11 + recent Win10 updates.
WSLCONF=/etc/wsl.conf
if ! grep -qE '^systemd=true' "$WSLCONF" 2>/dev/null; then
    echo "→ enabling systemd in /etc/wsl.conf"
    if [ -f "$WSLCONF" ] && grep -qE '^\[boot\]' "$WSLCONF"; then
        sed -i '/^\[boot\]/a systemd=true' "$WSLCONF"
    else
        cat >> "$WSLCONF" <<'EOF'

[boot]
systemd=true
EOF
    fi
    echo "  (systemd will activate after the next 'wsl --shutdown'; we'll trigger this below)"
    NEED_RESTART=1
else
    echo "✓ systemd already enabled in /etc/wsl.conf"
    NEED_RESTART=0
fi

# 2. Install dependencies ----------------------------------------------------
echo "→ apt update + dependency install"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# default-jre = the iris-service .deb's runtime dependency.
# linux-tools-virtual + hwdata = userspace `usbip` to attach passed-through
# devices (usbipd-win on the Windows side handles the host half).
apt-get install -y --no-install-recommends \
    default-jre-headless \
    linux-tools-virtual \
    hwdata \
    ca-certificates \
    curl

# usbip binary lives under /usr/lib/linux-tools/<version>/usbip on Ubuntu;
# symlink to /usr/local/bin so our scripts find it on $PATH.
USBIP_BIN=$(ls /usr/lib/linux-tools/*/usbip 2>/dev/null | tail -n1 || true)
if [ -n "$USBIP_BIN" ] && [ ! -e /usr/local/bin/usbip ]; then
    ln -sf "$USBIP_BIN" /usr/local/bin/usbip
fi

# 3. Install the iris service .deb ------------------------------------------
echo "→ installing $(basename "$DEB_FILE")"
apt-get install -y "$DEB_FILE"

# 4. Verify --------------------------------------------------------------
# If systemd was JUST enabled, the daemon won't be running yet inside this
# session — needs `wsl --shutdown` from the host. Detect that case and
# advise; otherwise verify systemctl status.
if [ "$NEED_RESTART" -eq 1 ]; then
    echo ""
    echo "⚠ systemd was just enabled; iris service won't start until WSL restarts."
    echo "  install.ps1 will run 'wsl --shutdown' next; the iris service will come up"
    echo "  on first launch of the distro afterwards."
    exit 0
fi

# Give systemd a moment to bring the unit up after install.
sleep 2
if systemctl is-active --quiet mantra-iris-service; then
    echo "✓ mantra-iris-service is running"
    systemctl status mantra-iris-service --no-pager --lines=5 || true
else
    echo "⚠ mantra-iris-service did not auto-start; recent log:"
    journalctl -u mantra-iris-service --no-pager --lines=20 || true
    echo ""
    echo "Common causes:"
    echo "  - IRIS_PROVIDER=marvis-strict and JAR isn't loadable (check /usr/local/mantra-iris-service/)"
    echo "  - USB device not yet attached via usbipd (run 'usbipd attach --hardware-id 2c0f:2100 --wsl' on Windows)"
    echo "  - Java not on PATH — run: which java"
    exit 1
fi

# Smoke test the HTTP layer.
if curl -sf -m 3 -X POST http://127.0.0.1:8031/iris/supporteddevicelist >/dev/null; then
    echo "✓ HTTP endpoint responding on :8031"
else
    echo "⚠ HTTP endpoint not yet responding (service may still be starting)"
fi

echo ""
echo "✓ iris provisioning complete."
echo "  Service:   systemctl status mantra-iris-service"
echo "  Logs:      journalctl -u mantra-iris-service -f"
echo "  USB list:  usbip list -p (should show MIS100V2 once usbipd attaches it)"
