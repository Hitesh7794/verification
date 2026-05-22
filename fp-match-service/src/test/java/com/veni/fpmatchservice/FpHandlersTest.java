package com.veni.fpmatchservice;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.veni.fpmatchservice.handler.FpHandlers;
import com.veni.fpmatchservice.provider.FpException;
import com.veni.fpmatchservice.provider.FpProvider;
import io.javalin.Javalin;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Arrays;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Verifies the HTTP layer routes / envelope shapes / score wiring against a
 * stub matcher. The real SourceAFIS provider is covered separately in
 * {@link SourceAfisProviderRealTest}.
 */
class FpHandlersTest {

    private static Javalin app;
    private static int port;
    private static StubFpProvider stub;
    private static final ObjectMapper M = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newHttpClient();
    private static final double TEST_THRESHOLD = 40.0;

    @BeforeAll
    static void boot() throws Exception {
        stub = new StubFpProvider();
        app = Javalin.create(cfg -> cfg.showJavalinBanner = false).start("127.0.0.1", 0);
        new FpHandlers(stub, TEST_THRESHOLD).register(app);
        port = app.port();
    }

    @AfterAll
    static void shutdown() {
        if (app != null) app.close();
    }

    private JsonNode post(String path, String body) throws Exception {
        HttpResponse<String> r = HTTP.send(
                HttpRequest.newBuilder()
                        .uri(URI.create("http://127.0.0.1:" + port + path))
                        .header("Content-Type", "application/json")
                        .POST(body == null
                                ? HttpRequest.BodyPublishers.noBody()
                                : HttpRequest.BodyPublishers.ofString(body))
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(200, r.statusCode(), "status for " + path + ": body=" + r.body());
        return M.readTree(r.body());
    }

    @Test
    void healthReportsVersionAndThreshold() throws Exception {
        JsonNode r = post("/fp/health", null);
        assertEquals("0", r.get("ErrorCode").asText());
        assertTrue(r.get("Version").asText().toLowerCase().contains("stub"));
        assertEquals(TEST_THRESHOLD, r.get("Threshold").asDouble(), 0.0001);
    }

    @Test
    void identicalTemplatesPassThreshold() throws Exception {
        // Stub returns score = 100 when probe and gallery bytes are equal,
        // mirroring SourceAFIS's "very high similarity for the same input".
        String tpl = Base64.getEncoder().encodeToString(new byte[]{1, 2, 3, 4});
        JsonNode r = post("/fp/match",
            "{\"ProbeTemplate\":\"" + tpl + "\",\"GalleryTemplate\":\"" + tpl + "\"}");
        assertEquals("0", r.get("ErrorCode").asText());
        assertEquals(100.0, r.get("Score").asDouble(), 0.0001);
        assertTrue(r.get("Status").asBoolean());
    }

    @Test
    void differentTemplatesBelowThreshold() throws Exception {
        // Stub returns score = 1 for unequal inputs — below threshold 40.
        String probe = Base64.getEncoder().encodeToString(new byte[]{1, 2, 3});
        String gallery = Base64.getEncoder().encodeToString(new byte[]{9, 8, 7});
        JsonNode r = post("/fp/match",
            "{\"ProbeTemplate\":\"" + probe + "\",\"GalleryTemplate\":\"" + gallery + "\"}");
        assertEquals("0", r.get("ErrorCode").asText());
        assertEquals(1.0, r.get("Score").asDouble(), 0.0001);
        assertFalse(r.get("Status").asBoolean());
    }

    @Test
    void missingProbeReturnsTypedError() throws Exception {
        String tpl = Base64.getEncoder().encodeToString(new byte[]{1, 2, 3});
        JsonNode r = post("/fp/match",
            "{\"GalleryTemplate\":\"" + tpl + "\"}");
        assertEquals("-4", r.get("ErrorCode").asText());
    }

    @Test
    void unparseableTemplateSurfacesProviderError() throws Exception {
        stub.triggerImportError = true;
        try {
            String tpl = Base64.getEncoder().encodeToString(new byte[]{0});
            JsonNode r = post("/fp/match",
                "{\"ProbeTemplate\":\"" + tpl + "\",\"GalleryTemplate\":\"" + tpl + "\"}");
            assertEquals("-3", r.get("ErrorCode").asText());
        } finally {
            stub.triggerImportError = false;
        }
    }

    /** Tiny stub matcher used to drive the HTTP tests deterministically. */
    static class StubFpProvider implements FpProvider {
        boolean triggerImportError = false;

        @Override
        public String version() { return "stub-fp 0.0.1"; }

        @Override
        public double match(byte[] probe, byte[] gallery) throws FpException {
            if (triggerImportError) {
                throw new FpException("-3", "stub: simulated import error");
            }
            if (probe == null || probe.length == 0 || gallery == null || gallery.length == 0) {
                throw new FpException("-2", "stub: empty template");
            }
            return Arrays.equals(probe, gallery) ? 100.0 : 1.0;
        }
    }
}
