package com.veni.luxandservice.provider;

/**
 * Raw per-frame liveness signals returned by
 * {@link FaceProvider#livenessSequence}. Structured so the HTTP handler
 * can implement its own pass/fail policy (blink counting, turn-head
 * detection, passive-score averaging) without a JAR redeploy.
 *
 * <p>All arrays share the same length — one slot per frame in the
 * sequence, in the order the frames were fed. When no face was tracked
 * on a frame, {@link Float#NaN} is placed in the corresponding slot.
 * {@code facesFound} counts the non-NaN slots.
 */
public final class LivenessSignals {

    /** Per-frame passive liveness value in [0, 1] (Luxand's attribute). */
    public final float[] passive;

    /** Per-frame eyes-open value in [0, 1] (1.0 = wide open). */
    public final float[] eyesOpen;

    /** Per-frame face yaw in degrees, or NaN if unknown. */
    public final float[] yaw;

    /** Number of frames where a face was detected + tracked. */
    public final int facesFound;

    public LivenessSignals(float[] passive, float[] eyesOpen, float[] yaw, int facesFound) {
        this.passive = passive;
        this.eyesOpen = eyesOpen;
        this.yaw = yaw;
        this.facesFound = facesFound;
    }
}
