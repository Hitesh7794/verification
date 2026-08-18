package com.veni.luxandservice.provider;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Reflective wrapper around Luxand's {@code Luxand.FSDK} class. Reflection
 * is deliberate: the FaceSDK JAR + its native {@code libfsdk.so} are
 * 70+ MB and Linux-only, and we don't want a Mac developer's compile to
 * fail just because the native isn't loadable. By going through reflection
 * the {@code com.veni.luxandservice} module compiles on any OS; the Linux
 * dependency is enforced at runtime, when the operator actually plugs
 * the service into the portal.
 *
 * <p>If anything in the reflective chain fails, every method throws
 * {@link FaceException} with the FSDK error code stringified. The service
 * treats this as fatal at startup (fail-fast on activation) so an
 * unactivated or unloadable SDK is loud rather than silent.
 *
 * <p>The vendor signatures we exercise (verified by reading
 * {@code Luxand/FSDK.java} in the wrapper source):
 *
 * <pre>
 *   int FSDK.ActivateLibrary(String licenseKey)
 *   int FSDK.Initialize()
 *   int FSDK.LoadImageFromJpegBuffer(HImage img, byte[] buf, int len)
 *   int FSDK.LoadImageFromPngBuffer (HImage img, byte[] buf, int len)
 *   int FSDK.GetFaceTemplate(HImage img, FSDK_FaceTemplate.ByReference out)
 *   int FSDK.MatchFaces(FSDK_FaceTemplate.ByReference t1,
 *                       FSDK_FaceTemplate.ByReference t2,
 *                       float[] similarityOut)
 *   int FSDK.GetMatchingThresholdAtFAR(float far, float[] thresholdOut)
 *   int FSDK.FreeImage(HImage img)
 * </pre>
 */
public final class LuxandFaceProvider implements FaceProvider {

    // FSDK error codes worth surfacing distinctly (taken from FSDK.java).
    private static final int FSDKE_OK              = 0;
    private static final int FSDKE_NOT_ACTIVATED   = -2;
    private static final int FSDKE_FACE_NOT_FOUND  = -7;
    private static final int FSDKE_INVALID_TEMPLATE = -25;

    // Reflected handles — populated lazily on first use.
    private final Class<?> fsdkCls;
    private final Class<?> hImageCls;
    private final Class<?> hTrackerCls;             // FSDK.HTracker
    private final Class<?> faceTemplateCls;        // FSDK_FaceTemplate
    private final Class<?> faceTemplateRefCls;     // FSDK_FaceTemplate.ByReference

    private boolean activated = false;

    public LuxandFaceProvider() throws FaceException {
        try {
            this.fsdkCls = Class.forName("Luxand.FSDK");
            this.hImageCls = Class.forName("Luxand.FSDK$HImage");
            this.hTrackerCls = Class.forName("Luxand.FSDK$HTracker");
            this.faceTemplateCls = Class.forName("Luxand.FSDK$FSDK_FaceTemplate");
            this.faceTemplateRefCls = Class.forName("Luxand.FSDK$FSDK_FaceTemplate$ByReference");
        } catch (Throwable t) {
            throw new FaceException("-1",
                "Luxand FSDK classes not loadable. Confirm FaceSDK.jar + jna-5.18.1.jar"
                + " are on the classpath, and libfsdk.so is locatable via java.library.path"
                + " or the JNA system property jna.library.path."
                + " (cause: " + t.getMessage() + ")", t);
        }
    }

    @Override
    public synchronized void activate(String licenseKey) throws FaceException {
        if (licenseKey == null || licenseKey.isBlank()) {
            throw new FaceException("-2", "FSDK_LICENSE_KEY env var is empty or unset");
        }
        int rc = invokeStaticInt("ActivateLibrary", new Class<?>[]{String.class}, licenseKey);
        if (rc != FSDKE_OK) {
            throw new FaceException(String.valueOf(rc),
                "ActivateLibrary failed (code " + rc + "). The license key may be invalid,"
                + " expired, or bound to a different domain/hardware.");
        }
        activated = true;
    }

    @Override
    public synchronized void initialize() throws FaceException {
        int rc = invokeStaticInt("Initialize", new Class<?>[]{});
        if (rc != FSDKE_OK) {
            throw new FaceException(String.valueOf(rc),
                "FSDK Initialize failed (code " + rc + ")");
        }
    }

    @Override
    public String version() {
        // FSDK doesn't expose a programmatic version field — the JAR
        // filename and EULA are the canonical source. Keep this static
        // so it shows up in the /face/health response.
        return "Luxand FaceSDK 8.3";
    }

    @Override
    public boolean isActivated() {
        return activated;
    }

    @Override
    public float matchingThresholdAtFAR(float far) throws FaceException {
        float[] out = new float[1];
        int rc = invokeStaticInt("GetMatchingThresholdAtFAR",
            new Class<?>[]{float.class, float[].class}, far, out);
        if (rc != FSDKE_OK) {
            throw new FaceException(String.valueOf(rc),
                "GetMatchingThresholdAtFAR(" + far + ") failed (code " + rc + ")");
        }
        return out[0];
    }

    @Override
    public byte[] extractTemplate(byte[] imageBytes, String mime) throws FaceException {
        Object himage = newHImage();
        try {
            loadImage(himage, imageBytes, mime);
            Object tplRef = newFaceTemplateRef();

            int rc = invokeStaticInt("GetFaceTemplate",
                new Class<?>[]{hImageCls, faceTemplateRefCls}, himage, tplRef);
            if (rc == FSDKE_FACE_NOT_FOUND) {
                return null;
            }
            if (rc != FSDKE_OK) {
                throw new FaceException(String.valueOf(rc),
                    "GetFaceTemplate failed (code " + rc + ")");
            }
            return readTemplateBytes(tplRef);
        } finally {
            try {
                invokeStaticInt("FreeImage", new Class<?>[]{hImageCls}, himage);
            } catch (Throwable ignored) {}
        }
    }

    @Override
    public float match(byte[] probe, byte[] gallery) throws FaceException {
        if (probe == null || gallery == null
                || probe.length != 1040 || gallery.length != 1040) {
            throw new FaceException(String.valueOf(FSDKE_INVALID_TEMPLATE),
                "templates must be 1040 bytes each (got "
                + (probe == null ? "null" : probe.length) + ", "
                + (gallery == null ? "null" : gallery.length) + ")");
        }
        Object probeRef = newFaceTemplateRef();
        Object galleryRef = newFaceTemplateRef();
        writeTemplateBytes(probeRef, probe);
        writeTemplateBytes(galleryRef, gallery);

        float[] sim = new float[1];
        int rc = invokeStaticInt("MatchFaces",
            new Class<?>[]{faceTemplateRefCls, faceTemplateRefCls, float[].class},
            probeRef, galleryRef, sim);
        if (rc != FSDKE_OK) {
            throw new FaceException(String.valueOf(rc),
                "MatchFaces failed (code " + rc + ")");
        }
        return sim[0];
    }

    @Override
    public float matchImage(byte[] probeImage, String probeMime, byte[] galleryTemplate)
            throws FaceException {
        byte[] probeTemplate = extractTemplate(probeImage, probeMime);
        if (probeTemplate == null) {
            return Float.NaN;
        }
        return match(probeTemplate, galleryTemplate);
    }

    // -- active liveness ------------------------------------------------------

    /**
     * Feed each frame through a fresh FSDK tracker and read per-frame
     * Liveness + Expression + face angle values.
     *
     * <p>Concurrency: FSDK's tracker isn't thread-safe, and a single
     * static SDK doesn't tolerate multiple threads inside FeedFrame at
     * once. We serialize on the provider instance — the HTTP service is
     * single-node behind the operator flow, so contention is minimal.
     * If we ever run this at scale, promote to a pool of trackers.
     *
     * <p>DetectLiveness is a Luxand model that scores the passive
     * "is this a live person" probability per frame after the tracker
     * has enough context (defaults to 15 frames of smoothing). Callers
     * should feed at least that many frames or the passive values in
     * the first few slots will be low even for a real person.
     */
    @Override
    public synchronized LivenessSignals livenessSequence(byte[][] frames, String mime)
            throws FaceException {
        if (frames == null || frames.length == 0) {
            return new LivenessSignals(new float[0], new float[0], new float[0], 0);
        }

        Object tracker = newHTracker();
        try {
            // One SetTrackerMultipleParameters call is faster than a
            // dozen SetTrackerParameters + reduces the risk of a stray
            // typo in one parameter silently disabling detection.
            int errPos = setTrackerMultipleParameters(tracker,
                "DetectLiveness=true;"
                + "DetectExpression=true;"
                + "DetermineFaceRotationAngle=true;"
                + "HandleArbitraryRotations=false;"
                + "InternalResizeWidth=384;"
                + "FaceDetectionThreshold=3;"
                + "SmoothAttributeLiveness=true;"
                + "SmoothAttributeExpressionEyesOpen=true;"
                + "AttributeExpressionEyesOpenSmoothingTemporal=6;"
                + "AttributeLivenessSmoothingAlpha=0.4;"
            );
            if (errPos >= 0) {
                throw new FaceException("-1",
                    "SetTrackerMultipleParameters rejected parameter #" + errPos);
            }

            int n = frames.length;
            float[] passive = new float[n];
            float[] eyes = new float[n];
            float[] yaw = new float[n];
            int found = 0;

            for (int i = 0; i < n; i++) {
                java.util.Arrays.fill(passive, i, i + 1, Float.NaN);
                java.util.Arrays.fill(eyes, i, i + 1, Float.NaN);
                java.util.Arrays.fill(yaw, i, i + 1, Float.NaN);

                if (frames[i] == null || frames[i].length == 0) continue;

                Object himage = newHImage();
                try {
                    // Bad frame → skip, don't kill the whole sequence.
                    try {
                        loadImage(himage, frames[i], mime);
                    } catch (FaceException e) {
                        continue;
                    }

                    long[] faceCount = new long[]{0};
                    long[] ids = new long[8]; // up to 8 IDs per frame — plenty
                    int rc = feedFrame(tracker, 0, himage, faceCount, ids);
                    if (rc != FSDKE_OK || faceCount[0] == 0) continue;

                    long id = ids[0];
                    Float p = readAttributeFloat(tracker, id, "Liveness");
                    if (p != null) passive[i] = p;

                    // Expression returns a semicolon-list like
                    // "Smile=0.03;EyesOpen=0.92;" — parse EyesOpen out.
                    String expr = readAttribute(tracker, id, "Expression");
                    Float e = parseKeyEquals(expr, "EyesOpen");
                    if (e != null) eyes[i] = e;

                    // Not all builds populate a "FaceAngle" attribute
                    // reliably; leave as NaN if we can't parse it.
                    String angles = readAttribute(tracker, id, "FaceAngle");
                    Float y = parseKeyEquals(angles, "Yaw");
                    if (y != null) yaw[i] = y;

                    found++;
                } finally {
                    try {
                        invokeStaticInt("FreeImage", new Class<?>[]{hImageCls}, himage);
                    } catch (Throwable ignored) {}
                }
            }

            return new LivenessSignals(passive, eyes, yaw, found);
        } finally {
            try {
                invokeStaticInt("FreeTracker",
                    new Class<?>[]{hTrackerCls}, tracker);
            } catch (Throwable ignored) {}
        }
    }

    // -- reflection helpers ---------------------------------------------------

    private int invokeStaticInt(String name, Class<?>[] sig, Object... args)
            throws FaceException {
        try {
            Method m = fsdkCls.getMethod(name, sig);
            Object out = m.invoke(null, args);
            return (Integer) out;
        } catch (Throwable t) {
            throw new FaceException("-1", "FSDK." + name + " reflective call failed: "
                + t.getMessage(), t);
        }
    }

    private Object newHImage() throws FaceException {
        try {
            Constructor<?> c = hImageCls.getConstructor();
            return c.newInstance();
        } catch (Throwable t) {
            throw new FaceException("-1", "HImage instantiate failed: " + t.getMessage(), t);
        }
    }

    private Object newFaceTemplateRef() throws FaceException {
        try {
            Constructor<?> c = faceTemplateRefCls.getConstructor();
            return c.newInstance();
        } catch (Throwable t) {
            throw new FaceException("-1",
                "FSDK_FaceTemplate.ByReference instantiate failed: " + t.getMessage(), t);
        }
    }

    private void loadImage(Object himage, byte[] bytes, String mime) throws FaceException {
        // Pick the right loader based on the declared mime type. Webcam
        // captures from the browser arrive as JPEG by default; the iris
        // and fingerprint daemons hand us BMP. PNG is rare but supported.
        String fn;
        if (mime != null && mime.toLowerCase().contains("png")) {
            fn = "LoadImageFromPngBuffer";
        } else {
            fn = "LoadImageFromJpegBuffer";
        }
        int rc = invokeStaticInt(fn,
            new Class<?>[]{hImageCls, byte[].class, int.class}, himage, bytes, bytes.length);
        if (rc != FSDKE_OK) {
            throw new FaceException(String.valueOf(rc),
                fn + " failed (code " + rc + ", " + bytes.length + " bytes)");
        }
    }

    private byte[] readTemplateBytes(Object tplRef) throws FaceException {
        try {
            Field f = faceTemplateCls.getField("template");
            byte[] arr = (byte[]) f.get(tplRef);
            // Defensive copy — JNA reuses the underlying buffer.
            byte[] out = new byte[arr.length];
            System.arraycopy(arr, 0, out, 0, arr.length);
            return out;
        } catch (Throwable t) {
            throw new FaceException("-1",
                "could not read FSDK_FaceTemplate.template: " + t.getMessage(), t);
        }
    }

    private Object newHTracker() throws FaceException {
        try {
            Constructor<?> c = hTrackerCls.getConstructor();
            Object t = c.newInstance();
            int rc = invokeStaticInt("CreateTracker",
                new Class<?>[]{hTrackerCls}, t);
            if (rc != FSDKE_OK) {
                throw new FaceException(String.valueOf(rc),
                    "CreateTracker failed (code " + rc + ")");
            }
            return t;
        } catch (FaceException fe) {
            throw fe;
        } catch (Throwable t) {
            throw new FaceException("-1",
                "HTracker instantiate failed: " + t.getMessage(), t);
        }
    }

    /**
     * Returns the FSDK error position: -1 on success, else a positive
     * index into the config string. Vendor semantics.
     */
    private int setTrackerMultipleParameters(Object tracker, String params)
            throws FaceException {
        int[] errPos = new int[]{-1};
        int rc;
        try {
            Method m = fsdkCls.getMethod("SetTrackerMultipleParameters",
                hTrackerCls, String.class, int[].class);
            rc = (Integer) m.invoke(null, tracker, params, errPos);
        } catch (Throwable t) {
            throw new FaceException("-1",
                "SetTrackerMultipleParameters reflective call failed: "
                    + t.getMessage(), t);
        }
        if (rc != FSDKE_OK) {
            return errPos[0] >= 0 ? errPos[0] : 0;
        }
        return -1;
    }

    private int feedFrame(Object tracker, long cameraIdx, Object himage,
                          long[] faceCount, long[] ids) throws FaceException {
        try {
            Method m = fsdkCls.getMethod("FeedFrame",
                hTrackerCls, long.class, hImageCls, long[].class, long[].class);
            return (Integer) m.invoke(null, tracker, cameraIdx, himage, faceCount, ids);
        } catch (Throwable t) {
            throw new FaceException("-1",
                "FeedFrame reflective call failed: " + t.getMessage(), t);
        }
    }

    private String readAttribute(Object tracker, long id, String attr) {
        String[] out = new String[]{""};
        try {
            Method m = fsdkCls.getMethod("GetTrackerFacialAttribute",
                hTrackerCls, long.class, long.class, String.class,
                String[].class, long.class);
            int rc = (Integer) m.invoke(null, tracker, 0L, id, attr, out, 256L);
            if (rc != FSDKE_OK) return null;
            return out[0];
        } catch (Throwable t) {
            return null;
        }
    }

    private Float readAttributeFloat(Object tracker, long id, String attr) {
        String s = readAttribute(tracker, id, attr);
        if (s == null || s.isEmpty()) return null;
        // Attributes come back as "AttributeName=0.87" or a bare float
        // depending on the SDK build. Handle both.
        String v = s;
        int eq = s.indexOf('=');
        if (eq >= 0 && eq + 1 < s.length()) {
            int semi = s.indexOf(';', eq + 1);
            v = semi > eq ? s.substring(eq + 1, semi) : s.substring(eq + 1);
        }
        try { return Float.parseFloat(v.trim()); }
        catch (NumberFormatException e) { return null; }
    }

    /** Parse "Smile=0.03;EyesOpen=0.92;Yaw=-4.2" for the given key. */
    private Float parseKeyEquals(String s, String key) {
        if (s == null || s.isEmpty()) return null;
        String needle = key + "=";
        int i = s.indexOf(needle);
        if (i < 0) return null;
        int start = i + needle.length();
        int end = s.indexOf(';', start);
        String v = end < 0 ? s.substring(start) : s.substring(start, end);
        try { return Float.parseFloat(v.trim()); }
        catch (NumberFormatException e) { return null; }
    }

    private void writeTemplateBytes(Object tplRef, byte[] src) throws FaceException {
        try {
            Field f = faceTemplateCls.getField("template");
            byte[] arr = (byte[]) f.get(tplRef);
            System.arraycopy(src, 0, arr, 0, Math.min(src.length, arr.length));
        } catch (Throwable t) {
            throw new FaceException("-1",
                "could not write FSDK_FaceTemplate.template: " + t.getMessage(), t);
        }
    }
}
