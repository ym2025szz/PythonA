package com.pythona.app;

import org.json.JSONObject;

/** Negotiate the optional extension once per connected official process generation. */
final class DshInlineCapability {
    interface Probe { JSONObject query() throws Exception; }
    private long cachedGeneration = Long.MIN_VALUE;
    private JSONObject cached;

    synchronized JSONObject resolve(long generation, boolean connected, Probe probe) throws Exception {
        return resolve(generation, connected, false, probe);
    }
    synchronized JSONObject resolve(long generation, boolean connected, boolean compatibilityAvailable, Probe probe) throws Exception {
        JSONObject result = official(generation, connected, probe);
        boolean officialAvailable = result.optBoolean("available", false);
        result.put("officialAvailable", officialAvailable).put("compatibilityAvailable", compatibilityAvailable)
            .put("available", officialAvailable || compatibilityAvailable);
        if (!officialAvailable && result.has("reason")) {
            result.put("officialReason", result.get("reason"));
            if (compatibilityAvailable) result.remove("reason");
        }
        return result;
    }
    private JSONObject official(long generation, boolean connected, Probe probe) throws Exception {
        if (!connected) return unavailable("runtime-not-ready");
        if (cached != null && cachedGeneration == generation) return new JSONObject(cached.toString());
        JSONObject result;
        try {
            JSONObject reported = probe.query();
            boolean available = reported != null && reported.opt("version") instanceof Number
                && ((Number) reported.opt("version")).doubleValue() == 1d
                && Boolean.TRUE.equals(reported.opt("available"))
                && "llm-only".equals(reported.optString("execution", ""))
                && Boolean.FALSE.equals(reported.opt("tools")) && Boolean.FALSE.equals(reported.opt("sessions"));
            result = available ? new JSONObject().put("version", 1).put("available", true)
                .put("execution", "llm-only").put("tools", false).put("sessions", false)
                : unavailable("extension-unavailable");
        } catch (Exception failure) { result = unavailable("extension-unavailable"); }
        cachedGeneration = generation; cached = new JSONObject(result.toString());
        return result;
    }
    private static JSONObject unavailable(String reason) throws Exception {
        return new JSONObject().put("version", 1).put("available", false).put("reason", reason)
            .put("execution", "llm-only").put("tools", false).put("sessions", false);
    }
}
