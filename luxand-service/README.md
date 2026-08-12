# luxand-service

Server-side face matching daemon for the Verification Portal. Wraps
**Luxand FaceSDK 8.3** behind a JSON HTTP API on `127.0.0.1:8040`.
**Runs on the central server (Linux EC2), not on operator laptops** —
face capture happens in the operator's browser via `getUserMedia`, the
JPEG ships up to the backend, the backend forwards it here.

| Service              | Port  | Where it runs    | Wraps                           |
|----------------------|-------|------------------|---------------------------------|
| morfin-client-service | 8030  | Operator laptop  | MorFin fingerprint SDK          |
| MarvisAuthClientService | 8031 | Operator laptop  | Marvis iris SDK (native Win)  |
| **luxand-service**    | **8040** | **Central server** | **Luxand FaceSDK 8.3**         |

## Endpoints

```
POST /face/health
  → {ErrorCode, ErrorDescription, Activated, Version, Threshold}

POST /face/extract
  body:  {Image: base64, Mime: "image/jpeg"|"image/png"}
  reply: {ErrorCode, ErrorDescription, FaceFound, Template: base64?}

POST /face/match
  body:  {ProbeTemplate: base64, GalleryTemplate: base64}
  reply: {ErrorCode, ErrorDescription, Score, Threshold, Status}

POST /face/match-image
  body:  {ProbeImage: base64, ProbeMime: "image/jpeg",
          GalleryTemplate: base64}
  reply: {ErrorCode, ErrorDescription, FaceFound, Score, Threshold, Status}

POST /face/threshold
  body:  {FAR: 0.0001}
  reply: {ErrorCode, ErrorDescription, FAR, Threshold}
```

`Score` is the cosine-similarity-style float in `[0, 1]` returned by
Luxand's `MatchFaces`. `Status` is the server-side convenience
`Score >= Threshold`.

## License

Set the license key via env var **`FSDK_LICENSE_KEY`** (or
`FSDK_LICENSE_FILE` pointing at a `.env`-style file). The service
**fails to start** if the key is missing or rejected by
`ActivateLibrary`. Never commit the key to git — `.gitignore` excludes
`.env` and the staged vendor JAR.

## Run locally — three options

### Option A — Docker (recommended for macOS / Apple Silicon dev)

The vendor `libfsdk.so` is Linux x86_64 only, so the cleanest local-dev
path on a Mac is to run the service in a Linux container.

**One-time setup**

1. Install Docker Desktop: https://www.docker.com/products/docker-desktop/
2. From this directory:
   ```bash
   cp .env.example .env
   # edit .env, paste your FSDK_LICENSE_KEY
   ```

**Boot the service**

```bash
./dev-up.sh
```

The script builds the image (first time: ~3 minutes — downloads JRE
+ apt deps), starts the container, waits for `/face/health` to return
200, and prints a one-line confirmation. After that:

```bash
# Health check
curl -s -X POST http://localhost:8040/face/health | jq

# Live logs
docker compose logs -f luxand-service

# Stop
./dev-down.sh
```

The Mac-native Go backend reaches the container at
`http://localhost:8040/face/` (its default `LUXAND_BASE`). The container
binds to `127.0.0.1` on the host — never on a public interface.

**Note for Apple Silicon (M1/M2/M3):** the image is built for
`linux/amd64` because the vendor's native is x86_64-only. Docker Desktop
runs it through Rosetta 2 emulation. Slower than native (~2-3× face
extraction latency in dev) but functionally identical to production.

### Option B — Bare JVM (for production on Linux EC2)

> **Java 25 minimum required.** Luxand FaceSDK 8.3 ships JAR class files
> at version 69.0 (Java 25). Older JREs throw
> `UnsupportedClassVersionError`. On Ubuntu, install via:
> `sudo apt install temurin-25-jre` (after adding the Adoptium APT repo)
> or download from https://adoptium.net/.

```bash
cd luxand-service
mvn -q package
export FSDK_LICENSE_KEY="<your-luxand-key>"
export FACE_PORT=8040
export FACE_MATCH_FAR=0.0001

# Run with -cp (not -jar) so all three jars are on the classpath.
# Luxand.FSDK lives in FaceSDK.jar; the EULA forbids us from merging it
# into the shaded jar, so we ship the vendor jars side-by-side.
java -Djna.library.path=$(pwd)/native/linux-x86_64 \
     -cp target/luxand-service-1.0.0.jar:lib/FaceSDK.jar:lib/jna-5.18.1.jar \
     com.veni.luxandservice.Main
```

The `.deb` produced by `build-deb.sh` does this automatically via systemd.

### Option C — Unit tests only (any OS, no SDK needed)

The Maven module compiles on macOS without the SDK because the vendor
JAR is `system`-scoped + `optional`. Tests use a stub provider:

```bash
cd luxand-service
mvn test
```

## Build the .deb (Linux only)

```bash
cd luxand-service
./build-deb.sh
# → dist/luxand-service_1.0.0_amd64.deb
```

The resulting `.deb` ships:
- `/usr/local/luxand-service/luxand-service.jar` (shaded fat jar)
- `/usr/local/luxand-service/FaceSDK.jar` + `jna-5.18.1.jar`
- `/usr/local/luxand-service/native/libfsdk.so`
- `/etc/systemd/system/luxand-service.service`
- `/etc/luxand-service/luxand.env` (postinst creates a placeholder; the
  operator edits it to insert the real key, then
  `systemctl restart luxand-service`)

## Architecture: why server-side

Face capture is the only biometric channel that doesn't need a per-laptop
native daemon — every browser already has webcam access via
`getUserMedia`. So:

```
Operator browser ── webcam JPEG ── HTTPS ──▶ Portal backend ── localhost ──▶ luxand-service
```

This means **one deployed instance serves every operator** in every
center, regardless of OS. No `.deb` / `.msi` rolled out per laptop, no
cross-platform install glue. Just a single systemd unit on the central
server.

## Performance notes

- **Template extraction**: ~30–80 ms per image (CPU bound — `libfsdk.so`
  + ONNX model load).
- **1:1 match between two pre-extracted templates**: ~1 ms.
- **Strategy**: extract gallery templates once per candidate, cache to
  disk (the portal backend handles this — see
  `backend/internal/api/face_handlers.go`). Every subsequent operator
  verification of the same candidate is just a `MatchFaces` call.

## Why reflective JNA

`LuxandFaceProvider` calls `Luxand.FSDK` via `Class.forName` rather than
a compile-time import. Reasons:

- Vendor JARs are 70+ MB and Linux-only; we don't want a Mac developer's
  `mvn compile` to fail because the native isn't loadable.
- The wrapper module compiles on any OS; the Linux dependency is
  enforced at runtime when the service actually starts.
- Refactor-friendly: if Luxand renames a method between minor SDK
  versions, the failure surfaces as a clean `FaceException` at the
  affected route rather than a build break.
