package com.veni.luxandservice;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.veni.luxandservice.handler.FaceHandlers;
import io.javalin.Javalin;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Verifies the HTTP layer routes / envelope shapes / score wiring against
 * the {@link StubFaceProvider}. Real {@link com.veni.luxandservice.provider.LuxandFaceProvider}
 * coverage requires libfsdk.so + a license key and is exercised separately
 * during the EC2 deploy smoke test.
 */
class FaceHandlersTest {

    private static Javalin app;
    private static int port;
    private static StubFaceProvider stub;
    private static final ObjectMapper M = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newHttpClient();
    private static final float TEST_THRESHOLD = 0.7f;

    @BeforeAll
    static void boot() throws Exception {
        stub = new StubFaceProvider();
        stub.activate("test-key");
        stub.initialize();
        app = Javalin.create(cfg -> cfg.showJavalinBanner = false).start("127.0.0.1", 0);
        new FaceHandlers(stub, TEST_THRESHOLD).register(app);
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
    void healthReportsActivatedAndThreshold() throws Exception {
        JsonNode r = post("/face/health", null);
        assertEquals("0", r.get("ErrorCode").asText());
        assertTrue(r.get("Activated").asBoolean());
        assertEquals(TEST_THRESHOLD, (float) r.get("Threshold").asDouble(), 0.0001f);
    }

    @Test
    void extractReturnsTemplate() throws Exception {
        String img = Base64.getEncoder().encodeToString("fake-jpeg-bytes".getBytes());
        JsonNode r = post("/face/extract",
            "{\"Image\":\"" + img + "\",\"Mime\":\"image/jpeg\"}");
        assertEquals("0", r.get("ErrorCode").asText());
        assertTrue(r.get("FaceFound").asBoolean());
        byte[] tpl = Base64.getDecoder().decode(r.get("Template").asText());
        assertEquals(1040, tpl.length);
    }

    @Test
    void extractSurfacesNoFaceCleanly() throws Exception {
        stub.triggerNoFace = true;
        try {
            String img = Base64.getEncoder().encodeToString("nofaces".getBytes());
            JsonNode r = post("/face/extract",
                "{\"Image\":\"" + img + "\",\"Mime\":\"image/jpeg\"}");
            assertEquals("0", r.get("ErrorCode").asText());
            assertFalse(r.get("FaceFound").asBoolean());
            assertNull(r.get("Template"));
        } finally {
            stub.triggerNoFace = false;
        }
    }

    @Test
    void identicalTemplatesMatch() throws Exception {
        // Pre-extract a template, then match it with itself.
        String img = Base64.getEncoder().encodeToString("alice".getBytes());
        JsonNode ext = post("/face/extract",
            "{\"Image\":\"" + img + "\",\"Mime\":\"image/jpeg\"}");
        String tpl = ext.get("Template").asText();

        JsonNode m = post("/face/match",
            "{\"ProbeTemplate\":\"" + tpl + "\",\"GalleryTemplate\":\"" + tpl + "\"}");
        assertEquals("0", m.get("ErrorCode").asText());
        assertEquals(1.0f, (float) m.get("Score").asDouble(), 0.0001f);
        assertTrue(m.get("Status").asBoolean());
    }

    @Test
    void differentTemplatesDontMatchAtThreshold() throws Exception {
        String aliceImg = Base64.getEncoder().encodeToString("alice".getBytes());
        String bobImg   = Base64.getEncoder().encodeToString("bob".getBytes());
        String alice = post("/face/extract",
            "{\"Image\":\"" + aliceImg + "\",\"Mime\":\"image/jpeg\"}").get("Template").asText();
        String bob = post("/face/extract",
            "{\"Image\":\"" + bobImg + "\",\"Mime\":\"image/jpeg\"}").get("Template").asText();

        JsonNode m = post("/face/match",
            "{\"ProbeTemplate\":\"" + alice + "\",\"GalleryTemplate\":\"" + bob + "\"}");
        assertEquals("0", m.get("ErrorCode").asText());
        assertEquals(0.5f, (float) m.get("Score").asDouble(), 0.0001f);
        // 0.5 < threshold 0.7 → does not pass.
        assertFalse(m.get("Status").asBoolean());
    }

    @Test
    void matchImageHandlesNoFaceCleanly() throws Exception {
        stub.triggerNoFace = true;
        try {
            String img = Base64.getEncoder().encodeToString("blurry".getBytes());
            String tpl = Base64.getEncoder().encodeToString(new byte[1040]);
            JsonNode r = post("/face/match-image",
                "{\"ProbeImage\":\"" + img + "\",\"ProbeMime\":\"image/jpeg\","
                + "\"GalleryTemplate\":\"" + tpl + "\"}");
            assertEquals("0", r.get("ErrorCode").asText());
            assertFalse(r.get("FaceFound").asBoolean());
            assertFalse(r.get("Status").asBoolean());
        } finally {
            stub.triggerNoFace = false;
        }
    }

    @Test
    void matchRejectsBadTemplateLength() throws Exception {
        String tooShort = Base64.getEncoder().encodeToString(new byte[100]);
        JsonNode r = post("/face/match",
            "{\"ProbeTemplate\":\"" + tooShort + "\",\"GalleryTemplate\":\"" + tooShort + "\"}");
        assertEquals("-25", r.get("ErrorCode").asText());
    }
}
