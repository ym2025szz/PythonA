package com.pythona.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public final class DshHttpClientTest {
    private static List<JSONObject> accept(String kind, JSONObject... chunks) throws Exception {
        DshHttpClient.StreamNormalizer normalizer = new DshHttpClient.StreamNormalizer(kind);
        ArrayList<JSONObject> events = new ArrayList<>();
        for (JSONObject chunk : chunks) events.addAll(normalizer.accept(chunk));
        events.addAll(normalizer.finish());
        return events;
    }

    @Test
    public void normalizesOpenAiCompatibleAndQwenChatFixtures() throws Exception {
        JSONObject first = new JSONObject().put("choices", new JSONArray().put(
            new JSONObject().put("delta", new JSONObject().put("content", "你🙂"))));
        JSONObject tool = new JSONObject().put("choices", new JSONArray().put(
            new JSONObject().put("delta", new JSONObject().put("tool_calls", new JSONArray().put(
                new JSONObject().put("index", 0).put("id", "call-1")
                    .put("function", new JSONObject().put("name", "read_file").put("arguments", "{\"path\":")))))));
        JSONObject toolEndDelta = new JSONObject()
            .put("tool_calls", new JSONArray().put(
                new JSONObject().put("index", 0).put("function",
                    new JSONObject().put("arguments", "\"a.py\"}"))));
        JSONObject toolEnd = new JSONObject().put("choices", new JSONArray().put(
            new JSONObject().put("delta", toolEndDelta)
                .put("finish_reason", "tool_calls")));
        for (String kind : List.of(DshProviderRegistry.OPENAI_COMPATIBLE, DshProviderRegistry.QWEN)) {
            List<JSONObject> events = accept(kind, first, tool, toolEnd);
            assertEquals("delta", events.get(0).getString("kind"));
            assertEquals("你🙂", events.get(0).getString("text"));
            assertTrue(events.stream().anyMatch(item -> "tool_call".equals(item.optString("kind"))
                && "read_file".equals(item.optString("name"))));
            assertEquals("done", events.get(events.size() - 1).getString("kind"));
        }
    }

    @Test
    public void normalizesOpenAiResponsesAnthropicAndGeminiFixtures() throws Exception {
        List<JSONObject> openAi = accept(DshProviderRegistry.OPENAI,
            new JSONObject().put("type", "response.output_text.delta").put("delta", "Hi"),
            new JSONObject().put("type", "response.completed")
                .put("response", new JSONObject().put("usage", new JSONObject().put("output_tokens", 2))));
        assertEquals("Hi", openAi.get(0).getString("text"));
        assertTrue(openAi.stream().anyMatch(item -> "usage".equals(item.optString("kind"))));

        List<JSONObject> anthropic = accept(DshProviderRegistry.ANTHROPIC,
            new JSONObject().put("type", "content_block_delta").put("index", 0)
                .put("delta", new JSONObject().put("type", "text_delta").put("text", "安")),
            new JSONObject().put("type", "message_stop"));
        assertEquals("安", anthropic.get(0).getString("text"));

        List<JSONObject> gemini = accept(DshProviderRegistry.GEMINI,
            new JSONObject().put("candidates", new JSONArray().put(new JSONObject()
                .put("content", new JSONObject().put("parts", new JSONArray().put(
                    new JSONObject().put("text", "全")))))));
        assertEquals("全", gemini.get(0).getString("text"));
        assertEquals("done", gemini.get(gemini.size() - 1).getString("kind"));
    }

    @Test
    public void endpointPolicyRequiresHttpsExceptExplicitLoopback() throws Exception {
        JSONObject publicHttp = new JSONObject().put("providerKind", DshProviderRegistry.OPENAI_COMPATIBLE)
            .put("baseUrl", "http://example.com/v1").put("model", "fixture");
        assertThrows(IllegalArgumentException.class, () -> DshHttpClient.endpoint(publicHttp));
        JSONObject loopback = new JSONObject().put("providerKind", DshProviderRegistry.OPENAI_COMPATIBLE)
            .put("baseUrl", "http://127.0.0.1:8080/v1").put("model", "fixture")
            .put("allowLocalEndpoint", true);
        URL endpoint = DshHttpClient.endpoint(loopback);
        assertEquals("127.0.0.1", endpoint.getHost());

        JSONObject gemini = new JSONObject().put("providerKind", DshProviderRegistry.GEMINI)
            .put("baseUrl", "https://generativelanguage.googleapis.com/v1beta")
            .put("model", "gemini-fixture");
        assertEquals("alt=sse", DshHttpClient.endpoint(gemini).getQuery());
        JSONObject queryInBase = new JSONObject().put("providerKind", DshProviderRegistry.GEMINI)
            .put("baseUrl", "https://generativelanguage.googleapis.com/v1beta?tenant=secret")
            .put("model", "gemini-fixture");
        assertThrows(IllegalArgumentException.class, () -> DshHttpClient.endpoint(queryInBase));
    }
}
