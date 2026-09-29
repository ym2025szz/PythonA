package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Loopback MCP with revocable per-turn credentials. The model never writes files. */
final class WorkspaceMcpServer implements AutoCloseable {
    interface Listener { void onEvent(JSONObject event); }
    static final int MAX_RESPONSE = 256 * 1024;
    private static final String PATH = "/pythona-mcp";
    private static final int MAX_BODY = 512 * 1024;
    private static final int MAX_RESULT = 96 * 1024;
    private static final int MAX_RESULTS = 100;
    private static final int MAX_PATCH_BYTES = 192 * 1024;
    private static final Pattern SYMBOL = Pattern.compile("^(\\s*)(?:async\\s+)?(def|class)\\s+([\\p{L}_][\\p{L}\\p{N}_]*)\\s*[( :]");
    private final WorkspaceRepository workspace;
    private final Listener listener;
    private final long approvalTimeoutMillis;
    private final long bindingTtlMillis;
    private final Map<String, Binding> bindings = new ConcurrentHashMap<>();
    private final Map<String, PendingRun> approvals = new ConcurrentHashMap<>();
    private final Set<Socket> clients = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean running = new AtomicBoolean();
    private volatile ServerSocket server;
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(3, 3, 0, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(8), runnable -> {
            Thread thread = new Thread(runnable, "PythonA.MCP");
            thread.setDaemon(true);
            return thread;
        });

    final class Binding {
        final String sessionId, streamId, requestId;
        private final String token;
        private final long expiresAt;
        private final AtomicBoolean active = new AtomicBoolean(true);
        private final AtomicInteger toolCalls = new AtomicInteger();
        private final Map<String, Snapshot> snapshots = new ConcurrentHashMap<>();
        private volatile String acpSessionId = "";
        private Binding(String sessionId, String streamId, String requestId) {
            this.sessionId = identity(sessionId);
            this.streamId = identity(streamId);
            this.requestId = identity(requestId);
            byte[] random = new byte[32];
            new SecureRandom().nextBytes(random);
            token = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
            expiresAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(bindingTtlMillis);
        }
        JSONObject descriptor() throws Exception {
            requireActive(this);
            return new JSONObject().put("type", "http").put("name", "pythona").put("url", url())
                .put("headers", new JSONArray().put(new JSONObject().put("name", "X-PythonA-MCP-Token").put("value", token)));
        }
        synchronized void attachSession(String acpSessionId) {
            String next = identity(acpSessionId);
            if (!this.acpSessionId.isEmpty() && !this.acpSessionId.equals(next))
                throw new IllegalStateException("MCP binding already belongs to another session");
            this.acpSessionId = next;
        }
        JSONObject event(String kind) throws Exception {
            return new JSONObject().put("kind", kind).put("official", true).put("source", "official-dsh")
                .put("requestId", requestId).put("streamId", streamId).put("sessionId", sessionId)
                .put("acpSessionId", acpSessionId).put("workspaceId", "default");
        }
    }
    private static final class Snapshot {
        final long revision;
        final String hash;
        Snapshot(WorkspaceRepository.Entry entry) { revision = entry.revision; hash = entry.sha256; }
    }
    private static final class PendingRun {
        final Binding binding;
        final CompletableFuture<Boolean> decision = new CompletableFuture<>();
        final CompletableFuture<JSONObject> result = new CompletableFuture<>();
        volatile boolean approved;
        PendingRun(Binding binding) { this.binding = binding; }
    }
    WorkspaceMcpServer(WorkspaceRepository workspace, Listener listener) {
        this(workspace, listener, 120_000L, 30 * 60_000L);
    }
    WorkspaceMcpServer(WorkspaceRepository workspace, Listener listener, long approvalTimeoutMillis, long bindingTtlMillis) {
        if (workspace == null || listener == null) throw new IllegalArgumentException("workspace and listener are required");
        this.workspace = workspace;
        this.listener = listener;
        this.approvalTimeoutMillis = approvalTimeoutMillis;
        this.bindingTtlMillis = bindingTtlMillis;
    }
    synchronized void start() throws IOException {
        if (running.get()) return;
        if (workers.isShutdown()) throw new IOException("MCP endpoint is closed");
        // Bind before returning so a session never receives a dead endpoint.
        server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        running.set(true);
        Thread acceptor = new Thread(() -> {
            try {
                while (running.get()) {
                    Socket client = server.accept();
                    client.setSoTimeout(15_000);
                    clients.add(client);
                    try { workers.execute(() -> handle(client)); }
                    catch (RejectedExecutionException full) { clients.remove(client); client.close(); }
                }
            } catch (IOException ignored) {
                // close() intentionally interrupts accept().
            } finally { running.set(false); }
        }, "PythonA.MCP.accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }
    String url() {
        if (!running.get() || server == null) throw new IllegalStateException("MCP endpoint is not running");
        return "http://127.0.0.1:" + server.getLocalPort() + PATH;
    }
    synchronized Binding bind(String uiSessionId, String streamId, String requestId) {
        if (!running.get()) throw new IllegalStateException("MCP endpoint is not running");
        for (Binding previous : bindings.values()) if (expired(previous)) revoke(previous, "expired");
        if (bindings.size() >= 16) throw new IllegalStateException("Too many active MCP tasks");
        Binding result = new Binding(uiSessionId, streamId, requestId);
        bindings.put(result.token, result);
        return result;
    }
    void revoke(Binding binding, String reason) {
        if (binding == null || !binding.active.compareAndSet(true, false)) return;
        bindings.remove(binding.token, binding);
        binding.snapshots.clear();
        for (Map.Entry<String, PendingRun> entry : approvals.entrySet()) {
            PendingRun pending = entry.getValue();
            if (pending.binding == binding) {
                pending.result.complete(terminal("cancelled", reason));
                pending.decision.complete(false);
                approvals.remove(entry.getKey(), pending);
            }
        }
    }
    void revokeAll(String reason) { for (Binding binding : bindings.values()) revoke(binding, reason); }
    boolean respondApproval(String approvalId, boolean allowed) { return respondApproval(approvalId, allowed, null); }
    boolean respondApproval(String approvalId, boolean allowed, JSONObject result) {
        PendingRun pending = approvals.get(String.valueOf(approvalId));
        if (pending == null) return false;
        synchronized (pending) {
            if (expired(pending.binding) || pending.result.isDone()) return false;
            if (!allowed) {
                boolean completed = pending.result.complete(terminal("rejected", "User rejected the run"));
                pending.decision.complete(false);
                return completed;
            }
            // A repeated approval must not admit a second editor run.
            if (pending.approved && result == null) return false;
            pending.approved = true;
            pending.decision.complete(true);
            return result == null || completeRun(approvalId, result);
        }
    }
    boolean completeRun(String approvalId, JSONObject result) {
        PendingRun pending = approvals.get(String.valueOf(approvalId));
        if (pending == null || !pending.approved || expired(pending.binding) || result == null) return false;
        String status = result.optString("status", "");
        if (status.isEmpty() || "approved".equals(status) || "running".equals(status) || "accepted".equals(status)) return false;
        try {
            JSONObject safe = (JSONObject) McpWorkspacePolicy.redactValue(result);
            if (McpWorkspacePolicy.exceedsValueLimits(result)) safe.put("truncated", true);
            return pending.result.complete(boundedResult(safe));
        }
        catch (Exception invalid) { return pending.result.complete(terminal("error", "Invalid run result")); }
    }
    int pendingApprovalCount() { return approvals.size(); }

    private void handle(Socket socket) {
        try (Socket client = socket) {
            try {
                Request request = readRequest(client);
                if (request == null) return;
                if (!PATH.equals(request.path) || !"POST".equals(request.method)) {
                    write(client, 404, new JSONObject().put("error", "not found")); return;
                }
                Binding binding = bindings.get(request.token);
                if (binding == null || expired(binding)) {
                    if (binding != null) revoke(binding, "expired");
                    write(client, 401, new JSONObject().put("error", "unauthorized")); return;
                }
                JSONObject response = dispatch(binding, new JSONObject(request.body));
                write(client, response == null ? 202 : 200, response);
            } catch (Exception error) { write(client, 400, new JSONObject().put("error", "Invalid MCP request")); }
        } catch (Exception ignored) {
            // Malformed/closed clients cannot terminate the acceptor.
        } finally { clients.remove(socket); }
    }
    private JSONObject dispatch(Binding binding, JSONObject request) throws Exception {
        Object id = request.opt("id");
        // JSON-RPC notifications receive an empty 202, not an id:null response.
        if (!request.has("id")) { requireActive(binding); return null; }
        JSONObject response = new JSONObject().put("jsonrpc", "2.0").put("id", id);
        if (!"2.0".equals(request.optString("jsonrpc")) || !(id instanceof String || id instanceof Number))
            return response.put("error", new JSONObject().put("code", -32600).put("message", "Invalid JSON-RPC request"));
        String method = request.optString("method", "");
        JSONObject params = request.optJSONObject("params");
        if (params == null) params = new JSONObject();
        try {
            requireActive(binding);
            if ("initialize".equals(method)) return response.put("result", new JSONObject()
                .put("protocolVersion", "2025-03-26").put("capabilities", new JSONObject().put("tools", new JSONObject()))
                .put("serverInfo", new JSONObject().put("name", "pythona-workspace").put("version", "0.4.0")));
            if ("ping".equals(method)) return response.put("result", new JSONObject());
            if ("tools/list".equals(method)) return response.put("result", tools());
            if ("tools/call".equals(method)) return response.put("result", callTool(binding, params));
            return response.put("error", new JSONObject().put("code", -32601).put("message", "method not found"));
        } catch (Exception error) {
            String safe = McpWorkspacePolicy.truncate(McpWorkspacePolicy.redact(String.valueOf(error.getMessage())), 512);
            if ("tools/call".equals(method)) return response.put("result", new JSONObject().put("isError", true)
                .put("content", new JSONArray().put(new JSONObject().put("type", "text").put("text", safe))));
            return response.put("error", new JSONObject().put("code", -32000).put("message", safe));
        }
    }
    private JSONObject tools() throws Exception {
        JSONArray list = new JSONArray();
        list.put(tool("read_file", "Read bounded, secret-redacted text in the PythonA workspace.", "path", "string", true));
        list.put(tool("search_workspace", "Search allowed workspace text; paths and results are bounded.", "query", "string", true));
        list.put(tool("list_symbols", "List lexical Python class/function definitions (not semantic references).", "path", "string", false));
        list.put(tool("propose_patch", "Propose files with path and afterText. PythonA shows a complete Diff before any write.", "files", "array", true));
        list.put(tool("request_run", "Request a saved configuration with user approval; returns its actual terminal result.", "configurationId", "string", true));
        return new JSONObject().put("tools", list);
    }
    private static JSONObject tool(String name, String description, String field, String type, boolean required) throws Exception {
        JSONObject property = new JSONObject().put("type", type);
        if ("files".equals(field)) property.put("maxItems", 32).put("items", new JSONObject().put("type", "object")
            .put("required", new JSONArray().put("path").put("afterText"))
            .put("properties", new JSONObject().put("path", new JSONObject().put("type", "string"))
                .put("afterText", new JSONObject().put("type", "string"))
                .put("baseRevision", new JSONObject().put("type", "integer"))
                .put("baseSha256", new JSONObject().put("type", "string"))));
        JSONObject schema = new JSONObject().put("type", "object").put("properties", new JSONObject().put(field, property));
        if (required) schema.put("required", new JSONArray().put(field));
        return new JSONObject().put("name", name).put("description", description).put("inputSchema", schema);
    }
    private JSONObject callTool(Binding binding, JSONObject params) throws Exception {
        if (binding.toolCalls.incrementAndGet() > 12) throw new IOException("MCP task tool limit reached (12 calls)");
        String name = params.optString("name", "");
        JSONObject args = params.optJSONObject("arguments");
        if (args == null) args = new JSONObject();
        McpWorkspacePolicy policy = new McpWorkspacePolicy(workspace);
        JSONObject result;
        if ("read_file".equals(name)) result = read(binding, policy, args.getString("path"));
        else if ("search_workspace".equals(name)) result = search(binding, policy, args.optString("query", ""));
        else if ("list_symbols".equals(name)) result = symbols(binding, policy, args.optString("path", ""));
        else if ("propose_patch".equals(name)) result = proposePatch(binding, policy, args);
        else if ("request_run".equals(name)) result = requestRun(binding, args);
        else throw new IllegalArgumentException("Unsupported PythonA tool");
        requireActive(binding);
        result = boundedResult(result);
        return new JSONObject().put("content", new JSONArray().put(new JSONObject().put("type", "text").put("text", result.toString())))
            .put("structuredContent", result);
    }
    private JSONObject read(Binding binding, McpWorkspacePolicy policy, String requested) throws Exception {
        String path = policy.requireAllowed(requested);
        File file = policy.resolve(path);
        if (file.length() > McpWorkspacePolicy.MAX_FILE_BYTES) return new JSONObject().put("path", path)
            .put("size", file.length()).put("truncated", true).put("message", "File exceeds the model context size limit");
        WorkspaceRepository.Entry entry = workspace.read(path);
        binding.snapshots.put(path, new Snapshot(entry));
        String safe = McpWorkspacePolicy.redact(entry.text());
        String content = McpWorkspacePolicy.truncate(safe, McpWorkspacePolicy.MAX_TEXT_BYTES);
        return new JSONObject().put("path", entry.path).put("content", content).put("size", entry.size)
            .put("revision", entry.revision).put("sha256", entry.sha256)
            .put("redacted", !safe.equals(entry.text())).put("truncated", !content.equals(safe));
    }
    private JSONObject search(Binding binding, McpWorkspacePolicy policy, String query) throws Exception {
        String needle = query.trim().toLowerCase(Locale.ROOT);
        if (needle.isEmpty() || McpWorkspacePolicy.bytes(needle) > 512) throw new IllegalArgumentException("query must contain 1–512 bytes");
        JSONArray results = new JSONArray();
        List<String> paths = policy.files();
        int scannedBytes = 0, resultBytes = 0;
        boolean truncated = policy.scanTruncated();
        scan: for (String path : paths) {
            requireActive(binding);
            WorkspaceRepository.Entry entry;
            try { policy.requireAllowed(path); entry = workspace.read(path); } catch (IOException skip) { continue; }
            scannedBytes += entry.content.length;
            if (scannedBytes > McpWorkspacePolicy.MAX_SCAN_BYTES) { truncated = true; break; }
            String[] lines = McpWorkspacePolicy.redact(entry.text()).split("\\R", -1);
            for (int line = 0; line < lines.length; line++) {
                if (!lines[line].toLowerCase(Locale.ROOT).contains(needle)) continue;
                JSONObject match = new JSONObject().put("path", path).put("line", line + 1)
                    .put("column", lines[line].toLowerCase(Locale.ROOT).indexOf(needle) + 1)
                    .put("text", McpWorkspacePolicy.truncate(lines[line], 2048));
                resultBytes += McpWorkspacePolicy.bytes(match.toString());
                if (results.length() >= MAX_RESULTS || resultBytes > 48 * 1024) { truncated = true; break scan; }
                results.put(match);
                binding.snapshots.putIfAbsent(path, new Snapshot(entry));
            }
        }
        return new JSONObject().put("results", results).put("truncated", truncated);
    }
    private JSONObject symbols(Binding binding, McpWorkspacePolicy policy, String requested) throws Exception {
        List<String> paths = requested.isEmpty() ? policy.files() : Collections.singletonList(policy.requireAllowed(requested));
        JSONArray symbols = new JSONArray();
        int scannedBytes = 0;
        boolean truncated = policy.scanTruncated();
        scan: for (String path : paths) {
            requireActive(binding);
            if (!path.toLowerCase(Locale.ROOT).matches(".*\\.pyi?$")) continue;
            if (policy.resolve(path).length() > McpWorkspacePolicy.MAX_FILE_BYTES) { truncated = true; continue; }
            WorkspaceRepository.Entry entry;
            try { policy.requireAllowed(path); entry = workspace.read(path); } catch (IOException skip) { continue; }
            scannedBytes += entry.content.length;
            if (scannedBytes > McpWorkspacePolicy.MAX_SCAN_BYTES) { truncated = true; break; }
            String[] lines = McpWorkspacePolicy.redact(entry.text()).split("\\R", -1);
            for (int line = 0; line < lines.length; line++) {
                Matcher symbol = SYMBOL.matcher(lines[line]);
                if (!symbol.find()) continue;
                if (symbols.length() >= MAX_RESULTS) { truncated = true; break scan; }
                symbols.put(new JSONObject().put("path", path).put("line", line + 1).put("column", symbol.start(3) + 1)
                    .put("name", McpWorkspacePolicy.truncate(symbol.group(3), 256)).put("kind", symbol.group(2)));
            }
        }
        return new JSONObject().put("symbols", symbols).put("semantic", false).put("truncated", truncated);
    }
    private JSONObject proposePatch(Binding binding, McpWorkspacePolicy policy, JSONObject args) throws Exception {
        JSONArray files = args.optJSONArray("files");
        if (files == null || files.length() == 0 || files.length() > 32) throw new IllegalArgumentException("files must contain 1–32 files");
        JSONArray normalized = new JSONArray(), summaries = new JSONArray();
        HashSet<String> seen = new HashSet<>();
        int bytes = 0;
        String transactionId = "mcp-patch-" + UUID.randomUUID();
        for (int index = 0; index < files.length(); index++) {
            requireActive(binding);
            JSONObject file = files.getJSONObject(index);
            String path = policy.requireAllowed(file.getString("path"));
            if (!seen.add(path)) throw new IllegalArgumentException("Duplicate patch path");
            if (!file.has("afterText") && !file.has("content")) throw new IllegalArgumentException("Patch requires afterText");
            String after = file.has("afterText") ? file.getString("afterText") : file.getString("content");
            File target = policy.resolve(path);
            if (target.length() > MAX_PATCH_BYTES) throw new IOException("Patch exceeds the preview byte limit");
            WorkspaceRepository.Entry current = target.exists() ? workspace.read(path) : null;
            String before = current == null ? "" : current.text();
            long revision = current == null ? workspace.revision(path) : current.revision;
            String hash = current == null ? "" : current.sha256;
            Snapshot context = binding.snapshots.get(path);
            if (context != null && (context.revision != revision || !context.hash.equals(hash)))
                throw new IOException("Workspace changed since the model read this file; read it again");
            if ((file.has("baseRevision") && file.getLong("baseRevision") != revision)
                || (file.has("baseSha256") && !hash.equals(file.getString("baseSha256"))))
                throw new IOException("Patch base is stale; read the file again");
            bytes += McpWorkspacePolicy.bytes(before) + McpWorkspacePolicy.bytes(after);
            if (bytes > MAX_PATCH_BYTES) throw new IOException("Patch exceeds the preview byte limit");
            normalized.put(new JSONObject().put("path", path).put("beforeText", before).put("afterText", after)
                .put("baseRevision", revision).put("baseSha256", hash));
            summaries.put(new JSONObject().put("path", path).put("baseRevision", revision).put("baseSha256", hash));
        }
        JSONObject patch = new JSONObject().put("files", normalized).put("id", transactionId).put("transactionId", transactionId)
            .put("title", McpWorkspacePolicy.truncate(McpWorkspacePolicy.redact(args.optString("title", "DSH workspace changes")), 256));
        JSONObject event = binding.event("patch_preview").put("patch", patch).put("summary", patch.optString("title"));
        if (McpWorkspacePolicy.bytes(event.toString()) > MAX_RESPONSE) throw new IOException("Encoded patch preview is too large");
        requireActive(binding);
        listener.onEvent(event);
        // Only the editor receives original beforeText. Never echo it back to the model.
        return new JSONObject().put("approvalRequired", true).put("transactionId", transactionId)
            .put("files", summaries).put("message", "PythonA will show a Diff before writing");
    }
    private JSONObject requestRun(Binding binding, JSONObject args) throws Exception {
        String configurationId = identity(args.optString("configurationId", ""));
        if (approvals.size() >= 8) throw new IOException("Too many pending run approvals");
        String approvalId = "mcp-run-" + UUID.randomUUID();
        PendingRun pending = new PendingRun(binding);
        approvals.put(approvalId, pending);
        try {
            requireActive(binding);
            listener.onEvent(binding.event("approval_required").put("action", "run")
                .put("approvalId", approvalId).put("configurationId", configurationId));
            pending.decision.get(approvalTimeoutMillis, TimeUnit.MILLISECONDS);
            // Execution gets its own deadline, starting only after the user approves.
            JSONObject result = pending.result.get(approvalTimeoutMillis, TimeUnit.MILLISECONDS);
            return result.put("configurationId", configurationId);
        } catch (TimeoutException timeout) {
            listener.onEvent(binding.event("approval_expired").put("approvalId", approvalId).put("action", "run"));
            return terminal("timeout", "Run approval or execution timed out").put("configurationId", configurationId);
        } finally { approvals.remove(approvalId, pending); }
    }
    private static JSONObject boundedResult(JSONObject result) throws Exception {
        if (McpWorkspacePolicy.bytes(result.toString()) <= MAX_RESULT) return result;
        return new JSONObject().put("status", result.optString("status", "completed")).put("truncated", true)
            .put("message", "Result exceeded the MCP byte limit")
            .put("preview", McpWorkspacePolicy.truncate(McpWorkspacePolicy.redact(result.toString()), 16 * 1024));
    }
    private static JSONObject terminal(String status, String message) {
        JSONObject result = new JSONObject();
        try { result.put("status", status).put("message", McpWorkspacePolicy.truncate(McpWorkspacePolicy.redact(message), 512)); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
        return result;
    }
    private static String identity(String value) {
        String id = value == null ? "" : value.trim();
        if (id.isEmpty() || id.length() > 256 || id.indexOf('\n') >= 0 || id.indexOf('\r') >= 0)
            throw new IllegalArgumentException("A bounded task identity is required");
        return id;
    }
    private boolean expired(Binding binding) { return !binding.active.get() || System.nanoTime() >= binding.expiresAt; }
    private void requireActive(Binding binding) throws IOException {
        if (!running.get() || expired(binding)) { revoke(binding, "expired"); throw new IOException("MCP task is no longer active"); }
    }
    private static final class Request {
        final String method, path, token, body;
        Request(String method, String path, String token, String body) { this.method = method; this.path = path; this.token = token; this.body = body; }
    }
    private static Request readRequest(Socket client) throws Exception {
        BufferedInputStream input = new BufferedInputStream(client.getInputStream());
        String requestLine = readLine(input);
        if (requestLine == null) return null;
        String[] parts = requestLine.split(" ", -1);
        if (parts.length != 3 || !"HTTP/1.1".equals(parts[2])) throw new IOException("Invalid HTTP request line");
        String token = "";
        int length = -1, headerBytes = requestLine.length(), headers = 0;
        HashSet<String> seen = new HashSet<>();
        while (true) {
            String line = readLine(input);
            if (line == null) throw new IOException("Truncated HTTP headers");
            if (line.isEmpty()) break;
            if (++headers > 32 || (headerBytes += line.length()) > 16 * 1024) throw new IOException("HTTP headers too large");
            int colon = line.indexOf(':');
            if (colon <= 0) throw new IOException("Invalid HTTP header");
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = line.substring(colon + 1).trim();
            if (!seen.add(name) && (name.equals("content-length") || name.equals("x-pythona-mcp-token")))
                throw new IOException("Duplicate HTTP security header");
            if ("transfer-encoding".equals(name)) throw new IOException("Chunked requests are not supported");
            if ("origin".equals(name)) throw new IOException("Browser origins are not accepted");
            if ("x-pythona-mcp-token".equals(name)) token = value;
            if ("content-length".equals(name)) length = Integer.parseInt(value);
        }
        if (length < 0 || length > MAX_BODY) throw new IOException("Invalid MCP content length");
        byte[] body = new byte[length];
        int offset = 0;
        while (offset < length) {
            int count = input.read(body, offset, length - offset);
            if (count < 0) throw new IOException("MCP request is truncated");
            offset += count;
        }
        return new Request(parts[0], parts[1], token, new String(body, StandardCharsets.UTF_8));
    }
    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) >= 0) {
            if (value == '\n') break;
            if (value != '\r') out.write(value);
            if (out.size() > 4096) throw new IOException("MCP header is too long");
        }
        return value < 0 && out.size() == 0 ? null : out.toString("UTF-8");
    }
    private static void write(Socket client, int status, JSONObject body) throws IOException {
        byte[] bytes = body == null ? new byte[0] : body.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_RESPONSE) { status = 500; bytes = "{\"error\":\"MCP response byte limit exceeded\"}".getBytes(StandardCharsets.UTF_8); }
        String reason = status == 200 ? "OK" : status == 202 ? "Accepted" : status == 401 ? "Unauthorized"
            : status == 404 ? "Not Found" : status == 500 ? "Internal Server Error" : "Bad Request";
        OutputStream output = client.getOutputStream();
        output.write(("HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: application/json\r\nContent-Length: "
            + bytes.length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        output.write(bytes);
        output.flush();
    }
    @Override public synchronized void close() {
        running.set(false);
        revokeAll("MCP endpoint closed");
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        for (Socket socket : clients) try { socket.close(); } catch (IOException ignored) { }
        clients.clear();
        workers.shutdownNow();
    }
}
