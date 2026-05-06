package com.veni.luxandservice.provider;

/**
 * Abstraction over a face-recognition SDK. The HTTP layer talks to this
 * interface; production wiring is {@link LuxandFaceProvider}, which
 * reflectively calls into the Luxand FSDK JAR. Tests use a tiny in-memory
 * stub.
 *
 * <p>All methods take or return raw byte[] — face templates are exactly
 * 1040 bytes (as defined by Luxand's {@code FSDK_FaceTemplate}). The HTTP
 * layer base64-encodes them on the wire.
 */
public interface FaceProvider {

    /** Activate the SDK. Called once at service start. */
    void activate(String licenseKey) throws FaceException;

    /** Initialize internal SDK state. Called once after activate. */
    void initialize() throws FaceException;

    /** SDK + version info, mainly for diagnostics. */
    String version();

    /** True if activated. The startup probe uses this. */
    boolean isActivated();

    /**
     * Compute the similarity threshold corresponding to a target False
     * Accept Rate (e.g. 0.0001 = 1 wrong match per 10,000 trials). The
     * service caches the result at startup so it's available without
     * round-tripping the SDK on every request.
     */
    float matchingThresholdAtFAR(float far) throws FaceException;

    /**
     * Detect the largest face in the image and extract a face template.
     * Returns {@code null} if no face is detected.
     */
    byte[] extractTemplate(byte[] imageBytes, String mime) throws FaceException;

    /**
     * 1:1 match between two pre-extracted templates. Returns the cosine-
     * similarity-style score in [0, 1].
     */
    float match(byte[] probe, byte[] gallery) throws FaceException;

    /**
     * Convenience: extract a template from {@code probeImage} (the live
     * webcam capture) and 1:1 match it against {@code galleryTemplate}
     * (the candidate's enrolled template).
     *
     * <p>Returns {@link Float#NaN} if no face was detected in the probe;
     * the handler maps that to a clean error response so the operator
     * gets "no face found, please re-capture" rather than a low score.
     */
    float matchImage(byte[] probeImage, String probeMime, byte[] galleryTemplate)
            throws FaceException;

    /**
     * Release SDK resources. Called from a JVM shutdown hook.
     */
    default void shutdown() {}
}
