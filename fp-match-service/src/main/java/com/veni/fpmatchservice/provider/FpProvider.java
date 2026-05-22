package com.veni.fpmatchservice.provider;

/**
 * Vendor-neutral 1:1 fingerprint matcher contract. Production implementation
 * uses SourceAFIS ({@link SourceAfisProvider}); tests use a stub.
 *
 * <p>Templates are passed in as raw bytes (the handler base64-decodes its
 * inputs). Both probe and gallery are expected to be ISO/IEC 19794-2:2005
 * FMR or ANSI INCITS 378 — SourceAFIS auto-detects which.
 */
public interface FpProvider {

    /** Library identifier returned by {@code /fp/health}. */
    String version();

    /**
     * Compute a similarity score between probe and gallery templates.
     *
     * @param probe   raw bytes of the probe FMR/ANSI template
     * @param gallery raw bytes of the gallery FMR/ANSI template
     * @return SourceAFIS similarity score; conventionally a positive double
     *         where ~40 is the 1-in-1000 FMR threshold and self-matches
     *         routinely exceed 100. Callers compare against the configured
     *         threshold; this method does not threshold internally.
     */
    double match(byte[] probe, byte[] gallery) throws FpException;
}
