package com.veni.fpmatchservice.provider;

/**
 * Vendor-style typed exception carrying both an error code and a message.
 * Mirrors {@code FaceException} / {@code IrisException} / {@code MorfinError}
 * so the portal backend's typed error handling stays uniform.
 *
 * <p>Codes are arbitrary negative integers (stringified). We use:
 * <ul>
 *   <li>{@code -1}  — generic SourceAFIS / reflective failure</li>
 *   <li>{@code -2}  — invalid input (missing or unparseable template)</li>
 *   <li>{@code -3}  — template format not recognised by SourceAFIS</li>
 * </ul>
 */
public final class FpException extends Exception {
    public final String code;

    public FpException(String code, String message) {
        super(message);
        this.code = code;
    }

    public FpException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }
}
