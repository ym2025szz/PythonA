package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

/** Real loopback requests exercise authentication, wire bounds and task identity. */
public final class WorkspaceMcpServerTest {
    private File temporary;
    private WorkspaceRepository workspace;
    private WorkspaceMcpServer server;
    private WorkspaceMcpServer.Binding binding;
    private final List<JSONObject> events = Collections.synchronizedList(new ArrayList<>());

    @Before public void setup() throws Exception {
        temporary = Files.createTempDirectory("pythona-mcp-").toFile();
        workspace = new WorkspaceRepository(temporary, "default");
        start(2000, 60_000);
    }
    private void start(long approvalMillis, long ttlMillis) throws Exception {
        if (server != null) server.close();
        server = new WorkspaceMcpServer(workspace, events::add, approvalMillis, ttlMillis);
        server.start();
        binding = server.bind("ui-1", "stream-1", "request-1");
        binding.attachSession("acp-1");
    }
    @After public void cleanup() throws Exception {
        if (server != null) server.close();
        if (temporary != null) try (java.util.stream.Stream<java.nio.file.Path> files = Files.walk(temporary.toPath())) {
            for (java.nio.file.Path path : (Iterable<java.nio.file.Path>) files.sorted(java.util.Comparator.reverseOrder())::iterator)
                Files.deleteIfExists(path);
        }
    }

    @Test public void tokenIsPerTaskAndRevokedWithoutBreakingOtherTasks() throws Exception {
        WorkspaceMcpServer.Binding second = server.bind("ui-2", "stream-2", "request-2");
        second.attachSession("acp-2");
        JSONObject descriptor = binding.descriptor();
        assertNotEquals(token(descriptor), token(second.descriptor()));
        assertEquals(401, exchange(server.url(), "wrong", request("tools/list", null)).status);
        assertEquals(200, exchange(server.url(), token(descriptor), request("tools/list", null)).status);
        server.revoke(binding, "cancelled");
        assertEquals(401, exchange(server.url(), token(descriptor), request("tools/list", null)).status);
        assertEquals(200, exchange(server.url(), token(second.descriptor()), request("tools/list", null)).status);
        assertThrows(IllegalStateException.class, () -> second.attachSession("acp-wrong"));
    }

    @Test public void expirationAndFreshServerInvalidateOldTokens() throws Exception {
        start(100, 15);
        String oldToken = token(binding.descriptor());
        Thread.sleep(25);
        assertEquals(401, exchange(server.url(), oldToken, request("tools/list", null)).status);
        start(100, 60_000);
        assertEquals(401, exchange(server.url(), oldToken, request("tools/list", null)).status);
    }

    @Test public void readRejectsTraversalIgnoresAndRedactsWholeFileBeforeTruncating() throws Exception {
        workspace.writeText(".pyaignore", "private/\n*.hidden.py\n", null, "test");
        workspace.writeText("private/module.py", "secret = 'hidden-value'", null, "test");
        workspace.writeText("config/.env.local", "API_KEY=hidden-value", null, "test");
        workspace.writeText("settings.py", "api_key = 'secret-value-123'\nprint('visible')\n", null, "test");
        for (String path : new String[]{"../outside.py", "/outside.py", "private/module.py", "config/.env.local"}) {
            assertTrue(call(binding, "read_file", new JSONObject().put("path", path)).getBoolean("isError"));
        }
        JSONObject result = structured(call(binding, "read_file", new JSONObject().put("path", "settings.py")));
        assertFalse(result.toString().contains("secret-value-123"));
        assertTrue(result.getBoolean("redacted"));
        assertTrue(result.getString("content").contains("visible"));
        assertEquals(workspace.read("settings.py").sha256, result.getString("sha256"));
    }

    @Test public void unicodeResultBoundsAreUtf8NotUtf16AndNeverSplitEmoji() throws Exception {
        String text = "🙂中文".repeat(20_000);
        workspace.writeText("large.py", text, null, "test");
        JSONObject result = structured(call(binding, "read_file", new JSONObject().put("path", "large.py")));
        assertTrue(result.getBoolean("truncated"));
        String content = result.getString("content");
        assertTrue(content.getBytes(StandardCharsets.UTF_8).length <= McpWorkspacePolicy.MAX_TEXT_BYTES);
        assertFalse(content.contains("\ufffd"));
        assertFalse(Character.isHighSurrogate(content.charAt(content.length() - 1)));
    }

    @Test public void searchIsBoundedRedactedAndIgnoreRulesRefreshEachCall() throws Exception {
        workspace.writeText("visible.py", ("match api_key='secret-abcdef' " + "中".repeat(1000) + "\n").repeat(150), null, "test");
        JSONObject result = structured(call(binding, "search_workspace", new JSONObject().put("query", "match")));
        assertTrue(result.getBoolean("truncated"));
        assertTrue(result.getJSONArray("results").length() <= 100);
        assertFalse(result.toString().contains("secret-abcdef"));
        assertTrue(result.toString().getBytes(StandardCharsets.UTF_8).length < 60 * 1024);
        workspace.writeText(".pyaignore", "visible.py\n", null, "test");
        result = structured(call(binding, "search_workspace", new JSONObject().put("query", "match")));
        assertEquals(0, result.getJSONArray("results").length());
    }

    @Test public void lexicalSymbolsReturnActualUnicodeDefinitions() throws Exception {
        workspace.writeText("source.py", "class 示例:\n    async def 计算(self):\n        pass\n", null, "test");
        JSONObject result = structured(call(binding, "list_symbols", new JSONObject().put("path", "source.py")));
        assertFalse(result.getBoolean("semantic"));
        assertEquals(2, result.getJSONArray("symbols").length());
        JSONObject function = result.getJSONArray("symbols").getJSONObject(1);
        assertEquals("计算", function.getString("name"));
        assertEquals(2, function.getInt("line"));
        assertEquals(15, function.getInt("column"));
    }

    @Test public void patchesPreserveTaskIdentitySnapshotAndNeverEchoSecretsOrWrite() throws Exception {
        workspace.writeText("config.py", "api_key='secret-abcdef'\nvalue=1\n", null, "test");
        WorkspaceMcpServer.Binding second = server.bind("ui-2", "stream-2", "request-2");
        second.attachSession("acp-2");
        JSONArray files = new JSONArray().put(new JSONObject().put("path", "config.py").put("afterText", "value=2\n"));
        JSONObject result = structured(call(second, "propose_patch", new JSONObject().put("files", files)));
        assertTrue(result.getBoolean("approvalRequired"));
        assertFalse(result.toString().contains("secret-abcdef"));
        JSONObject event = events.get(0);
        assertEquals("request-2", event.getString("requestId"));
        assertEquals("stream-2", event.getString("streamId"));
        assertEquals("ui-2", event.getString("sessionId"));
        assertEquals("acp-2", event.getString("acpSessionId"));
        JSONObject file = event.getJSONObject("patch").getJSONArray("files").getJSONObject(0);
        assertEquals(workspace.read("config.py").sha256, file.getString("baseSha256"));
        assertTrue(file.getString("beforeText").contains("secret-abcdef"));
        assertTrue(workspace.read("config.py").text().contains("value=1"));
        assertEquals(result.getString("transactionId"), event.getJSONObject("patch").getString("transactionId"));
    }

    @Test public void staleAndDuplicatePatchBasesEmitNothing() throws Exception {
        workspace.writeText("main.py", "one", null, "test");
        JSONObject file = new JSONObject().put("path", "main.py").put("afterText", "two").put("baseRevision", 99);
        assertTrue(call(binding, "propose_patch", new JSONObject().put("files", new JSONArray().put(file))).getBoolean("isError"));
        file.remove("baseRevision");
        assertTrue(call(binding, "propose_patch", new JSONObject().put("files", new JSONArray().put(file).put(file))).getBoolean("isError"));
        assertTrue(events.isEmpty());
        assertEquals("one", workspace.read("main.py").text());
    }

    @Test public void modificationAfterModelReadRequiresFreshSnapshot() throws Exception {
        workspace.writeText("main.py", "one", null, "test");
        call(binding, "read_file", new JSONObject().put("path", "main.py"));
        workspace.writeText("main.py", "external", null, "external");
        JSONObject patch = new JSONObject().put("files", new JSONArray().put(new JSONObject().put("path", "main.py").put("afterText", "two")));
        assertTrue(call(binding, "propose_patch", patch).getBoolean("isError"));
        assertTrue(events.isEmpty());
        call(binding, "read_file", new JSONObject().put("path", "main.py"));
        assertTrue(structured(call(binding, "propose_patch", patch)).getBoolean("approvalRequired"));
        assertEquals("external", workspace.read("main.py").text());
    }

    @Test public void newFileProposalStaysUnwrittenAndLargeReadOnlyReturnsMetadata() throws Exception {
        JSONObject patch = new JSONObject().put("files", new JSONArray().put(new JSONObject().put("path", "new.py").put("afterText", "print(1)")));
        JSONObject result = structured(call(binding, "propose_patch", patch));
        assertTrue(result.getBoolean("approvalRequired"));
        assertFalse(new File(workspace.rootDirectory(), "new.py").exists());
        JSONObject file = events.get(0).getJSONObject("patch").getJSONArray("files").getJSONObject(0);
        assertEquals(0L, file.getLong("baseRevision"));
        assertEquals("", file.getString("baseSha256"));
        workspace.writeText("huge.py", "x".repeat(McpWorkspacePolicy.MAX_FILE_BYTES + 1), null, "test");
        JSONObject large = structured(call(binding, "read_file", new JSONObject().put("path", "huge.py")));
        assertTrue(large.getBoolean("truncated"));
        assertFalse(large.has("content"));
        assertEquals(McpWorkspacePolicy.MAX_FILE_BYTES + 1, large.getInt("size"));
    }

    @Test public void symlinkCannotExposeOutsideOrIgnoredContext() throws Exception {
        workspace.writeText("private.py", "private value", null, "test");
        workspace.writeText(".pyaignore", "private.py\n", null, "test");
        java.nio.file.Path alias = new File(workspace.rootDirectory(), "alias.py").toPath();
        try { Files.createSymbolicLink(alias, new File(workspace.rootDirectory(), "private.py").toPath()); }
        catch (java.nio.file.FileSystemException | UnsupportedOperationException unavailable) {
            org.junit.Assume.assumeNoException("Host does not permit symlink creation", unavailable);
        }
        assertTrue(call(binding, "read_file", new JSONObject().put("path", "alias.py")).getBoolean("isError"));
    }

    @Test public void approvalAloneDoesNotCompleteRunAndActualResultIsRedacted() throws Exception {
        CompletableFuture<JSONObject> response = runAsync(binding);
        JSONObject approval = waitForApproval();
        String id = approval.getString("approvalId");
        assertEquals("request-1", approval.getString("requestId"));
        assertTrue(server.respondApproval(id, true));
        assertFalse(server.respondApproval(id, true));
        assertFalse(server.completeRun(id, new JSONObject().put("status", "approved")));
        assertFalse(response.isDone());
        assertTrue(server.completeRun(id, new JSONObject().put("status", "completed").put("exitCode", 0)
            .put("stdout", "answer=42\napi_key='secret-abcdef'").put("apiKey", "nested-secret")));
        JSONObject result = structured(response.get(2, TimeUnit.SECONDS));
        assertEquals("completed", result.getString("status"));
        assertEquals(0, result.getInt("exitCode"));
        assertTrue(result.getString("stdout").contains("answer=42"));
        assertFalse(result.toString().contains("secret-abcdef"));
        assertFalse(result.toString().contains("nested-secret"));
        assertEquals(0, server.pendingApprovalCount());
        assertFalse(server.respondApproval(id, true));
    }

    @Test public void runRejectionTimeoutAndCancellationCleanPendingApprovals() throws Exception {
        CompletableFuture<JSONObject> rejected = runAsync(binding);
        String rejectedId = waitForApproval().getString("approvalId");
        assertTrue(server.respondApproval(rejectedId, false));
        assertEquals("rejected", structured(rejected.get(2, TimeUnit.SECONDS)).getString("status"));
        events.clear();
        start(60, 60_000);
        JSONObject timeout = structured(call(binding, "request_run", new JSONObject().put("configurationId", "run-main")));
        assertEquals("timeout", timeout.getString("status"));
        assertEquals(0, server.pendingApprovalCount());
        assertEquals("approval_expired", events.get(events.size() - 1).getString("kind"));
        events.clear();
        start(2000, 60_000);
        CompletableFuture<JSONObject> cancelled = runAsync(binding);
        String cancelledId = waitForApproval().getString("approvalId");
        server.revoke(binding, "User cancelled task");
        assertTrue(cancelled.get(2, TimeUnit.SECONDS).getBoolean("isError"));
        assertEquals(0, server.pendingApprovalCount());
        assertFalse(server.respondApproval(cancelledId, true));
    }

    @Test public void oversizedRunOutputHasExplicitTruncationAndStillHasTerminalStatus() throws Exception {
        CompletableFuture<JSONObject> response = runAsync(binding);
        String id = waitForApproval().getString("approvalId");
        assertTrue(server.respondApproval(id, true, new JSONObject().put("status", "completed")
            .put("stdout", "中🙂".repeat(50_000)).put("stderr", "error".repeat(30_000))));
        JSONObject result = structured(response.get(2, TimeUnit.SECONDS));
        assertEquals("completed", result.getString("status"));
        assertTrue(result.getBoolean("truncated"));
        assertTrue(result.toString().getBytes(StandardCharsets.UTF_8).length < 96 * 1024);
        assertFalse(result.toString().contains("\ufffd"));
    }

    @Test public void toolLimitAndNotificationResponsesAreExplicit() throws Exception {
        workspace.writeText("main.py", "print(1)", null, "test");
        for (int i = 0; i < 12; i++) assertFalse(call(binding, "read_file", new JSONObject().put("path", "main.py")).optBoolean("isError"));
        assertTrue(call(binding, "read_file", new JSONObject().put("path", "main.py")).getBoolean("isError"));
        Response notification = exchange(server.url(), token(binding.descriptor()), new JSONObject().put("jsonrpc", "2.0").put("method", "notifications/initialized"));
        assertEquals(202, notification.status);
        assertEquals("", notification.body);
    }

    @Test public void malformedLengthAndDuplicateSecurityHeadersReturnBoundedErrors() throws Exception {
        URI uri = URI.create(server.url());
        for (String headers : new String[]{"Content-Length: 9999999\r\n", "Content-Length: 0\r\nContent-Length: 0\r\n", "Transfer-Encoding: chunked\r\nContent-Length: 0\r\n"}) {
            try (Socket socket = new Socket(uri.getHost(), uri.getPort())) {
                socket.setSoTimeout(2000);
                socket.getOutputStream().write(("POST /pythona-mcp HTTP/1.1\r\n" + headers + "\r\n").getBytes(StandardCharsets.UTF_8));
                String wire = new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                assertTrue(wire.startsWith("HTTP/1.1 400"));
                assertTrue(wire.length() < 1024);
            }
        }
    }

    private CompletableFuture<JSONObject> runAsync(WorkspaceMcpServer.Binding task) {
        return CompletableFuture.supplyAsync(() -> {
            try { return call(task, "request_run", new JSONObject().put("configurationId", "run-main")); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
    }
    private JSONObject waitForApproval() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < deadline) {
            synchronized (events) {
                for (JSONObject event : events) if ("approval_required".equals(event.optString("kind"))) return event;
            }
            Thread.sleep(5);
        }
        throw new AssertionError("No approval event");
    }
    private JSONObject call(WorkspaceMcpServer.Binding task, String name, JSONObject args) throws Exception {
        Response response = exchange(server.url(), token(task.descriptor()), request("tools/call", new JSONObject().put("name", name).put("arguments", args)));
        assertEquals(response.body, 200, response.status);
        return new JSONObject(response.body).getJSONObject("result");
    }
    private static JSONObject structured(JSONObject result) throws Exception { return result.getJSONObject("structuredContent"); }
    private static String token(JSONObject descriptor) throws Exception { return descriptor.getJSONArray("headers").getJSONObject(0).getString("value"); }
    private static JSONObject request(String method, JSONObject params) throws Exception {
        return new JSONObject().put("jsonrpc", "2.0").put("id", "test-request").put("method", method).put("params", params);
    }
    private static final class Response {
        final int status; final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
    }
    private static Response exchange(String url, String token, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(2000);
        connection.setReadTimeout(4000);
        connection.setRequestProperty("X-PythonA-MCP-Token", token);
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(bytes.length);
        connection.getOutputStream().write(bytes);
        int status = connection.getResponseCode();
        java.io.InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String text = input == null ? "" : new String(input.readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(text.getBytes(StandardCharsets.UTF_8).length <= WorkspaceMcpServer.MAX_RESPONSE);
        connection.disconnect();
        return new Response(status, text);
    }
}
