package com.pythona.app;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import java.util.Comparator;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.JSONObject;
import org.junit.*;

public final class InlineCompletionHostTest {
    private File root;
    private WorkspaceRepository workspace;
    @Before public void setup() throws Exception {
        root = Files.createTempDirectory("pythona-inline-test-").toFile();
        workspace = new WorkspaceRepository(root, "default");
        workspace.writeText("src/main.py", "foo.\n", null, "test");
    }
    @After public void cleanup() throws Exception {
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(root.toPath())) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> { try { Files.deleteIfExists(path); } catch (Exception ignored) {} });
        }
    }
    private JSONObject request(int version) throws Exception {
        return new JSONObject().put("completionId", "inline-" + version).put("requestId", "inline-" + version)
            .put("workspaceId", "default").put("path", "src/main.py").put("uri", "pythona://default/src/main.py")
            .put("epoch", 1).put("bufferVersion", version).put("cursor", 4).put("selectionVersion", version)
            .put("selection", new JSONObject().put("anchor", 4).put("head", 4)).put("modelSelectionVersion", 1).put("generation", 1)
            .put("codeUpload", true).put("provider", "p").put("model", "m").put("prefix", "foo.").put("suffix", "\n");
    }
    @Test public void contextPolicyRejectsUploadIgnoreTraversalAndSensitiveCursorFragments() throws Exception {
        for (JSONObject bad : new JSONObject[]{request(1).put("codeUpload", false), request(1).put("path", "../main.py"),
            request(1).put("workspaceId", "other"), request(1).put("prefix", "a".repeat(6145)),
            request(1).put("prefix", "sk-ABCDEFGHIJKLM").put("suffix", "NOPQRSTUVWX"),
            request(1).put("selection", new JSONObject().put("anchor", 0).put("head", 4))}) {
            assertThrows(Exception.class, () -> InlineCompletionHost.prepare(workspace, bad, new JSONObject()));
        }
        workspace.writeText(".pyaignore", "src/main.py\n", null, "test");
        assertThrows(Exception.class, () -> InlineCompletionHost.prepare(workspace, request(1), new JSONObject()));
    }
    @Test public void preparedPayloadIsCurrentFileOnlyAndIdentityDoesNotCopyUnknownFields() throws Exception {
        JSONObject input = request(1).put("history", "not-copied").put("apiKey", "not-copied").put("tools", "not-copied");
        input.getJSONObject("selection").put("secret", "not-copied");
        JSONObject actual = InlineCompletionHost.prepare(workspace, input, new JSONObject().put("id", "transport"));
        assertEquals("foo.", actual.getString("prefix")); assertEquals(256, actual.getInt("maxOutputTokens"));
        assertEquals("default", actual.getString("workspaceId")); assertEquals("inline-1", actual.getString("requestId"));
        assertFalse(actual.toString().contains("not-copied"));
    }
    @Test public void finalOutputRejectsToolsStyleMarkdownSecretsAndSizeWithoutClippingCode() throws Exception {
        for (String text : new String[]{"a".repeat(2049), "a\n".repeat(8), "```python\npass\n```", "sk-ABCDEFGHIJKLMNOPQRSTUVWX"})
            assertThrows(Exception.class, () -> InlineCompletionHost.validateOutput(text));
        assertEquals("    return 42\n", InlineCompletionHost.validateOutput("    return 42\n"));
    }
    @Test public void completionEmitsOnlyFinalTextAndExactIdentity() throws Exception {
        BlockingQueue<JSONObject> events = new LinkedBlockingQueue<>();
        try (InlineCompletionHost host = new InlineCompletionHost(workspace, new InlineCompletionHost.Backend() {
            public JSONObject complete(JSONObject value) throws Exception { return new JSONObject().put("status", "completed").put("text", "bar()"); }
            public void cancel(String id) { fail("A completed request must not cancel other work"); }
        }, () -> false, events::add)) {
            assertTrue(host.start(request(1), new JSONObject()).getBoolean("accepted"));
            JSONObject result = events.poll(3, TimeUnit.SECONDS); assertNotNull(result);
            assertEquals("inlineCompletion", result.getString("kind")); assertEquals("bar()", result.getString("text"));
            assertEquals("inline-1", result.getString("completionId")); assertEquals(1, result.getInt("bufferVersion"));
            assertEquals("default", result.getString("workspaceId")); assertFalse(result.has("prefix"));
        }
    }
    @Test public void cancellationInvalidatesLateResultAndWrongTaskIdCannotCancel() throws Exception {
        BlockingQueue<JSONObject> events = new LinkedBlockingQueue<>();
        CountDownLatch entered = new CountDownLatch(1), released = new CountDownLatch(1), stopped = new CountDownLatch(1);
        try (InlineCompletionHost host = new InlineCompletionHost(workspace, new InlineCompletionHost.Backend() {
            public JSONObject complete(JSONObject value) throws Exception { entered.countDown(); released.await(); return new JSONObject().put("text", "late"); }
            public void cancel(String id) { assertEquals("inline-1", id); stopped.countDown(); }
        }, () -> false, events::add)) {
            host.start(request(1), new JSONObject()); assertTrue(entered.await(3, TimeUnit.SECONDS));
            assertFalse(host.cancel(new JSONObject().put("completionId", "run-1")).getBoolean("cancelled"));
            host.cancelForChat(); assertEquals("cancelled", events.poll(3, TimeUnit.SECONDS).getString("status"));
            assertTrue(stopped.await(3, TimeUnit.SECONDS)); released.countDown();
            assertNull(events.poll(100, TimeUnit.MILLISECONDS));
        } finally { released.countDown(); }
    }
    @Test public void admissionIsSingleFlightAndChatHasPriority() throws Exception {
        AtomicBoolean chat = new AtomicBoolean(true); AtomicInteger calls = new AtomicInteger();
        CountDownLatch release = new CountDownLatch(1);
        try (InlineCompletionHost host = new InlineCompletionHost(workspace, new InlineCompletionHost.Backend() {
            public JSONObject complete(JSONObject value) throws Exception { calls.incrementAndGet(); release.await(); return new JSONObject().put("text", "x"); }
            public void cancel(String id) { release.countDown(); }
        }, chat::get, event -> {})) {
            assertEquals("inline-busy", host.start(request(1), new JSONObject()).getString("code"));
            chat.set(false); assertTrue(host.start(request(1), new JSONObject()).getBoolean("accepted"));
            assertEquals("inline-busy", host.start(request(2), new JSONObject()).getString("code"));
        } finally { release.countDown(); }
    }
    @Test public void rateLimitAndThreeSecondGapAreEnforcedNatively() throws Exception {
        AtomicLong now = new AtomicLong(100000); BlockingQueue<JSONObject> events = new LinkedBlockingQueue<>();
        try (InlineCompletionHost host = new InlineCompletionHost(workspace, new InlineCompletionHost.Backend() {
            public JSONObject complete(JSONObject value) throws Exception { return new JSONObject().put("text", "x"); }
            public void cancel(String id) {}
        }, () -> false, events::add, now::get)) {
            for (int i = 1; i <= 12; i++) {
                assertTrue(host.start(request(i), new JSONObject()).getBoolean("accepted")); assertNotNull(events.poll(3, TimeUnit.SECONDS));
                assertEquals("inline-rate-limited", host.start(request(i + 100), new JSONObject()).getString("code"));
                now.addAndGet(3000);
            }
            assertEquals("inline-rate-limited", host.start(request(20), new JSONObject()).getString("code"));
        }
    }
    @Test public void authenticationFailurePausesUntilConfigurationReset() throws Exception {
        AtomicLong now = new AtomicLong(100000); BlockingQueue<JSONObject> events = new LinkedBlockingQueue<>();
        try (InlineCompletionHost host = new InlineCompletionHost(workspace, new InlineCompletionHost.Backend() {
            public JSONObject complete(JSONObject value) throws Exception { return new JSONObject().put("status", "error").put("error", new JSONObject().put("code", "inline-auth")); }
            public void cancel(String id) {}
        }, () -> false, events::add, now::get)) {
            host.start(request(1), new JSONObject()); assertNotNull(events.poll(3, TimeUnit.SECONDS)); now.addAndGet(31000);
            assertEquals("inline-auth-paused", host.start(request(2), new JSONObject()).getString("code"));
            host.resetAuthorization(); assertTrue(host.start(request(2), new JSONObject()).getBoolean("accepted"));
            assertNotNull(events.poll(3, TimeUnit.SECONDS));
        }
    }
    @Test public void cancellationArrivingBeforeQueuedStartSkipsPreparationAndInference() throws Exception {
        AtomicInteger calls = new AtomicInteger(); AtomicLong now = new AtomicLong(100000);
        BlockingQueue<JSONObject> events = new LinkedBlockingQueue<>();
        try (InlineCompletionHost host = new InlineCompletionHost(workspace, new InlineCompletionHost.Backend() {
            public JSONObject complete(JSONObject value) throws Exception { calls.incrementAndGet(); return new JSONObject().put("text", "x"); }
            public void cancel(String id) { fail("No backend request has started"); }
        }, () -> false, events::add, now::get)) {
            assertFalse(host.cancel(new JSONObject().put("completionId", "inline-1")).getBoolean("cancelled"));
            // Invalid context proves cancellation is checked before workspace reads/prepare.
            assertEquals("inline-cancelled", host.start(new JSONObject().put("completionId", "inline-1"), new JSONObject()).getString("code"));
            assertEquals("inline-cancelled", host.start(request(1), new JSONObject()).getString("code")); assertEquals(0, calls.get());
            for (int i = 0; i < 40; i++) host.cancel(new JSONObject().put("completionId", "../invalid-" + i));
            assertEquals("inline-cancelled", host.start(request(1), new JSONObject()).getString("code"));
            now.addAndGet(60000);
            assertTrue(host.start(request(1), new JSONObject()).getBoolean("accepted"));
            assertNotNull(events.poll(3, TimeUnit.SECONDS)); assertEquals(1, calls.get());
        }
    }
    @Test public void pendingCancellationTombstonesAreBoundedTo32ValidatedIds() throws Exception {
        BlockingQueue<JSONObject> events = new LinkedBlockingQueue<>();
        try (InlineCompletionHost host = new InlineCompletionHost(workspace, new InlineCompletionHost.Backend() {
            public JSONObject complete(JSONObject value) throws Exception { return new JSONObject().put("text", "x"); }
            public void cancel(String id) { }
        }, () -> false, events::add)) {
            for (int i = 0; i < 33; i++) host.cancel(new JSONObject().put("completionId", "inline-" + i));
            assertEquals("inline-cancelled", host.start(request(32), new JSONObject()).getString("code"));
            assertEquals("inline-cancelled", host.start(request(1), new JSONObject()).getString("code"));
            assertTrue(host.start(request(0), new JSONObject()).getBoolean("accepted"));
            assertNotNull(events.poll(3, TimeUnit.SECONDS));
        }
    }
}
