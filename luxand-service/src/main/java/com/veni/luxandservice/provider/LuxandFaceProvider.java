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
    private final Class<?> faceTemplateCls;        // FSDK_FaceTemplate
    private final Class<?> faceTemplateRefCls;     // FSDK_FaceTemplate.ByReference

    private boolean activated = false;

    public LuxandFaceProvider() throws FaceException {
        try {
            this.fsdkCls = Class.forName("Luxand.FSDK");
            this.hImageCls = Class.forName("Luxand.FSDK$HImage");
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
