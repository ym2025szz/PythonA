package com.pythona.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class PurePythonWheelManagerTest {
    private static final String FILE_NAME = "demo_pkg-1.2.3-py3-none-any.whl";
    private static final String DIST_INFO = "demo_pkg-1.2.3.dist-info";

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void filenamePolicyAllowsOnlyGenericPurePythonTags() throws Exception {
        assertEquals(
            "py3-none-any",
            PurePythonWheelManager.parseWheelFileName(FILE_NAME).tag());
        assertEquals(
            "py314-none-any",
            PurePythonWheelManager.parseWheelFileName(
                "demo_pkg-1.2.3-py314-none-any.whl").tag());

        assertThrows(IOException.class, () ->
            PurePythonWheelManager.parseWheelFileName(
                "demo_pkg-1.2.3-cp314-none-any.whl"));
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.parseWheelFileName(
                "demo_pkg-1.2.3-cp314-cp314-android_26_arm64_v8a.whl"));
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.parseWheelFileName(
                "demo_pkg-1.2.3-py3-none-manylinux_2_28_aarch64.whl"));
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.parseWheelFileName(
                "demo_pkg-1.2.3-py3-none-musllinux_1_2_aarch64.whl"));
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.parseWheelFileName("demo_pkg-1.2.3.tar.gz"));
    }

    @Test
    public void validWheelInstallsAtomicallyAndBecomesRuntimeImportPath() throws Exception {
        File wheel = buildWheel("valid.whl", new LinkedHashMap<>() {{
            put("demo_pkg/__init__.py", "VALUE = 42\n".getBytes(StandardCharsets.UTF_8));
        }}, true, null);
        File environments = temporaryFolder.newFolder("environments");
        File imports = temporaryFolder.newFolder("imports");
        PurePythonWheelManager manager = new PurePythonWheelManager(environments, imports);
        try {
            PurePythonWheelManager.InstalledWheel installed = manager.installVerifiedWheel(
                wheel, FILE_NAME, PurePythonWheelManager.DEFAULT_ENVIRONMENT);
            assertEquals("demo-pkg", installed.normalizedName);
            assertEquals("1.2.3", installed.version);
            assertTrue(new File(installed.sitePackages, "demo_pkg/__init__.py").isFile());
            assertEquals(
                "VALUE = 42\n",
                new String(
                    Files.readAllBytes(new File(
                        installed.sitePackages,
                        "demo_pkg/__init__.py").toPath()),
                    StandardCharsets.UTF_8));

            PurePythonWheelManager.RuntimeEnvironment runtime =
                manager.prepareRuntimeEnvironment(PurePythonWheelManager.DEFAULT_ENVIRONMENT);
            assertEquals(1, runtime.wheels.size());
            assertEquals(1, runtime.pythonImportPaths.size());
            assertEquals(
                installed.sitePackages.getCanonicalFile(),
                runtime.pythonImportPaths.get(0).getCanonicalFile());

            // Reinstalling byte-identical content reuses the content-addressed
            // build and does not create another active package.
            PurePythonWheelManager.InstalledWheel repeated = manager.installVerifiedWheel(
                wheel, FILE_NAME, PurePythonWheelManager.DEFAULT_ENVIRONMENT);
            assertEquals(installed.wheelSha256, repeated.wheelSha256);
            assertEquals(1, manager.prepareRuntimeEnvironment("default").wheels.size());
        } finally {
            makeWritable(environments);
        }
    }

    @Test
    public void runtimeSnapshotRejectsFilesChangedAfterInstallation() throws Exception {
        File wheel = buildWheel("tamper.whl", new LinkedHashMap<>() {{
            put("demo_pkg/__init__.py", "VALUE = 42\n".getBytes(StandardCharsets.UTF_8));
        }}, true, null);
        File environments = temporaryFolder.newFolder("tamper-environments");
        PurePythonWheelManager manager = new PurePythonWheelManager(
            environments,
            temporaryFolder.newFolder("tamper-imports"));
        try {
            PurePythonWheelManager.InstalledWheel installed = manager.installVerifiedWheel(
                wheel, FILE_NAME, PurePythonWheelManager.DEFAULT_ENVIRONMENT);
            File module = new File(installed.sitePackages, "demo_pkg/__init__.py");
            assertTrue(module.setWritable(true, true) || module.canWrite());
            Files.write(module.toPath(), "VALUE = 99\n".getBytes(StandardCharsets.UTF_8));
            assertThrows(IOException.class, () ->
                manager.prepareRuntimeEnvironment(PurePythonWheelManager.DEFAULT_ENVIRONMENT));
        } finally {
            makeWritable(environments);
        }
    }

    @Test
    public void purelibDataIsMappedButScriptsAreRejected() throws Exception {
        File purelib = buildWheel("purelib.whl", new LinkedHashMap<>() {{
            put("demo_pkg-1.2.3.data/purelib/demo_extra.py",
                "EXTRA = True\n".getBytes(StandardCharsets.UTF_8));
        }}, true, null);
        PurePythonWheelManager.ValidatedWheel validated =
            PurePythonWheelManager.validateArchive(purelib, FILE_NAME);
        assertTrue(validated.payloads.stream().anyMatch(
            item -> "demo_extra.py".equals(item.installPath)));

        File scripts = buildWheel("scripts.whl", new LinkedHashMap<>() {{
            put("demo_pkg-1.2.3.data/scripts/demo",
                "#!/usr/bin/env python\n".getBytes(StandardCharsets.UTF_8));
        }}, true, null);
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.validateArchive(scripts, FILE_NAME));
    }

    @Test
    public void nativeNamesAndDisguisedNativeMagicAreRejected() throws Exception {
        File extension = buildWheel("native-name.whl", new LinkedHashMap<>() {{
            put("demo_pkg/_core.so", new byte[] {1, 2, 3, 4});
        }}, true, null);
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.validateArchive(extension, FILE_NAME));

        File disguised = buildWheel("native-magic.whl", new LinkedHashMap<>() {{
            put("demo_pkg/resources/model.bin",
                new byte[] {0x7f, 'E', 'L', 'F', 1, 2, 3});
        }}, true, null);
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.validateArchive(disguised, FILE_NAME));

        File pathHook = buildWheel("path-hook.whl", new LinkedHashMap<>() {{
            put("demo_pkg_bootstrap.pth",
                "import demo_pkg\n".getBytes(StandardCharsets.UTF_8));
        }}, true, null);
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.validateArchive(pathHook, FILE_NAME));
    }

    @Test
    public void traversalCaseCollisionsAndIncompleteRecordAreRejected() throws Exception {
        File traversal = buildWheel("traversal.whl", new LinkedHashMap<>() {{
            put("../escape.py", "bad\n".getBytes(StandardCharsets.UTF_8));
        }}, true, null);
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.validateArchive(traversal, FILE_NAME));

        File collision = buildWheel("collision.whl", new LinkedHashMap<>() {{
            put("demo_pkg/Value.py", "A = 1\n".getBytes(StandardCharsets.UTF_8));
            put("demo_pkg/value.py", "A = 2\n".getBytes(StandardCharsets.UTF_8));
        }}, true, null);
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.validateArchive(collision, FILE_NAME));

        File incomplete = buildWheel("record.whl", new LinkedHashMap<>() {{
            put("demo_pkg/__init__.py", "A = 1\n".getBytes(StandardCharsets.UTF_8));
        }}, false, null);
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.validateArchive(incomplete, FILE_NAME));
    }

    @Test
    public void unixSymlinkEntriesAreRejectedBeforeExtraction() throws Exception {
        File wheel = buildWheel("symlink.whl", new LinkedHashMap<>() {{
            put("demo_pkg/link", "../outside".getBytes(StandardCharsets.UTF_8));
        }}, true, null);
        markCentralEntryAsSymlink(wheel, "demo_pkg/link");
        assertThrows(IOException.class, () ->
            PurePythonWheelManager.validateArchive(wheel, FILE_NAME));
    }

    private File buildWheel(
        String localName,
        LinkedHashMap<String, byte[]> additional,
        boolean completeRecord,
        String wheelHeadersOverride
    ) throws Exception {
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        entries.putAll(additional);
        entries.put(
            DIST_INFO + "/METADATA",
            ("Metadata-Version: 2.4\n"
                + "Name: demo-pkg\n"
                + "Version: 1.2.3\n"
                + "Requires-Dist: helper>=1\n\n").getBytes(StandardCharsets.UTF_8));
        String wheelHeaders = wheelHeadersOverride == null
            ? "Wheel-Version: 1.0\nGenerator: PythonA-test\n"
                + "Root-Is-Purelib: true\nTag: py3-none-any\n\n"
            : wheelHeadersOverride;
        entries.put(DIST_INFO + "/WHEEL", wheelHeaders.getBytes(StandardCharsets.UTF_8));

        StringBuilder record = new StringBuilder();
        boolean skipped = false;
        for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
            if (!completeRecord && !skipped && entry.getKey().startsWith("demo_pkg/")) {
                skipped = true;
                continue;
            }
            record.append(csv(entry.getKey()))
                .append(",sha256=")
                .append(Base64.getUrlEncoder().withoutPadding().encodeToString(
                    MessageDigest.getInstance("SHA-256").digest(entry.getValue())))
                .append(',')
                .append(entry.getValue().length)
                .append("\n");
        }
        record.append(DIST_INFO).append("/RECORD,,\n");
        entries.put(DIST_INFO + "/RECORD", record.toString().getBytes(StandardCharsets.UTF_8));

        File wheel = new File(temporaryFolder.getRoot(), localName);
        try (ZipOutputStream output = new ZipOutputStream(new FileOutputStream(wheel))) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                ZipEntry zipEntry = new ZipEntry(entry.getKey());
                output.putNextEntry(zipEntry);
                output.write(entry.getValue());
                output.closeEntry();
            }
        }
        return wheel;
    }

    private static String csv(String value) {
        if (value.indexOf(',') < 0 && value.indexOf('"') < 0) return value;
        return '"' + value.replace("\"", "\"\"") + '"';
    }

    private static void markCentralEntryAsSymlink(File archive, String target)
        throws Exception {
        try (RandomAccessFile file = new RandomAccessFile(archive, "rw")) {
            long offset = 0;
            while (offset + 46 <= file.length()) {
                file.seek(offset);
                int signature = readLittleInt(file);
                if (signature != 0x02014b50) {
                    offset += 1;
                    continue;
                }
                file.seek(offset + 28);
                int nameLength = readLittleShort(file);
                int extraLength = readLittleShort(file);
                int commentLength = readLittleShort(file);
                byte[] name = new byte[nameLength];
                file.seek(offset + 46);
                file.readFully(name);
                if (target.equals(new String(name, StandardCharsets.UTF_8))) {
                    file.seek(offset + 5);
                    file.write(3); // version-made-by host system: Unix
                    long external = ((long) 0120777) << 16;
                    file.seek(offset + 38);
                    writeLittleInt(file, (int) external);
                    return;
                }
                offset += 46L + nameLength + extraLength + commentLength;
            }
        }
        throw new IOException("Central entry not found: " + target);
    }

    private static int readLittleShort(RandomAccessFile file) throws IOException {
        int low = file.read();
        int high = file.read();
        return low | (high << 8);
    }

    private static int readLittleInt(RandomAccessFile file) throws IOException {
        return readLittleShort(file) | (readLittleShort(file) << 16);
    }

    private static void writeLittleInt(RandomAccessFile file, int value) throws IOException {
        file.write(value & 0xff);
        file.write((value >>> 8) & 0xff);
        file.write((value >>> 16) & 0xff);
        file.write((value >>> 24) & 0xff);
    }

    private static void makeWritable(File root) throws IOException {
        if (root == null || !root.exists()) return;
        Files.walk(root.toPath()).forEach(path -> path.toFile().setWritable(true, false));
    }
}
