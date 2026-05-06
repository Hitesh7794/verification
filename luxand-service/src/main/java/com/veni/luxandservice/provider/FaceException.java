package com.veni.luxandservice.provider;

/**
 * Thrown by FaceProvider implementations on any failure. The HTTP layer
 * maps the (code, message) pair onto the {ErrorCode, ErrorDescription}
 * envelope. Code is a string to keep the wire shape uniform with morfin
 * and iris services.
 */
public final class FaceException extends Exception {
    public final String code;

    public FaceException(String code, String message) {
        super(message);
        this.code = code;
    }

    public FaceException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }
}
