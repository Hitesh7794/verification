package com.veni.luxandservice;

import com.veni.luxandservice.provider.FaceException;
import com.veni.luxandservice.provider.FaceProvider;

import java.util.Arrays;

/**
 * Test-only stub that lives under src/test/. Not packaged with the service.
 * Provides deterministic responses for HTTP-layer unit tests without
 * requiring libfsdk.so or a license key.
 *
 * <p>Behaviour:
 * <ul>
 *   <li>activate() always succeeds</li>
 *   <li>extractTemplate() returns 1040 zero-filled bytes prefixed with a
 *       4-byte hash of the input image, or null if {@code triggerNoFace}
 *       is set</li>
 *   <li>match() returns 1.0 if templates are byte-identical, else 0.5</li>
 * </ul>
 */
public final class StubFaceProvider implements FaceProvider {
    public boolean triggerNoFace = false;
    public boolean activated = false;

    @Override public void activate(String licenseKey) { activated = true; }
    @Override public void initialize() {}
    @Override public String version() { return "Stub 0.0.1"; }
    @Override public boolean isActivated() { return activated; }

    @Override
    public float matchingThresholdAtFAR(float far) { return 0.7f; }

    @Override
    public byte[] extractTemplate(byte[] imageBytes, String mime) {
        if (triggerNoFace) return null;
        byte[] tpl = new byte[1040];
        // Cheap content-derived prefix so distinct images get distinct templates.
        int h = Arrays.hashCode(imageBytes);
        tpl[0] = (byte)(h);
        tpl[1] = (byte)(h >>> 8);
        tpl[2] = (byte)(h >>> 16);
        tpl[3] = (byte)(h >>> 24);
        return tpl;
    }

    @Override
    public float match(byte[] probe, byte[] gallery) throws FaceException {
        if (probe == null || gallery == null
                || probe.length != 1040 || gallery.length != 1040) {
            throw new FaceException("-25", "templates must be 1040 bytes");
        }
        return Arrays.equals(probe, gallery) ? 1.0f : 0.5f;
    }

    @Override
    public float matchImage(byte[] probeImage, String mime, byte[] galleryTemplate)
            throws FaceException {
        byte[] probe = extractTemplate(probeImage, mime);
        if (probe == null) return Float.NaN;
        return match(probe, galleryTemplate);
    }
}
