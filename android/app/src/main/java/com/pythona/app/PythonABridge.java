package com.pythona.app;

import android.content.Context;
import android.webkit.JavascriptInterface;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Versioned asynchronous native broker. The synchronous invoke method remains
 * temporarily for the existing front end and must not be used for new calls.
 */
public final class PythonABridge implements AutoCloseable {
    public interface RuntimePackPicker {
        boolean isAvailable();
        void pick(RuntimePackPickerCallback callback);
    }

    public interface RuntimePackPickerCallback {
        void onPicked(String contentUri);
        void onCancelled();
        void onError(String message);
    }

    public interface PythonPackagePicker {
        boolean isAvailable();
        void pick(PythonPackagePickerCallback callback);
    }

    public interface PythonPackagePickerCallback {
        void onPicked(String contentUri);
        void onCancelled();
        void onError(String message);
    }

    private final RuntimeService legacyRuntimeService;
    private final WebView webView;
    private final WorkspaceRepository workspace;
    private final RuntimePackManager runtimePackManager;
    private final RuntimePackPicker runtimePackPicker;
    private final PythonPackagePicker pythonPackagePicker;
    private final ExecutorService workspaceExecutor;
    private final ServiceMessengerClient runtimeClient;
    private final ServiceMessengerClient languageClient;
    private final ServiceMessengerClient dshClient;
    private final ProjectModelStore projectModelStore;
    private final ProjectIndexDatabase projectIndex;
    private final EditorDraftStore editorDrafts;
    private final WorkspaceRepository.Listener workspaceListener;
    private volatile WebMessagePort messagePort;
    private volatile boolean closed;

    public PythonABridge() {
        this(null, null, null, new StubRuntimeService());
    }

    public PythonABridge(RuntimeService runtimeService) {
        this(null, null, null, runtimeService);
    }

    public PythonABridge(
        Context context,
        WebView webView,
        WorkspaceRepository workspace,
        RuntimeService runtimeService
    ) {
        this(context, webView, workspace, runtimeService, null);
    }

    public PythonABridge(
        Context context,
        WebView webView,
        WorkspaceRepository workspace,
        RuntimeService runtimeService,
        RuntimePackPicker runtimePackPicker
    ) {
        this(context, webView, workspace, runtimeService, runtimePackPicker, null);
    }

    public PythonABridge(
        Context context,
        WebView webView,
        WorkspaceRepository workspace,
        RuntimeService runtimeService,
        RuntimePackPicker runtimePackPicker,
        PythonPackagePicker pythonPackagePicker
    ) {
        this.legacyRuntimeService = runtimeService == null
            ? new StubRuntimeService(context)
            : runtimeService;
        this.webView = webView;
        this.workspace = workspace;
        this.runtimePackManager = new RuntimePackManager(context);
        this.runtimePackPicker = runtimePackPicker;
        this.pythonPackagePicker = pythonPackagePicker;
        this.workspaceExecutor = Executors.newSingleThreadExecutor();
        this.runtimeClient = context == null
            ? null
            : new ServiceMessengerClient(
                context,
                RuntimeHostService.class,
                this::deliver,
                (state, detail) -> postServiceLifecycleEvent("runtime", state, detail));
        this.languageClient = context == null
            ? null
            : new ServiceMessengerClient(
                context,
                LanguageHostService.class,
                this::deliver,
                (state, detail) -> postServiceLifecycleEvent("language", state, detail));
        this.dshClient = context == null
            ? null
            : new ServiceMessengerClient(
                context,
                DshHostService.class,
                this::deliver,
                (state, detail) -> postServiceLifecycleEvent("dsh", state, detail));
        ProjectModelStore openedProject = null;
        ProjectIndexDatabase openedIndex = null;
        EditorDraftStore openedDrafts = null;
        if (context != null) {
            try {
                openedProject = new ProjectModelStore(context, "default");
                openedIndex = new ProjectIndexDatabase(context, "default");
            } catch (Exception ignored) {
                // Requests report a precise unavailable error; editor/runtime
                // startup remains independent from optional indexing state.
            }
            try {
                openedDrafts = new EditorDraftStore(context.getFilesDir(), "default");
            } catch (Exception ignored) {
                // A damaged optional project index must not disable draft recovery.
                // Draft requests themselves report an explicit unavailable error.
            }
        }
        this.projectModelStore = openedProject;
        this.projectIndex = openedIndex;
        this.editorDrafts = openedDrafts;
        this.workspaceListener = this::postWorkspaceEvent;
        if (workspace != null) workspace.addListener(workspaceListener);
    }

    /** Compatibility API for the current bundle. New code should use postMessage. */
    public String invoke(String requestJson) {
        try {
            JSONObject request = new JSONObject(requestJson == null ? "{}" : requestJson);
            String method = request.optString("method", "capabilities");
            JSONObject payload = request.optJSONObject("payload");
            if ("capabilities".equals(method)) return legacyRuntimeService.capabilities().toString();
            if ("run".equals(method)) {
                String runId = payload == null
                    ? "run-android"
                    : payload.optString("runId", "run-android");
                String command = payload == null ? "" : payload.optString("command", "");
                String cwd = payload == null ? "" : payload.optString("cwd", "");
                String file = payload == null ? "" : payload.optString("file", "");
                return legacyRuntimeService.run(runId, command, cwd, file).toString();
            }
            if ("stop".equals(method)) {
                legacyRuntimeService.stop(payload == null ? "" : payload.optString("runId", ""));
                return new JSONObject().put("ok", true).toString();
            }
            return new JSONObject().put("error", "unknown bridge method").toString();
        } catch (Exception error) {
            try {
                return new JSONObject()
                    .put("error", message(error))
                    .put("code", "native-runtime-error")
                    .toString();
            } catch (JSONException ignored) {
                return "{\"error\":\"invalid request\"}";
            }
        }
    }

    /**
     * Non-blocking protocol v2 entry point. Responses are delivered to
     * window.PythonANative.onMessage(response).
     */
    @JavascriptInterface
    public void postMessage(String requestJson) {
        JSONObject request;
        try {
            request = BridgeProtocol.parseRequest(requestJson);
        } catch (Exception error) {
            deliver(BridgeProtocol.error(null, "invalid-request", message(error)));
            return;
        }
        if (closed) {
            deliver(BridgeProtocol.error(
                request, "bridge-closed", "The native bridge is already closed"));
            return;
        }

        String channel = request.optString("channel", "");
        if ("runtime".equals(channel)) {
            executeAsync(
                request,
                () -> forward(runtimeClient, request, "runtime-service-unavailable"));
            return;
        }
        if ("test".equals(channel)) {
            // Test execution shares the Runtime process and its exclusive
            // admission gate, while events retain the dedicated test channel
            // so the UI can keep structured reports separate from Console.
            executeAsync(
                request,
                () -> forward(runtimeClient, request, "runtime-service-unavailable"));
            return;
        }
        if ("language".equals(channel)) {
            // Indexing is a local, app-private operation.  Keep the public
            // language channel name used by the WebView API, but do not send
            // these methods through the isolated Jedi process (which has no
            // access to the project metadata database).
            String method = request.optString("method", "");
            if ("indexWorkspace".equals(method) || "workspaceSymbols".equals(method)) {
                executeAsync(request, () -> dispatchLocal(request));
                return;
            }
            executeAsync(
                request,
                () -> forward(languageClient, request, "language-service-unavailable"));
            return;
        }
        if ("dsh".equals(channel)) {
            if ("configureCredential".equals(request.optString("method"))) {
                showDshCredentialDialog(request);
                return;
            }
            executeAsync(
                request,
                () -> forward(dshClient, request, "dsh-service-unavailable"));
            return;
        }
        if ("pythonPackage".equals(channel)
            && "pickAndInstall".equals(request.optString("method", ""))
            && (request.optJSONObject("payload") == null
                || request.optJSONObject("payload").optString("uri", "").isEmpty())) {
            if (!hasUserConfirmation(request)) {
                deliver(BridgeProtocol.error(
                    request,
                    "confirmation-required",
                    "User confirmation is required before installing a wheel"));
                return;
            }
            beginPythonPackagePick(request);
            return;
        }
        if ("pythonPackage".equals(channel)) {
            executeAsync(
                request,
                () -> forward(runtimeClient, request, "runtime-service-unavailable"));
            return;
        }
        if ("runtimePack".equals(channel)
            && "pickAndInstall".equals(request.optString("method", ""))) {
            if (!hasUserConfirmation(request)) {
                deliver(BridgeProtocol.error(
                    request,
                    "confirmation-required",
                    "User confirmation is required before importing a Runtime Pack"));
                return;
            }
            beginRuntimePackPick(request);
            return;
        }
        if ("runtimePack".equals(channel)
            && "rollback".equals(request.optString("method", ""))) {
            executeAsync(
                request,
                () -> forward(runtimeClient, request, "runtime-service-unavailable"));
            return;
        }

        executeAsync(request, () -> dispatchLocal(request));
    }

    private void beginRuntimePackPick(JSONObject request) {
        if (runtimePackPicker == null || !runtimePackPicker.isAvailable()) {
            deliver(BridgeProtocol.error(
                request,
                "runtime-pack-picker-unavailable",
                "Android Runtime Pack document picker is unavailable"));
            return;
        }
        runtimePackPicker.pick(new RuntimePackPickerCallback() {
            @Override
            public void onPicked(String contentUri) {
                executeAsync(request, () -> {
                    try {
                        deliver(BridgeProtocol.success(
                            request,
                            runtimePackManager.installFromContentUri(contentUri, true)));
                    } catch (Exception error) {
                        deliver(BridgeProtocol.error(
                            request, "runtime-pack-install-failed", message(error)));
                    }
                });
            }

            @Override
            public void onCancelled() {
                try {
                    deliver(BridgeProtocol.success(request, new JSONObject()
                        .put("accepted", false)
                        .put("ok", false)
                        .put("status", "cancelled")));
                } catch (JSONException impossible) {
                    deliver(BridgeProtocol.error(
                        request, "runtime-pack-picker-cancelled", "Runtime Pack selection cancelled"));
                }
            }

            @Override
            public void onError(String detail) {
                deliver(BridgeProtocol.error(
                    request,
                    "runtime-pack-picker-failed",
                    detail == null || detail.isEmpty()
                        ? "Unable to open Runtime Pack document picker"
                        : detail));
            }
        });
    }

    private void beginPythonPackagePick(JSONObject request) {
        if (pythonPackagePicker == null || !pythonPackagePicker.isAvailable()) {
            deliver(BridgeProtocol.error(
                request,
                "python-package-picker-unavailable",
                "Android wheel document picker is unavailable"));
            return;
        }
        pythonPackagePicker.pick(new PythonPackagePickerCallback() {
            @Override
            public void onPicked(String contentUri) {
                executeAsync(request, () -> {
                    try {
                        JSONObject forwarded = new JSONObject(request.toString());
                        JSONObject original = forwarded.optJSONObject("payload");
                        JSONObject payload = original == null
                            ? new JSONObject()
                            : new JSONObject(original.toString());
                        payload.put("uri", contentUri == null ? "" : contentUri);
                        payload.put("confirmed", true);
                        forwarded.put("payload", payload);
                        forward(
                            runtimeClient,
                            forwarded,
                            "runtime-service-unavailable");
                    } catch (Exception error) {
                        deliver(BridgeProtocol.error(
                            request, "python-package-install-failed", message(error)));
                    }
                });
            }

            @Override
            public void onCancelled() {
                try {
                    deliver(BridgeProtocol.success(request, new JSONObject()
                        .put("accepted", false)
                        .put("ok", false)
                        .put("status", "cancelled")));
                } catch (JSONException impossible) {
                    deliver(BridgeProtocol.error(
                        request,
                        "python-package-picker-cancelled",
                        "Wheel selection cancelled"));
                }
            }

            @Override
            public void onError(String detail) {
                deliver(BridgeProtocol.error(
                    request,
                    "python-package-picker-failed",
                    detail == null || detail.isEmpty()
                        ? "Unable to open wheel document picker"
                        : detail));
            }
        });
    }

    /** Attach the native half of the WebMessagePort v2 transport. */
    public void attachMessagePort(WebMessagePort port) {
        WebMessagePort previous = messagePort;
        messagePort = port;
        if (previous != null && previous != port) previous.close();
    }

    @Override
    public void close() {
        if (closed) return;
        closed = true;
        if (workspace != null) workspace.removeListener(workspaceListener);
        if (runtimeClient != null) runtimeClient.close();
        if (languageClient != null) languageClient.close();
        if (dshClient != null) dshClient.close();
        if (projectIndex != null) projectIndex.close();
        WebMessagePort port = messagePort;
        messagePort = null;
        if (port != null) port.close();
        workspaceExecutor.shutdownNow();
    }

    private void showDshCredentialDialog(JSONObject request) {
        if (webView == null || !(webView.getContext() instanceof android.app.Activity)) {
            deliver(BridgeProtocol.error(request, "native-ui-unavailable", "原生凭据窗口不可用"));
            return;
        }
        executeAsync(request, () -> {
            try {
                JSONObject read = new JSONObject().put("protocolVersion", 2)
                    .put("id", "provider-prefill-" + java.util.UUID.randomUUID())
                    .put("channel", "dsh").put("method", "listProfiles").put("payload", new JSONObject());
                dshClient.request(read, response -> {
                    if (!response.optBoolean("ok")) {
                        deliver(BridgeProtocol.error(request, "provider-read-failed", "无法读取已保存配置，请重试"));
                        return;
                    }
                    JSONObject payload = response.optJSONObject("payload");
                    JSONArray profiles = payload == null ? null : payload.optJSONArray("profiles");
                    JSONObject profile = null;
                    if (profiles != null) for (int i = 0; i < profiles.length(); i++) {
                        JSONObject candidate = profiles.optJSONObject(i);
                        if (candidate != null && "direct-dsh".equals(candidate.optString("profileId"))) profile = candidate;
                    }
                    openDshCredentialDialog(request, profile);
                });
            } catch (JSONException failure) {
                deliver(BridgeProtocol.error(request, "provider-read-failed", "无法读取 Provider 配置"));
            }
        });
    }

    private void openDshCredentialDialog(JSONObject request, JSONObject profile) {
        webView.post(() -> {
            android.app.Activity activity = (android.app.Activity) webView.getContext();
            if (closed || activity.isFinishing()) return;
            DshProviderDialog.show(activity, profile, (payload, completed) -> executeAsync(request, () -> {
                try {
                    JSONObject nativeRequest = new JSONObject(request.toString())
                        .put("id", "provider-save-" + java.util.UUID.randomUUID())
                        .put("transportTimeoutMs", 60000).put("payload", payload);
                    dshClient.request(nativeRequest, response -> {
                        completed.accept(response);
                        JSONObject result = response.optJSONObject("payload");
                        if (response.optBoolean("ok") && result != null && result.optBoolean("saved")) {
                            try { deliver(BridgeProtocol.success(request, result)); }
                            catch (JSONException failure) {
                                deliver(BridgeProtocol.error(request, "provider-response-failed", "配置已保存，请刷新查看"));
                            }
                        }
                    });
                } catch (JSONException malformed) {
                    completed.accept(BridgeProtocol.error(request, "credential-save-failed", "无法保存配置，请重试"));
                }
            }), () -> deliver(BridgeProtocol.error(request, "cancelled", "已取消 Provider 配置")));
        });
    }

    private void dispatchLocal(JSONObject request) {
        try {
            String channel = request.getString("channel");
            String method = request.getString("method");
            JSONObject payload = request.optJSONObject("payload");
            if (payload == null) payload = new JSONObject();

            if ("draft".equals(channel)) {
                if (editorDrafts == null) {
                    deliver(BridgeProtocol.error(request, "draft-unavailable", "Draft storage is unavailable"));
                    return;
                }
                if (!"default".equals(payload.optString("workspaceId", "default"))) throw new IllegalArgumentException("Unknown draft workspace");
                Object result;
                if ("list".equals(method)) result = editorDrafts.list();
                else if ("read".equals(method)) result = editorDrafts.read(payload.getString("path"));
                else if ("write".equals(method)) result = editorDrafts.write(payload);
                else if ("delete".equals(method)) result = editorDrafts.delete(payload.getString("path"));
                else throw new IllegalArgumentException("Unknown draft method: " + method);
                deliver(BridgeProtocol.success(request, result));
                return;
            }

            if ("workspace".equals(channel)) {
                if (workspace == null) {
                    deliver(BridgeProtocol.error(
                        request, "workspace-unavailable", "Workspace repository is unavailable"));
                    return;
                }
                deliver(BridgeProtocol.success(
                    request, dispatchWorkspace(method, payload)));
                return;
            }
            if ("project".equals(channel)) {
                if (projectModelStore == null) {
                    deliver(BridgeProtocol.error(
                        request, "project-unavailable", "Project metadata store is unavailable"));
                    return;
                }
                deliver(BridgeProtocol.success(request, dispatchProject(method, payload)));
                return;
            }
            if ("index".equals(channel)) {
                if (projectIndex == null || workspace == null) {
                    deliver(BridgeProtocol.error(
                        request, "index-unavailable", "Project index is unavailable"));
                    return;
                }
                deliver(BridgeProtocol.success(request, dispatchIndex(method, payload)));
                return;
            }
            if ("language".equals(channel)
                && ("indexWorkspace".equals(method) || "workspaceSymbols".equals(method))) {
                if (projectIndex == null || workspace == null) {
                    deliver(BridgeProtocol.error(
                        request, "index-unavailable", "Project index is unavailable"));
                    return;
                }
                deliver(BridgeProtocol.success(request, dispatchIndex(method, payload)));
                return;
            }
            if ("runtimePack".equals(channel)) {
                if ("capabilities".equals(method)) {
                    JSONObject capabilities = runtimePackManager.capabilities();
                    boolean pickerAvailable = runtimePackPicker != null
                        && runtimePackPicker.isAvailable();
                    capabilities.put("pickerAvailable", pickerAvailable);
                    if (pickerAvailable) {
                        JSONArray methods = capabilities.optJSONArray("methods");
                        if (methods == null) {
                            methods = new JSONArray();
                            capabilities.put("methods", methods);
                        }
                        methods.put("pickAndInstall");
                    }
                    deliver(BridgeProtocol.success(request, capabilities));
                    return;
                }
                if ("install".equals(method)) {
                    deliver(BridgeProtocol.success(
                        request,
                        runtimePackManager.installFromContentUri(
                            payload.optString("uri", ""),
                            hasUserConfirmation(request))));
                    return;
                }
                if ("rollback".equals(method)) {
                    if (!hasUserConfirmation(request)) {
                        deliver(BridgeProtocol.success(request, new JSONObject()
                            .put("status", "confirmation-required")
                            .put("accepted", false)
                            .put("ok", false)
                            .put("packId", payload.optString("packId", ""))));
                        return;
                    }
                    deliver(BridgeProtocol.success(
                        request,
                        runtimePackManager.rollback(payload.getString("packId"))));
                    return;
                }
                deliver(BridgeProtocol.error(
                    request, "unknown-method", "Unknown Runtime Pack method: " + method));
                return;
            }
            deliver(BridgeProtocol.error(
                request, "unknown-channel", "Unknown native channel: " + channel));
        } catch (WorkspaceRepository.RevisionConflictException conflict) {
            try {
                JSONObject details = new JSONObject()
                    .put("path", conflict.path)
                    .put("expectedRevision", conflict.expectedRevision)
                    .put("actualRevision", conflict.actualRevision);
                deliver(BridgeProtocol.error(
                    request, "revision-conflict", conflict.getMessage(), details));
            } catch (JSONException impossible) {
                deliver(BridgeProtocol.error(
                    request, "revision-conflict", conflict.getMessage()));
            }
        } catch (WorkspaceRepository.HashConflictException conflict) {
            try {
                JSONObject details = new JSONObject()
                    .put("path", conflict.path)
                    .put("expectedSha256", conflict.expectedSha256)
                    .put("actualSha256", conflict.actualSha256);
                deliver(BridgeProtocol.error(
                    request, "hash-conflict", conflict.getMessage(), details));
            } catch (JSONException impossible) {
                deliver(BridgeProtocol.error(
                    request, "hash-conflict", conflict.getMessage()));
            }
        } catch (IOException error) {
            deliver(BridgeProtocol.error(request, "workspace-io-error", message(error)));
        } catch (Exception error) {
            deliver(BridgeProtocol.error(request, "native-request-error", message(error)));
        }
    }

    static boolean hasUserConfirmation(JSONObject request) {
        JSONObject payload = request == null ? null : request.optJSONObject("payload");
        return payload != null && Boolean.TRUE.equals(payload.opt("confirmed"));
    }

    private Object dispatchWorkspace(String method, JSONObject payload) throws Exception {
        String workspaceId = payload.optString("workspaceId", "default");
        if (!"default".equals(workspaceId)) {
            throw new IllegalArgumentException("Unknown workspace: " + workspaceId);
        }
        if ("list".equals(method)) {
            List<WorkspaceRepository.Summary> files = workspace.list();
            JSONArray fileResult = new JSONArray();
            for (WorkspaceRepository.Summary file : files) {
                fileResult.put(new JSONObject()
                    .put("path", file.path)
                    .put("size", file.size)
                    .put("revision", file.revision)
                    .put("sha256", file.sha256)
                    .put("updatedAt", file.updatedAt)
                    .put("editable", file.editable)
                    .put("kind", file.editable ? "text" : "binary")
                    .put("editorLimitBytes", WorkspaceRepository.MAX_EDITABLE_TEXT_BYTES));
            }
            JSONArray tombstoneResult = new JSONArray();
            for (WorkspaceRepository.Summary tombstone : workspace.tombstones()) {
                tombstoneResult.put(new JSONObject()
                    .put("path", tombstone.path)
                    .put("revision", tombstone.revision)
                    .put("updatedAt", tombstone.updatedAt));
            }
            return new JSONObject()
                .put("files", fileResult)
                .put("tombstones", tombstoneResult);
        }
        if ("read".equals(method)) {
            return entryJson(workspace.read(payload.getString("path")));
        }
        if ("write".equals(method)) {
            return entryJson(workspace.writeText(
                payload.getString("path"),
                payload.optString("content", ""),
                optionalRevision(payload),
                payload.optString("source", "webview")));
        }
        if ("delete".equals(method)) {
            String path = payload.getString("path");
            boolean deleted = workspace.delete(
                path,
                optionalRevision(payload),
                payload.optString("source", "webview"));
            return new JSONObject()
                .put("deleted", deleted)
                .put("path", path)
                .put("revision", workspace.revision(path));
        }
        if ("applyBatch".equals(method)) {
            JSONArray requested = payload.optJSONArray("files");
            if (requested == null || requested.length() == 0) {
                throw new IllegalArgumentException("A non-empty files array is required");
            }
            ArrayList<WorkspaceRepository.BatchWrite> writes = new ArrayList<>();
            for (int index = 0; index < requested.length(); index += 1) {
                JSONObject file = requested.getJSONObject(index);
                writes.add(new WorkspaceRepository.BatchWrite(
                    file.getString("path"),
                    file.optString("content", "").getBytes(StandardCharsets.UTF_8),
                    file.getLong("expectedRevision"),
                    file.optString("expectedSha256", ""),
                    file.optBoolean("delete", false)));
            }
            WorkspaceRepository.BatchResult result = workspace.applyBatch(
                payload.optString("transactionId", ""),
                writes,
                payload.optString("source", "dsh"));
            JSONArray files = new JSONArray();
            for (WorkspaceRepository.Entry entry : result.files) files.put(entryJson(entry));
            JSONArray deleted = new JSONArray();
            for (WorkspaceRepository.Summary entry : result.deleted) deleted.put(new JSONObject()
                .put("path", entry.path).put("revision", entry.revision).put("sha256", ""));
            return new JSONObject()
                .put("transactionId", result.transactionId)
                .put("files", files)
                .put("deleted", deleted);
        }
        throw new IllegalArgumentException("Unknown workspace method: " + method);
    }

    private Object dispatchProject(String method, JSONObject payload) throws Exception {
        if ("open".equals(method)) return projectModelStore.open();
        if ("save".equals(method)) return projectModelStore.save(payload.getJSONObject("model"));
        if ("listModules".equals(method)) {
            return new JSONObject().put("modules",
                projectModelStore.open().getJSONArray("modules"));
        }
        if ("getInterpreter".equals(method)) {
            JSONArray interpreters = projectModelStore.open().getJSONArray("interpreters");
            JSONObject selected = interpreters.length() == 0 ? null : interpreters.getJSONObject(0);
            for (int index = 0; index < interpreters.length(); index += 1) {
                if (interpreters.getJSONObject(index).optBoolean("selected", false)) {
                    selected = interpreters.getJSONObject(index);
                    break;
                }
            }
            return new JSONObject().put("interpreter", selected == null ? JSONObject.NULL : selected);
        }
        if ("listRunConfigurations".equals(method)) {
            return new JSONObject().put("configurations", projectModelStore.runConfigurations());
        }
        if ("saveRunConfigurations".equals(method)) {
            return new JSONObject().put("configurations",
                projectModelStore.saveRunConfigurations(payload.optJSONArray("configurations")));
        }
        throw new IllegalArgumentException("Unknown project method: " + method);
    }

    private Object dispatchIndex(String method, JSONObject payload) throws Exception {
        if ("status".equals(method)) return projectIndex.status();
        if ("indexWorkspace".equals(method)) return projectIndex.index(workspace);
        if ("search".equals(method)) {
            return new JSONObject().put("results", projectIndex.search(
                payload.optString("query", ""), payload.optInt("limit", 100)));
        }
        if ("symbols".equals(method)) {
            return new JSONObject().put("symbols", projectIndex.symbols(
                payload.optString("uri", payload.optString("path", ""))));
        }
        if ("workspaceSymbols".equals(method)) {
            String uri = payload.optString("uri", payload.optString("path", ""));
            return new JSONObject().put("symbols", uri.isEmpty()
                ? projectIndex.workspaceSymbols()
                : projectIndex.symbols(uri));
        }
        if ("definition".equals(method)) {
            JSONObject result = projectIndex.definition(
                workspace,
                payload.optString("uri", payload.optString("path", "")),
                payload.optJSONObject("position") == null
                    ? new JSONObject() : payload.optJSONObject("position"));
            return new JSONObject().put("definition", result == null ? JSONObject.NULL : result);
        }
        if ("contextForRequest".equals(method)) {
            return new JSONObject().put("paths", projectIndex.contextFor(
                payload.optString("uri", payload.optString("path", ""))));
        }
        throw new IllegalArgumentException("Unknown index method: " + method);
    }

    private void forward(
        ServiceMessengerClient client,
        JSONObject request,
        String unavailableCode
    ) {
        if (client == null) {
            deliver(BridgeProtocol.error(
                request, unavailableCode, "Native host service is unavailable"));
            return;
        }
        client.request(request, this::deliver);
    }

    private void executeAsync(JSONObject request, Runnable action) {
        try {
            workspaceExecutor.execute(action);
        } catch (RejectedExecutionException closedExecutor) {
            deliver(BridgeProtocol.error(
                request, "bridge-closed", "The native bridge is already closed"));
        }
    }

    private void postWorkspaceEvent(WorkspaceRepository.Change change) {
        try {
            JSONObject event = new JSONObject()
                .put("protocolVersion", BridgeProtocol.VERSION)
                .put("type", "event")
                .put("channel", "workspace")
                .put("event", new JSONObject()
                    .put("type", change.type)
                    .put("path", change.path)
                    .put("revision", change.revision)
                    .put("sha256", change.sha256)
                    .put("size", change.size)
                    .put("editable", change.editable)
                    .put("kind", change.editable ? "text" : "binary")
                    .put("source", change.source)
                    .put("requestId", "")
                    .put("streamId", "")
                    .put("sessionId", "workspace")
                    .put("epoch", 0)
                    .put("workspaceId", "default")
                    .put("uri", "file:///workspace/" + change.path)
                    .put("bufferVersion", 0));
            deliver(event);
        } catch (JSONException ignored) {
        }
    }

    private void postServiceLifecycleEvent(String channel, String state, String detail) {
        String type;
        if ("reconnected".equals(state) || "connected".equals(state)) {
            type = "reconnected".equals(state) ? "service-reconnected" : "service-connected";
        } else {
            type = "service-crashed";
        }
        try {
            deliver(BridgeProtocol.event(channel, new JSONObject()
                .put("type", type)
                .put("state", state)
                .put("message", detail == null ? "" : detail)
                .put("recoverable", true)
                .put("requestId", "")
                .put("streamId", "")
                .put("sessionId", channel + "-service")
                .put("epoch", 0)
                .put("workspaceId", "default")
                .put("uri", "")
                .put("bufferVersion", 0)));
        } catch (JSONException ignored) {
        }
    }

    private void deliver(JSONObject response) {
        if (closed || webView == null) return;
        String json = response == null ? "{}" : response.toString();
        WebMessagePort port = messagePort;
        if (port != null) {
            webView.post(() -> {
                if (closed || messagePort != port) return;
                try {
                    port.postMessage(new WebMessage(json));
                } catch (IllegalStateException portClosed) {
                    if (messagePort == port) messagePort = null;
                }
            });
            return;
        }
        String script = "window.PythonANative&&window.PythonANative.onMessage(JSON.parse("
            + JSONObject.quote(json) + "));";
        webView.post(() -> {
            if (!closed) webView.evaluateJavascript(script, null);
        });
    }

    private static JSONObject entryJson(WorkspaceRepository.Entry entry) throws JSONException {
        return new JSONObject()
            .put("path", entry.path)
            .put("content", entry.text())
            .put("revision", entry.revision)
            .put("sha256", entry.sha256)
            .put("updatedAt", entry.updatedAt)
            .put("size", entry.size)
            .put("editable", entry.editable)
            .put("kind", entry.editable ? "text" : "binary");
    }

    private static Long optionalRevision(JSONObject payload) throws JSONException {
        if (!payload.has("expectedRevision") || payload.isNull("expectedRevision")) return null;
        return payload.getLong("expectedRevision");
    }

    private static String message(Exception error) {
        String value = error.getMessage();
        return value == null || value.isEmpty() ? error.getClass().getSimpleName() : value;
    }
}
