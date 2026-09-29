package com.pythona.app;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

/** Custom OpenAI-compatible settings stay in the official dsh schema and reject unsafe endpoints. */
public final class DshCustomConfigurationTest {
    private static JSONObject input(String url) throws Exception {
        return new JSONObject().put("displayName", "My Gateway").put("baseUrl", url)
            .put("model", "gpt-custom").put("runtimeMode", "custom");
    }
    @Test public void emitsOfficialPiAiRouteWithoutSecret() throws Exception {
        JSONObject profile = DshCustomConfiguration.normalize(input("https://gateway.example/v1"));
        JSONObject settings = DshCustomConfiguration.settings(profile);
        assertEquals("openai-completions", settings.getString("api"));
        assertEquals("PYTHONA_CUSTOM_API_KEY", settings.getString("apiKeyEnv"));
        assertEquals("gpt-custom", settings.getJSONArray("models").getJSONObject(0).getString("id"));
        assertFalse(settings.toString().contains("secret"));
    }
    @Test public void rejectsQueryAndPlainHttpEndpoints() throws Exception {
        assertThrows(Exception.class, () -> DshCustomConfiguration.normalize(input("http://gateway.example/v1")));
        assertThrows(Exception.class, () -> DshCustomConfiguration.normalize(input("https://gateway.example/v1?key=bad")));
    }
    @Test public void allowsExplicitLoopbackHttpOnly() throws Exception {
        JSONObject profile = DshCustomConfiguration.normalize(input("http://127.0.0.1:8080/v1").put("allowLocalEndpoint", true));
        assertEquals("http://127.0.0.1:8080/v1", profile.getString("baseUrl"));
    }
    @Test public void stripsTrailingSlashAndRejectsChatCompletionsPath() throws Exception {
        assertEquals("https://gateway.example/v1", DshCustomConfiguration.normalize(input("https://gateway.example/v1///")).getString("baseUrl"));
        assertThrows(Exception.class, () -> DshCustomConfiguration.normalize(input("https://gateway.example/v1/chat/completions")));
    }
}
