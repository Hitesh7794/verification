package com.veni.irisservice.handler;

import com.veni.irisservice.Envelope;
import com.veni.irisservice.provider.IrisException;
import com.veni.irisservice.provider.IrisProvider;
import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Wires the IrisProvider behind the HTTP surface. Endpoint paths and
 * JSON shapes mirror MorFin daemon's wire format so the portal frontend
 * can use the same patterns:
 *
 * <pre>
 *   POST /iris/supporteddevicelist
 *   POST /iris/connecteddevicelist
 *   POST /iris/checkdevice         {"ConnectedDvc": "MIS100V2"}
 *   POST /iris/info                {"ConnectedDvc": "MIS100V2"}
 *   POST /iris/initdevice          {"ConnectedDvc": "MIS100V2"}
 *   POST /iris/uninitdevice
 *   POST /iris/capture             {"MinQuality": 60, "UpperQuality": 95, "TimeOut": 10000}
 *   POST /iris/match               {
 *      "ProbLeft":  base64,  "ProbRight":  base64,
 *      "GalleryLeft": base64, "GalleryRight": base64,
 *      "Format": "BMP"|"RAW"|"K7"|"IIR_K7"|"K1"
 *   }
 *
 * Format values mirror {@code com.mantra.marvisauth.enums.ImageFormat}
 * verified against the vendor JAR's bytecode. Older docs referenced
 * "K3" and "JPEG2000" — those constants do not exist in the SDK.
 * </pre>
 *
 * Every response carries {@code ErrorCode} (string) + {@code ErrorDescription}.
 * Successful responses add typed fields documented per-handler.
 */
public final class IrisHandlers {
    private static final Logger LOG = LoggerFactory.getLogger(IrisHandlers.class);

    private final IrisProvider provider;

    public IrisHandlers(IrisProvider provider) {
        this.provider = provider;
    }

    public void register(Javalin app) {
        app.post("/iris/supporteddevicelist", this::supportedDeviceList);
        app.post("/iris/connecteddevicelist", this::connectedDeviceList);
        app.post("/iris/checkdevice",         this::checkDevice);
        app.post("/iris/info",                this::info);
        app.post("/iris/initdevice",          this::initDevice);
        app.post("/iris/uninitdevice",        this::uninitDevice);
        app.post("/iris/capture",             this::capture);
        app.post("/iris/match",               this::match);
    }

    private void supportedDeviceList(Context ctx) {
        try {
            List<String> devices = provider.getSupportedDevices();
            ctx.json(Envelope.ok("Supported Devices: " + String.join(",", devices)));
        } catch (IrisException e) { writeErr(ctx, e); }
    }

    private void connectedDeviceList(Context ctx) {
        try {
            List<String> devices = provider.getConnectedDevices();
            String desc = devices.isEmpty() ? "" : "Found Devices: " + String.join(",", devices);
            ctx.json(Envelope.ok(desc));
        } catch (IrisException e) { writeErr(ctx, e); }
    }

    private void checkDevice(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            String name = strParam(body, "ConnectedDvc", "MIS100V2");
            provider.checkDevice(name);
            ctx.json(Envelope.ok("device present"));
        } catch (IrisException e) { writeErr(ctx, e); }
    }

    private void info(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            String name = strParam(body, "ConnectedDvc", "MIS100V2");
            IrisProvider.DeviceInfo info = provider.getInfo(name);
            LinkedHashMap<String, Object> resp = Envelope.ok("OK");
            resp.put("DeviceInfo", info);
            ctx.json(resp);
        } catch (IrisException e) { writeErr(ctx, e); }
    }

    private void initDevice(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            provider.init(strParam(body, "ConnectedDvc", "MIS100V2"));
            ctx.json(Envelope.ok("init OK"));
        } catch (IrisException e) { writeErr(ctx, e); }
    }

    private void uninitDevice(Context ctx) {
        provider.uninit();
        ctx.json(Envelope.ok("uninit OK"));
    }

    private void capture(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            int minQ = intParam(body, "MinQuality", 50);
            int upQ  = intParam(body, "UpperQuality", 95);
            int tout = intParam(body, "TimeOut", 10000);

            IrisProvider.CaptureResult cap = provider.autoCapture(minQ, upQ, tout);
            LinkedHashMap<String, Object> resp = Envelope.ok("Capture Success");
            resp.put("Left",  toEyeJson(cap.Left));
            resp.put("Right", toEyeJson(cap.Right));
            ctx.json(resp);
        } catch (IrisException e) { writeErr(ctx, e); }
    }

    private void match(Context ctx) {
        try {
            Map<String, Object> body = readBody(ctx);
            String format = strParam(body, "Format", "K7");
            byte[] probeLeft   = decodeIfPresent(body, "ProbLeft");
            byte[] probeRight  = decodeIfPresent(body, "ProbRight");
            byte[] galleryLeft = decodeIfPresent(body, "GalleryLeft");
            byte[] galleryRight = decodeIfPresent(body, "GalleryRight");

            boolean hasLeft  = probeLeft != null && galleryLeft != null;
            boolean hasRight = probeRight != null && galleryRight != null;
            if (!hasLeft && !hasRight) {
                ctx.json(Envelope.err("-1", "at least one prob+gallery pair required"));
                return;
            }

            Float leftScore = null, rightScore = null;
            boolean overallStatus = false;
            if (hasLeft) {
                IrisProvider.MatchResult mr = provider.matchImage(probeLeft, galleryLeft, format);
                leftScore = mr.LeftScore;
                overallStatus |= mr.Status;
            }
            if (hasRight) {
                IrisProvider.MatchResult mr = provider.matchImage(probeRight, galleryRight, format);
                rightScore = mr.LeftScore != null ? mr.LeftScore : mr.RightScore;
                overallStatus |= mr.Status;
            }

            LinkedHashMap<String, Object> resp = Envelope.ok("OK");
            resp.put("Status", overallStatus);
            if (leftScore  != null) resp.put("LeftScore",  leftScore);
            if (rightScore != null) resp.put("RightScore", rightScore);
            ctx.json(resp);
        } catch (IrisException e) { writeErr(ctx, e); }
    }

    // -- helpers --

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

    private static int intParam(Map<String, Object> body, String key, int def) {
        Object v = body.get(key);
        if (v == null) return def;
        if (v instanceof Number) return ((Number) v).intValue();
        try { return Integer.parseInt(String.valueOf(v)); }
        catch (NumberFormatException e) { return def; }
    }

    private static byte[] decodeIfPresent(Map<String, Object> body, String key) {
        Object v = body.get(key);
        if (!(v instanceof String) || ((String) v).isEmpty()) return null;
        try {
            return Base64.getDecoder().decode((String) v);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static LinkedHashMap<String, Object> toEyeJson(IrisProvider.Eye e) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        m.put("Quality", e.Quality);
        m.put("IrisX", e.IrisX);
        m.put("IrisY", e.IrisY);
        m.put("IrisR", e.IrisR);
        m.put("BitmapB64", e.image == null || e.image.length == 0
                ? "" : Base64.getEncoder().encodeToString(e.image));
        return m;
    }

    private static void writeErr(Context ctx, IrisException e) {
        LOG.warn("iris error code={} msg={}", e.code, e.getMessage());
        ctx.json(Envelope.err(e.code, e.getMessage()));
    }
}
