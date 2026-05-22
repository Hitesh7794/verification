# fp-match-service container image.
#
# Stage 1 builds the shaded fat JAR with Maven.
# Stage 2 is a slim JRE runtime — no native libraries to stage because
# SourceAFIS is pure Java.
#
# Unlike luxand-service this image is architecture-neutral (works on
# linux/amd64 AND linux/arm64 — including Apple Silicon natively, no
# Rosetta needed). SourceAFIS has zero native dependencies.
# ----------------------------------------------------------------------

# ---- Build stage ------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-17 AS build

WORKDIR /src

# Maven cache primer — copy only the POM first so dependencies are cached
# in their own image layer. Subsequent source changes don't re-download
# the universe.
COPY pom.xml ./
RUN mvn -B -q -o dependency:resolve || \
    mvn -B -q dependency:resolve || true

COPY src ./src
RUN mvn -B -q -DskipTests package

# ---- Runtime stage ----------------------------------------------------------
# Java 17 is sufficient — SourceAFIS targets Java 8 / 11. We use the same
# Temurin 17 JRE that hosts our other Java services for consistency.
FROM eclipse-temurin:17-jre-noble AS runtime

WORKDIR /app

# Bring in the built shaded jar — single artifact, all dependencies
# included (including the SourceAFIS library). No vendor jars to ship
# separately like luxand: SourceAFIS is Apache 2.0, so the shade plugin
# happily merges it into our fat jar.
COPY --from=build /src/target/fp-match-service-*.jar /app/fp-match-service.jar

ENV FP_MATCH_PORT=8050 \
    FP_MATCH_THRESHOLD=40

# fp-match-service binds to 127.0.0.1 by default so the central server's
# Go backend can reach it on loopback. In a container "loopback" means
# the container's own loopback, which the host can't reach — so we let
# Main.java rebind to 0.0.0.0 when this env var is set.
#
# Even at 0.0.0.0 the container is still locked down: only the host's
# port mapping (8050 → 127.0.0.1:8050 on the Mac) makes it reachable,
# and we never publish it to a non-loopback interface.
ENV FP_MATCH_BIND=0.0.0.0

EXPOSE 8050

ENTRYPOINT ["java", "-jar", "/app/fp-match-service.jar"]
