# Iris hardware test — blocked on vendor

**TL;DR:** Mantra's Marvis Auth SDK package nominally supports Windows
but in practice it crashes during JNI initialisation. Their own sample
binary fails identically. Our integration code is verified correct. We
need a corrected Windows SDK from Mantra to proceed.

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

| Layer | State |
|---|---|
| Our iris-service Java wrapper | ✅ verified correct |
| Windows + USB driver + device detection | ✅ working |
| Our test harness, frontend, full stack | ✅ working with iris-mock |
| Mantra SDK on Windows | ❌ broken (vendor's own sample fails) |
| Mantra SDK on Linux | ✅ working |

When Mantra ships the corrected Windows SDK, swapping it in is a
~5-minute task — drop the new JAR into `iris-service/lib/`,
`mvn package`, redeploy. The integration code already targets the
right API surface (we extracted the method signatures by reading
their bytecode, including the otherwise-undocumented `MatchImage` 1:1
matcher).

In the meantime: nothing else in the project is blocked.
