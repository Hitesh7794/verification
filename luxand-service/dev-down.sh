#!/usr/bin/env bash
# dev-down.sh — stop and remove the local luxand-service container.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
echo "✓ luxand-service stopped."
