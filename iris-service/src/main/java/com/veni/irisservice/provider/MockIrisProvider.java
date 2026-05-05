package com.veni.irisservice.provider;

import java.util.Base64;
import java.util.List;

/**
 * Pure-Java fake provider. Returns realistic responses without needing
 * the Marvis SDK or USB hardware. Used when the service is run with
 * {@code IRIS_PROVIDER=mock} (typical for developer laptops).
 *
 * <p>For more sophisticated fault injection (mid-session disconnect,
 * low quality, match fail), prefer the standalone {@code iris-mock}
 * Go binary — it has a {@code /control} endpoint for runtime tweaking.
 * This in-process mock is intentionally minimal: just enough to verify
 * the HTTP layer end-to-end during tests.
 */
public final class MockIrisProvider implements IrisProvider {

    private static final byte[] PLACEHOLDER_IMAGE =
            Base64.getDecoder().decode("Qk1aAAAAAAAAAHYAAAAoAAAAAQAAAAEAAAABAAQAAAAAAAQAAAAAAA==");

    private boolean initialized = false;

    @Override
    public List<String> getSupportedDevices() {
        return List.of("MIS100V2");
    }

    @Override
    public List<String> getConnectedDevices() {
        return List.of("MIS100V2");
    }

    @Override
    public void checkDevice(String name) {}

    @Override
    public void init(String name) {
        initialized = true;
    }

    @Override
    public void uninit() {
        initialized = false;
    }

    @Override
    public DeviceInfo getInfo(String name) {
        DeviceInfo d = new DeviceInfo();
        d.SerialNo = "MOCK-IRIS-0001";
        d.Make = "Mantra";
        d.Model = "MIS100V2";
        d.Width = 640;
        d.Height = 480;
        d.Firmware = "1.0.0-mock";
        return d;
    }

    @Override
    public CaptureResult autoCapture(int minQuality, int upperQuality, int timeoutMs) {
        CaptureResult r = new CaptureResult();
        r.Left.Quality = 78;
        r.Left.IrisX = 320;
        r.Left.IrisY = 240;
        r.Left.IrisR = 90;
        r.Left.image = PLACEHOLDER_IMAGE;
        r.Right.Quality = 81;
        r.Right.IrisX = 322;
        r.Right.IrisY = 238;
        r.Right.IrisR = 91;
        r.Right.image = PLACEHOLDER_IMAGE;
        return r;
    }

    @Override
    public MatchResult matchImage(byte[] probe, byte[] gallery, String format) {
        MatchResult m = new MatchResult();
        // Simple, deterministic: identical bytes = perfect match, otherwise
        // moderate match. Real SDK would return something probability-like.
        boolean same = java.util.Arrays.equals(probe, gallery);
        m.LeftScore = same ? 0.95f : 0.78f;
        m.RightScore = same ? 0.94f : 0.79f;
        m.Status = m.LeftScore >= 0.6f || m.RightScore >= 0.6f;
        return m;
    }
}
