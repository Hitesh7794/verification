package com.veni.irisservice.provider;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Reflective wrapper over Mantra's {@code com.mantra.marvisauth.MarvisAuth}.
 *
 * <p>Reflection is deliberate: the vendor JAR is huge (~230 MB of native
 * libraries inside) and we don't want to drag it onto every developer's
 * compile-time classpath. Build the service with the JAR absent and only
 * load it at runtime when {@code IRIS_PROVIDER=marvis} is selected.
 *
 * <p>If the JAR is missing at runtime, the constructor throws —
 * {@link com.veni.irisservice.Main} catches that and falls back to the
 * mock provider with a loud log line.
 *
 * <p>The published vendor signatures (verified by reading
 * {@code MarvisAuth.class}'s constant pool):
 *
 * <pre>
 * int  Init(DeviceModel modelName, DeviceInfo deviceInfo)
 * int  AutoCapture(int minQuality, int upperQuality, int timeOut, IrisAnatomy anatomy)
 * int  GetImage(byte[] image, int[] imageLen, int compressionRatio, ImageFormat format)
 * int  MatchImage(byte[] probImage, byte[] galleryImage, ImageFormat format, float[] matchScore)
 * int  Uninit()
 * </pre>
 *
 * Each returns {@code 0} on success; non-zero is an error code resolvable
 * via {@code GetErrorMessage(int)}.
 */
public final class MarvisIrisProvider implements IrisProvider {

    // Package-private holders for reflective handles. Cached on construct
    // so per-call overhead is just method invocation.
    private final Class<?> marvisAuthCls;
    private final Class<?> deviceModelCls;
    private final Class<?> deviceInfoCls;
    private final Class<?> irisAnatomyCls;
    private final Class<?> imageFormatCls;
    private final Class<?> callbackIface;

    private final Object marvisAuth; // instance of MarvisAuth
    private boolean initialized = false;
    // Cached after the most recent successful Init. getInfo() returns this
    // instead of re-Initializing every call (the vendor's Init populates
    // DeviceInfo as an out parameter — calling it twice on the same device
    // works but is wasteful and adds a USB round-trip per status poll).
    private DeviceInfo lastInfo;

    /**
     * Build a provider against the Marvis classes already present on the
     * caller's classpath. Throws if the JAR isn't loadable — caller can
     * fall back to the mock.
     */
    public MarvisIrisProvider() throws IrisException {
        try {
            this.marvisAuthCls   = Class.forName("com.mantra.marvisauth.MarvisAuth");
            this.deviceModelCls  = Class.forName("com.mantra.marvisauth.enums.DeviceModel");
            this.deviceInfoCls   = Class.forName("com.mantra.marvisauth.DeviceInfo");
            this.irisAnatomyCls  = Class.forName("com.mantra.marvisauth.IrisAnatomy");
            this.imageFormatCls  = Class.forName("com.mantra.marvisauth.enums.ImageFormat");
            this.callbackIface   = Class.forName("com.mantra.marvisauth.MarvisAuth_Callback");

            // The MarvisAuth constructor takes a callback. We supply a
            // no-op proxy — the synchronous AutoCapture path returns its
            // result directly, so we don't need preview/complete events.
            Object noopCallback = java.lang.reflect.Proxy.newProxyInstance(
                callbackIface.getClassLoader(),
                new Class<?>[]{callbackIface},
                (proxy, method, args) -> defaultFor(method.getReturnType()));
            this.marvisAuth = marvisAuthCls
                .getConstructor(callbackIface)
                .newInstance(noopCallback);
        } catch (Throwable t) {
            throw new IrisException("-1", "Marvis SDK unavailable: " + t.getMessage(), t);
        }
    }

    private static Object defaultFor(Class<?> t) {
        if (!t.isPrimitive()) return null;
        if (t == boolean.class) return false;
        if (t == void.class)    return null;
        return 0;
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<String> getSupportedDevices() throws IrisException {
        try {
            List<String> out = new ArrayList<>();
            Method m = marvisAuthCls.getMethod("GetSupportedDevices", List.class);
            int rc = (Integer) m.invoke(marvisAuth, out);
            if (rc != 0) throw errorFromCode(rc);
            return out;
        } catch (IrisException e) {
            throw e;
        } catch (Throwable t) {
            throw new IrisException("-1", "GetSupportedDevices failed: " + t.getMessage(), t);
        }
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<String> getConnectedDevices() throws IrisException {
        try {
            List<String> out = new ArrayList<>();
            Method m = marvisAuthCls.getMethod("GetConnectedDevices", List.class);
            int rc = (Integer) m.invoke(marvisAuth, out);
            if (rc != 0) {
                // 0 with empty list = no device. Some SDKs prefer a non-zero
                // code; tolerate either by returning [] in both cases.
                return out;
            }
            return out;
        } catch (Throwable t) {
            throw new IrisException("-1", "GetConnectedDevices failed: " + t.getMessage(), t);
        }
    }

    @Override
    public void checkDevice(String name) throws IrisException {
        try {
            Object model = enumValueOf(deviceModelCls, name);
            Method m = marvisAuthCls.getMethod("IsDeviceConnected", deviceModelCls);
            boolean connected = (Boolean) m.invoke(marvisAuth, model);
            if (!connected) throw new IrisException("-2027", "device not connected");
        } catch (IrisException e) {
            throw e;
        } catch (Throwable t) {
            throw new IrisException("-1", "IsDeviceConnected failed: " + t.getMessage(), t);
        }
    }

    @Override
    public synchronized DeviceInfo getInfo(String name) throws IrisException {
        if (!initialized || lastInfo == null) init(name);
        return lastInfo;
    }

    @Override
    public synchronized void init(String name) throws IrisException {
        try {
            Object infoObj = deviceInfoCls.getConstructor().newInstance();
            Method m = marvisAuthCls.getMethod("Init", deviceModelCls, deviceInfoCls);
            Object model = enumValueOf(deviceModelCls, name);
            int rc = (Integer) m.invoke(marvisAuth, model, infoObj);
            if (rc != 0) throw errorFromCode(rc);
            DeviceInfo d = new DeviceInfo();
            d.SerialNo = strField(infoObj, "SerialNo");
            d.Make     = strField(infoObj, "Make");
            d.Model    = strField(infoObj, "Model");
            d.Width    = intField(infoObj, "Width");
            d.Height   = intField(infoObj, "Height");
            d.Firmware = strField(infoObj, "Firmware");
            lastInfo = d;
            initialized = true;
        } catch (IrisException e) {
            throw e;
        } catch (Throwable t) {
            throw new IrisException("-1", "Init failed: " + t.getMessage(), t);
        }
    }

    @Override
    public synchronized void uninit() {
        if (!initialized) return;
        try {
            marvisAuthCls.getMethod("Uninit").invoke(marvisAuth);
        } catch (Throwable ignored) {
            // best-effort cleanup
        } finally {
            initialized = false;
            lastInfo = null;
        }
    }

    @Override
    public synchronized CaptureResult autoCapture(int minQuality, int upperQuality, int timeoutMs)
            throws IrisException {
        try {
            Object anatomy = irisAnatomyCls.getConstructor().newInstance();
            Method m = marvisAuthCls.getMethod("AutoCapture", int.class, int.class, int.class, irisAnatomyCls);
            int rc = (Integer) m.invoke(marvisAuth, minQuality, upperQuality, timeoutMs, anatomy);
            if (rc != 0) throw errorFromCode(rc);

            // GetImage in BMP format, sized generously. The SDK fills both
            // image[] and imageLen[0] in place. We size the buffer to a
            // typical iris BMP (~3 MB at 640x480 8bpp + headers).
            byte[] image = new byte[8 * 1024 * 1024];
            int[] imgLen = new int[]{image.length};
            Method gi = marvisAuthCls.getMethod("GetImage", byte[].class, int[].class, int.class, imageFormatCls);
            Object bmp = enumValueOf(imageFormatCls, "BMP");
            int gc = (Integer) gi.invoke(marvisAuth, image, imgLen, 0, bmp);
            byte[] captured = (gc == 0) ? Arrays.copyOf(image, imgLen[0]) : new byte[0];

            CaptureResult r = new CaptureResult();
            r.Left.image  = captured;
            r.Right.image = captured;
            // IrisAnatomy fields verified against the vendor JAR's bytecode:
            // private int Quality, irisX, irisY, irisR (note the casing).
            r.Left.Quality  = intField(anatomy, "Quality");
            r.Right.Quality = intField(anatomy, "Quality");
            r.Left.IrisX  = intField(anatomy, "irisX");
            r.Left.IrisY  = intField(anatomy, "irisY");
            r.Left.IrisR  = intField(anatomy, "irisR");
            r.Right.IrisX = intField(anatomy, "irisX");
            r.Right.IrisY = intField(anatomy, "irisY");
            r.Right.IrisR = intField(anatomy, "irisR");
            return r;
        } catch (IrisException e) {
            throw e;
        } catch (Throwable t) {
            throw new IrisException("-1", "AutoCapture failed: " + t.getMessage(), t);
        }
    }

    @Override
    public MatchResult matchImage(byte[] probe, byte[] gallery, String format)
            throws IrisException {
        try {
            Object fmt = enumValueOf(imageFormatCls, format);
            // Size 2: vendor's signature is float[]; constant-pool inspection
            // showed both `matchScore` and `matchScore1` referenced — likely
            // two scores for left + right eye. Size 2 covers both possibilities;
            // a single-score SDK leaves index 1 as 0.
            float[] scores = new float[2];
            Method m = marvisAuthCls.getMethod("MatchImage", byte[].class, byte[].class, imageFormatCls, float[].class);
            int rc = (Integer) m.invoke(marvisAuth, probe, gallery, fmt, scores);
            if (rc != 0) throw errorFromCode(rc);
            MatchResult r = new MatchResult();
            r.LeftScore  = scores[0];
            r.RightScore = scores[1] != 0f ? scores[1] : null;
            // Threshold left to the caller; surface raw scores. The HTTP
            // layer applies the operator-side threshold against these.
            r.Status = scores[0] > 0f;
            return r;
        } catch (IrisException e) {
            throw e;
        } catch (Throwable t) {
            throw new IrisException("-1", "MatchImage failed: " + t.getMessage(), t);
        }
    }

    private IrisException errorFromCode(int rc) {
        try {
            Method gem = marvisAuthCls.getMethod("GetErrorMessage", int.class);
            String msg = (String) gem.invoke(marvisAuth, rc);
            return new IrisException(String.valueOf(rc), msg);
        } catch (Throwable t) {
            return new IrisException(String.valueOf(rc), "Marvis error " + rc);
        }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static Object enumValueOf(Class<?> enumCls, String name) {
        return Enum.valueOf((Class<Enum>) enumCls, name);
    }

    // Vendor classes mix two conventions: DeviceInfo uses public fields
    // (SerialNo, Model, ...), while IrisAnatomy uses private fields with
    // public getters (Quality / getQuality(), irisX / getIrisX(), ...).
    // Try public field, then declared+setAccessible, then a JavaBean getter.
    // The earlier helper only handled public fields, so every IrisAnatomy
    // value was silently coming back as 0.
    private static String strField(Object obj, String name) {
        Object v = readMember(obj, name);
        return v == null ? "" : String.valueOf(v);
    }

    private static int intField(Object obj, String name) {
        Object v = readMember(obj, name);
        return v instanceof Number ? ((Number) v).intValue() : 0;
    }

    private static Object readMember(Object obj, String name) {
        try {
            return obj.getClass().getField(name).get(obj);
        } catch (NoSuchFieldException | IllegalAccessException ignored) {
        }
        try {
            java.lang.reflect.Field f = obj.getClass().getDeclaredField(name);
            f.setAccessible(true);
            return f.get(obj);
        } catch (NoSuchFieldException | IllegalAccessException ignored) {
        }
        String getter = "get" + Character.toUpperCase(name.charAt(0)) + name.substring(1);
        try {
            return obj.getClass().getMethod(getter).invoke(obj);
        } catch (Throwable ignored) {
            return null;
        }
    }
}
