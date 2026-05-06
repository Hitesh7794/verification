# `client-bootstrap/windows/`

Builds the operator-laptop install bundle for **Windows 10 (build 19041+) / Windows 11**.

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
`localhost:8031` — WSL2's localhost forwarding makes the routing
transparent.

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
