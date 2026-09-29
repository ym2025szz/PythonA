package com.pythona.app;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class DshAcpUpdatesTest {
    @Test public void textAndThoughtKeepExactDeltasAndIdentity() throws Exception {
        for (String type : new String[]{"agent_message_chunk", "agent_thought_chunk"}) {
            JSONObject result = DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", type)
                .put("messageId", "turn:1").put("content", new JSONObject().put("type", "text").put("text", "你好\n")));
            assertEquals("你好\n", result.getString("text"));
            assertEquals("turn:1", result.getString("messageId"));
            assertEquals(type.equals("agent_message_chunk") ? "delta" : "thought", result.getString("kind"));
        }
    }
    @Test public void usageKeepsOfficialContextFactsWithoutInventingBillingFields() throws Exception {
        JSONObject result = DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "usage_update")
            .put("used", 1920).put("size", 65536).put("apiKey", "do-not-copy"));
        JSONObject usage = result.getJSONObject("usage");
        assertEquals(1920, usage.getInt("used"));
        assertEquals(65536, usage.getInt("size"));
        assertEquals("context", usage.getString("measurement"));
        assertFalse(usage.has("inputTokens"));
        assertFalse(usage.has("apiKey"));
    }
    @Test public void blockIndexPreservesOnlyExplicitValidStreamMetadata() throws Exception {
        JSONObject input = new JSONObject().put("sessionUpdate", "agent_message_chunk")
            .put("content", new JSONObject().put("type", "text").put("text", "```python\npass\n```"));
        assertFalse(DshAcpUpdates.normalize(input).has("blockIndex"));
        input.put("_meta", new JSONObject().put("pythonaBlockIndex", 2).put("apiKey", "not-copied"));
        JSONObject actual = DshAcpUpdates.normalize(input);
        assertEquals(2, actual.getInt("blockIndex"));
        assertFalse(actual.has("_meta"));
        input.put("_meta", new JSONObject().put("pythonaBlockIndex", "2"));
        assertFalse(DshAcpUpdates.normalize(input).has("blockIndex"));
    }
    @Test public void unknownAndInvalidUsageAreNotZeroTokens() throws Exception {
        for (Object used : new Object[]{JSONObject.NULL, "100", -1, 1.25, 9_007_199_254_740_992d}) {
            assertNull(DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "usage_update")
                .put("used", used).put("size", 10)));
        }
        assertNull(DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "usage_update").put("used", 0).put("size", 0)));
        assertEquals(0, DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "usage_update")
            .put("used", 0).put("size", 10)).getJSONObject("usage").getInt("used"));
    }
    @Test public void toolMetadataHasNoRawInputOutputOrCredentials() throws Exception {
        JSONObject result = DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "tool_call")
            .put("toolCallId", "call-1").put("title", "read_file sk-ABCDEFGHIJKLMNOPQRSTUVWX")
            .put("kind", "read").put("status", "in_progress")
            .put("rawInput", new JSONObject().put("password", "secret-value"))
            .put("content", new JSONArray().put("secret output")));
        assertEquals("call-1", result.getString("callId"));
        assertEquals("read", result.getString("toolKind"));
        assertEquals("in_progress", result.getString("status"));
        assertTrue(result.getString("title").contains("[REDACTED]"));
        assertFalse(result.toString().contains("ABCDEFGHIJKLMNOP"));
        assertFalse(result.has("rawInput"));
        assertFalse(result.has("content"));
    }
    @Test public void locationsRejectAbsoluteTraversalAndProtocolPaths() throws Exception {
        JSONArray rows = new JSONArray();
        for (String path : new String[]{"src/hello.py", "../secret", "/root/secret", "C:/secret", "https://bad", "src/../../secret"})
            rows.put(new JSONObject().put("path", path).put("line", 12));
        JSONObject result = DshAcpUpdates.tool(new JSONObject().put("locations", rows));
        assertEquals(1, result.getJSONArray("locations").length());
        assertEquals("src/hello.py", result.getJSONArray("locations").getJSONObject(0).getString("path"));
        assertFalse(result.getJSONArray("locations").getJSONObject(0).has("line"));
        JSONObject explicit = new JSONObject().put("locations", new JSONArray().put(new JSONObject()
            .put("path", "src/hello.py").put("line", 0).put("_meta", new JSONObject().put("pythonaLineBase", 0))));
        assertEquals(1, DshAcpUpdates.tool(explicit).getJSONArray("locations").getJSONObject(0).getInt("line"));
    }
    @Test public void payloadsAndLocationsAreBoundedAndUnsupportedBlocksAreIgnored() throws Exception {
        String text = String.join("", java.util.Collections.nCopies(30000, "你"));
        JSONObject result = DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "agent_thought_chunk")
            .put("content", new JSONObject().put("type", "text").put("text", text)));
        assertTrue(result.getBoolean("truncated"));
        assertTrue(McpWorkspacePolicy.bytes(result.getString("text")) <= 65536);
        assertFalse(result.getString("text").contains("\ufffd"));
        JSONArray locations = new JSONArray();
        for (int i = 0; i < 100; i++) locations.put(new JSONObject().put("path", "src/" + i + ".py"));
        assertEquals(32, DshAcpUpdates.tool(new JSONObject().put("locations", locations)).getJSONArray("locations").length());
        assertNull(DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "agent_message_chunk")
            .put("content", new JSONObject().put("type", "image").put("data", "not-text"))));
    }
    @Test public void permissionOptionsAndResetAreAllowlisted() throws Exception {
        JSONArray options = DshAcpUpdates.permissionOptions(new JSONArray()
            .put(new JSONObject().put("optionId", "allow").put("kind", "allow_once").put("name", "Allow").put("secret", "no"))
            .put(new JSONObject().put("kind", "custom-permission")));
        assertEquals(1, options.length());
        assertFalse(options.getJSONObject(0).has("secret"));
        JSONObject reset = DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "pythona_stream_reset")
            .put("messageId", "pythona:1:0:0").put("reason", "retry"));
        assertEquals("stream_reset", reset.getString("kind"));
        assertEquals("pythona:1:0:0", reset.getString("messageId"));
        assertNull(DshAcpUpdates.normalize(new JSONObject().put("sessionUpdate", "pythona_stream_reset").put("reason", "unknown")));
    }
}
