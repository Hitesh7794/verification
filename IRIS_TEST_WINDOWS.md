# Iris hardware test on a Windows laptop

This document describes **two paths** for running the iris service on
Windows. The recommended path for any operator-laptop or production
testing is the **WSL2 path** (verified working 2026-05-07). The
native-Windows path remains broken at the vendor level.

> **Recommended: WSL2 path** — `client-bootstrap/windows/install.ps1`
> provisions WSL2 Ubuntu, installs the iris `.deb` inside it (which uses
> the working Linux `.so` natives in `Marvis_Auth.jar`), and uses
> `usbipd-win` to pass the MIS100V2 USB device through to WSL. Browser
> still talks to `localhost:8031` because WSL2's NAT-mode forwarder
> bridges Windows → WSL transparently. Verified end-to-end on Win10
> 19045 with real hardware. See
> [`client-bootstrap/windows/README.md`](./client-bootstrap/windows/README.md)
> and [`IRIS_VENDOR_ISSUE.md`](./IRIS_VENDOR_ISSUE.md) for the operational
> details. **The rest of this document is the legacy native-Windows path,
> which still fails at Step 5.**

> **⚠️ Native-Windows path — still vendor-blocked.** The bundled
> Windows DLLs in `Marvis_Auth_Linux_Java_1.0.0.0/Libs/Marvis_Auth.jar`
> are broken — Mantra's own `Marvis_Auth_Sample.jar` also crashes with
> `NoSuchMethodError: CompleteCallback` during JNI registration. The
> guide below is **expected to fail at Step 5** until Mantra ships a
> corrected Windows JAR. Every step before that — file copy, Java
> setup, `mvn package`, USB driver install, device detection by
> Windows — is verified working. See `CONTEXT.md` §6 for the full
> diagnostic. Use the WSL2 path above for any real testing.

## What this is, and what it isn't

**This guide is for:** verifying the iris fallback flow with real
hardware before operator-laptop rollout.

**This is *not* for:** the Mac you've been developing on. The Marvis
SDK ships no macOS native build, so iris hardware *cannot* be tested
on macOS. Same applies to the EC2 server — USB doesn't traverse the
network.

The Marvis JAR is verified cross-platform (it bundles
`linux/x86_64/*.so` AND `win/x64/*.dll` in a single archive and
dispatches at runtime), so the same JAR we use in `iris-service/`
runs on Windows without modification.

## Prerequisites

- A Windows 10 or Windows 11 laptop with admin rights
- The MIS100V2 iris device (USB)
- A reasonably fresh internet connection (you'll download Java + Maven
  + Go + Node)
- The two folders from your Mac:
  - `Portal-main/`
  - `Marvis_Auth_Linux_Java_1.0.0.0/` (vendor SDK — only needs the
    `Libs/Marvis_Auth.jar` file)
- The `gndu27/` candidate data tree if you want non-empty test data
  (optional — you can skip this and use empty seeds for the iris-only
  smoke test)

## Step 0 — Get the files onto Windows

Use any transfer method (USB stick, AirDrop, cloud sync, `scp`, GitHub).
A clean layout looks like:

```
C:\dev\
├── Portal-main\                       (whole project)
├── gndu27\                            (candidate data — optional)
└── Marvis_Auth_Linux_Java_1.0.0.0\    (only need Libs\Marvis_Auth.jar)
```

## Step 1 — Install dependencies (one-time)

Open **PowerShell as Administrator** and run:

```powershell
winget install EclipseAdoptium.Temurin.17.JDK
winget install Apache.Maven
winget install GoLang.Go
winget install OpenJS.NodeJS
```

If `winget` isn't on your machine (older Windows builds), download the
installers directly:

| Tool | Source |
|---|---|
| Java 17 (Adoptium Temurin) | https://adoptium.net/temurin/releases/?version=17 |
| Maven | https://maven.apache.org/download.cgi (zip — extract, add `bin\` to PATH) |
| Go | https://go.dev/dl/ |
| Node.js (LTS) | https://nodejs.org/ |

**Close + reopen PowerShell** so the new tools land on `PATH`.

Verify each one:

```powershell
java --version    # → openjdk 17...
mvn -version      # → Apache Maven 3.9...
go version        # → go1.22+
node --version    # → v18+ or v20+
```

## Step 2 — Stage the Marvis JAR into the iris-service

```powershell
cd C:\dev\Portal-main\iris-service
New-Item -ItemType Directory -Force -Path .\lib | Out-Null
Copy-Item C:\dev\Marvis_Auth_Linux_Java_1.0.0.0\Libs\Marvis_Auth.jar .\lib\
```

After this `lib\Marvis_Auth.jar` should exist.

## Step 3 — Plug in the iris device

Plug the **MIS100V2** into a USB port on the Windows laptop. If Windows
asks to install a driver, accept whatever Mantra ships (or whatever
Windows Update offers).

Confirm Windows sees the device:

```powershell
Get-PnpDevice | Where-Object { $_.FriendlyName -like "*MIS*" -or $_.Manufacturer -like "*Mantra*" }
```

You should see one entry. If nothing shows up, try a different USB
port or check Device Manager for an unrecognized device.

## Step 4 — Build + run the iris service (Terminal 1)

```powershell
cd C:\dev\Portal-main\iris-service
mvn -q package

# Note the SEMICOLON in the classpath — Windows uses `;`
# (Linux/Mac use `:`). The Marvis JAR must be on the classpath
# alongside our shaded service JAR.
java -cp "target\mantra-iris-service-1.0.0.jar;lib\Marvis_Auth.jar" `
     com.veni.irisservice.Main
```

You should see:

```
[main] INFO  ... using MarvisIrisProvider (real SDK)
[main] INFO  ... mantra-iris-service listening on 127.0.0.1:8031
```

If you see `falling back to MockIrisProvider`, the JAR didn't load —
see [Troubleshooting](#troubleshooting) below.

## Step 5 — Verify the device is detected (Terminal 2)

```powershell
curl.exe -X POST http://localhost:8031/iris/connecteddevicelist
```

> Use `curl.exe` rather than just `curl` in PowerShell — Windows
> aliases `curl` to `Invoke-WebRequest`, which has different syntax.

Expected when the device is plugged in:

```json
{"ErrorCode":"0","ErrorDescription":"Found Devices: MIS100V2"}
```

**This is the moment of truth.** If you see `MIS100V2` in
`ErrorDescription`, the SDK loaded successfully, the Windows DLLs
were extracted from the JAR, and the device is recognised.

If `ErrorDescription` is empty, the SDK is up but isn't seeing the
device — try unplugging / replugging, or a different USB port.

## Step 6 — Run the backend (Terminal 3)

```powershell
cd C:\dev\Portal-main\backend
go run .\cmd\server
```

You should see something like:

```
loading candidate index from C:\dev\gndu27 ...
indexed 28xx candidates across 11 centers
listening on :8080
```

If `indexed 0 candidates` appears, the data tree wasn't found. Either:

- Copy the `gndu27\` directory into `C:\dev\` (so it sits alongside
  `Portal-main\`), or
- Set `DATA_DIR` explicitly:
  ```powershell
  $env:DATA_DIR = "C:\dev\gndu27\.."
  go run .\cmd\server
  ```

## Step 7 — Run the frontend (Terminal 4)

```powershell
cd C:\dev\Portal-main\frontend
npm install     # one-time, ~10s
npm run dev
```

When Vite prints `ready in xxx ms`, open `http://localhost:5173/` in
Edge or Chrome on the Windows laptop.

## Step 8 — Test the iris flow in the browser

1. Login as `client / client123`.
2. Enter roll `99999` (a test candidate we registered earlier — if
   the data tree wasn't copied, use any roll the index found).
3. **Step 2 (face capture)** — Luxand isn't running on this Windows
   box, so face matching will return *"luxand-service unreachable"*.
   That's fine; click through.
4. **Step 3 (fingerprint)** — without the MorFin daemon installed,
   you'll see *"Device service not running"*. **This is exactly what
   triggers the iris fallback below.**
5. The **iris fallback card** appears: *"Fingerprint did not match.
   You can try iris as a fallback."* → click **Try iris instead**.
6. The iris card auto-detects the device and shows a green status
   banner: **"Iris device ready · MIS100V2 · *real serial number*"**.
   The serial number is fetched from `MarvisAuth.Init` and is the
   actual hardware ID of *your* device — proof the SDK is genuinely
   talking to it.
7. Click **Capture iris**. Look at the device. After ~1–3 seconds,
   you'll see two real iris images (one per eye) with per-eye quality
   numbers from `IrisAnatomy`. These are produced by the SDK from
   actual sensor frames.
8. Click **Verified** or **Not verified** — the submission carries
   `via=iris` and the iris quality numbers are persisted to the audit
   row in the backend's SQLite database.

## What "real success" looks like

| What you'll see | Why it proves real hardware |
|---|---|
| Status banner: `Iris device ready · MIS100V2 · 1234567` | Serial number returned by `Init` is unique per device |
| Live BMP previews of both eyes (not the placeholder image) | Bytes came from the camera + ONNX iris-pipeline model |
| Quality numbers in the 60–90 range when looking straight | `IrisAnatomy.quality` is a real per-eye metric |
| Latency 1–3 seconds for `Capture iris` | Real `AutoCapture` time on this hardware (mock is 1.5 s flat) |

## Troubleshooting

| Step | Symptom | Likely cause / fix |
|---|---|---|
| 1 | `winget` not found | Older Windows. Download installers manually (links in Step 1). |
| 2 | `Copy-Item` says file not found | Path typo — verify SDK was extracted to the expected location. |
| 4 | Maven build fails with `cannot find Marvis_Auth.jar` | Step 2 was skipped or the file was placed in the wrong directory. |
| 4 | Service starts but logs `falling back to MockIrisProvider` | Marvis JAR not on classpath. Verify the path in your `java -cp` command, paying attention to the `;` separator. |
| 4 | `UnsatisfiedLinkError: ... Marvis_Auth.dll: cannot find` | Windows DLL didn't extract from the jar. Usually a JNA tmp-dir permissions issue — try running PowerShell as Administrator, or clear `%TEMP%` and retry. |
| 5 | `ErrorDescription` empty | Device not detected. Try a different USB port; check Device Manager for an unknown device; reinstall the driver. |
| 5 | `ErrorCode` is `-2027` | Device disconnected mid-call (e.g. cable jiggle). Re-plug and retry. |
| 6 | Backend prints `indexed 0 candidates` | Data tree not found. See Step 6 fix. |
| 7 | `npm install` fails on `node-gyp` errors | A native dependency needs build tools. Run `npm install --include=optional --no-fund` or install Visual Studio Build Tools. |
| 8 | Browser can't reach `localhost:8031` | Firewall blocking loopback (rare). Allow inbound 8031 in Windows Defender Firewall. |

## Architecture reminder

```
Windows laptop                                    The Mac (or future EC2)
─────────────                                     ─────────────────────
Browser ──── HTTP localhost ──▶ iris-service:8031 (Marvis SDK + USB)
   │
   │ HTTP localhost (Vite proxy)
   ▼
Backend (Go) :8080  ◀────── (this terminal can also be on the Mac later;
                              the architecture doesn't care)
```

For *iris hardware testing*, only the iris-service has to run on the
Windows laptop. Backend + frontend can run on the same Windows box
(easiest, what this guide does) or on the Mac (with extra network
plumbing for the browser to find the right hosts).

## What this verifies, what it doesn't

| Verified by this test | Not verified |
|---|---|
| Marvis SDK loads on Windows from the cross-platform JAR | Whether the same flow works on Linux operator laptops |
| MIS100V2 USB device communicates with the SDK | Whether Mantra's `MatchImage` 1:1 score is calibrated correctly (no enrolled iris templates yet) |
| `iris-service` HTTP API maps the JNI calls correctly | Production-grade install via the `.deb` package |
| Frontend's iris fallback flow lights up against real hardware | Latency under realistic operator load |

The full iris matching flow (1:1 against an enrolled template) needs
candidate iris templates that don't exist in the gndu27 sample data.
This test verifies the **capture** path; the **match** path is
exercised when production candidates have iris enrolled.

## Once it works on Windows

You're done. Pack the laptop down. The Linux `.deb` (built by
`iris-service/build-deb.sh` on a Linux box) and the Windows install
flow cover the operator-rollout side. There's no further hardware
work for iris until enrollment data with real iris templates exists.
