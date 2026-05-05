# mantra-iris-service

A localhost HTTP service that wraps Mantra's `Marvis_Auth.jar` (the iris
SDK for the MIS100V2 device). Designed to run on operator laptops as a
systemd unit, parallel to `morfinauth-client-service` (which handles
fingerprint), so the verification-portal frontend can talk to both
through the same architectural pattern:

| Service              | Port  | What it wraps              |
|----------------------|-------|----------------------------|
| morfinauth-client-service | `:8030` | MorFin SDK (vendor's `.deb`) — fingerprint |
| mantra-iris-service       | `:8031` | Marvis SDK (this package) — iris            |

JSON envelopes are deliberately matched: `{ErrorCode: "0|<code>",
ErrorDescription: "...", ...data}`.

## Endpoints

```
POST /iris/supporteddevicelist
POST /iris/connecteddevicelist
POST /iris/checkdevice          {"ConnectedDvc": "MIS100V2"}
POST /iris/info                 {"ConnectedDvc": "MIS100V2"}
POST /iris/initdevice           {"ConnectedDvc": "MIS100V2"}
POST /iris/uninitdevice
POST /iris/capture              {"MinQuality": 50, "UpperQuality": 95, "TimeOut": 10000}
POST /iris/match                {"ProbLeft": b64, "GalleryLeft": b64,
                                 "ProbRight": b64, "GalleryRight": b64,
                                 "Format": "BMP"|"RAW"|"K7"|"IIR_K7"|"K1"}
```

The full vendor surface (StartCapture / PreviewCallback / etc.) is
covered in `IrisProvider.java` but exposed selectively — the operator
flow uses the synchronous `AutoCapture` path, which is simpler and
returns one final result.

## Architecture

```
Browser (any OS) ── HTTP JSON ──▶  localhost:8031  ──▶  IrisProvider
                                       │
                                       ├── MockIrisProvider   (dev)
                                       └── MarvisIrisProvider (real, via reflection
                                                               so the JAR isn't a
                                                               build-time dependency)
```

The provider is selected by env var:

```
IRIS_PROVIDER=mock           in-process fake (dev / CI; default for `mvn test`)
IRIS_PROVIDER=marvis         real SDK; falls back to mock on load failure
                             (good for contributor laptops without the JAR)
IRIS_PROVIDER=marvis-strict  real SDK required; fail-closed on load failure
                             (production setting; pinned by the systemd unit)
```

The `marvis` mode keeps a developer's machine running when the JAR is
missing or the device isn't plugged in. The `marvis-strict` mode is the
only correct choice in production: a healthy-looking service quietly
emitting fake match scores would be far worse than a failing systemd unit.

## Build & test (any OS with Maven + JDK 11+)

```bash
cd iris-service
mvn test                # runs the HTTP-layer + provider tests against the mock
mvn package             # produces target/mantra-iris-service-1.0.0.jar
```

## Run locally (no SDK required)

```bash
IRIS_PROVIDER=mock IRIS_PORT=8031 \
  java -jar target/mantra-iris-service-1.0.0.jar
```

```bash
curl -s -X POST http://localhost:8031/iris/supporteddevicelist
```

For richer fault injection (mid-session disconnect, tunable scores, fail
windows), use the standalone Go-based `iris-mock` instead:

```bash
cd backend && go run ./cmd/iris-mock     # also on :8031, with /control endpoint
```

## Build the .deb (Linux only)

Requires `mvn`, `dpkg-deb`, and the vendor JAR in `lib/Marvis_Auth.jar`
(not redistributable, copy from `Marvis_Auth_Linux_Java_1.0.0.0/Libs/`):

```bash
cd iris-service
cp /path/to/Marvis_Auth.jar lib/
./build-deb.sh
# → dist/mantra-iris-service_1.0.0_all.deb
```

Install on an operator laptop:

```bash
sudo apt install ./mantra-iris-service_1.0.0_all.deb
sudo systemctl status mantra-iris-service
curl -X POST http://localhost:8031/iris/supporteddevicelist
```

## Open questions for vendor (Mantra)

Documented in repo-root `CONTEXT.md` §4. Specifically for iris:

- Is `MatchImage` production-grade? (It's in the JAR but not in the PDF.)
- What MatchScore range / threshold do you recommend?
- Is the score per-eye (length 2) or combined (length 1)?
- Recommended `ImageFormat` for gallery side: K3 vs K7?
