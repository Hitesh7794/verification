package com.veni.irisservice.provider;

/**
 * Thrown by IrisProvider implementations on any failure. The HTTP layer
 * maps the (code, message) pair onto the {ErrorCode, ErrorDescription}
 * envelope. Code is a string to match the wire format on the daemon.
 */
public final class IrisException extends Exception {
    public final String code;

    public IrisException(String code, String message) {
        super(message);
        this.code = code;
    }

    public IrisException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }
}
