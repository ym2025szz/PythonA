package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/** One process generation. Nothing in a retired connection can settle a new one. */
final class AcpConnection {
    interface Writer { void write(JSONObject value) throws Exception; }
    private final Writer writer;
    private final Consumer<JSONObject> events;
    private final AtomicLong sequence = new AtomicLong();
    private final Map<String, CompletableFuture<JSONObject>> requests = new HashMap<>();
    private final Map<String, String> prompts = new HashMap<>();
    private final Map<String, JSONObject> permissions = new HashMap<>();
    private final Set<String> cancelling = new HashSet<>();
    private boolean closed;

    AcpConnection(Writer writer, Consumer<JSONObject> events) {
        this.writer = writer; this.events = events;
    }

    JSONObject call(String method, JSONObject params, long timeout) throws Exception {
        String id = "pya-" + sequence.incrementAndGet();
        CompletableFuture<JSONObject> future = new CompletableFuture<>();
        synchronized (this) { requireOpen(); requests.put(id, future); }
        try {
            writer.write(envelope(id, method, params));
            JSONObject response = future.get(timeout, TimeUnit.MILLISECONDS);
            if (response.has("error")) throw new IOException(errorCode(response.optJSONObject("error")));
            JSONObject result = response.optJSONObject("result");
            return result == null ? new JSONObject() : result;
        } finally { synchronized (this) { requests.remove(id); } }
    }

    synchronized JSONObject prompt(String session, JSONArray content) throws Exception {
        requireOpen();
        if (prompts.containsValue(session)) throw new IOException("session-busy");
        String id = "pya-" + sequence.incrementAndGet();
        prompts.put(id, session);
        try { writer.write(envelope(id, "session/prompt", new JSONObject().put("sessionId", session).put("prompt", content))); }
        catch (Exception error) { prompts.remove(id); throw error; }
        return new JSONObject().put("accepted", true).put("requestId", id).put("sessionId", session);
    }

    synchronized boolean hasPrompt(String session) { return prompts.containsValue(session); }
    synchronized String promptId(String session) {
        for (Map.Entry<String, String> entry : prompts.entrySet()) if (session.equals(entry.getValue())) return entry.getKey();
        return null;
    }
    synchronized boolean hasPrompt(String session, String id) { return id != null && session.equals(prompts.get(id)); }
    synchronized boolean busy() { return !prompts.isEmpty(); }

    synchronized JSONObject cancel(String session) throws Exception {
        requireOpen();
        if (!hasPrompt(session)) return new JSONObject().put("cancelled", false).put("sessionId", session);
        cancelling.add(session);
        // ACP cancel is a notification; waiting for a response adds 120 seconds.
        writer.write(new JSONObject().put("jsonrpc", "2.0").put("method", "session/cancel")
            .put("params", new JSONObject().put("sessionId", session)));
        for (String token : new ArrayList<>(permissions.keySet())) {
            JSONObject params = permissions.get(token).optJSONObject("params");
            if (params != null && session.equals(params.optString("sessionId"))) respondPermission(token, false);
        }
        return new JSONObject().put("cancelled", true).put("sessionId", session);
    }

    synchronized JSONObject respondPermission(String token, boolean allowed) throws Exception {
        requireOpen();
        JSONObject request = permissions.remove(token);
        if (request == null) throw new IOException("permission-stale");
        JSONObject outcome = permissionOutcome(request.optJSONObject("params"), allowed);
        writer.write(new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id"))
            .put("result", new JSONObject().put("outcome", outcome)));
        return new JSONObject().put("accepted", true);
    }

    static JSONObject permissionOutcome(JSONObject params, boolean allowed) throws Exception {
        JSONArray options = params == null ? null : params.optJSONArray("options");
        String kind = allowed ? "allow_once" : "reject_once";
        if (options != null) for (int i = 0; i < options.length(); i++) {
            JSONObject option = options.optJSONObject(i);
            if (option != null && kind.equals(option.optString("kind")) && !option.optString("optionId").isEmpty())
                return new JSONObject().put("outcome", "selected").put("optionId", option.getString("optionId"));
        }
        // A one-time decision must never select allow_always or fabricate an option.
        return new JSONObject().put("outcome", "cancelled");
    }

    synchronized void receive(JSONObject message) throws Exception {
        if (closed) return;
        if (!"2.0".equals(message.optString("jsonrpc"))) throw new IOException("invalid-acp-envelope");
        if (message.has("method")) {
            if (message.has("id")) {
                if (!"session/request_permission".equals(message.optString("method"))) {
                    writer.write(new JSONObject().put("jsonrpc", "2.0").put("id", message.get("id"))
                        .put("error", new JSONObject().put("code", -32601).put("message", "Unsupported client method")));
                    return;
                }
                JSONObject permissionParams = message.optJSONObject("params");
                String permissionSession = permissionParams == null ? "" : permissionParams.optString("sessionId");
                if (!hasPrompt(permissionSession) || cancelling.contains(permissionSession)) {
                    writer.write(new JSONObject().put("jsonrpc", "2.0").put("id", message.get("id"))
                        .put("result", new JSONObject().put("outcome", new JSONObject().put("outcome", "cancelled"))));
                    return;
                }
                for (JSONObject pending : permissions.values())
                    if (pending.get("id").getClass().equals(message.get("id").getClass())
                        && pending.get("id").equals(message.get("id"))) return;
                if (permissions.size() >= 32) throw new IOException("permission-limit");
                String token = UUID.randomUUID().toString();
                permissions.put(token, new JSONObject(message.toString()));
                JSONObject event = new JSONObject(message.toString());
                event.getJSONObject("params").put("approvalId", token);
                events.accept(event);
            } else events.accept(message);
            return;
        }
        // String IDs intentionally never match a numeric id of similar spelling.
        if (!(message.opt("id") instanceof String)) return;
        String id = message.getString("id");
        CompletableFuture<JSONObject> waiting = requests.get(id);
        if (waiting != null) waiting.complete(message);
        String session = prompts.remove(id);
        if (session != null) {
            permissions.entrySet().removeIf(entry -> session.equals(entry.getValue().optJSONObject("params").optString("sessionId")));
            boolean cancelled = cancelling.remove(session);
            JSONObject result = message.optJSONObject("result");
            String code = errorCode(message.optJSONObject("error"));
            emitTerminal(session, message.has("error") && !cancelled, cancelled ? "cancelled"
                : result == null ? "error" : result.optString("stopReason", "end_turn"), code);
        }
    }

    synchronized void close(String reason) {
        if (closed) return;
        closed = true;
        for (CompletableFuture<JSONObject> future : requests.values()) future.completeExceptionally(new IOException(reason));
        requests.clear(); permissions.clear();
        for (String session : new HashSet<>(prompts.values())) {
            boolean cancelled = cancelling.contains(session);
            emitTerminal(session, !cancelled, cancelled ? "cancelled" : reason, reason);
        }
        prompts.clear(); cancelling.clear();
    }

    private void emitTerminal(String session, boolean error, String stopReason, String code) {
        try { events.accept(new JSONObject().put("method", error ? "direct/prompt_error" : "direct/prompt_done")
            .put("params", new JSONObject().put("sessionId", session).put("stopReason", stopReason)
                .put("code", code).put("message", error ? code : ""))); } catch (Exception ignored) { }
    }
    private void requireOpen() throws IOException { if (closed) throw new IOException("service-disconnected"); }
    private static JSONObject envelope(String id, String method, JSONObject params) throws Exception {
        return new JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params);
    }
    static String errorCode(JSONObject error) {
        if (error == null) return "";
        String text = error.toString().toLowerCase(Locale.ROOT);
        if (text.contains("credential") || text.contains("api key")) return "dsh-key-required";
        if (text.contains("401") || text.contains("403") || text.contains("auth")) return "dsh-auth-failed";
        if (text.contains("429") || text.contains("rate_limit")) return "dsh-rate-limited";
        if (text.contains("timeout")) return "dsh-timeout";
        if (text.contains("model")) return "dsh-model-unavailable";
        if (text.contains("network") || text.contains("transport") || text.contains("fetch")
            || text.contains("connection error") || text.contains("getaddrinfo") || text.contains("enotfound")) return "dsh-network-error";
        return "dsh-request-failed";
    }

    static void rejectCredentials(Object value, int depth) throws Exception {
        if (depth > 32) throw new IOException("acp-params-too-deep");
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String lower = key.toLowerCase(Locale.ROOT).replace("_", "").replace("-", "");
                if (lower.contains("apikey") || lower.contains("secret") || lower.contains("password")
                    || lower.contains("credential") || lower.contains("authorization") || lower.contains("bearer")
                    || lower.contains("accesstoken") || lower.contains("refreshtoken") || lower.equals("token"))
                    throw new IOException("credential-field-forbidden");
                rejectCredentials(object.opt(key), depth + 1);
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int i = 0; i < array.length(); i++) rejectCredentials(array.opt(i), depth + 1);
        }
    }

    static String readLine(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int count = 0;
        int b;
        while ((b = input.read()) != -1 && b != '\n') {
            if (++count > maximum) throw new IOException("acp-message-too-large");
            if (b != '\r') bytes.write(b);
        }
        return b == -1 && bytes.size() == 0 ? null : StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString();
    }
}
