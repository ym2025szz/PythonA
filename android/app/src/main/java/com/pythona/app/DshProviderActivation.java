package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

/** ACP handshake can finish before the optional settings consumers register. */
final class DshProviderActivation {
    interface Catalog { JSONObject load() throws Exception; }
    static boolean contains(JSONObject catalog, String providerId, String modelId) {
        JSONArray providers = catalog.optJSONArray("providers");
        if (providers == null) return false;
        for (int i = 0; i < providers.length(); i++) {
            JSONObject provider = providers.optJSONObject(i);
            if (provider == null || !providerId.equals(provider.optString("id", provider.optString("providerId")))) continue;
            JSONArray models = provider.optJSONArray("models");
            if (models == null) continue;
            for (int j = 0; j < models.length(); j++) {
                JSONObject model = models.optJSONObject(j);
                if (model != null && modelId.equals(model.optString("id"))) return true;
            }
        }
        return false;
    }
    static JSONObject await(Catalog loader, String providerId, String modelId, long timeoutMillis, long pollMillis) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        do {
            JSONObject result = loader.load();
            if (contains(result, providerId, modelId)) return result;
            if (System.nanoTime() >= deadline) break;
            Thread.sleep(Math.max(1, pollMillis));
        } while (!Thread.currentThread().isInterrupted());
        throw new IOException("Provider 配置已保存，但官方 dsh 尚未载入此模型；请重试刷新目录");
    }
}
