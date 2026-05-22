package com.veni.fpmatchservice.provider;

import com.machinezoo.sourceafis.FingerprintCompatibility;
import com.machinezoo.sourceafis.FingerprintMatcher;
import com.machinezoo.sourceafis.FingerprintTemplate;

/**
 * SourceAFIS-backed {@link FpProvider}. SourceAFIS is a pure-Java
 * fingerprint matcher (Apache 2.0) — no native dependencies, no licensing
 * server. {@code FingerprintCompatibility.importTemplate(byte[])} auto-
 * detects ISO/IEC 19794-2:2005 FMR and ANSI INCITS 378-2004 inputs, so we
 * accept whatever the operator-laptop fingerprint daemon emits (Mantra
 * MorFin, Startek/ACPL FM220U) and whatever the candidate gallery has
 * on file in gndu27 (FMR_V2005 in current data).
 *
 * <p>The matcher is stateless and thread-safe; we construct it lazily per
 * call. Building a {@link FingerprintMatcher} is the expensive part
 * (~few ms because it indexes the probe); {@code match(candidate)} on
 * top of that is faster. For 1:1 verification we don't need to cache —
 * each request gets fresh templates.
 */
public final class SourceAfisProvider implements FpProvider {

    @Override
    public String version() {
        // SourceAFIS doesn't expose a programmatic version field; pin our
        // statement to what's declared in pom.xml. Surfaced via /fp/health
        // for operational visibility, not used for any logic.
        return "SourceAFIS 3.18.1";
    }

    @Override
    public double match(byte[] probe, byte[] gallery) throws FpException {
        if (probe == null || probe.length == 0) {
            throw new FpException("-2", "probe template is empty");
        }
        if (gallery == null || gallery.length == 0) {
            throw new FpException("-2", "gallery template is empty");
        }
        FingerprintTemplate probeTpl;
        FingerprintTemplate galleryTpl;
        try {
            probeTpl = FingerprintCompatibility.importTemplate(probe);
        } catch (Throwable t) {
            throw new FpException("-3",
                    "probe template not recognised by SourceAFIS"
                            + " (expected ISO/IEC 19794-2 FMR or ANSI 378): "
                            + t.getMessage(),
                    t);
        }
        try {
            galleryTpl = FingerprintCompatibility.importTemplate(gallery);
        } catch (Throwable t) {
            throw new FpException("-3",
                    "gallery template not recognised by SourceAFIS"
                            + " (expected ISO/IEC 19794-2 FMR or ANSI 378): "
                            + t.getMessage(),
                    t);
        }
        try {
            return new FingerprintMatcher(probeTpl).match(galleryTpl);
        } catch (Throwable t) {
            throw new FpException("-1",
                    "SourceAFIS match failed: " + t.getMessage(), t);
        }
    }
}
