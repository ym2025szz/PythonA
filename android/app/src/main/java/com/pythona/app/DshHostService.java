package com.pythona.app;

import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/** Network-enabled model gateway isolated in the :dsh process. */
public final class DshHostService extends BaseHostService {
    private static final Pattern SAFE_STREAM =
        Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private DshCredentialStore credentials;
    private DshProviderRegistry providers;
    private DshHttpClient http;
    private DirectDshRuntime direct;
    private WorkspaceMcpServer workspaceMcp;
    private WorkspaceRepository workspaceRepository;
    private DshConversationStore conversations;
    private InlineCompletionHost inline;
    private final DshInlineCapability inlineCapability = new DshInlineCapability();
    private volatile boolean compatibilityBusy;
    private final ScheduledExecutorService historyWorker = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, OfficialStream> officialStreams = new ConcurrentHashMap<>();
    private final Map<String, OfficialStream> officialStreamsByStream = new ConcurrentHashMap<>();
    private volatile Throwable initializationError;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            credentials = new DshCredentialStore(this);
            providers = new DshProviderRegistry(this, credentials);
            http = new DshHttpClient();
            direct = new DirectDshRuntime(this, this::onDirectEvent);
            workspaceRepository = WorkspaceRepository.readOnly(getFilesDir(), "default");
            workspaceMcp = new WorkspaceMcpServer(workspaceRepository, this::onWorkspaceMcpEvent);
            workspaceMcp.start();
            conversations = new DshConversationStore(getFilesDir());
            inline = new InlineCompletionHost(workspaceRepository, new InlineCompletionHost.Backend() {
                @Override public JSONObject complete(JSONObject prepared) throws Exception {
                    if (prepared.optBoolean("officialMode", true)) {
                        configureDirect();
                        direct.initialize();
                        if (!inline.isActive(prepared.getString("completionId")))
                            return new JSONObject().put("status", "cancelled");
                        if (prepared.getLong("generation") != direct.generation())
                            return new JSONObject().put("status", "error").put("error", new JSONObject().put("code", "inline-stale-generation"));
                        return direct.call("pythona/inline_complete", prepared);
                    }
                    JSONObject profile = providers.enabledProfile(prepared.optString("profileId", ""));
                    if (!profile.optString("model").equals(prepared.optString("model")))
                        throw new IllegalArgumentException("inline-model-unavailable");
                    if (!inline.isActive(prepared.getString("completionId")))
                        return new JSONObject().put("status", "cancelled");
                    char[] key = providers.secret(profile);
                    try { return http.inlineComplete(prepared.getString("completionId"), profile, key, prepared); }
                    finally { java.util.Arrays.fill(key, '\0'); }
                }
                @Override public void cancel(String completionId) throws Exception {
                    http.cancelInline(completionId);
                    direct.cancelInline(completionId);
                }
            }, () -> compatibilityBusy || direct.isBusy() || !officialStreamsByStream.isEmpty(), event -> emitEvent("dsh", event));
            historyWorker.scheduleWithFixedDelay(() -> {
                try { conversations.flush(); } catch (Exception ignored) { /* Terminal persistence reports errors. */ }
            }, 1, 1, TimeUnit.SECONDS);
        } catch (Throwable error) {
            initializationError = error;
        }
    }

    @Override
    public void onDestroy() {
        if (inline != null) inline.close();
        if (direct != null) direct.close();
        if (workspaceMcp != null) workspaceMcp.close();
        historyWorker.shutdown();
        officialStreams.clear();
        officialStreamsByStream.clear();
        workspaceRepository = null;
        super.onDestroy();
    }

    @Override
    protected boolean isConcurrentControlMethod(String method) {
        return "cancel".equals(method) || "$/cancelRequest".equals(method)
            || "session/cancel".equals(method) || "$/cancel_request".equals(method)
            || "inlineCancel".equals(method)
            || "respondToolApproval".equals(method);
    }

    @Override
    protected JSONObject handleRequest(
        String method,
        JSONObject payload,
        JSONObject request
    ) throws Exception {
        if (isOfficialMethod(method)) return handleOfficial(method, payload, request);
        requireReady();
        if ("inlineComplete".equals(method)) return inline.start(payload, request);
        if ("inlineCancel".equals(method)) return inline.cancel(payload);
        if (method.startsWith("conversation.")) return handleConversation(method, payload);
        if ("listProviders".equals(method)) {
            return new JSONObject().put("providers", providers.providers());
        }
        if ("listProfiles".equals(method)) {
            return new JSONObject().put("profiles", providers.publicProfiles());
        }
        if ("saveProfile".equals(method)) {
            JSONObject profile = payload.optJSONObject("profile");
            if (profile == null) throw new IllegalArgumentException("Provider profile is required");
            String secret = payload.optString("secret", "");
            if (secret.length() > 8 * 1024) throw new IllegalArgumentException("API key is too large");
            JSONObject saved = providers.save(profile, secret);
            return new JSONObject().put("profile", saved);
        }
        if ("deleteProfile".equals(method)) {
            return new JSONObject().put("deleted",
                providers.delete(payload.getString("profileId")));
        }
        if ("networkStatus".equals(method)) return networkStatus();
        if ("testProfile".equals(method)) return testProfile(payload, request);
        if ("configureCredential".equals(method)) return saveDirectCredential(payload);
        if ("start".equals(method) && payload.optBoolean("officialMode", false)) {
            inline.cancelForChat();
            return startOfficial(payload, request);
        }
        if ("start".equals(method)) {
            inline.cancelForChat();
            compatibilityBusy = true;
            try { return start(payload, request); }
            finally { compatibilityBusy = false; }
        }
        if ("cancel".equals(method) || "$/cancelRequest".equals(method)) {
            String streamId = payload.optString("streamId", "");
            OfficialStream officialStream = officialStreamsByStream.get(streamId);
            if (officialStream != null && direct != null) {
                workspaceMcp.revoke(officialStream.binding, "cancelled");
                direct.cancel(officialStream.acpSessionId);
                return new JSONObject().put("cancelled", true).put("streamId", streamId).put("official", true);
            }
            return new JSONObject().put("cancelled", http.cancel(streamId)).put("streamId", streamId);
        }
        if ("respondToolApproval".equals(method)) {
            String requestId = payload.optString("approvalId", payload.optString("requestId", ""));
            boolean allowed = payload.optBoolean("allowed", false);
            boolean accepted = workspaceMcp != null && workspaceMcp.respondApproval(requestId, allowed, payload.optJSONObject("result"));
            if (accepted) return new JSONObject().put("accepted", true).put("source", "pythona-mcp");
            if (direct == null) throw new IllegalStateException("PythonA official dsh unavailable");
            return direct.respondPermission(requestId, allowed);
        }
        throw new IllegalArgumentException("Unknown DSH method: " + method);
    }

    private static boolean isOfficialMethod(String method) {
        return "capabilities".equals(method) || "listModels".equals(method)
            || "selectModel".equals(method) || "openSettings".equals(method)
            || "reconnect".equals(method) || "initialize".equals(method)
            || "authenticate".equals(method) || "session/new".equals(method)
            || "session/list".equals(method) || "session/resume".equals(method)
            || "session/close".equals(method) || "session/set_config_option".equals(method)
            || "session/prompt".equals(method) || "session/cancel".equals(method)
            || "session/request_permission/response".equals(method)
            || "bridge/permission_response".equals(method)
            || "$/cancel_request".equals(method);
    }

    private JSONObject handleOfficial(String method, JSONObject payload, JSONObject request)
        throws Exception {
        if (direct == null) throw new IllegalStateException("PythonA official dsh unavailable");
        AcpConnection.rejectCredentials(payload, 0);
        return handleDirectOfficial(method, payload, request);
    }

    /** Official dsh is launched directly inside PythonA's own :dsh process. */
    private JSONObject handleDirectOfficial(String method, JSONObject payload, JSONObject request)
        throws Exception {
        if ("reconnect".equals(method)) {
            if (direct.isBusy()) throw new IllegalStateException("dsh-busy");
            direct.reconnect();
            configureDirect();
            direct.initialize();
        }
        if ("capabilities".equals(method) || "reconnect".equals(method)) {
            JSONObject capabilities = direct.capabilities();
            JSONObject negotiated = inlineCapability.resolve(capabilities.optLong("generation"),
                inline != null && capabilities.optBoolean("connected", false),
                inline != null && http != null && providers != null && initializationError == null, direct::inlineCapabilities);
            JSONObject limits = inline == null ? new JSONObject() : inline.capabilities();
            java.util.Iterator<String> keys = negotiated.keys();
            while (keys.hasNext()) { String key = keys.next(); limits.put(key, negotiated.get(key)); }
            return capabilities.put("keyConfigured", directHasKey())
                .put("inlineCompletion", limits)
                .put("conversations", new JSONObject().put("supported", conversations != null)
                    .put("persistent", true).put("pageSize", 50).put("workspaceBound", true));
        }
        if ("initialize".equals(method)) return direct.initialize();
        if ("authenticate".equals(method)) return new JSONObject().put("authenticated", directHasKey());
        if ("listModels".equals(method)) return currentCatalog();
        if ("openSettings".equals(method)) return new JSONObject().put("opened", true)
            .put("message", "请在 PythonA 设置 → DSH 模型中配置官方 dsh");
        if ("selectModel".equals(method)) {
            JSONObject selection = payload.optJSONObject("selection");
            if (selection == null) selection = payload;
            String sessionId = selection.optString("sessionId", payload.optString("sessionId", ""));
            if (sessionId.isEmpty()) return new JSONObject().put("selected", selection).put("official", true);
            return direct.call("session/set_config_option", new JSONObject()
                .put("sessionId", sessionId).put("configId", "model")
                .put("value", selection.optString("value", selection.optString("model", ""))));
        }
        if ("session/new".equals(method) || "session/resume".equals(method)) {
            configureDirect();
            direct.initialize();
            JSONObject result = "session/resume".equals(method)
                ? direct.call(method, new JSONObject().put("sessionId", payload.getString("sessionId"))
                    .put("cwd", "/root").put("mcpServers", new JSONArray()))
                : direct.newSession("/root", new JSONArray());
            String acp = result.optString("sessionId", payload.optString("sessionId", ""));
            result.put("sessionId", acp);
            officialStreams.put(acp, new OfficialStream(acp, request.optString("id", ""), acp));
            return result;
        }
        if ("session/prompt".equals(method)) {
            if (inline != null) inline.cancelForChat();
            configureDirect();
            String acp = payload.optString("sessionId", "");
            if (direct.isBusy()) throw new IllegalStateException("dsh-busy");
            if (!directHasKey()) throw new IllegalStateException("dsh-key-required");
            StringBuilder content = new StringBuilder();
            JSONArray parts = payload.optJSONArray("prompt");
            if (parts == null) content.append(payload.optString("text", ""));
            else for (int i = 0; i < parts.length(); i++) {
                JSONObject part = parts.getJSONObject(i);
                if (!"text".equals(part.optString("type"))) throw new IllegalArgumentException("unsupported-prompt-content");
                content.append(part.getString("text")).append("\n");
            }
            OfficialStream stream = officialStreams.get(acp);
            if (stream == null) throw new IllegalStateException("Unknown dsh session");
            stream.requestId = request.optString("id", stream.requestId);
            officialStreamsByStream.put(stream.streamId, stream);
            try {
                JSONObject accepted = direct.prompt(acp, content.toString());
                return accepted.put("streamId", stream.streamId).put("requestId", stream.requestId);
            } catch (Exception error) { officialStreamsByStream.remove(stream.streamId, stream); throw error; }
        }
        if ("session/cancel".equals(method) || "$/cancel_request".equals(method)) {
            OfficialStream stream = officialStreams.get(payload.optString("sessionId", ""));
            if (stream != null) workspaceMcp.revoke(stream.binding, "cancelled");
            return direct.cancel(payload.optString("sessionId", ""));
        }
        if ("session/request_permission/response".equals(method)
            || "bridge/permission_response".equals(method)) {
            String optionId = payload.optString("optionId", "").toLowerCase(java.util.Locale.ROOT);
            boolean allowed = optionId.startsWith("allow") && !optionId.startsWith("reject");
            return direct.respondPermission(payload.optString("requestId", ""), allowed);
        }
        if ("session/close".equals(method)) {
            JSONObject result = direct.call(method, payload);
            OfficialStream closed = officialStreams.remove(payload.optString("sessionId", ""));
            if (closed != null) officialStreamsByStream.remove(closed.streamId);
            return result;
        }
        return direct.call(method, payload);
    }

    private JSONObject currentCatalog() throws Exception {
        configureDirect();
        JSONObject configured;
        try { configured = providers.profile("direct-dsh"); }
        catch (IllegalArgumentException missing) { configured = null; }
        final boolean hasKey = directHasKey();
        boolean custom = configured != null && "custom".equals(configured.optString("runtimeMode"));
        String providerId = custom ? DshCustomConfiguration.PROVIDER_ID : "deepseek-official";
        JSONObject catalog = configured == null
            ? DshModelCatalog.normalize(direct.modelCatalog(), hasKey)
            : DshProviderActivation.await(() -> DshModelCatalog.normalize(direct.modelCatalog(), hasKey),
                providerId, configured.getString("model"), 15000, 200);
        if (configured != null) catalog.put("selected", new JSONObject().put("providerId", providerId)
            .put("model", configured.getString("model")).put("reasoningLevel", custom ? "off" : "high"));
        JSONArray rows = catalog.getJSONArray("providers");
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            boolean selected = providerId.equals(row.optString("id"));
            row.put("keyConfigured", selected && hasKey);
            if (configured != null && selected) row.put("baseUrl", configured.getString("baseUrl"));
            if (custom && selected) {
                row.put("capabilities", new JSONObject().put("reasoningLevels", new JSONArray().put("off")));
                JSONArray models = row.getJSONArray("models");
                for (int j = 0; j < models.length(); j++) models.getJSONObject(j).put("reasoningLevels", new JSONArray().put("off"));
            }
        }
        return catalog.put("keyConfigured", hasKey).put("status", "ready");
    }

    private JSONObject saveDirectCredential(JSONObject payload) throws Exception {
        if (direct.isBusy()) throw new IllegalStateException("dsh-busy");
        String secret = payload.optString("secret", "");
        if (secret.length() > 8192) throw new IllegalArgumentException("API Key 太长");
        JSONObject profile = DshCustomConfiguration.normalize(payload.getJSONObject("profile"));
        JSONObject saved = providers.save(profile, secret);
        if (inline != null) inline.resetAuthorization();
        JSONObject result = new JSONObject().put("saved", true).put("hasKey", saved.optBoolean("hasKey", false)).put("profile", saved);
        try { result.put("catalog", currentCatalog()).put("activated", true); }
        catch (Exception failure) {
            result.put("activated", false).put("message", "配置已保存，官方 dsh 载入未完成；可以重试刷新目录");
        }
        return result;
    }

    private boolean directHasKey() {
        try { return providers.profile("direct-dsh").optString("keyRef", "").length() > 0; }
        catch (Exception ignored) { return false; }
    }

    private void configureDirect() throws Exception {
        if (direct == null || providers == null) return;
        try {
            JSONObject profile = providers.profile("direct-dsh");
            char[] secret = profile.optString("keyRef").isEmpty() ? new char[0] : providers.secret(profile);
            try {
                direct.configure(new String(secret), profile.optString("baseUrl", ""),
                    profile.optString("runtimeMode", "deepseek"),
                    DshCustomConfiguration.settings(profile));
            } finally { java.util.Arrays.fill(secret, '\0'); }
        } catch (IllegalArgumentException missing) {
            direct.configure("", "");
        }
    }

    /** Adapt the existing PythonA DSH start surface to an official ACP turn. */
    private JSONObject startOfficial(JSONObject payload, JSONObject request) throws Exception {
        if (direct.isBusy() || !officialStreamsByStream.isEmpty()) throw new IllegalStateException("dsh-busy");
        if (!directHasKey()) throw new IllegalStateException("dsh-key-required");
        configureDirect();
        String streamId = requireStream(payload.optString("streamId", ""));
        String requestId = request.optString("id", payload.optString("requestId", streamId));
        String uiSessionId = payload.optString("sessionId", "dsh-" + requestId);
        String workspace = requireWorkspace(payload);
        String conversationId = payload.optString("conversationId", "");
        if (conversationId.isEmpty()) conversationId = conversations.create(workspace, "").getString("id");
        String turnId = payload.optString("turnId", "turn-" + UUID.randomUUID());
        String previousSession = conversations.acpSession(workspace, conversationId);
        conversations.begin(workspace, conversationId, turnId, payload);
        WorkspaceMcpServer.Binding binding = workspaceMcp.bind(uiSessionId, streamId, requestId);
        try {
        JSONObject created = previousSession.isEmpty()
            ? direct.newSession("/root", new JSONArray().put(binding.descriptor()))
            : direct.resumeSession(previousSession, new JSONArray().put(binding.descriptor()));
        String acpSessionId = created.optString("sessionId", "");
        if (acpSessionId.isEmpty()) throw new IllegalStateException("Official DSH returned no session id");
        OfficialStream stream = new OfficialStream(acpSessionId, requestId, uiSessionId, streamId);
        stream.conversationId = conversationId;
        stream.turnId = turnId;
        conversations.attach(workspace, conversationId, acpSessionId);
        stream.binding = binding;
        stream.generation = direct.generation();
        stream.identity = new JSONObject(payload.toString());
        binding.attachSession(acpSessionId);
        officialStreams.put(acpSessionId, stream);
        officialStreamsByStream.put(streamId, stream);
        DshSessionOptions.apply(created, payload.optString("provider", ""),
            payload.optString("model", ""), payload.optString("reasoningLevel", ""), direct::call);
        String prompt = payload.optString("prompt", "");
        JSONObject context = payload.optJSONObject("context");
        if (context != null) prompt += "\n\n<untrusted-workspace-context>\n" + context.toString()
            + "\n</untrusted-workspace-context>\nUse the PythonA MCP tools for workspace access. Changes must be proposed with propose_patch; saved Run configurations require request_run.";
        direct.prompt(acpSessionId, prompt);
        return new JSONObject().put("accepted", true).put("official", true)
            .put("streamId", streamId).put("requestId", requestId).put("sessionId", uiSessionId)
            .put("conversationId", conversationId).put("turnId", turnId);
        } catch (Exception error) {
            workspaceMcp.revoke(binding, "start-failed");
            OfficialStream failed = officialStreamsByStream.remove(streamId);
            if (failed != null) {
                officialStreams.remove(failed.acpSessionId);
                direct.closeSessionLater(failed.acpSessionId, failed.generation);
            }
            conversations.finish(workspace, conversationId, turnId, new JSONObject().put("kind", "error")
                .put("message", safeMessage(error)));
            throw error;
        }
    }

    private static final class OfficialStream {
        final String sessionId;
        final String streamId;
        final String acpSessionId;
        final String uiSessionId;
        volatile String requestId;
        volatile WorkspaceMcpServer.Binding binding;
        volatile JSONObject identity;
        volatile long generation;
        volatile String conversationId = "", turnId = "";
        final AtomicBoolean finishing = new AtomicBoolean();
        OfficialStream(String sessionId, String requestId, String uiSessionId) {
            this(sessionId, requestId, uiSessionId, "acp-" + UUID.randomUUID());
        }
        OfficialStream(String sessionId, String requestId, String uiSessionId, String streamId) {
            this.sessionId = sessionId;
            this.acpSessionId = sessionId;
            this.uiSessionId = uiSessionId;
            this.streamId = streamId;
            this.requestId = requestId;
        }
    }

    private void onWorkspaceMcpEvent(JSONObject event) {
        try {
            OfficialStream stream = officialStreamsByStream.get(event.optString("streamId", ""));
            if (stream == null) return;
            JSONObject normalized = new JSONObject(event.toString())
                .put("streamId", stream.streamId)
                .put("requestId", stream.requestId)
                .put("sessionId", stream.uiSessionId)
                .put("workspaceId", "default")
                .put("official", true)
                .put("source", "official-dsh");
            copyStreamIdentity(stream, normalized);
            persistEvent(stream, normalized);
            emitEvent("dsh", normalized);
        } catch (Exception ignored) { }
    }

    private void onOfficialEvent(JSONObject event) {
        try {
            String method = event.optString("method", event.optString("type", ""));
            JSONObject params = event.optJSONObject("params");
            if (params == null) params = event;
            if ("direct/runtime".equals(method)) {
                String state = params.optString("state", "unknown");
                emitEvent("dsh", new JSONObject()
                    .put("kind", "scope")
                    .put("type", "runtime-progress").put("phase", state)
                    .put("generation", event.optLong("generation", direct == null ? 0 : direct.generation()))
                    .put("completed", params.optLong("completed")).put("total", params.optLong("total"))
                    .put("text", "内置 dsh " + state)
                    .put("official", true)
                    .put("source", "official-dsh"));
                if ("stopped".equals(state)) {
                    if (inline != null) inline.cancelForChat();
                    workspaceMcp.revokeAll("dsh-stopped");
                    for (OfficialStream stream : officialStreamsByStream.values()) {
                        JSONObject terminal = new JSONObject().put("kind", "error")
                            .put("streamId", stream.streamId).put("sessionId", stream.uiSessionId)
                            .put("requestId", stream.requestId).put("workspaceId", "default")
                            .put("code", "service-disconnected").put("message", "dsh 服务已中断；本轮不会自动重发")
                            .put("official", true);
                        copyStreamIdentity(stream, terminal);
                        finishOfficial(stream, terminal, false);
                    }
                }
                return;
            }
            String sessionId = params.optString("sessionId", event.optString("sessionId", ""));
            OfficialStream stream = officialStreams.get(sessionId);
            if (stream == null || stream.finishing.get()) return;
            String kind;
            JSONObject normalized = new JSONObject().put("streamId", stream.streamId)
                .put("kind", "scope").put("requestId", stream.requestId)
                .put("sessionId", stream.uiSessionId).put("workspaceId", "default")
                .put("official", true);
            copyStreamIdentity(stream, normalized);
            if ("session/update".equals(method)) {
                JSONObject update = params.optJSONObject("update");
                if (update == null) update = params;
                JSONObject presentation = DshAcpUpdates.normalize(update);
                if (presentation == null) return;
                kind = presentation.getString("kind");
                java.util.Iterator<String> keys = presentation.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    normalized.put(key, presentation.get(key));
                }
            } else if ("direct/prompt_done".equals(method) || "direct/prompt_error".equals(method) || "bridge/prompt_done".equals(method) || "session/finished".equals(method)
                || "bridge/prompt_error".equals(method)) {
                kind = method.endsWith("error") ? "error" : "done";
                normalized.put("stopReason", params.optString("stopReason", ""));
                normalized.put("code", params.optString("code", ""));
                if (params.has("message")) normalized.put("message", params.optString("message"));
            } else if ("bridge/permission_request".equals(method)
                || "session/request_permission".equals(method)) {
                kind = "approval_required";
                normalized.put("action", "permission")
                    .put("approvalId", params.optString("approvalId", ""))
                    .put("permission", DshAcpUpdates.tool(params.optJSONObject("toolCall")))
                    .put("options", DshAcpUpdates.permissionOptions(params.optJSONArray("options")));
            } else return;
            normalized.put("kind", kind);
            if ("done".equals(kind) || "error".equals(kind)) {
                finishOfficial(stream, normalized, true);
            } else { persistEvent(stream, normalized); emitEvent("dsh", normalized); }
        } catch (Exception ignored) {
            // Polling must not die on a malformed provider event.
        }
    }

    private void onDirectEvent(JSONObject event) {
        onOfficialEvent(event);
    }

    private static void copyStreamIdentity(OfficialStream stream, JSONObject event) throws Exception {
        if (!stream.conversationId.isEmpty()) event.put("conversationId", stream.conversationId).put("turnId", stream.turnId);
        JSONObject identity = stream.identity;
        if (identity == null) return;
        for (String key : new String[]{"uri", "epoch", "bufferVersion"})
            if (identity.has(key)) event.put(key, identity.get(key));
    }

    private void persistEvent(OfficialStream stream, JSONObject event) {
        if (stream.conversationId.isEmpty() || stream.finishing.get()) return;
        historyWorker.execute(() -> {
            try { conversations.append(stream.conversationId, stream.turnId, event); }
            catch (Exception ignored) { /* Terminal flush reports storage errors without interrupting tokens. */ }
        });
    }

    private void finishOfficial(OfficialStream stream, JSONObject terminal, boolean closeSession) {
        if (!stream.finishing.compareAndSet(false, true)) return;
        if (stream.binding != null) workspaceMcp.revoke(stream.binding, "turn-ended");
        historyWorker.execute(() -> {
            try {
                if (closeSession && stream.binding != null) direct.closeSessionAwaited(stream.acpSessionId, stream.generation);
            } catch (Exception error) {
                try { terminal.put("kind", "error").put("code", "conversation-save-failed")
                    .put("message", "官方会话保存未完成，无法确认下一轮可恢复；请检查服务状态后重试"); }
                catch (Exception ignored) { }
            }
            try {
                if (!stream.conversationId.isEmpty()) conversations.finish("default", stream.conversationId, stream.turnId, terminal);
            } catch (Exception error) {
                try { terminal.put("kind", "error").put("code", "conversation-save-failed")
                    .put("message", "本地会话记录保存失败，已保留当前界面内容"); } catch (Exception ignored) { }
            }
            officialStreams.remove(stream.acpSessionId, stream);
            officialStreamsByStream.remove(stream.streamId, stream);
            emitEvent("dsh", terminal);
        });
    }

    private JSONObject handleConversation(String method, JSONObject payload) throws Exception {
        String workspace = requireWorkspace(payload), id = payload.optString("conversationId", "");
        if ("conversation.create".equals(method)) return new JSONObject().put("conversation", conversations.create(workspace, payload.optString("title", "")));
        if ("conversation.list".equals(method)) return conversations.list(workspace, payload.optBoolean("archived"), payload.optInt("offset", 0));
        if ("conversation.read".equals(method)) return conversations.readConversation(workspace, id, payload.optInt("before", -1));
        if ("conversation.rename".equals(method)) return new JSONObject().put("conversation", conversations.rename(workspace, id, payload.optString("title", "")));
        if ("conversation.archive".equals(method)) return new JSONObject().put("conversation", conversations.archive(workspace, id, payload.optBoolean("archived", true)));
        if ("conversation.draft".equals(method)) return new JSONObject().put("conversation", conversations.draft(workspace, id, payload.optString("draft", "")));
        throw new IllegalArgumentException("Unknown conversation method");
    }

    private static String requireWorkspace(JSONObject payload) {
        String workspace = payload.optString("workspaceId", "default");
        if (!"default".equals(workspace)) throw new IllegalArgumentException("conversation-workspace-unavailable");
        return workspace;
    }

    private JSONObject start(JSONObject payload, JSONObject transport) throws Exception {
        String streamId = requireStream(payload.optString("streamId", ""));
        JSONObject profile = providers.enabledProfile(payload.optString("profileId", ""));
        String sessionId = payload.optString("sessionId", "");
        if (sessionId.isEmpty()) sessionId = "session-" + UUID.randomUUID();
        final String finalSessionId = sessionId;
        emitEvent("dsh", identityEvent(payload, transport, streamId, finalSessionId, "scope")
            .put("text", "Provider " + profile.optString("displayName", profile.optString("providerKind"))
                + " · " + profile.optString("model")));
        char[] secret = providers.secret(profile);
        try {
            JSONObject result = http.stream(streamId, profile, secret, payload, event -> {
                JSONObject normalized = identityEvent(
                    payload, transport, streamId, finalSessionId, event.optString("kind", "delta"));
                java.util.Iterator<String> keys = event.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (!"kind".equals(key)) normalized.put(key, event.get(key));
                }
                emitEvent("dsh", normalized);
            });
            return result.put("sessionId", finalSessionId);
        } catch (DshHttpClient.HttpFailure failure) {
            emitEvent("dsh", identityEvent(payload, transport, streamId, finalSessionId, "error")
                .put("code", failure.code)
                .put("status", failure.status)
                .put("message", safeMessage(failure)));
            return new JSONObject()
                .put("ok", false).put("streamId", streamId)
                .put("code", failure.code).put("status", failure.status);
        }
    }

    private JSONObject testProfile(JSONObject payload, JSONObject transport) throws Exception {
        JSONObject profile = providers.profile(payload.getString("profileId"));
        String streamId = "test-" + UUID.randomUUID();
        JSONObject test = new JSONObject()
            .put("streamId", streamId)
            .put("requestId", transport.optString("id", streamId))
            .put("sessionId", "profile-test")
            .put("workspaceId", "default")
            .put("messages", new JSONArray().put(new JSONObject()
                .put("role", "user")
                .put("content", "Reply with the single word OK.")))
            .put("maxOutputTokens", 8)
            .put("tools", new JSONArray());
        long startedAt = System.currentTimeMillis();
        final boolean[] received = { false };
        char[] secret = providers.secret(profile);
        JSONObject result = http.stream(streamId, profile, secret, test, event -> {
            if ("delta".equals(event.optString("kind"))) received[0] = true;
        });
        return new JSONObject()
            .put("ok", result.optBoolean("ok", false))
            .put("receivedOutput", received[0])
            .put("latencyMillis", System.currentTimeMillis() - startedAt)
            .put("profile", publicIdentity(profile));
    }

    private JSONObject networkStatus() throws Exception {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        Network network = manager == null ? null : manager.getActiveNetwork();
        NetworkCapabilities capabilities = manager == null || network == null
            ? null : manager.getNetworkCapabilities(network);
        return new JSONObject()
            .put("connected", capabilities != null)
            .put("validated", capabilities != null
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            .put("metered", manager != null && manager.isActiveNetworkMetered());
    }

    private static JSONObject identityEvent(
        JSONObject payload,
        JSONObject transport,
        String streamId,
        String sessionId,
        String kind
    ) throws Exception {
        JSONObject event = new JSONObject()
            .put("streamId", streamId)
            .put("kind", kind)
            .put("requestId", payload.optString("requestId", transport.optString("id", "")))
            .put("sessionId", sessionId)
            .put("epoch", payload.optLong("epoch", 0))
            .put("workspaceId", payload.optString("workspaceId", "default"))
            .put("uri", payload.optString("uri", payload.optString("path", "")));
        if (payload.has("bufferVersion")) event.put("bufferVersion", payload.optLong("bufferVersion"));
        else event.put("bufferVersion", payload.optLong("version", 0));
        return event;
    }

    private static JSONObject publicIdentity(JSONObject profile) throws Exception {
        return new JSONObject()
            .put("profileId", profile.optString("profileId"))
            .put("displayName", profile.optString("displayName"))
            .put("providerKind", profile.optString("providerKind"))
            .put("model", profile.optString("model"));
    }

    private void requireReady() {
        if (initializationError == null && providers != null && http != null) return;
        throw new IllegalStateException(
            "DSH secure storage failed to initialize: " + safeMessage(initializationError));
    }

    private static String requireStream(String value) {
        String streamId = value == null ? "" : value.trim();
        if (!SAFE_STREAM.matcher(streamId).matches()) {
            throw new IllegalArgumentException("Invalid DSH stream id");
        }
        return streamId;
    }

    private static String safeMessage(Throwable error) {
        String value = error == null ? null : error.getMessage();
        return value == null || value.isEmpty()
            ? (error == null ? "Unknown DSH error" : error.getClass().getSimpleName())
            : value;
    }
}
