package com.pythona.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Official dsh inside PythonA. Each process owns its own ACP request state. */
final class DirectDshRuntime implements AutoCloseable {
    interface Listener { void onEvent(JSONObject event); }
    private static final long REQUEST_TIMEOUT_MS = 120_000L;
    private final Context context;
    private final Listener listener;
    private final File root, rootfs;
    private final Object lifecycle = new Object();
    private final ExecutorService background = Executors.newCachedThreadPool();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private final DshRuntimeInstaller installer;
    private volatile Running running;
    private volatile String apiKey = "", baseUrl = "", stage = "stopped";
    private volatile String providerSettings = "{}";
    private volatile String providerMode = "deepseek";
    private volatile boolean closed;
    private long generation;
    private int restartCount;
    private String dnsConfiguration = "";

    private final class Running {
        final Process process;
        final OutputStream stdin;
        final long generation;
        final AcpConnection wire;
        final ThreadPoolExecutor outgoing = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(32));
        final Map<String, List<ScheduledFuture<?>>> timers = new ConcurrentHashMap<>();
        volatile JSONObject initialized;
        Running(Process process, long generation) {
            this.process = process; this.stdin = process.getOutputStream(); this.generation = generation;
            wire = new AcpConnection(value -> {
                byte[] bytes = (value.toString() + "\n").getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 2 * 1024 * 1024) throw new IOException("acp-request-too-large");
                try { outgoing.execute(() -> {
                    try { stdin.write(bytes); stdin.flush(); }
                    catch (IOException error) { stop(this, "acp-write-failed"); }
                }); } catch (RejectedExecutionException full) { throw new IOException("acp-write-queue-unavailable"); }
            }, event -> {
                if (running != this) return;
                if (event.optString("method").startsWith("direct/prompt_")) {
                    List<ScheduledFuture<?>> old = timers.remove(event.optJSONObject("params").optString("sessionId"));
                    if (old != null) for (ScheduledFuture<?> timer : old) timer.cancel(false);
                }
                try { event.put("generation", generation); listener.onEvent(event); } catch (Exception ignored) { }
            });
        }
    }
    DirectDshRuntime(Context context, Listener listener) throws IOException {
        this.context = context.getApplicationContext(); this.listener = listener;
        root = new File(context.getFilesDir(), "dsh-runtime"); rootfs = new File(root, "rootfs");
        installer = new DshRuntimeInstaller(context, (phase, completed, total) -> {
            stage = phase; emitState(phase, completed, total);
        });
    }
    boolean isReady() { return installer.isReady(); }
    boolean isRunning() { Running state = running; return state != null && state.process.isAlive(); }
    boolean isBusy() { Running state = running; return state != null && state.wire.busy(); }
    void configure(String key, String url) throws IOException { configure(key, url, "deepseek", new JSONObject()); }
    void configure(String key, String url, String mode, JSONObject settings) throws IOException {
        key = key == null ? "" : key; url = url == null ? "" : url;
        synchronized (lifecycle) {
            String nextSettings = settings.toString();
            if (apiKey.equals(key) && baseUrl.equals(url) && providerMode.equals(mode) && providerSettings.equals(nextSettings)) return;
            if (isBusy()) throw new IOException("dsh-busy");
            apiKey = key; baseUrl = url; providerMode = mode; providerSettings = nextSettings;
            if (running != null) stop(running, "configuration-changed");
        }
    }
    JSONObject capabilities() throws Exception {
        Running state = running;
        return new JSONObject().put("official", true)
            .put("connected", state != null && state.initialized != null && state.process.isAlive())
            .put("runtime", "direct-dsh").put("status", stage).put("protocol", "acp")
            .put("generation", generation).put("restartCount", restartCount);
    }
    JSONObject call(String method, JSONObject params) throws Exception {
        Running state = ensureProcess();
        try { return state.wire.call(method, params == null ? new JSONObject() : params, REQUEST_TIMEOUT_MS); }
        catch (TimeoutException timeout) { stop(state, "dsh-timeout"); throw new IOException("dsh-timeout"); }
    }
    JSONObject initialize() throws Exception {
        Running state = ensureProcess();
        synchronized (state) {
            if (state.initialized != null) return new JSONObject(state.initialized.toString());
            JSONObject result;
            try { result = state.wire.call("initialize", new JSONObject().put("protocolVersion", 1)
                .put("clientInfo", new JSONObject().put("name", "PythonA").put("version", BuildConfig.VERSION_NAME))
                .put("clientCapabilities", new JSONObject().put("fs", new JSONObject()
                    .put("readTextFile", false).put("writeTextFile", false)).put("terminal", false)), REQUEST_TIMEOUT_MS);
            } catch (TimeoutException timeout) { stop(state, "dsh-timeout"); throw new IOException("dsh-timeout"); }
            if (result.optInt("protocolVersion", -1) != 1) throw new IOException("unsupported-acp-version");
            if (running != state) throw new IOException("service-disconnected");
            state.initialized = result; stage = "ready"; emitState(stage, 1, 1);
            return new JSONObject(result.toString());
        }
    }
    JSONObject newSession(String cwd, JSONArray servers) throws Exception {
        initialize();
        return call("session/new", new JSONObject().put("cwd", "/root")
            .put("mcpServers", servers == null ? new JSONArray() : servers));
    }
    JSONObject resumeSession(String sessionId, JSONArray servers) throws Exception {
        initialize();
        return call("session/resume", new JSONObject().put("sessionId", sessionId)
            .put("cwd", "/root").put("mcpServers", servers == null ? new JSONArray() : servers))
            .put("sessionId", sessionId);
    }
    JSONObject modelCatalog() throws Exception {
        JSONObject session = newSession("/root", new JSONArray());
        try { return new JSONObject().put("source", "official-dsh").put("configOptions", session.optJSONArray("configOptions")); }
        finally { call("session/close", new JSONObject().put("sessionId", session.getString("sessionId"))); }
    }
    JSONObject prompt(String sessionId, String text) throws Exception {
        if (text == null || text.trim().isEmpty()) throw new IOException("empty-prompt");
        Running state = ensureProcess();
        JSONObject result = state.wire.prompt(sessionId, new JSONArray()
            .put(new JSONObject().put("type", "text").put("text", text)));
        watchPrompt(state, sessionId, result.getString("requestId"), REQUEST_TIMEOUT_MS, "dsh-timeout");
        return result;
    }
    JSONObject cancel(String sessionId) throws Exception {
        Running state = running;
        if (state == null) return new JSONObject().put("cancelled", false);
        String promptId = state.wire.promptId(sessionId);
        JSONObject result = state.wire.cancel(sessionId);
        if (promptId != null) watchPrompt(state, sessionId, promptId, 2000, "cancel-watchdog");
        return result;
    }
    private void watchPrompt(Running state, String session, String id, long timeout, String reason) {
        ScheduledFuture<?> timer = watchdog.schedule(() -> {
            if (running == state && state.wire.hasPrompt(session, id)) stop(state, reason);
        }, timeout, TimeUnit.MILLISECONDS);
        state.timers.computeIfAbsent(session, ignored -> new CopyOnWriteArrayList<>()).add(timer);
        if (!state.wire.hasPrompt(session, id)) {
            timer.cancel(false);
            List<ScheduledFuture<?>> timers = state.timers.get(session);
            if (timers != null) timers.remove(timer);
        }
    }
    long generation() { return generation; }
    /** Called on the history worker, never the ACP reader; close awaits official log flush. */
    void closeSessionAwaited(String sessionId, long expectedGeneration) throws Exception {
        Running state = running;
        if (state == null || state.generation != expectedGeneration) throw new IOException("service-disconnected");
        state.wire.call("session/close", new JSONObject().put("sessionId", sessionId), 15000);
        if (running != state) throw new IOException("service-disconnected");
    }
    JSONObject cancelInline(String completionId) throws Exception {
        Running state = running;
        if (state == null) return new JSONObject().put("cancelled", false);
        return state.wire.call("pythona/inline_cancel", new JSONObject().put("completionId", completionId), 1500);
    }
    JSONObject inlineCapabilities() throws Exception {
        Running state = running;
        if (state == null || state.initialized == null) throw new IOException("inline-runtime-not-ready");
        JSONObject result = state.wire.call("pythona/inline_capabilities", new JSONObject(), 2000);
        if (running != state) throw new IOException("inline-stale-generation");
        return result;
    }
    void closeSessionLater(String sessionId, long expectedGeneration) {
        Running state = running;
        if (state == null || state.generation != expectedGeneration) return;
        background.execute(() -> {
            if (running != state) return;
            try { state.wire.call("session/close", new JSONObject().put("sessionId", sessionId), 5000); }
            catch (Exception ignored) { /* Closing a retired session never starts a replacement process. */ }
        });
    }
    JSONObject respondPermission(String token, boolean allowed) throws Exception {
        Running state = running;
        if (state == null) throw new IOException("permission-stale");
        return state.wire.respondPermission(token, allowed);
    }
    void reconnect() { Running state = running; if (state != null) stop(state, "reconnect"); }

    private Running ensureProcess() throws Exception {
        synchronized (lifecycle) {
            if (closed) throw new IOException("dsh-runtime-closed");
            if (isRunning()) { refreshDns(); return running; }
            if (running != null) stop(running, "process-exit");
            stage = "preparing"; emitState(stage, 0, 0);
            try { installer.ensureInstalled(); }
            catch (Exception error) { stage = "error"; emitState(stage, 0, 0); throw error; }
            refreshDns();
            File nativeDir = new File(context.getApplicationInfo().nativeLibraryDir);
            boolean custom = "custom".equals(providerMode);
            boolean inlineModuleReady = true;
            {
                File boot = new File(rootfs, "root/.pythona-bootstrap.cjs");
                try (InputStream source = context.getAssets().open("configure-dsh.cjs")) {
                    java.nio.file.Files.copy(source, boot.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                try (InputStream source = context.getAssets().open("pythona-acp-stream.cjs")) {
                    java.nio.file.Files.copy(source, new File(rootfs, "root/.pythona-acp-stream.cjs").toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                try (InputStream source = context.getAssets().open("pythona-inline-completion.cjs")) {
                    java.nio.file.Files.copy(source, new File(rootfs, "root/.pythona-inline-completion.cjs").toPath(),
                        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                } catch (IOException optionalInlineFailure) { inlineModuleReady = false; }
                java.nio.file.Files.write(new File(rootfs, "root/.pythona-provider.json").toPath(),
                    providerSettings.getBytes(StandardCharsets.UTF_8));
            }
            File proot = new File(nativeDir, "libproot.so");
            if (!proot.isFile()) throw new IOException("missing-proot");
            File support = new File(root, "native-support"); support.mkdirs();
            copyIfNeeded(new File(nativeDir, "libtalloc.so"), new File(support, "libtalloc.so.2"));
            copyIfNeeded(new File(nativeDir, "libandroidshmem.so"), new File(support, "libandroid-shmem.so"));
            List<String> argv = new ArrayList<>(Arrays.asList(proot.getAbsolutePath(),
                "--link2symlink", "-L", "--kill-on-exit", "-0", "--rootfs=" + rootfs.getAbsolutePath(), "--cwd=/root"));
            for (String bind : new String[]{"/dev", "/proc", "/sys", "/system", "/apex", "/linkerconfig"})
                if (new File(bind).exists()) { argv.add("-b"); argv.add(bind); }
            argv.addAll(Arrays.asList("/usr/local/bin/node", "/root/.pythona-bootstrap.cjs"));
            ProcessBuilder builder = new ProcessBuilder(argv).redirectErrorStream(false);
            Map<String, String> env = builder.environment();
            env.remove("DEEPSEEK_API_KEY"); env.remove("DEEPSEEK_BASE_URL");
            env.remove(DshCustomConfiguration.KEY_ENV);
            env.remove("PYTHONA_INLINE_DISABLED");
            if (!inlineModuleReady) env.put("PYTHONA_INLINE_DISABLED", "1");
            env.put("HOME", "/root"); env.put("TMPDIR", "/tmp");
            File prootTmp = new File(root, "tmp");
            if (!prootTmp.isDirectory() && !prootTmp.mkdirs()) throw new IOException("dsh-tmp-unavailable");
            env.put("PROOT_TMP_DIR", prootTmp.getAbsolutePath());
            env.put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
            if (!apiKey.isEmpty()) env.put("custom".equals(providerMode) ? DshCustomConfiguration.KEY_ENV : "DEEPSEEK_API_KEY", apiKey);
            if (!baseUrl.isEmpty() && !"custom".equals(providerMode)) env.put("DEEPSEEK_BASE_URL", baseUrl);
            env.put("PROOT_LOADER", new File(nativeDir, "libprootloader.so").getAbsolutePath());
            env.put("PROOT_LOADER_32", new File(nativeDir, "libprootloader32.so").getAbsolutePath());
            env.put("LD_LIBRARY_PATH", support.getAbsolutePath() + ":" + nativeDir.getAbsolutePath());
            Running state = new Running(builder.start(), ++generation);
            if (generation > 1) restartCount++;
            running = state; stage = "starting"; emitState(stage, 0, 0);
            background.execute(() -> readOutput(state));
            background.execute(() -> drainErrors(state));
            background.execute(() -> {
                try { state.process.waitFor(); stop(state, "process-exit"); }
                catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            });
            return state;
        }
    }
    private void readOutput(Running state) {
        try (InputStream input = new BufferedInputStream(state.process.getInputStream())) {
            String line;
            while (running == state && (line = AcpConnection.readLine(input, 2 * 1024 * 1024)) != null)
                state.wire.receive(new JSONObject(line));
        } catch (Exception ignored) { /* Never log SDK error text containing credentials. */ }
        stop(state, "acp-transport-closed");
    }

    private void refreshDns() throws IOException {
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        Network network = manager == null ? null : manager.getActiveNetwork();
        LinkProperties properties = network == null ? null : manager.getLinkProperties(network);
        String value = DshDnsConfiguration.render(properties == null ? null : properties.getDnsServers());
        if (value == null || value.equals(dnsConfiguration)) return;
        java.nio.file.Path target = new File(rootfs, "etc/resolv.conf").toPath();
        if (java.nio.file.Files.isSymbolicLink(target)) throw new IOException("Invalid runtime DNS path");
        java.nio.file.Path temporary = target.resolveSibling("resolv.conf.pythona.tmp");
        java.nio.file.Files.write(temporary, value.getBytes(StandardCharsets.UTF_8));
        java.nio.file.Files.move(temporary, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        dnsConfiguration = value;
    }
    private void drainErrors(Running state) {
        // Drain stderr with bounded memory; raw SDK traces may contain auth headers.
        try (InputStream input = state.process.getErrorStream()) {
            byte[] chunk = new byte[4096];
            while (input.read(chunk) != -1) Arrays.fill(chunk, (byte) 0);
        } catch (IOException ignored) { }
    }
    private void stop(Running owner, String reason) {
        synchronized (lifecycle) {
            if (running != owner) return;
            // Break a blocked pipe writer before acquiring its protocol monitor.
            owner.process.destroyForcibly();
            owner.outgoing.shutdownNow();
            owner.wire.close(reason);
            for (List<ScheduledFuture<?>> timers : owner.timers.values())
                for (ScheduledFuture<?> timer : timers) timer.cancel(false);
            owner.timers.clear();
            running = null;
            stage = "stopped"; emitState(stage, 0, 0);
        }
    }
    private void emitState(String phase, long completed, long total) {
        try { listener.onEvent(new JSONObject().put("method", "direct/runtime").put("generation", generation)
            .put("params", new JSONObject().put("state", phase).put("phase", phase)
                .put("completed", completed).put("total", total))); } catch (Exception ignored) { }
    }
    private static void copyIfNeeded(File source, File target) throws IOException {
        if (target.isFile() && target.length() == source.length()) return;
        try (InputStream input = new FileInputStream(source); OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[16384]; int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
        target.setReadable(true, true); target.setExecutable(true, true);
    }
    @Override public void close() {
        closed = true; Running state = running; if (state != null) stop(state, "service-disconnected");
        watchdog.shutdownNow(); background.shutdownNow(); apiKey = "";
    }
}
