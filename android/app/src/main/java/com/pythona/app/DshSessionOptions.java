package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;

/** Applies ACP selections using the options advertised by that exact session. */
final class DshSessionOptions {
    interface Caller {
        JSONObject call(String method, JSONObject params) throws Exception;
    }

    static JSONObject apply(JSONObject created, String provider, String model,
                            String reasoning, Caller caller) throws Exception {
        String sessionId = created.optString("sessionId", "");
        if (sessionId.isEmpty()) throw new IllegalArgumentException("Official dsh returned no session id");
        JSONObject state = new JSONObject(created.toString());
        if (model != null && !model.isEmpty()) {
            JSONObject modelOption = option(state, "model");
            String value = modelValue(modelOption, provider, model);
            if (value == null) throw new IllegalArgumentException("dsh-model-unavailable: " + provider + "/" + model);
            if (!value.equals(modelOption.optString("currentValue", ""))) {
                state = set(caller, sessionId, "model", value);
            }
        }

        if (reasoning != null && !reasoning.isEmpty()) {
            // Model changes replace dependent options. Never reuse the old model's
            // reasoning choices, or invent an "off" choice for a non-reasoning model.
            JSONObject reasoningOption = option(state, "reasoning_effort");
            if (reasoningOption == null && "off".equals(reasoning)) return state;
            if (reasoningOption == null || !containsValue(reasoningOption.optJSONArray("options"), reasoning)) {
                throw new IllegalArgumentException("dsh-reasoning-unsupported: " + reasoning);
            }
            if (!reasoning.equals(reasoningOption.optString("currentValue", ""))) {
                state = set(caller, sessionId, "reasoning_effort", reasoning);
            }
        }
        return state;
    }

    private static JSONObject set(Caller caller, String sessionId, String id, String value) throws Exception {
        JSONObject result = caller.call("session/set_config_option", new JSONObject()
            .put("sessionId", sessionId).put("configId", id).put("value", value));
        if (result == null || result.optJSONArray("configOptions") == null) {
            throw new IllegalStateException("Official dsh returned no updated session config options");
        }
        return new JSONObject(result.toString()).put("sessionId", sessionId);
    }

    private static JSONObject option(JSONObject state, String id) {
        JSONArray options = state.optJSONArray("configOptions");
        if (options == null) return null;
        for (int i = 0; i < options.length(); i++) {
            JSONObject item = options.optJSONObject(i);
            if (item != null && id.equals(item.optString("id")) && "select".equals(item.optString("type"))) return item;
        }
        return null;
    }

    private static String modelValue(JSONObject option, String provider, String model) {
        if (option == null) return null;
        JSONArray choices = option.optJSONArray("options");
        if (choices == null) return null;
        for (int i = 0; i < choices.length(); i++) {
            JSONObject choice = choices.optJSONObject(i);
            if (choice == null) continue;
            JSONArray group = choice.optJSONArray("options");
            if (group == null) {
                String value = matchingRoute(choice, provider, model);
                if (value != null) return value;
            } else {
                for (int j = 0; j < group.length(); j++) {
                    String value = matchingRoute(group.optJSONObject(j), provider, model);
                    if (value != null) return value;
                }
            }
        }
        return null;
    }

    private static String matchingRoute(JSONObject choice, String provider, String model) {
        if (choice == null || !choice.has("value")) return null;
        String value = choice.optString("value", "");
        try {
            JSONArray route = new JSONArray(value);
            if (route.length() == 2 && provider != null && provider.equals(route.getString(0))
                && model.equals(route.getString(1))) return value;
        } catch (Exception malformed) { /* A malformed catalog entry is not selectable. */ }
        return null;
    }

    private static boolean containsValue(JSONArray choices, String value) {
        if (choices == null) return false;
        for (int i = 0; i < choices.length(); i++) {
            JSONObject choice = choices.optJSONObject(i);
            if (choice == null) continue;
            if (value.equals(choice.optString("value", null))) return true;
            JSONArray group = choice.optJSONArray("options");
            if (group == null) continue;
            for (int j = 0; j < group.length(); j++) {
                JSONObject nested = group.optJSONObject(j);
                if (nested != null && value.equals(nested.optString("value", null))) return true;
            }
        }
        return false;
    }
}
