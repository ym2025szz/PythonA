package com.pythona.app;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class DshConversationStoreTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();
    private JSONObject payload(String prompt) throws Exception {
        return new JSONObject().put("prompt", prompt).put("provider", "custom").put("model", "a/b");
    }
    private JSONObject done() throws Exception { return new JSONObject().put("kind", "done"); }
    @Test public void explicitRegistryHasStableAcpIdentityAndLatestChronologicalPages() throws Exception {
        DshConversationStore store = new DshConversationStore(temp.getRoot());
        String id = store.create("default", "").getString("id");
        store.attach("default", id, "official-123");
        for (int i = 0; i < 27; i++) {
            store.begin("default", id, "turn-" + i, payload("question-" + i));
            store.append(id, "turn-" + i, new JSONObject().put("kind", "delta").put("text", "answer-" + i));
            store.finish("default", id, "turn-" + i, done());
        }
        JSONObject page = store.readConversation("default", id, -1);
        assertEquals(50, page.getJSONArray("messages").length());
        assertEquals("question-2", page.getJSONArray("messages").getJSONObject(0).getString("content"));
        assertEquals(4, page.getInt("nextBefore"));
        assertEquals(4, store.readConversation("default", id, 4).getJSONArray("messages").length());
        assertEquals("official-123", store.acpSession("default", id));
        assertEquals(1, store.list("default", false, 0).getJSONArray("conversations").length());
    }
    @Test public void workspaceAndPathTraversalAreRejected() throws Exception {
        DshConversationStore store = new DshConversationStore(temp.getRoot());
        String id = store.create("default", "title").getString("id");
        assertThrows(IllegalArgumentException.class, () -> store.readConversation("other", id, -1));
        assertThrows(IllegalArgumentException.class, () -> store.readConversation("default", "../outside", -1));
        assertThrows(IllegalArgumentException.class, () -> store.begin("default", id, "../turn", payload("x")));
    }
    @Test public void restartMarksRunningTurnInterruptedWithoutReexecutionAndKeepsDraft() throws Exception {
        DshConversationStore store = new DshConversationStore(temp.getRoot());
        String id = store.create("default", "").getString("id");
        store.begin("default", id, "turn-1", payload("hello"));
        store.append(id, "turn-1", new JSONObject().put("kind", "delta").put("text", "partial"));
        store.flush(); store.draft("default", id, "next input");
        DshConversationStore restarted = new DshConversationStore(temp.getRoot());
        JSONObject page = restarted.readConversation("default", id, -1);
        assertEquals("interrupted", page.getJSONObject("conversation").getString("status"));
        assertEquals("next input", page.getJSONObject("conversation").getString("draft"));
        assertEquals("partial", page.getJSONArray("messages").getJSONObject(1).getString("content"));
        assertTrue(page.getJSONArray("messages").getJSONObject(1).getBoolean("historyReadOnly"));
        restarted.begin("default", id, "turn-2", payload("continue"));
    }
    @Test public void archivedSessionsCanBeRestoredButNotRunAndActiveTurnsCannotBeArchived() throws Exception {
        DshConversationStore store = new DshConversationStore(temp.getRoot());
        String id = store.create("default", "first").getString("id");
        store.archive("default", id, true);
        assertEquals(0, store.list("default", false, 0).getJSONArray("conversations").length());
        assertEquals(1, store.list("default", true, 0).getJSONArray("conversations").length());
        assertThrows(IllegalStateException.class, () -> store.begin("default", id, "t1", payload("x")));
        store.archive("default", id, false); store.rename("default", id, "renamed");
        store.begin("default", id, "t1", payload("x"));
        assertThrows(IllegalStateException.class, () -> store.archive("default", id, true));
        assertThrows(IllegalStateException.class, () -> store.begin("default", id, "t2", payload("y")));
    }
    @Test public void savedHistoryRedactsSecretsAndRetiresApprovalIds() throws Exception {
        DshConversationStore store = new DshConversationStore(temp.getRoot());
        String id = store.create("default", "").getString("id");
        JSONObject input = payload("API_KEY=supersecret").put("context", new JSONObject().put("apiKey", "not-to-save"));
        store.begin("default", id, "t1", input);
        store.append(id, "t1", new JSONObject().put("kind", "approval_required").put("approvalId", "do-not-restore")
            .put("options", new JSONArray().put("allow")));
        store.finish("default", id, "t1", done());
        String encoded = store.readConversation("default", id, -1).toString();
        assertFalse(encoded.contains("not-to-save"));
        assertFalse(encoded.contains("do-not-restore"));
        assertFalse(encoded.contains("\"options\""));
    }
    @Test public void cancelledTurnIsNotSuccessAndDuplicateTurnIsRejected() throws Exception {
        DshConversationStore store = new DshConversationStore(temp.getRoot());
        String id = store.create("default", "").getString("id");
        store.begin("default", id, "t1", payload("x"));
        store.finish("default", id, "t1", done().put("stopReason", "cancelled"));
        assertEquals("cancelled", store.readConversation("default", id, -1).getJSONObject("conversation").getString("status"));
        assertThrows(IllegalStateException.class, () -> store.begin("default", id, "t1", payload("x")));
    }
    @Test public void streamReconciliationReplacesOnlyCurrentMessage() throws Exception {
        DshConversationStore store = new DshConversationStore(temp.getRoot());
        String id = store.create("default", "").getString("id");
        store.begin("default", id, "t1", payload("x"));
        store.append(id, "t1", new JSONObject().put("kind", "delta").put("messageId", "a").put("text", "first "));
        store.append(id, "t1", new JSONObject().put("kind", "delta").put("messageId", "b").put("text", "wrong"));
        store.append(id, "t1", new JSONObject().put("kind", "stream_reset").put("messageId", "b"));
        store.append(id, "t1", new JSONObject().put("kind", "delta").put("messageId", "b").put("text", "correct"));
        store.finish("default", id, "t1", done());
        assertEquals("first correct", store.readConversation("default", id, -1).getJSONArray("messages").getJSONObject(1).getString("content"));
    }
    @Test public void largeTranscriptIsBoundedAndMarkedTruncated() throws Exception {
        DshConversationStore store = new DshConversationStore(temp.getRoot());
        String id = store.create("default", "").getString("id");
        store.begin("default", id, "t1", payload("x"));
        store.append(id, "t1", new JSONObject().put("kind", "delta").put("text", "word ".repeat(50000)));
        store.finish("default", id, "t1", done());
        File file = new File(temp.getRoot(), "dsh-conversations/" + id + "/t1.json");
        assertTrue(Files.size(file.toPath()) <= 256 * 1024);
        assertTrue(store.readConversation("default", id, -1).getJSONArray("messages").getJSONObject(1).getBoolean("truncated"));
    }
}
