package com.pythona.app;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read only the configuration options actually advertised by the ACP session. */
final class DshModelCatalog {
    static JSONObject normalize(JSONObject source, boolean keyConfigured) throws Exception {
        JSONArray providers = new JSONArray(), levels = new JSONArray();
        JSONObject selected = new JSONObject();
        JSONArray options = source.optJSONArray("configOptions");
        if (options == null) options = new JSONArray();
        for (int i = 0; i < options.length(); i++) {
            JSONObject option = options.getJSONObject(i);
            if ("reasoning_effort".equals(option.optString("id"))) {
                selected.put("reasoningLevel", option.optString("currentValue", "off"));
                JSONArray values = option.optJSONArray("options");
                if (values != null) for (int j = 0; j < values.length(); j++)
                    levels.put(values.getJSONObject(j).getString("value"));
            }
            if (!"model".equals(option.optString("id"))) continue;
            try {
                JSONArray current = new JSONArray(option.optString("currentValue"));
                selected.put("providerId", current.getString(0)).put("model", current.getString(1));
            } catch (Exception ignored) { }
            JSONArray groups = option.optJSONArray("options");
            if (groups == null) continue;
            for (int j = 0; j < Math.min(64, groups.length()); j++) {
                JSONObject group = groups.optJSONObject(j);
                if (group == null || !group.has("group")) continue;
                JSONArray models = new JSONArray(), values = group.optJSONArray("options");
                if (values != null) for (int k = 0; k < Math.min(256, values.length()); k++) {
                    JSONObject value = values.getJSONObject(k);
                    JSONArray route = new JSONArray(value.getString("value"));
                    models.put(new JSONObject().put("id", route.getString(1))
                        .put("name", value.optString("name", route.getString(1)))
                        .put("description", value.optString("description"))
                        .put("value", value.getString("value")));
                }
                providers.put(new JSONObject().put("id", group.getString("group"))
                    .put("name", group.optString("name", group.getString("group")))
                    .put("models", models).put("keyConfigured", keyConfigured));
            }
        }
        for (int i = 0; i < providers.length(); i++) {
            JSONObject provider = providers.getJSONObject(i);
            provider.put("capabilities", new JSONObject().put("reasoningLevels", levels));
            JSONArray models = provider.getJSONArray("models");
            for (int j = 0; j < models.length(); j++) models.getJSONObject(j).put("reasoningLevels", levels);
        }
        return new JSONObject().put("source", "official-dsh").put("official", true).put("connected", true)
            .put("protocol", "acp").put("providers", providers).put("selected", selected)
            .put("keyConfigured", keyConfigured);
    }
}
