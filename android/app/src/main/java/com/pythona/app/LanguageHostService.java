package com.pythona.app;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/** Single-worker Jedi/Parso language service in the isolated :language process. */
public final class LanguageHostService extends BaseHostService {
    private final Object engineLock = new Object();
    private final ConcurrentHashMap<String, String> semanticRequestByTransportId =
        new ConcurrentHashMap<>();
    private final Set<String> cancelledTransportIds = ConcurrentHashMap.newKeySet();
    private final AtomicInteger activeCalls = new AtomicInteger();

    private PythonRuntimeInstaller runtimeInstaller;
    private PurePythonWheelManager purePythonWheelManager;
    private RuntimePackManager runtimePackManager;
    private volatile PythonEngine engine;

    @Override
    public void onCreate() {
        super.onCreate();
        runtimeInstaller = new PythonRuntimeInstaller(this);
        purePythonWheelManager = new PurePythonWheelManager(this);
        runtimePackManager = new RuntimePackManager(this);
    }

    @Override
    public void onDestroy() {
        PythonEngine current = engine;
        if (current != null && activeCalls.get() == 0) current.close();
        semanticRequestByTransportId.clear();
        cancelledTransportIds.clear();
        super.onDestroy();
    }

    @Override
    protected boolean isConcurrentControlMethod(String method) {
        return "$/cancelRequest".equals(method) || "cancel".equals(method);
    }

    @Override
    protected JSONObject handleRequest(
        String method,
        JSONObject payload,
        JSONObject request
    ) throws Exception {
        if ("$/cancelRequest".equals(method) || "cancel".equals(method)) {
            return cancel(payload);
        }
        if ("didSave".equals(method) || "saveDocument".equals(method)) {
            // didChange already carries every formal buffer update. didSave is
            // an acknowledgement boundary and must not create a duplicate Jedi
            // document version.
            return identityResponse(payload, new JSONObject().put("saved", true));
        }

        JSONObject enriched = new JSONObject(payload.toString());
        {
            String workspaceId = enriched.optString("workspaceId", "default");
            WorkspaceRepository workspace = WorkspaceRepository.readOnly(
                getFilesDir(), workspaceId);
            enriched.put("workspaceRoot", workspace.rootDirectory().getCanonicalPath());
        }
        if (!enriched.has("requestId") && request.has("id")) {
            enriched.put("requestId", request.optString("id", ""));
        }

        String transportId = request.optString("id", "");
        String semanticId = enriched.optString("requestId", transportId);
        semanticRequestByTransportId.put(transportId, semanticId);
        PythonEngine current = ensureEngine();
        if (cancelledTransportIds.remove(transportId)) current.cancelRequest(semanticId);

        JSONObject nativeRequest = new JSONObject()
            .put("method", normalizeMethod(method))
            .put("payload", enriched);
        activeCalls.incrementAndGet();
        try {
            return new JSONObject(current.callJson(nativeRequest.toString()));
        } finally {
            activeCalls.decrementAndGet();
            semanticRequestByTransportId.remove(transportId);
            cancelledTransportIds.remove(transportId);
        }
    }

    private JSONObject cancel(JSONObject payload) throws Exception {
        String requested = payload.optString(
            "requestId", payload.optString("id", ""));
        if (requested.isEmpty()) {
            throw new IllegalArgumentException("Cancellation requestId is required");
        }
        String semantic = semanticRequestByTransportId.get(requested);
        if (semantic == null) {
            if (cancelledTransportIds.size() >= 1024) cancelledTransportIds.clear();
            cancelledTransportIds.add(requested);
            semantic = requested;
        }
        PythonEngine current = engine;
        if (current != null) {
            current.cancelRequest(semantic);
            if (!semantic.equals(requested)) current.cancelRequest(requested);
        }
        return new JSONObject()
            .put("cancelled", true)
            .put("requestId", requested)
            .put("semanticRequestId", semantic);
    }

    private PythonEngine ensureEngine() throws Exception {
        PythonEngine current = engine;
        if (current != null) return current;
        synchronized (engineLock) {
            current = engine;
            if (current != null) return current;
            PythonRuntimeInstaller.Layout layout = runtimeInstaller.ensureInstalled();
            PurePythonWheelManager.RuntimeEnvironment wheelEnvironment =
                purePythonWheelManager.prepareRuntimeEnvironment(
                    PurePythonWheelManager.DEFAULT_ENVIRONMENT);
            ArrayList<File> importPaths = new ArrayList<>(layout.languageImportPaths());
            importPaths.addAll(runtimePackManager.activeLanguageImportPaths());
            importPaths.addAll(wheelEnvironment.pythonImportPaths);
            PythonEngine created = new PythonEngine(PythonEngine.NO_OP_LISTENER);
            try {
                created.initialize(new PythonEngine.Configuration(
                    layout.home,
                    layout.temporaryDirectory,
                    importPaths));
            } catch (Exception error) {
                created.close();
                throw error;
            } catch (LinkageError error) {
                created.close();
                throw error;
            }
            engine = created;
            return created;
        }
    }

    static String normalizeMethod(String method) {
        if (method == null) return "";
        if (method.startsWith("language/")) method = method.substring("language/".length());
        if ("openDocument".equals(method)) return "didOpen";
        if ("changeDocument".equals(method)) return "didChange";
        if ("closeDocument".equals(method)) return "didClose";
        if ("complete".equals(method)) return "completion";
        if ("resolveCompletion".equals(method)) return "completionItem/resolve";
        if ("documentSymbols".equals(method)) return "documentSymbol";
        if ("findReferences".equals(method)) return "references";
        if ("renameSymbol".equals(method)) return "rename";
        if ("publishDiagnostics".equals(method)) return "diagnose";
        return method;
    }

    private static JSONObject identityResponse(JSONObject payload, Object result)
        throws Exception {
        JSONObject response = new JSONObject().put("result", result);
        copy(payload, response, "requestId", "requestId");
        copy(payload, response, "epoch", "epoch");
        copy(payload, response, "uri", "uri");
        if (payload.has("bufferVersion")) {
            copy(payload, response, "bufferVersion", "bufferVersion");
        } else {
            copy(payload, response, "version", "bufferVersion");
        }
        return response;
    }

    private static void copy(
        JSONObject source,
        JSONObject target,
        String sourceKey,
        String targetKey
    ) throws Exception {
        if (source.has(sourceKey) && !source.isNull(sourceKey)) {
            target.put(targetKey, source.get(sourceKey));
        }
    }
}
