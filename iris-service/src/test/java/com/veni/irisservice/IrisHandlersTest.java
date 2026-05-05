package com.veni.irisservice;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.veni.irisservice.handler.IrisHandlers;
import com.veni.irisservice.provider.MockIrisProvider;
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
 * End-to-end verification that the HTTP layer + MockIrisProvider together
 * produce envelopes the frontend expects. This catches Jackson field-name
 * drift, status-code regressions, and routing typos.
 *
 * The real SDK path (MarvisIrisProvider) needs Linux + the JAR + a USB
 * iris device, so it is out of scope for unit tests; a separate
 * integration test on the operator-laptop image will cover it.
 */
class IrisHandlersTest {

    private static Javalin app;
    private static int port;
    private static final ObjectMapper M = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    @BeforeAll
    static void boot() {
        app = Javalin.create(cfg -> cfg.showJavalinBanner = false).start("127.0.0.1", 0);
        new IrisHandlers(new MockIrisProvider()).register(app);
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
    void supportedDeviceListIncludesMIS100V2() throws Exception {
        JsonNode env = post("/iris/supporteddevicelist", null);
        assertEquals("0", env.get("ErrorCode").asText());
        assertTrue(env.get("ErrorDescription").asText().contains("MIS100V2"));
    }

    @Test
    void connectedDeviceListContainsFoundDevicesPrefix() throws Exception {
        JsonNode env = post("/iris/connecteddevicelist", null);
        assertEquals("0", env.get("ErrorCode").asText());
        assertTrue(env.get("ErrorDescription").asText().startsWith("Found Devices:"));
    }

    @Test
    void infoReturnsDeviceFields() throws Exception {
        JsonNode env = post("/iris/info", "{\"ConnectedDvc\":\"MIS100V2\"}");
        assertEquals("0", env.get("ErrorCode").asText());
        JsonNode d = env.get("DeviceInfo");
        assertNotNull(d);
        assertNotNull(d.get("SerialNo"));
        assertEquals("MIS100V2", d.get("Model").asText());
    }

    @Test
    void captureReturnsBothEyes() throws Exception {
        JsonNode env = post("/iris/capture", "{\"MinQuality\":50,\"UpperQuality\":95,\"TimeOut\":10000}");
        assertEquals("0", env.get("ErrorCode").asText());
        for (String eye : new String[]{"Left", "Right"}) {
            JsonNode e = env.get(eye);
            assertNotNull(e, eye + " missing");
            assertTrue(e.get("Quality").asInt() > 0, eye + ".Quality");
            assertNotNull(e.get("BitmapB64"));
        }
    }

    @Test
    void matchHappyPath() throws Exception {
        String b64 = Base64.getEncoder().encodeToString("payload".getBytes());
        String body = "{\"ProbLeft\":\"" + b64 + "\",\"GalleryLeft\":\"" + b64 +
                      "\",\"ProbRight\":\"" + b64 + "\",\"GalleryRight\":\"" + b64 +
                      "\",\"Format\":\"K7\"}";
        JsonNode env = post("/iris/match", body);
        assertEquals("0", env.get("ErrorCode").asText());
        assertTrue(env.get("Status").asBoolean());
        assertNotNull(env.get("LeftScore"));
        assertNotNull(env.get("RightScore"));
    }

    @Test
    void matchRejectsEmptyTemplates() throws Exception {
        JsonNode env = post("/iris/match", "{}");
        assertEquals("-1", env.get("ErrorCode").asText());
    }

    @Test
    void identicalTemplatesProduceHigherScores() throws Exception {
        // Mock: same bytes yield 0.95, different yield 0.78.
        String same = Base64.getEncoder().encodeToString("AAAA".getBytes());
        String diff = Base64.getEncoder().encodeToString("BBBB".getBytes());

        JsonNode highEnv = post("/iris/match",
            "{\"ProbLeft\":\"" + same + "\",\"GalleryLeft\":\"" + same + "\",\"Format\":\"K7\"}");
        JsonNode lowEnv = post("/iris/match",
            "{\"ProbLeft\":\"" + same + "\",\"GalleryLeft\":\"" + diff + "\",\"Format\":\"K7\"}");

        double high = highEnv.get("LeftScore").asDouble();
        double low  = lowEnv.get("LeftScore").asDouble();
        assertTrue(high > low, "high=" + high + " should be > low=" + low);
    }
}
