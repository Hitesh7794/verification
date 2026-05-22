package com.veni.fpmatchservice;

import java.util.LinkedHashMap;

/**
 * Standard JSON envelope. Field names + the string-typed {@code ErrorCode}
 * are deliberately the same as morfin / iris / luxand envelopes so the
 * portal backend's parsing is uniform across vendors.
 *
 * <p>SourceAFIS exceptions are wrapped in {@link com.veni.fpmatchservice.provider.FpException}
 * with a vendor-style error code (a negative integer stringified).
 */
public final class Envelope {
    public static LinkedHashMap<String, Object> ok(String description) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        m.put("ErrorCode", "0");
        m.put("ErrorDescription", description == null ? "OK" : description);
        return m;
    }

    public static LinkedHashMap<String, Object> err(String code, String description) {
        LinkedHashMap<String, Object> m = new LinkedHashMap<>();
        m.put("ErrorCode", code);
        m.put("ErrorDescription", description == null ? "" : description);
        return m;
    }

    private Envelope() {}
}
