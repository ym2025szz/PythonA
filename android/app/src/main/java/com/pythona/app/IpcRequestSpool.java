package com.pythona.app;

import android.os.Bundle;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * App-private overflow transport for JSON envelopes which are unsafe to place
 * in a Binder transaction. Requests, responses and events all use the same
 * authenticated, single-consumer file format. The receiver deletes the file
 * before dispatching the decoded JSON.
 */
final class IpcRequestSpool {
    // Binder's ~1 MiB buffer is shared by all in-flight transactions in the
    // process. Stay well below it even when runtime output and Jedi responses
    // cross at the same time.
    static final int INLINE_LIMIT_BYTES = 64 * 1024;
    static final int MAX_REQUEST_BYTES = 16 * 1024 * 1024;
    static final String KEY_FILE_NAME = "ipcSpoolName";
    static final String KEY_SIZE = "ipcSpoolSize";
    static final String KEY_SHA256 = "ipcSpoolSha256";
    static final String KEY_ID = "ipcSpoolId";
    static final String KEY_CHANNEL = "ipcSpoolChannel";

    private static final String DIRECTORY = "ipc-spool";
    private static final Pattern FILE_NAME = Pattern.compile(
        "payload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");

    static final class Descriptor {
        final File file;
        final long size;
        final String sha256;
        final String id;
        final String channel;

        Descriptor(File file, long size, String sha256, String id, String channel) {
            this.file = file;
            this.size = size;
            this.sha256 = sha256;
            this.id = id;
            this.channel = channel;
        }

        void writeTo(Bundle bundle) {
            bundle.putString(KEY_FILE_NAME, file.getName());
            bundle.putLong(KEY_SIZE, size);
            bundle.putString(KEY_SHA256, sha256);
            bundle.putString(KEY_ID, id);
            bundle.putString(KEY_CHANNEL, channel);
        }

        void delete() {
            try {
                Files.deleteIfExists(file.toPath());
            } catch (IOException ignored) {
            }
        }
    }

    static final class Payload {
        final String json;
        final String id;
        final String channel;

        Payload(String json, String id, String channel) {
            this.json = json;
            this.id = id;
            this.channel = channel;
        }
    }

    private IpcRequestSpool() {
    }

    static Descriptor writeIfNeeded(
        File cacheDirectory,
        String json,
        String id,
        String channel
    ) throws IOException {
        byte[] bytes = String.valueOf(json).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_REQUEST_BYTES) {
            throw new IOException("Native request exceeds the 16 MiB limit");
        }
        if (bytes.length <= INLINE_LIMIT_BYTES) return null;
        requireIdentity(id, "request id");
        requireIdentity(channel, "request channel");

        File root = spoolRoot(cacheDirectory);
        String name = "payload-" + UUID.randomUUID().toString().toLowerCase(Locale.ROOT)
            + ".json";
        File target = safeChild(root, name);
        File temporary = safeChild(root, "." + name + ".tmp");
        boolean committed = false;
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.flush();
                output.getFD().sync();
            }
            try {
                Files.move(
                    temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary.toPath(), target.toPath());
            }
            target.setReadable(false, false);
            target.setWritable(false, false);
            target.setReadable(true, true);
            target.setWritable(true, true);
            committed = true;
            return new Descriptor(target, bytes.length, sha256(bytes), id, channel);
        } finally {
            if (!committed) Files.deleteIfExists(temporary.toPath());
        }
    }

    static Payload readAndDelete(File cacheDirectory, Bundle bundle) throws IOException {
        return readAndDelete(cacheDirectory, bundle, BaseHostService.KEY_REQUEST_JSON);
    }

    static Payload readAndDelete(
        File cacheDirectory,
        Bundle bundle,
        String inlineKey
    ) throws IOException {
        String inline = bundle == null ? null : bundle.getString(inlineKey);
        String spoolName = bundle == null ? null : bundle.getString(KEY_FILE_NAME);
        if (inline != null) {
            if (spoolName != null) throw new IOException("Ambiguous IPC request payload");
            byte[] bytes = inline.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > INLINE_LIMIT_BYTES) {
                throw new IOException("Oversized IPC envelope was not spooled");
            }
            return new Payload(inline, null, null);
        }
        if (spoolName == null || !FILE_NAME.matcher(spoolName).matches()) {
            throw new IOException("IPC envelope payload is missing");
        }

        File file = safeChild(spoolRoot(cacheDirectory), spoolName);
        try {
            long expectedSize = bundle.getLong(KEY_SIZE, -1L);
            String expectedHash = bundle.getString(KEY_SHA256, "");
            String expectedId = bundle.getString(KEY_ID, "");
            String expectedChannel = bundle.getString(KEY_CHANNEL, "");
            if (expectedSize <= INLINE_LIMIT_BYTES || expectedSize > MAX_REQUEST_BYTES) {
                throw new IOException("Invalid IPC spool size");
            }
            if (!SHA256.matcher(expectedHash).matches()) {
                throw new IOException("Invalid IPC spool digest");
            }
            requireIdentity(expectedId, "spooled request id");
            requireIdentity(expectedChannel, "spooled request channel");
            if (Files.isSymbolicLink(file.toPath()) || !file.isFile()) {
                throw new IOException("IPC spool file is unavailable");
            }
            if (file.length() != expectedSize) {
                throw new IOException("IPC spool size mismatch");
            }
            byte[] bytes = readExactly(file, (int) expectedSize);
            if (!MessageDigest.isEqual(
                hexToBytes(expectedHash), hexToBytes(sha256(bytes)))) {
                throw new IOException("IPC spool digest mismatch");
            }
            return new Payload(
                new String(bytes, StandardCharsets.UTF_8), expectedId, expectedChannel);
        } finally {
            Files.deleteIfExists(file.toPath());
        }
    }

    /** Remove crash leftovers without touching a payload which may be in flight. */
    static void cleanupStale(File cacheDirectory, long olderThanMillis) {
        if (cacheDirectory == null || olderThanMillis < 0L) return;
        try {
            File root = spoolRoot(cacheDirectory);
            long cutoff = System.currentTimeMillis() - olderThanMillis;
            File[] children = root.listFiles();
            if (children == null) return;
            for (File child : children) {
                String name = child.getName();
                boolean payload = FILE_NAME.matcher(name).matches();
                boolean temporary = name.startsWith(".payload-") && name.endsWith(".json.tmp");
                if ((payload || temporary) && child.lastModified() < cutoff) {
                    try {
                        Files.deleteIfExists(child.toPath());
                    } catch (IOException ignored) {
                    }
                }
            }
        } catch (IOException ignored) {
        }
    }

    private static byte[] readExactly(File file, int size) throws IOException {
        byte[] bytes = new byte[size];
        int offset = 0;
        try (FileInputStream input = new FileInputStream(file)) {
            while (offset < size) {
                int read = input.read(bytes, offset, size - offset);
                if (read < 0) throw new IOException("IPC spool ended early");
                offset += read;
            }
            if (input.read() != -1) throw new IOException("IPC spool grew while reading");
        }
        return bytes;
    }

    private static File spoolRoot(File cacheDirectory) throws IOException {
        if (cacheDirectory == null) throw new IOException("App cache directory is unavailable");
        File root = new File(cacheDirectory, DIRECTORY).getCanonicalFile();
        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) {
            throw new IOException("Unable to create IPC spool directory");
        }
        return root;
    }

    private static File safeChild(File root, String name) throws IOException {
        if (name == null || name.isEmpty() || name.indexOf('/') >= 0
            || name.indexOf('\\') >= 0 || name.indexOf('\0') >= 0) {
            throw new IOException("Unsafe IPC spool name");
        }
        File child = new File(root, name).getCanonicalFile();
        if (!root.equals(child.getParentFile())) {
            throw new IOException("IPC spool path escaped its directory");
        }
        return child;
    }

    private static void requireIdentity(String value, String label) throws IOException {
        if (value == null || value.trim().isEmpty() || value.length() > 256) {
            throw new IOException("Invalid " + label);
        }
    }

    private static String sha256(byte[] value) throws IOException {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
            StringBuilder result = new StringBuilder(64);
            for (byte item : digest) {
                result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IOException("SHA-256 is unavailable", impossible);
        }
    }

    private static byte[] hexToBytes(String value) {
        byte[] result = new byte[value.length() / 2];
        for (int index = 0; index < result.length; index += 1) {
            result[index] = (byte) Integer.parseInt(
                value.substring(index * 2, index * 2 + 2), 16);
        }
        return result;
    }
}
