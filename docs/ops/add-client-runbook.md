# Adding a new client (per-client Data Plane) — ops runbook

Track 2 model. Each real client (NTA, SSC, UP Board, …) gets its own DP
process + own PostgreSQL database + own subdomain. This document is the
step-by-step ops walk-through the superadmin + ops person follow.

**Not automated.** The Terraform / bash automation is optional; the
canonical path is the manual steps below so a person understands every
side effect.

---

## 0. What you'll need

- **Superadmin JWT** for the Control Plane. Get one with:
  ```bash
  curl -sk -X POST http://127.0.0.1:8091/api/superadmin/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"cpsuper","password":"..."}' \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])'
  ```
- **PEM key** for SSH into the target EC2 host.
- **Postgres superuser creds** (for `CREATE DATABASE`).
- **Decided values** for this client:
  | Field | Example |
  |---|---|
  | Display name | `NTA` |
  | Slug | `nta` |
  | Public subdomain | `nta.verify.portal.io` |
  | DP local port | `8092` (if same box; unique per DP) |
  | DP database name | `verification_nta` |

---

## Step 1 — Register the client in CP

Creates a row in `clients_registry` with `status='infra_pending'` and
returns a **freshly generated api_key echoed ONCE**. This is the shared
secret the DP will present as `X-Internal-API-Key` and the CP will
validate against `clients_registry.api_key`. Copy it now — no later
call returns it.

```bash
export CP_TOKEN="<the superadmin JWT>"

curl -sk -X POST http://127.0.0.1:8091/api/superadmin/clients \
  -H "Authorization: Bearer $CP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "NTA",
    "api_url": "https://nta.verify.portal.io",
    "kyc_review_mode": "both",
    "notes": "Provisioned via runbook 2026-08-30"
  }'
# → { "id": 2, "name": "NTA", "api_url": "https://nta.verify.portal.io", "api_key": "abc123..." }
```

Record:
- `CP_ROW_ID = 2` (needed later for the DP's `.env`)
- `API_KEY = abc123...` (needed later, single-use secret)

The CP now shows this client in the superadmin UI with badge **"Infra
pending"** — no `/internal/metrics` fan-out will hit it yet, so it can't
add timeouts to the dashboard.

---

## Step 2 — Provision the target infrastructure (ops)

### 2a. Create the database

Same RDS instance is fine; per-instance dedicated is fine too. On the
Postgres side:

```bash
PGPASSWORD=<pg-master-pw> psql \
  -h verification-portal-1787132309574.cwg1nygt9byx.ap-south-1.rds.amazonaws.com \
  -U postgres -d postgres \
  -c "CREATE DATABASE verification_nta;"
```

### 2b. Provision compute

Same EC2 (multi-port) OR new EC2. On the target box, lay down the DP:

```bash
sudo install -d -o ubuntu -g ubuntu /opt/verificationportal-nta/{logs,data,artifacts,downloads,webapp}
sudo cp /opt/verificationportal/portal-server /opt/verificationportal-nta/portal-server
sudo chown ubuntu:ubuntu /opt/verificationportal-nta/portal-server
sudo chmod +x /opt/verificationportal-nta/portal-server
```

### 2c. Write the DP env file

`/opt/verificationportal-nta/.env` — populate ALL of:

```
APP_ENV=production
HTTP_ADDR=127.0.0.1:8092
PUBLIC_BASE_URL=https://nta.verify.portal.io
ALLOWED_ORIGINS=https://nta.verify.portal.io

# NTA-owned DB (from step 2a)
DATABASE_URL=postgres://postgres:<pw>@<host>:5432/verification_nta?sslmode=require

# Per-DP secrets — DO NOT reuse across clients
JWT_SECRET=<32 bytes hex, openssl rand -hex 32>
INTERNAL_API_KEY=<PASTE api_key FROM STEP 1>

# Control Plane wiring
CONTROL_PLANE_URL=http://127.0.0.1:8091
DATA_PLANE_CLIENT_ID=<CP_ROW_ID from step 1>
DATA_PLANE_API_KEY=<SAME as INTERNAL_API_KEY>

# Local storage
DATA_DIR=/opt/verificationportal-nta/data
ARTIFACT_DIR=/opt/verificationportal-nta/artifacts
DOWNLOADS_DIR=/opt/verificationportal-nta/downloads

# Shared providers (copy from primary DP)
S3_BUCKET=...
S3_REGION=...
SMTP_HOST=... (and PORT, USER, PASS, FROM)
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
TRUSTVIEW_BASE_URL=...
TRUSTVIEW_TOKEN=...
WALLET_FEE_PER_LOOKUP_PAISE=...
```

`chmod 640` + `chown ubuntu:ubuntu`.

### 2d. Systemd unit

`/etc/systemd/system/portal-nta.service`:

```ini
[Unit]
Description=Verification Portal Data Plane - NTA
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/verificationportal-nta
EnvironmentFile=/opt/verificationportal-nta/.env
ExecStart=/opt/verificationportal-nta/portal-server
Restart=on-failure
RestartSec=3s
StandardOutput=append:/opt/verificationportal-nta/logs/portal-server.log
StandardError=append:/opt/verificationportal-nta/logs/portal-server.log
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/verificationportal-nta
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable portal-nta.service
sudo systemctl start portal-nta.service
sleep 3
sudo systemctl is-active portal-nta.service   # should print: active
curl -f http://127.0.0.1:8092/api/health      # should print: {"status":"ok",...}
```

DP schema migrations run on first boot — check `journalctl -u portal-nta`
for any migration errors before proceeding.

### 2e. Nginx vhost

`/etc/nginx/sites-available/portal-nta.conf`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name nta.verify.portal.io;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name nta.verify.portal.io;

    ssl_certificate     /etc/nginx/certs/verifyportal/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/verifyportal/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    root /opt/verificationportal-nta/webapp;
    index index.html;

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location = /index.html {
        add_header Cache-Control "no-store";
        try_files $uri =404;
    }

    # Bulk upload path first — longest-prefix wins for regex locations
    location ~ ^/api/superadmin/exams/[^/]+/bulk/[^/]+$ {
        client_max_body_size 2G;
        client_body_timeout  3600s;
        send_timeout         3600s;
        proxy_pass http://127.0.0.1:8092;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_buffering         off;
        proxy_read_timeout      3600s;
        proxy_send_timeout      3600s;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /api/ {
        client_max_body_size 10M;
        client_body_timeout  60s;
        proxy_pass http://127.0.0.1:8092;
        proxy_http_version 1.1;
        proxy_read_timeout  300s;
        proxy_send_timeout  300s;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        try_files $uri $uri/ /index.html;
    }
    access_log /var/log/nginx/portal-nta.access.log;
    error_log  /var/log/nginx/portal-nta.error.log;
}
```

Enable + reload:

```bash
sudo ln -s /etc/nginx/sites-available/portal-nta.conf /etc/nginx/sites-enabled/
sudo nginx -t                     # MUST pass
sudo systemctl reload nginx
```

### 2f. Extend the TLS cert

Current cert covers only `verifyportal.13-127-17-248.nip.io`. Browsers
hitting `nta.verify.portal.io` will fail TLS validation until the cert
is re-issued with the new SAN. Options:

**Option A** — Caddy re-issue (matches existing renewal ritual):
1. Add both domains to `/etc/caddy/Caddyfile`.
2. `sudo systemctl stop nginx && sudo systemctl start caddy`.
3. Wait ~30s for Caddy's ACME dance.
4. Copy fresh cert to nginx paths, restart nginx, stop caddy.

**Option B** — Wildcard cert `*.verify.portal.io` via DNS-01 (Route 53
API). Cleanest long-term. Requires DNS provider API access.

### 2g. DNS

If using `*.verify.portal.io`, add DNS record `nta.verify.portal.io`
pointing to the target EC2 IP.

For the current nip.io setup you can use
`nta.verifyportal.13-127-17-248.nip.io` — no DNS setup needed, nip.io
wildcard resolves any subdomain of a dashed-IP hostname.

---

## Step 3 — Verify the CP↔DP round-trip

From the CP box (or any box that can reach the DP):

```bash
# Health check with the shared secret
curl -f -H "X-Internal-API-Key: $API_KEY" \
     https://nta.verify.portal.io/api/internal/health
# → {"status":"ok","db":"ok","schema_version":23}
```

If that returns 200 with `status: ok`, the DP is up, the DB is
migrated, and the shared secret matches. Ready to promote.

---

## Step 4 — Promote CP status from `infra_pending` → `ready`

```bash
curl -sk -X PATCH http://127.0.0.1:8091/api/superadmin/clients/2 \
  -H "Authorization: Bearer $CP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"ready"}'
# → {"ok":true}
```

The federated dashboard will now include this DP in its `/internal/metrics`
fan-out. New KYC applications targeting this DP's subdomain will be
routed through the CP proxy.

Optional: flip to `active` when you're ready to let real user traffic
through:

```bash
curl -sk -X PATCH http://127.0.0.1:8091/api/superadmin/clients/2 \
  -H "Authorization: Bearer $CP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"active"}'
```

---

## Step 5 — Provision a reviewer for this client

The CP fires an internal call to the DP; **nothing is stored on the CP DB**.

```bash
# First, superadmin needs the DP-side client id. Since each DP hosts
# exactly one exam board in this model, that's typically the first row
# in its `clients` table. Query the DP or check its bootstrap output.

DP_CLIENT_ID=1   # NTA's row id within verification_nta.clients

curl -sk -X POST http://127.0.0.1:8091/api/superadmin/clients/2/reviewers \
  -H "Authorization: Bearer $CP_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"username\": \"nta_reviewer_01\",
    \"password\": \"<a strong password>\",
    \"display_name\": \"NTA Reviewer #1\",
    \"email\": \"reviewer1@nta.gov.in\",
    \"client_id\": $DP_CLIENT_ID
  }"
# → {"user_id":42,"username":"nta_reviewer_01","client_registry_id":2}
```

Under the hood the CP called `POST https://nta.verify.portal.io/api/internal/users/create`
with the `X-Internal-API-Key` header. NTA's DP bcrypt'd the password and
INSERTed into its own `users` table with `role='client_reviewer'`.

Hand the credentials to the reviewer out-of-band. They log in at
`https://nta.verify.portal.io/reviewer/login`.

---

## Step 6 — Smoke test end-to-end

- Reviewer login: `https://nta.verify.portal.io/reviewer/login` — should
  see empty inbox.
- Applicant registers via `https://nta.verify.portal.io/register` —
  should submit successfully; row lands on CP DB.
- Reviewer sees the pending KYC in inbox.
- Reviewer approves → CP fires `/orgs/create` to NTA's DP → org + admin
  + coa row + exam subs created.
- Admin clicks magic link → lands on NTA's admin dashboard.

If any step fails, `journalctl -u portal-nta.service --since "5 min ago"`
usually has the answer.

---

## Rollback / decommission

To remove a client cleanly:

```bash
# 1. Soft-delete on CP (row kept for audit)
curl -sk -X DELETE http://127.0.0.1:8091/api/superadmin/clients/2 \
  -H "Authorization: Bearer $CP_TOKEN"

# 2. Stop + disable DP systemd
sudo systemctl stop portal-nta.service
sudo systemctl disable portal-nta.service
sudo rm /etc/systemd/system/portal-nta.service
sudo systemctl daemon-reload

# 3. Remove nginx vhost
sudo rm /etc/nginx/sites-enabled/portal-nta.conf
sudo rm /etc/nginx/sites-available/portal-nta.conf
sudo nginx -t && sudo systemctl reload nginx

# 4. Move DP home aside (do NOT rm -rf — data recovery may be needed)
TS=$(date -u +%Y%m%dT%H%M%SZ)
sudo mv /opt/verificationportal-nta /opt/verificationportal-nta.removed.$TS

# 5. Only if you're sure: drop the database
# PGPASSWORD=... psql ... -c "DROP DATABASE verification_nta;"
# (Irreversible. Leave in place until you've confirmed no data recovery is needed.)
```

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| CP returns 502 on `/internal/health` | DP not started, wrong port, or firewall blocks CP→DP | `systemctl status portal-nta` + `curl 127.0.0.1:<port>/api/health` locally |
| CP returns 401 on `/internal/*` | INTERNAL_API_KEY mismatch between DP `.env` and CP `clients_registry.api_key` | Rotate: `PATCH .../clients/{id}` with `{"rotate_api_key":true}`, update DP `.env`, restart DP |
| Reviewer login "invalid credentials" | Password was mistyped OR reviewer INSERT failed silently — check DP logs | Re-provision via `POST /clients/{id}/reviewers` with a fresh username |
| KYC lands on wrong DP | Applicant's subdomain in browser doesn't match nginx server_name | Check nginx vhost + DNS resolution |
| Federated dashboard skips a DP | `status` is `infra_pending` (not yet promoted) or `suspended` | PATCH to `ready` or `active` |
| Browser TLS warning on subdomain | Cert doesn't include new subdomain SAN | Re-issue per Step 2f |

---

## Notes on this model

- **CP DB stores NO user credentials.** Reviewer + admin passwords live only on the DP that owns them. Compromising the CP does not leak any DP's user table.
- **Per-DP JWT_SECRET** means a JWT signed by NTA's DP is structurally invalid at SSC's DP. Cross-tenant token replay is impossible by construction.
- **One shared secret per DP.** DP's `INTERNAL_API_KEY` and CP's `clients_registry.api_key` for that DP must match. Rotation is a two-side update.
- **No add-dp automation.** Bash scripts in `scripts/multi-tenant/` are example templates; the canonical path is this runbook.
