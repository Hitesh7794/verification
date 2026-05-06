# luxand-service container image.
#
# Stage 1 builds the shaded fat JAR with Maven.
# Stage 2 is a slim JRE runtime with the vendor native library staged at
# a stable path and JNA pointed at it.
#
# Architecture is pinned to linux/amd64 because Luxand's libfsdk.so only
# ships x86_64 binaries. On Apple Silicon the container runs under
# Rosetta 2 (Docker Desktop) — slower than native but works.
# ----------------------------------------------------------------------

# ---- Build stage ------------------------------------------------------------
FROM --platform=linux/amd64 maven:3.9-eclipse-temurin-17 AS build

WORKDIR /src

# Maven cache primer — copy only the POM first so dependencies are cached
# in their own image layer. Subsequent source changes don't re-download
# the universe.
COPY pom.xml ./
COPY lib ./lib
RUN mvn -B -q -o dependency:resolve || \
    mvn -B -q dependency:resolve || true

COPY src ./src
RUN mvn -B -q -DskipTests package

# ---- Runtime stage ----------------------------------------------------------
# Java 25 is required because Luxand's FaceSDK.jar 8.3 ships with class
# file version 69.0 (Java 25). The build stage above can stay on JDK 17
# because our own source compiles to Java 11 bytecode and Luxand's
# classes are only loaded reflectively at runtime, not at compile time.
FROM --platform=linux/amd64 eclipse-temurin:25-jre-noble AS runtime

# Native dependencies libfsdk.so links against. Luxand's binary needs
# libgomp (OpenMP), libstdc++ (already in JRE base), and a few common
# graphics-stack libs because parts of the model loader expect them.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 \
        libgl1 \
        libglib2.0-0 \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in the built jar, the two vendor jars, and the vendor native at
# fixed paths. The vendor jars are listed in pom.xml as system-scoped so
# the Maven shade plugin doesn't merge their classes into the fat jar
# (otherwise we'd be redistributing Luxand's proprietary code, which the
# EULA forbids). Instead we ship them as separate jars and add them to
# the runtime classpath. The systemd unit on EC2 follows the same layout.
COPY --from=build /src/target/luxand-service-*.jar /app/luxand-service.jar
COPY lib/FaceSDK.jar      /app/FaceSDK.jar
COPY lib/jna-5.18.1.jar   /app/jna-5.18.1.jar
COPY native/linux-x86_64/libfsdk.so /app/native/libfsdk.so

# JNA looks here for native libraries. The system property is also set
# on the java command line for redundancy — env var alone is sometimes
# overridden by stricter JREs.
ENV LD_LIBRARY_PATH=/app/native \
    FACE_PORT=8040 \
    FACE_MATCH_FAR=0.0001

# luxand-service binds to 127.0.0.1 by default so the central server's
# Go backend can reach it on loopback. In a container "loopback" means
# the container's own loopback, which the host can't reach — so we let
# Main.java rebind to 0.0.0.0 when this env var is set.
#
# Even at 0.0.0.0 the container is still locked down: only the host's
# port mapping (8040 → 127.0.0.1:8040 on the Mac) makes it reachable,
# and we never publish it to a non-loopback interface.
ENV FACE_BIND=0.0.0.0

EXPOSE 8040

# FSDK_LICENSE_KEY is supplied by docker-compose / `docker run -e ...`,
# never baked into the image. Run with -cp (not -jar) so all three jars
# are on the classpath — Luxand.FSDK lives in FaceSDK.jar and isn't part
# of the shaded fat jar (vendor EULA forbids redistribution).
ENTRYPOINT ["java", \
    "-Djna.library.path=/app/native", \
    "-Djava.library.path=/app/native", \
    "-cp", "/app/luxand-service.jar:/app/FaceSDK.jar:/app/jna-5.18.1.jar", \
    "com.veni.luxandservice.Main"]
