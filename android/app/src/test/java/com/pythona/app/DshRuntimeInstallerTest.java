package com.pythona.app;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

public final class DshRuntimeInstallerTest {
    private Path temporary;
    @Before public void setup() throws Exception { temporary = Files.createTempDirectory("dsh-install-test-"); }
    @After public void cleanup() throws Exception { DshRuntimeInstaller.deleteTreeNoFollow(temporary); }

    @Test public void verifiesArchiveAndReportsStagesThenReusesReadyTree() throws Exception {
        byte[] tar = archive(entry("usr/local/bin/node", "node"));
        AtomicInteger opens = new AtomicInteger();
        List<String> progress = new ArrayList<>();
        DshRuntimeInstaller installer = installer(tar, tar, opens, progress);
        Path root = installer.ensureInstalled().toPath();
        assertEquals("node", readText(root.resolve("usr/local/bin/node")));
        assertTrue(installer.isReady());
        assertTrue(progress.containsAll(Arrays.asList("verifying", "extracting", "validating", "ready")));
        installer.ensureInstalled();
        assertEquals(1, opens.get());
        installer(tar, tar, opens, progress).ensureInstalled();
        assertEquals("A verified installation must not reopen the archive", 1, opens.get());
    }

    @Test public void archiveDigestFailureLeavesExistingRuntimeUntouched() throws Exception {
        byte[] tar = archive(entry("usr/local/bin/node", "node"));
        Path original = temporary.resolve("rootfs/usr/local/bin/node");
        Files.createDirectories(original.getParent()); writeText(original, "old-runtime");
        byte[] corrupt = tar.clone(); corrupt[512] ^= 1;
        DshRuntimeInstaller installer = installer(tar, corrupt, new AtomicInteger(), new ArrayList<>());
        assertThrows(IOException.class, installer::ensureInstalled);
        assertEquals("old-runtime", readText(original));
        assertFalse(Files.exists(temporary.resolve("rootfs-stage")));
        assertFalse(installer.isReady());
    }

    @Test public void damagedCriticalFileIsRepairedAndSessionStateSurvives() throws Exception {
        byte[] tar = archive(entry("usr/local/bin/node", "node"));
        installer(tar, tar, new AtomicInteger(), new ArrayList<>()).ensureInstalled();
        Path root = temporary.resolve("rootfs");
        writeText(root.resolve("usr/local/bin/node"), "bad!");
        Path session = root.resolve("root/.dsh/storages/session.json");
        Files.createDirectories(session.getParent()); writeText(session, "keep-session");
        DshRuntimeInstaller repaired = installer(tar, tar, new AtomicInteger(), new ArrayList<>());
        repaired.ensureInstalled();
        assertEquals("node", readText(root.resolve("usr/local/bin/node")));
        assertEquals("keep-session", readText(session));
        assertTrue(Files.exists(temporary.resolve("rootfs-previous")));
    }

    @Test public void interruptedStageIsDiscardedAndRetryUsesBundledArchive() throws Exception {
        byte[] tar = archive(entry("usr/local/bin/node", "node"));
        Path partial = temporary.resolve("rootfs-stage/usr/local/bin/node");
        Files.createDirectories(partial.getParent()); writeText(partial, "partial");
        installer(tar, tar, new AtomicInteger(), new ArrayList<>()).ensureInstalled();
        assertEquals("node", readText(temporary.resolve("rootfs/usr/local/bin/node")));
        assertFalse(Files.exists(temporary.resolve("rootfs-stage")));
    }

    @Test public void activationInterruptedAfterOldRenameRecoversOriginalBeforeContinuing() throws Exception {
        byte[] tar = archive(entry("usr/local/bin/node", "node"));
        installer(tar, tar, new AtomicInteger(), new ArrayList<>()).ensureInstalled();
        Files.move(temporary.resolve("rootfs"), temporary.resolve("rootfs-previous"));
        AtomicInteger opens = new AtomicInteger();
        DshRuntimeInstaller recovered = installer(tar, tar, opens, new ArrayList<>());
        recovered.ensureInstalled();
        assertEquals(0, opens.get());
        assertTrue(recovered.isReady());
    }

    @Test public void malformedTarDoesNotBecomeReadyEvenWithMatchingArchiveHash() throws Exception {
        byte[] tar = archive(entry("usr/local/bin/node", "node"));
        byte[] truncated = Arrays.copyOf(tar, 515);
        DshRuntimeInstaller installer = installer(truncated, truncated, new AtomicInteger(), new ArrayList<>());
        assertThrows(IOException.class, installer::ensureInstalled);
        assertFalse(installer.isReady());
    }

    @Test public void traversalAndBadChecksumAreRejected() throws Exception {
        Path destination = temporary.resolve("stage");
        byte[] traversal = archive(entry("../escape", "bad"));
        assertThrows(IOException.class, () -> extract(traversal, destination));
        assertFalse(Files.exists(temporary.resolve("escape")));
        byte[] badChecksum = archive(entry("normal", "ok")); badChecksum[0] ^= 1;
        assertThrows(IOException.class, () -> extract(badChecksum, destination));
    }

    @Test public void duplicateFileCannotReplacePriorPayload() throws Exception {
        byte[] tar = archive(entry("node", "first"), entry("node", "second"));
        assertThrows(IOException.class, () -> extract(tar, temporary.resolve("stage")));
    }

    @Test public void gzipTrailerCorruptionIsRejected() throws Exception {
        byte[] tar = archive(entry("node", "data"));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (java.util.zip.GZIPOutputStream gzip = new java.util.zip.GZIPOutputStream(output)) { gzip.write(tar); }
        byte[] damaged = output.toByteArray(); damaged[damaged.length - 8] ^= 1;
        assertThrows(IOException.class, () -> extract(damaged, temporary.resolve("stage")));
    }

    @Test public void hardlinksUseRootRelativeTargets() throws Exception {
        byte[] tar = archive(entry("usr/bin/original", "data"), new Entry("usr/bin/alias", "", '1', "./usr/bin/original"));
        Path destination = temporary.resolve("stage"); extract(tar, destination);
        assertTrue(Files.isSameFile(destination.resolve("usr/bin/original"), destination.resolve("usr/bin/alias")));
    }

    @Test public void permissionDeniedHardlinkFallsBackToBoundedExecutableCopy() throws Exception {
        Path original = temporary.resolve("original"), alias = temporary.resolve("alias");
        writeText(original, "executable"); assertTrue(original.toFile().setExecutable(true, false));
        long copied = TarGzipExtractor.createHardlinkOrCopy(temporary, alias, original, 10,
            (link, target) -> { throw new java.nio.file.FileSystemException(link.toString(), target.toString(), "EPERM (Operation not permitted)"); });
        assertEquals(10, copied); assertEquals("executable", readText(alias));
        assertFalse(Files.isSameFile(original, alias)); assertTrue(Files.isExecutable(alias));
    }

    @Test public void androidHardlinkDenialWithoutStrerrorStillCopiesSafely() throws Exception {
        Path original = temporary.resolve("original"), alias = temporary.resolve("alias");
        writeText(original, "data");
        assertEquals(4, TarGzipExtractor.createHardlinkOrCopy(temporary, alias, original, 4,
            (link, target) -> { throw new java.nio.file.FileSystemException(link.toString(), target.toString(), null); }));
        assertEquals("data", readText(alias));
    }

    @Test public void hardlinkCopyRejectsExpandedLimitAndUnrelatedIoFailures() throws Exception {
        Path original = temporary.resolve("original"), alias = temporary.resolve("alias");
        writeText(original, "data");
        assertThrows(IOException.class, () -> TarGzipExtractor.createHardlinkOrCopy(temporary, alias, original, 3,
            (link, target) -> { throw new UnsupportedOperationException("hard links unsupported"); }));
        assertFalse(Files.exists(alias));
        IOException failure = assertThrows(IOException.class, () -> TarGzipExtractor.createHardlinkOrCopy(temporary, alias, original, 10,
            (link, target) -> { throw new java.nio.file.FileSystemException(link.toString(), target.toString(), "Input/output error"); }));
        assertTrue(failure.getMessage().contains("Input/output error")); assertFalse(Files.exists(alias));
    }

    @Test public void hardlinkCopyRefusesSymlinkSourceAndExistingDestination() throws Exception {
        requireSymlinks();
        Path original = temporary.resolve("original"), source = temporary.resolve("source"), alias = temporary.resolve("alias");
        writeText(original, "data"); Files.createSymbolicLink(source, original);
        assertThrows(IOException.class, () -> TarGzipExtractor.createHardlinkOrCopy(temporary, alias, source, 10,
            (link, target) -> { throw new java.nio.file.AccessDeniedException(link.toString()); }));
        writeText(alias, "keep");
        assertThrows(IOException.class, () -> TarGzipExtractor.createHardlinkOrCopy(temporary, alias, original, 10,
            (link, target) -> { throw new java.nio.file.AccessDeniedException(link.toString()); }));
        assertEquals("keep", readText(alias));
    }

    @Test public void missingEndMarkerIsRejected() throws Exception {
        byte[] tar = archive(entry("node", "data"));
        assertThrows(IOException.class, () -> extract(Arrays.copyOf(tar, tar.length - 1024), temporary.resolve("stage")));
    }

    @Test public void absoluteRootfsLinksAreRemappedAndCannotEscape() throws Exception {
        requireSymlinks();
        byte[] tar = archive(entry("usr/bin/tool", "tool"), link("bin/tool", "/usr/bin/tool"));
        Path destination = temporary.resolve("stage"); extract(tar, destination);
        assertEquals("tool", readText(destination.resolve("bin/tool")));
        assertFalse(Files.readSymbolicLink(destination.resolve("bin/tool")).isAbsolute());
        byte[] escape = archive(link("bad", "../../outside"));
        assertThrows(IOException.class, () -> extract(escape, temporary.resolve("escape-stage")));
    }

    @Test public void deferredLinksCannotBecomePayloadParents() throws Exception {
        requireSymlinks();
        byte[] tar = archive(link("alias", "real"), entry("alias/file", "payload"));
        assertThrows(IOException.class, () -> extract(tar, temporary.resolve("stage")));
    }

    @Test public void cleanupDeletesLinkWithoutTouchingTarget() throws Exception {
        requireSymlinks();
        Path outside = temporary.resolve("outside"), stage = temporary.resolve("stage");
        Files.createDirectories(outside); writeText(outside.resolve("keep"), "untouched");
        Files.createDirectories(stage); Files.createSymbolicLink(stage.resolve("linked"), outside);
        DshRuntimeInstaller.deleteTreeNoFollow(stage);
        assertEquals("untouched", readText(outside.resolve("keep")));
    }

    @Test public void repairPreservesProotSessionAliasWithoutPointingAtOldRootfs() throws Exception {
        requireSymlinks();
        byte[] tar = archive(entry("usr/local/bin/node", "node"));
        installer(tar, tar, new AtomicInteger(), new ArrayList<>()).ensureInstalled();
        Path root = temporary.resolve("rootfs"), androidAlias = temporary.resolve("android-data-alias");
        Files.createSymbolicLink(androidAlias, root);
        Path sessionDirectory = root.resolve("root/.dsh/sessions/--root--/session-id");
        Files.createDirectories(sessionDirectory);
        Path data = sessionDirectory.resolve(".l2s.session.jsonl.zstd.123.tmp0001");
        writeText(data, "saved-session");
        Path link = sessionDirectory.resolve("session.jsonl.zstd");
        Files.createSymbolicLink(link, androidAlias.resolve(root.relativize(data)));
        writeText(root.resolve("usr/local/bin/node"), "bad!");
        installer(tar, tar, new AtomicInteger(), new ArrayList<>()).ensureInstalled();
        assertEquals("saved-session", readText(link));
        assertFalse(Files.readSymbolicLink(link).isAbsolute());
        assertTrue(link.toRealPath().startsWith(root.toRealPath()));
    }

    @Test public void stateSymlinksMapVirtualAndPhysicalRootsToReplacement() throws Exception {
        Path oldRoot = temporary.resolve("old"), newRoot = temporary.resolve("new");
        Files.createDirectories(oldRoot); Files.createDirectories(newRoot);
        Path oldLink = oldRoot.resolve("root/.dsh/profiles/entry"), newLink = newRoot.resolve("root/.dsh/profiles/entry");
        Path virtual = DshRuntimeInstaller.remapStateSymlink(oldRoot, newRoot, oldLink, newLink,
            java.nio.file.Paths.get("/usr/local/lib/official"));
        assertEquals(newRoot.resolve("usr/local/lib/official"), newLink.getParent().resolve(virtual).normalize());
        Path physical = DshRuntimeInstaller.remapStateSymlink(oldRoot, newRoot, oldLink, newLink,
            oldRoot.resolve("usr/local/lib/official"));
        assertEquals(virtual, physical);
        Path relative = DshRuntimeInstaller.remapStateSymlink(oldRoot, newRoot, oldLink, newLink,
            java.nio.file.Paths.get("../../../.dsh/config"));
        assertTrue(newLink.getParent().resolve(relative).normalize().startsWith(newRoot));
    }

    @Test public void stateSymlinksAcceptFilesystemAliasButRejectExternalTargets() throws Exception {
        requireSymlinks();
        Path oldRoot = temporary.resolve("old"), newRoot = temporary.resolve("new"), alias = temporary.resolve("android-alias");
        Files.createDirectories(oldRoot); Files.createDirectories(newRoot); Files.createSymbolicLink(alias, oldRoot);
        Path oldLink = oldRoot.resolve("root/.dsh/plugin"), newLink = newRoot.resolve("root/.dsh/plugin");
        Path remapped = DshRuntimeInstaller.remapStateSymlink(oldRoot, newRoot, oldLink, newLink,
            alias.resolve("usr/local/lib/plugin"));
        assertEquals(newRoot.resolve("usr/local/lib/plugin"), newLink.getParent().resolve(remapped).normalize());
        Path outside = temporary.resolve("outside"); Files.createDirectories(outside); writeText(outside.resolve("keep"), "safe");
        assertThrows(IOException.class, () -> DshRuntimeInstaller.remapStateSymlink(oldRoot, newRoot, oldLink, newLink,
            outside.resolve("keep")));
        assertThrows(IOException.class, () -> DshRuntimeInstaller.remapStateSymlink(oldRoot, newRoot, oldLink, newLink,
            java.nio.file.Paths.get("../../../../outside/keep")));
        assertThrows(IOException.class, () -> DshRuntimeInstaller.remapStateSymlink(oldRoot, newRoot, oldLink, newLink,
            java.nio.file.Paths.get("/usr/../../outside/keep")));
        assertEquals("safe", readText(outside.resolve("keep")));
    }

    private static String readText(Path path) throws IOException {
        return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    }
    private static void writeText(Path path, String text) throws IOException {
        Files.write(path, text.getBytes(StandardCharsets.UTF_8));
    }

    private void requireSymlinks() throws IOException {
        Path link = temporary.resolve("symlink-probe");
        try { Files.createSymbolicLink(link, temporary); Files.delete(link); }
        catch (UnsupportedOperationException | IOException | SecurityException unavailable) { Assume.assumeNoException(unavailable); }
    }

    private DshRuntimeInstaller installer(byte[] expected, byte[] actual, AtomicInteger opens,
                                          List<String> progress) throws Exception {
        byte[] content = "node".getBytes(StandardCharsets.UTF_8);
        JSONObject manifest = new JSONObject().put("format", 1).put("version", "test-v1")
            .put("asset", "runtime.bin").put("size", expected.length).put("sha256", hash(expected))
            .put("unpackedBytes", content.length)
            .put("criticalFiles", new JSONArray().put(new JSONObject()
                .put("path", "usr/local/bin/node").put("size", content.length).put("sha256", hash(content))));
        return new DshRuntimeInstaller(temporary.toFile(), name -> {
            opens.incrementAndGet(); return new ByteArrayInputStream(actual);
        }, manifest.toString().getBytes(StandardCharsets.UTF_8), (stage, done, total) -> progress.add(stage));
    }

    private static void extract(byte[] tar, Path destination) throws IOException {
        TarGzipExtractor.extractAuto(new ByteArrayInputStream(tar), destination.toFile(), 0, false,
            (bytes, entries) -> {});
    }
    private static Entry entry(String path, String content) { return new Entry(path, content, '0', ""); }
    private static Entry link(String path, String target) { return new Entry(path, "", '2', target); }
    private static byte[] archive(Entry... entries) throws IOException {
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        for (Entry entry : entries) {
            byte[] header = new byte[512], content = entry.content.getBytes(StandardCharsets.UTF_8);
            put(header, 0, entry.path); put(header, 100, "0000755"); put(header, 124, String.format("%011o", content.length));
            Arrays.fill(header, 148, 156, (byte) ' '); header[156] = (byte) entry.type;
            put(header, 157, entry.target); put(header, 257, "ustar");
            int checksum = 0; for (byte value : header) checksum += value & 0xff;
            put(header, 148, String.format("%06o\0 ", checksum));
            result.write(header); result.write(content);
            result.write(new byte[(512 - content.length % 512) % 512]);
        }
        result.write(new byte[1024]); return result.toByteArray();
    }
    private static void put(byte[] target, int offset, String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8); System.arraycopy(bytes, 0, target, offset, bytes.length);
    }
    private static String hash(byte[] content) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(content)) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }
    private static final class Entry {
        final String path, content, target; final char type;
        Entry(String path, String content, char type, String target) { this.path=path; this.content=content; this.type=type; this.target=target; }
    }
}
