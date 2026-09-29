package com.pythona.app;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Real embedded-CPython runtime control plane.
 *
 * <p>The Messenger request worker never executes user code. A dedicated
 * execution thread owns blocking {@link PythonEngine#runFile}; input and stop
 * remain concurrent control calls on the IPC looper.</p>
 */
public final class RuntimeHostService extends BaseHostService {
    private static final String PACK_PROBE_PREFIX = "pack-probe-";
    private static final long PACK_PROBE_TIMEOUT_SECONDS = 45L;
    private static final long STOP_RETRY_DELAY_MILLIS = 10L;
    private static final long STOP_WATCHDOG_DELAY_MILLIS = 3_000L;

    private final Object engineLock = new Object();
    private final AtomicReference<String> activeRun = new AtomicReference<>();
    private final AtomicBoolean environmentChangeInProgress = new AtomicBoolean();
    private final ConcurrentHashMap<String, Boolean> stopRequested =
        new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, JSONObject> runIdentities =
        new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, List<String>> runSecrets =
        new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Boolean> testTimeouts =
        new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, TestTask> testRuns =
        new ConcurrentHashMap<>();

    private RuntimePackManager runtimePackManager;
    private PurePythonWheelManager purePythonWheelManager;
    private PythonRuntimeInstaller runtimeInstaller;
    private ExecutorService executionExecutor;
    private ExecutorService activationProbeExecutor;
    private Handler restartHandler;
    private RuntimeOutputBuffer outputBuffer;
    private volatile PythonEngine engine;
    private volatile String initializationError;
    private volatile boolean restartScheduled;

    @Override
    public void onCreate() {
        super.onCreate();
        runtimePackManager = new RuntimePackManager(this);
        purePythonWheelManager = new PurePythonWheelManager(this);
        runtimeInstaller = new PythonRuntimeInstaller(this);
        executionExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "PythonA.runtime.execution");
            thread.setDaemon(true);
            return thread;
        });
        activationProbeExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "PythonA.runtime.pack-probe");
            thread.setDaemon(true);
            return thread;
        });
        restartHandler = new Handler(Looper.getMainLooper());
        outputBuffer = new RuntimeOutputBuffer(this::emitOutputEvent);
    }

    @Override
    public void onDestroy() {
        String runId = activeRun.get();
        PythonEngine current = engine;
        if (runId != null && current != null) {
            try {
                current.stop(runId);
            } catch (RuntimeException ignored) {
            }
        }
        if (executionExecutor != null) executionExecutor.shutdownNow();
        if (activationProbeExecutor != null) activationProbeExecutor.shutdownNow();
        runIdentities.clear();
        runSecrets.clear();
        testTimeouts.clear();
        testRuns.clear();
        if (restartHandler != null) restartHandler.removeCallbacksAndMessages(null);
        if (outputBuffer != null) outputBuffer.close();
        // close() waits for the execution lock, so only perform it synchronously
        // when no user script is active. A killed :runtime process releases all
        // remaining native state in the active case.
        if (runId == null && current != null) current.close();
        super.onDestroy();
    }

    @Override
    protected boolean isConcurrentControlMethod(String method) {
        return isConcurrentRuntimeMethod(method);
    }

    /**
     * Admit a run on the IPC looper before a following stop can overtake it.
     * The blocking Python call still runs exclusively on executionExecutor.
     */
    static boolean isConcurrentRuntimeMethod(String method) {
        return "runFile".equals(method)
            || "runConfiguration".equals(method)
            || "run".equals(method)
            || "test.run".equals(method)
            || "test.cancel".equals(method)
            || "cancel".equals(method)
            || "sendInput".equals(method)
            || "stop".equals(method)
            || "$/cancelRequest".equals(method);
    }

    @Override
    protected JSONObject handleRequest(
        String method,
        JSONObject payload,
        JSONObject request
    ) throws Exception {
        String channel = request.optString("channel", "");
        if ("test".equals(channel)) {
            if ("capabilities".equals(method)) return testCapabilities();
            if ("discover".equals(method)) return discoverTests(withTransportIdentity(payload, request));
            if ("run".equals(method) || "test.run".equals(method)) {
                return startTest(withTransportIdentity(payload, request));
            }
            if ("cancel".equals(method) || "test.cancel".equals(method)) {
                return cancelTest(payload);
            }
        }
        if ("pythonPackage".equals(channel)) {
            return handlePythonPackageRequest(method, payload);
        }
        if ("runtimePack".equals(channel) && "rollback".equals(method)) {
            return rollbackPack(payload);
        }
        if ("capabilities".equals(method)) return capabilities();
        if ("runFile".equals(method)) return startRun(withTransportIdentity(payload, request));
        if ("runConfiguration".equals(method)) {
            return startRunConfiguration(withTransportIdentity(payload, request));
        }
        if ("sendInput".equals(method)) return sendInput(payload);
        if ("stop".equals(method) || "$/cancelRequest".equals(method)) {
            if (testRuns.containsKey(payload.optString("runId", ""))) return cancelTest(payload);
            return stop(payload);
        }
        if ("listPackages".equals(method)) return listPackages(payload);
        if ("activatePack".equals(method)) {
            return activatePack(payload);
        }
        if ("run".equals(method)) {
            throw new IllegalArgumentException(
                "PythonA provides runFile/Python Console, not a Bash command runner");
        }
        throw new IllegalArgumentException("Unknown runtime method: " + method);
    }

    private JSONObject capabilities() {
        boolean available = false;
        String reason = null;
        try {
            ensureEngine();
            available = true;
            initializationError = null;
        } catch (Throwable error) {
            initializationError = message(error);
            reason = "runtime-initialization-failed";
        }

        try {
            JSONArray methods = new JSONArray()
                .put("capabilities")
                .put("runFile")
                .put("runConfiguration")
                .put("test.capabilities")
                .put("test.discover")
                .put("test.run")
                .put("test.cancel")
                .put("sendInput")
                .put("stop")
                .put("listPackages")
                .put("activatePack");
            JSONObject features = new JSONObject()
                .put("execution", available)
                .put("runFile", available)
                .put("runConfiguration", available)
                .put("tests", available)
                .put("test", available)
                .put("testDiscover", available)
                .put("testRun", available)
                .put("testCancel", available)
                .put("input", available)
                .put("sendInput", available)
                .put("stop", available)
                .put("activatePack", true)
                .put("bash", false)
                .put("pty", false)
                .put("subprocess", false)
                .put("multiprocessing", false)
                .put("cuda", false);
            JSONObject result = new JSONObject()
                .put("protocolVersion", BridgeProtocol.VERSION)
                .put("mode", "embedded-cpython")
                .put("available", available)
                .put("python", "CPython " + PythonRuntimeInstaller.PYTHON_VERSION)
                .put("pythonAbi", PythonRuntimeInstaller.PYTHON_ABI_TAG)
                .put("runtimeAbi", PythonRuntimeInstaller.PYTHON_ABI)
                .put("abi", "arm64-v8a")
                .put("terminal", "Python Console (no Bash/PTTY)")
                .put("network", false)
                .put("pytorch", "实验包不可用")
                .put("methods", methods)
                .put("features", features)
                .put("runtimePacks", runtimePackManager.capabilities())
                .put("purePythonPackages", purePythonWheelManager.capabilities())
                .put("test", testCapabilities());
            if (!available) {
                result.put("reason", reason);
                result.put("detail", initializationError == null ? "unknown" : initializationError);
            }
            return result;
        } catch (Exception impossible) {
            return new JSONObject();
        }
    }

    private JSONObject startRun(JSONObject payload) throws Exception {
        if (restartScheduled || environmentChangeInProgress.get()) {
            throw new IllegalStateException(
                "Runtime restart is pending after an environment change");
        }
        String runId = requireIdentifier(payload.optString("runId", ""), "runId");
        String workspaceId = payload.optString("workspaceId", "default");
        String environmentId = payload.optString(
            "environmentId", payload.optString("environment", "default"));
        if (!"default".equals(environmentId)) {
            throw new IllegalArgumentException("Unknown Python environment: " + environmentId);
        }
        WorkspaceRepository workspace = WorkspaceRepository.readOnly(getFilesDir(), workspaceId);
        String relativePath = WorkspaceRepository.normalizeRelativePath(
            payload.optString("path", payload.optString("file", "")));
        File script = new File(workspace.rootDirectory(), relativePath);

        ArrayList<String> arguments = new ArrayList<>();
        JSONArray rawArguments = payload.optJSONArray("args");
        if (rawArguments != null) {
            for (int index = 0; index < rawArguments.length(); index += 1) {
                arguments.add(rawArguments.getString(index));
            }
        }
        String workingDirectory = payload.optString("workingDirectory", payload.optString("cwd", "/"));
        Map<String, String> environment = new LinkedHashMap<>();
        JSONObject rawEnvironment = payload.optJSONObject("environment");
        if (rawEnvironment == null) rawEnvironment = payload.optJSONObject("env");
        if (rawEnvironment != null) {
            java.util.Iterator<String> names = rawEnvironment.keys();
            while (names.hasNext()) {
                String name = names.next();
                if (!name.matches("[A-Za-z_][A-Za-z0-9_]*")) {
                    throw new IllegalArgumentException("Invalid environment variable name");
                }
                environment.put(name, rawEnvironment.getString(name));
            }
        }
        ArrayList<String> envFiles = new ArrayList<>();
        JSONArray rawEnvFiles = payload.optJSONArray("envFiles");
        if (rawEnvFiles != null) {
            for (int index = 0; index < rawEnvFiles.length(); index += 1) {
                envFiles.add(WorkspaceRepository.normalizeRelativePath(rawEnvFiles.getString(index)));
            }
        }
        // Values loaded by the Python host from .env files never cross this
        // admission method as a map. Read only the sensitive assignments here
        // so terminal/error events can redact them just like explicit config
        // values; the file contents themselves never enter the event payload.
        ArrayList<String> secrets = new ArrayList<>();
        collectEnvironmentFileSecrets(workspace, envFiles, secrets);
        for (Map.Entry<String, String> item : environment.entrySet()) {
            addSensitiveEnvironmentValue(item.getKey(), item.getValue(), secrets);
        }
        if (!activeRun.compareAndSet(null, runId)) {
            throw new IllegalStateException("Another Python run is already active");
        }
        runIdentities.put(runId, runtimeIdentity(payload, runId, relativePath));
        if (!secrets.isEmpty()) runSecrets.put(runId, secrets);
        // Close the admission race with a wheel installation which may have
        // claimed the environment-change guard after the first check.
        if (restartScheduled || environmentChangeInProgress.get()) {
            activeRun.compareAndSet(runId, null);
            runIdentities.remove(runId);
            runSecrets.remove(runId);
            throw new IllegalStateException(
                "Runtime restart is pending after an environment change");
        }
        stopRequested.remove(runId);
        try {
            executionExecutor.execute(
                () -> executeRun(runId, workspace.rootDirectory(), script, arguments,
                    workingDirectory, environment, envFiles));
        } catch (RejectedExecutionException stopping) {
            activeRun.compareAndSet(runId, null);
            runIdentities.remove(runId);
            runSecrets.remove(runId);
            throw new IllegalStateException("Runtime service is stopping", stopping);
        }
        return new JSONObject()
            .put("accepted", true)
            .put("started", true)
            .put("runId", runId);
    }

    private static final class TestTask {
        final String framework;
        final long startedAt = android.os.SystemClock.elapsedRealtime();
        final AtomicBoolean terminal = new AtomicBoolean();
        TestTask(String framework) { this.framework = framework; }
    }

    private volatile JSONObject cachedTestCapabilities;

    private JSONObject testCapabilities() throws Exception {
        JSONObject cached = cachedTestCapabilities;
        if (activeRun.get() != null) {
            if (cached != null) return new JSONObject(cached.toString()).put("busy", true);
            return new JSONObject().put("available", false).put("reason", "runtime-busy")
                .put("methods", new JSONArray());
        }
        try {
            JSONObject response = new JSONObject(ensureEngine().testJson(null,
                new JSONObject().put("method", "capabilities").put("payload", new JSONObject()).toString()));
            JSONObject result = requireTestResult(response);
            cachedTestCapabilities = result;
            return new JSONObject(result.toString());
        } catch (Throwable error) {
            return new JSONObject().put("available", false).put("methods", new JSONArray())
                .put("reason", "test-capability-failed").put("detail", message(error));
        }
    }

    static JSONObject requireTestResult(JSONObject response) throws Exception {
        if (response.has("error")) throw new IllegalStateException(
            response.optString("code", "test-host-error") + ": " + response.optString("error"));
        JSONObject result = response.optJSONObject("result");
        if (result == null || result.has("error")) throw new IllegalStateException("Invalid test host result");
        return result;
    }

    private JSONObject discoverTests(JSONObject payload) throws Exception {
        String token = "discovery-" + UUID.randomUUID();
        admitTestSlot(token);
        try {
            WorkspaceRepository workspace = WorkspaceRepository.readOnly(getFilesDir(), payload.optString("workspaceId", "default"));
            JSONObject options = new JSONObject(payload.toString()).put("workspaceRoot", workspace.rootDirectory().getCanonicalPath());
            return requireTestResult(new JSONObject(ensureEngine().testJson(null,
                new JSONObject().put("method", "discover").put("payload", options).toString())));
        } finally {
            activeRun.compareAndSet(token, null);
        }
    }

    private void admitTestSlot(String runId) {
        if (restartScheduled || environmentChangeInProgress.get()) {
            throw new IllegalStateException("Runtime environment change is in progress");
        }
        if (!activeRun.compareAndSet(null, runId)) {
            throw new IllegalStateException("Another Python run or test task is already active");
        }
        if (restartScheduled || environmentChangeInProgress.get()) {
            activeRun.compareAndSet(runId, null);
            throw new IllegalStateException("Runtime environment change is in progress");
        }
    }

    private JSONObject startTest(JSONObject input) throws Exception {
        JSONObject payload = new JSONObject(input.toString());
        String runId = requireIdentifier(payload.optString("runId", ""), "runId");
        WorkspaceRepository workspace = WorkspaceRepository.readOnly(getFilesDir(), payload.optString("workspaceId", "default"));
        JSONArray args = payload.optJSONArray("args");
        if (payload.has("args") && args == null) throw new IllegalArgumentException("Test args must be an array");
        if (args != null) for (int i = 0; i < args.length(); i++) {
            if (!(args.get(i) instanceof String)) throw new IllegalArgumentException("Test args must be strings");
        }
        JSONArray paths = payload.optJSONArray("paths");
        if (paths != null) for (int i = 0; i < paths.length(); i++) WorkspaceRepository.normalizeRelativePath(paths.getString(i));
        if (!payload.optString("path", "").isEmpty()) WorkspaceRepository.normalizeRelativePath(payload.getString("path"));
        ArrayList<String> envFiles = new ArrayList<>();
        JSONArray rawFiles = payload.optJSONArray("envFiles");
        if (rawFiles != null) for (int i = 0; i < rawFiles.length(); i++)
            envFiles.add(WorkspaceRepository.normalizeRelativePath(rawFiles.getString(i)));
        ArrayList<String> secrets = new ArrayList<>();
        collectEnvironmentFileSecrets(workspace, envFiles, secrets);
        JSONObject env = payload.optJSONObject("environment");
        if (env != null) {
            java.util.Iterator<String> keys = env.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                if (!name.matches("[A-Za-z_][A-Za-z0-9_]*") || !(env.get(name) instanceof String))
                    throw new IllegalArgumentException("Invalid test environment assignment");
                addSensitiveEnvironmentValue(name, env.getString(name), secrets);
            }
        }
        String framework = payload.optString("framework", "auto");
        if (!framework.matches("auto|pytest|unittest")) throw new IllegalArgumentException("Invalid test framework");
        if (!"unittest".equals(framework)) framework = cachedTestCapabilities == null
            ? "pytest" : cachedTestCapabilities.optString("framework", "pytest");
        JSONObject identity = runtimeIdentity(payload, runId, payload.optString("path", ""));
        admitTestSlot(runId);
        runIdentities.put(runId, identity);
        if (!secrets.isEmpty()) runSecrets.put(runId, secrets);
        TestTask task = new TestTask(framework);
        testRuns.put(runId, task);
        stopRequested.remove(runId);
        testTimeouts.remove(runId);
        emitTestEvent(new JSONObject().put("type", "started").put("runId", runId).put("framework", framework));
        try {
            executionExecutor.execute(() -> executeTest(runId, workspace.rootDirectory(), payload));
        } catch (RejectedExecutionException stopping) {
            testRuns.remove(runId); runIdentities.remove(runId); runSecrets.remove(runId);
            activeRun.compareAndSet(runId, null);
            throw new IllegalStateException("Runtime service is stopping", stopping);
        }
        long timeout = payload.optLong("timeoutMillis", 0L);
        if (timeout > 0 && restartHandler != null) restartHandler.postDelayed(() -> {
            if (testRuns.get(runId) != task || task.terminal.get()) return;
            testTimeouts.put(runId, Boolean.TRUE);
            requestTestStop(runId);
        }, Math.min(timeout, 24L * 60L * 60L * 1000L));
        return new JSONObject().put("accepted", true).put("runId", runId);
    }

    private void requestTestStop(String runId) {
        if (!testRuns.containsKey(runId) || !runId.equals(activeRun.get())) return;
        stopRequested.put(runId, Boolean.TRUE);
        PythonEngine current = engine;
        if (current != null) {
            current.cancelRequest(runId);
            if (!current.stop(runId)) scheduleStopRetry(runId);
        }
        scheduleTestWatchdog(runId);
    }

    private JSONObject cancelTest(JSONObject payload) throws Exception {
        String runId = requireIdentifier(payload.optString("runId", payload.optString("requestId", "")), "runId");
        boolean matches = testRuns.containsKey(runId) && runId.equals(activeRun.get());
        if (matches) requestTestStop(runId);
        return new JSONObject().put("accepted", matches).put("cancellationRequested", matches)
            .put("terminal", false).put("runId", runId);
    }

    private JSONObject testTerminalResult(String runId, String status, String detail) throws Exception {
        TestTask task = testRuns.get(runId);
        return new JSONObject().put("framework", task == null ? "pytest" : task.framework)
            .put("status", status).put("counts", new JSONObject().put("collected", 0).put("passed", 0)
                .put("failed", 0).put("skipped", 0).put("errors", "error".equals(status) ? 1 : 0))
            .put("cases", new JSONArray()).put("truncated", true)
            .put("durationMillis", task == null ? 0 : android.os.SystemClock.elapsedRealtime() - task.startedAt)
            .put("message", detail);
    }

    private void scheduleTestWatchdog(String runId) {
        Handler handler = restartHandler;
        TestTask task = testRuns.get(runId);
        if (handler == null || task == null) return;
        handler.postDelayed(() -> {
            if (testRuns.get(runId) != task || task.terminal.get() || !stopRequested.containsKey(runId)) return;
            restartScheduled = true; // reject new admissions until this process dies
            try {
                JSONObject result = testTerminalResult(runId,
                    testTimeouts.containsKey(runId) ? "timeout" : "cancelled",
                    "Runtime restart required after the test did not respond to interruption");
                result.put("restartRequired", true);
                finishTest(runId, result);
            } catch (Exception ignored) { }
            // Allow the bounded terminal Binder message to leave the process.
            handler.postDelayed(() -> Process.killProcess(Process.myPid()), 150L);
        }, STOP_WATCHDOG_DELAY_MILLIS);
    }

    private void executeTest(String runId, File workspaceRoot, JSONObject payload) {
        try {
            PythonEngine current = ensureEngine();
            if (stopRequested.containsKey(runId)) {
                finishTest(runId, testTerminalResult(runId,
                    testTimeouts.containsKey(runId) ? "timeout" : "cancelled", "Stopped before test execution"));
                return;
            }
            JSONObject options = new JSONObject(payload.toString()).put("workspaceRoot", workspaceRoot.getCanonicalPath());
            JSONObject result = requireTestResult(new JSONObject(current.testJson(runId,
                new JSONObject().put("method", "run").put("payload", options).toString())));
            if (testTimeouts.containsKey(runId)) result.put("status", "timeout");
            else if (stopRequested.containsKey(runId)) result.put("status", "cancelled");
            result.put("stdout", redactRuntimeOutput(runId, result.optString("stdout", "")));
            result.put("stderr", redactRuntimeOutput(runId, result.optString("stderr", "")));
            JSONArray cases = result.optJSONArray("cases");
            if (cases != null) for (int i = 0; i < cases.length(); i++) {
                JSONObject item = cases.getJSONObject(i);
                item.put("message", redactRuntimeOutput(runId, item.optString("message", "")));
                item.put("traceback", redactRuntimeOutput(runId, item.optString("traceback", "")));
            }
            finishTest(runId, result);
        } catch (Throwable error) {
            try {
                String status = testTimeouts.containsKey(runId) ? "timeout"
                    : stopRequested.containsKey(runId) ? "cancelled" : "error";
                finishTest(runId, testTerminalResult(runId, status, redactRuntimeOutput(runId, message(error))));
            } catch (Exception ignored) { }
        } finally {
            testTimeouts.remove(runId); stopRequested.remove(runId);
            activeRun.compareAndSet(runId, null);
            runIdentities.remove(runId); runSecrets.remove(runId); testRuns.remove(runId);
        }
    }

    private void finishTest(String runId, JSONObject result) {
        TestTask task = testRuns.get(runId);
        if (task == null || !task.terminal.compareAndSet(false, true)) return;
        emitAfterPendingOutput(() -> {
            try {
                emitTestEvent(new JSONObject().put("type", "finished").put("runId", runId).put("result", result));
            } catch (Exception ignored) { }
        });
    }

    private void emitTestOutput(String runId, String stream, String text) {
        TestTask task = testRuns.get(runId);
        if (task == null) return;
        try {
            emitTestEvent(new JSONObject().put("type", "output").put("runId", runId)
                .put("stream", "stderr".equals(stream) ? "stderr" : "stdout")
                .put("text", redactRuntimeOutput(runId, text == null ? "" : text)));
        } catch (Exception ignored) { }
    }

    private void emitTestEvent(JSONObject event) {
        try {
            String runId = event.optString("runId", "");
            for (String key : new String[]{"requestId", "streamId", "sessionId", "epoch", "workspaceId", "uri", "bufferVersion"})
                event.put(key, identityValue(runId, key));
            emitEvent("test", event);
        } catch (Exception ignored) { }
    }

    private static void collectEnvironmentFileSecrets(
        WorkspaceRepository workspace,
        List<String> envFiles,
        List<String> secrets
    ) {
        for (String path : envFiles) {
            try {
                String text = workspace.read(path).text();
                for (String rawLine : text.split("\\r?\\n")) {
                    String line = rawLine.trim();
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    int equals = line.indexOf('=');
                    if (equals <= 0) continue;
                    String name = line.substring(0, equals).trim();
                    String value = line.substring(equals + 1).trim();
                    if (value.length() >= 2
                        && ((value.startsWith("\"") && value.endsWith("\""))
                            || (value.startsWith("'") && value.endsWith("'")))) {
                        value = value.substring(1, value.length() - 1);
                    }
                    addSensitiveEnvironmentValue(name, value, secrets);
                }
            } catch (Exception ignored) {
                // The Python host will report a missing/malformed env file;
                // redaction collection must not change run admission behavior.
            }
        }
    }

    private static void addSensitiveEnvironmentValue(
        String name,
        String value,
        List<String> secrets
    ) {
        String lower = name == null ? "" : name.toLowerCase(java.util.Locale.ROOT);
        if (value != null && value.length() >= 4
            && (lower.contains("key") || lower.contains("token") || lower.contains("secret")
                || lower.contains("password") || lower.contains("credential")
                || lower.contains("auth"))) {
            if (!secrets.contains(value)) secrets.add(value);
        }
    }

    private JSONObject startRunConfiguration(JSONObject payload) throws Exception {
        JSONObject configuration = payload.optJSONObject("configuration");
        if (configuration == null) throw new IllegalArgumentException("Run configuration is required");
        JSONObject resolved = new JSONObject()
            .put("runId", payload.optString("runId", ""))
            .put("workspaceId", payload.optString("workspaceId", "default"))
            .put("requestId", payload.optString("requestId", ""))
            .put("streamId", payload.optString("streamId", payload.optString("runId", "")))
            .put("sessionId", payload.optString("sessionId", ""))
            .put("epoch", payload.optLong("epoch", 0))
            .put("uri", payload.optString("uri", ""))
            .put("bufferVersion", payload.optLong("bufferVersion", payload.optLong("version", 0)))
            .put("environmentId", "default")
            .put("args", configuration.optJSONArray("args") == null
                ? new JSONArray() : configuration.optJSONArray("args"))
            .put("workingDirectory", configuration.optString("workingDirectory", "/"))
            .put("environment", configuration.optJSONObject("environment") == null
                ? new JSONObject() : configuration.optJSONObject("environment"))
            .put("envFiles", configuration.optJSONArray("envFiles") == null
                ? new JSONArray() : configuration.optJSONArray("envFiles"));
        String targetKind = configuration.optString("targetKind", "file");
        String target = configuration.getString("target");
        if ("module".equals(targetKind)) {
            String module = target.replace('.', '/');
            WorkspaceRepository workspace = WorkspaceRepository.readOnly(
                getFilesDir(), payload.optString("workspaceId", "default"));
            String moduleFile = module + ".py";
            if (!new File(workspace.rootDirectory(), moduleFile).isFile()) {
                moduleFile = module + "/__main__.py";
            }
            resolved.put("path", moduleFile);
        } else {
            resolved.put("path", target);
        }
        if (resolved.optString("uri", "").isEmpty()) {
            resolved.put("uri", resolved.optString("path", target));
        }
        return startRun(resolved);
    }

    private void executeRun(
        String runId,
        File workspaceRoot,
        File script,
        List<String> arguments,
        String workingDirectory,
        Map<String, String> environment,
        List<String> envFiles
    ) {
        try {
            PythonEngine current = ensureEngine();
            if (stopRequested.remove(runId) != null) {
                emitFinished(runId, 130, true, 0L, null);
                return;
            }
            PythonEngine.RunResult result = current.runFile(
                runId, workspaceRoot, script, arguments,
                workingDirectory, environment, envFiles);
            emitFinished(
                result.runId,
                result.exitCode,
                result.cancelled,
                result.durationMillis,
                result.payload.optJSONObject("error"));
        } catch (Throwable error) {
            emitOutput(runId, "stderr", "Runtime error: " + message(error) + "\n");
            emitFinished(runId, 1, false, 0L, errorJson(error));
        } finally {
            stopRequested.remove(runId);
            activeRun.compareAndSet(runId, null);
        }
    }

    private JSONObject sendInput(JSONObject payload) throws Exception {
        String runId = requireIdentifier(payload.optString("runId", ""), "runId");
        PythonEngine current = engine;
        boolean accepted = current != null
            && runId.equals(activeRun.get())
            && current.sendInput(runId, payload.optString("text", ""));
        return new JSONObject()
            .put("ok", accepted)
            .put("accepted", accepted)
            .put("runId", runId);
    }

    private JSONObject stop(JSONObject payload) throws Exception {
        String runId = payload.optString(
            "runId", payload.optString("requestId", payload.optString("id", "")));
        runId = requireIdentifier(runId, "runId");
        boolean matches = runId.equals(activeRun.get());
        boolean interruptDelivered = false;
        if (matches) {
            stopRequested.put(runId, Boolean.TRUE);
            PythonEngine current = engine;
            try {
                interruptDelivered = current != null && current.stop(runId);
            } catch (RuntimeException ignored) {
                interruptDelivered = false;
            }
            if (current != null) {
                if (!interruptDelivered) scheduleStopRetry(runId);
                scheduleStopWatchdog(runId);
            }
        }
        return new JSONObject()
            .put("ok", matches)
            .put("accepted", matches)
            .put("cancellationRequested", matches)
            // Only the later finished/service-crashed event is terminal.
            .put("stopped", false)
            .put("terminal", false)
            .put("interruptDelivered", interruptDelivered)
            .put("runId", runId);
    }

    /** Retry across the small Java-active/native-begin window. */
    private void scheduleStopRetry(String runId) {
        Handler handler = restartHandler;
        if (handler == null) return;
        handler.postDelayed(() -> {
            if (!runId.equals(activeRun.get()) || !stopRequested.containsKey(runId)) return;
            PythonEngine current = engine;
            if (current == null) return;
            boolean delivered = false;
            try {
                delivered = current.stop(runId);
            } catch (RuntimeException ignored) {
            }
            if (!delivered) scheduleStopRetry(runId);
        }, STOP_RETRY_DELAY_MILLIS);
    }

    /**
     * KeyboardInterrupt is cooperative. If user code catches it, or a native
     * extension holds the GIL indefinitely, terminate only the :runtime
     * process so Android can reconnect a fresh service.
     */
    private void scheduleStopWatchdog(String runId) {
        Handler handler = restartHandler;
        if (handler == null) return;
        handler.postDelayed(() -> {
            if (runId.equals(activeRun.get()) && stopRequested.containsKey(runId)) {
                Process.killProcess(Process.myPid());
            }
        }, STOP_WATCHDOG_DELAY_MILLIS);
    }

    private JSONObject listPackages(JSONObject payload) throws Exception {
        String environmentId = payload.optString(
            "environmentId", payload.optString("environment", "default"));
            JSONArray packages = new JSONArray()
            .put(packageRecord("python", PythonRuntimeInstaller.PYTHON_VERSION, "bundled"))
            .put(packageRecord("jedi", "0.20.0", "bundled-language-service"))
            .put(packageRecord("parso", "0.8.7", "bundled-language-service"))
            .put(packageRecord("pytest", "9.0.3", "bundled-test-framework"))
            .put(packageRecord("iniconfig", "2.1.0", "bundled-test-dependency"))
            .put(packageRecord("packaging", "25.0", "bundled-test-dependency"))
            .put(packageRecord("pluggy", "1.6.0", "bundled-test-dependency"))
            .put(packageRecord("pygments", "2.20.0", "bundled-test-dependency"));
        JSONObject wheelPackages = purePythonWheelManager.listJson(environmentId);
        JSONArray installedWheels = wheelPackages.optJSONArray("packages");
        if (installedWheels != null) {
            for (int index = 0; index < installedWheels.length(); index += 1) {
                packages.put(installedWheels.getJSONObject(index));
            }
        }
        return new JSONObject()
            .put("environmentId", environmentId)
            .put("packages", packages)
            .put("purePythonWheels", installedWheels == null
                ? new JSONArray()
                : installedWheels)
            .put("runtimePacks", runtimePackManager.capabilities().optJSONArray("active"));
    }

    private JSONObject handlePythonPackageRequest(String method, JSONObject payload)
        throws Exception {
        String environmentId = payload.optString(
            "environmentId", payload.optString("environment", "default"));
        if ("capabilities".equals(method)) {
            JSONObject result = purePythonWheelManager.capabilities();
            result.put("pickerAvailable", true);
            return result;
        }
        if ("list".equals(method) || "listPackages".equals(method)) {
            return purePythonWheelManager.listJson(environmentId);
        }
        if ("install".equals(method) || "pickAndInstall".equals(method)) {
            if (!environmentChangeInProgress.compareAndSet(false, true)) {
                return new JSONObject()
                    .put("status", "environment-change-in-progress")
                    .put("accepted", false)
                    .put("ok", false);
            }
            String runId = activeRun.get();
            if (runId != null) {
                environmentChangeInProgress.set(false);
                return new JSONObject()
                    .put("status", "runtime-busy")
                    .put("accepted", false)
                    .put("ok", false)
                    .put("activeRunId", runId)
                    .put("reason", "Stop the active Python run before installing a wheel");
            }
            JSONObject result;
            try {
                result = purePythonWheelManager.installFromContentUri(
                    payload.optString("uri", ""),
                    environmentId,
                    hasUserConfirmation(payload));
                if (result.optBoolean("accepted", false)
                    && result.optBoolean("restartRequired", false)) {
                    scheduleRuntimeRestart();
                } else {
                    environmentChangeInProgress.set(false);
                }
            } catch (Throwable error) {
                environmentChangeInProgress.set(false);
                throw error;
            }
            return result;
        }
        throw new IllegalArgumentException("Unknown Python package method: " + method);
    }

    private JSONObject activatePack(JSONObject payload) throws Exception {
        String packId = requireIdentifier(payload.optString("packId", ""), "packId");
        String buildId = payload.optString("buildId", "").trim();
        if (!hasUserConfirmation(payload)) {
            return new JSONObject()
                .put("status", "confirmation-required")
                .put("accepted", false)
                .put("ok", false)
                .put("packId", packId);
        }
        if (!environmentChangeInProgress.compareAndSet(false, true)) {
            return new JSONObject()
                .put("status", "environment-change-in-progress")
                .put("accepted", false)
                .put("ok", false)
                .put("packId", packId);
        }
        String runId = activeRun.get();
        if (runId != null) {
            environmentChangeInProgress.set(false);
            return new JSONObject()
                .put("status", "runtime-busy")
                .put("accepted", false)
                .put("ok", false)
                .put("packId", packId)
                .put("activeRunId", runId)
                .put("reason", "Stop the active Python run before changing Runtime Packs");
        }
        try {
            JSONObject result = runtimePackManager.requestActivation(packId, buildId);
            if (result.optBoolean("accepted", false)
                && result.optBoolean("restartRequired", false)) {
                scheduleRuntimeRestart();
            } else {
                environmentChangeInProgress.set(false);
            }
            return result;
        } catch (Throwable error) {
            environmentChangeInProgress.set(false);
            throw error;
        }
    }

    private JSONObject rollbackPack(JSONObject payload) throws Exception {
        String packId = requireIdentifier(payload.optString("packId", ""), "packId");
        if (!hasUserConfirmation(payload)) {
            return new JSONObject()
                .put("status", "confirmation-required")
                .put("accepted", false)
                .put("ok", false)
                .put("packId", packId);
        }
        if (!environmentChangeInProgress.compareAndSet(false, true)) {
            return new JSONObject()
                .put("status", "environment-change-in-progress")
                .put("accepted", false)
                .put("ok", false)
                .put("packId", packId);
        }
        String runId = activeRun.get();
        if (runId != null) {
            environmentChangeInProgress.set(false);
            return new JSONObject()
                .put("status", "runtime-busy")
                .put("accepted", false)
                .put("ok", false)
                .put("packId", packId)
                .put("activeRunId", runId)
                .put("reason", "Stop the active Python run before rolling back Runtime Packs");
        }
        try {
            JSONObject result = runtimePackManager.rollback(packId);
            if (result.optBoolean("accepted", false)
                && result.optBoolean("restartRequired", false)) {
                scheduleRuntimeRestart();
            } else {
                environmentChangeInProgress.set(false);
            }
            return result;
        } catch (Throwable error) {
            environmentChangeInProgress.set(false);
            throw error;
        }
    }

    static boolean hasUserConfirmation(JSONObject payload) {
        return payload != null && Boolean.TRUE.equals(payload.opt("confirmed"));
    }

    private static JSONObject packageRecord(String name, String version, String source)
        throws Exception {
        return new JSONObject()
            .put("name", name)
            .put("version", version)
            .put("status", "installed")
            .put("source", source);
    }

    private PythonEngine ensureEngine() throws Exception {
        PythonEngine current = engine;
        if (current != null) return current;
        synchronized (engineLock) {
            current = engine;
            if (current != null) return current;
            PythonRuntimeInstaller.Layout layout = runtimeInstaller.ensureInstalled();
            // Validate unsigned pure-Python content before touching the
            // Runtime Pack activation journal. A damaged wheel must never
            // make an unrelated signed pack look like a failed activation.
            PurePythonWheelManager.RuntimeEnvironment wheelEnvironment =
                purePythonWheelManager.prepareRuntimeEnvironment(
                    PurePythonWheelManager.DEFAULT_ENVIRONMENT);
            RuntimePackManager.RuntimeEnvironment packEnvironment;
            try {
                packEnvironment = runtimePackManager.prepareRuntimeEnvironment();
            } catch (Exception validationFailure) {
                boolean reverted = runtimePackManager.failUncommittedActivations(
                    message(validationFailure));
                if (!reverted) throw validationFailure;
                // No candidate code has loaded yet, so the previous active
                // environment can be resolved safely in this same process.
                packEnvironment = runtimePackManager.prepareRuntimeEnvironment();
            }
            ArrayList<File> importPaths = new ArrayList<>(layout.extraImportPaths());
            importPaths.addAll(packEnvironment.pythonImportPaths);
            // Bundled packages and authenticated Runtime Packs retain import
            // precedence. Unsigned wheels can add pure-Python modules but
            // cannot replace those trusted native/runtime components.
            importPaths.addAll(wheelEnvironment.pythonImportPaths);
            PythonEngine created = new PythonEngine(new PythonEngine.Listener() {
                @Override
                public void onOutput(String runId, String stream, String text) {
                    if (runId != null && runId.startsWith(PACK_PROBE_PREFIX)) return;
                    emitOutput(runId, stream, text);
                }

                @Override
                public void onInputRequested(String runId, String prompt) {
                    if (runId != null && runId.startsWith(PACK_PROBE_PREFIX)) return;
                    emitAfterPendingOutput(() -> {
                        try {
                            emitEvent("runtime", new JSONObject()
                                .put("type", "input-request")
                                .put("runId", runId)
                                .put("prompt", prompt == null ? "" : prompt)
                                .put("requestId", identityValue(runId, "requestId"))
                                .put("streamId", identityValue(runId, "streamId"))
                                .put("sessionId", identityValue(runId, "sessionId"))
                                .put("epoch", identityValue(runId, "epoch"))
                                .put("workspaceId", identityValue(runId, "workspaceId"))
                                .put("uri", identityValue(runId, "uri"))
                                .put("bufferVersion", identityValue(runId, "bufferVersion")));
                        } catch (Exception ignored) {
                        }
                    });
                }
            });
            try {
                created.initialize(new PythonEngine.Configuration(
                    layout.home,
                    layout.temporaryDirectory,
                    importPaths,
                    packEnvironment.nativeLibraries));
                if (packEnvironment.hasPendingActivation()) {
                    runActivationProbe(created, packEnvironment);
                    runtimePackManager.commitPendingActivation(packEnvironment);
                    scheduleLanguageRestart(250L);
                }
            } catch (Exception error) {
                handleInitializationFailure(created, packEnvironment, error);
                throw error;
            } catch (LinkageError error) {
                handleInitializationFailure(created, packEnvironment, error);
                throw error;
            }
            engine = created;
            return created;
        }
    }

    private void runActivationProbe(
        PythonEngine candidate,
        RuntimePackManager.RuntimeEnvironment environment
    ) throws Exception {
        String runId = PACK_PROBE_PREFIX + UUID.randomUUID();
        File probeRoot = new File(getCacheDir(), runId);
        if (!probeRoot.mkdirs() && !probeRoot.isDirectory()) {
            throw new IOException("Unable to create Runtime Pack probe directory");
        }
        File script = new File(probeRoot, "probe.py");
        String source = activationProbeSource(environment);
        try (FileOutputStream output = new FileOutputStream(script)) {
            output.write(source.getBytes(StandardCharsets.UTF_8));
            output.flush();
            output.getFD().sync();
        }

        Future<PythonEngine.RunResult> future = activationProbeExecutor.submit(
            () -> candidate.runFile(
                runId, probeRoot, script, Collections.emptyList()));
        try {
            PythonEngine.RunResult result = future.get(
                PACK_PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!result.succeeded()) {
                JSONObject error = result.payload.optJSONObject("error");
                throw new IOException(
                    "Runtime Pack import probe failed"
                        + (error == null ? "" : ": " + error.optString("message", "")));
            }
        } catch (TimeoutException timeout) {
            candidate.stop(runId);
            future.cancel(true);
            throw new IOException("Runtime Pack import probe timed out", timeout);
        } finally {
            try {
                Files.deleteIfExists(script.toPath());
                Files.deleteIfExists(probeRoot.toPath());
            } catch (IOException ignored) {
            }
        }
    }

    private static String activationProbeSource(
        RuntimePackManager.RuntimeEnvironment environment
    ) {
        StringBuilder source = new StringBuilder()
            .append("import importlib, os, sys\n");
        File pythonDirectory = environment.pendingBuildDirectory == null
            ? null
            : new File(environment.pendingBuildDirectory, "python");
        if (pythonDirectory != null && pythonDirectory.isDirectory()) {
            source.append("_pack_root = os.path.realpath(")
                .append(JSONObject.quote(pythonDirectory.getAbsolutePath()))
                .append(")\n")
                .append("if _pack_root not in [os.path.realpath(p) for p in sys.path if p]:\n")
                .append("    raise RuntimeError('candidate Runtime Pack is absent from sys.path')\n");
        }
        for (String module : environment.smokeImports) {
            source.append("_module = importlib.import_module(")
                .append(JSONObject.quote(module))
                .append(")\n");
            if (pythonDirectory != null && pythonDirectory.isDirectory()) {
                source.append("_origins = []\n")
                    .append("_file = getattr(_module, '__file__', None)\n")
                    .append("_origins.extend([_file] if _file else [])\n")
                    .append("_origins.extend(list(getattr(_module, '__path__', ())))\n")
                    .append("if not any(os.path.commonpath((_pack_root, os.path.realpath(p))) == _pack_root for p in _origins):\n")
                    .append("    raise ImportError('module did not load from candidate Runtime Pack: ")
                    .append(module.replace("'", ""))
                    .append("')\n");
            }
        }
        return source.toString();
    }

    private void handleInitializationFailure(
        PythonEngine candidate,
        RuntimePackManager.RuntimeEnvironment environment,
        Throwable error
    ) {
        if (environment != null && environment.hasPendingActivation()) {
            candidate.setListener(PythonEngine.NO_OP_LISTENER);
            try {
                runtimePackManager.failPendingActivation(
                    environment.pendingPackId,
                    environment.pendingBuildId,
                    message(error));
            } catch (Exception rollbackError) {
                initializationError = "Runtime Pack rollback failed: " + message(rollbackError);
            }
            scheduleRuntimeRestart();
            return;
        }
        try {
            candidate.close();
        } catch (RuntimeException ignored) {
        }
    }

    private void scheduleRuntimeRestart() {
        if (restartScheduled || restartHandler == null) return;
        restartScheduled = true;
        restartHandler.postDelayed(() -> {
            requestLanguageRestart();
            Intent restart = new Intent(this, RuntimeProcessRestartReceiver.class)
                .setAction(RuntimeProcessRestartReceiver.ACTION_RESTART_RUNTIME);
            sendBroadcast(restart);
        }, 750L);
    }

    private void scheduleLanguageRestart(long delayMillis) {
        Handler handler = restartHandler;
        if (handler == null) return;
        handler.postDelayed(this::requestLanguageRestart, Math.max(0L, delayMillis));
    }

    private void requestLanguageRestart() {
        Intent restartLanguage = new Intent(this, LanguageProcessRestartReceiver.class)
            .setAction(LanguageProcessRestartReceiver.ACTION_RESTART_LANGUAGE);
        sendBroadcast(restartLanguage);
    }

    private void emitOutput(String runId, String stream, String text) {
        RuntimeOutputBuffer buffer = outputBuffer;
        if (buffer != null) {
            buffer.append(runId, stream, text);
            return;
        }
        emitOutputEvent(runId, stream, text);
    }

    private void emitOutputEvent(String runId, String stream, String text) {
        if (testRuns.containsKey(runId == null ? "" : runId)) {
            emitTestOutput(runId, stream, text);
            return;
        }
        try {
            String safeStream = "stderr".equals(stream) ? "stderr" : "stdout";
            String safeText = redactRuntimeOutput(runId, text == null ? "" : text);
            emitEvent("runtime", new JSONObject()
                .put("type", safeStream)
                .put("runId", runId)
                .put("stream", safeStream)
                .put("text", safeText)
                .put("requestId", identityValue(runId, "requestId"))
                .put("streamId", identityValue(runId, "streamId"))
                .put("sessionId", identityValue(runId, "sessionId"))
                .put("epoch", identityValue(runId, "epoch"))
                .put("workspaceId", identityValue(runId, "workspaceId"))
                .put("uri", identityValue(runId, "uri"))
                .put("bufferVersion", identityValue(runId, "bufferVersion")));
        } catch (Exception ignored) {
        }
    }

    private void emitAfterPendingOutput(Runnable action) {
        RuntimeOutputBuffer buffer = outputBuffer;
        if (buffer == null) {
            action.run();
            return;
        }
        buffer.flushThen(action);
    }

    private void emitFinished(
        String runId,
        int exitCode,
        boolean cancelled,
        long durationMillis,
        JSONObject error
    ) {
        emitAfterPendingOutput(() -> {
            try {
                JSONObject event = new JSONObject()
                    .put("type", "finished")
                    .put("runId", runId)
                    .put("exitCode", exitCode)
                    .put("cancelled", cancelled)
                    .put("durationMillis", durationMillis)
                    .put("requestId", identityValue(runId, "requestId"))
                    .put("streamId", identityValue(runId, "streamId"))
                    .put("sessionId", identityValue(runId, "sessionId"))
                    .put("epoch", identityValue(runId, "epoch"))
                    .put("workspaceId", identityValue(runId, "workspaceId"))
                    .put("uri", identityValue(runId, "uri"))
                    .put("bufferVersion", identityValue(runId, "bufferVersion"));
                if (error != null) event.put("error", redactRuntimeError(runId, error));
                emitEvent("runtime", event);
                runIdentities.remove(runId);
                runSecrets.remove(runId);
            } catch (Exception ignored) {
            }
        });
    }

    private static JSONObject withTransportIdentity(JSONObject payload, JSONObject request)
        throws Exception {
        JSONObject enriched = payload == null ? new JSONObject() : new JSONObject(payload.toString());
        String requestId = request == null ? "" : request.optString("id", "");
        if (!enriched.has("requestId") || enriched.optString("requestId", "").isEmpty()) {
            enriched.put("requestId", requestId);
        }
        String runId = enriched.optString("runId", "");
        if (!enriched.has("streamId")) enriched.put("streamId", runId);
        if (!enriched.has("sessionId")) enriched.put("sessionId", "runtime-" + (runId.isEmpty() ? requestId : runId));
        if (!enriched.has("epoch")) enriched.put("epoch", 0);
        if (!enriched.has("workspaceId")) enriched.put("workspaceId", "default");
        if (!enriched.has("uri")) enriched.put("uri", enriched.optString("path", enriched.optString("file", "")));
        if (!enriched.has("bufferVersion")) enriched.put("bufferVersion", enriched.optLong("version", 0));
        return enriched;
    }

    private static JSONObject runtimeIdentity(JSONObject payload, String runId, String path)
        throws Exception {
        JSONObject identity = new JSONObject()
            .put("requestId", payload.optString("requestId", runId))
            .put("streamId", payload.optString("streamId", runId))
            .put("sessionId", payload.optString("sessionId", "runtime-" + runId))
            .put("epoch", payload.optLong("epoch", 0))
            .put("workspaceId", payload.optString("workspaceId", "default"))
            .put("uri", payload.optString("uri", path == null ? "" : path))
            .put("bufferVersion", payload.optLong("bufferVersion", payload.optLong("version", 0)));
        return identity;
    }

    private Object identityValue(String runId, String key) {
        JSONObject identity = runIdentities.get(runId);
        if (identity == null) {
            if ("streamId".equals(key)) return runId == null ? "" : runId;
            if ("requestId".equals(key)) return runId == null ? "" : runId;
            if ("sessionId".equals(key)) return "runtime-" + (runId == null ? "unknown" : runId);
            if ("workspaceId".equals(key)) return "default";
            if ("epoch".equals(key) || "bufferVersion".equals(key)) return 0;
            return "";
        }
        return identity.opt(key);
    }

    private String redactRuntimeOutput(String runId, String text) {
        String result = text == null ? "" : text;
        List<String> secrets = runSecrets.get(runId);
        if (secrets != null) {
            for (String secret : secrets) if (secret != null && !secret.isEmpty()) {
                result = result.replace(secret, "[REDACTED]");
            }
        }
        // Also cover values loaded from a workspace .env file, which are not
        // visible to this Java admission path.  These patterns are deliberately
        // conservative and only affect terminal output, never the script.
        result = result.replaceAll("\\bsk-ant-[A-Za-z0-9_-]{20,}\\b", "[REDACTED]");
        result = result.replaceAll("\\bsk-[A-Za-z0-9_-]{20,}\\b", "[REDACTED]");
        result = result.replaceAll("\\bAIza[0-9A-Za-z_-]{20,}\\b", "[REDACTED]");
        result = result.replaceAll("\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\b", "[REDACTED]");
        return result;
    }

    private JSONObject redactRuntimeError(String runId, JSONObject error) {
        String safe = redactRuntimeOutput(runId, error == null ? "" : error.toString());
        if (safe.length() > 64 * 1024) safe = safe.substring(0, 64 * 1024) + "…";
        try {
            return new JSONObject(safe);
        } catch (Exception malformed) {
            try {
                return new JSONObject()
                    .put("type", error == null ? "RuntimeError" : error.optString("type", "RuntimeError"))
                    .put("message", safe);
            } catch (Exception impossible) {
                return new JSONObject();
            }
        }
    }

    private static String requireIdentifier(String value, String label) {
        String result = value == null ? "" : value.trim();
        if (result.isEmpty() || result.length() > 256) {
            throw new IllegalArgumentException(label + " is required and must be <= 256 chars");
        }
        return result;
    }

    private static JSONObject errorJson(Throwable error) {
        try {
            return new JSONObject()
                .put("type", error.getClass().getSimpleName())
                .put("message", message(error));
        } catch (Exception impossible) {
            return new JSONObject();
        }
    }

    private static String message(Throwable error) {
        String value = error == null ? null : error.getMessage();
        return value == null || value.isEmpty()
            ? (error == null ? "Unknown runtime error" : error.getClass().getSimpleName())
            : value;
    }
}
