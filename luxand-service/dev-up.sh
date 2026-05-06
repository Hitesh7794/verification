#!/usr/bin/env bash
# dev-up.sh — local face-matching dev convenience wrapper.
#
# Brings up the luxand-service container, waits for it to become
# healthy, then prints a smoke-test you can run from the host.
#
# Usage:
#   1. Once: cp .env.example .env && edit .env to add FSDK_LICENSE_KEY
#   2. ./dev-up.sh
#   3. Back on the host:  curl -X POST http://localhost:8040/face/health
#   4. ./dev-down.sh   (or:  docker compose down)

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo "✗ .env not found. Copy .env.example to .env and add your" >&2
    echo "  FSDK_LICENSE_KEY before running this script." >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "✗ docker not found. Install Docker Desktop:" >&2
    echo "    https://www.docker.com/products/docker-desktop/" >&2
    exit 1
fi

# Only build if the image is missing. After the first successful build,
# every subsequent start should be ~1 s of compose orchestration, not a
# Docker Hub round trip — that round trip becomes a hard failure whenever
# the dev box is on a flaky network or behind a proxy. Force a rebuild
# manually with:  docker compose build
if ! docker image inspect luxand-service:1.0.0 >/dev/null 2>&1; then
    echo "→ image not found; building (first run downloads JRE + libs, ~3 min)"
    docker compose build
else
    echo "→ image cached; skipping build"
fi

echo "→ starting service"
docker compose up -d

echo "→ waiting for /face/health to return 200..."
for i in $(seq 1 30); do
    if curl -fs -X POST http://127.0.0.1:8040/face/health >/dev/null 2>&1; then
        echo
        echo "✓ luxand-service is up."
        echo
        echo "  health:  curl -X POST http://localhost:8040/face/health | jq"
        echo "  logs:    docker compose logs -f luxand-service"
        echo "  stop:    ./dev-down.sh"
        echo
        curl -s -X POST http://127.0.0.1:8040/face/health | head -c 400
        echo
        exit 0
    fi
    sleep 2
done

echo "✗ /face/health didn't respond within 60 seconds." >&2
echo "  Check logs:  docker compose logs luxand-service" >&2
exit 1
