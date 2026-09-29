package com.pythona.app;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Exercises ACP wire identity and lifecycle, not a real Provider or model request. */
public final class AcpConnectionTest {
    @Test public void permissionsPreserveNumericAndStringRequestIdsIndependently() throws Exception {
        Fixture f = new Fixture(); f.prompt("session-1");
        f.connection.receive(permission(17, "session-1"));
        f.connection.receive(permission("17", "session-1"));
        assertEquals(2, f.events.size());
        f.connection.respondPermission(f.approval(0), true);
        JSONObject numeric = f.lastWrite();
        assertTrue(numeric.get("id") instanceof Number);
        assertEquals(17, numeric.getInt("id"));
        assertEquals("allow-once-id", numeric.getJSONObject("result").getJSONObject("outcome").getString("optionId"));
        f.connection.respondPermission(f.approval(1), false);
        JSONObject string = f.lastWrite();
        assertTrue(string.get("id") instanceof String);
        assertEquals("17", string.getString("id"));
        assertEquals("reject-once-id", string.getJSONObject("result").getJSONObject("outcome").getString("optionId"));
    }

    @Test public void allowOnceNeverSelectsRememberedApprovalOrInventsOption() throws Exception {
        JSONObject params = new JSONObject().put("options", new JSONArray()
            .put(option("allow_always", "persistent"))
            .put(option("allow_once", "one-request")));
        assertEquals("one-request", AcpConnection.permissionOutcome(params, true).getString("optionId"));
        params.put("options", new JSONArray().put(option("allow_always", "persistent")));
        JSONObject absent = AcpConnection.permissionOutcome(params, true);
        assertEquals("cancelled", absent.getString("outcome"));
        assertFalse(absent.has("optionId"));
        assertEquals("cancelled", AcpConnection.permissionOutcome(null, false).getString("outcome"));
    }

    @Test public void duplicatePermissionResponseIsRejectedWithoutAnotherWireWrite() throws Exception {
        Fixture f = new Fixture(); f.prompt("session-1"); f.connection.receive(permission(2, "session-1"));
        String token = f.approval(0);
        f.connection.respondPermission(token, true); int writes = f.writes.size();
        IOException error = assertThrows(IOException.class, () -> f.connection.respondPermission(token, true));
        assertEquals("permission-stale", error.getMessage());
        assertEquals(writes, f.writes.size());
    }

    @Test public void duplicateIncomingPermissionCannotCreateSecondApproval() throws Exception {
        Fixture f = new Fixture(); f.prompt("session-1");
        JSONObject request = permission(2, "session-1");
        f.connection.receive(request); f.connection.receive(new JSONObject(request.toString()));
        assertEquals("A duplicate ACP request must not create a second independently approving card", 1, f.events.size());
    }

    @Test public void permissionExpiresWhenOwningPromptCompletes() throws Exception {
        Fixture f = new Fixture(); String request = f.prompt("session-1");
        f.connection.receive(permission(2, "session-1")); String token = f.approval(0);
        f.connection.receive(response(request, "end_turn")); int writes = f.writes.size();
        assertThrows(IOException.class, () -> f.connection.respondPermission(token, true));
        assertEquals(writes, f.writes.size());
    }

    @Test public void lateIncomingPermissionCannotReopenCompletedPrompt() throws Exception {
        Fixture f = new Fixture(); String request = f.prompt("session-1");
        f.connection.receive(response(request, "end_turn")); int events = f.events.size();
        f.connection.receive(permission("late-request", "session-1"));
        assertEquals("Completed prompts cannot produce a new approving card", events, f.events.size());
    }

    @Test public void duplicatePermissionAtCapacityDoesNotDisconnectSession() throws Exception {
        Fixture f = new Fixture(); f.prompt("session-1");
        for (int i = 0; i < 32; i++) f.connection.receive(permission(i, "session-1"));
        f.connection.receive(permission(31, "session-1"));
        assertEquals(32, f.events.size()); assertTrue(f.connection.busy());
    }

    @Test public void cancellingIsAnIdlessNotificationAndRejectsOutstandingPermission() throws Exception {
        Fixture f = new Fixture(); f.prompt("session-1");
        f.connection.receive(permission("permission-1", "session-1")); String token = f.approval(0);
        int before = f.writes.size();
        assertTrue(f.connection.cancel("session-1").getBoolean("cancelled"));
        JSONObject cancel = f.writes.get(before);
        assertEquals("session/cancel", cancel.getString("method")); assertFalse(cancel.has("id"));
        assertEquals("session-1", cancel.getJSONObject("params").getString("sessionId"));
        assertEquals("reject-once-id", f.lastWrite().getJSONObject("result").getJSONObject("outcome").getString("optionId"));
        assertThrows(IOException.class, () -> f.connection.respondPermission(token, true));
    }

    @Test public void cancellingUnknownSessionCannotCancelAnotherPrompt() throws Exception {
        Fixture f = new Fixture(); f.prompt("active"); int writes = f.writes.size();
        assertFalse(f.connection.cancel("different").getBoolean("cancelled"));
        assertEquals(writes, f.writes.size()); assertTrue(f.connection.hasPrompt("active"));
    }

    @Test public void cancelledPromptProducesOneTerminalAfterResponseAndProcessDeath() throws Exception {
        Fixture f = new Fixture(); String request = f.prompt("session-1");
        f.connection.cancel("session-1");
        f.connection.receive(response(request, "end_turn"));
        f.connection.receive(response(request, "end_turn"));
        f.connection.close("process-exit");
        assertEquals(1, f.terminals().size());
        JSONObject event = f.terminals().get(0);
        assertEquals("direct/prompt_done", event.getString("method"));
        assertEquals("cancelled", event.getJSONObject("params").getString("stopReason"));
        assertFalse(f.connection.busy());
    }

    @Test public void processDeathTerminatesEachActivePromptExactlyOnce() throws Exception {
        Fixture f = new Fixture(); String first = f.prompt("first"), second = f.prompt("second");
        f.connection.close("process-exit"); f.connection.close("process-exit");
        f.connection.receive(response(first, "end_turn")); f.connection.receive(response(second, "end_turn"));
        assertEquals(2, f.terminals().size());
        for (JSONObject event : f.terminals()) assertEquals("direct/prompt_error", event.getString("method"));
        assertFalse(f.connection.busy());
    }

    @Test public void cancellationFollowedByCrashStillReportsCancelledOnce() throws Exception {
        Fixture f = new Fixture(); f.prompt("session-1"); f.connection.cancel("session-1");
        f.connection.close("process-exit"); f.connection.close("timeout");
        assertEquals(1, f.terminals().size());
        assertEquals("cancelled", f.terminals().get(0).getJSONObject("params").getString("stopReason"));
    }

    @Test public void retiredConnectionCannotPublishEventsOrAcceptApproval() throws Exception {
        Fixture old = new Fixture(); old.prompt("session-1"); old.connection.receive(permission(9, "session-1"));
        String token = old.approval(0); old.connection.close("restarted");
        int events = old.events.size(), writes = old.writes.size();
        old.connection.receive(new JSONObject().put("jsonrpc", "2.0").put("method", "session/update")
            .put("params", new JSONObject().put("sessionId", "session-1")));
        old.connection.receive(permission(10, "session-1"));
        assertThrows(IOException.class, () -> old.connection.respondPermission(token, true));
        assertEquals(events, old.events.size()); assertEquals(writes, old.writes.size());
        Fixture current = new Fixture(); current.prompt("session-1"); assertTrue(current.connection.busy());
    }

    @Test public void unsupportedServerRequestReceivesMethodNotFoundWithOriginalId() throws Exception {
        Fixture f = new Fixture();
        f.connection.receive(new JSONObject().put("jsonrpc", "2.0").put("id", 123)
            .put("method", "fs/write_text_file").put("params", new JSONObject()));
        assertEquals(123, f.lastWrite().getInt("id"));
        assertEquals(-32601, f.lastWrite().getJSONObject("error").getInt("code"));
        assertEquals(0, f.events.size());
    }

    @Test public void oneSessionCannotHaveOverlappingPrompts() throws Exception {
        Fixture f = new Fixture(); f.prompt("same");
        assertThrows(IOException.class, () -> f.prompt("same"));
        assertEquals(1, f.writes.size());
    }

    @Test public void readLineCountsUtf8BytesAndReturnsCompleteUnicode() throws Exception {
        String value = "中文🙂"; byte[] data = (value + "\nnext\n").getBytes(StandardCharsets.UTF_8);
        ByteArrayInputStream input = new ByteArrayInputStream(data);
        assertEquals(value, AcpConnection.readLine(input, 10));
        assertEquals("next", AcpConnection.readLine(input, 10));
        assertNull(AcpConnection.readLine(input, 10));
        assertThrows(IOException.class, () -> AcpConnection.readLine(new ByteArrayInputStream(data), 9));
    }

    @Test public void carriageReturnsCannotBypassWireByteLimit() {
        byte[] data = "\r\r\r\r\r\r\r\r\r\r\n".getBytes(StandardCharsets.UTF_8);
        assertThrows(IOException.class, () -> AcpConnection.readLine(new ByteArrayInputStream(data), 4));
    }

    @Test public void malformedUtf8IsRejectedInsteadOfReplaced() {
        byte[] data = {(byte) 0xc3, 0x28, 0x0a};
        assertThrows(IOException.class, () -> AcpConnection.readLine(new ByteArrayInputStream(data), 10));
    }

    @Test public void secretFieldsAreRejectedEvenInsideArraysAndMixedNaming() throws Exception {
        for (String name : Arrays.asList("apiKey", "API_KEY", "api-key", "clientSecret", "password",
                "credentials", "Authorization", "bearer", "accessToken", "refresh-token", "token")) {
            JSONObject params = new JSONObject().put("outer", new JSONArray().put(new JSONObject().put(name, "do-not-log")));
            IOException error = assertThrows(name, IOException.class, () -> AcpConnection.rejectCredentials(params, 0));
            assertEquals("credential-field-forbidden", error.getMessage());
            assertFalse(error.getMessage().contains("do-not-log"));
        }
        AcpConnection.rejectCredentials(new JSONObject().put("prompt", "Explain how API keys work")
            .put("model", "official-model").put("reasoning_effort", "high"), 0);
    }

    @Test public void deepCredentialStructureCannotExhaustStack() throws Exception {
        JSONObject params = new JSONObject(), level = params;
        for (int i = 0; i < 34; i++) { JSONObject next = new JSONObject(); level.put("nested", next); level = next; }
        assertThrows(IOException.class, () -> AcpConnection.rejectCredentials(params, 0));
    }

    @Test public void providerErrorsAreSanitizedToStableCodes() throws Exception {
        assertEquals("dsh-auth-failed", AcpConnection.errorCode(new JSONObject().put("message", "401 leaked-secret-value")));
        assertEquals("dsh-rate-limited", AcpConnection.errorCode(new JSONObject().put("message", "429 Too many requests")));
        assertEquals("dsh-timeout", AcpConnection.errorCode(new JSONObject().put("message", "request timeout")));
        assertEquals("dsh-network-error", AcpConnection.errorCode(new JSONObject().put("message", "fetch failed")));
        assertEquals("dsh-network-error", AcpConnection.errorCode(new JSONObject().put("message", "turn failed: Connection error.")));
        assertEquals("dsh-network-error", AcpConnection.errorCode(new JSONObject().put("message", "getaddrinfo ENOTFOUND provider.invalid")));
    }

    @Test public void catalogUsesOnlyAdvertisedReasoningAndKeepsSelectedModel() throws Exception {
        JSONObject source = new JSONObject().put("configOptions", new JSONArray()
            .put(new JSONObject().put("id", "reasoning_effort").put("currentValue", "high")
                .put("options", new JSONArray().put(value("off")).put(value("high")).put(value("max"))))
            .put(new JSONObject().put("id", "model").put("currentValue", "[\"deepseek\",\"official-pro\"]")
                .put("options", new JSONArray().put(new JSONObject().put("group", "deepseek").put("name", "DeepSeek")
                    .put("options", new JSONArray().put(new JSONObject().put("name", "Official Pro")
                        .put("value", "[\"deepseek\",\"official-pro\"]")))))));
        JSONObject catalog = DshModelCatalog.normalize(source, false);
        JSONObject selected = catalog.getJSONObject("selected");
        assertEquals("deepseek", selected.getString("providerId")); assertEquals("official-pro", selected.getString("model"));
        assertEquals("high", selected.getString("reasoningLevel"));
        JSONObject provider = catalog.getJSONArray("providers").getJSONObject(0);
        JSONArray levels = provider.getJSONObject("capabilities").getJSONArray("reasoningLevels");
        assertEquals("[\"off\",\"high\",\"max\"]", levels.toString());
        assertEquals(levels.toString(), provider.getJSONArray("models").getJSONObject(0).getJSONArray("reasoningLevels").toString());
        assertFalse(provider.getBoolean("keyConfigured"));
        assertFalse(catalog.toString().contains("medium"));
    }

    @Test public void emptyCatalogDoesNotFabricateProvidersOrReasoning() throws Exception {
        JSONObject catalog = DshModelCatalog.normalize(new JSONObject(), false);
        assertEquals(0, catalog.getJSONArray("providers").length());
        assertEquals(0, catalog.getJSONObject("selected").length());
    }

    private static JSONObject permission(Object id, String session) throws Exception {
        return new JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", "session/request_permission")
            .put("params", new JSONObject().put("sessionId", session).put("options", new JSONArray()
                .put(option("allow_always", "remembered-id")).put(option("allow_once", "allow-once-id"))
                .put(option("reject_once", "reject-once-id"))));
    }
    private static JSONObject option(String kind, String id) throws Exception { return new JSONObject().put("kind", kind).put("optionId", id); }
    private static JSONObject value(String value) throws Exception { return new JSONObject().put("value", value); }
    private static JSONObject response(String id, String stop) throws Exception {
        return new JSONObject().put("jsonrpc", "2.0").put("id", id)
            .put("result", new JSONObject().put("stopReason", stop));
    }
    private static final class Fixture {
        final List<JSONObject> writes = new ArrayList<>(), events = new ArrayList<>();
        final AcpConnection connection = new AcpConnection(value -> writes.add(new JSONObject(value.toString())), events::add);
        String prompt(String session) throws Exception { return connection.prompt(session, new JSONArray()).getString("requestId"); }
        String approval(int index) throws Exception { return events.get(index).getJSONObject("params").getString("approvalId"); }
        JSONObject lastWrite() { return writes.get(writes.size() - 1); }
        List<JSONObject> terminals() {
            List<JSONObject> result = new ArrayList<>();
            for (JSONObject event : events) if (event.optString("method").startsWith("direct/prompt_")) result.add(event);
            return result;
        }
    }
}
