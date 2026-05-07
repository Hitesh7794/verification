# Iris on Windows — vendor still broken, WSL2 workaround verified

**TL;DR (updated 2026-05-07):** Mantra's Windows DLLs in the Marvis
Auth SDK are still broken. **But we are no longer blocked.** The
WSL2+usbipd workaround in `client-bootstrap/windows/install.ps1` is
verified working end-to-end on a real Windows 10 (build 19045) laptop
with a real MIS100V2 device:

```
PS> curl.exe -X POST http://localhost:8031/iris/connecteddevicelist
{"ErrorCode":"0","ErrorDescription":"Found Devices: MIS100V2"}
```

The bundle no longer waits on Mantra. The vendor email is still open
because a native-Windows fix would let us simplify `install.ps1` later,
but operator-laptop rollout on Windows can proceed today via WSL2.

## Original problem (still true)

Mantra's Marvis Auth SDK package nominally supports Windows but in
practice it crashes during JNI initialisation. Their own sample binary
fails identically. Our integration code is verified correct. We need a
corrected Windows SDK from Mantra to retire the WSL2 workaround.

## What we tried

1. Took a Windows 11 laptop, installed the official Mantra **MYUSB driver**
   (downloaded from mantratec.com — official source, not third-party).
2. Plugged in the **MIS100V2** iris device.
3. Confirmed Windows recognised the device: `MIS100V2`, vendor ID `2C0F`,
   product ID `2100`, status `OK`.
4. Built our `mantra-iris-service` JAR (a thin Java wrapper around their
   `Marvis_Auth.jar`) and ran it against the device.

## What failed

The service refuses to talk to the device because the Marvis SDK itself
crashes when it tries to load its native Windows DLL:

```
java.lang.NoSuchMethodError: CompleteCallback
    at com.mantra.marvisauth.NativeUtils.ExtractLibraryFromJar(NativeUtils.java:169)
    at com.mantra.marvisauth.MarvisAuthNative.<clinit>(MarvisAuthNative.java:570)
    at com.mantra.marvisauth.MarvisAuth.<init>(MarvisAuth.java:46)
```

Translation: the Windows DLL inside Mantra's JAR is calling back into
Java for a method named `CompleteCallback`, and the Java class in the
same JAR doesn't have that method with the right signature. The DLL
and the Java classes ship in the same archive but **don't actually
match each other** on Windows.

## Why this isn't us

The same crash happens when you run **Mantra's own sample binary**
they ship with the SDK:

```
cd Marvis_Auth_Linux_Java_1.0.0.0\Sample
java -jar Marvis_Auth_Sample.jar
```

Their own pre-compiled, presumably-tested sample crashes with the
identical stack trace. That conclusively rules out anything in our
wrapper.

We tested across Java 11 and Java 17 — both fail. Same hardware works
fine on Linux (the SDK bundles separate Linux `.so` files which
function correctly).

## What we need from Mantra

The package we have is named `Marvis_Auth_Linux_Java_1.0.0.0`. It
optimistically bundles Windows DLLs but they don't work. We need
either:

1. A separate **Windows-tested SDK build** (likely
   `Marvis_Auth_Windows_*` if they distribute one), or
2. An updated `Marvis_Auth_Linux_Java` package with corrected
   Windows binaries.

A draft email to `servico@mantratec.com` is in `CONTEXT.md` §4 and the
chat history. Their support typically responds within a business day.

## What this does NOT block

- **Linux operator laptops** — same JAR works there (already tested).
- **Windows operator laptops via WSL2 + usbipd** — see workaround below.
- **Face matching** (Luxand) — completely independent, works server-side.
- **Fingerprint** (MorFin) — uses a different vendor SDK, unaffected.
- **All the rest of the portal** — backend, frontend, schema, install
  bundles, dashboards. All complete and tested.

## Windows workaround — WSL2 + usbipd-win

Implemented in [`client-bootstrap/windows/`](./client-bootstrap/windows/).
The Windows installer (`install.ps1`) provisions WSL2 Ubuntu, installs
`mantra-iris-service.deb` inside it (which uses the working Linux `.so`),
and uses Microsoft's [`usbipd-win`](https://github.com/dorssel/usbipd-win)
to pass the MIS100V2 USB device through to WSL. The browser still talks
to `localhost:8031` — WSL2's localhost forwarding makes the routing
transparent.

When Mantra ships a corrected Windows DLL, switching back to a
native-Windows iris service is a one-flag change in `install.ps1`:
re-register the iris JAR via `nssm` like the MorFin daemon, and the
WSL2 path can be retired.

## Status

| Layer | State (as of 2026-05-07) |
|---|---|
| Our iris-service Java wrapper | ✅ verified correct |
| Windows + USB driver + device detection | ✅ working |
| Our test harness, frontend, full stack | ✅ working with iris-mock |
| Mantra SDK on Windows (native) | ❌ broken (vendor's own sample fails) |
| Mantra SDK on Linux | ✅ working |
| **WSL2+usbipd workaround on Windows** | **✅ verified end-to-end with real MIS100V2** |

## What "verified end-to-end" means

Tested on Windows 10 build 19045 with the MIS100V2 device:

1. `install.ps1` runs all 10 phases without errors (after fixes for
   `.url` shortcut, UTF-8 BOM, Java check via `Get-Command`, WSL
   `--no-launch` fallback for older builds, and `IRIS_BIND=0.0.0.0`
   for WSL2 NAT-mode forwarder compatibility).
2. systemd inside WSL2 starts `mantra-iris-service.service`, which
   loads `MarvisIrisProvider` in `marvis-strict` mode (real SDK, no
   mock fallback) using the Linux `.so` natives bundled in
   `Marvis_Auth.jar`.
3. `usbipd attach --hardware-id 2c0f:2100 --wsl` passes the iris USB
   device through to WSL.
4. Windows `curl.exe http://localhost:8031/iris/connecteddevicelist`
   returns `{"ErrorCode":"0","ErrorDescription":"Found Devices: MIS100V2"}`
   — proof that every layer in the chain works:
   Windows curl → WSL2 NAT forwarder → Javalin → MarvisIrisProvider →
   JNI → Linux `Marvis_Auth.so` → libusb → usbipd → physical device.

## Operational caveats (not blockers, but should be hardened before fleet rollout)

1. **WSL2 idle timeout.** The VM goes to sleep after ~60s of inactivity,
   taking the iris service + USB attachment with it. We tried
   `vmIdleTimeout=-1` in `.wslconfig` but it isn't being honored on
   Win10 19045. Workaround during testing: keep a persistent `wsl -d
   Ubuntu-22.04` shell open. Production fix candidates:
   - Try `vmIdleTimeout=2147483647` (large int) instead of `-1`
   - Run `wsl -d Ubuntu-22.04` as a Windows service via `nssm`
   - A small tray app that pings `localhost:8031` every 30s
2. **usbipd re-attach on VM cycle.** After the VM cycles, the USB
   passthrough is lost. Today the install creates a scheduled task
   that fires at Windows logon, but not on WSL VM resume. Production
   fix: add a startup script that runs `usbipd attach` whenever the
   distro boots, or a systemd timer inside WSL that calls `wsl.exe`
   on the host.
3. **First-call cold-boot latency.** A fresh WSL VM start (from
   `Stopped` to bound on :8031) takes ~5-10s due to JVM startup +
   Marvis SDK init. Subsequent calls are <100ms forwarder + ~1-3s
   for actual capture.

## When Mantra ships a corrected Windows SDK

Retiring the WSL2 path is a small change:

1. Drop the corrected JAR into `iris-service/lib/`.
2. Update `install.ps1` to register the iris JAR via `nssm` (mirror
   of the existing MorFin daemon registration), remove the WSL2 +
   usbipd phases.
3. Rebuild bundle, redeploy.

The integration code (the reflective wrapper in
`MarvisIrisProvider.java`) doesn't change — it works against the same
API surface regardless of OS.

In the meantime: nothing in the project is blocked. The WSL2 path is
the supported deployment for Windows operator laptops.
