package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.UUID;

/** Bounded atomic drafts outside the workspace. These files are never executable content. */
final class EditorDraftStore {
    private static final int MAX_FILES = 64;
    private static final long MAX_CONTENT_BYTES = WorkspaceRepository.MAX_EDITABLE_TEXT_BYTES;
    private static final long MAX_RECORD_BYTES = MAX_CONTENT_BYTES * 2 + 65536;
    private static final long MAX_TOTAL_BYTES = 64L * 1024 * 1024;
    private final File filesRoot;
    private final File directory;

    EditorDraftStore(File appFiles, String workspaceId) throws IOException {
        if (appFiles == null || !workspaceId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")) {
            throw new IllegalArgumentException("Invalid draft workspace");
        }
        filesRoot = appFiles.getCanonicalFile();
        directory = new File(new File(filesRoot, "editor-drafts"), workspaceId);
        ensureDirectory();
    }

    private void ensureDirectory() throws IOException {
        File parent = directory.getParentFile();
        if (Files.isSymbolicLink(parent.toPath()) || Files.isSymbolicLink(directory.toPath())) throw new IOException("Draft directory is a symlink");
        if (!directory.getCanonicalPath().startsWith(filesRoot.getPath() + File.separator)) throw new IOException("Draft directory escaped app files");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create draft directory");
    }

    static String checkedPath(String path) {
        if (path == null || path.isEmpty() || path.length() > 2048 || path.startsWith("/") || path.contains("\\")
            || path.contains(":") || path.chars().anyMatch(value -> value < 32)) throw new IllegalArgumentException("Invalid draft path");
        for (String part : path.split("/", -1)) if (part.isEmpty() || ".".equals(part) || "..".equals(part)) throw new IllegalArgumentException("Invalid draft path");
        return path;
    }

    private File file(String path) throws Exception {
        ensureDirectory();
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(checkedPath(path).getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : digest) name.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        File target = new File(directory, name + ".json");
        if (Files.isSymbolicLink(target.toPath()) || !target.getCanonicalFile().getParentFile().equals(directory.getCanonicalFile())) {
            throw new IOException("Draft file escaped directory");
        }
        return target;
    }

    synchronized JSONObject read(String path) throws Exception {
        File source = file(path);
        if (!source.exists()) return null;
        JSONObject value = decode(source);
        if (!path.equals(value.optString("path"))) throw new IOException("Draft identity mismatch");
        return value;
    }

    private JSONObject decode(File source) throws Exception {
        if (!Files.isRegularFile(source.toPath(), LinkOption.NOFOLLOW_LINKS) || source.length() > MAX_RECORD_BYTES) throw new IOException("Invalid draft file");
        JSONObject value = new JSONObject(new String(Files.readAllBytes(source.toPath()), StandardCharsets.UTF_8));
        if (value.optInt("schemaVersion") != 1) throw new IOException("Unsupported draft version");
        checkedPath(value.getString("path"));
        if (!(value.opt("content") instanceof String) || !(value.opt("original") instanceof String)
            || value.getLong("revision") < 0 || value.getLong("bufferVersion") < 0
            || value.getString("content").getBytes(StandardCharsets.UTF_8).length > MAX_CONTENT_BYTES
            || value.getString("original").getBytes(StandardCharsets.UTF_8).length > MAX_CONTENT_BYTES) {
            throw new IOException("Malformed draft payload");
        }
        return value;
    }

    synchronized JSONObject write(JSONObject requested) throws Exception {
        String path = checkedPath(requested.getString("path"));
        File target = file(path);
        String content = requested.getString("content");
        String original = requested.getString("original");
        if (content.getBytes(StandardCharsets.UTF_8).length > MAX_CONTENT_BYTES
            || original.getBytes(StandardCharsets.UTF_8).length > MAX_CONTENT_BYTES) throw new IOException("Draft exceeds editable text limit");
        long revision = requested.getLong("revision");
        long version = requested.optLong("bufferVersion", 0);
        if (revision < 0 || version < 0) throw new IllegalArgumentException("Invalid draft version");
        JSONObject value = new JSONObject().put("schemaVersion", 1).put("path", path)
            .put("content", content).put("original", original).put("revision", revision)
            .put("hash", requested.optString("hash", "")).put("bufferVersion", version)
            .put("updatedAt", System.currentTimeMillis());
        JSONObject view = requested.optJSONObject("viewState");
        if (view != null) {
            JSONObject scroll = view.optJSONObject("scroll");
            value.put("viewState", new JSONObject().put("cursor", Math.max(0, Math.min(content.length(), view.optInt("cursor"))))
                .put("scroll", new JSONObject().put("top", scroll == null ? 0 : Math.max(0, Math.min(100000000, scroll.optDouble("top", 0))))
                    .put("left", scroll == null ? 0 : Math.max(0, Math.min(100000000, scroll.optDouble("left", 0))))));
        }
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_RECORD_BYTES) throw new IOException("Draft record too large");
        long total = 0;
        int count = 0;
        File[] files = directory.listFiles();
        if (files == null) throw new IOException("Cannot list drafts");
        for (File entry : files) if (entry.getName().endsWith(".json") && !entry.equals(target)) { total += entry.length(); count++; }
        if (count >= MAX_FILES || total + bytes.length > MAX_TOTAL_BYTES) throw new IOException("Draft storage limit reached; save or close existing drafts");
        File temporary = new File(directory, UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(bytes); output.getFD().sync(); }
            try { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (java.nio.file.AtomicMoveNotSupportedException unsupported) { Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(temporary.toPath()); }
        return new JSONObject().put("saved", true).put("path", path).put("updatedAt", value.getLong("updatedAt"));
    }

    synchronized JSONObject list() throws Exception {
        ensureDirectory();
        JSONArray drafts = new JSONArray();
        File[] files = directory.listFiles();
        if (files == null) throw new IOException("Cannot list drafts");
        JSONArray errors = new JSONArray();
        for (File source : files) if (source.getName().endsWith(".json")) {
            try {
                JSONObject value = decode(source);
                drafts.put(new JSONObject().put("path", value.getString("path")).put("updatedAt", value.optLong("updatedAt"))
                    .put("revision", value.optLong("revision")).put("hash", value.optString("hash")));
            } catch (Exception error) { errors.put("A draft could not be read; its file has been preserved"); }
        }
        return new JSONObject().put("drafts", drafts).put("errors", errors);
    }

    synchronized JSONObject delete(String path) throws Exception {
        return new JSONObject().put("deleted", Files.deleteIfExists(file(path).toPath())).put("path", path);
    }
}
