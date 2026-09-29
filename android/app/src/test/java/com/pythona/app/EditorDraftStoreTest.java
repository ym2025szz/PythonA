package com.pythona.app;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import java.io.File;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class EditorDraftStoreTest {
    private File root;
    private EditorDraftStore drafts;
    @Before public void setUp() throws Exception { root = Files.createTempDirectory("pythona-drafts-").toFile(); drafts = new EditorDraftStore(root, "default"); }
    @After public void tearDown() throws Exception {
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(root.toPath())) {
            for (java.nio.file.Path path : (Iterable<java.nio.file.Path>)paths.sorted(java.util.Comparator.reverseOrder())::iterator) Files.deleteIfExists(path);
        }
    }
    private JSONObject draft(String path, String content) throws Exception {
        return new JSONObject().put("path",path).put("content",content).put("original","base")
            .put("revision",4).put("hash","abc").put("bufferVersion",9);
    }
    @Test public void roundTripSurvivesRestartAndIsSeparateFromWorkspace() throws Exception {
        drafts.write(draft("src/中文.py","未保存\n"));
        EditorDraftStore reopened = new EditorDraftStore(root,"default");
        assertEquals("未保存\n",reopened.read("src/中文.py").getString("content"));
        assertEquals(4,reopened.read("src/中文.py").getInt("revision"));
        assertFalse(new File(root,"workspaces").exists());
        assertEquals(1,reopened.list().getJSONArray("drafts").length());
        assertFalse(reopened.list().getJSONArray("drafts").getJSONObject(0).has("content"));
    }
    @Test public void pathsCannotTraverseOrUseAbsoluteNames() {
        for (String path : new String[]{"../secret","/root.py","C:/file.py","a/../b","a\\b","a//b","./a","a\u0000b",""}) {
            assertThrows(IllegalArgumentException.class,()->drafts.read(path));
        }
    }
    @Test public void rejectsInvalidWorkspace() {
        assertThrows(IllegalArgumentException.class,()->new EditorDraftStore(root,"../other"));
        assertThrows(IllegalArgumentException.class,()->new EditorDraftStore(root,"/other"));
    }
    @Test public void overwriteIsAtomicAndLeavesNoTemporaryFiles() throws Exception {
        drafts.write(draft("a.py","first")); drafts.write(draft("a.py","second"));
        assertEquals("second",drafts.read("a.py").getString("content"));
        assertEquals(1,new File(root,"editor-drafts/default").list().length);
    }
    @Test public void deletionIsSpecificAndIdempotent() throws Exception {
        drafts.write(draft("a.py","a")); drafts.write(draft("b.py","b"));
        assertTrue(drafts.delete("a.py").getBoolean("deleted")); assertFalse(drafts.delete("a.py").getBoolean("deleted"));
        assertNull(drafts.read("a.py")); assertEquals("b",drafts.read("b.py").getString("content"));
    }
    @Test public void countBoundDoesNotEvictUnsavedDrafts() throws Exception {
        for(int i=0;i<64;i++) drafts.write(draft("file"+i+".py","draft"));
        assertThrows(java.io.IOException.class,()->drafts.write(draft("overflow.py","no")));
        assertEquals(64,drafts.list().getJSONArray("drafts").length());
        drafts.write(draft("file0.py","updated"));
        assertEquals("updated",drafts.read("file0.py").getString("content"));
    }
    @Test public void malformedDraftIsPreservedAndReported() throws Exception {
        drafts.write(draft("a.py","draft"));
        File stored = new File(root,"editor-drafts/default").listFiles()[0];
        Files.write(stored.toPath(),"broken".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThrows(Exception.class,()->drafts.read("a.py"));
        assertEquals(1,drafts.list().getJSONArray("errors").length()); assertTrue(stored.exists());
    }
    @Test public void negativeVersionsRejected() throws Exception {
        assertThrows(IllegalArgumentException.class,()->drafts.write(draft("a.py","draft").put("revision",-1)));
    }
    @Test public void cursorAndScrollPersistWithBoundsAndMissingDefaults() throws Exception {
        drafts.write(draft("a.py","draft").put("viewState",new JSONObject().put("cursor",999).put("scroll",new JSONObject().put("top",-1))));
        JSONObject view=drafts.read("a.py").getJSONObject("viewState");
        assertEquals(5,view.getInt("cursor"));assertEquals(0,view.getJSONObject("scroll").getInt("top"));assertEquals(0,view.getJSONObject("scroll").getInt("left"));
    }
    @Test public void malformedJsonShapeCannotBecomeAnEditorBuffer() throws Exception {
        drafts.write(draft("a.py","draft"));File stored=new File(root,"editor-drafts/default").listFiles()[0];
        JSONObject invalid=draft("a.py","draft").put("schemaVersion",1).put("content",new JSONObject());
        Files.write(stored.toPath(),invalid.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThrows(java.io.IOException.class,()->drafts.read("a.py"));
        assertEquals(0,drafts.list().getJSONArray("drafts").length());assertEquals(1,drafts.list().getJSONArray("errors").length());
    }
}
