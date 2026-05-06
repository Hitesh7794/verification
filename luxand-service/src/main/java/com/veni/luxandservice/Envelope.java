package com.veni.luxandservice;

import java.util.LinkedHashMap;

/**
 * Standard JSON envelope. Field names + the string-typed {@code ErrorCode}
 * are deliberately the same as morfin / iris envelopes so the portal
 * backend's parsing is uniform across all three vendors.
 *
 * <p>Luxand's underlying SDK returns numeric error codes ({@code FSDK.FSDKE_*}),
 * which the handler stringifies before placing here.
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
