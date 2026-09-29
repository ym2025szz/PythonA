package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;

/** Allowlisted, bounded presentation facts from the official ACP wire. */
final class DshAcpUpdates {
    private DshAcpUpdates() { }

    static JSONObject normalize(JSONObject update) throws Exception {
        String type = update.optString("sessionUpdate", "");
        JSONObject result = new JSONObject();
        if ("pythona_stream_reset".equals(type)) {
            String reason = update.optString("reason", "");
            if (!"retry".equals(reason) && !"reconcile".equals(reason)) return null;
            return result.put("kind", "stream_reset")
                .put("messageId", safe(update.optString("messageId", ""), 256)).put("reason", reason);
        }
        if ("agent_message_chunk".equals(type) || "agent_thought_chunk".equals(type)) {
            JSONObject content = update.optJSONObject("content");
            if (content != null && !"text".equals(content.optString("type", "text"))) return null;
            String text = content == null ? update.optString("text", "") : content.optString("text", "");
            String bounded = McpWorkspacePolicy.truncate(text, 64 * 1024);
            result.put("kind", "agent_message_chunk".equals(type) ? "delta" : "thought").put("text", bounded);
            if (!text.equals(bounded)) result.put("truncated", true);
            if (update.has("messageId")) result.put("messageId", safe(update.optString("messageId"), 256));
            JSONObject meta = update.optJSONObject("_meta");
            Long blockIndex = meta == null ? null : count(meta, "pythonaBlockIndex");
            if (blockIndex != null && blockIndex <= Integer.MAX_VALUE) result.put("blockIndex", blockIndex);
            return result;
        }
        if ("tool_call".equals(type) || "tool_call_update".equals(type)) {
            result = tool(update);
            result.put("kind", "scope");
            result.put("text", result.optString("title", "DSH 工具")
                + (result.has("status") ? " · " + result.getString("status") : ""));
            return result;
        }
        if ("usage_update".equals(type)) {
            Long used = count(update, "used");
            Long size = count(update, "size");
            if (used == null || size == null || size == 0) return null;
            return result.put("kind", "usage").put("usage", new JSONObject()
                .put("used", used).put("size", size).put("source", "official-acp")
                .put("measurement", "context"));
        }
        return null;
    }

    static JSONObject tool(JSONObject input) throws Exception {
        JSONObject result = new JSONObject();
        if (input == null) return result;
        result.put("callId", safe(input.optString("toolCallId", ""), 256));
        if (input.has("title")) result.put("title", safe(input.optString("title"), 512));
        String status = input.optString("status", "");
        if ("pending".equals(status) || "in_progress".equals(status)
            || "completed".equals(status) || "failed".equals(status)) result.put("status", status);
        String kind = input.optString("kind", "");
        if (kind.matches("read|edit|delete|move|search|execute|think|fetch|switch_mode|other")) result.put("toolKind", kind);
        JSONArray inputLocations = input.optJSONArray("locations");
        if (inputLocations != null) {
            JSONArray locations = new JSONArray();
            for (int i = 0; i < Math.min(inputLocations.length(), 32); i++) {
                JSONObject location = inputLocations.optJSONObject(i);
                if (location == null) continue;
                String path = location.optString("path", "");
                if (path.length() > 1024 || path.contains(":")) continue;
                try { path = WorkspaceRepository.normalizeRelativePath(path); }
                catch (Exception invalid) { continue; }
                JSONObject row = new JSONObject().put("path", safe(path, 1024));
                Long line = count(location, "line");
                // ACP v1 does not specify the line base. Only explicit metadata
                // permits an exact jump; unknown bases still expose the file.
                JSONObject meta = location.optJSONObject("_meta");
                int base = meta == null ? -1 : meta.optInt("pythonaLineBase", -1);
                if (line != null && line < Integer.MAX_VALUE && (base == 0 || base == 1)
                    && (base == 0 || line > 0)) row.put("line", base == 0 ? line + 1 : line);
                locations.put(row);
            }
            result.put("locations", locations);
        }
        return result;
    }

    static JSONArray permissionOptions(JSONArray input) throws Exception {
        JSONArray result = new JSONArray();
        if (input == null) return result;
        for (int i = 0; i < Math.min(input.length(), 8); i++) {
            JSONObject row = input.optJSONObject(i);
            if (row == null) continue;
            String kind = row.optString("kind", "");
            if (!kind.matches("allow_once|allow_always|reject_once|reject_always")) continue;
            result.put(new JSONObject().put("optionId", safe(row.optString("optionId"), 128))
                .put("name", safe(row.optString("name"), 256)).put("kind", kind));
        }
        return result;
    }

    private static Long count(JSONObject input, String key) {
        Object value = input.opt(key);
        if (!(value instanceof Number)) return null;
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > 9_007_199_254_740_991d
            || Math.floor(number) != number) return null;
        return (long) number;
    }

    private static String safe(String text, int bytes) {
        return McpWorkspacePolicy.truncate(McpWorkspacePolicy.redact(text), bytes);
    }
}
