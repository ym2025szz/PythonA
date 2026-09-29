package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.net.URI;

/** Non-secret projection onto the official llm-pi-ai settings schema. */
final class DshCustomConfiguration {
    static final String PROVIDER_ID = "pythona-custom";
    static final String KEY_ENV = "PYTHONA_CUSTOM_API_KEY";
    static JSONObject normalize(JSONObject input) throws Exception {
        String mode = input.optString("runtimeMode", "custom");
        if (!"custom".equals(mode) && !"deepseek".equals(mode)) throw new IOException("Unsupported provider mode");
        String model = input.optString("model", "").trim();
        String name = input.optString("displayName", "").trim();
        String url = input.optString("baseUrl", "").trim();
        if (model.isEmpty() || model.length() > 256 || model.matches("(?s).*\\p{Cntrl}.*"))
            throw new IOException("请输入有效模型 ID");
        if (name.isEmpty()) name = "custom".equals(mode) ? "自定义 OpenAI 兼容" : "DeepSeek";
        if (name.length() > 128) throw new IOException("Provider 名称过长");
        URI endpoint;
        try { endpoint = URI.create(url); } catch (Exception invalid) { throw new IOException("Base URL 格式无效"); }
        if (endpoint.getHost() == null || endpoint.getRawUserInfo() != null || endpoint.getRawQuery() != null || endpoint.getRawFragment() != null)
            throw new IOException("Base URL 必须包含主机，且不能携带账号、查询参数或片段");
        boolean local = "127.0.0.1".equals(endpoint.getHost()) || "localhost".equalsIgnoreCase(endpoint.getHost())
            || "[::1]".equals(endpoint.getHost()) || "::1".equals(endpoint.getHost());
        boolean allowLocal = input.optBoolean("allowLocalEndpoint", false);
        if (!"https".equalsIgnoreCase(endpoint.getScheme())
            && !("http".equalsIgnoreCase(endpoint.getScheme()) && local && allowLocal))
            throw new IOException("请使用 HTTPS；本机 HTTP 需勾选允许本地回环端点");
        if (local && !allowLocal) throw new IOException("本机端点需要勾选允许本地回环端点");
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        if (url.endsWith("/chat/completions")) throw new IOException("Base URL 请填写到 /v1，不要包含 /chat/completions");
        return new JSONObject().put("profileId", "direct-dsh").put("providerKind", "openai-compatible")
            .put("runtimeMode", mode).put("displayName", name).put("baseUrl", url)
            .put("model", model).put("enabled", true).put("allowLocalEndpoint", allowLocal);
    }
    static JSONObject settings(JSONObject profile) throws Exception {
        JSONObject section = new JSONObject();
        if (!"custom".equals(profile.optString("runtimeMode", "deepseek"))) return section;
        JSONObject model = new JSONObject().put("id", profile.getString("model")).put("name", profile.getString("model"))
            .put("contextWindow", 128000).put("maxTokens", 4096).put("input", new JSONArray().put("text"))
            .put("reasoningEfforts", false);
        return new JSONObject().put("displayName", profile.getString("displayName"))
            .put("api", "openai-completions").put("baseURL", profile.getString("baseUrl"))
            .put("apiKeyEnv", KEY_ENV).put("models", new JSONArray().put(model))
            .put("streamIdleTimeoutMs", 120000);
    }
}
