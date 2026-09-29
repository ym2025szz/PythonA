package com.pythona.app;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Offline, restart-safe installation of the APK's digest-locked official dsh rootfs. */
final class DshRuntimeInstaller {
    interface ProgressListener { void onProgress(String stage, long completed, long total); }
    interface AssetSource { InputStream open(String name) throws IOException; }
    static final String MANIFEST_ASSET = "dsh-runtime-manifest.json";
    static final String READY_MARKER = ".pythona-dsh-runtime";
    private final Path runtime, rootfs, staging, previous, archive;
    private final AssetSource assets;
    private final JSONObject manifest;
    private final String marker;
    private final ProgressListener listener;
    private volatile boolean validated;
    private String lastStage = "";
    private long lastProgress;
    private long lastCompleted = -1;

    DshRuntimeInstaller(Context context, ProgressListener listener) throws IOException {
        this(new File(context.getFilesDir(), "dsh-runtime"), context.getAssets()::open,
            readManifest(context.getAssets().open(MANIFEST_ASSET)), listener);
    }

    DshRuntimeInstaller(File directory, AssetSource assets, byte[] manifestBytes,
                        ProgressListener listener) throws IOException {
        if (Files.isSymbolicLink(directory.toPath())) throw new IOException("Runtime directory cannot be a link");
        // Android commonly exposes /data/user/0 through an OS-owned alias; canonicalize that
        // parent once, then use one stable containment root for all installation operations.
        runtime = directory.getCanonicalFile().toPath();
        rootfs = runtime.resolve("rootfs"); staging = runtime.resolve("rootfs-stage");
        previous = runtime.resolve("rootfs-previous"); archive = runtime.resolve("rootfs-verified.bin");
        this.assets = assets;
        this.listener = listener == null ? (stage, completed, total) -> {} : listener;
        try {
            manifest = new JSONObject(new String(manifestBytes, StandardCharsets.UTF_8));
            if (manifest.getInt("format") != 1 || !manifest.getString("sha256").matches("[0-9a-f]{64}")
                    || manifest.getLong("size") <= 0 || manifest.getLong("size") > 512L * 1024 * 1024
                    || !manifest.getString("asset").matches("[A-Za-z0-9._-]+")
                    || manifest.getJSONArray("criticalFiles").length() == 0)
                throw new IOException("Invalid bundled dsh manifest");
            marker = manifest.getString("version") + "\n" + hex(sha256().digest(manifestBytes)) + "\n";
        } catch (org.json.JSONException malformed) { throw new IOException("Invalid bundled dsh manifest", malformed); }
    }

    /** Cheap UI probe; ensureInstalled performs real critical-file verification before execution. */
    boolean isReady() {
        try { return validMarker(rootfs); }
        catch (IOException error) { return false; }
    }

    void invalidateValidation() { validated = false; }

    synchronized File ensureInstalled() throws IOException {
        if (validated && validMarker(rootfs)) return rootfs.toFile();
        if (Files.isSymbolicLink(runtime)) throw new IOException("Runtime directory cannot be a link");
        Files.createDirectories(runtime);
        if (!runtime.toRealPath().equals(runtime)) throw new IOException("Runtime path contains a link");
        Path lockPath = runtime.resolve("install.lock");
        if (Files.isSymbolicLink(lockPath)) throw new IOException("Runtime lock cannot be a link");
        try (FileChannel channel = FileChannel.open(lockPath, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
             FileLock ignored = channel.lock()) {
            recoverInterruptedActivation();
            try {
                if (validMarker(rootfs)) {
                    publish("validating", 0, criticalBytes());
                    verifyTree(rootfs);
                    validated = true;
                    // A previous version is only disposable after the active version verifies.
                    deleteOwned(previous); deleteOwned(staging); deleteOwned(archive);
                    publish("ready", 1, 1);
                    return rootfs.toFile();
                }
            } catch (IOException damaged) {
                validated = false;
                publish("repairing", 0, 1);
            }
            try {
                boolean stageReady = false;
                if (validMarker(staging)) {
                    try { verifyTree(staging); stageReady = true; }
                    catch (IOException damagedStage) { deleteOwned(staging); }
                }
                if (!stageReady) {
                    deleteOwned(staging);
                    Files.createDirectory(staging);
                    prepareArchive();
                    publish("extracting", 0, manifest.optLong("unpackedBytes", 1));
                    try (InputStream input = Files.newInputStream(archive)) {
                        TarGzipExtractor.extractAuto(input, staging.toFile(), 0, false,
                            (bytes, entries) -> publish("extracting", bytes, manifest.optLong("unpackedBytes", 1)));
                    }
                    publish("validating", 0, criticalBytes());
                    verifyTree(staging);
                    preserveDshState();
                    writeMarker(staging);
                }
                activate();
                validated = true;
                deleteOwned(archive);
                publish("ready", 1, 1);
                return rootfs.toFile();
            } catch (IOException failure) {
                validated = false;
                // The active/previous roots are deliberately kept for recovery. Only uncommitted
                // staging is removed, without traversing links introduced by an interrupted run.
                try { if (!validMarker(staging)) deleteOwned(staging); }
                catch (IOException cleanup) { failure.addSuppressed(cleanup); }
                publish("failed", 0, 1);
                throw failure;
            }
        }
    }

    private void prepareArchive() throws IOException {
        long size = manifest.optLong("size");
        String digest = manifest.optString("sha256");
        publish("verifying", 0, size);
        if (Files.isRegularFile(archive, LinkOption.NOFOLLOW_LINKS) && Files.size(archive) == size
                && digest.equals(hashFile(archive, "verifying", 0, size))) return;
        deleteOwned(archive);
        Path partial = runtime.resolve("rootfs-download.part");
        deleteOwned(partial);
        MessageDigest hash = sha256(); long bytes = 0;
        try (InputStream input = assets.open(manifest.optString("asset"));
             FileOutputStream output = new FileOutputStream(partial.toFile())) {
            byte[] buffer = new byte[256 * 1024]; int count;
            while ((count = input.read(buffer)) >= 0) {
                checkInterrupted();
                bytes += count;
                if (bytes > size) throw new IOException("Bundled dsh archive size mismatch");
                hash.update(buffer, 0, count); output.write(buffer, 0, count);
                publish("verifying", bytes, size);
            }
            output.getFD().sync();
        } catch (IOException error) { deleteOwned(partial); throw error; }
        if (bytes != size || !digest.equals(hex(hash.digest()))) {
            deleteOwned(partial); throw new IOException("Bundled dsh archive SHA-256 mismatch");
        }
        move(partial, archive);
    }

    private void verifyTree(Path tree) throws IOException {
        if (!Files.isDirectory(tree, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Missing dsh rootfs");
        JSONArray files = manifest.optJSONArray("criticalFiles"); long completed = 0, total = criticalBytes();
        for (int i = 0; i < files.length(); i++) {
            JSONObject entry = files.optJSONObject(i);
            if (entry == null) throw new IOException("Invalid critical dsh entry");
            Path path = TarGzipExtractor.safePath(tree, entry.optString("path"));
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                    || !path.toRealPath().startsWith(tree.toRealPath())
                    || Files.size(path) != entry.optLong("size", -1)
                    || !entry.optString("sha256").equals(hashFile(path, "validating", completed, total)))
                throw new IOException("dsh runtime verification failed: " + entry.optString("path"));
            completed += entry.optLong("size");
        }
        JSONObject entrypoint = manifest.optJSONObject("entrypoint");
        if (entrypoint != null) {
            Path link = TarGzipExtractor.safePath(tree, entrypoint.optString("path"));
            if (!Files.isSymbolicLink(link)
                    || !Files.readSymbolicLink(link).toString().replace('\\', '/').equals(entrypoint.optString("target"))
                    || !Files.isRegularFile(link) || !link.toRealPath().startsWith(tree.toRealPath()))
                throw new IOException("dsh entrypoint is invalid");
        }
    }

    private long criticalBytes() {
        JSONArray files = manifest.optJSONArray("criticalFiles"); long total = 0;
        for (int i = 0; i < files.length(); i++) total += files.optJSONObject(i).optLong("size");
        return total;
    }

    private void preserveDshState() throws IOException {
        Path source = rootfs.resolve("root/.dsh"), destination = staging.resolve("root/.dsh");
        if (Files.isSymbolicLink(rootfs)) throw new IOException("Existing rootfs is a link; original retained");
        if (!Files.exists(source, LinkOption.NOFOLLOW_LINKS)) return;
        if (!Files.isDirectory(source, LinkOption.NOFOLLOW_LINKS)
                || !source.toRealPath().startsWith(rootfs.toRealPath()))
            throw new IOException("Existing dsh state directory is unsafe");
        // Session/config files must survive a runtime repair or upgrade. Do not follow symlinks:
        // bundled package links stay relative to the same location in the replacement rootfs.
        deleteOwned(destination);
        final long[] copied = {0};
        Files.walkFileTree(source, new SimpleFileVisitor<Path>() {
            @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) throws IOException {
                checkInterrupted();
                Files.createDirectories(destination.resolve(source.relativize(dir)));
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                checkInterrupted();
                Path target = destination.resolve(source.relativize(file));
                if (attrs.isSymbolicLink()) {
                    Path link = Files.readSymbolicLink(file);
                    Files.createSymbolicLink(target, remapStateSymlink(rootfs, staging, file, target, link));
                } else if (attrs.isRegularFile()) {
                    copied[0] += attrs.size();
                    if (copied[0] > 1024L * 1024 * 1024) throw new IOException("dsh state exceeds migration limit; original retained");
                    Files.copy(file, target, StandardCopyOption.COPY_ATTRIBUTES);
                } else throw new IOException("Unsupported dsh state file");
                return FileVisitResult.CONTINUE;
            }
        });
    }

    /** Re-home the CLI's symlinks without traversing their targets. proot can create either
     * virtual /usr/... targets or physical Android paths using /data/user/0 aliases. */
    static Path remapStateSymlink(Path sourceRoot, Path destinationRoot, Path sourceFile,
                                  Path destinationFile, Path link) throws IOException {
        sourceRoot = sourceRoot.toAbsolutePath().normalize();
        destinationRoot = destinationRoot.toAbsolutePath().normalize();
        String raw = link.toString().replace('\\', '/');
        if (raw.isEmpty() || raw.indexOf('\0') >= 0) throw new IOException("Invalid existing dsh state link");
        Path relative = null;
        if (link.isAbsolute()) {
            Path normalized = link.normalize();
            if (normalized.startsWith(sourceRoot)) relative = sourceRoot.relativize(normalized);
            else {
                // Match the root ancestor, not the final target: resolving the final target
                // could follow another proot-absolute symlink into the Android host namespace.
                Path canonicalRoot = sourceRoot.toFile().getCanonicalFile().toPath();
                for (Path ancestor = normalized.getParent(); ancestor != null; ancestor = ancestor.getParent()) {
                    if (ancestor.toFile().getCanonicalFile().toPath().equals(canonicalRoot)) {
                        relative = ancestor.relativize(normalized); break;
                    }
                }
            }
        }
        if (relative == null && raw.startsWith("/")) {
            // Only container roots are virtual. Android app/storage paths outside our rootfs
            // are rejected rather than copied, read, or redirected into an unrelated app.
            if (!raw.matches("^/(root|usr|bin|lib|lib64|sbin|etc|var|opt|tmp|run|home)(/.*)?$"))
                throw new IOException("Existing dsh state link escapes rootfs");
            relative = java.nio.file.Paths.get(raw.substring(1)).normalize();
            if (relative.isAbsolute() || relative.startsWith(".."))
                throw new IOException("Existing dsh state link escapes rootfs");
        } else if (relative == null && !link.isAbsolute()) {
            Path resolved = sourceFile.getParent().resolve(link).normalize();
            if (!resolved.startsWith(sourceRoot)) throw new IOException("Existing dsh state link escapes rootfs");
            relative = sourceRoot.relativize(resolved);
        }
        if (relative == null) throw new IOException("Existing dsh state link escapes rootfs");
        Path relocated = destinationRoot.resolve(relative).normalize();
        if (!relocated.startsWith(destinationRoot) || !destinationFile.normalize().startsWith(destinationRoot))
            throw new IOException("Existing dsh state link escapes rootfs");
        return destinationFile.getParent().relativize(relocated);
    }

    private void activate() throws IOException {
        if (Files.exists(previous, LinkOption.NOFOLLOW_LINKS)) deleteOwned(previous);
        boolean movedOld = Files.exists(rootfs, LinkOption.NOFOLLOW_LINKS);
        if (movedOld) move(rootfs, previous);
        try { move(staging, rootfs); }
        catch (IOException activationFailure) {
            if (movedOld && !Files.exists(rootfs, LinkOption.NOFOLLOW_LINKS)) move(previous, rootfs);
            throw activationFailure;
        }
        // Keep the prior tree until the next successful process startup verification. A process
        // kill between either rename is recovered from rootfs-previous on the next invocation.
    }

    private void recoverInterruptedActivation() throws IOException {
        if (!Files.exists(rootfs, LinkOption.NOFOLLOW_LINKS) && Files.exists(previous, LinkOption.NOFOLLOW_LINKS))
            move(previous, rootfs);
    }

    private boolean validMarker(Path tree) throws IOException {
        Path file = tree.resolve(READY_MARKER);
        return Files.isDirectory(tree, LinkOption.NOFOLLOW_LINKS)
            && Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && Files.size(file) < 1024
            && marker.equals(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
    }

    private void writeMarker(Path tree) throws IOException {
        Path file = tree.resolve(READY_MARKER);
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Unexpected runtime marker in archive");
        try (FileOutputStream output = new FileOutputStream(file.toFile())) {
            output.write(marker.getBytes(StandardCharsets.UTF_8)); output.getFD().sync();
        }
    }

    private String hashFile(Path path, String stage, long offset, long total) throws IOException {
        MessageDigest hash = sha256(); byte[] buffer = new byte[256 * 1024]; long count = offset;
        try (InputStream input = Files.newInputStream(path)) {
            int read;
            while ((read = input.read(buffer)) >= 0) {
                checkInterrupted(); hash.update(buffer, 0, read); count += read; publish(stage, count, total);
            }
        }
        return hex(hash.digest());
    }

    private void deleteOwned(Path path) throws IOException {
        Path normalized = path.toAbsolutePath().normalize();
        if (!normalized.startsWith(runtime) || normalized.equals(runtime)) throw new IOException("Cleanup target leaves runtime");
        Path parent = normalized.getParent();
        if (Files.exists(parent) && !parent.toRealPath().startsWith(runtime.toRealPath()))
            throw new IOException("Cleanup parent leaves runtime");
        deleteTreeNoFollow(normalized);
    }

    static void deleteTreeNoFollow(Path target) throws IOException {
        if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) return;
        Files.walkFileTree(target, new SimpleFileVisitor<Path>() {
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file); return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult postVisitDirectory(Path dir, IOException error) throws IOException {
                if (error != null) throw error;
                Files.delete(dir); return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void move(Path source, Path target) throws IOException {
        try { Files.move(source, target, StandardCopyOption.ATOMIC_MOVE); }
        catch (AtomicMoveNotSupportedException unavailable) { Files.move(source, target); }
    }
    private void publish(String stage, long completed, long total) {
        long now = System.nanoTime();
        if (!stage.equals(lastStage) || (completed >= total && completed != lastCompleted)
                || now - lastProgress >= 100_000_000L) {
            lastStage = stage; lastProgress = now; lastCompleted = completed;
            listener.onProgress(stage, completed, total);
        }
    }
    private static byte[] readManifest(InputStream input) throws IOException {
        try (InputStream source = input; java.io.ByteArrayOutputStream result = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int read;
            while ((read = source.read(buffer)) >= 0) {
                if (result.size() + read > 64 * 1024) throw new IOException("dsh manifest too large");
                result.write(buffer, 0, read);
            }
            return result.toByteArray();
        }
    }
    private static MessageDigest sha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }
    private static void checkInterrupted() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("dsh installation interrupted; retry to continue");
    }
}
