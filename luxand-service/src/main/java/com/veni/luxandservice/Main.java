package com.veni.luxandservice;

import com.veni.luxandservice.handler.FaceHandlers;
import com.veni.luxandservice.provider.FaceException;
import com.veni.luxandservice.provider.FaceProvider;
import com.veni.luxandservice.provider.LuxandFaceProvider;
import io.javalin.Javalin;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * luxand-service entry point. Listens on {@code 127.0.0.1:8040} (override
 * via {@code FACE_PORT}). Loopback-only on purpose — the portal backend
 * is the sole intended client.
 *
 * <p>Lifecycle:
 * <ol>
 *   <li>Read {@code FSDK_LICENSE_KEY} (mandatory)</li>
 *   <li>Construct {@link LuxandFaceProvider} → JNA loads
 *       {@code libfsdk.so} from {@code java.library.path} or
 *       {@code jna.library.path}</li>
 *   <li>{@code ActivateLibrary(key)} — fail-fast on any non-zero return</li>
 *   <li>{@code Initialize()} once</li>
 *   <li>Compute the matching threshold for the configured FAR
 *       ({@code FACE_MATCH_FAR}, default {@code 0.0001})</li>
 *   <li>Start Javalin, wire {@link FaceHandlers}</li>
 *   <li>Register a JVM shutdown hook so {@code FreeImage} loops don't
 *       leak when {@code systemctl stop} hits the unit</li>
 * </ol>
 *
 * <p>Fail-fast is deliberate: a misconfigured key or a missing native
 * library should make the systemd unit go red, not silently serve garbage
 * scores.
 */
public final class Main {
    private static final Logger LOG = LoggerFactory.getLogger(Main.class);

    public static void main(String[] args) throws Exception {
        int port = parseInt(System.getenv("FACE_PORT"), 8040);
        float far = parseFloat(System.getenv("FACE_MATCH_FAR"), 0.0001f);
        String key = readKey();

        // Default to loopback so a misconfigured deploy can't accidentally
        // expose the service to the public internet. In Docker, set
        // FACE_BIND=0.0.0.0 explicitly — the container's network is still
        // private; only the host's port map decides who can reach it.
        String bind = System.getenv("FACE_BIND");
        if (bind == null || bind.isBlank()) bind = "127.0.0.1";

        FaceProvider provider;
        float threshold;
        try {
            provider = new LuxandFaceProvider();
            provider.activate(key);
            provider.initialize();
            threshold = provider.matchingThresholdAtFAR(far);
        } catch (FaceException e) {
            LOG.error("luxand-service refusing to start: code={} msg={}", e.code, e.getMessage());
            // exit non-zero so systemd marks the unit failed instead of running.
            System.exit(2);
            return;
        }

        LOG.info("luxand-service activated; FAR={} threshold={}", far, threshold);

        final String bindAddr = bind;
        Javalin app = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            cfg.plugins.enableCors(c -> c.add(it -> it.anyHost()));
        }).start(bindAddr, port);

        new FaceHandlers(provider, threshold).register(app);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.info("shutting down — releasing FaceSDK");
            try { provider.shutdown(); } catch (Throwable ignored) {}
            app.close();
        }));

        LOG.info("luxand-service listening on {}:{}", bindAddr, port);
    }

    /**
     * Read the license key. Two sources, checked in order:
     *   1. {@code FSDK_LICENSE_KEY} environment variable (preferred for
     *      systemd / Docker / CI).
     *   2. {@code FSDK_LICENSE_FILE} pointing at a path that contains
     *      the key, optionally surrounded by an `FSDK_LICENSE_KEY=...`
     *      assignment line so the same file works as a `.env`.
     *
     * Throws if neither is set — a misconfigured deploy should fail
     * audibly, not produce wrong scores.
     */
    private static String readKey() throws Exception {
        String env = System.getenv("FSDK_LICENSE_KEY");
        if (env != null && !env.isBlank()) return env.trim();

        String path = System.getenv("FSDK_LICENSE_FILE");
        if (path != null && !path.isBlank()) {
            String raw = java.nio.file.Files.readString(java.nio.file.Path.of(path));
            for (String line : raw.split("\\R")) {
                line = line.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                if (line.startsWith("FSDK_LICENSE_KEY=")) {
                    return line.substring("FSDK_LICENSE_KEY=".length()).trim();
                }
                // Bare key file (no env-style assignment).
                return line;
            }
        }

        throw new IllegalStateException(
            "FSDK_LICENSE_KEY env var or FSDK_LICENSE_FILE path must be set."
            + " The license key is provided by Luxand and must not be committed to git.");
    }

    private static int parseInt(String s, int def) {
        if (s == null || s.isEmpty()) return def;
        try { return Integer.parseInt(s); } catch (NumberFormatException e) { return def; }
    }

    private static float parseFloat(String s, float def) {
        if (s == null || s.isEmpty()) return def;
        try { return Float.parseFloat(s); } catch (NumberFormatException e) { return def; }
    }

    private Main() {}
}
