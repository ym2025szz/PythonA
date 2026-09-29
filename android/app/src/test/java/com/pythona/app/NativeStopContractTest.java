package com.pythona.app;

import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Test;

/** Source-level guard for the JNI run/stop publication contract. */
public final class NativeStopContractTest {
    @Test
    public void runnerThreadIsPublishedAtomicallyWithTheActiveRun() throws Exception {
        File sourceFile = new File("src/main/cpp/pythona_engine.c");
        if (!sourceFile.isFile()) sourceFile = new File("app/src/main/cpp/pythona_engine.c");
        if (!sourceFile.isFile()) {
            sourceFile = new File("android/app/src/main/cpp/pythona_engine.c");
        }
        assertTrue("native source is available to the contract test", sourceFile.isFile());
        String source = new String(
            Files.readAllBytes(sourceFile.toPath()), StandardCharsets.UTF_8).replace("\r\n", "\n");

        int beginDefinition = source.indexOf(
            "static bool begin_run(const char *run_id, unsigned long python_thread_id)");
        int publishThread = source.indexOf(
            "&g_active_python_thread,\n                python_thread_id", beginDefinition);
        int beginCall = source.indexOf(
            "begin_run(run_id, PyThread_get_thread_ident())", publishThread);
        int acquireGil = source.lastIndexOf("PyGILState_Ensure()", beginCall);

        assertTrue("begin_run accepts the actual runner thread id", beginDefinition >= 0);
        assertTrue("begin_run publishes the runner before returning", publishThread > beginDefinition);
        assertTrue("nativeRunFile acquires the GIL before publishing the run", acquireGil > publishThread);
        assertTrue("nativeRunFile passes its own Python thread id", beginCall > acquireGil);
        int testEntry = source.indexOf("Java_com_pythona_app_PythonEngine_nativeTestJson");
        int testGil = source.indexOf("PyGILState_Ensure()", testEntry);
        int testBegin = source.indexOf("begin_run(run_id, PyThread_get_thread_ident())", testEntry);
        assertTrue("test entry acquires GIL before publishing its runner", testGil > testEntry && testBegin > testGil);
    }
}
