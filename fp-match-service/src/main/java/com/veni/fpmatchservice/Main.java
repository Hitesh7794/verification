package com.veni.fpmatchservice;

import com.veni.fpmatchservice.handler.FpHandlers;
import com.veni.fpmatchservice.provider.FpProvider;
import com.veni.fpmatchservice.provider.SourceAfisProvider;
import io.javalin.Javalin;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * fp-match-service entry point. Listens on {@code 127.0.0.1:8050} (override
 * via {@code FP_MATCH_PORT}). Loopback-only on purpose — the portal backend
 * is the sole intended client.
 *
 * <p>Lifecycle:
 * <ol>
 *   <li>Construct {@link SourceAfisProvider} — pure-Java matcher, no native
 *       loading. Always succeeds; no licence, no activation.</li>
 *   <li>Read the FMR threshold from {@code FP_MATCH_THRESHOLD} (default
 *       {@code 40.0}, SourceAFIS's documented 1-in-1000 FMR point).</li>
 *   <li>Start Javalin, wire {@link FpHandlers}.</li>
 * </ol>
 *
 * <p>Unlike luxand-service, there is no fail-fast on key/SDK activation:
 * SourceAFIS is Apache 2.0 with no licensing layer, so the only ways this
 * service can fail to start are JVM-level (out of memory, port in use).
 */
public final class Main {
    private static final Logger LOG = LoggerFactory.getLogger(Main.class);

    public static void main(String[] args) {
        int port = parseInt(System.getenv("FP_MATCH_PORT"), 8050);
        double threshold = parseDouble(System.getenv("FP_MATCH_THRESHOLD"), 40.0);

        // Default to loopback so a misconfigured deploy can't accidentally
        // expose the service to the public internet. In Docker we set
        // FP_MATCH_BIND=0.0.0.0 explicitly so the container's port can be
        // mapped to the host — the host network still only exposes 127.0.0.1.
        String bind = System.getenv("FP_MATCH_BIND");
        if (bind == null || bind.isBlank()) bind = "127.0.0.1";

        FpProvider provider = new SourceAfisProvider();
        LOG.info("fp-match-service using {}; threshold={}", provider.version(), threshold);

        final String bindAddr = bind;
        Javalin app = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            cfg.plugins.enableCors(c -> c.add(it -> it.anyHost()));
        }).start(bindAddr, port);

        new FpHandlers(provider, threshold).register(app);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.info("shutting down fp-match-service");
            app.close();
        }));

        LOG.info("fp-match-service listening on {}:{}", bindAddr, port);
    }

    private static int parseInt(String s, int def) {
        if (s == null || s.isEmpty()) return def;
        try { return Integer.parseInt(s); }
        catch (NumberFormatException e) { return def; }
    }

    private static double parseDouble(String s, double def) {
        if (s == null || s.isEmpty()) return def;
        try { return Double.parseDouble(s); }
        catch (NumberFormatException e) { return def; }
    }

    private Main() {}
}
