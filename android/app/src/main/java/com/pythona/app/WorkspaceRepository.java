package com.pythona.app;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * App-private, revisioned workspace storage shared by the editor, DSH and
 * native Python providers.
 *
 * <p>The workspace tree contains only user-visible files. Revision metadata is
 * kept under a sibling app-private directory so it can never be executed or
 * accidentally exported as project content.</p>
 */
public final class WorkspaceRepository {
    private static final int INDEX_MAGIC = 0x50594157; // "PYAW"
    private static final int INDEX_VERSION = 1;
    /** Keep editor/bridge payloads bounded; binary artifacts stay in-place. */
    public static final long MAX_EDITABLE_TEXT_BYTES = 8L * 1024 * 1024;
    /** Bound a single DSH/editor transaction before staging it on disk. */
    private static final int MAX_BATCH_FILES = 128;
    private static final long MAX_BATCH_BYTES = 32L * 1024 * 1024;
    private static final int JOURNAL_VERSION = 2;
    private static final Pattern WORKSPACE_ID =
        Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,63}");

    public interface Listener {
        void onChange(Change change);
    }

    public static final class RevisionConflictException extends IOException {
        public final String path;
        public final long expectedRevision;
        public final long actualRevision;

        RevisionConflictException(String path, long expectedRevision, long actualRevision) {
            super("Revision conflict for " + path + ": expected "
                + expectedRevision + ", actual " + actualRevision);
            this.path = path;
            this.expectedRevision = expectedRevision;
            this.actualRevision = actualRevision;
        }
    }

    public static final class HashConflictException extends IOException {
        public final String path;
        public final String expectedSha256;
        public final String actualSha256;

        HashConflictException(String path, String expectedSha256, String actualSha256) {
            super("Hash conflict for " + path);
            this.path = path;
            this.expectedSha256 = expectedSha256;
            this.actualSha256 = actualSha256;
        }
    }

    public static final class BatchWrite {
        public final String path;
        public final byte[] content;
        public final long expectedRevision;
        public final String expectedSha256;
        public final boolean delete;

        public BatchWrite(
            String path,
            byte[] content,
            long expectedRevision,
            String expectedSha256
        ) {
            this(path, content, expectedRevision, expectedSha256, false);
        }

        public BatchWrite(String path, byte[] content, long expectedRevision, String expectedSha256, boolean delete) {
            this.path = path;
            this.content = content == null ? new byte[0] : content.clone();
            this.expectedRevision = expectedRevision;
            this.expectedSha256 = expectedSha256 == null ? "" : expectedSha256;
            this.delete = delete;
        }
    }

    public static final class BatchResult {
        public final String transactionId;
        public final List<Entry> files;
        public final List<Summary> deleted;

        BatchResult(String transactionId, List<Entry> files, List<Summary> deleted) {
            this.transactionId = transactionId;
            this.files = Collections.unmodifiableList(new ArrayList<>(files));
            this.deleted = Collections.unmodifiableList(new ArrayList<>(deleted));
        }
    }

    public static final class Entry {
        public final String path;
        public final byte[] content;
        public final long revision;
        public final String sha256;
        public final long updatedAt;
        public final long size;
        public final boolean editable;

        Entry(
            String path,
            byte[] content,
            long revision,
            String sha256,
            long updatedAt,
            boolean editable
        ) {
            this.path = path;
            this.content = content;
            this.revision = revision;
            this.sha256 = sha256;
            this.updatedAt = updatedAt;
            this.size = content == null ? 0 : content.length;
            this.editable = editable;
        }

        public String text() {
            return new String(content, StandardCharsets.UTF_8);
        }
    }

    public static final class Summary {
        public final String path;
        public final long size;
        public final long revision;
        public final String sha256;
        public final long updatedAt;
        public final boolean editable;

        Summary(
            String path,
            long size,
            long revision,
            String sha256,
            long updatedAt,
            boolean editable
        ) {
            this.path = path;
            this.size = size;
            this.revision = revision;
            this.sha256 = sha256;
            this.updatedAt = updatedAt;
            this.editable = editable;
        }
    }

    public static final class Change {
        public final String type;
        public final String path;
        public final long revision;
        public final String sha256;
        public final String source;
        public final long size;
        public final boolean editable;

        Change(
            String type,
            String path,
            long revision,
            String sha256,
            String source,
            long size,
            boolean editable
        ) {
            this.type = type;
            this.path = path;
            this.revision = revision;
            this.sha256 = sha256;
            this.source = source;
            this.size = size;
            this.editable = editable;
        }
    }

    private static final class Record {
        long revision;
        String sha256;
        long updatedAt;
        boolean exists;

        Record(long revision, String sha256, long updatedAt, boolean exists) {
            this.revision = revision;
            this.sha256 = sha256;
            this.updatedAt = updatedAt;
            this.exists = exists;
        }
    }

    private final File workspaceRoot;
    private final File stateRoot;
    private final File indexFile;
    private final boolean readOnly;
    private final Map<String, Record> records = new HashMap<>();
    private final Set<Listener> listeners = new HashSet<>();

    public WorkspaceRepository(File appFilesDir, String workspaceId) throws IOException {
        this(appFilesDir, workspaceId, false);
    }

    /**
     * Service processes consume the editor's committed revision index. They
     * must never recover a transaction or write a stale cached index back.
     */
    public static WorkspaceRepository readOnly(File appFilesDir, String workspaceId) throws IOException {
        return new WorkspaceRepository(appFilesDir, workspaceId, true);
    }

    private WorkspaceRepository(File appFilesDir, String workspaceId, boolean readOnly) throws IOException {
        if (appFilesDir == null) throw new IllegalArgumentException("appFilesDir is required");
        if (workspaceId == null || !WORKSPACE_ID.matcher(workspaceId).matches()) {
            throw new IllegalArgumentException("Invalid workspace id");
        }
        // Keep the user-visible tree below an explicit root directory.  The
        // workspace container can then grow metadata/import state later
        // without ever exposing it to CPython, Jedi or the project explorer.
        workspaceRoot = new File(
            new File(new File(appFilesDir, "workspaces"), workspaceId), "root")
            .getCanonicalFile();
        stateRoot = new File(new File(appFilesDir, "workspace-state"), workspaceId)
            .getCanonicalFile();
        indexFile = new File(stateRoot, "index.bin");
        this.readOnly = readOnly;
        if (readOnly) {
            // No directory creation, corruption quarantine, or journal
            // recovery is permitted outside the workspace owner process.
            // Main may still be seeding the first index while services bind;
            // resolve rootDirectory now and load metadata lazily on each read.
            return;
        }
        ensureDirectory(workspaceRoot);
        ensureDirectory(stateRoot);
        loadIndex();
        // The journal contains the previous revision metadata.  Load the
        // index first so a crash after the index swap can be repaired before
        // any caller observes the repository.
        recoverTransactions();
    }

    public File rootDirectory() {
        return workspaceRoot;
    }

    /** Revision retained for a live file or deletion tombstone, or zero. */
    public synchronized long revision(String path) throws IOException {
        String snapshot = readOnly ? loadReplicaSnapshot() : null;
        String normalized = normalizeRelativePath(path);
        File target = resolve(normalized, true);
        Record record = readOnly ? replicaRecord(normalized, target,
            target.isFile() ? sha256(target) : null) : currentRecord(normalized, target);
        if (readOnly) verifyReplicaSnapshot(snapshot);
        return record == null ? 0 : record.revision;
    }

    /**
     * Deletion revisions are sent to the WebView so recreating a path remains
     * monotonic even after an Activity/WebView restart.
     */
    public synchronized List<Summary> tombstones() throws IOException {
        String snapshot = readOnly ? loadReplicaSnapshot() : null;
        List<Summary> result = new ArrayList<>();
        for (Map.Entry<String, Record> item : records.entrySet()) {
            Record record = item.getValue();
            if (!record.exists) {
                result.add(new Summary(
                    item.getKey(), 0, record.revision, "", record.updatedAt, false));
            }
        }
        result.sort((left, right) -> left.path.compareTo(right.path));
        if (readOnly) verifyReplicaSnapshot(snapshot);
        return result;
    }

    public synchronized void addListener(Listener listener) {
        if (listener != null) listeners.add(listener);
    }

    public synchronized void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    public synchronized Entry read(String path) throws IOException {
        String snapshot = readOnly ? loadReplicaSnapshot() : null;
        String normalized = normalizeRelativePath(path);
        File file = resolve(normalized, true);
        if (!file.isFile()) throw new IOException("File not found: " + normalized);
        if (!isEditableTextFile(normalized, file)) {
            throw new IOException("File is binary or exceeds the editor size limit: " + normalized);
        }
        byte[] content = Files.readAllBytes(file.toPath());
        Record record = readOnly ? replicaRecord(normalized, file, sha256(content))
            : reconcile(normalized, file, content);
        if (readOnly) verifyReplicaSnapshot(snapshot);
        return new Entry(
            normalized, content, record.revision, record.sha256, record.updatedAt, true);
    }

    public synchronized Entry writeText(
        String path,
        String content,
        Long expectedRevision,
        String source
    ) throws IOException {
        return write(path, String.valueOf(content).getBytes(StandardCharsets.UTF_8),
            expectedRevision, source);
    }

    public synchronized Entry write(
        String path,
        byte[] content,
        Long expectedRevision,
        String source
    ) throws IOException {
        requireWritable();
        String normalized = normalizeRelativePath(path);
        File target = resolve(normalized, false);
        if (target.exists() && !target.isFile()) {
            throw new IOException("Not a regular file: " + normalized);
        }
        File parent = target.getParentFile();
        ensureDirectory(parent);
        // Resolve again after creating parents: an existing symlink in the path
        // must never redirect a write outside the workspace.
        target = resolve(normalized, false);

        Record previous = currentRecord(normalized, target);
        long actualRevision = previous == null ? 0 : previous.revision;
        if (expectedRevision != null && expectedRevision != actualRevision) {
            throw new RevisionConflictException(normalized, expectedRevision, actualRevision);
        }

        byte[] nextContent = content == null ? new byte[0] : content;
        File temporary = new File(parent,
            "." + target.getName() + ".pythona-" + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(nextContent);
                output.flush();
                output.getFD().sync();
            }
            atomicReplace(temporary.toPath(), target.toPath());
        } finally {
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }

        long now = Math.max(System.currentTimeMillis(), target.lastModified());
        Record next = new Record(actualRevision + 1, sha256(nextContent), now, true);
        records.put(normalized, next);
        persistIndex();
        boolean editable = isEditableTextFile(normalized, target);
        emit(new Change(previous == null || !previous.exists ? "created" : "changed",
            normalized, next.revision, next.sha256, safeSource(source),
            nextContent.length, editable));
        return new Entry(normalized, nextContent.clone(), next.revision, next.sha256,
            next.updatedAt, editable);
    }

    /**
     * Validate every base revision/hash, stage all bytes, then replace the
     * complete set under a recoverable journal. A failed swap rolls every path
     * back before callers can observe a success response.
     */
    public synchronized BatchResult applyBatch(
        String requestedTransactionId,
        List<BatchWrite> requestedWrites,
        String source
    ) throws IOException {
        requireWritable();
        if (requestedWrites == null || requestedWrites.isEmpty()) {
            throw new IllegalArgumentException("A batch requires at least one file");
        }
        if (requestedWrites.size() > MAX_BATCH_FILES) {
            throw new IllegalArgumentException("A batch may contain at most " + MAX_BATCH_FILES + " files");
        }
        String transactionId = requestedTransactionId == null
            ? "batch-" + UUID.randomUUID()
            : requestedTransactionId.trim();
        if (!transactionId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")) {
            throw new IllegalArgumentException("Invalid transaction id");
        }

        ArrayList<BatchWrite> writes = new ArrayList<>();
        HashSet<String> paths = new HashSet<>();
        HashSet<String> canonicalTargets = new HashSet<>();
        ArrayList<Boolean> existed = new ArrayList<>();
        ArrayList<Record> previousRecords = new ArrayList<>();
        long batchBytes = 0L;
        for (BatchWrite requested : requestedWrites) {
            String path = normalizeRelativePath(requested.path);
            if (!paths.add(path)) throw new IllegalArgumentException("Duplicate batch path: " + path);
            File target = resolve(path, false);
            if (!canonicalTargets.add(target.getCanonicalPath())) throw new IOException("Batch paths alias the same file: " + path);
            if (target.exists() && !target.isFile()) {
                throw new IOException("Not a regular file: " + path);
            }
            Record previous = currentRecord(path, target);
            long revision = previous == null ? 0 : previous.revision;
            String digest = previous == null || !previous.exists ? "" : previous.sha256;
            if (revision != requested.expectedRevision) {
                throw new RevisionConflictException(path, requested.expectedRevision, revision);
            }
            if (!requested.expectedSha256.isEmpty()
                && !requested.expectedSha256.equalsIgnoreCase(digest)) {
                throw new HashConflictException(path, requested.expectedSha256, digest);
            }
            if (requested.delete && (previous == null || !previous.exists || requested.expectedSha256.isEmpty())) {
                throw new IOException("Deletion requires an existing file and its base hash: " + path);
            }
            writes.add(new BatchWrite(path, requested.content, revision, requested.expectedSha256, requested.delete));
            batchBytes += requested.content == null ? 0 : requested.content.length;
            if (batchBytes > MAX_BATCH_BYTES) {
                throw new IllegalArgumentException("A batch exceeds the 32 MiB staging limit");
            }
            existed.add(target.isFile());
            previousRecords.add(previous);
        }

        File transactionsRoot = new File(stateRoot, "transactions");
        ensureDirectory(transactionsRoot);
        File transactionRoot = new File(transactionsRoot, transactionId).getCanonicalFile();
        if (!transactionRoot.getParentFile().equals(transactionsRoot.getCanonicalFile())) {
            throw new IOException("Unsafe transaction directory");
        }
        if (transactionRoot.exists()) throw new IOException("Transaction already exists: " + transactionId);
        ensureDirectory(transactionRoot);
        File journal = new File(stateRoot, "journal-" + transactionId + ".bin");
        boolean committed = false;
        try {
            for (int index = 0; index < writes.size(); index += 1) {
                if (writes.get(index).delete) continue;
                File staged = new File(transactionRoot, "stage-" + index);
                try (FileOutputStream output = new FileOutputStream(staged)) {
                    output.write(writes.get(index).content);
                    output.flush();
                    output.getFD().sync();
                }
            }
            // Staging may take time for a multi-file edit. Recheck every base
            // immediately before the first replacement, including direct
            // writes made by a running trusted script during staging.
            for (BatchWrite write : writes) {
                File target = resolve(write.path, false);
                Record current = currentRecord(write.path, target);
                long revision = current == null ? 0 : current.revision;
                String digest = current == null || !current.exists ? "" : current.sha256;
                if (revision != write.expectedRevision) throw new RevisionConflictException(write.path, write.expectedRevision, revision);
                if (!write.expectedSha256.isEmpty() && !write.expectedSha256.equalsIgnoreCase(digest))
                    throw new HashConflictException(write.path, write.expectedSha256, digest);
            }
            writeBatchJournal(journal, false, transactionId, writes, existed, previousRecords);
            for (int index = 0; index < writes.size(); index += 1) {
                BatchWrite write = writes.get(index);
                File target = resolve(write.path, false);
                ensureDirectory(target.getParentFile());
                target = resolve(write.path, false);
                if (existed.get(index)) {
                    atomicReplace(target.toPath(), new File(transactionRoot, "backup-" + index).toPath());
                }
                if (!write.delete) atomicReplace(new File(transactionRoot, "stage-" + index).toPath(), target.toPath());
            }

            ArrayList<Entry> result = new ArrayList<>();
            ArrayList<Summary> deleted = new ArrayList<>();
            ArrayList<Change> changes = new ArrayList<>();
            long now = System.currentTimeMillis();
            for (int index = 0; index < writes.size(); index += 1) {
                BatchWrite write = writes.get(index);
                File target = resolve(write.path, true);
                Record previous = previousRecords.get(index);
                if (write.delete) {
                    Record tombstone = new Record(write.expectedRevision + 1, "", now, false);
                    records.put(write.path, tombstone);
                    deleted.add(new Summary(write.path, 0, tombstone.revision, "", now, false));
                    changes.add(new Change("deleted", write.path, tombstone.revision, "", safeSource(source), 0, false));
                    continue;
                }
                Record next = new Record(
                    write.expectedRevision + 1,
                    sha256(write.content),
                    Math.max(now, target.lastModified()),
                    true);
                records.put(write.path, next);
                boolean editable = isEditableTextFile(write.path, target);
                result.add(new Entry(
                    write.path, write.content.clone(), next.revision, next.sha256,
                    next.updatedAt, editable));
                changes.add(new Change(
                    previous == null || !previous.exists ? "created" : "changed",
                    write.path, next.revision, next.sha256, safeSource(source),
                    write.content.length, editable));
            }
            persistIndex();
            writeBatchJournal(journal, true, transactionId, writes, existed, previousRecords);
            committed = true;
            for (Change change : changes) emit(change);
            return new BatchResult(transactionId, result, deleted);
        } finally {
            if (!committed && journal.isFile()) {
                IOException rollbackFailure = null;
                try {
                    rollbackBatch(transactionRoot, writes, existed);
                } catch (IOException error) {
                    rollbackFailure = error;
                }
                // A failure after the file swaps but before the committed
                // journal marker must restore the in-memory revision map too;
                // otherwise the next request could observe a revision that no
                // longer matches the bytes recovered on disk.
                for (int index = 0; index < writes.size(); index += 1) {
                    Record previous = previousRecords.get(index);
                    if (previous == null) records.remove(writes.get(index).path);
                    else records.put(writes.get(index).path, previous);
                }
                try {
                    persistIndex();
                } catch (IOException error) {
                    if (rollbackFailure == null) rollbackFailure = error;
                    else rollbackFailure.addSuppressed(error);
                }
                if (rollbackFailure != null) throw rollbackFailure;
            }
            if (journal.exists() && !journal.delete()) journal.deleteOnExit();
            deleteTree(transactionRoot);
        }
    }

    public synchronized boolean delete(
        String path,
        Long expectedRevision,
        String source
    ) throws IOException {
        requireWritable();
        String normalized = normalizeRelativePath(path);
        File target = resolve(normalized, true);
        Record previous = currentRecord(normalized, target);
        long actualRevision = previous == null ? 0 : previous.revision;
        if (expectedRevision != null && expectedRevision != actualRevision) {
            throw new RevisionConflictException(normalized, expectedRevision, actualRevision);
        }
        if (!target.exists()) return false;
        if (!target.isFile()) throw new IOException("Not a regular file: " + normalized);
        Files.delete(target.toPath());
        pruneEmptyParents(target.getParentFile());
        Record tombstone = new Record(actualRevision + 1, "", System.currentTimeMillis(), false);
        records.put(normalized, tombstone);
        persistIndex();
        emit(new Change(
            "deleted", normalized, tombstone.revision, "", safeSource(source), 0, false));
        return true;
    }

    public synchronized List<Summary> list() throws IOException {
        return scan(false, "scan");
    }

    /**
     * Reconcile direct filesystem writes made by the runtime, DSH or an import
     * adapter and emit revisioned events for every observed change.
     */
    public synchronized List<Summary> reconcileExternalChanges(String source)
        throws IOException {
        requireWritable();
        return scan(true, safeSource(source));
    }

    private List<Summary> scan(boolean emitChanges, String source) throws IOException {
        String snapshot = readOnly ? loadReplicaSnapshot() : null;
        final List<String> paths = new ArrayList<>();
        Files.walkFileTree(workspaceRoot.toPath(), new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
                if (attributes.isRegularFile()) {
                    String relative = workspaceRoot.toPath().relativize(file).toString()
                        .replace(File.separatorChar, '/');
                    if (!isTemporaryName(file.getFileName().toString())) paths.add(relative);
                }
                return FileVisitResult.CONTINUE;
            }
        });
        Collections.sort(paths);

        List<Summary> result = new ArrayList<>();
        List<Change> changes = new ArrayList<>();
        Set<String> present = new HashSet<>(paths);
        boolean changed = false;
        for (String path : paths) {
            File file = resolve(path, true);
            long size = file.length();
            String digest = sha256(file);
            boolean editable = isEditableTextFile(path, file);
            Record before = records.get(path);
            Record after = readOnly ? replicaRecord(path, file, digest)
                : reconcileInMemory(path, file, digest);
            if (before != after) {
                changed = true;
                if (emitChanges) {
                    changes.add(new Change(
                        before == null || !before.exists ? "created" : "changed",
                        path,
                        after.revision,
                        after.sha256,
                        source,
                        size,
                        editable));
                }
            }
            result.add(new Summary(
                path, size, after.revision, after.sha256, after.updatedAt, editable));
        }
        for (Map.Entry<String, Record> item : new ArrayList<>(records.entrySet())) {
            Record record = item.getValue();
            if (record.exists && !present.contains(item.getKey())) {
                if (readOnly) throw new IOException("Workspace owner has not reconciled deletion: " + item.getKey());
                Record tombstone = new Record(record.revision + 1, "",
                    System.currentTimeMillis(), false);
                records.put(item.getKey(), tombstone);
                changed = true;
                if (emitChanges) {
                    changes.add(new Change(
                        "deleted", item.getKey(), tombstone.revision, "", source, 0, false));
                }
            }
        }
        if (changed) persistIndex();
        if (readOnly) verifyReplicaSnapshot(snapshot);
        for (Change change : changes) emit(change);
        return result;
    }

    public static String normalizeRelativePath(String value) throws IOException {
        if (value == null) throw new IOException("A workspace path is required");
        String path = value.trim().replace('\\', '/');
        if (path.isEmpty() || path.startsWith("/") || path.indexOf('\0') >= 0) {
            throw new IOException("Unsafe workspace path");
        }
        // Reject drive-qualified paths even when tests run on a non-Windows host.
        if (path.length() >= 2 && Character.isLetter(path.charAt(0))
            && path.charAt(1) == ':') {
            throw new IOException("Unsafe workspace path");
        }
        String[] pieces = path.split("/", -1);
        StringBuilder normalized = new StringBuilder();
        for (String piece : pieces) {
            if (piece.isEmpty() || ".".equals(piece) || "..".equals(piece)) {
                throw new IOException("Unsafe workspace path");
            }
            if (normalized.length() > 0) normalized.append('/');
            normalized.append(piece);
        }
        return normalized.toString();
    }

    public static String sha256(byte[] content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(content == null ? new byte[0] : content);
            StringBuilder result = new StringBuilder(hash.length * 2);
            for (byte item : hash) result.append(String.format(Locale.ROOT, "%02x", item));
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    public static String sha256(File file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(file))) {
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    if (read > 0) digest.update(buffer, 0, read);
                }
            }
            byte[] hash = digest.digest();
            StringBuilder result = new StringBuilder(hash.length * 2);
            for (byte item : hash) result.append(String.format(Locale.ROOT, "%02x", item));
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private File resolve(String normalized, boolean mustExist) throws IOException {
        File file = new File(workspaceRoot, normalized).getCanonicalFile();
        String rootPath = workspaceRoot.getCanonicalPath();
        String filePath = file.getCanonicalPath();
        if (!filePath.startsWith(rootPath + File.separator)) {
            throw new IOException("Workspace path escapes its root");
        }
        if (mustExist && !file.exists()) return file;
        return file;
    }

    private Record currentRecord(String path, File file) throws IOException {
        if (file.isFile()) {
            return reconcile(path, file, sha256(file));
        }
        return records.get(path);
    }

    private void requireWritable() throws IOException {
        if (readOnly) throw new IOException("Read-only workspace replica cannot change workspace state");
    }

    /** Only committed owner metadata may supply a proposal's base revision. */
    private Record replicaRecord(String path, File file, String digest) throws IOException {
        Record record = records.get(path);
        if (digest != null) {
            if (record == null || !record.exists || !digest.equals(record.sha256)) {
                throw new IOException("Workspace owner has not reconciled file: " + path);
            }
        } else if (file.exists() || (record != null && record.exists)) {
            throw new IOException("Workspace owner has not reconciled file: " + path);
        }
        return record;
    }

    private void requireCommittedReplicaState() throws IOException {
        if (!workspaceRoot.isDirectory() || !stateRoot.isDirectory() || !indexFile.isFile()) {
            throw new IOException("Workspace owner metadata is unavailable; retry after workspace is ready");
        }
        File[] journals = stateRoot.listFiles((directory, name) ->
            name.startsWith("journal-") && name.endsWith(".bin"));
        if (journals == null || journals.length != 0) {
            throw new IOException("Workspace transaction is in progress; retry after it completes");
        }
    }

    private String loadReplicaSnapshot() throws IOException {
        requireCommittedReplicaState();
        // The index is app-private metadata; bound its allocation as well as
        // entry count, and reject partial replacement rather than repairing it.
        if (indexFile.length() > 64L * 1024 * 1024) throw new IOException("Workspace index is too large");
        byte[] bytes = Files.readAllBytes(indexFile.toPath());
        if (bytes.length > 64 * 1024 * 1024) throw new IOException("Workspace index is too large");
        Map<String, Record> loaded = new HashMap<>();
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (input.readInt() != INDEX_MAGIC || input.readInt() != INDEX_VERSION) {
                throw new IOException("Unsupported workspace index");
            }
            int count = input.readInt();
            if (count < 0 || count > 1_000_000) throw new IOException("Invalid workspace index");
            for (int index = 0; index < count; index++) {
                String path = normalizeRelativePath(input.readUTF());
                long revision = input.readLong();
                String digest = input.readUTF();
                long updatedAt = input.readLong();
                boolean exists = input.readBoolean();
                if (revision < 1 || loaded.containsKey(path)
                    || (exists ? !digest.matches("[a-fA-F0-9]{64}") : !digest.isEmpty())) {
                    throw new IOException("Invalid workspace revision metadata");
                }
                loaded.put(path, new Record(revision, digest, updatedAt, exists));
            }
            if (input.read() != -1) throw new IOException("Trailing workspace index bytes");
        }
        String snapshot = sha256(bytes);
        verifyReplicaSnapshot(snapshot);
        records.clear();
        records.putAll(loaded);
        return snapshot;
    }

    private void verifyReplicaSnapshot(String snapshot) throws IOException {
        requireCommittedReplicaState();
        if (!snapshot.equals(sha256(indexFile))) {
            throw new IOException("Workspace revision changed while reading; retry with current state");
        }
        // A transaction could begin between the first journal check and hash.
        requireCommittedReplicaState();
    }

    private Record reconcile(String path, File file, byte[] content) throws IOException {
        return reconcile(path, file, sha256(content));
    }

    private Record reconcile(String path, File file, String digest) throws IOException {
        Record before = records.get(path);
        Record after = reconcileInMemory(path, file, digest);
        if (before != after) persistIndex();
        return after;
    }

    private Record reconcileInMemory(String path, File file, String digest) {
        Record record = records.get(path);
        if (record == null) {
            record = new Record(1, digest, file.lastModified(), true);
            records.put(path, record);
            return record;
        }
        if (!record.exists || !digest.equals(record.sha256)) {
            Record updated = new Record(record.revision + 1, digest,
                Math.max(System.currentTimeMillis(), file.lastModified()), true);
            records.put(path, updated);
            return updated;
        }
        return record;
    }

    private void loadIndex() throws IOException {
        records.clear();
        if (!indexFile.isFile()) return;
        try (DataInputStream input = new DataInputStream(
            new BufferedInputStream(new FileInputStream(indexFile)))) {
            if (input.readInt() != INDEX_MAGIC || input.readInt() != INDEX_VERSION) {
                throw new IOException("Unsupported workspace index");
            }
            int count = input.readInt();
            if (count < 0 || count > 1_000_000) throw new IOException("Invalid workspace index");
            for (int index = 0; index < count; index += 1) {
                String path = normalizeRelativePath(input.readUTF());
                long revision = input.readLong();
                String digest = input.readUTF();
                long updatedAt = input.readLong();
                boolean exists = input.readBoolean();
                if (revision < 1) throw new IOException("Invalid workspace revision");
                records.put(path, new Record(revision, digest, updatedAt, exists));
            }
        } catch (EOFException corrupt) {
            File quarantine = new File(stateRoot, "index.corrupt-" + System.currentTimeMillis());
            Files.move(indexFile.toPath(), quarantine.toPath(), StandardCopyOption.REPLACE_EXISTING);
            records.clear();
        }
    }

    private void persistIndex() throws IOException {
        requireWritable();
        ensureDirectory(stateRoot);
        File temporary = new File(stateRoot, "index-" + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream fileOutput = new FileOutputStream(temporary);
                 DataOutputStream output = new DataOutputStream(
                     new BufferedOutputStream(fileOutput))) {
                output.writeInt(INDEX_MAGIC);
                output.writeInt(INDEX_VERSION);
                List<String> paths = new ArrayList<>(records.keySet());
                Collections.sort(paths);
                output.writeInt(paths.size());
                for (String path : paths) {
                    Record record = records.get(path);
                    output.writeUTF(path);
                    output.writeLong(record.revision);
                    output.writeUTF(record.sha256 == null ? "" : record.sha256);
                    output.writeLong(record.updatedAt);
                    output.writeBoolean(record.exists);
                }
                output.flush();
                fileOutput.getFD().sync();
            }
            atomicReplace(temporary.toPath(), indexFile.toPath());
        } finally {
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }
    }

    private static void atomicReplace(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException unsupported) {
            Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private void recoverTransactions() throws IOException {
        File[] journals = stateRoot.listFiles((directory, name) ->
            name.startsWith("journal-") && name.endsWith(".bin"));
        if (journals == null) return;
        for (File journal : journals) {
            String transactionId;
            boolean committed;
            ArrayList<BatchWrite> writes = new ArrayList<>();
            ArrayList<Boolean> existed = new ArrayList<>();
            ArrayList<Record> previousRecords = new ArrayList<>();
            try (DataInputStream input = new DataInputStream(
                new BufferedInputStream(new FileInputStream(journal)))) {
                int magic = input.readInt();
                int version = input.readInt();
                if (magic != 0x50594154 || (version != 1 && version != JOURNAL_VERSION)) {
                    throw new IOException("Unsupported batch journal");
                }
                committed = input.readBoolean();
                transactionId = input.readUTF();
                int count = input.readInt();
                if (count < 1 || count > 10_000) throw new IOException("Invalid batch journal count");
                for (int index = 0; index < count; index += 1) {
                    String path = normalizeRelativePath(input.readUTF());
                    long revision = input.readLong();
                    String digest = input.readUTF();
                    boolean didExist = input.readBoolean();
                    writes.add(new BatchWrite(path, new byte[0], revision, digest));
                    existed.add(didExist);
                    if (version >= JOURNAL_VERSION) {
                        boolean hasPrevious = input.readBoolean();
                        if (!hasPrevious) {
                            previousRecords.add(null);
                        } else {
                            long previousRevision = input.readLong();
                            String previousDigest = input.readUTF();
                            long previousUpdatedAt = input.readLong();
                            boolean previousExists = input.readBoolean();
                            if (previousRevision < 1) {
                                throw new IOException("Invalid previous workspace revision");
                            }
                            previousRecords.add(new Record(
                                previousRevision, previousDigest, previousUpdatedAt, previousExists));
                        }
                    } else {
                        // Version 1 did not retain tombstone timestamps.  It
                        // is still safe to recover its bytes; a missing prior
                        // record is represented as a new file with revision 0.
                        previousRecords.add(didExist
                            ? new Record(revision, digest, 0L, true) : null);
                    }
                }
            } catch (Exception corrupt) {
                File quarantined = new File(stateRoot,
                    journal.getName() + ".corrupt-" + System.currentTimeMillis());
                Files.move(journal.toPath(), quarantined.toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
                continue;
            }
            File transactionsRoot = new File(stateRoot, "transactions").getCanonicalFile();
            File transactionRoot = new File(transactionsRoot, transactionId).getCanonicalFile();
            if (!transactionRoot.getParentFile().equals(transactionsRoot)) {
                throw new IOException("Unsafe transaction recovery path");
            }
            if (!committed) {
                rollbackBatch(transactionRoot, writes, existed);
                for (int index = 0; index < writes.size(); index += 1) {
                    Record previous = previousRecords.get(index);
                    if (previous == null) records.remove(writes.get(index).path);
                    else records.put(writes.get(index).path, previous);
                }
                persistIndex();
            }
            if (!journal.delete()) journal.deleteOnExit();
            deleteTree(transactionRoot);
        }
    }

    private static void writeBatchJournal(
        File journal,
        boolean committed,
        String transactionId,
        List<BatchWrite> writes,
        List<Boolean> existed,
        List<Record> previousRecords
    ) throws IOException {
        File temporary = new File(journal.getParentFile(), journal.getName() + ".tmp");
        try {
            try (FileOutputStream fileOutput = new FileOutputStream(temporary);
                 DataOutputStream output = new DataOutputStream(
                     new BufferedOutputStream(fileOutput))) {
                output.writeInt(0x50594154); // "PYAT"
                output.writeInt(JOURNAL_VERSION);
                output.writeBoolean(committed);
                output.writeUTF(transactionId);
                output.writeInt(writes.size());
                for (int index = 0; index < writes.size(); index += 1) {
                    BatchWrite write = writes.get(index);
                    output.writeUTF(write.path);
                    output.writeLong(write.expectedRevision);
                    output.writeUTF(write.expectedSha256);
                    output.writeBoolean(existed.get(index));
                    Record previous = previousRecords.get(index);
                    output.writeBoolean(previous != null);
                    if (previous != null) {
                        output.writeLong(previous.revision);
                        output.writeUTF(previous.sha256 == null ? "" : previous.sha256);
                        output.writeLong(previous.updatedAt);
                        output.writeBoolean(previous.exists);
                    }
                }
                output.flush();
                fileOutput.getFD().sync();
            }
            atomicReplace(temporary.toPath(), journal.toPath());
        } finally {
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }
    }

    private void rollbackBatch(
        File transactionRoot,
        List<BatchWrite> writes,
        List<Boolean> existed
    ) throws IOException {
        IOException failure = null;
        for (int index = writes.size() - 1; index >= 0; index -= 1) {
            try {
                File target = resolve(writes.get(index).path, false);
                File backup = new File(transactionRoot, "backup-" + index);
                if (backup.isFile()) {
                    ensureDirectory(target.getParentFile());
                    atomicReplace(backup.toPath(), target.toPath());
                } else if (!existed.get(index) && target.exists()) {
                    Files.delete(target.toPath());
                    pruneEmptyParents(target.getParentFile());
                }
            } catch (IOException error) {
                if (failure == null) failure = error; else failure.addSuppressed(error);
            }
        }
        if (failure != null) throw failure;
    }

    private void deleteTree(File root) throws IOException {
        if (root == null || !root.exists()) return;
        File transactionsRoot = new File(stateRoot, "transactions").getCanonicalFile();
        File resolved = root.getCanonicalFile();
        if (!resolved.getParentFile().equals(transactionsRoot)) {
            throw new IOException("Refusing to delete an unsafe transaction directory");
        }
        Files.walkFileTree(resolved.toPath(), new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes)
                throws IOException {
                Files.deleteIfExists(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error)
                throws IOException {
                if (error != null) throw error;
                Files.deleteIfExists(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private void pruneEmptyParents(File directory) throws IOException {
        File root = workspaceRoot.getCanonicalFile();
        File current = directory == null ? null : directory.getCanonicalFile();
        while (current != null && !current.equals(root)
            && current.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) {
            String[] children = current.list();
            if (children == null || children.length != 0 || !current.delete()) break;
            current = current.getParentFile();
        }
    }

    private void emit(Change change) {
        for (Listener listener : new ArrayList<>(listeners)) listener.onChange(change);
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (directory.isDirectory()) return;
        if (!directory.mkdirs() && !directory.isDirectory()) {
            throw new IOException("Unable to create directory: " + directory);
        }
    }

    private static String safeSource(String source) {
        String value = source == null ? "unknown" : source.trim();
        return value.isEmpty() ? "unknown" : value;
    }

    private static boolean isTemporaryName(String name) {
        return name.startsWith(".") && name.contains(".pythona-") && name.endsWith(".tmp");
    }

    private static boolean isEditableTextFile(String path, File file) {
        if (file == null || !file.isFile() || file.length() > MAX_EDITABLE_TEXT_BYTES) {
            return false;
        }
        String lower = path.toLowerCase(Locale.ROOT);
        String name = lower.substring(lower.lastIndexOf('/') + 1);
        if (name.equals(".gitignore") || name.equals(".pyaignore") || name.equals(".gitattributes")
            || name.equals(".editorconfig") || name.equals("dockerfile")
            || name.equals("makefile") || name.equals("license")) {
            return true;
        }
        String[] extensions = {
            ".py", ".pyi", ".txt", ".md", ".rst", ".toml", ".json",
            ".yaml", ".yml", ".ini", ".cfg", ".conf", ".csv", ".tsv",
            ".xml", ".html", ".htm", ".css", ".js", ".mjs", ".cjs",
            ".java", ".kt", ".kts", ".c", ".h", ".cc", ".cpp", ".hpp",
            ".cmake", ".gradle", ".properties", ".sh", ".bat", ".ps1"
        };
        for (String extension : extensions) {
            if (lower.endsWith(extension)) return true;
        }
        return false;
    }
}
