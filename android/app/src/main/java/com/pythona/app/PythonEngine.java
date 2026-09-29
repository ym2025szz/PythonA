package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Persistent embedded CPython instance for one Android service process.
 *
 * <p>Execution methods are serialized, but {@link #sendInput(String, String)},
 * {@link #stop(String)} and {@link #cancelRequest(String)} are deliberately
 * lock-free so another Binder/handler thread can wake or interrupt Python.</p>
 */
public final class PythonEngine implements AutoCloseable {
    public interface Listener {
        void onOutput(String runId, String stream, String text);

        default void onInputRequested(String runId, String prompt) {
        }
    }

    public static final Listener NO_OP_LISTENER = new Listener() {
        @Override
        public void onOutput(String runId, String stream, String text) {
        }
    };

    public static final class Configuration {
        public final File home;
        public final File temporaryDirectory;
        public final List<File> extraImportPaths;
        public final List<File> preloadLibraries;

        public Configuration(
            File home,
            File temporaryDirectory,
            List<File> extraImportPaths
        ) {
            this(home, temporaryDirectory, extraImportPaths, Collections.emptyList());
        }

        public Configuration(
            File home,
            File temporaryDirectory,
            List<File> extraImportPaths,
            List<File> preloadLibraries
        ) {
            this.home = Objects.requireNonNull(home, "home");
            this.temporaryDirectory = Objects.requireNonNull(
                temporaryDirectory, "temporaryDirectory");
            this.extraImportPaths = Collections.unmodifiableList(
                new ArrayList<>(extraImportPaths == null
                    ? Collections.emptyList()
                    : extraImportPaths));
            this.preloadLibraries = Collections.unmodifiableList(
                new ArrayList<>(preloadLibraries == null
                    ? Collections.emptyList()
                    : preloadLibraries));
        }

        public static Configuration from(PythonRuntimeInstaller.Layout layout) {
            return new Configuration(
                layout.home,
                layout.temporaryDirectory,
                layout.extraImportPaths());
        }
    }

    public static final class RunResult {
        public final String runId;
        public final int exitCode;
        public final boolean cancelled;
        public final long durationMillis;
        public final JSONObject payload;

        private RunResult(String requestedRunId, String json) throws JSONException {
            payload = new JSONObject(json);
            runId = payload.optString("runId", requestedRunId);
            exitCode = payload.optInt("exitCode", 1);
            cancelled = payload.optBoolean("cancelled", false);
            durationMillis = payload.optLong("durationMillis", 0L);
        }

        public boolean succeeded() {
            return exitCode == 0 && !cancelled;
        }
    }

    private static final int MAX_JSON_CHARS = 16 * 1024 * 1024;
    private static final Object LOAD_LOCK = new Object();
    private static final Set<String> LOADED_NATIVE_PATHS = new HashSet<>();
    private static volatile boolean nativeLoaded;

    private final ReentrantLock executionLock = new ReentrantLock();
    private volatile Listener listener;
    private volatile boolean initialized;
    private volatile boolean closed;

    public PythonEngine(Listener listener) {
        this.listener = listener == null ? NO_OP_LISTENER : listener;
        ensureNativeLoaded();
    }

    /** Convenience constructor used by a host service during {@code onCreate}. */
    public PythonEngine(Configuration configuration) throws IOException {
        this(configuration, NO_OP_LISTENER);
    }

    /** Construct and initialize while preserving a streaming console listener. */
    public PythonEngine(Configuration configuration, Listener listener) throws IOException {
        this(listener);
        initialize(configuration);
    }

    /** Initialize CPython once. Subsequent calls in the same process reattach callbacks. */
    public void initialize(Configuration configuration) throws IOException {
        Objects.requireNonNull(configuration, "configuration");
        executionLock.lock();
        try {
            ensureOpen();
            if (!configuration.home.isDirectory()) {
                throw new IOException("Python home does not exist: " + configuration.home);
            }
            if (!configuration.temporaryDirectory.isDirectory()
                && !configuration.temporaryDirectory.mkdirs()) {
                throw new IOException(
                    "Unable to create Python temporary directory: "
                        + configuration.temporaryDirectory);
            }
            ArrayList<String> importPaths = new ArrayList<>();
            for (File path : configuration.extraImportPaths) {
                if (!path.isDirectory()) {
                    throw new IOException("Python import path does not exist: " + path);
                }
                importPaths.add(path.getCanonicalPath());
            }
            preloadNativeLibraries(configuration.preloadLibraries);
            nativeInitialize(
                configuration.home.getCanonicalPath(),
                configuration.temporaryDirectory.getCanonicalPath(),
                importPaths.toArray(new String[0]));
            initialized = true;
        } finally {
            executionLock.unlock();
        }
    }

    /** Execute a real workspace script in the persistent interpreter. */
    public RunResult runFile(
        String runId,
        File workspaceRoot,
        File script,
        List<String> arguments
    ) throws IOException, JSONException {
        return runFile(runId, workspaceRoot, script, arguments, "/",
            Collections.emptyMap(), Collections.emptyList());
    }

    /** Execute a file with validated Run Configuration options. */
    public RunResult runFile(
        String runId,
        File workspaceRoot,
        File script,
        List<String> arguments,
        String workingDirectory,
        Map<String, String> environment,
        List<String> environmentFiles
    ) throws IOException, JSONException {
        String safeRunId = requireIdentifier(runId, "runId");
        File canonicalRoot = workspaceRoot.getCanonicalFile();
        File canonicalScript = requireContainedRegularFile(canonicalRoot, script);
        JSONArray args = new JSONArray();
        if (arguments != null) {
            for (String argument : arguments) args.put(String.valueOf(argument));
        }
        JSONObject options = new JSONObject()
            .put("args", args)
            .put("workingDirectory", workingDirectory == null ? "/" : workingDirectory)
            .put("environment", environment == null
                ? new JSONObject() : new JSONObject(environment))
            .put("envFiles", environmentFiles == null
                ? new JSONArray() : new JSONArray(environmentFiles));

        executionLock.lock();
        try {
            ensureReady();
            String result = nativeRunFile(
                safeRunId,
                canonicalRoot.getPath(),
                canonicalScript.getPath(),
                options.toString());
            return new RunResult(safeRunId, result);
        } finally {
            executionLock.unlock();
        }
    }

    /** Dispatch one JSON request to the persistent Jedi host. */
    public String callJson(String requestJson) {
        String value = requireJsonSize(requestJson);
        executionLock.lock();
        try {
            ensureReady();
            return nativeCallJson(value);
        } finally {
            executionLock.unlock();
        }
    }

    /** Queue one line for the currently blocked Python {@code input()} call. */
    public String testJson(String runId, String requestJson) {
        String value = requireJsonSize(requestJson);
        executionLock.lock();
        try {
            ensureReady();
            return nativeTestJson(runId == null ? "" : runId, value);
        } finally {
            executionLock.unlock();
        }
    }

    public boolean sendInput(String runId, String text) {
        if (!initialized || closed) return false;
        return nativeSendInput(
            requireIdentifier(runId, "runId"),
            text == null ? "" : text);
    }

    /** Request KeyboardInterrupt and wake a blocked input call. */
    public boolean stop(String runId) {
        if (!initialized || closed) return false;
        return nativeStop(requireIdentifier(runId, "runId"));
    }

    /** Mark a semantic request cancelled without waiting for the Jedi worker lock. */
    public void cancelRequest(String requestId) {
        if (!initialized || closed) return;
        nativeCancelRequest(requireIdentifier(requestId, "requestId"));
    }

    public void setListener(Listener listener) {
        this.listener = listener == null ? NO_OP_LISTENER : listener;
    }

    @Override
    public void close() {
        executionLock.lock();
        try {
            if (closed) return;
            closed = true;
            listener = NO_OP_LISTENER;
            if (initialized) nativeDetachCallbacks();
            initialized = false;
        } finally {
            executionLock.unlock();
        }
    }

    /** Visible to host-service and JVM tests; rejects sibling-prefix and symlink escapes. */
    static File requireContainedRegularFile(File canonicalRoot, File candidate)
        throws IOException {
        if (canonicalRoot == null || !canonicalRoot.isDirectory()) {
            throw new IOException("Workspace root does not exist");
        }
        if (candidate == null) throw new IOException("Script path is required");
        File canonical = candidate.isAbsolute()
            ? candidate.getCanonicalFile()
            : new File(canonicalRoot, candidate.getPath()).getCanonicalFile();
        String rootPath = canonicalRoot.getCanonicalPath();
        String filePath = canonical.getCanonicalPath();
        if (!filePath.startsWith(rootPath + File.separator) || !canonical.isFile()) {
            throw new IOException("Script is outside the workspace or is not a file");
        }
        return canonical;
    }

    private static void ensureNativeLoaded() {
        if (nativeLoaded) return;
        synchronized (LOAD_LOCK) {
            if (nativeLoaded) return;
            System.loadLibrary("pythona_engine");
            nativeLoaded = true;
        }
    }

    /**
     * Load relocatable pack dependency libraries by absolute path. A retry
     * pass lets a dependency encountered later in lexical order satisfy an
     * earlier DT_NEEDED failure without trusting LD_LIBRARY_PATH.
     */
    static void preloadNativeLibraries(List<File> libraries) throws IOException {
        if (libraries == null || libraries.isEmpty()) return;
        synchronized (LOAD_LOCK) {
            LinkedHashMap<String, UnsatisfiedLinkError> pending = new LinkedHashMap<>();
            for (File library : libraries) {
                if (library == null || !library.isFile()
                    || java.nio.file.Files.isSymbolicLink(library.toPath())) {
                    throw new IOException("Runtime pack native library is missing or unsafe");
                }
                String path = library.getCanonicalPath();
                if (!path.endsWith(".so") && !path.contains(".so.")) {
                    throw new IOException("Runtime pack native library has an invalid name: " + path);
                }
                if (!LOADED_NATIVE_PATHS.contains(path)) pending.put(path, null);
            }
            while (!pending.isEmpty()) {
                boolean progress = false;
                ArrayList<String> paths = new ArrayList<>(pending.keySet());
                for (String path : paths) {
                    try {
                        System.load(path);
                        LOADED_NATIVE_PATHS.add(path);
                        pending.remove(path);
                        progress = true;
                    } catch (UnsatisfiedLinkError error) {
                        pending.put(path, error);
                    } catch (SecurityException error) {
                        throw new IOException(
                            "Android rejected runtime pack native library: " + path,
                            error);
                    }
                }
                if (!progress) {
                    Map.Entry<String, UnsatisfiedLinkError> failure =
                        pending.entrySet().iterator().next();
                    throw new IOException(
                        "Unable to load runtime pack native library: " + failure.getKey(),
                        failure.getValue());
                }
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

    private static String requireJsonSize(String value) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("JSON is required");
        if (value.length() > MAX_JSON_CHARS) {
            throw new IllegalArgumentException("JSON request is too large");
        }
        return value;
    }

    private void ensureReady() {
        ensureOpen();
        if (!initialized) throw new IllegalStateException("PythonEngine is not initialized");
    }

    private void ensureOpen() {
        if (closed) throw new IllegalStateException("PythonEngine is closed");
    }

    // Called only by JNI. Keep names/signatures in sync with pythona_engine.c.
    @SuppressWarnings("unused")
    private void dispatchOutput(String runId, String stream, String text) {
        try {
            listener.onOutput(runId, stream, text);
        } catch (RuntimeException ignored) {
            // Console rendering must never tear down the interpreter.
        }
    }

    @SuppressWarnings("unused")
    private void dispatchInputRequested(String runId, String prompt) {
        try {
            listener.onInputRequested(runId, prompt);
        } catch (RuntimeException ignored) {
            // The input queue remains usable even if the UI listener failed.
        }
    }

    private native void nativeInitialize(
        String home,
        String temporaryDirectory,
        String[] extraImportPaths);

    private native String nativeRunFile(
        String runId,
        String workspaceRoot,
        String scriptPath,
        String argumentsJson);

    private native String nativeCallJson(String requestJson);

    private native String nativeTestJson(String runId, String requestJson);

    private native boolean nativeSendInput(String runId, String text);

    private native boolean nativeStop(String runId);

    private native void nativeCancelRequest(String requestId);

    private native void nativeDetachCallbacks();
}
