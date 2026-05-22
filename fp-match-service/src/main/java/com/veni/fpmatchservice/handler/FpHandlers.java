package com.veni.fpmatchservice.handler;

import com.veni.fpmatchservice.Envelope;
import com.veni.fpmatchservice.provider.FpException;
import com.veni.fpmatchservice.provider.FpProvider;
import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * HTTP routes for the fp-match service. All endpoints accept and return JSON
 * envelopes consistent with morfin / iris / luxand services so the portal
 * backend's parsing is uniform across all biometric services:
 *
 * <pre>
 *   POST /fp/health
 *     → {ErrorCode, ErrorDescription, Version, Threshold}
 *
 *   POST /fp/match
 *     body:  {ProbeTemplate: base64, GalleryTemplate: base64}
 *     reply: {ErrorCode, ErrorDescription, Score: float, Threshold: float, Status: bool}
 * </pre>
 *
 * <p>Templates are raw bytes of ISO/IEC 19794-2:2005 FMR or ANSI INCITS 378
 * (SourceAFIS auto-detects). {@code Score} is the SourceAFIS similarity
 * score; {@code Status} is the server-side convenience {@code Score >= Threshold}.
 *
 * <p>Loopback-only by default ({@code FP_MATCH_BIND=127.0.0.1}). The
 * portal backend is the sole intended client; operator browsers never
 * reach this service directly.
 */
public final class FpHandlers {
    private static final Logger LOG = LoggerFactory.getLogger(FpHandlers.class);

    private final FpProvider provider;
    private final double threshold;

    public FpHandlers(FpProvider provider, double threshold) {
        this.provider = provider;
        this.threshold = threshold;
    }

    public void register(Javalin app) {
        app.post("/fp/health", this::health);
        app.post("/fp/match",  this::match);
    }

    private void health(Context ctx) {
        LinkedHashMap<String, Object> m = Envelope.ok("OK");
        m.put("Version", provider.version());
        m.put("Threshold", threshold);
        ctx.json(m);
    }

    private void match(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            byte[] probe = b64(body, "ProbeTemplate");
            byte[] gallery = b64(body, "GalleryTemplate");
            if (probe == null || gallery == null) {
                ctx.json(Envelope.err("-4",
                    "ProbeTemplate and GalleryTemplate (base64) required"));
                return;
            }
            double score = provider.match(probe, gallery);
            LinkedHashMap<String, Object> r = Envelope.ok("OK");
            r.put("Score", score);
            r.put("Threshold", threshold);
            r.put("Status", score >= threshold);
            ctx.json(r);
        } catch (FpException e) {
            writeErr(ctx, e);
        }
    }

    // -- helpers --------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readBody(Context ctx) {
        if (ctx.body() == null || ctx.body().isEmpty()) return Map.of();
        Map<String, Object> m = ctx.bodyAsClass(HashMap.class);
        return m != null ? m : Map.of();
    }

    private static byte[] b64(Map<String, Object> body, String key) {
        Object v = body.get(key);
        if (!(v instanceof String) || ((String) v).isEmpty()) return null;
        try { return Base64.getDecoder().decode((String) v); }
        catch (IllegalArgumentException e) { return null; }
    }

    private static void writeErr(Context ctx, FpException e) {
        LOG.warn("fp error code={} msg={}", e.code, e.getMessage());
        ctx.json(Envelope.err(e.code, e.getMessage()));
    }
}
