package com.veni.luxandservice.handler;

import com.veni.luxandservice.Envelope;
import com.veni.luxandservice.provider.FaceException;
import com.veni.luxandservice.provider.FaceProvider;
import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * HTTP routes for the Luxand face service. All endpoints accept and return
 * JSON envelopes consistent with morfin / iris services:
 *
 * <pre>
 *   POST /face/health
 *     → {ErrorCode, ErrorDescription, Activated, Version, Threshold}
 *
 *   POST /face/extract
 *     body:  {Image: base64, Mime: "image/jpeg"|"image/png"}
 *     reply: {ErrorCode, ErrorDescription, Template: base64, FaceFound: bool}
 *
 *   POST /face/match
 *     body:  {ProbeTemplate: base64, GalleryTemplate: base64}
 *     reply: {ErrorCode, ErrorDescription, Score: float, Threshold: float, Status: bool}
 *
 *   POST /face/match-image
 *     body:  {ProbeImage: base64, ProbeMime: "image/jpeg",
 *             GalleryTemplate: base64}
 *     reply: {ErrorCode, ErrorDescription, Score, Threshold, Status, FaceFound}
 *
 *   POST /face/threshold
 *     body:  {FAR: 0.0001}
 *     reply: {ErrorCode, ErrorDescription, Threshold}
 * </pre>
 *
 * <p>The {@code Score} is the cosine-similarity-style float in [0, 1]
 * Luxand returns from {@code MatchFaces}. {@code Status} is a server-side
 * convenience: {@code Score >= Threshold}.
 */
public final class FaceHandlers {
    private static final Logger LOG = LoggerFactory.getLogger(FaceHandlers.class);

    private final FaceProvider provider;
    private final float threshold;

    public FaceHandlers(FaceProvider provider, float threshold) {
        this.provider = provider;
        this.threshold = threshold;
    }

    public void register(Javalin app) {
        app.post("/face/health",      this::health);
        app.post("/face/extract",     this::extract);
        app.post("/face/match",       this::match);
        app.post("/face/match-image", this::matchImage);
        app.post("/face/threshold",   this::thresholdHandler);
    }

    private void health(Context ctx) {
        LinkedHashMap<String, Object> m = Envelope.ok("OK");
        m.put("Activated", provider.isActivated());
        m.put("Version", provider.version());
        m.put("Threshold", threshold);
        ctx.json(m);
    }

    private void extract(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            byte[] image = b64(body, "Image");
            if (image == null) {
                ctx.json(Envelope.err("-4", "Image (base64) required"));
                return;
            }
            String mime = strParam(body, "Mime", "image/jpeg");
            byte[] tpl = provider.extractTemplate(image, mime);
            if (tpl == null) {
                LinkedHashMap<String, Object> r = Envelope.ok("face not detected");
                r.put("FaceFound", false);
                ctx.json(r);
                return;
            }
            LinkedHashMap<String, Object> r = Envelope.ok("OK");
            r.put("FaceFound", true);
            r.put("Template", Base64.getEncoder().encodeToString(tpl));
            ctx.json(r);
        } catch (FaceException e) { writeErr(ctx, e); }
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
            float score = provider.match(probe, gallery);
            LinkedHashMap<String, Object> r = Envelope.ok("OK");
            r.put("Score", score);
            r.put("Threshold", threshold);
            r.put("Status", score >= threshold);
            ctx.json(r);
        } catch (FaceException e) { writeErr(ctx, e); }
    }

    private void matchImage(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            byte[] probeImg = b64(body, "ProbeImage");
            byte[] gallery = b64(body, "GalleryTemplate");
            if (probeImg == null || gallery == null) {
                ctx.json(Envelope.err("-4",
                    "ProbeImage and GalleryTemplate (base64) required"));
                return;
            }
            String mime = strParam(body, "ProbeMime", "image/jpeg");
            float score = provider.matchImage(probeImg, mime, gallery);
            if (Float.isNaN(score)) {
                LinkedHashMap<String, Object> r = Envelope.ok("face not detected in probe");
                r.put("FaceFound", false);
                r.put("Status", false);
                ctx.json(r);
                return;
            }
            LinkedHashMap<String, Object> r = Envelope.ok("OK");
            r.put("FaceFound", true);
            r.put("Score", score);
            r.put("Threshold", threshold);
            r.put("Status", score >= threshold);
            ctx.json(r);
        } catch (FaceException e) { writeErr(ctx, e); }
    }

    private void thresholdHandler(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            float far = floatParam(body, "FAR", 0.0001f);
            float th = provider.matchingThresholdAtFAR(far);
            LinkedHashMap<String, Object> r = Envelope.ok("OK");
            r.put("FAR", far);
            r.put("Threshold", th);
            ctx.json(r);
        } catch (FaceException e) { writeErr(ctx, e); }
    }

    // -- helpers --------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readBody(Context ctx) {
        if (ctx.body() == null || ctx.body().isEmpty()) return Map.of();
        Map<String, Object> m = ctx.bodyAsClass(HashMap.class);
        return m != null ? m : Map.of();
    }

    private static String strParam(Map<String, Object> body, String key, String def) {
        Object v = body.get(key);
        if (v == null) return def;
        String s = String.valueOf(v).trim();
        return s.isEmpty() ? def : s;
    }

    private static float floatParam(Map<String, Object> body, String key, float def) {
        Object v = body.get(key);
        if (v == null) return def;
        if (v instanceof Number) return ((Number) v).floatValue();
        try { return Float.parseFloat(String.valueOf(v)); }
        catch (NumberFormatException e) { return def; }
    }

    private static byte[] b64(Map<String, Object> body, String key) {
        Object v = body.get(key);
        if (!(v instanceof String) || ((String) v).isEmpty()) return null;
        try { return Base64.getDecoder().decode((String) v); }
        catch (IllegalArgumentException e) { return null; }
    }

    private static void writeErr(Context ctx, FaceException e) {
        LOG.warn("face error code={} msg={}", e.code, e.getMessage());
        ctx.json(Envelope.err(e.code, e.getMessage()));
    }
}
