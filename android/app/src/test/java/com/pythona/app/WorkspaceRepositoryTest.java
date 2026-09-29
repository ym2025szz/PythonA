package com.pythona.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.io.DataOutputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public final class WorkspaceRepositoryTest {
    private File temporaryRoot;
    private WorkspaceRepository repository;

    @Before
    public void setUp() throws Exception {
        temporaryRoot = Files.createTempDirectory("pythona-workspace-test-").toFile();
        repository = new WorkspaceRepository(temporaryRoot, "test-workspace");
    }

    @After
    public void tearDown() throws Exception {
        if (temporaryRoot != null) deleteRecursively(temporaryRoot);
    }

    @Test
    public void writesReadsHashesAndAdvancesRevisions() throws Exception {
        WorkspaceRepository.Entry first = repository.writeText(
            "src/main.py", "print('one')\n", null, "test");
        assertEquals(1, first.revision);
        assertEquals("print('one')\n", repository.read("src/main.py").text());
        assertEquals(
            WorkspaceRepository.sha256("print('one')\n".getBytes(StandardCharsets.UTF_8)),
            first.sha256);

        WorkspaceRepository.Entry second = repository.writeText(
            "src/main.py", "print('two')\n", first.revision, "test");
        assertEquals(2, second.revision);
        assertNotEquals(first.sha256, second.sha256);
    }

    @Test
    public void rejectsStaleExpectedRevision() throws Exception {
        WorkspaceRepository.Entry current = repository.writeText(
            "main.py", "value = 1\n", null, "test");
        WorkspaceRepository.RevisionConflictException conflict = assertThrows(
            WorkspaceRepository.RevisionConflictException.class,
            () -> repository.writeText("main.py", "value = 2\n", 0L, "test"));
        assertEquals("main.py", conflict.path);
        assertEquals(0, conflict.expectedRevision);
        assertEquals(current.revision, conflict.actualRevision);
    }

    @Test
    public void deleteAndRecreateRetainsMonotonicRevision() throws Exception {
        WorkspaceRepository.Entry first = repository.writeText(
            "main.py", "one\n", null, "test");
        assertTrue(repository.delete("main.py", first.revision, "test"));
        assertEquals(2, repository.revision("main.py"));
        assertEquals(1, repository.tombstones().size());
        assertEquals("main.py", repository.tombstones().get(0).path);
        assertEquals(2, repository.tombstones().get(0).revision);
        WorkspaceRepository.Entry recreated = repository.writeText(
            "main.py", "two\n", 2L, "test");
        assertEquals(3, recreated.revision);
        assertTrue(repository.tombstones().isEmpty());
    }

    @Test
    public void usesExplicitWorkspaceRootDirectory() throws Exception {
        File expected = new File(
            new File(new File(temporaryRoot, "workspaces"), "test-workspace"), "root")
            .getCanonicalFile();
        assertEquals(expected, repository.rootDirectory());
    }

    @Test
    public void reconcilesExternalModificationAndDeletion() throws Exception {
        WorkspaceRepository.Entry first = repository.writeText(
            "src/main.py", "one\n", null, "test");
        File file = new File(repository.rootDirectory(), "src/main.py");
        Files.write(file.toPath(), "external\n".getBytes(StandardCharsets.UTF_8));

        WorkspaceRepository.Entry changed = repository.read("src/main.py");
        assertEquals(first.revision + 1, changed.revision);
        assertEquals("external\n", changed.text());

        assertTrue(file.delete());
        assertTrue(repository.list().isEmpty());
        WorkspaceRepository.Entry recreated = repository.writeText(
            "src/main.py", "again\n", changed.revision + 1, "test");
        assertEquals(changed.revision + 2, recreated.revision);
    }

    @Test
    public void externalReconcileEmitsCreatedChangedAndDeletedEvents() throws Exception {
        WorkspaceRepository.Entry initial = repository.writeText(
            "main.py", "one\n", null, "editor");
        List<WorkspaceRepository.Change> changes = new ArrayList<>();
        repository.addListener(changes::add);

        File main = new File(repository.rootDirectory(), "main.py");
        Files.write(main.toPath(), "two\n".getBytes(StandardCharsets.UTF_8));
        File added = new File(repository.rootDirectory(), "added.py");
        Files.write(added.toPath(), "added\n".getBytes(StandardCharsets.UTF_8));
        repository.reconcileExternalChanges("runtime");

        assertEquals(2, changes.size());
        assertEquals("created", changes.get(0).type);
        assertEquals("added.py", changes.get(0).path);
        assertEquals("changed", changes.get(1).type);
        assertEquals("main.py", changes.get(1).path);
        assertEquals(initial.revision + 1, changes.get(1).revision);
        assertEquals("runtime", changes.get(1).source);

        changes.clear();
        assertTrue(added.delete());
        repository.reconcileExternalChanges("runtime");
        assertEquals(1, changes.size());
        assertEquals("deleted", changes.get(0).type);
        assertEquals("added.py", changes.get(0).path);
    }

    @Test
    public void listIsSortedAndOmitsAtomicTemporaryFiles() throws Exception {
        repository.writeText("z.py", "z\n", null, "test");
        repository.writeText("a/a.py", "a\n", null, "test");
        repository.writeText("m.py", "m\n", null, "test");
        Files.write(
            new File(repository.rootDirectory(), ".ignored.pythona-token.tmp").toPath(),
            "temporary".getBytes(StandardCharsets.UTF_8));

        List<WorkspaceRepository.Summary> files = repository.list();
        assertEquals(3, files.size());
        assertEquals("a/a.py", files.get(0).path);
        assertEquals("m.py", files.get(1).path);
        assertEquals("z.py", files.get(2).path);
    }

    @Test
    public void binaryArtifactsAreListedWithoutBeingLoadedIntoTheEditor() throws Exception {
        File model = new File(repository.rootDirectory(), "model.pt");
        Files.write(model.toPath(), new byte[] {0, 1, 2, 3, 4, 5});

        List<WorkspaceRepository.Summary> files = repository.reconcileExternalChanges("runtime");
        assertEquals(1, files.size());
        assertEquals("model.pt", files.get(0).path);
        assertEquals(6, files.get(0).size);
        assertFalse(files.get(0).editable);
        assertThrows(IOException.class, () -> repository.read("model.pt"));
    }

    @Test
    public void rejectsTraversalAndAbsolutePaths() {
        String[] unsafe = {
            "../secret.py", "src/../secret.py", "./main.py", "/main.py",
            "C:/main.py", "src//main.py", "src\\..\\main.py", "   "
        };
        for (String path : unsafe) {
            assertThrows(IOException.class,
                () -> repository.writeText(path, "bad", null, "test"));
        }
    }

    @Test
    public void successfulAtomicWriteLeavesNoTemporarySibling() throws Exception {
        repository.writeText("src/main.py", "print('ok')\n", null, "test");
        File parent = new File(repository.rootDirectory(), "src");
        File[] leftovers = parent.listFiles((directory, name) -> name.endsWith(".tmp"));
        assertFalse(leftovers == null);
        assertEquals(0, leftovers.length);
    }

    @Test
    public void batchWritesValidateEveryBaseBeforeChangingAnyFile() throws Exception {
        WorkspaceRepository.Entry first = repository.writeText(
            "a.py", "a = 1\n", 0L, "test");
        WorkspaceRepository.Entry second = repository.writeText(
            "b.py", "b = 1\n", 0L, "test");
        List<WorkspaceRepository.BatchWrite> writes = new ArrayList<>();
        writes.add(new WorkspaceRepository.BatchWrite(
            "a.py", "a = 2\n".getBytes(StandardCharsets.UTF_8),
            first.revision, first.sha256));
        writes.add(new WorkspaceRepository.BatchWrite(
            "b.py", "b = 2\n".getBytes(StandardCharsets.UTF_8),
            second.revision - 1, second.sha256));
        assertThrows(WorkspaceRepository.RevisionConflictException.class,
            () -> repository.applyBatch("batch-conflict", writes, "dsh"));
        assertEquals("a = 1\n", repository.read("a.py").text());
        assertEquals("b = 1\n", repository.read("b.py").text());
    }

    @Test
    public void batchWritesCommitMultipleFilesWithOneTransactionId() throws Exception {
        WorkspaceRepository.Entry first = repository.writeText(
            "a.py", "a = 1\n", 0L, "test");
        WorkspaceRepository.Entry second = repository.writeText(
            "b.py", "b = 1\n", 0L, "test");
        WorkspaceRepository.BatchResult result = repository.applyBatch(
            "batch-ok",
            List.of(
                new WorkspaceRepository.BatchWrite(
                    "a.py", "a = 2\n".getBytes(StandardCharsets.UTF_8),
                    first.revision, first.sha256),
                new WorkspaceRepository.BatchWrite(
                    "b.py", "b = 2\n".getBytes(StandardCharsets.UTF_8),
                    second.revision, second.sha256)),
            "dsh");
        assertEquals("batch-ok", result.transactionId);
        assertEquals(2, result.files.size());
        assertEquals("a = 2\n", repository.read("a.py").text());
        assertEquals("b = 2\n", repository.read("b.py").text());
    }

    @Test
    public void atomicRenameAndUndoPreserveContentAndTombstoneRevisions() throws Exception {
        WorkspaceRepository.Entry original = repository.writeText("old.py", "print('hello')\n", 0L, "test");
        WorkspaceRepository.BatchResult renamed = repository.applyBatch("rename-test", List.of(
            new WorkspaceRepository.BatchWrite("new.py", original.content, 0, ""),
            new WorkspaceRepository.BatchWrite("old.py", null, original.revision, original.sha256, true)), "file-operation");
        assertEquals(1, renamed.files.size());
        assertEquals(1, renamed.deleted.size());
        assertEquals(original.revision + 1, renamed.deleted.get(0).revision);
        assertFalse(new File(repository.rootDirectory(), "old.py").exists());
        WorkspaceRepository.Entry moved = repository.read("new.py");
        assertEquals(original.text(), moved.text());
        repository.applyBatch("undo-rename", List.of(
            new WorkspaceRepository.BatchWrite("new.py", null, moved.revision, moved.sha256, true),
            new WorkspaceRepository.BatchWrite("old.py", original.content, renamed.deleted.get(0).revision, "")), "file-operation-undo");
        assertEquals(original.text(), repository.read("old.py").text());
        assertFalse(new File(repository.rootDirectory(), "new.py").exists());
        assertEquals(original.revision + 2, repository.read("old.py").revision);
    }

    @Test
    public void staleDeletionRejectsWholeRenameBeforeCreatingDestination() throws Exception {
        WorkspaceRepository.Entry original = repository.writeText("old.py", "original", 0L, "test");
        Files.write(new File(repository.rootDirectory(), "old.py").toPath(), "external".getBytes(StandardCharsets.UTF_8));
        assertThrows(WorkspaceRepository.RevisionConflictException.class, () -> repository.applyBatch("rename-stale", List.of(
            new WorkspaceRepository.BatchWrite("new.py", original.content, 0, ""),
            new WorkspaceRepository.BatchWrite("old.py", null, original.revision, original.sha256, true)), "file-operation"));
        assertFalse(new File(repository.rootDirectory(), "new.py").exists());
        assertEquals("external", repository.read("old.py").text());
    }

    @Test
    public void failureAfterDeletionRestoresBytesAndOriginalRevision() throws Exception {
        WorkspaceRepository.Entry original = repository.writeText("old.py", "original", 0L, "test");
        repository.writeText("blocked", "parent is a file", 0L, "test");
        assertThrows(IOException.class, () -> repository.applyBatch("delete-rollback", List.of(
            new WorkspaceRepository.BatchWrite("old.py", null, original.revision, original.sha256, true),
            new WorkspaceRepository.BatchWrite("blocked/new.py", original.content, 0, "")), "file-operation"));
        assertEquals(original.text(), repository.read("old.py").text());
        assertEquals(original.revision, repository.read("old.py").revision);
        assertTrue(repository.tombstones().isEmpty());
    }

    @Test
    public void uncommittedRenameCrashRestoresDeletedSourceWithoutReplayingEmptyContent() throws Exception {
        WorkspaceRepository.Entry original = repository.writeText("old.py", "must survive crash", 0L, "test");
        File state = new File(temporaryRoot, "workspace-state/test-workspace");
        File transaction = new File(state, "transactions/crash-rename");
        assertTrue(transaction.mkdirs());
        Files.move(new File(repository.rootDirectory(), "old.py").toPath(), new File(transaction, "backup-1").toPath());
        Files.write(new File(repository.rootDirectory(), "new.py").toPath(), original.content);
        try (DataOutputStream out = new DataOutputStream(new FileOutputStream(new File(state, "journal-crash-rename.bin")))) {
            out.writeInt(0x50594154); out.writeInt(2); out.writeBoolean(false); out.writeUTF("crash-rename"); out.writeInt(2);
            out.writeUTF("new.py"); out.writeLong(0); out.writeUTF(""); out.writeBoolean(false); out.writeBoolean(false);
            out.writeUTF("old.py"); out.writeLong(original.revision); out.writeUTF(original.sha256); out.writeBoolean(true); out.writeBoolean(true);
            out.writeLong(original.revision); out.writeUTF(original.sha256); out.writeLong(original.updatedAt); out.writeBoolean(true);
        }
        repository = new WorkspaceRepository(temporaryRoot, "test-workspace");
        assertEquals(original.text(), repository.read("old.py").text());
        assertEquals(original.revision, repository.read("old.py").revision);
        assertFalse(new File(repository.rootDirectory(), "new.py").exists());
        assertFalse(transaction.exists());
    }

    @Test
    public void replicaReloadsLatestRevisionAfterApplyAndUndoRestoreIdenticalBytes() throws Exception {
        WorkspaceRepository.Entry first = repository.writeText("main.py", "original\n", 0L, "editor");
        WorkspaceRepository replica = WorkspaceRepository.readOnly(temporaryRoot, "test-workspace");
        assertEquals(1, replica.read("main.py").revision);
        WorkspaceRepository.Entry changed = repository.applyBatch("replica-change", List.of(
            new WorkspaceRepository.BatchWrite("main.py", "changed\n".getBytes(StandardCharsets.UTF_8), first.revision, first.sha256)), "dsh").files.get(0);
        repository.applyBatch("replica-undo", List.of(
            new WorkspaceRepository.BatchWrite("main.py", first.content, changed.revision, changed.sha256)), "undo");

        WorkspaceRepository.Entry latest = replica.read("main.py");
        assertEquals(first.text(), latest.text());
        assertEquals(first.sha256, latest.sha256);
        assertEquals(3, latest.revision);
        assertEquals(3, replica.revision("main.py"));
        assertEquals(3, replica.list().get(0).revision);
        // A replica lookup must not persist its original revision 1 over the
        // owner's revision 3, even when the content hashes are equal again.
        assertEquals(3, new WorkspaceRepository(temporaryRoot, "test-workspace").read("main.py").revision);
    }

    @Test
    public void replicaObservesOwnerTombstonesAndRecreationWithoutReconciliation() throws Exception {
        WorkspaceRepository.Entry first = repository.writeText("main.py", "one\n", 0L, "editor");
        WorkspaceRepository replica = WorkspaceRepository.readOnly(temporaryRoot, "test-workspace");
        assertEquals(1, replica.read("main.py").revision);
        repository.delete("main.py", first.revision, "editor");
        assertEquals(2, replica.revision("main.py"));
        assertEquals(2, replica.tombstones().get(0).revision);
        assertTrue(replica.list().isEmpty());
        repository.writeText("main.py", first.text(), 2L, "editor");
        assertEquals(3, replica.read("main.py").revision);
        assertTrue(replica.tombstones().isEmpty());
    }

    @Test
    public void replicaNeverPersistsNewExternalBytesOrTombstones() throws Exception {
        repository.writeText("main.py", "one\n", 0L, "editor");
        WorkspaceRepository replica = WorkspaceRepository.readOnly(temporaryRoot, "test-workspace");
        File index = new File(temporaryRoot, "workspace-state/test-workspace/index.bin");
        byte[] before = Files.readAllBytes(index.toPath());
        File main = new File(repository.rootDirectory(), "main.py");
        Files.write(main.toPath(), "external\n".getBytes(StandardCharsets.UTF_8));
        assertThrows(IOException.class, () -> replica.read("main.py"));
        assertThrows(IOException.class, () -> replica.revision("main.py"));
        assertThrows(IOException.class, replica::list);
        assertArrayEquals(before, Files.readAllBytes(index.toPath()));
        repository.reconcileExternalChanges("watcher");
        assertEquals(2, replica.read("main.py").revision);
        before = Files.readAllBytes(index.toPath());
        Files.delete(main.toPath());
        assertThrows(IOException.class, replica::list);
        assertThrows(IOException.class, () -> replica.revision("main.py"));
        assertTrue(replica.tombstones().isEmpty());
        assertArrayEquals(before, Files.readAllBytes(index.toPath()));
        repository.reconcileExternalChanges("watcher");
        assertEquals(3, replica.tombstones().get(0).revision);
    }

    @Test
    public void replicaRejectsUnindexedExternalFileWithoutCreatingOwnerMetadata() throws Exception {
        repository.writeText("main.py", "one\n", 0L, "editor");
        WorkspaceRepository replica = WorkspaceRepository.readOnly(temporaryRoot, "test-workspace");
        File index = new File(temporaryRoot, "workspace-state/test-workspace/index.bin");
        byte[] before = Files.readAllBytes(index.toPath());
        Files.write(new File(repository.rootDirectory(), "external.py").toPath(), "external\n".getBytes(StandardCharsets.UTF_8));
        assertThrows(IOException.class, () -> replica.read("external.py"));
        assertThrows(IOException.class, replica::list);
        assertArrayEquals(before, Files.readAllBytes(index.toPath()));
        repository.reconcileExternalChanges("watcher");
        assertEquals(1, replica.read("external.py").revision);
    }

    @Test
    public void replicaDuringPendingJournalCannotRollbackOwnersLiveTransaction() throws Exception {
        WorkspaceRepository.Entry original = repository.writeText("main.py", "original", 0L, "editor");
        File state = new File(temporaryRoot, "workspace-state/test-workspace");
        File transaction = new File(state, "transactions/live-owner");
        assertTrue(transaction.mkdirs());
        File main = new File(repository.rootDirectory(), "main.py");
        File backup = new File(transaction, "backup-0");
        Files.move(main.toPath(), backup.toPath());
        Files.write(main.toPath(), "in-progress".getBytes(StandardCharsets.UTF_8));
        File journal = new File(state, "journal-live-owner.bin");
        try (DataOutputStream out = new DataOutputStream(new FileOutputStream(journal))) {
            out.writeInt(0x50594154); out.writeInt(2); out.writeBoolean(false); out.writeUTF("live-owner"); out.writeInt(1);
            out.writeUTF("main.py"); out.writeLong(original.revision); out.writeUTF(original.sha256); out.writeBoolean(true); out.writeBoolean(true);
            out.writeLong(original.revision); out.writeUTF(original.sha256); out.writeLong(original.updatedAt); out.writeBoolean(true);
        }
        byte[] before = Files.readAllBytes(new File(state, "index.bin").toPath());
        WorkspaceRepository replica = WorkspaceRepository.readOnly(temporaryRoot, "test-workspace");
        assertThrows(IOException.class, () -> replica.read("main.py"));
        assertThrows(IOException.class, replica::list);
        assertThrows(IOException.class, replica::tombstones);
        assertEquals("in-progress", new String(Files.readAllBytes(main.toPath()), StandardCharsets.UTF_8));
        assertEquals(original.text(), new String(Files.readAllBytes(backup.toPath()), StandardCharsets.UTF_8));
        assertTrue(journal.isFile());
        assertArrayEquals(before, Files.readAllBytes(new File(state, "index.bin").toPath()));
        // Recovery remains the responsibility of a writable owner restart.
        repository = new WorkspaceRepository(temporaryRoot, "test-workspace");
        assertEquals(original.text(), repository.read("main.py").text());
        assertEquals(original.revision, replica.read("main.py").revision);
    }

    @Test
    public void replicaCorruptOrMissingIndexFailsClosedWithoutQuarantine() throws Exception {
        repository.writeText("main.py", "one\n", 0L, "editor");
        WorkspaceRepository replica = WorkspaceRepository.readOnly(temporaryRoot, "test-workspace");
        File state = new File(temporaryRoot, "workspace-state/test-workspace");
        File index = new File(state, "index.bin");
        byte[] valid = Files.readAllBytes(index.toPath());
        Files.write(index.toPath(), new byte[] {1, 2, 3});
        assertThrows(IOException.class, () -> replica.read("main.py"));
        assertThrows(IOException.class, replica::list);
        assertThrows(IOException.class, replica::tombstones);
        assertArrayEquals(new byte[] {1, 2, 3}, Files.readAllBytes(index.toPath()));
        assertEquals(0, state.listFiles((directory, name) -> name.startsWith("index.corrupt-")).length);
        Files.delete(index.toPath());
        assertThrows(IOException.class, () -> replica.revision("main.py"));
        assertFalse(index.exists());
        Files.write(index.toPath(), valid);
        assertEquals(1, replica.read("main.py").revision);
    }

    @Test
    public void replicaConstructedBeforeOwnerDoesNotCreateAnyWorkspaceState() throws Exception {
        WorkspaceRepository replica = WorkspaceRepository.readOnly(temporaryRoot, "not-created-yet");
        assertFalse(replica.rootDirectory().exists());
        assertFalse(new File(temporaryRoot, "workspace-state/not-created-yet").exists());
        assertThrows(IOException.class, replica::list);
        assertThrows(IOException.class, replica::tombstones);
        WorkspaceRepository owner = new WorkspaceRepository(temporaryRoot, "not-created-yet");
        owner.writeText("main.py", "ready\n", 0L, "editor");
        assertEquals("ready\n", replica.read("main.py").text());
    }

    @Test
    public void replicaRejectsEveryMutationBeforeAnyFilesystemChange() throws Exception {
        WorkspaceRepository.Entry first = repository.writeText("main.py", "one\n", 0L, "editor");
        WorkspaceRepository replica = WorkspaceRepository.readOnly(temporaryRoot, "test-workspace");
        File index = new File(temporaryRoot, "workspace-state/test-workspace/index.bin");
        byte[] before = Files.readAllBytes(index.toPath());
        assertThrows(IOException.class, () -> replica.writeText("new/path.py", "bad", 0L, "dsh"));
        assertThrows(IOException.class, () -> replica.write("main.py", new byte[0], 1L, "dsh"));
        assertThrows(IOException.class, () -> replica.delete("main.py", 1L, "dsh"));
        assertThrows(IOException.class, () -> replica.applyBatch("bad-replica", List.of(
            new WorkspaceRepository.BatchWrite("main.py", new byte[0], 1, first.sha256)), "dsh"));
        assertThrows(IOException.class, () -> replica.reconcileExternalChanges("dsh"));
        assertFalse(new File(repository.rootDirectory(), "new").exists());
        assertEquals(first.text(), repository.read("main.py").text());
        assertArrayEquals(before, Files.readAllBytes(index.toPath()));
    }

    private static void deleteRecursively(File file) throws IOException {
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursively(child);
            }
        }
        Files.deleteIfExists(file.toPath());
    }
}
