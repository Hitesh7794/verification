#!/usr/bin/env bash
# Phase-4 provisioning — add a new Data Plane to this box.
#
# Runs on the EC2 host itself (ubuntu user with sudo). Given a short
# slug + a free port + a subdomain, it will:
#
#   1. Create a dedicated PG database on the shared RDS instance.
#   2. Lay down /opt/verificationportal-<slug>/ with binary + logs
#      + data dirs.
#   3. Render + install the systemd unit and nginx vhost.
#   4. Generate per-DP secrets (JWT_SECRET, INTERNAL_API_KEY) and a
#      per-DP .env inheriting shared providers (SMTP, Razorpay, S3,
#      TrustView) from the source DP.
#   5. Register this DP with the Control Plane via
#      POST /api/superadmin/clients, capturing the api_key echoed once.
#   6. Wire the CP-issued (client_id, api_key) into the DP's .env.
#   7. Start the systemd unit, verify /health locally.
#   8. Verify CP → DP internal-api round-trip works.
#
# NOT done by this script:
#   - Migrating existing client data from the source DP (add-dp starts
#     the new DP with an empty schema; the DP's own migrator runs on
#     first boot to create tables).
#   - Extending the TLS cert to include the new subdomain. Browsers
#     will fail TLS verification until the cert is re-issued with
#     the new SAN — see README.md, "TLS cert extension".
#   - Provisioning a new EC2 or new RDS instance. This add-dp script
#     is same-box + same-RDS.
#
# Rollback: ./remove-dp.sh --slug <slug>  [--drop-db]

set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────
usage() {
    cat >&2 <<EOF
Usage: $0 --name NAME --slug SLUG --port PORT --domain DOMAIN --cp-token JWT [OPTIONS]

Required:
  --name    NAME       Display name registered with the CP (e.g. "NTA")
  --slug    SLUG       Short lowercase identifier used in paths (e.g. "nta")
                         Must match [a-z0-9-]+
  --port    PORT       Local bind port for this DP's Go process (e.g. 8092)
                         Must not overlap 8090 (primary DP) or 8091 (CP)
  --domain  DOMAIN     Public subdomain for this DP
                         (e.g. nta.verifyportal.13-127-17-248.nip.io)
  --cp-token JWT       Bearer JWT from POST /api/superadmin/login on CP.
                         Get one with:
                           curl -s -X POST http://127.0.0.1:8091/api/superadmin/login \\
                             -H 'Content-Type: application/json' \\
                             -d '{"username":"cpsuper","password":"..."}' \\
                             | jq -r .token

Optional:
  --db-name DB         Postgres DB name (default: verification_<slug>)
  --cp-url  URL        CP base URL as seen from THIS box
                         (default: http://127.0.0.1:8091)
  --source-env PATH    Source DP .env to inherit shared providers from
                         (default: /opt/verificationportal/.env)
  --source-bin PATH    Source DP binary to copy
                         (default: /opt/verificationportal/portal-server)
  --pg-host HOST       Postgres host (default: from source .env DATABASE_URL)
  --pg-user USER       Postgres superuser for CREATE DATABASE
                         (default: postgres)
  --pg-pass PASS       Postgres password (default: prompted)
  --dry-run            Print what would happen, make no changes

Example:
  $0 --name NTA --slug nta --port 8092 \\
     --domain nta.verifyportal.13-127-17-248.nip.io \\
     --cp-token \$(cat ~/cp-token.txt)
EOF
    exit 2
}

NAME="" SLUG="" PORT="" DOMAIN="" CP_TOKEN=""
DB_NAME=""
CP_URL="http://127.0.0.1:8091"
SOURCE_ENV="/opt/verificationportal/.env"
SOURCE_BIN="/opt/verificationportal/portal-server"
PG_HOST="" PG_USER="postgres" PG_PASS=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name)       NAME="$2"; shift 2 ;;
        --slug)       SLUG="$2"; shift 2 ;;
        --port)       PORT="$2"; shift 2 ;;
        --domain)     DOMAIN="$2"; shift 2 ;;
        --cp-token)   CP_TOKEN="$2"; shift 2 ;;
        --db-name)    DB_NAME="$2"; shift 2 ;;
        --cp-url)     CP_URL="$2"; shift 2 ;;
        --source-env) SOURCE_ENV="$2"; shift 2 ;;
        --source-bin) SOURCE_BIN="$2"; shift 2 ;;
        --pg-host)    PG_HOST="$2"; shift 2 ;;
        --pg-user)    PG_USER="$2"; shift 2 ;;
        --pg-pass)    PG_PASS="$2"; shift 2 ;;
        --dry-run)    DRY_RUN=1; shift ;;
        -h|--help)    usage ;;
        *)            echo "unknown flag: $1" >&2; usage ;;
    esac
done

[[ -z "$NAME"     ]] && { echo "--name required"     >&2; usage; }
[[ -z "$SLUG"     ]] && { echo "--slug required"     >&2; usage; }
[[ -z "$PORT"     ]] && { echo "--port required"     >&2; usage; }
[[ -z "$DOMAIN"   ]] && { echo "--domain required"   >&2; usage; }
[[ -z "$CP_TOKEN" ]] && { echo "--cp-token required" >&2; usage; }
[[ -z "$DB_NAME"  ]] && DB_NAME="verification_${SLUG}"

# ── Sanity checks ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/templates"
DP_HOME="/opt/verificationportal-$SLUG"
SYSTEMD_UNIT="/etc/systemd/system/portal-$SLUG.service"
NGINX_CONF="/etc/nginx/sites-available/portal-$SLUG.conf"
NGINX_LINK="/etc/nginx/sites-enabled/portal-$SLUG.conf"

log()  { printf '\033[1;34m[add-dp %s]\033[0m %s\n' "$SLUG" "$*"; }
warn() { printf '\033[1;33m[add-dp %s WARN]\033[0m %s\n' "$SLUG" "$*"; }
die()  { printf '\033[1;31m[add-dp %s FATAL]\033[0m %s\n' "$SLUG" "$*" >&2; exit 1; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then echo "  DRY: $*"; else eval "$*"; fi; }

# Slug format
[[ "$SLUG" =~ ^[a-z0-9-]+$ ]] || die "slug must match [a-z0-9-]+"

# Port free
if ss -tlnp 2>/dev/null | grep -q ":${PORT}[[:space:]]"; then
    die "port $PORT is already in use"
fi
[[ "$PORT" == "8090" ]] && die "port 8090 is the primary DP"
[[ "$PORT" == "8091" ]] && die "port 8091 is the CP"

# Paths must not already exist
[[ -d "$DP_HOME"       ]] && die "$DP_HOME already exists"
[[ -e "$SYSTEMD_UNIT"  ]] && die "$SYSTEMD_UNIT already exists"
[[ -e "$NGINX_CONF"    ]] && die "$NGINX_CONF already exists"

# Templates + source files present
for f in "$TEMPLATE_DIR/dp.env.tmpl" \
         "$TEMPLATE_DIR/dp.service.tmpl" \
         "$TEMPLATE_DIR/dp-nginx.conf.tmpl"; do
    [[ -r "$f" ]] || die "missing template: $f"
done
[[ -r "$SOURCE_ENV" ]] || die "source env not readable: $SOURCE_ENV (try sudo -E)"
[[ -x "$SOURCE_BIN" ]] || die "source binary not executable: $SOURCE_BIN"

# Extract PG host from source DATABASE_URL if not provided
if [[ -z "$PG_HOST" ]]; then
    SRC_DSN="$(grep -E '^DATABASE_URL=' "$SOURCE_ENV" | head -1 | cut -d= -f2-)"
    [[ -n "$SRC_DSN" ]] || die "cannot find DATABASE_URL in $SOURCE_ENV"
    # postgres://user:pass@host:5432/db?...  →  host
    PG_HOST="$(echo "$SRC_DSN" | sed -E 's|^postgres(ql)?://[^@]+@([^:/]+).*|\2|')"
    [[ -n "$PG_HOST" && "$PG_HOST" != "$SRC_DSN" ]] || die "could not parse host from DATABASE_URL"
fi

# PG password prompt (or read from env)
if [[ -z "$PG_PASS" ]]; then
    if [[ -n "${PGPASSWORD:-}" ]]; then
        PG_PASS="$PGPASSWORD"
    else
        read -srp "Postgres password for user '$PG_USER' on $PG_HOST: " PG_PASS
        echo
    fi
fi
export PGPASSWORD="$PG_PASS"

# CP reachable?
if ! curl -sf -m 5 "$CP_URL/api/health" >/dev/null; then
    die "CP not reachable at $CP_URL/api/health"
fi

log "preflight OK: slug=$SLUG port=$PORT domain=$DOMAIN db=$DB_NAME pg_host=$PG_HOST"

# ── 1. Create PG database ─────────────────────────────────────────────
log "step 1/8: create Postgres database '$DB_NAME'"
if psql -h "$PG_HOST" -U "$PG_USER" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
    die "database '$DB_NAME' already exists on $PG_HOST"
fi
run "psql -h '$PG_HOST' -U '$PG_USER' -d postgres -c \"CREATE DATABASE $DB_NAME\""

# ── 2. Lay down /opt/verificationportal-<slug>/ ───────────────────────
log "step 2/8: create $DP_HOME"
run "sudo install -d -o ubuntu -g ubuntu $DP_HOME"
for sub in logs data artifacts downloads webapp db-backups; do
    run "sudo install -d -o ubuntu -g ubuntu $DP_HOME/$sub"
done
run "sudo cp '$SOURCE_BIN' '$DP_HOME/portal-server'"
run "sudo chown ubuntu:ubuntu '$DP_HOME/portal-server'"
run "sudo chmod +x '$DP_HOME/portal-server'"

# ── 3. Render + install .env ──────────────────────────────────────────
log "step 3/8: render .env"

# Fresh per-DP secrets
JWT_SECRET="$(openssl rand -hex 32)"
INTERNAL_API_KEY="$(openssl rand -hex 32)"
PUBLIC_BASE_URL="https://$DOMAIN"
DATABASE_URL="$(echo "$SRC_DSN" | sed -E "s|/[^/?]+(\?|$)|/$DB_NAME\1|")"

# Render template
TMP_ENV="$(mktemp)"
sed -e "s|__SLUG__|$SLUG|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__PUBLIC_BASE_URL__|$PUBLIC_BASE_URL|g" \
    -e "s|__DATABASE_URL__|$DATABASE_URL|g" \
    -e "s|__JWT_SECRET__|$JWT_SECRET|g" \
    -e "s|__INTERNAL_API_KEY__|$INTERNAL_API_KEY|g" \
    -e "s|__CONTROL_PLANE_URL__|$CP_URL|g" \
    -e "s|__DP_CLIENT_ID__|__PENDING__|g" \
    -e "s|__DP_API_KEY__|__PENDING__|g" \
    "$TEMPLATE_DIR/dp.env.tmpl" > "$TMP_ENV"

# Append inherited-provider block: any KEY=VALUE from source .env whose
# key is NOT already set by the template. Provider creds (SMTP, Razorpay,
# S3, TrustView, wallet fees) come across unchanged so the new DP works
# out of the box.
{
    echo ""
    echo "# ── INHERITED FROM $SOURCE_ENV ─────────────────────────────"
    # Keys the template already sets — do NOT re-inherit these
    OWN_KEYS='APP_ENV|HTTP_ADDR|PUBLIC_BASE_URL|ALLOWED_ORIGINS|DATABASE_URL|JWT_SECRET|INTERNAL_API_KEY|CONTROL_PLANE_URL|DATA_PLANE_CLIENT_ID|DATA_PLANE_API_KEY|SERVE_KYC_LOCALLY|DATA_DIR|ARTIFACT_DIR|DOWNLOADS_DIR'
    grep -E '^[A-Z_][A-Z0-9_]*=' "$SOURCE_ENV" \
        | grep -vE "^($OWN_KEYS)=" \
        || true
} >> "$TMP_ENV"

run "sudo install -m 640 -o ubuntu -g ubuntu '$TMP_ENV' '$DP_HOME/.env'"
rm -f "$TMP_ENV"

# ── 4. Render + install systemd unit ──────────────────────────────────
log "step 4/8: install systemd unit"
TMP_SVC="$(mktemp)"
sed -e "s|__SLUG__|$SLUG|g" "$TEMPLATE_DIR/dp.service.tmpl" > "$TMP_SVC"
run "sudo install -m 644 -o root -g root '$TMP_SVC' '$SYSTEMD_UNIT'"
rm -f "$TMP_SVC"
run "sudo systemctl daemon-reload"

# ── 5. Render + install nginx vhost ───────────────────────────────────
log "step 5/8: install nginx vhost"
TMP_NGX="$(mktemp)"
sed -e "s|__SLUG__|$SLUG|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__DOMAIN__|$DOMAIN|g" \
    "$TEMPLATE_DIR/dp-nginx.conf.tmpl" > "$TMP_NGX"
run "sudo install -m 644 -o root -g root '$TMP_NGX' '$NGINX_CONF'"
rm -f "$TMP_NGX"
run "sudo ln -sf '$NGINX_CONF' '$NGINX_LINK'"
run "sudo nginx -t"

# ── 6. Start the DP (still with __PENDING__ CP creds) ─────────────────
log "step 6/8: start DP systemd unit"
run "sudo systemctl enable portal-$SLUG.service"
run "sudo systemctl start portal-$SLUG.service"

log "waiting for /health on 127.0.0.1:$PORT..."
if [[ $DRY_RUN -eq 0 ]]; then
    for i in $(seq 1 20); do
        if curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null; then
            log "health OK"
            break
        fi
        [[ $i -eq 20 ]] && die "DP failed to come up; check journalctl -u portal-$SLUG"
        sleep 1
    done
fi

# ── 7. Register with CP ───────────────────────────────────────────────
log "step 7/8: register with CP at $CP_URL"
if [[ $DRY_RUN -eq 1 ]]; then
    CP_RESP='{"id":"__DRY__","api_key":"__DRY__"}'
else
    CP_RESP="$(curl -sf -X POST "$CP_URL/api/superadmin/clients" \
        -H "Authorization: Bearer $CP_TOKEN" \
        -H 'Content-Type: application/json' \
        -d "{\"name\":\"$NAME\",\"kyc_review_mode\":\"both\",\"api_url\":\"$PUBLIC_BASE_URL\",\"notes\":\"Provisioned by add-dp.sh at $(date -u +%FT%TZ)\"}")" \
        || die "CP registration failed"
fi

DP_CLIENT_ID="$(echo "$CP_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')"
DP_API_KEY="$(echo "$CP_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["api_key"])')"
[[ -n "$DP_CLIENT_ID" && -n "$DP_API_KEY" ]] \
    || die "CP response missing id or api_key: $CP_RESP"

# Patch the DP's .env with the CP-issued creds, in place
log "patching DP .env with (client_id=$DP_CLIENT_ID, api_key=<redacted>)"
run "sudo sed -i \"s|^DATA_PLANE_CLIENT_ID=.*|DATA_PLANE_CLIENT_ID=$DP_CLIENT_ID|\" '$DP_HOME/.env'"
run "sudo sed -i \"s|^DATA_PLANE_API_KEY=.*|DATA_PLANE_API_KEY=$DP_API_KEY|\" '$DP_HOME/.env'"

# ALSO update the CP row so its stored api_key matches what the DP now
# holds as INTERNAL_API_KEY (the CP calls DP /api/internal/* using this).
# The clients_registry.api_key column stores what CP presents when it
# reverse-proxies; we set it to the DP's INTERNAL_API_KEY so CP → DP
# internal calls authenticate.
log "syncing CP clients_registry.api_key to DP INTERNAL_API_KEY"
if [[ $DRY_RUN -eq 0 ]]; then
    curl -sf -X PATCH "$CP_URL/api/superadmin/clients/$DP_CLIENT_ID" \
        -H "Authorization: Bearer $CP_TOKEN" \
        -H 'Content-Type: application/json' \
        -d "{\"api_key\":\"$INTERNAL_API_KEY\"}" \
        >/dev/null \
        || warn "CP api_key sync failed — you may need to PATCH manually"
fi

# Restart DP one more time to pick up the CP-issued env vars
log "restart DP to pick up CP-issued env"
run "sudo systemctl restart portal-$SLUG.service"

if [[ $DRY_RUN -eq 0 ]]; then
    sleep 2
    curl -sf -m 5 "http://127.0.0.1:$PORT/health" >/dev/null \
        || die "DP unhealthy after CP-cred restart"
fi

# ── 8. CP → DP internal round-trip check ──────────────────────────────
log "step 8/8: CP → DP /internal/health round-trip"
if [[ $DRY_RUN -eq 0 ]]; then
    RT="$(curl -sf -H "X-Internal-API-Key: $INTERNAL_API_KEY" \
        "http://127.0.0.1:$PORT/api/internal/health" || true)"
    if [[ -z "$RT" ]] || ! echo "$RT" | grep -q '"status"'; then
        warn "internal/health returned unexpected: $RT"
    else
        log "internal round-trip OK: $RT"
    fi
fi

# ── nginx reload (finalise vhost) ─────────────────────────────────────
run "sudo systemctl reload nginx"

# ── Summary ───────────────────────────────────────────────────────────
cat <<EOF

──────────────────────────────────────────────────────────────────
  Data Plane '$NAME' (slug '$SLUG') provisioned.

  Systemd:      portal-$SLUG.service  (enabled + running)
  Home dir:     $DP_HOME
  Bind:         127.0.0.1:$PORT
  Public URL:   https://$DOMAIN
                  (⚠ TLS cert has no SAN for this domain yet — browsers
                     will warn until you re-issue. See README.md,
                     "TLS cert extension".)
  Database:     $DB_NAME on $PG_HOST
  CP row id:    $DP_CLIENT_ID  (POST /api/superadmin/clients)
  Nginx vhost:  $NGINX_CONF
  Logs:         $DP_HOME/logs/portal-server.log
                sudo journalctl -u portal-$SLUG.service -f

  Rollback:     ./remove-dp.sh --slug $SLUG [--drop-db]
──────────────────────────────────────────────────────────────────
EOF
