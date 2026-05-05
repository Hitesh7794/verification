package com.veni.irisservice;

import java.util.LinkedHashMap;

/**
 * The JSON shape every iris endpoint returns.
 * <p>
 * Field names and the string-typed {@code ErrorCode} are deliberate —
 * they mirror the MorFin daemon's envelope so the frontend can use the
 * same parsing across both services. The vendor's reference JS compares
 * {@code ErrorCode} with the literal string {@code "0"}.
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
