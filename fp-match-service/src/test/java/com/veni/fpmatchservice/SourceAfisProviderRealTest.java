package com.veni.fpmatchservice;

import com.veni.fpmatchservice.provider.SourceAfisProvider;
import org.junit.jupiter.api.Test;

import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Integration test of the real SourceAFIS provider with realistic FMR_V2005
 * inputs:
 *
 * <ul>
 *   <li>{@code MANTRA_10001} — gndu27 candidate 10001, extracted by Mantra
 *       MorFin during NEET enrollment (222 bytes).</li>
 *   <li>{@code STARTEK_99999} — captured live from a Startek FM220U L1 on
 *       2026-05-15 (324 bytes); also stored on disk as the gallery for our
 *       test roll 99999.</li>
 * </ul>
 *
 * <p>Spike (Phase A, 2026-05-16) observed: self-matches score 385.18 and
 * 571.32; cross-finger matches score 0.17 and 0.02. We assert: self &gt; 100
 * (well above SourceAFIS's recommended 40 threshold) and cross &lt; 10
 * (well below). These cross/self gaps are huge so the test tolerates score
 * drift across SourceAFIS minor versions without becoming flaky.
 */
class SourceAfisProviderRealTest {

    // gndu27 candidate 10001 — Mantra-extracted FMR_V2005 template.
    // 222 bytes, base64-encoded inline so the test is hermetic.
    private static final String MANTRA_10001 =
        "Rk1SACAyMAAAAADeAAABPAFiAMUAxQEAAAAuIECJAL/EZICtAMBMZEDDAMfGZEBQ" +
        "AIYWXEA5AHgaWEAlAPkkXIAUAO0xX0BvADYLL0CiADD5SYAVAREjNoAzAUoaMEB+" +
        "AMWwZECtALVhZEB6AIX9ZEC7AGDqZED5AHhcYkEBAH/bWkBJATabYUEgALfPOkEk" +
        "ANNNP4EUARzDN0ASATAXDIB6ALWoZIB+AJjvZEC5AIXfZIDgAQu/ZEENAMrMZEAr" +
        "ARaMQYEBAGzTOEAhARINNEBLADoXHUEKASu9WAAA";

    // Startek FM220U L1 live capture (M240477055 device, 2026-05-15) — also
    // stored as gallery for test roll 99999. 324 bytes.
    private static final String STARTEK_99999 =
        "Rk1SACAyMAAAAAFEAAABQAFoAMUAxQEAAABkMYBIAD15ZICsAEJjZICKAEhlZID0" +
        "AE7oZIBwAFLvZICFAFNvZIDzAGBoZIDeAGLhZEB6AGxrZIC7AHflZIBEAHt8ZIET" +
        "AIFtZECqAI9nZIB6AJftZIDfAJpoZICSALFtZEBNALKBZICBALbqZIBvAL12ZICP" +
        "AL5qZEDgAL7mZEBUAL8CZICCAMPtZIBpAMjyZIDAAMjgZECUAM5yZID9AM5lZIC8" +
        "ANRlZICtANfgZEA/ANwJZIAuAN6VZIC2AOBgZICPAOhoZECmAOjeZEBzAOnyZIC0" +
        "AO/eZIBbAPWJZECOAPhmZEB8APnoZECtAPzcZICRAQRlZICyAQdSZEC8AQjhZICO" +
        "AQ9qZEBcATSfZICCATZtZEDXAT3XZIBUAUEoZECLAUHbZAAA";

    private static byte[] decode(String s) {
        return Base64.getDecoder().decode(s.replaceAll("\\s+", ""));
    }

    @Test
    void importsMantraExtractedTemplate() throws Exception {
        SourceAfisProvider p = new SourceAfisProvider();
        // Self-match the Mantra template; importTemplate must succeed for
        // both arguments. Score must be a real (non-NaN, non-zero) number.
        double score = p.match(decode(MANTRA_10001), decode(MANTRA_10001));
        assertFalse(Double.isNaN(score), "score is NaN — importTemplate likely returned a degenerate template");
        assertTrue(score > 100.0,
            "self-match should score >> 100; got " + score
                + " (SourceAFIS recommends threshold 40)");
    }

    @Test
    void importsStartekExtractedTemplate() throws Exception {
        SourceAfisProvider p = new SourceAfisProvider();
        double score = p.match(decode(STARTEK_99999), decode(STARTEK_99999));
        assertFalse(Double.isNaN(score));
        assertTrue(score > 100.0, "self-match should score >> 100; got " + score);
    }

    @Test
    void crossVendorDifferentFingersAreRejected() throws Exception {
        SourceAfisProvider p = new SourceAfisProvider();
        // Mantra-extracted candidate 10001 belongs to a different person than
        // the user's Startek capture stored at roll 99999 — the score should
        // be well below the 40-threshold the service ships with.
        double cross1 = p.match(decode(STARTEK_99999), decode(MANTRA_10001));
        double cross2 = p.match(decode(MANTRA_10001), decode(STARTEK_99999));
        assertTrue(cross1 < 10.0, "cross-finger should score < 10; got " + cross1);
        assertTrue(cross2 < 10.0, "cross-finger should score < 10; got " + cross2);
    }
}
