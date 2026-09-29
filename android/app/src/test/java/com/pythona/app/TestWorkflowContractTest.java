package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import static org.junit.Assert.*;

public class TestWorkflowContractTest {
    @Test public void testConfigurationSurvivesStoreReopenAndRejectsShellArguments() throws Exception {
        Path root = Files.createTempDirectory("pythona-test-config-");
        try {
            JSONObject original = new JSONObject().put("id", "suite").put("type", "test")
                .put("target", "tests").put("framework", "unittest")
                .put("paths", new JSONArray().put("tests/test_demo.py"))
                .put("nodeId", "tests/test_demo.py::Case::test_works")
                .put("testArgs", new JSONArray().put("-q"));
            new ProjectModelStore(root.toFile(), "default").saveRunConfigurations(new JSONArray().put(original));
            JSONObject loaded = new ProjectModelStore(root.toFile(), "default").runConfigurations().getJSONObject(0);
            assertEquals("test", loaded.getString("type"));
            assertEquals("unittest", loaded.getString("framework"));
            assertEquals(original.getJSONArray("paths").toString(), loaded.getJSONArray("paths").toString());
            assertEquals(original.getString("nodeId"), loaded.getString("nodeId"));
            assertEquals("-q", loaded.getJSONArray("testArgs").getString(0));
            original.put("testArgs", "pytest tests");
            assertThrows(IllegalArgumentException.class, () -> new ProjectModelStore(root.toFile(), "default")
                .saveRunConfigurations(new JSONArray().put(original)));
        } finally {
            try (var paths = Files.walk(root)) { paths.sorted(Comparator.reverseOrder()).forEach(p -> { try { Files.delete(p); } catch(Exception e) { throw new RuntimeException(e); } }); }
        }
    }

    @Test public void testAdmissionUsesOrderedControlLaneAndHostErrorsAreRejected() throws Exception {
        assertTrue(RuntimeHostService.isConcurrentRuntimeMethod("run"));
        assertTrue(RuntimeHostService.isConcurrentRuntimeMethod("cancel"));
        assertThrows(IllegalStateException.class, () -> RuntimeHostService.requireTestResult(
            new JSONObject().put("error", "workspaceRoot is required").put("code", "invalid-workspace")));
        assertEquals(2, RuntimeHostService.requireTestResult(new JSONObject().put("result", new JSONObject().put("count", 2))).getInt("count"));
    }
}
