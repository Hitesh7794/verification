# fp-match-service

Server-side fingerprint matching daemon for the Verification Portal. Wraps
**[SourceAFIS](https://sourceafis.machinezoo.com/)** (Apache 2.0, pure Java)
behind a JSON HTTP API on `127.0.0.1:8050`.

| Service              | Port  | Where it runs    | Wraps                                  |
|----------------------|-------|------------------|----------------------------------------|
| morfin-client-service | 8030  | Operator laptop  | MorFin fingerprint SDK (Mantra)        |
| MarvisAuthClientService | 8031 | Operator laptop  | Marvis iris SDK (Mantra, native Win)  |
| ACPL Capture API      | 8090/4443 | Operator laptop | Startek FM220U L1 (ACPL)             |
| luxand-service        | 8040  | Central server   | Luxand FaceSDK 8.3 — face matching     |
| **fp-match-service**  | **8050** | **Central server** | **SourceAFIS — fingerprint matching** |

## Why this exists

Mantra MorFin matches against pre-enrolled gallery templates correctly on the
operator laptop. Startek/ACPL's L1 Capture API **does not** — its
`GetMatchResult` endpoint only matches against templates captured in the same
live session, not against arbitrary stored gallery FMR templates. To unblock
1:1 verification with Startek devices against the existing gndu27 candidate
gallery, we forward {probe captured via Startek's `gettmpl`, gallery from
backend} to this server-side matcher.

Vendor-neutral by design: a future deployment could also route Mantra-captured
probes through this same service for unified scoring across vendors.

## Endpoints

```
POST /fp/health
  → {ErrorCode, ErrorDescription, Version, Threshold}

POST /fp/match
  body:  {ProbeTemplate: base64, GalleryTemplate: base64}
  reply: {ErrorCode, ErrorDescription, Score, Threshold, Status}
```

Templates are raw bytes of **ISO/IEC 19794-2:2005 FMR** or **ANSI INCITS
378-2004** (SourceAFIS auto-detects). `Score` is the SourceAFIS similarity
score; `Status` is a server-side convenience (`Score >= Threshold`).

## Threshold

Default `FP_MATCH_THRESHOLD=40` — SourceAFIS's documented 1-in-1000 FMR
point. Observed scores on our actual data (2026-05-16):

| Probe → Gallery | Score |
|---|---|
| same finger, same template (self) | 385–571 |
| different fingers (cross) | 0.02–0.17 |

The gap between match and non-match is enormous, so any threshold between
~30 and ~100 separates them cleanly. 40 is the safest default.

## Run locally — Docker (recommended for dev on macOS)

Unlike luxand-service, no `.env` is needed — SourceAFIS has no licence:

```bash
./dev-up.sh                 # builds image (~2 min first time), starts container
curl -X POST http://localhost:8050/fp/health
./dev-down.sh
```

The image is `linux/amd64` AND `linux/arm64` compatible — Apple Silicon runs
it natively, no Rosetta.

## Run locally — bare JVM (any OS, JDK 11+)

```bash
mvn -q package
java -jar target/fp-match-service-1.0.0.jar
```

## Run tests

```bash
mvn -q test
```

Covers:
- HTTP route layer + envelope shapes (5 tests against a stub matcher)
- Real SourceAFIS provider against bundled gndu27 Mantra + Startek FM220U
  FMR_V2005 templates (3 tests; asserts self-match scores >100,
  cross-finger scores <10)

## Build the .deb (Linux only)

```bash
./build-deb.sh
# → dist/fp-match-service_1.0.0_all.deb
```

Installs to `/usr/local/fp-match-service/`, registers a systemd unit, starts
on port `127.0.0.1:8050`. Loopback-only — the portal backend on the same EC2
host is the sole intended client.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `FP_MATCH_PORT` | `8050` | Listen port |
| `FP_MATCH_BIND` | `127.0.0.1` | Listen address (Docker overrides to `0.0.0.0` for container-to-host mapping) |
| `FP_MATCH_THRESHOLD` | `40` | Default match threshold returned in `/fp/health` and applied in `Status` |

## Why SourceAFIS

- **Apache 2.0** — free, commercial-friendly, no licence server
- **Pure Java** — no native dependencies, cross-platform, easy to ship
- **Vendor-neutral** — accepts FMR / ANSI templates from any extractor
- **Mature** — 10+ years of development, widely deployed
- **Verified on our data** — passes our Phase A spike with the actual
  Mantra-extracted (gndu27) and Startek-extracted (FM220U) templates

## Performance

- Match latency: ~10–30 ms per pair on a modern x86_64
- Template extraction: not used (we accept pre-extracted templates only)
- RAM: ~150–200 MB JVM steady-state
- Concurrency: stateless — scale by running multiple instances behind a
  load balancer; or by JVM thread pool (default Javalin handles hundreds
  of simultaneous requests)
