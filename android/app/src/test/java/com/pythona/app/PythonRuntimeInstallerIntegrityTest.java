package com.pythona.app;

import static org.junit.Assert.assertThrows;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Comparator;

import org.junit.After;
import org.junit.Assume;
import org.junit.Test;

public final class PythonRuntimeInstallerIntegrityTest {
    private Path temporaryRoot;

    @After
    public void cleanUp() throws Exception {
        if (temporaryRoot == null || !Files.exists(temporaryRoot)) return;
        Files.walk(temporaryRoot)
            .sorted(Comparator.reverseOrder())
            .forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                    // Best-effort cleanup of a unit-test-only directory.
                }
            });
    }

    @Test
    public void validatesDecodedPathsHashesAndExactTree() throws Exception {
        Fixture fixture = createFixture();
        PythonRuntimeInstaller.verifyManifestTree(
            fixture.root.toFile(), fixture.manifest, false);

        Path extra = fixture.root.resolve("undeclared.py");
        Files.write(extra, "extra\n".getBytes(StandardCharsets.UTF_8));
        assertThrows(
            IOException.class,
            () -> PythonRuntimeInstaller.verifyManifestTree(
                fixture.root.toFile(), fixture.manifest, false));
        Files.delete(extra);

        Files.write(fixture.payload, "tampered\n".getBytes(StandardCharsets.UTF_8));
        assertThrows(
            IOException.class,
            () -> PythonRuntimeInstaller.verifyManifestTree(
                fixture.root.toFile(), fixture.manifest, false));
    }

    @Test
    public void rejectsARewrittenInstalledManifest() throws Exception {
        Fixture fixture = createFixture();
        Files.write(
            fixture.root.resolve(PythonRuntimeInstaller.MANIFEST_NAME),
            "0\t0\tfake.py\n".getBytes(StandardCharsets.UTF_8));
        assertThrows(
            IOException.class,
            () -> PythonRuntimeInstaller.verifyManifestTree(
                fixture.root.toFile(), fixture.manifest, false));
    }

    @Test
    public void markerIsRequiredOnlyAfterCommittedValidation() throws Exception {
        Fixture fixture = createFixture();
        assertThrows(
            IOException.class,
            () -> PythonRuntimeInstaller.verifyManifestTree(
                fixture.root.toFile(), fixture.manifest, true));

        Files.write(
            fixture.root.resolve(".pythona-runtime"),
            ("pythona-cpython-prefix-v3\n"
                + PythonRuntimeInstaller.PYTHON_VERSION + "\n"
                + PythonRuntimeInstaller.PYTHON_ABI + "\n")
                .getBytes(StandardCharsets.UTF_8));
        PythonRuntimeInstaller.verifyManifestTree(
            fixture.root.toFile(), fixture.manifest, true);
    }

    @Test
    public void rejectsSymbolicLinksWhenSupportedByTheHost() throws Exception {
        Fixture fixture = createFixture();
        Path link = fixture.root.resolve("link.py");
        try {
            Files.createSymbolicLink(link, fixture.payload);
        } catch (UnsupportedOperationException | IOException | SecurityException unavailable) {
            Assume.assumeNoException(unavailable);
        }
        assertThrows(
            IOException.class,
            () -> PythonRuntimeInstaller.verifyManifestTree(
                fixture.root.toFile(), fixture.manifest, false));
    }

    private Fixture createFixture() throws Exception {
        temporaryRoot = Files.createTempDirectory("pythona-runtime-integrity-");
        Path payload = temporaryRoot.resolve("lib/python3.14/zipfile/_path/value.py");
        Files.createDirectories(payload.getParent());
        byte[] contents = "value = '完整性🙂'\n".getBytes(StandardCharsets.UTF_8);
        Files.write(payload, contents);
        String encodedPath = "lib/python3.14/zipfile/x-pythona-u-path/value.py";
        byte[] manifest = (hex(MessageDigest.getInstance("SHA-256").digest(contents))
            + "\t" + contents.length + "\t" + encodedPath + "\n")
            .getBytes(StandardCharsets.UTF_8);
        Files.write(
            temporaryRoot.resolve(PythonRuntimeInstaller.MANIFEST_NAME), manifest);
        return new Fixture(temporaryRoot, payload, manifest);
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) output.append(String.format("%02x", value & 0xff));
        return output.toString();
    }

    private static final class Fixture {
        final Path root;
        final Path payload;
        final byte[] manifest;

        Fixture(Path root, Path payload, byte[] manifest) {
            this.root = root;
            this.payload = payload;
            this.manifest = manifest;
        }
    }
}
