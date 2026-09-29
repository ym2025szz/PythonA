package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** PythonA-owned history. ACP probe sessions never enter this registry. */
final class DshConversationStore {
    private static final int MAX_TEXT = 64 * 1024, MAX_TURN = 256 * 1024;
    private final File root;
    private final Map<String, JSONObject> active = new HashMap<>();

    DshConversationStore(File filesDir) throws Exception {
        root = new File(filesDir, "dsh-conversations");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("conversation-storage-unavailable");
        // A new host has no surviving active request or approval authority.
        File[] dirs = root.listFiles(File::isDirectory);
        if (dirs != null) for (File dir : dirs) {
            File metadata = new File(dir, "conversation.json");
            if (!metadata.isFile()) continue;
            JSONObject item;
            try { item = read(metadata); }
            catch (Exception damaged) { continue; } // Keep damaged files for recovery; other conversations remain usable.
            String turnId = item.optString("activeTurnId");
            if (!turnId.isEmpty()) {
                File saved = new File(dir, turnId + ".json");
                if (saved.isFile()) {
                    try {
                    JSONObject turn = read(saved).put("status", "interrupted")
                        .put("message", "dsh 服务重启，本轮已中断；不会自动重发");
                    write(saved, turn);
                    } catch (Exception damaged) { item.put("historyError", "conversation-turn-unreadable"); }
                }
                item.put("status", "interrupted").remove("activeTurnId");
                write(metadata, item);
            }
        }
    }

    synchronized JSONObject create(String workspaceId, String title) throws Exception {
        validate(workspaceId);
        String id = "conversation-" + UUID.randomUUID();
        File dir = directory(id);
        if (!dir.mkdirs()) throw new IOException("conversation-storage-unavailable");
        JSONObject value = new JSONObject().put("id", id).put("workspaceId", workspaceId)
            .put("title", text(title.trim().isEmpty() ? "新对话" : title, 160))
            .put("archived", false).put("status", "idle").put("draft", "")
            .put("createdAt", System.currentTimeMillis()).put("updatedAt", System.currentTimeMillis())
            .put("turnIds", new JSONArray());
        write(metadata(id), value);
        return summary(value);
    }

    synchronized JSONObject list(String workspace, boolean archived, int offset) throws Exception {
        validate(workspace);
        ArrayList<JSONObject> items = new ArrayList<>();
        int unavailable = 0;
        File[] dirs = root.listFiles(File::isDirectory);
        if (dirs != null) for (File dir : dirs) {
            File file = new File(dir, "conversation.json");
            if (!file.isFile()) continue;
            JSONObject item;
            try { item = read(file); }
            catch (Exception damaged) { unavailable++; continue; }
            if (workspace.equals(item.optString("workspaceId")) && archived == item.optBoolean("archived")) items.add(item);
        }
        items.sort(Comparator.comparingLong((JSONObject item) -> item.optLong("updatedAt")).reversed());
        int from = Math.max(0, Math.min(offset, items.size())), end = Math.min(from + 50, items.size());
        JSONArray page = new JSONArray();
        for (int i = from; i < end; i++) page.put(summary(items.get(i)));
        return new JSONObject().put("conversations", page).put("nextOffset", end < items.size() ? end : JSONObject.NULL)
            .put("unavailableCount", unavailable);
    }

    synchronized JSONObject readConversation(String workspace, String id, int before) throws Exception {
        JSONObject item = require(workspace, id);
        JSONArray turnIds = item.getJSONArray("turnIds");
        int total = turnIds.length() * 2;
        int end = before < 0 ? total : Math.min(total, Math.max(0, before));
        int start = Math.max(0, end - 50);
        JSONArray messages = new JSONArray();
        for (int index = start; index < end; index++) {
            String turnId = turnIds.getString(index / 2);
            JSONObject turn = active.get(id);
            if (turn == null || !turnId.equals(turn.optString("turnId"))) turn = read(turnFile(id, turnId));
            boolean user = index % 2 == 0;
            JSONObject message = new JSONObject().put("id", turnId + (user ? "-user" : "-assistant"))
                .put("turnId", turnId).put("role", user ? "user" : "assistant")
                .put("content", turn.optString(user ? "prompt" : "content"))
                .put("createdAt", turn.optLong("createdAt")).put("model", turn.optJSONObject("model"))
                .put("status", turn.optString("status")).put("historyReadOnly", true);
            if (user) message.put("context", turn.optJSONObject("context"));
            else message.put("thought", turn.optString("thought")).put("tools", turn.optJSONArray("tools"))
                .put("usage", turn.optJSONObject("usage")).put("message", turn.optString("message"))
                .put("truncated", turn.optBoolean("truncated"));
            messages.put(message);
        }
        return new JSONObject().put("conversation", summary(item)).put("messages", messages)
            .put("nextBefore", start > 0 ? start : JSONObject.NULL);
    }

    synchronized JSONObject rename(String workspace, String id, String title) throws Exception {
        if (title.trim().isEmpty()) throw new IllegalArgumentException("conversation-title-required");
        JSONObject item = require(workspace, id).put("title", text(title.trim(), 160));
        write(metadata(id), item); return summary(item);
    }
    synchronized JSONObject archive(String workspace, String id, boolean archived) throws Exception {
        JSONObject item = require(workspace, id);
        if (item.has("activeTurnId")) throw new IllegalStateException("conversation-busy");
        item.put("archived", archived); write(metadata(id), item); return summary(item);
    }
    synchronized JSONObject draft(String workspace, String id, String draft) throws Exception {
        JSONObject item = require(workspace, id).put("draft", text(draft, 16 * 1024));
        write(metadata(id), item); return summary(item);
    }

    synchronized JSONObject begin(String workspace, String id, String turnId, JSONObject payload) throws Exception {
        validate(turnId);
        JSONObject item = require(workspace, id);
        if (item.optBoolean("archived")) throw new IllegalStateException("conversation-archived");
        if (item.has("activeTurnId")) throw new IllegalStateException("conversation-busy");
        if (turnFile(id, turnId).exists()) throw new IllegalStateException("conversation-turn-already-exists");
        JSONArray ids = item.getJSONArray("turnIds");
        if (ids.length() >= 1000) throw new IllegalStateException("conversation-full-create-new");
        String prompt = text(payload.optString("prompt"), MAX_TEXT);
        if (ids.length() == 0 && "新对话".equals(item.optString("title"))) item.put("title", text(prompt.replaceAll("\\s+", " "), 100));
        JSONObject turn = new JSONObject().put("turnId", turnId).put("createdAt", System.currentTimeMillis())
            .put("status", "running").put("prompt", prompt).put("content", "").put("thought", "")
            .put("tools", new JSONArray()).put("model", new JSONObject()
                .put("provider", payload.optString("provider")).put("model", payload.optString("model"))
                .put("reasoningLevel", payload.optString("reasoningLevel")))
            .put("context", boundedContext(payload.optJSONObject("context")));
        write(turnFile(id, turnId), turn);
        ids.put(turnId);
        item.put("activeTurnId", turnId).put("status", "running").put("draft", "")
            .put("updatedAt", System.currentTimeMillis());
        write(metadata(id), item);
        active.put(id, turn);
        return summary(item);
    }

    synchronized void attach(String workspace, String id, String acpSessionId) throws Exception {
        JSONObject item = require(workspace, id).put("acpSessionId", acpSessionId);
        write(metadata(id), item);
    }
    synchronized String acpSession(String workspace, String id) throws Exception { return require(workspace, id).optString("acpSessionId"); }

    synchronized void append(String id, String turnId, JSONObject event) throws Exception {
        JSONObject turn = active.get(id);
        if (turn == null || !turnId.equals(turn.optString("turnId"))) return;
        String kind = event.optString("kind");
        if ("stream_reset".equals(kind)) {
            String message = event.optString("messageId", "default");
            JSONObject blocks = turn.optJSONObject("blocks");
            if (blocks != null) { blocks.remove(message); rebuildText(turn, blocks); }
        } else if ("delta".equals(kind) || "thought".equals(kind) || "reasoning".equals(kind)) {
            String field = "delta".equals(kind) ? "content" : "thought";
            JSONObject blocks = turn.optJSONObject("blocks");
            if (blocks == null) { blocks = new JSONObject(); turn.put("blocks", blocks); }
            String message = event.optString("messageId", "default");
            JSONObject block = blocks.optJSONObject(message);
            if (block == null) {
                if (blocks.length() >= 100) { turn.put("truncated", true); return; }
                block = new JSONObject().put("order", blocks.length()); blocks.put(message, block);
            }
            String combined = block.optString(field) + event.optString("text", event.optString("delta"));
            String bounded = text(combined, MAX_TEXT);
            block.put(field, bounded);
            if (!bounded.equals(McpWorkspacePolicy.redact(combined))) turn.put("truncated", true);
            rebuildText(turn, blocks);
        } else if ("usage".equals(kind)) turn.put("usage", McpWorkspacePolicy.redactValue(event.optJSONObject("usage")));
        else if ("tool".equals(kind) || "tool_update".equals(kind) || "tool_call".equals(kind) || "approval_required".equals(kind)
            || "task".equals(kind) || "patch_preview".equals(kind) || ("scope".equals(kind) && event.has("callId"))) {
            JSONArray tools = turn.getJSONArray("tools");
            String callId = event.optString("callId");
            int replace = -1;
            if (!callId.isEmpty()) for (int i = 0; i < tools.length(); i++)
                if (callId.equals(tools.getJSONObject(i).optString("callId"))) { replace = i; break; }
            if (replace >= 0 || tools.length() < 100) {
                JSONObject safe = (JSONObject) McpWorkspacePolicy.redactValue(event);
                // No live approval credentials or executable actions survive in history.
                safe.remove("approvalId"); safe.remove("requestId"); safe.remove("options");
                safe.put("historyReadOnly", true);
                String encoded = safe.toString();
                int limit = "patch_preview".equals(kind) ? 128 * 1024 : 4096;
                if (encoded.getBytes(StandardCharsets.UTF_8).length > limit) {
                    safe = new JSONObject().put("kind", kind).put("preview", text(encoded, 4096)).put("historyReadOnly", true)
                        .put("truncated", true);
                    turn.put("truncated", true);
                }
                if (replace >= 0) tools.put(replace, safe); else tools.put(safe);
            } else turn.put("truncated", true);
        }
    }

    synchronized void flush() throws Exception {
        for (Map.Entry<String, JSONObject> entry : active.entrySet()) writeTurn(entry.getKey(), entry.getValue());
    }

    synchronized void finish(String workspace, String id, String turnId, JSONObject terminal) throws Exception {
        JSONObject turn = active.get(id);
        if (turn == null || !turnId.equals(turn.optString("turnId"))) return;
        String reason = terminal.optString("stopReason"), kind = terminal.optString("kind");
        String status = "error".equals(kind) ? "error" : reason.contains("cancel") ? "cancelled" : "done";
        if ("service-disconnected".equals(terminal.optString("code"))) status = "interrupted";
        turn.put("status", status).put("finishedAt", System.currentTimeMillis())
            .put("message", text(terminal.optString("message"), 1024));
        writeTurn(id, turn);
        JSONObject item = require(workspace, id).put("status", status).put("updatedAt", System.currentTimeMillis());
        item.remove("activeTurnId");
        write(metadata(id), item); active.remove(id);
    }

    private void writeTurn(String id, JSONObject turn) throws Exception {
        JSONObject persisted = new JSONObject(turn.toString());
        persisted.remove("blocks");
        while (persisted.toString().getBytes(StandardCharsets.UTF_8).length > MAX_TURN && persisted.getJSONArray("tools").length() > 0) {
            persisted.getJSONArray("tools").remove(0); persisted.put("truncated", true);
        }
        if (persisted.toString().getBytes(StandardCharsets.UTF_8).length > MAX_TURN) {
            persisted.put("context", new JSONObject().put("truncated", true)).put("truncated", true);
            for (String field : new String[]{"thought", "content", "prompt"})
                persisted.put(field, text(persisted.optString(field), 12 * 1024));
        }
        write(turnFile(id, turn.getString("turnId")), persisted);
    }
    private static void rebuildText(JSONObject turn, JSONObject blocks) throws Exception {
        ArrayList<JSONObject> ordered = new ArrayList<>();
        java.util.Iterator<String> keys = blocks.keys();
        while (keys.hasNext()) ordered.add(blocks.getJSONObject(keys.next()));
        ordered.sort(Comparator.comparingInt(block -> block.optInt("order")));
        for (String field : new String[]{"content", "thought"}) {
            StringBuilder value = new StringBuilder();
            for (JSONObject block : ordered) value.append(block.optString(field));
            String safe = text(value.toString(), MAX_TEXT);
            turn.put(field, safe);
            if (!safe.equals(value.toString())) turn.put("truncated", true);
        }
    }
    private static Object boundedContext(JSONObject context) throws Exception {
        if (context == null) return new JSONObject();
        Object safe = McpWorkspacePolicy.redactValue(context);
        if (safe.toString().getBytes(StandardCharsets.UTF_8).length <= 48 * 1024) return safe;
        return new JSONObject().put("truncated", true).put("preview", text(safe.toString(), 48 * 1024));
    }
    private JSONObject require(String workspace, String id) throws Exception {
        validate(workspace); JSONObject item = read(metadata(id));
        if (!workspace.equals(item.optString("workspaceId"))) throw new IllegalArgumentException("conversation-workspace-mismatch");
        return item;
    }
    private static JSONObject summary(JSONObject item) throws Exception {
        JSONObject result = new JSONObject(item.toString()); result.remove("turnIds");
        result.put("messageCount", item.getJSONArray("turnIds").length() * 2); return result;
    }
    private File directory(String id) { validate(id); return new File(root, id); }
    private File metadata(String id) { return new File(directory(id), "conversation.json"); }
    private File turnFile(String id, String turn) { validate(turn); return new File(directory(id), turn + ".json"); }
    private static void validate(String value) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")) throw new IllegalArgumentException("invalid-conversation-identity");
    }
    private static String text(String value, int bytes) { return McpWorkspacePolicy.truncate(McpWorkspacePolicy.redact(value), bytes); }
    private static JSONObject read(File file) throws Exception {
        if (!file.isFile()) throw new IllegalArgumentException("conversation-not-found");
        if (file.length() > 2 * 1024 * 1024) throw new IOException("conversation-storage-too-large");
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }
    private static void write(File file, JSONObject value) throws Exception {
        File temporary = new File(file.getParentFile(), file.getName() + ".tmp");
        try {
            try (java.io.FileOutputStream stream = new java.io.FileOutputStream(temporary)) {
                stream.write(value.toString().getBytes(StandardCharsets.UTF_8)); stream.getFD().sync();
            }
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary.toPath()); }
    }
}
