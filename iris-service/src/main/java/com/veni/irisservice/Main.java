package com.veni.irisservice;

import com.veni.irisservice.handler.IrisHandlers;
import com.veni.irisservice.provider.IrisException;
import com.veni.irisservice.provider.IrisProvider;
import com.veni.irisservice.provider.MarvisIrisProvider;
import com.veni.irisservice.provider.MockIrisProvider;
import io.javalin.Javalin;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * mantra-iris-service entry point. Listens on {@code localhost:8031}
 * (configurable via {@code IRIS_PORT}). Picks an iris provider based
 * on the {@code IRIS_PROVIDER} env var:
 *
 * <ul>
 *   <li>{@code mock} — pure-Java fake; for dev / CI without hardware.</li>
 *   <li>{@code marvis} — real SDK; on load failure falls back to mock
 *       with a loud warning. Use this on developer/QA laptops that may
 *       not always have the JAR or device.</li>
 *   <li>{@code marvis-strict} — real SDK required. On load failure the
 *       process exits non-zero so systemd's {@code Restart=on-failure}
 *       loops it and ops sees a failing unit. **This is the production
 *       setting** — silently serving fake scores from an installed
 *       service is the worst outcome.</li>
 * </ul>
 *
 * Defaults to {@code marvis} when unset, since that's the more forgiving
 * choice on a contributor's machine. The shipped systemd unit pins
 * {@code marvis-strict} for production hosts.
 */
public final class Main {
    private static final Logger LOG = LoggerFactory.getLogger(Main.class);

    public static void main(String[] args) {
        int port = parsePort(System.getenv("IRIS_PORT"), 8031);
        String wanted = orDefault(System.getenv("IRIS_PROVIDER"), "marvis");
        // Bind address defaults to loopback for native Linux operator
        // laptops (defence-in-depth — only the local browser should reach
        // the daemon). The WSL2-on-Windows path overrides via a systemd
        // drop-in to "0.0.0.0" because WSL2's NAT-mode localhost forwarder
        // doesn't reliably bridge to 127.0.0.1-bound services inside WSL,
        // and binding to a non-loopback inside the WSL VM is still
        // effectively private (the VM has no LAN-reachable interface).
        String bind = orDefault(System.getenv("IRIS_BIND"), "127.0.0.1");

        IrisProvider provider = pickProvider(wanted);
        IrisHandlers handlers = new IrisHandlers(provider);

        Javalin app = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            cfg.plugins.enableCors(cors -> cors.add(it -> it.anyHost()));
        }).start(bind, port);

        handlers.register(app);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.info("shutting down — releasing iris device");
            try { provider.uninit(); } catch (Throwable ignored) {}
            app.close();
        }));

        LOG.info("mantra-iris-service listening on {}:{}", bind, port);
    }

    private static IrisProvider pickProvider(String wanted) {
        if ("mock".equalsIgnoreCase(wanted)) {
            LOG.info("using MockIrisProvider (IRIS_PROVIDER=mock)");
            return new MockIrisProvider();
        }
        boolean strict = "marvis-strict".equalsIgnoreCase(wanted);
        try {
            IrisProvider p = new MarvisIrisProvider();
            LOG.info("using MarvisIrisProvider (real SDK, mode={})", wanted);
            return p;
        } catch (IrisException e) {
            if (strict) {
                // Exit non-zero so systemd surfaces the failure instead of
                // a healthy-looking unit that quietly mints fake scores.
                LOG.error("IRIS_PROVIDER=marvis-strict but Marvis SDK not loadable: {}",
                          e.getMessage(), e);
                throw new IllegalStateException(
                        "Marvis SDK required (IRIS_PROVIDER=marvis-strict) but failed to load: "
                                + e.getMessage(), e);
            }
            LOG.warn("Marvis SDK not loadable ({}); falling back to MockIrisProvider. " +
                     "Set IRIS_PROVIDER=marvis-strict to fail-closed instead.",
                     e.getMessage());
            return new MockIrisProvider();
        }
    }

    private static int parsePort(String s, int def) {
        if (s == null || s.isEmpty()) return def;
        try { return Integer.parseInt(s); }
        catch (NumberFormatException e) { return def; }
    }

    private static String orDefault(String s, String def) {
        return s == null || s.isEmpty() ? def : s;
    }

    private Main() {}
}
