# `client-bootstrap/linux/`

Builds the operator-laptop install bundle for Linux (Ubuntu 18.04+).

## What's in here

| Path | Purpose |
|------|---------|
| `meta-deb/` | Source tree of the `verification-portal-client.deb` meta-package. Holds DEBIAN control / postinst / prerm scripts and the desktop launcher. |
| `install.sh` | Bootstrap script shipped inside the bundle. IT runs this on each laptop; it `apt-get install`s the three `.debs` and writes the portal URL to `/etc/verification-portal/portal.conf`. |
| `build-bundle.sh` | Build host entry point. Builds the iris service `.deb`, builds the meta `.deb`, copies in the vendor MorFin `.deb`, and tars everything into `dist/verification-portal-client_<ver>_linux.tar.gz`. |

## Building the bundle

Prerequisites on the build host (Linux, can be a CI runner or a VM):

- `dpkg-deb`
- `mvn` (used transitively by `iris-service/build-deb.sh`)
- The vendor's `Marvis_Auth.jar` staged at `Portal-main/iris-service/lib/Marvis_Auth.jar`
  (see `iris-service/lib/README.md`)
- The vendor's `MorfinAuthClientService.deb` accessible — defaults to
  `verification-portal/MorfinAuth_Linux_Web_SDK_1.0.0.0/Setup/`, override
  via `MORFIN_DEB=/some/path.deb`.

Then:

```bash
cd Portal-main/client-bootstrap/linux
./build-bundle.sh
# → dist/verification-portal-client_1.0.0_linux.tar.gz
```

## Field install (operator laptop)

```bash
tar xzf verification-portal-client_*_linux.tar.gz
cd verification-portal-client_*_linux/
sudo ./install.sh https://portal.example.com
```

What happens:

1. `/etc/verification-portal/portal.conf` is written with the URL.
2. `apt-get install` lays down `morfinauth-client-service.deb` (vendor)
   — this drops the daemon JAR + systemd unit + cert auto-import.
3. `apt-get install` lays down `mantra-iris-service_*_all.deb` (ours)
   — this drops the iris JAR + systemd unit (running in
   `IRIS_PROVIDER=marvis-strict` mode by default).
4. `apt-get install` lays down `verification-portal-client_*_all.deb`
   (this directory's meta-package). Its postinst pins the portal URL as
   the homepage in Chrome / Chromium / Firefox managed-policy files
   and refreshes the desktop database so the launcher icon appears.
5. Both daemons are restarted so they pick up any cert/policy changes.

After install, the operator opens their browser and the portal is the
homepage. With a Mantra fingerprint reader plugged in, the green
"Device ready" dot appears within ~2 s.

## Updating the portal URL after install

```bash
sudo $EDITOR /etc/verification-portal/portal.conf
sudo dpkg-reconfigure verification-portal-client    # re-runs postinst
```

The desktop launcher reads the conf at click time, so it picks up the
new URL without a re-install.

## Uninstall

```bash
sudo apt-get purge verification-portal-client mantra-iris-service \
                  morfinauth-client-service
```
