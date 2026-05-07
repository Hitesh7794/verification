# `client-bootstrap/windows/`

Builds the operator-laptop install bundle for **Windows 10 (build 19041+) / Windows 11**.

> **Status: verified working end-to-end on 2026-05-07.** Tested on a
> real Windows 10 build 19045 laptop with a real MIS100V2 device.
> `curl.exe -X POST http://localhost:8031/iris/connecteddevicelist`
> from the Windows host returns
> `{"ErrorCode":"0","ErrorDescription":"Found Devices: MIS100V2"}` —
> proves the full chain works (Windows curl → WSL2 NAT forwarder →
> Javalin → Marvis SDK → Linux `.so` → libusb → usbipd → physical
> device). See [`IRIS_VENDOR_ISSUE.md`](../../IRIS_VENDOR_ISSUE.md)
> for the verification details and the operational caveats discovered
> during that test.

## Why this is more involved than the Linux bundle

The vendor MorFin daemon JAR ships native Windows DLLs that work fine —
its fingerprint scanner integration runs natively on Windows. But the
Marvis (iris) JAR in the same package ships a **broken Windows DLL**:
its JNI callback signatures don't match the Java classes in the same
JAR (verified by bytecode inspection, see [`IRIS_VENDOR_ISSUE.md`](../../IRIS_VENDOR_ISSUE.md)).
The Linux `.so` files in the same JAR work correctly.

Rather than wait on a vendor fix, we **run the iris service inside WSL2
Ubuntu** on the operator's Windows laptop, with the iris USB device
passed through via Microsoft's `usbipd-win`. The browser still talks to
`localhost:8031` — WSL2's NAT-mode localhost forwarder bridges Windows
host calls to the service inside the VM, provided the JVM binds to a
non-loopback address (see "IRIS_BIND env var" below).

```
┌─ Windows host ────────────────────────────────────────────────────┐
│                                                                    │
│  Browser ─→ localhost:8030  (MorFin daemon, native Win service)   │
│         ─→ localhost:8031  (iris service inside WSL2)             │
│                                  │                                │
│  ┌── WSL2 (Ubuntu-22.04) ────────▼──────────────────────────────┐ │
│  │  systemd → mantra-iris-service.service → :8031              │ │
│  │  Marvis_Auth.jar uses linux/x86_64/*.so (working bytes)     │ │
│  │       ↑                                                      │ │
│  │       │ /dev/bus/usb/...    (USB passthrough)               │ │
│  └───────│──────────────────────────────────────────────────────┘ │
│          │                                                         │
│  ┌── usbipd-win ─┴──────────────────────┐                         │
│  │  Routes vendor 2c0f:2100 to WSL2    │                         │
│  │  (auto-reattaches at boot via       │                         │
│  │   scheduled task)                   │                         │
│  └─────────────────┬───────────────────┘                         │
│                    │                                              │
└────────────────────┼──────────────────────────────────────────────┘
                     │ USB
              ┌──────▼──────┐
              │  MIS100V2   │
              └─────────────┘
```

If/when Mantra ships a fixed Windows DLL: drop the iris service back
into a `nssm`-registered native Windows service in `install.ps1` and
remove the WSL2 path. The frontend doesn't change.

## Bundle contents

```
VerificationPortalClient-<ver>-windows.zip
├── install.ps1                                      ← entry point (admin)
├── wsl-iris-setup.sh                                ← runs INSIDE WSL during phase 3
├── morfin/
│   ├── morfinauth-client-service-1.0.0.0.jar       (vendor; runs Win-native)
│   └── certs/                                        (vendor TLS certs)
├── iris-wsl/
│   └── mantra-iris-service_<ver>_all.deb           (installed inside WSL)
├── tools/
│   └── nssm.exe                                      (Windows service registrar for MorFin)
└── README.txt
```

## Prerequisites — operator laptop

| Requirement | Why |
|------|-----|
| Windows 10 build 19041+ (May 2020 update / 22H2) **or** Windows 11 | WSL2 needs build 19041+ |
| 64-bit Windows | WSL2 is 64-bit only |
| Hardware virtualization enabled in BIOS/UEFI | WSL2 runs in a lightweight Hyper-V VM |
| ~4 GB free disk | WSL2 + Ubuntu + JRE + iris .deb |
| Adoptium Temurin JRE 17 on PATH | MorFin daemon needs Java |
| Internet for first install | Downloads WSL kernel + Ubuntu image (~1 GB once) |

The installer fails fast with a clear message if any of these aren't met.

## Building (build host)

Prerequisites:

- `mvn` (Maven)
- `dpkg-deb` (`brew install dpkg` on macOS, `apt install dpkg` on Linux)
- `Marvis_Auth.jar` staged at `Portal-main/iris-service/lib/`
- Vendor `MorfinAuthClientService.deb` accessible (auto-detected at the
  project's typical layout, override via `MORFIN_DEB=`)
- `nssm.exe` (64-bit) at `client-bootstrap/windows/tools/nssm.exe`
  ([nssm.cc/download](https://nssm.cc/download), BSD-licensed)

```bash
cd Portal-main/client-bootstrap/windows
./build-bundle.sh
# → dist/VerificationPortalClient-1.0.0-windows.zip
```

## Field install (operator laptop)

1. **Install Java 17** — Adoptium Temurin from
   [adoptium.net](https://adoptium.net/), tick "Add to PATH".
2. Unzip the bundle anywhere.
3. Open PowerShell **as Administrator** in the unzipped folder.
4. Run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1 -PortalUrl https://portal.example.com
   ```

### Two-phase install (handles WSL2 reboot)

If WSL2 isn't already enabled on the machine, `install.ps1` enables the
required Windows features and exits with a reboot prompt. After
rebooting, re-run **the same command** — the script detects WSL2 is now
ready and continues with provisioning. No state is lost.

### What `install.ps1` does, in order

| # | Step | Reversible? |
|---|------|-------------|
| 1 | Pre-flight: admin, OS build, Java | yes |
| 2 | Enable WSL feature + Virtual Machine Platform | yes (`Disable-WindowsOptionalFeature`) |
| 3 | Install Ubuntu-22.04 distro | yes (`wsl --unregister Ubuntu-22.04`) |
| 4 | Install `usbipd-win` via winget | yes (`winget uninstall`) |
| 5 | Bind iris USB hardware ID + create scheduled task | yes (`usbipd unbind`, `Unregister-ScheduledTask`) |
| 6 | Run `wsl-iris-setup.sh` inside WSL — apt deps + iris .deb + systemd | yes (`apt purge`) |
| 7 | Import vendor TLS certs into `Cert:\LocalMachine\Root` | yes (`Get-ChildItem Cert:\LocalMachine\Root \| Remove-Item`) |
| 8 | Register MorFin daemon as Windows Service via `nssm` | yes (`nssm remove`) |
| 9 | Pin Chrome + Edge homepage in `HKLM` policy | yes (`Remove-Item`) |
| 10 | Drop Desktop + Start Menu `.url` shortcuts | yes (`Remove-Item`) |

Idempotent: re-running updates everything in place (services stopped +
re-registered, certs re-imported, policies overwritten).

### CLI flags

```powershell
.\install.ps1 -PortalUrl https://portal.example.com `
              -InstallRoot "C:\Program Files\VerificationPortal" `
              -WslDistro "Ubuntu-22.04" `
              -IrisHwId "2c0f:2100"

.\install.ps1 -PortalUrl ... -SkipIris    # fingerprint-only centers
```

## Verifying the install

```powershell
# Native Windows service
Get-Service MorfinAuthClientService
curl http://localhost:8030/

# Iris service inside WSL
wsl -d Ubuntu-22.04 -- systemctl status mantra-iris-service
curl -Method POST http://localhost:8031/iris/supporteddevicelist

# USB passthrough
usbipd list                 # iris device should show "Shared" or "Attached"
Get-ScheduledTask VerificationPortal-IrisUsbAttach
```

If the iris endpoint times out: usually means the device isn't currently
attached to WSL. Plug + replug the iris reader, or run on the host:

```powershell
usbipd attach --hardware-id 2c0f:2100 --wsl
```

## `IRIS_BIND` env var (and why this matters for WSL2)

`mantra-iris-service` reads `IRIS_BIND` to decide which interface
Javalin binds on:

| `IRIS_BIND` | Effect | Used in |
|---|---|---|
| (unset) | `127.0.0.1` (loopback only) | Default — native Linux operator laptops, where defence-in-depth matters |
| `0.0.0.0` | All interfaces | WSL2 path — required, see below |

WSL2's NAT-mode localhost forwarder (the default networking mode on
Win10 19045 and most Win11 builds) does **not** reliably bridge a
Windows-host `localhost:8031` call to a service bound on `127.0.0.1`
inside the WSL VM. Symptoms: Windows `curl` returns "Empty reply" or
"Connection aborted" while inside-WSL `curl 127.0.0.1:8031` works
fine. Binding to `0.0.0.0` inside WSL fixes it. The security cost is
zero — WSL2 exposes the VM only on a private Hyper-V vSwitch, never
on a LAN-routed interface.

`wsl-iris-setup.sh` writes a systemd drop-in at
`/etc/systemd/system/mantra-iris-service.service.d/wsl-bind.conf`
that sets `IRIS_BIND=0.0.0.0` for the WSL case. The .deb's base unit
file is unchanged, so a native Linux install of the same .deb still
binds to loopback.

If your Windows version is Win11 22H2+ with WSL 2.0.0+, you can use
`networkingMode=mirrored` in `~\.wslconfig` instead of the
`IRIS_BIND` override — mirrored mode shares Windows' network
interfaces directly, eliminating the forwarder layer. The drop-in
above is harmless in mirrored mode, so the bundle works on both.

## Operational caveats (read before fleet rollout)

These were discovered during the 2026-05-07 verification on Win10
19045. They don't block functionality but should be hardened before
deploying to many laptops.

### 1. WSL2 idle timeout (`vmIdleTimeout`)

Default WSL2 behaviour: after ~60s with no shells connected, the VM
shuts down. Inside the VM, that's a SIGTERM to systemd → SIGTERM to
`mantra-iris-service` → exit 143. Next operator request finds nothing
on `localhost:8031`. We tried `vmIdleTimeout=-1` in `~/.wslconfig` to
disable the timeout, but the value isn't being honored on Win10 19045
(possibly version-dependent — newer WSL parses `-1` correctly).

**Workarounds, in order of preference:**

1. Try `vmIdleTimeout=2147483647` (large int) instead of `-1` — some
   WSL versions only accept positive values.
2. Run a persistent `wsl -d Ubuntu-22.04` shell as a Windows service
   via `nssm`. As long as a shell is connected, WSL2 will not idle
   the VM regardless of timeout settings. The shell consumes
   negligible resources.
3. A small tray app that pings `localhost:8031` every 30s. Cheap to
   implement, no service registration overhead.
4. Switch to `networkingMode=mirrored` (Win11 22H2+ only) — mirrored
   mode keeps the VM warmer because it shares Windows' network
   interfaces.

### 2. usbipd auto-attach on VM resume

`install.ps1` registers a Windows scheduled task
(`VerificationPortal-IrisUsbAttach`) that fires at user logon and
runs `usbipd attach --hardware-id 2c0f:2100 --wsl`. **It does not
fire on WSL VM resume.** So if the VM cycles (idle-out + later
re-launch), the USB attachment is gone until the operator either
re-logs-in to Windows or someone manually re-runs `usbipd attach`.

**Production fix candidates:**

- Extend the scheduled task with a trigger on event log entry
  "WSL VM started" (if WSL emits one).
- A systemd timer inside WSL that calls `wsl.exe usbipd attach` on
  the host every minute. This requires the WSL distro to have
  permission to invoke `wsl.exe`, which it does by default.
- Combine with #1 — keep the VM alive forever, then this issue
  doesn't manifest.

### 3. First-call cold-boot latency

A cold WSL VM start (from `Stopped` state) takes:

- ~3-5s for the VM to boot
- ~2s for systemd to start the iris service
- ~1-2s for the JVM to start and Marvis SDK to init

Total: ~5-10s for the first iris call after a VM cycle. Subsequent
calls are <100ms forwarder + ~1-3s for the actual iris capture.

Operators should not see this in normal use because most candidates
will pass on fingerprint and never trigger the iris fallback.
Sessions that do trigger iris within the same WSL VM lifetime see
sub-second response.

## Uninstall

```powershell
# Windows-side
Stop-Service MorfinAuthClientService -Force
& "C:\Program Files\VerificationPortal\tools\nssm.exe" remove MorfinAuthClientService confirm
Unregister-ScheduledTask -TaskName VerificationPortal-IrisUsbAttach -Confirm:$false
Remove-Item -Recurse "C:\Program Files\VerificationPortal"
Remove-Item HKLM:\SOFTWARE\Policies\Google\Chrome\HomepageLocation
Remove-Item HKLM:\SOFTWARE\Policies\Microsoft\Edge\HomepageLocation

# WSL-side iris service
wsl -d Ubuntu-22.04 -- sudo apt-get purge -y mantra-iris-service

# Optional — completely remove the WSL distro
wsl --unregister Ubuntu-22.04
```

## Why we don't ship a `.msi`

The two-phase install (with a reboot in the middle), Windows feature
enablement, and WSL provisioning steps don't translate well to MSI's
declarative model. A PowerShell installer that IT can read, audit, and
patch in the field is the better fit for this stack. If a future
deployment target requires `.msi` (Intune / SCCM), wrap `install.ps1`
in a custom-action MSI — the script itself is the source of truth.
