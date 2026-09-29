package com.pythona.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public final class PythonEngineContractTest {
    private File root;

    @Before
    public void createWorkspace() throws IOException {
        root = Files.createTempDirectory("pythona-engine-contract-").toFile();
        Files.write(
            new File(root, "main.py").toPath(),
            "print('ok')\n".getBytes(StandardCharsets.UTF_8));
    }

    @After
    public void removeWorkspace() throws IOException {
        if (root != null) delete(root);
    }

    @Test
    public void runFileValidationRejectsTraversalAndDirectory() throws Exception {
        assertEquals(
            new File(root, "main.py").getCanonicalFile(),
            PythonEngine.requireContainedRegularFile(root.getCanonicalFile(), new File("main.py")));
        assertThrows(
            IOException.class,
            () -> PythonEngine.requireContainedRegularFile(
                root.getCanonicalFile(), new File(root, "../outside.py")));
        assertThrows(
            IOException.class,
            () -> PythonEngine.requireContainedRegularFile(root.getCanonicalFile(), root));
    }

    @Test
    public void packagedGzipAndTrailingDashNamesAreRestored() {
        assertEquals("archive.tar.gz", PythonRuntimeInstaller.decodedAssetName("archive.tar.gz-"));
        assertEquals("intentional-", PythonRuntimeInstaller.decodedAssetName("intentional--"));
        assertEquals("_path", PythonRuntimeInstaller.decodedAssetName("x-pythona-u-path"));
        assertEquals(
            "x-pythona-u-real",
            PythonRuntimeInstaller.decodedAssetName("x-pythona-e-x-pythona-u-real"));
        assertEquals(
            "x-pythona-u-archive.gz",
            PythonRuntimeInstaller.decodedAssetName(
                "x-pythona-e-x-pythona-u-archive.gz-"));
        assertEquals("normal.py", PythonRuntimeInstaller.decodedAssetName("normal.py"));
    }

    @Test
    public void configurationKeepsPackImportAndNativePlansImmutable() {
        File importPath = new File(root, "pack-python");
        File nativeLibrary = new File(root, "libpack.so");
        PythonEngine.Configuration configuration = new PythonEngine.Configuration(
            root,
            root,
            Collections.singletonList(importPath),
            Collections.singletonList(nativeLibrary));

        assertEquals(Collections.singletonList(importPath), configuration.extraImportPaths);
        assertEquals(Collections.singletonList(nativeLibrary), configuration.preloadLibraries);
        assertThrows(
            UnsupportedOperationException.class,
            () -> configuration.preloadLibraries.add(new File(root, "other.so")));
    }

    private static void delete(File file) throws IOException {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) delete(child);
            }
        }
        Files.deleteIfExists(file.toPath());
    }
}
