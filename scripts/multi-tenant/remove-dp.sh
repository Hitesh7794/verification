#!/usr/bin/env bash
# Phase-4 rollback — tear down a Data Plane provisioned by add-dp.sh.
#
# Safe by default: stops the DP, removes systemd + nginx, soft-deletes
# the CP registry row. The database is LEFT INTACT unless --drop-db is
# passed. The /opt/verificationportal-<slug>/ directory is moved aside
# to a timestamped backup rather than rm -rf, so recovery is possible.
#
# What this script does NOT do:
#   - Delete files from the S3 bucket. Docs + candidate photos stay.
#   - Un-do any CP-side institution_applications rows that were routed
#     to this DP. They remain visible on the CP superadmin view.

set -euo pipefail

usage() {
    cat >&2 <<EOF
Usage: $0 --slug SLUG --cp-token JWT [OPTIONS]

Required:
  --slug     SLUG      DP slug to tear down (must match what add-dp.sh used)
  --cp-token JWT       Bearer JWT from POST /api/superadmin/login on CP

Optional:
  --cp-url   URL       CP base URL (default: http://127.0.0.1:8091)
  --drop-db            Also DROP DATABASE — IRREVERSIBLE. Default: leave DB.
  --pg-host  HOST      Postgres host (default: parsed from DP's .env)
  --pg-user  USER      Postgres superuser (default: postgres)
  --pg-pass  PASS      Postgres password (default: prompted with --drop-db)
  --force              Skip confirmation prompt
  --dry-run            Print what would happen, make no changes
EOF
    exit 2
}

SLUG="" CP_TOKEN=""
CP_URL="http://127.0.0.1:8091"
DROP_DB=0
PG_HOST="" PG_USER="postgres" PG_PASS=""
FORCE=0 DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --slug)      SLUG="$2"; shift 2 ;;
        --cp-token)  CP_TOKEN="$2"; shift 2 ;;
        --cp-url)    CP_URL="$2"; shift 2 ;;
        --drop-db)   DROP_DB=1; shift ;;
        --pg-host)   PG_HOST="$2"; shift 2 ;;
        --pg-user)   PG_USER="$2"; shift 2 ;;
        --pg-pass)   PG_PASS="$2"; shift 2 ;;
        --force)     FORCE=1; shift ;;
        --dry-run)   DRY_RUN=1; shift ;;
        -h|--help)   usage ;;
        *)           echo "unknown flag: $1" >&2; usage ;;
    esac
done

[[ -z "$SLUG"     ]] && { echo "--slug required" >&2; usage; }
[[ -z "$CP_TOKEN" ]] && { echo "--cp-token required" >&2; usage; }

DP_HOME="/opt/verificationportal-$SLUG"
SYSTEMD_UNIT="/etc/systemd/system/portal-$SLUG.service"
NGINX_CONF="/etc/nginx/sites-available/portal-$SLUG.conf"
NGINX_LINK="/etc/nginx/sites-enabled/portal-$SLUG.conf"

log()  { printf '\033[1;34m[remove-dp %s]\033[0m %s\n' "$SLUG" "$*"; }
warn() { printf '\033[1;33m[remove-dp %s WARN]\033[0m %s\n' "$SLUG" "$*"; }
die()  { printf '\033[1;31m[remove-dp %s FATAL]\033[0m %s\n' "$SLUG" "$*" >&2; exit 1; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then echo "  DRY: $*"; else eval "$*"; fi; }

[[ -d "$DP_HOME" || -e "$SYSTEMD_UNIT" || -e "$NGINX_CONF" ]] \
    || die "nothing to remove — slug '$SLUG' has no home dir, systemd unit, or nginx vhost"

# Extract DB info from DP .env for optional drop
DB_NAME="" DP_DATABASE_URL=""
if [[ -r "$DP_HOME/.env" ]]; then
    DP_DATABASE_URL="$(sudo grep -E '^DATABASE_URL=' "$DP_HOME/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    DB_NAME="$(echo "$DP_DATABASE_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"
    if [[ -z "$PG_HOST" ]]; then
        PG_HOST="$(echo "$DP_DATABASE_URL" | sed -E 's|^postgres(ql)?://[^@]+@([^:/]+).*|\2|')"
    fi
fi

# Look up CP row id by name+api_url
log "looking up CP registry row for '$DP_HOME'"
CP_LIST="$(curl -sf -H "Authorization: Bearer $CP_TOKEN" \
    "$CP_URL/api/superadmin/clients" || echo '')"
DP_CLIENT_ID="$(echo "$CP_LIST" | python3 -c \
    "import sys,json; xs=json.load(sys.stdin).get('clients',[]); \
     match=[c for c in xs if 'portal-$SLUG' in (c.get('api_url') or '') or c.get('name','').lower()=='$SLUG']; \
     print(match[0]['id'] if match else '')" 2>/dev/null || echo '')"

# Confirmation
cat >&2 <<EOF
About to tear down Data Plane '$SLUG':
  systemd unit:   $SYSTEMD_UNIT             $([ -e "$SYSTEMD_UNIT" ] && echo "(will stop + remove)" || echo "(absent)")
  home dir:       $DP_HOME              $([ -d "$DP_HOME" ] && echo "(will move to .removed.<ts>)" || echo "(absent)")
  nginx vhost:    $NGINX_CONF          $([ -e "$NGINX_CONF" ] && echo "(will remove + reload nginx)" || echo "(absent)")
  CP row id:      ${DP_CLIENT_ID:-<not found>} $([ -n "$DP_CLIENT_ID" ] && echo "(will soft-delete via DELETE /clients/<id>)" || echo "")
  database:       ${DB_NAME:-<unknown>} on ${PG_HOST:-<unknown>} $([ "$DROP_DB" -eq 1 ] && echo "(⚠ WILL BE DROPPED — --drop-db)" || echo "(kept)")

EOF

if [[ $FORCE -eq 0 && $DRY_RUN -eq 0 ]]; then
    read -rp "Proceed? [y/N] " ans
    [[ "$ans" =~ ^[yY]$ ]] || die "cancelled"
fi

# ── 1. Stop + disable systemd unit ────────────────────────────────────
if [[ -e "$SYSTEMD_UNIT" ]]; then
    log "stop + disable portal-$SLUG.service"
    run "sudo systemctl stop portal-$SLUG.service || true"
    run "sudo systemctl disable portal-$SLUG.service || true"
    run "sudo rm -f '$SYSTEMD_UNIT'"
    run "sudo systemctl daemon-reload"
fi

# ── 2. Remove nginx vhost ─────────────────────────────────────────────
if [[ -e "$NGINX_CONF" || -e "$NGINX_LINK" ]]; then
    log "remove nginx vhost"
    run "sudo rm -f '$NGINX_LINK'"
    run "sudo rm -f '$NGINX_CONF'"
    run "sudo nginx -t"
    run "sudo systemctl reload nginx"
fi

# ── 3. Soft-delete CP registry row ────────────────────────────────────
if [[ -n "$DP_CLIENT_ID" ]]; then
    log "soft-delete CP row id=$DP_CLIENT_ID"
    if [[ $DRY_RUN -eq 0 ]]; then
        curl -sf -X DELETE -H "Authorization: Bearer $CP_TOKEN" \
            "$CP_URL/api/superadmin/clients/$DP_CLIENT_ID" \
            >/dev/null \
            || warn "CP soft-delete failed"
    fi
else
    warn "no CP row matched slug '$SLUG'; skipping CP soft-delete"
fi

# ── 4. Move DP home aside ─────────────────────────────────────────────
if [[ -d "$DP_HOME" ]]; then
    TS="$(date -u +%Y%m%dT%H%M%SZ)"
    log "move $DP_HOME → $DP_HOME.removed.$TS"
    run "sudo mv '$DP_HOME' '$DP_HOME.removed.$TS'"
fi

# ── 5. Optional: drop the database ────────────────────────────────────
if [[ $DROP_DB -eq 1 ]]; then
    [[ -n "$DB_NAME"  ]] || die "--drop-db requested but DB name unknown"
    [[ -n "$PG_HOST"  ]] || die "--drop-db requested but PG host unknown"
    if [[ -z "$PG_PASS" ]]; then
        if [[ -n "${PGPASSWORD:-}" ]]; then PG_PASS="$PGPASSWORD"
        else read -srp "Postgres password (drop $DB_NAME on $PG_HOST): " PG_PASS; echo
        fi
    fi
    export PGPASSWORD="$PG_PASS"
    log "DROP DATABASE $DB_NAME"
    run "psql -h '$PG_HOST' -U '$PG_USER' -d postgres -c \"DROP DATABASE IF EXISTS $DB_NAME\""
fi

log "done. To fully recover, rename '$DP_HOME.removed.<ts>' back and re-enable the systemd unit."
