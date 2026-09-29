package com.pythona.app;

import org.json.JSONException;
import org.json.JSONObject;

/** Helpers for the versioned JSON protocol shared by WebView and host services. */
final class BridgeProtocol {
    static final int VERSION = 2;

    private BridgeProtocol() {
    }

    static JSONObject success(JSONObject request, Object payload) throws JSONException {
        return base(request)
            .put("ok", true)
            .put("payload", payload == null ? JSONObject.NULL : payload);
    }

    static JSONObject event(String channel, JSONObject event) {
        try {
            JSONObject normalized = event == null ? new JSONObject() : new JSONObject(event.toString());
            if (!normalized.has("requestId")) normalized.put("requestId", "");
            if (!normalized.has("streamId")) normalized.put("streamId", "");
            if (!normalized.has("sessionId")) normalized.put("sessionId", safe(channel, "native") + "-session");
            if (!normalized.has("epoch")) normalized.put("epoch", 0);
            if (!normalized.has("workspaceId")) normalized.put("workspaceId", "default");
            if (!normalized.has("uri")) normalized.put("uri", "");
            if (!normalized.has("bufferVersion")) normalized.put("bufferVersion", 0);
            return new JSONObject()
                .put("protocolVersion", VERSION)
                .put("type", "event")
                .put("channel", safe(channel, "native"))
                .put("event", normalized);
        } catch (JSONException impossible) {
            return new JSONObject();
        }
    }

    static JSONObject error(JSONObject request, String code, String message) {
        return error(request, code, message, null);
    }

    static JSONObject error(
        JSONObject request,
        String code,
        String message,
        JSONObject details
    ) {
        try {
            JSONObject error = new JSONObject()
                .put("code", safe(code, "native-error"))
                .put("message", safe(message, "Native request failed"));
            if (details != null) error.put("details", details);
            return base(request).put("ok", false).put("error", error);
        } catch (JSONException impossible) {
            return new JSONObject();
        }
    }

    static JSONObject parseRequest(String requestJson) throws JSONException {
        JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
        if (request.optInt("protocolVersion", -1) != VERSION) {
            throw new JSONException("Unsupported protocolVersion");
        }
        if (request.optString("id", "").trim().isEmpty()) {
            throw new JSONException("Request id is required");
        }
        if (request.optString("channel", "").trim().isEmpty()) {
            throw new JSONException("Request channel is required");
        }
        if (request.optString("method", "").trim().isEmpty()) {
            throw new JSONException("Request method is required");
        }
        return request;
    }

    private static JSONObject base(JSONObject request) throws JSONException {
        JSONObject response = new JSONObject().put("protocolVersion", VERSION);
        if (request != null) {
            response.put("id", request.optString("id", ""));
            response.put("channel", request.optString("channel", ""));
            response.put("method", request.optString("method", ""));
            JSONObject payload = request.optJSONObject("payload");
            response.put("requestId", payload == null
                ? request.optString("id", "") : payload.optString("requestId", request.optString("id", "")));
            response.put("streamId", payload == null ? "" : payload.optString("streamId", ""));
            response.put("sessionId", payload == null ? "" : payload.optString("sessionId", ""));
            response.put("epoch", payload == null ? 0 : payload.optLong("epoch", 0));
            response.put("workspaceId", payload == null ? "default" : payload.optString("workspaceId", "default"));
            response.put("uri", payload == null ? "" : payload.optString("uri", payload.optString("path", "")));
            response.put("bufferVersion", payload == null
                ? 0 : payload.optLong("bufferVersion", payload.optLong("version", 0)));
            if (payload != null) {
                copyIdentity(payload, response, "requestId", "requestId");
                copyIdentity(payload, response, "streamId", "streamId");
                copyIdentity(payload, response, "sessionId", "sessionId");
                copyIdentity(payload, response, "epoch", "epoch");
                copyIdentity(payload, response, "workspaceId", "workspaceId");
                copyIdentity(payload, response, "uri", "uri");
                if (payload.has("bufferVersion")) {
                    copyIdentity(payload, response, "bufferVersion", "bufferVersion");
                } else {
                    copyIdentity(payload, response, "version", "bufferVersion");
                }
            }
        }
        return response;
    }

    private static void copyIdentity(
        JSONObject source,
        JSONObject target,
        String sourceKey,
        String targetKey
    ) throws JSONException {
        if (source.has(sourceKey) && !source.isNull(sourceKey)) {
            target.put(targetKey, source.get(sourceKey));
        }
    }

    private static String safe(String value, String fallback) {
        if (value == null || value.trim().isEmpty()) return fallback;
        return value;
    }
}
