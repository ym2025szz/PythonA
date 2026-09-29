package com.pythona.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class RuntimePackPolicyTest {
    private static final String UUID = "123e4567-e89b-12d3-a456-426614174000";

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void reservedBuildIdsCannotAliasStateFilesOrStaging() throws Exception {
        RuntimePackManager.validateBuildId("numpy-2.4.0-arm64");
        assertTrue(RuntimePackManager.isReservedBuildId(".staging-attacker"));
        assertTrue(RuntimePackManager.isReservedBuildId("active.json"));
        assertFalse(RuntimePackManager.isReservedBuildId("release-2026.09"));
        assertThrows(IOException.class, () -> RuntimePackManager.validateBuildId("active.json"));
        assertThrows(IOException.class, () -> RuntimePackManager.validateBuildId(".."));
    }

    @Test
    public void dependenciesUseExactPackAndVersionIdentity() throws Exception {
        assertArrayEquals(
            new String[] {"org.pythona.numpy", "2.4.1"},
            RuntimePackManager.parseDependency("org.pythona.numpy@2.4.1"));
        assertThrows(
            IOException.class,
            () -> RuntimePackManager.parseDependency("org.pythona.numpy@>=2.4"));
        assertThrows(
            IOException.class,
            () -> RuntimePackManager.parseDependency("missing-version@"));
    }

    @Test
    public void nativePayloadsStayInArm64OrPythonTrees() throws Exception {
        RuntimePackManager.validatePayloadKind("lib/arm64-v8a/libtorch.so", "native");
        RuntimePackManager.validatePayloadKind("python/torch/_C.so", "native");
        // Compatibility with the v1 builder: extension modules under python/
        // are detected by suffix and hardened even when classified as python.
        RuntimePackManager.validatePayloadKind("python/numpy/_core.so", "python");
        assertThrows(
            IOException.class,
            () -> RuntimePackManager.validatePayloadKind("lib/x86_64/libtorch.so", "native"));
        assertThrows(
            IOException.class,
            () -> RuntimePackManager.validatePayloadKind("metadata/unsigned.so", "metadata"));
    }

    @Test
    public void cleanupRemovesOnlyStrictManagedStagingDirectories() throws Exception {
        File packDirectory = temporaryFolder.newFolder("packs");
        File managed = createDirectory(packDirectory, ".staging-" + UUID);
        File lookalike = createDirectory(packDirectory, ".staging-not-a-uuid");
        File ordinary = createDirectory(packDirectory, "numpy-build");
        writeMarker(managed, "incomplete");
        writeMarker(lookalike, "keep-lookalike");
        writeMarker(ordinary, "keep-build");

        RuntimePackManager.cleanupPackTransientsLocked(packDirectory);

        assertFalse(managed.exists());
        assertTrue(lookalike.isDirectory());
        assertTrue(ordinary.isDirectory());
        assertEquals("keep-lookalike", readMarker(lookalike));
        assertEquals("keep-build", readMarker(ordinary));
    }

    @Test
    public void cleanupRestoresInterruptedReplacementWhenTargetIsMissing() throws Exception {
        File packDirectory = temporaryFolder.newFolder("restore-packs");
        File quarantine = createDirectory(
            packDirectory, ".replaced-numpy-2.4.1-arm64-" + UUID);
        writeMarker(quarantine, "old-signed-build");

        RuntimePackManager.cleanupPackTransientsLocked(packDirectory);

        File restored = new File(packDirectory, "numpy-2.4.1-arm64");
        assertFalse(quarantine.exists());
        assertTrue(restored.isDirectory());
        assertEquals("old-signed-build", readMarker(restored));
    }

    @Test
    public void cleanupDeletesReplacementQuarantineWhenTargetExists() throws Exception {
        File packDirectory = temporaryFolder.newFolder("committed-packs");
        File target = createDirectory(packDirectory, "numpy-2.4.1-arm64");
        File quarantine = createDirectory(
            packDirectory, ".replaced-numpy-2.4.1-arm64-" + UUID);
        writeMarker(target, "new-build");
        writeMarker(quarantine, "old-build");

        RuntimePackManager.cleanupPackTransientsLocked(packDirectory);

        assertTrue(target.isDirectory());
        assertEquals("new-build", readMarker(target));
        assertFalse(quarantine.exists());
    }

    @Test
    public void cleanupRemovesOnlyStrictManagedImportArchives() throws Exception {
        File importDirectory = temporaryFolder.newFolder("imports");
        File managed = new File(importDirectory, UUID + ".pya-pack");
        File userArchive = new File(importDirectory, "numpy-2.4.1.pya-pack");
        File lookalike = new File(importDirectory, UUID + ".pya-pack.backup");
        Files.write(managed.toPath(), "temporary".getBytes(StandardCharsets.UTF_8));
        Files.write(userArchive.toPath(), "user".getBytes(StandardCharsets.UTF_8));
        Files.write(lookalike.toPath(), "backup".getBytes(StandardCharsets.UTF_8));

        RuntimePackManager.cleanupImportTempsLocked(importDirectory);

        assertFalse(managed.exists());
        assertTrue(userArchive.isFile());
        assertTrue(lookalike.isFile());
    }

    private static File createDirectory(File parent, String name) throws IOException {
        File directory = new File(parent, name);
        if (!directory.mkdir()) throw new IOException("Unable to create " + directory);
        return directory;
    }

    private static void writeMarker(File directory, String value) throws IOException {
        Files.write(
            new File(directory, "marker.txt").toPath(),
            value.getBytes(StandardCharsets.UTF_8));
    }

    private static String readMarker(File directory) throws IOException {
        return new String(
            Files.readAllBytes(new File(directory, "marker.txt").toPath()),
            StandardCharsets.UTF_8);
    }
}
