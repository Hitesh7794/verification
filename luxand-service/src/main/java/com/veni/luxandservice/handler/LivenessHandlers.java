package com.veni.luxandservice.handler;

import com.veni.luxandservice.Envelope;
import com.veni.luxandservice.provider.FaceException;
import com.veni.luxandservice.provider.FaceProvider;
import com.veni.luxandservice.provider.LivenessSignals;
import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Active-liveness endpoint. Consumes a short sequence of JPEG frames
 * captured during a browser-side challenge (e.g. "blink twice") and
 * returns a pass/fail summary the Go backend can act on.
 *
 * <pre>
 *   POST /face/liveness
 *     body:
 *       {
 *         "Frames":     ["b64jpg", "b64jpg", ...],  // required, ≥ MIN_FRAMES
 *         "Mime":       "image/jpeg",               // default
 *         "Challenges": ["blink"]                    // subset of {blink}
 *                                                    // (turn_left / turn_right
 *                                                    // reserved for later)
 *       }
 *
 *     reply (200):
 *       {
 *         ErrorCode:          "0",
 *         ErrorDescription:   "OK",
 *         FacesFound:         27,        // frames where a face was tracked
 *         PassiveMean:        0.82,      // mean per-frame Luxand liveness
 *         PassivePassed:      true,      // PassiveMean ≥ 0.5 AND per-frame floor
 *         BlinksDetected:     2,         // eye-close→open events counted
 *         ChallengesPassed:   ["blink"], // strict subset of Challenges
 *         AllPassed:          true       // passive AND every requested challenge
 *       }
 * </pre>
 *
 * <p>The pass/fail policy lives here (not in the provider) so we can
 * tune thresholds without rebuilding the JAR.
 */
public final class LivenessHandlers {
    private static final Logger LOG = LoggerFactory.getLogger(LivenessHandlers.class);

    /** Below this the sequence is too short to trust; policy rejects it. */
    private static final int MIN_FRAMES = 15;

    /** Passive-score policy. Both must hold to say "passive passed". */
    private static final float PASSIVE_MEAN_MIN = 0.50f;   // mean across frames
    private static final float PASSIVE_PER_FRAME_FLOOR = 0.20f; // worst frame

    /**
     * Eye-close threshold. FSDK's EyesOpen (with per-frame smoothing
     * DISABLED so a real blink actually shows up in the series) sits
     * near ~0.9 for a wide-open eye and dips during a blink. A cross
     * below CLOSE_TH followed by a return above OPEN_TH counts as one
     * blink. Loosened from 0.35/0.70 → 0.50/0.75 after v1.1.2 field
     * testing showed natural blinks dipping only to ~0.4-0.5 at 10 fps
     * capture, not the 0.2 the paper values assume.
     */
    private static final float EYES_CLOSE_TH = 0.50f;
    private static final float EYES_OPEN_TH  = 0.75f;

    private final FaceProvider provider;

    public LivenessHandlers(FaceProvider provider) {
        this.provider = provider;
    }

    public void register(Javalin app) {
        app.post("/face/liveness", this::check);
    }

    private void check(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);

            List<byte[]> frames = decodeFrames(body.get("Frames"));
            if (frames == null || frames.size() < MIN_FRAMES) {
                ctx.json(Envelope.err("-4",
                    "Frames array (base64 JPEGs) required, minimum "
                        + MIN_FRAMES + " entries; got "
                        + (frames == null ? 0 : frames.size())));
                return;
            }
            String mime = strParam(body, "Mime", "image/jpeg");
            List<String> requested = decodeChallenges(body.get("Challenges"));

            LivenessSignals sig = provider.livenessSequence(
                frames.toArray(new byte[0][]), mime);

            boolean passive = passivePolicy(sig.passive);
            int blinks = countBlinks(sig.eyesOpen);
            float passiveMean = mean(sig.passive);

            List<String> challengesPassed = new ArrayList<>();
            for (String c : requested) {
                if ("blink".equalsIgnoreCase(c) && blinks >= 2) {
                    challengesPassed.add("blink");
                }
                // "turn_left" / "turn_right" will read the yaw series
                // when we wire them in a follow-up. Kept off the pass
                // list here so a caller that requests them fails until
                // we implement the detector.
            }

            boolean allPassed =
                sig.facesFound >= MIN_FRAMES / 2
                && passive
                && challengesPassed.size() == requested.size()
                && !requested.isEmpty();

            LinkedHashMap<String, Object> r = Envelope.ok("OK");
            r.put("FacesFound",       sig.facesFound);
            r.put("PassiveMean",      round(passiveMean, 3));
            r.put("PassivePassed",    passive);
            r.put("BlinksDetected",   blinks);
            r.put("ChallengesPassed", challengesPassed);
            r.put("AllPassed",        allPassed);
            ctx.json(r);
        } catch (FaceException e) {
            writeErr(ctx, e);
        } catch (RuntimeException e) {
            LOG.warn("liveness handler unexpected error", e);
            ctx.json(Envelope.err("-1", "internal: " + e.getMessage()));
        }
    }

    // -- policy helpers ---------------------------------------------------

    private static boolean passivePolicy(float[] passive) {
        int okCount = 0;
        int totalCount = 0;
        float worst = Float.POSITIVE_INFINITY;
        for (float v : passive) {
            if (Float.isNaN(v)) continue;
            totalCount++;
            if (v < worst) worst = v;
            if (v >= PASSIVE_MEAN_MIN) okCount++;
        }
        if (totalCount == 0) return false;
        float mean = mean(passive);
        return mean >= PASSIVE_MEAN_MIN
            && worst >= PASSIVE_PER_FRAME_FLOOR
            && (okCount * 2) >= totalCount;
    }

    private static float mean(float[] xs) {
        double s = 0;
        int n = 0;
        for (float x : xs) {
            if (Float.isNaN(x)) continue;
            s += x;
            n++;
        }
        return n == 0 ? Float.NaN : (float) (s / n);
    }

    /**
     * Count high→low→high transitions in the smoothed EyesOpen series.
     * A run of NaN frames breaks continuity — those frames don't stall
     * the state machine, but they don't contribute either.
     */
    private static int countBlinks(float[] eyesOpen) {
        int blinks = 0;
        // 0 = waiting for eyes to open (initial), 1 = eyes are open,
        // 2 = eyes closed after being open (waiting for reopen).
        int state = 0;
        for (float v : eyesOpen) {
            if (Float.isNaN(v)) continue;
            switch (state) {
                case 0:
                    if (v >= EYES_OPEN_TH) state = 1;
                    break;
                case 1:
                    if (v <= EYES_CLOSE_TH) state = 2;
                    break;
                case 2:
                    if (v >= EYES_OPEN_TH) { blinks++; state = 1; }
                    break;
            }
        }
        return blinks;
    }

    // -- request decoding -------------------------------------------------

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readBody(Context ctx) {
        if (ctx.body() == null || ctx.body().isEmpty()) return Map.of();
        Map<String, Object> m = ctx.bodyAsClass(HashMap.class);
        return m != null ? m : Map.of();
    }

    private static List<byte[]> decodeFrames(Object raw) {
        if (!(raw instanceof List<?>)) return null;
        List<?> in = (List<?>) raw;
        List<byte[]> out = new ArrayList<>(in.size());
        for (Object el : in) {
            if (!(el instanceof String)) return null;
            String s = (String) el;
            // Accept plain base64 or a data: URL as the browser's
            // canvas.toDataURL emits.
            int comma = s.indexOf(',');
            if (comma > 0 && s.startsWith("data:")) s = s.substring(comma + 1);
            try {
                out.add(Base64.getDecoder().decode(s));
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
        return out;
    }

    private static List<String> decodeChallenges(Object raw) {
        List<String> out = new ArrayList<>();
        if (raw instanceof List<?>) {
            for (Object el : (List<?>) raw) {
                if (el instanceof String) out.add((String) el);
            }
        }
        if (out.isEmpty()) out.add("blink"); // sane default
        return out;
    }

    private static String strParam(Map<String, Object> body, String key, String def) {
        Object v = body.get(key);
        if (v == null) return def;
        String s = String.valueOf(v).trim();
        return s.isEmpty() ? def : s;
    }

    private static double round(float v, int digits) {
        if (Float.isNaN(v)) return -1.0;
        double m = Math.pow(10, digits);
        return Math.round(v * m) / m;
    }

    private static void writeErr(Context ctx, FaceException e) {
        LOG.warn("liveness error code={} msg={}", e.code, e.getMessage());
        ctx.json(Envelope.err(e.code, e.getMessage()));
    }
}
