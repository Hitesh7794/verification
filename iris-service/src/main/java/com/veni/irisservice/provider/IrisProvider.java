package com.veni.irisservice.provider;

import java.util.List;

/**
 * Abstraction over the iris SDK so the HTTP layer doesn't depend on
 * Marvis directly. Two implementations:
 * <ul>
 *   <li>{@link MarvisIrisProvider} — calls the real Marvis SDK via
 *       reflection, so building this module doesn't require the vendor
 *       JAR to be on the build-time classpath.</li>
 *   <li>{@link MockIrisProvider} — pure-Java fake; lets the service
 *       run on developer machines without the SDK or USB hardware.</li>
 * </ul>
 * Selection at runtime via the {@code IRIS_PROVIDER} env var
 * ({@code mock} or {@code marvis}; default {@code marvis}).
 */
public interface IrisProvider {

    /** Returns the device-model strings the SDK supports (e.g. ["MIS100V2"]). */
    List<String> getSupportedDevices() throws IrisException;

    /** Returns currently-plugged-in supported devices, or [] if none. */
    List<String> getConnectedDevices() throws IrisException;

    /** Throws if the named device isn't currently connected. */
    void checkDevice(String name) throws IrisException;

    DeviceInfo getInfo(String name) throws IrisException;

    /**
     * Initialise the named device. Idempotent — calling on an already-init
     * provider is a no-op (we re-init internally if the model differs).
     */
    void init(String name) throws IrisException;

    /** Release the device. Idempotent; safe to call when not initialised. */
    void uninit();

    /** Synchronous AutoCapture wrapping {@code MarvisAuth.AutoCapture}. */
    CaptureResult autoCapture(int minQuality, int upperQuality, int timeoutMs) throws IrisException;

    /**
     * 1:1 match of two iris images. Both arguments are in {@code format}.
     * Returns one or two {@code float} scores depending on what the SDK
     * fills in. The vendor's published interface accepts a {@code float[]}
     * out parameter; this wrapper passes one through and returns it.
     */
    MatchResult matchImage(byte[] probe, byte[] gallery, String format) throws IrisException;

    /**
     * Information about the iris device returned by {@code Init}. Field
     * names match the JSON shape on the wire so Jackson can serialise
     * directly without a separate DTO.
     */
    final class DeviceInfo {
        public String SerialNo = "";
        public String Make = "";
        public String Model = "";
        public int Width;
        public int Height;
        public String Firmware = "";
    }

    /**
     * One eye's slice of an AutoCapture result.
     */
    final class Eye {
        public int Quality;
        public int IrisX;
        public int IrisY;
        public int IrisR;
        /** Captured image bytes, base64-encoded by the HTTP layer before send. */
        public byte[] image;
    }

    final class CaptureResult {
        public Eye Left = new Eye();
        public Eye Right = new Eye();
    }

    final class MatchResult {
        public Float LeftScore;
        public Float RightScore;
        public boolean Status;
    }
}
