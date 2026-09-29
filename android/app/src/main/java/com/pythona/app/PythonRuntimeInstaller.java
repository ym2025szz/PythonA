package com.pythona.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Process;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.List;

/**
 * Installs the read-only Python asset tree into app-private storage.
 *
 * <p>CPython cannot import its complete standard library directly from an APK:
 * native extension modules need real paths for {@code dlopen}.  The build puts
 * the official Android prefix under {@code assets/python}; this class performs
 * a versioned, cross-process-safe extraction.  A marker is written only after
 * the complete tree has been validated, so a killed install is never mistaken
 * for a usable runtime.</p>
 */
public final class PythonRuntimeInstaller {
    public static final String PYTHON_VERSION = "3.14.7";
    public static final String PYTHON_ABI_TAG = "cp314";
    public static final String PYTHON_ABI = "cp314-android_arm64_v8a";
    public static final String ASSET_ROOT = "python";

    private static final String INSTALL_FORMAT = "pythona-cpython-prefix-v3";
    private static final String UNDERSCORE_DIRECTORY_PREFIX = "x-pythona-u-";
    private static final String ESCAPED_DIRECTORY_PREFIX = "x-pythona-e-";
    private static final String MARKER_NAME = ".pythona-runtime";
    static final String MANIFEST_NAME = "pythona-runtime-manifest.sha256";
    private static final long MAX_FILE_BYTES = 256L * 1024L * 1024L;
    private static final long MAX_TREE_BYTES = 768L * 1024L * 1024L;
    private static final int MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
    private static final int MAX_MANIFEST_ENTRIES = 100_000;

    /** Paths required by {@link PythonEngine.Configuration}. */
    public static final class Layout {
        public final File home;
        public final File standardLibrary;
        public final File sitePackages;
        public final File languageSitePackages;
        public final File temporaryDirectory;

        private Layout(
            File home,
            File standardLibrary,
            File sitePackages,
            File languageSitePackages,
            File temporaryDirectory
        ) {
            this.home = home;
            this.standardLibrary = standardLibrary;
            this.sitePackages = sitePackages;
            this.languageSitePackages = languageSitePackages;
            this.temporaryDirectory = temporaryDirectory;
        }

        /** Default import paths beyond those discovered from {@code PyConfig.home}. */
        public List<File> extraImportPaths() {
            if (!sitePackages.isDirectory()) return Collections.emptyList();
            return Collections.singletonList(sitePackages);
        }

        /** Only Jedi/Parso and the language host are visible to :language. */
        public List<File> languageImportPaths() {
            File path = languageSitePackages.isDirectory() ? languageSitePackages : sitePackages;
            return path.isDirectory() ? Collections.singletonList(path) : Collections.emptyList();
        }
    }

    private final Context context;

    public PythonRuntimeInstaller(Context context) {
        if (context == null) throw new IllegalArgumentException("context is required");
        this.context = context.getApplicationContext();
    }

    /** Return the installed layout, extracting it once when necessary. */
    public Layout ensureInstalled() throws IOException {
        byte[] authoritativeManifest = readAuthoritativeManifest();
        File runtimeRoot = new File(context.getFilesDir(), "python-runtime");
        ensureDirectory(runtimeRoot);
        File target = new File(runtimeRoot, "cpython-" + PYTHON_VERSION);
        File lockFile = new File(runtimeRoot, ".install.lock");

        try (FileOutputStream lockStream = new FileOutputStream(lockFile, true);
             FileChannel channel = lockStream.getChannel();
             FileLock ignored = channel.lock()) {
            if (!isComplete(target, authoritativeManifest)) {
                installLocked(runtimeRoot, target, authoritativeManifest);
            }
        }
        if (!isComplete(target, authoritativeManifest)) {
            throw new IOException("CPython runtime validation failed after installation");
        }

        File stdlib = new File(target, "lib/python3.14");
        File sitePackages = new File(stdlib, "site-packages");
        File languageSitePackages = new File(stdlib, "language-site-packages");
        File temporaryDirectory = new File(context.getCacheDir(), "python-" + PYTHON_VERSION);
        ensureDirectory(temporaryDirectory);
        return new Layout(target, stdlib, sitePackages, languageSitePackages, temporaryDirectory);
    }

    private byte[] readAuthoritativeManifest() throws IOException {
        try (InputStream input = context.getAssets().open(ASSET_ROOT + "/" + MANIFEST_NAME)) {
            return readBounded(input, MAX_MANIFEST_BYTES);
        }
    }

    private void installLocked(
        File runtimeRoot,
        File target,
        byte[] authoritativeManifest
    ) throws IOException {
        String nonce = Process.myPid() + "-" + Thread.currentThread().getId();
        File staging = new File(runtimeRoot, ".staging-" + nonce);
        File backup = new File(runtimeRoot, ".previous-" + nonce);
        deleteTree(staging);
        deleteTree(backup);
        ensureDirectory(staging);

        boolean committed = false;
        try {
            Counter counter = new Counter();
            extractAssetTree(context.getAssets(), ASSET_ROOT, staging, counter);
            validateRuntimeTree(staging);
            verifyManifestTree(staging, authoritativeManifest, false);
            writeMarker(staging);
            verifyManifestTree(staging, authoritativeManifest, true);
            makeReadOnlyTree(staging);

            if (Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                move(target, backup);
            }
            try {
                move(staging, target);
                committed = true;
            } catch (IOException commitFailure) {
                if (Files.exists(backup.toPath(), LinkOption.NOFOLLOW_LINKS)
                    && !Files.exists(target.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                    move(backup, target);
                }
                throw commitFailure;
            }
            deleteTree(backup);
        } finally {
            if (!committed) deleteTree(staging);
        }
    }

    private static void extractAssetTree(
        AssetManager assets,
        String assetPath,
        File output,
        Counter counter
    ) throws IOException {
        String[] children = assets.list(assetPath);
        if (children == null) {
            throw new IOException("Unable to list runtime asset: " + assetPath);
        }

        if (children.length == 0) {
            try (InputStream input = new BufferedInputStream(assets.open(assetPath))) {
                copyAssetFile(input, output, counter);
                return;
            } catch (FileNotFoundException notAFile) {
                // APKs omit empty directories. Treat an unopenable, empty listing
                // as a directory so extraction remains deterministic.
                ensureDirectory(output);
                return;
            }
        }

        ensureDirectory(output);
        for (String child : children) {
            validateAssetName(child);
            String outputName = decodedAssetName(child);
            File destination = safeChild(output, outputName);
            extractAssetTree(assets, assetPath + "/" + child, destination, counter);
        }
    }

    private static void copyAssetFile(InputStream input, File output, Counter counter)
        throws IOException {
        File parent = output.getParentFile();
        if (parent == null) throw new IOException("Runtime asset has no parent: " + output);
        ensureDirectory(parent);
        long fileBytes = 0;
        byte[] buffer = new byte[64 * 1024];
        try (FileOutputStream raw = new FileOutputStream(output);
             BufferedOutputStream sink = new BufferedOutputStream(raw)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                fileBytes += read;
                counter.bytes += read;
                if (fileBytes > MAX_FILE_BYTES || counter.bytes > MAX_TREE_BYTES) {
                    throw new IOException("Bundled Python runtime exceeds extraction limit");
                }
                sink.write(buffer, 0, read);
            }
            sink.flush();
        }
    }

    private static void validateRuntimeTree(File home) throws IOException {
        requireRegularFile(home, "lib/python3.14/os.py");
        requireRegularFile(home, "lib/python3.14/encodings/__init__.py");
        requireRegularFile(home, "lib/python3.14/zipfile/_path/__init__.py");
        requireRegularFile(home, "lib/python3.14/site-packages/pythona_runtime_host.py");
        requireRegularFile(home, "lib/python3.14/site-packages/pythona_test_host.py");
        requireRegularFile(home, "lib/python3.14/site-packages/pythona_jedi_host.py");
        requireRegularFile(home, "lib/python3.14/site-packages/jedi/__init__.py");
        requireRegularFile(home, "lib/python3.14/site-packages/parso/__init__.py");
        requireRegularFile(home, "lib/python3.14/language-site-packages/pythona_jedi_host.py");
        requireRegularFile(home, "lib/python3.14/language-site-packages/jedi/__init__.py");
        requireRegularFile(home, "lib/python3.14/language-site-packages/parso/__init__.py");
        requireDirectory(home, "lib/python3.14/lib-dynload");
    }

    private static void requireRegularFile(File root, String relative) throws IOException {
        File file = safeRelative(root, relative);
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Missing Python runtime file: " + relative);
        }
    }

    private static void requireDirectory(File root, String relative) throws IOException {
        File file = safeRelative(root, relative);
        if (!Files.isDirectory(file.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Missing Python runtime directory: " + relative);
        }
    }

    private static void writeMarker(File staging) throws IOException {
        File marker = new File(staging, MARKER_NAME);
        String value = INSTALL_FORMAT + "\n" + PYTHON_VERSION + "\n" + PYTHON_ABI + "\n";
        try (FileOutputStream output = new FileOutputStream(marker)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
    }

    private static boolean isComplete(File target, byte[] authoritativeManifest) {
        if (!Files.isDirectory(target.toPath(), LinkOption.NOFOLLOW_LINKS)) return false;
        File marker = new File(target, MARKER_NAME);
        if (!Files.isRegularFile(marker.toPath(), LinkOption.NOFOLLOW_LINKS)) return false;
        try {
            String expected = INSTALL_FORMAT + "\n" + PYTHON_VERSION + "\n" + PYTHON_ABI + "\n";
            String actual = new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8);
            if (!expected.equals(actual)) return false;
            validateRuntimeTree(target);
            verifyManifestTree(target, authoritativeManifest, true);
            return true;
        } catch (IOException invalid) {
            return false;
        }
    }

    /**
     * Verify the extracted tree against the manifest shipped in the APK.
     *
     * <p>This method deliberately accepts the authoritative bytes separately
     * from the installed manifest.  Otherwise a damaged runtime could replace
     * both a payload and its local manifest and appear valid.</p>
     */
    static void verifyManifestTree(
        File root,
        byte[] authoritativeManifest,
        boolean requireMarker
    ) throws IOException {
        if (!Files.isDirectory(root.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Python runtime root is not a directory");
        }
        ManifestData manifest = parseManifest(authoritativeManifest);
        File installedManifest = safeRelative(root, MANIFEST_NAME);
        if (!Files.isRegularFile(installedManifest.toPath(), LinkOption.NOFOLLOW_LINKS)
            || installedManifest.length() != authoritativeManifest.length
            || !Arrays.equals(sha256(authoritativeManifest), sha256(installedManifest))) {
            throw new IOException("Installed Python runtime manifest does not match APK");
        }

        for (ManifestEntry entry : manifest.entries.values()) {
            File payload = safeRelative(root, entry.decodedPath);
            if (!Files.isRegularFile(payload.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("Missing Python runtime payload: " + entry.decodedPath);
            }
            if (payload.length() != entry.size) {
                throw new IOException("Python runtime payload size mismatch: " + entry.decodedPath);
            }
            if (!entry.sha256.equals(toHex(sha256(payload)))) {
                throw new IOException("Python runtime payload hash mismatch: " + entry.decodedPath);
            }
        }

        File marker = safeRelative(root, MARKER_NAME);
        if (requireMarker) {
            if (!Files.isRegularFile(marker.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("Python runtime completion marker is missing");
            }
        } else if (Files.exists(marker.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Python runtime marker appeared before validation");
        }

        scanForUnexpectedFiles(root, root, manifest.entries.keySet(), requireMarker);
    }

    private static ManifestData parseManifest(byte[] bytes) throws IOException {
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_MANIFEST_BYTES) {
            throw new IOException("Invalid Python runtime manifest size");
        }
        String text = new String(bytes, StandardCharsets.UTF_8);
        String[] lines = text.split("\\n", -1);
        Map<String, ManifestEntry> entries = new HashMap<>();
        long totalBytes = 0;
        int count = 0;
        for (String rawLine : lines) {
            String line = rawLine.endsWith("\r")
                ? rawLine.substring(0, rawLine.length() - 1)
                : rawLine;
            if (line.isEmpty()) continue;
            if (++count > MAX_MANIFEST_ENTRIES) {
                throw new IOException("Python runtime manifest has too many entries");
            }
            String[] fields = line.split("\\t", -1);
            if (fields.length != 3 || !fields[0].matches("[0-9a-f]{64}")) {
                throw new IOException("Malformed Python runtime manifest entry");
            }
            long size;
            try {
                size = Long.parseLong(fields[1]);
            } catch (NumberFormatException invalidSize) {
                throw new IOException("Malformed Python runtime manifest size", invalidSize);
            }
            if (size < 0 || size > MAX_FILE_BYTES) {
                throw new IOException("Python runtime manifest file exceeds limit");
            }
            totalBytes += size;
            if (totalBytes < 0 || totalBytes > MAX_TREE_BYTES) {
                throw new IOException("Python runtime manifest tree exceeds limit");
            }
            String decodedPath = decodeManifestPath(fields[2]);
            if (MARKER_NAME.equals(decodedPath) || MANIFEST_NAME.equals(decodedPath)) {
                throw new IOException("Python runtime manifest contains a reserved path");
            }
            ManifestEntry previous = entries.put(
                decodedPath,
                new ManifestEntry(decodedPath, size, fields[0]));
            if (previous != null) {
                throw new IOException("Duplicate Python runtime manifest path: " + decodedPath);
            }
        }
        if (entries.isEmpty()) throw new IOException("Python runtime manifest is empty");
        return new ManifestData(entries);
    }

    private static String decodeManifestPath(String assetPath) throws IOException {
        if (assetPath == null || assetPath.isEmpty() || assetPath.startsWith("/")
            || assetPath.endsWith("/") || assetPath.indexOf('\\') >= 0
            || assetPath.indexOf('\0') >= 0) {
            throw new IOException("Unsafe path in Python runtime manifest");
        }
        String[] encodedSegments = assetPath.split("/", -1);
        StringBuilder decoded = new StringBuilder();
        for (String encoded : encodedSegments) {
            validateAssetName(encoded);
            String segment = decodedAssetName(encoded);
            validateAssetName(segment);
            if (decoded.length() > 0) decoded.append('/');
            decoded.append(segment);
        }
        return decoded.toString();
    }

    private static void scanForUnexpectedFiles(
        File root,
        File current,
        Set<String> expectedPayloads,
        boolean markerAllowed
    ) throws IOException {
        if (Files.isSymbolicLink(current.toPath())) {
            throw new IOException("Symbolic link in Python runtime: " + current);
        }
        if (Files.isDirectory(current.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            File[] children = current.listFiles();
            if (children == null) throw new IOException("Unable to list Python runtime: " + current);
            for (File child : children) {
                scanForUnexpectedFiles(root, child, expectedPayloads, markerAllowed);
            }
            return;
        }
        if (!Files.isRegularFile(current.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("Unsupported entry in Python runtime: " + current);
        }
        String relative = root.toPath().relativize(current.toPath()).toString()
            .replace(File.separatorChar, '/');
        if (MANIFEST_NAME.equals(relative)) return;
        if (markerAllowed && MARKER_NAME.equals(relative)) return;
        if (!expectedPayloads.contains(relative)) {
            throw new IOException("Undeclared file in Python runtime: " + relative);
        }
    }

    private static byte[] readBounded(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) {
            if (output.size() > limit - read) {
                throw new IOException("Python runtime manifest exceeds size limit");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static byte[] sha256(byte[] bytes) throws IOException {
        MessageDigest digest = newSha256();
        digest.update(bytes);
        return digest.digest();
    }

    private static byte[] sha256(File file) throws IOException {
        MessageDigest digest = newSha256();
        byte[] buffer = new byte[64 * 1024];
        try (InputStream input = new BufferedInputStream(Files.newInputStream(file.toPath()))) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (read > 0) digest.update(buffer, 0, read);
            }
        }
        return digest.digest();
    }

    private static MessageDigest newSha256() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IOException("SHA-256 is unavailable", impossible);
        }
    }

    private static String toHex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] result = new char[bytes.length * 2];
        for (int index = 0; index < bytes.length; index++) {
            int value = bytes[index] & 0xff;
            result[index * 2] = digits[value >>> 4];
            result[index * 2 + 1] = digits[value & 0x0f];
        }
        return new String(result);
    }

    private static void makeReadOnlyTree(File file) throws IOException {
        if (Files.isSymbolicLink(file.toPath())) {
            throw new IOException("Refusing to make runtime symlink read-only: " + file);
        }
        if (Files.isDirectory(file.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Unable to list: " + file);
            for (File child : children) makeReadOnlyTree(child);
            file.setReadable(true, false);
            file.setExecutable(true, false);
        }
        if (!file.setWritable(false, false)) {
            throw new IOException("Unable to make Python runtime read-only: " + file);
        }
    }

    /** Undo the reversible AAPT-safe directory and trailing-dash encodings. */
    static String decodedAssetName(String name) {
        String decoded = name;
        if (name.startsWith(ESCAPED_DIRECTORY_PREFIX)) {
            decoded = name.substring(ESCAPED_DIRECTORY_PREFIX.length());
        } else if (name.startsWith(UNDERSCORE_DIRECTORY_PREFIX)) {
            decoded = "_" + name.substring(UNDERSCORE_DIRECTORY_PREFIX.length());
        }
        if (decoded.endsWith(".gz-")) {
            return decoded.substring(0, decoded.length() - 1);
        }
        if (decoded.endsWith("--")) return decoded.substring(0, decoded.length() - 1);
        return decoded;
    }

    private static void validateAssetName(String name) throws IOException {
        if (name == null || name.isEmpty() || ".".equals(name) || "..".equals(name)
            || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0
            || name.indexOf('\0') >= 0) {
            throw new IOException("Unsafe Python asset name");
        }
    }

    private static File safeChild(File parent, String name) throws IOException {
        validateAssetName(name);
        File child = new File(parent, name);
        String rootPath = parent.getCanonicalPath() + File.separator;
        String childPath = child.getCanonicalPath();
        if (!childPath.startsWith(rootPath)) throw new IOException("Python asset escaped staging");
        return child;
    }

    private static File safeRelative(File root, String relative) throws IOException {
        File file = new File(root, relative);
        String rootPath = root.getCanonicalPath() + File.separator;
        if (!file.getCanonicalPath().startsWith(rootPath)) {
            throw new IOException("Python runtime path escaped installation");
        }
        return file;
    }

    private static void move(File source, File target) throws IOException {
        try {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException unsupported) {
            // Both paths are app-private siblings, so this remains on one
            // filesystem. The completion marker makes interruption detectable.
            Files.move(source.toPath(), target.toPath());
        }
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (Files.isDirectory(directory.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.exists(directory.toPath(), LinkOption.NOFOLLOW_LINKS) || !directory.mkdirs()) {
            throw new IOException("Unable to create directory: " + directory);
        }
    }

    private static void deleteTree(File file) throws IOException {
        if (file == null || !Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS)) return;
        if (Files.isSymbolicLink(file.toPath())) {
            Files.delete(file.toPath());
            return;
        }
        if (file.isDirectory()) {
            file.setWritable(true, false);
            file.setReadable(true, false);
            file.setExecutable(true, false);
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Unable to list: " + file);
            for (File child : children) deleteTree(child);
        } else {
            file.setWritable(true, false);
        }
        Files.deleteIfExists(file.toPath());
    }

    private static final class ManifestData {
        final Map<String, ManifestEntry> entries;

        ManifestData(Map<String, ManifestEntry> entries) {
            this.entries = entries;
        }
    }

    private static final class ManifestEntry {
        final String decodedPath;
        final long size;
        final String sha256;

        ManifestEntry(String decodedPath, long size, String sha256) {
            this.decodedPath = decodedPath;
            this.size = size;
            this.sha256 = sha256;
        }
    }

    private static final class Counter {
        long bytes;
    }
}
