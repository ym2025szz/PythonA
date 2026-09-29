package com.pythona.app;

import java.io.BufferedInputStream;
import java.io.EOFException;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;

/** Bounded offline rootfs extractor. Links are created only after all payload writes finish. */
public final class TarGzipExtractor {
    public interface ProgressListener { void onProgress(long bytes, long entries); }
    private static final int BLOCK = 512;
    private static final long MAX_FILE_BYTES = 512L * 1024 * 1024;
    private static final long MAX_TOTAL_BYTES = 2L * 1024 * 1024 * 1024;
    private static final int MAX_ENTRIES = 100_000;
    private static final int MAX_METADATA = 256 * 1024;
    private TarGzipExtractor() {}

    public static void extractAuto(InputStream raw, File dest, int strip, boolean lenient,
                                   boolean rejectLinks) throws IOException {
        extractAuto(raw, dest, strip, rejectLinks, (bytes, entries) -> {});
    }

    public static void extractAuto(InputStream raw, File dest, int strip, boolean rejectLinks,
                                   ProgressListener progress) throws IOException {
        PushbackInputStream input = new PushbackInputStream(new BufferedInputStream(raw, 64 * 1024), 2);
        int first = input.read(), second = input.read();
        if (second >= 0) input.unread(second);
        if (first >= 0) input.unread(first);
        try (InputStream tar = first == 0x1f && second == 0x8b
                ? new GZIPInputStream(input, 64 * 1024) : input) {
            extractTar(tar, dest, strip, rejectLinks, progress);
            // Consume the gzip trailer; otherwise an early tar EOF can hide a bad CRC.
            byte[] tail = new byte[8192];
            long trailing = 0;
            int count;
            while ((count = tar.read(tail)) >= 0) {
                trailing += count;
                if (trailing > 16L * 1024 * 1024) throw new IOException("Excessive tar trailer");
                for (int i = 0; i < count; i++) if (tail[i] != 0) throw new IOException("Unexpected tar trailing data");
            }
        }
    }

    static void extractTar(InputStream input, File dest, int strip, boolean rejectLinks,
                           ProgressListener progress) throws IOException {
        Path root = dest.toPath().toAbsolutePath().normalize();
        if (Files.isSymbolicLink(root)) throw new IOException("Rootfs destination is a link");
        Files.createDirectories(root);
        byte[] header = new byte[BLOCK], buffer = new byte[256 * 1024];
        List<Link> links = new ArrayList<>();
        Map<String, String> pax = new HashMap<>();
        String longName = null, longLink = null;
        long bytes = 0, entries = 0;
        while (true) {
            checkInterrupted();
            readExactly(input, header, BLOCK);
            if (isZero(header)) {
                readExactly(input, header, BLOCK);
                if (!isZero(header)) throw new IOException("Invalid tar end marker");
                break;
            }
            verifyChecksum(header);
            long size = octal(header, 124, 12);
            int mode = (int) octal(header, 100, 8);
            int type = header[156] & 0xff;
            String name = string(header, 0, 100), target = string(header, 157, 100);
            if (type == 'L' || type == 'K' || type == 'x' || type == 'g') {
                if (size <= 0 || size > MAX_METADATA) throw new IOException("Invalid tar metadata size");
                byte[] metadata = new byte[(int) size];
                readExactly(input, metadata, metadata.length);
                skipExactly(input, padding(size));
                if (type == 'L') longName = string(metadata, 0, metadata.length);
                else if (type == 'K') longLink = string(metadata, 0, metadata.length);
                else if (type == 'x') pax = parsePax(metadata);
                continue;
            }
            String prefix = string(header, 345, 155);
            if (!prefix.isEmpty()) name = prefix + "/" + name;
            if (longName != null) name = longName;
            if (longLink != null) target = longLink;
            name = pax.getOrDefault("path", name);
            target = pax.getOrDefault("linkpath", target);
            if (pax.containsKey("size")) {
                try { size = Long.parseLong(pax.get("size")); }
                catch (NumberFormatException e) { throw new IOException("Invalid PAX file size", e); }
            }
            longName = null; longLink = null; pax.clear();
            if (size < 0 || size > MAX_FILE_BYTES || ++entries > MAX_ENTRIES)
                throw new IOException("Rootfs archive limit exceeded");
            while (name.startsWith("./")) name = name.substring(2);
            for (int i = 0; i < strip && !name.isEmpty(); i++) {
                int slash = name.indexOf('/');
                name = slash < 0 ? "" : name.substring(slash + 1);
            }
            if (name.isEmpty() || name.equals(".")) {
                if (type != '5') throw new IOException("Empty tar payload path");
                skipExactly(input, size + padding(size));
                continue;
            }
            Path out = safePath(root, name);
            ensureParents(root, out.getParent());
            if (type == '0' || type == 0 || type == '7') {
                if (bytes > MAX_TOTAL_BYTES - size) throw new IOException("Rootfs expanded size limit exceeded");
                // CREATE_NEW prevents duplicate entries from replacing a directory or following a link.
                try (OutputStream output = Files.newOutputStream(out, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                    long remaining = size;
                    while (remaining > 0) {
                        checkInterrupted();
                        int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                        if (count < 0) throw new EOFException("Truncated tar payload");
                        output.write(buffer, 0, count); remaining -= count; bytes += count;
                        progress.onProgress(bytes, entries);
                    }
                }
                setMode(out, mode);
            } else if (type == '5') {
                if (Files.exists(out, LinkOption.NOFOLLOW_LINKS) && !Files.isDirectory(out, LinkOption.NOFOLLOW_LINKS))
                    throw new IOException("Tar directory conflicts with payload");
                Files.createDirectories(out);
                skipExactly(input, size);
            } else if (type == '1' || type == '2') {
                if (rejectLinks) throw new IOException("Archive links are not allowed");
                links.add(new Link(out, target, type == '1'));
                skipExactly(input, size);
            } else {
                // Device nodes, FIFOs and sparse files have no place in this offline runtime.
                throw new IOException("Unsupported tar entry type: " + type);
            }
            skipExactly(input, padding(size));
            progress.onProgress(bytes, entries);
        }
        // Hardlinks first: their targets must be existing ordinary payload files, never symlinks.
        for (Link link : links) if (link.hard) {
            Path target = safePath(root, link.target);
            bytes += createHardlinkOrCopy(root, link.path, target, MAX_TOTAL_BYTES - bytes, Files::createLink);
            progress.onProgress(bytes, entries);
        }
        for (Link link : links) if (!link.hard) {
            if (link.target.isEmpty() || link.target.indexOf('\0') >= 0 || link.target.indexOf('\\') >= 0)
                throw new IOException("Invalid symlink target");
            Path target = link.target.startsWith("/")
                ? root.resolve(link.target.substring(1)).normalize()
                : link.path.getParent().resolve(link.target).normalize();
            if (!target.startsWith(root)) throw new IOException("Symlink leaves rootfs");
            ensureParents(root, link.path.getParent());
            Files.createSymbolicLink(link.path, link.path.getParent().relativize(target));
        }
        progress.onProgress(bytes, entries);
    }

    interface HardlinkCreator { void create(Path link, Path existing) throws IOException; }

    /** Android SELinux can deny link(2) even within the same app-private directory. These
     * immutable distro aliases can safely be materialized as independent regular files. */
    static long createHardlinkOrCopy(Path root, Path link, Path target, long remainingBytes,
                                     HardlinkCreator creator) throws IOException {
        if (!link.normalize().startsWith(root) || !target.normalize().startsWith(root))
            throw new IOException("Hardlink leaves rootfs");
        ensureParents(root, target.getParent());
        ensureParents(root, link.getParent());
        if (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid hardlink target");
        if (Files.exists(link, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Hardlink destination already exists");
        try { creator.create(link, target); return 0; }
        catch (UnsupportedOperationException unsupported) { /* Materialize the checked file below. */ }
        catch (IOException failure) { if (!unsupportedHardlink(failure)) throw failure; }

        long size = Files.size(target);
        if (size > remainingBytes) throw new IOException("Rootfs expanded size limit exceeded");
        long copied = 0;
        // A replaced source symlink must never be followed; a conflicting destination must
        // never be overwritten. Any partial destination remains in disposable staging only.
        try (InputStream input = Files.newInputStream(target, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS);
             OutputStream output = Files.newOutputStream(link, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            byte[] buffer = new byte[256 * 1024]; int count;
            while ((count = input.read(buffer)) >= 0) {
                checkInterrupted();
                if (copied > remainingBytes - count) throw new IOException("Rootfs expanded size limit exceeded");
                output.write(buffer, 0, count); copied += count;
            }
        }
        if (copied != size) throw new IOException("Hardlink source changed while copying");
        setMode(link, Files.isExecutable(target) ? 0755 : 0644);
        return copied;
    }

    private static boolean unsupportedHardlink(IOException error) {
        if (error instanceof java.nio.file.AccessDeniedException) return true;
        if (!(error instanceof java.nio.file.FileSystemException)) return false;
        String reason = ((java.nio.file.FileSystemException) error).getReason();
        // Android's libcore can omit strerror for an app-domain link(2) denial.
        // The fallback still requires a fresh destination and a no-follow source.
        if (reason == null) return !(error instanceof java.nio.file.FileAlreadyExistsException)
            && !(error instanceof java.nio.file.NoSuchFileException);
        String lower = reason.toLowerCase(java.util.Locale.ROOT);
        return lower.contains("operation not permitted") || lower.contains("permission denied")
            || lower.contains("not supported") || lower.contains("function not implemented")
            || lower.contains("eperm") || lower.contains("eacces") || lower.contains("enosys")
            || lower.contains("eopnotsupp") || lower.contains("enotsup");
    }

    static Path safePath(Path root, String name) throws IOException {
        if (name.isEmpty() || name.startsWith("/") || name.indexOf('\\') >= 0 || name.indexOf('\0') >= 0
                || name.matches("^[A-Za-z]:.*")) throw new IOException("Unsafe tar path");
        Path result = root.resolve(name).normalize();
        if (!result.startsWith(root) || result.equals(root)) throw new IOException("Tar path leaves rootfs");
        return result;
    }

    private static void ensureParents(Path root, Path parent) throws IOException {
        if (!parent.startsWith(root)) throw new IOException("Parent leaves rootfs");
        Path current = root;
        for (Path component : root.relativize(parent)) {
            current = current.resolve(component);
            if (Files.exists(current, LinkOption.NOFOLLOW_LINKS)) {
                if (!Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Tar parent is not an ordinary directory");
            } else Files.createDirectory(current);
        }
    }

    private static void setMode(Path file, int mode) throws IOException {
        if (!file.toFile().setReadable(true, true) || !file.toFile().setWritable(true, true))
            throw new IOException("Cannot set rootfs payload permissions");
        if ((mode & 0111) != 0 && !file.toFile().setExecutable(true, false))
            throw new IOException("Cannot make rootfs payload executable");
    }

    private static Map<String, String> parsePax(byte[] data) throws IOException {
        Map<String, String> values = new HashMap<>();
        int offset = 0;
        while (offset < data.length) {
            int space = offset;
            while (space < data.length && data[space] != ' ') space++;
            int length;
            try { length = Integer.parseInt(new String(data, offset, space - offset, StandardCharsets.US_ASCII)); }
            catch (RuntimeException e) { throw new IOException("Invalid PAX record", e); }
            if (length <= space - offset + 2 || offset + length > data.length || data[offset + length - 1] != '\n')
                throw new IOException("Invalid PAX record length");
            String record = new String(data, space + 1, offset + length - space - 2, StandardCharsets.UTF_8);
            int equals = record.indexOf('=');
            if (equals > 0) values.put(record.substring(0, equals), record.substring(equals + 1));
            offset += length;
        }
        return values;
    }

    private static void verifyChecksum(byte[] header) throws IOException {
        long expected = octal(header, 148, 8), actual = 0;
        for (int i = 0; i < BLOCK; i++) actual += i >= 148 && i < 156 ? 32 : header[i] & 0xff;
        if (actual != expected) throw new IOException("Tar header checksum mismatch");
    }
    private static long octal(byte[] data, int offset, int length) throws IOException {
        long value = 0;
        for (int i = offset; i < offset + length; i++) {
            int c = data[i] & 0xff;
            if (c == 0 || c == 32) continue;
            if (c < '0' || c > '7') throw new IOException("Invalid tar numeric field");
            value = value * 8 + c - '0';
        }
        return value;
    }
    private static String string(byte[] bytes, int offset, int length) {
        int end = offset;
        while (end < offset + length && bytes[end] != 0) end++;
        return new String(bytes, offset, end - offset, StandardCharsets.UTF_8);
    }
    private static boolean isZero(byte[] bytes) { for (byte value : bytes) if (value != 0) return false; return true; }
    private static long padding(long size) { return (BLOCK - size % BLOCK) % BLOCK; }
    private static void skipExactly(InputStream input, long length) throws IOException {
        while (length > 0) {
            checkInterrupted();
            long skipped = input.skip(length);
            if (skipped <= 0) { if (input.read() < 0) throw new EOFException("Truncated tar padding"); skipped = 1; }
            length -= skipped;
        }
    }
    private static void readExactly(InputStream input, byte[] buffer, int length) throws IOException {
        int offset = 0;
        while (offset < length) {
            int count = input.read(buffer, offset, length - offset);
            if (count < 0) throw new EOFException("Truncated tar header or metadata");
            offset += count;
        }
    }
    private static void checkInterrupted() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("Rootfs installation interrupted");
    }
    private static final class Link {
        final Path path; final String target; final boolean hard;
        Link(Path path, String target, boolean hard) { this.path = path; this.target = target; this.hard = hard; }
    }
}
