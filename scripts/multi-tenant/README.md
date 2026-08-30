# Phase-4 multi-tenant provisioning

Scripts to add and remove a Data Plane on the existing EC2 host, alongside
the primary DP (`portal-server` on `:8090`) and the Control Plane
(`cp-server` on `:8091`).

Each DP gets:
- Its own PostgreSQL database on the shared RDS instance.
- Its own `/opt/verificationportal-<slug>/` directory (binary, env,
  logs, data, artifacts).
- Its own systemd unit `portal-<slug>.service`.
- Its own nginx vhost `portal-<slug>.conf` on a dedicated subdomain.
- Its own `JWT_SECRET` and `INTERNAL_API_KEY` (per-DP secrets — token
  from DP-A is rejected by DP-B by construction).
- A row in the CP's `clients_registry` so the CP can reach it.

Provider credentials (SMTP, Razorpay, S3, TrustView) are inherited from
the source DP's `.env`. Override in the rendered `.env` for per-DP
billing / separate providers.

## Prerequisites

- Runs on the EC2 host itself, as the `ubuntu` user with `sudo` rights.
- The primary DP is already running at `/opt/verificationportal/` on `:8090`.
- The Control Plane is already running on `127.0.0.1:8091`.
- `openssl`, `curl`, `python3`, `psql`, `nginx`, `systemctl`, `sudo` on PATH.
- You have a Bearer JWT from the CP's `/api/superadmin/login` endpoint
  (get one with `curl` inside an SSH tunnel — see below).

## Get a CP superadmin JWT

The CP is not exposed via nginx yet, so log in via localhost on the box:

```bash
curl -s -X POST http://127.0.0.1:8091/api/superadmin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"cpsuper","password":"<the seeded password>"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])'
```

Save that JWT — you'll pass it as `--cp-token` to both scripts. It's
valid for 12 h.

## Add a Data Plane

```bash
./add-dp.sh \
  --name NTA \
  --slug nta \
  --port 8092 \
  --domain nta.verifyportal.13-127-17-248.nip.io \
  --cp-token "$CP_TOKEN"
```

Optional flags: `--db-name`, `--cp-url`, `--source-env`, `--source-bin`,
`--pg-host`, `--pg-user`, `--pg-pass`, `--dry-run`.

`--dry-run` prints every command that would run without touching the
system. Run it first the first few times.

What happens:
1. `CREATE DATABASE verification_nta`.
2. `/opt/verificationportal-nta/` laid down with a copy of the primary
   DP's binary.
3. Per-DP `.env` rendered from the template, with `JWT_SECRET` and
   `INTERNAL_API_KEY` freshly generated. Shared providers inherited
   from `/opt/verificationportal/.env`.
4. Systemd unit + nginx vhost installed.
5. `systemctl start portal-nta` → wait for `/health`.
6. `POST /api/superadmin/clients` on CP → captures returned `api_key`
   and writes it into the DP's `.env` as `DATA_PLANE_API_KEY`.
7. `PATCH /api/superadmin/clients/<id>` on CP sets its stored `api_key`
   to the DP's `INTERNAL_API_KEY` (so CP → DP `/api/internal/*` calls
   authenticate correctly).
8. Restart DP one more time to pick up the CP-issued env vars.
9. `curl /api/internal/health` from CP-side → verifies round-trip.
10. `nginx -s reload`.

## Remove a Data Plane

```bash
./remove-dp.sh --slug nta --cp-token "$CP_TOKEN"
# Also drop the database (IRREVERSIBLE):
./remove-dp.sh --slug nta --cp-token "$CP_TOKEN" --drop-db
```

- Systemd unit is stopped, disabled, removed.
- Nginx vhost is removed, nginx reloaded.
- CP registry row is soft-deleted (`DELETE /api/superadmin/clients/{id}` →
  `status = 'deleted'`, row kept for audit).
- `/opt/verificationportal-<slug>/` is **moved aside** to
  `.removed.<timestamp>` rather than deleted, so recovery is a rename.
- The database is **kept** by default. Pass `--drop-db` only when
  you're sure.
- S3 objects (docs + photos) are NOT touched.

## TLS cert extension

The scripts install the new nginx vhost using the SAME cert paths as
the primary DP:

```
ssl_certificate     /etc/nginx/certs/verifyportal/fullchain.pem;
ssl_certificate_key /etc/nginx/certs/verifyportal/privkey.pem;
```

That cert covers `verifyportal.13-127-17-248.nip.io` only. Browsers
hitting `nta.verifyportal.13-127-17-248.nip.io` will fail TLS validation
until the cert is re-issued with the new subdomain as a SAN.

**Re-issue procedure** (Caddy-driven, matches the manual renewal ritual
in `reference_common_ops.md`):

1. Add the new subdomain to Caddy's config (`/etc/caddy/Caddyfile`),
   e.g. `verifyportal.13-127-17-248.nip.io, nta.verifyportal.13-127-17-248.nip.io {`.
2. `sudo systemctl stop nginx && sudo systemctl start caddy`.
3. Wait 30 s for Caddy's ACME dance to issue a cert with both SANs.
4. Copy from Caddy's on-disk store to nginx's cert path:
   ```bash
   sudo cp /var/lib/caddy/.local/share/caddy/certificates/*/verifyportal*/verifyportal*.crt \
           /etc/nginx/certs/verifyportal/fullchain.pem
   sudo cp /var/lib/caddy/.local/share/caddy/certificates/*/verifyportal*/verifyportal*.key \
           /etc/nginx/certs/verifyportal/privkey.pem
   ```
5. `sudo systemctl stop caddy && sudo systemctl start nginx`.

Alternative: get a wildcard cert `*.verifyportal.13-127-17-248.nip.io`
via DNS-01 (needs DNS API access — nip.io is a public wildcard so
this path is not straightforward).

## Verify a provisioned DP

```bash
# 1. DP process is up
sudo systemctl status portal-nta

# 2. DP /health responds locally
curl -f http://127.0.0.1:8092/health

# 3. DP /health responds through nginx (after cert extension)
curl -k https://nta.verifyportal.13-127-17-248.nip.io/health

# 4. CP → DP internal round-trip works
INTERNAL_KEY=$(sudo grep '^INTERNAL_API_KEY=' /opt/verificationportal-nta/.env | cut -d= -f2)
curl -H "X-Internal-API-Key: $INTERNAL_KEY" \
     http://127.0.0.1:8092/api/internal/health

# 5. CP sees the new DP in its registry
curl -H "Authorization: Bearer $CP_TOKEN" \
     http://127.0.0.1:8091/api/superadmin/clients \
     | python3 -m json.tool

# 6. CP federated dashboard aggregates this DP's metrics
curl -H "Authorization: Bearer $CP_TOKEN" \
     http://127.0.0.1:8091/api/superadmin/dashboard \
     | python3 -m json.tool
```

## Known gaps (deliberate)

- **No new-EC2 provisioning.** Same-box only. Adding a DP on a different
  machine requires manually spinning up EC2 + running the script there.
- **No cross-DP data migration.** New DPs start with an empty schema.
  Moving an existing client's data from the primary DP to a new dedicated
  DP is a separate one-off script.
- **No superadmin UI to trigger add-dp.** Runs from the shell only.
  (The CP React frontend is a separate Phase-4 track, owned by Rahul.)
- **Port allocation is manual.** You pass `--port` explicitly. No
  next-free-port helper — pick from 8092 onwards.
- **DP webapp bundle is empty by default.** The nginx vhost expects
  `/opt/verificationportal-<slug>/webapp/`. If you want each DP to serve
  its own SPA, copy the built frontend into that path after `add-dp.sh`
  completes. If you want all DPs to share the primary DP's UI (no visual
  per-DP branding), just symlink:
  ```bash
  sudo ln -s /opt/verificationportal/webapp /opt/verificationportal-nta/webapp
  ```

## File layout

```
scripts/multi-tenant/
  README.md                          # this file
  add-dp.sh                          # provisioning
  remove-dp.sh                       # rollback / teardown
  templates/
    dp.env.tmpl                      # rendered → /opt/verificationportal-<slug>/.env
    dp.service.tmpl                  # rendered → /etc/systemd/system/portal-<slug>.service
    dp-nginx.conf.tmpl               # rendered → /etc/nginx/sites-available/portal-<slug>.conf
```
