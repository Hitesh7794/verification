#!/usr/bin/env bash
# dev-down.sh — stop and remove the local fp-match-service container.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
echo "✓ fp-match-service stopped."
