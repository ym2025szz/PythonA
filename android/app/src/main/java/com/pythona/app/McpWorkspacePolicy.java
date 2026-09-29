package com.pythona.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/** The model-facing context policy, independent of Android and the MCP transport. */
final class McpWorkspacePolicy {
    static final int MAX_FILE_BYTES = 512 * 1024;
    static final int MAX_TEXT_BYTES = 48 * 1024;
    static final int MAX_SCAN_FILES = 512;
    static final int MAX_SCAN_BYTES = 2 * 1024 * 1024;
    private static final Pattern SECRET_FIELD = Pattern.compile(
        "(?i)(?:api.?key|secret|password|passwd|credential|authorization|bearer|access.?token|refresh.?token)");
    private static final Pattern[] SECRETS = {
        Pattern.compile("-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)"),
        Pattern.compile("\\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{20,}\\b"),
        Pattern.compile("\\bAIza[0-9A-Za-z_-]{20,}\\b"),
        Pattern.compile("\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b"),
        Pattern.compile("\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b"),
        Pattern.compile("\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b"),
        Pattern.compile("\\bsk_(?:live|test)_[A-Za-z0-9]{16,}\\b"),
        Pattern.compile("\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\b"),
        Pattern.compile("(?i)\\b(?:password|passwd|api[_-]?key|secret|token)\\s*[\"']?\\s*[:=]\\s*[\"']?[^\\s\"',;}]{6,}"),
        Pattern.compile("(?i)\\b(?:Bearer|Basic)\\s+[A-Za-z0-9+/=._-]{6,}")
    };

    private final WorkspaceRepository workspace;
    private final List<Pattern> ignores = new ArrayList<>();
    private boolean scanTruncated;

    McpWorkspacePolicy(WorkspaceRepository workspace) throws IOException {
        this.workspace = workspace;
        File ignore = resolve(".pyaignore");
        if (ignore.exists()) {
            if (!ignore.isFile() || ignore.length() > 64 * 1024) {
                throw new IOException("Workspace ignore rules exceed the MCP limit");
            }
            String text = new String(Files.readAllBytes(ignore.toPath()), StandardCharsets.UTF_8);
            for (String line : text.split("\\r?\\n")) {
                String rule = line.trim().replace('\\', '/');
                // Negation cannot expose a default secret exclusion.
                if (rule.isEmpty() || rule.startsWith("#") || rule.startsWith("!")) continue;
                if (ignores.size() >= 256 || rule.length() > 512) throw new IOException("Too many workspace ignore rules");
                ignores.add(glob(rule));
            }
        }
    }

    File resolve(String requested) throws IOException {
        String path = WorkspaceRepository.normalizeRelativePath(requested);
        File root = workspace.rootDirectory().getCanonicalFile();
        File target = new File(root, path).getCanonicalFile();
        if (!target.getPath().startsWith(root.getPath() + File.separator)) {
            throw new IOException("Workspace path escapes its root");
        }
        // An internal symlink must not bypass .pyaignore under a different name.
        Path current = root.toPath();
        for (String segment : path.split("/")) {
            current = current.resolve(segment);
            if (Files.isSymbolicLink(current)) throw new IOException("MCP does not follow workspace symlinks");
        }
        return target;
    }

    String requireAllowed(String requested) throws IOException {
        String normalized = WorkspaceRepository.normalizeRelativePath(requested);
        resolve(normalized);
        if (ignored(normalized)) throw new IOException("Path is excluded from model context");
        return normalized;
    }

    boolean ignored(String path) {
        String lower = path.replace('\\', '/').toLowerCase(Locale.ROOT);
        for (String piece : lower.split("/")) {
            if (piece.equals(".git") || piece.equals(".venv") || piece.equals("venv")
                || piece.equals("node_modules") || piece.equals("__pycache__")
                || piece.equals(".env") || piece.startsWith(".env.")
                || piece.endsWith(".pem") || piece.endsWith(".key")
                || piece.startsWith("credentials") || piece.startsWith("secrets")) return true;
        }
        for (Pattern rule : ignores) if (rule.matcher(path).matches() || rule.matcher(path + "/").matches()) return true;
        return false;
    }

    List<String> files() throws IOException {
        scanTruncated = false;
        ArrayList<String> result = new ArrayList<>();
        final int[] visits = {0};
        final long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2);
        Path root = workspace.rootDirectory().toPath();
        Files.walkFileTree(root, new SimpleFileVisitor<Path>() {
            private boolean limit() {
                boolean reached = ++visits[0] > 2048 || System.nanoTime() > deadline || result.size() >= MAX_SCAN_FILES;
                if (reached) scanTruncated = true;
                return reached;
            }
            @Override public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) {
                if (limit()) return FileVisitResult.TERMINATE;
                String path = root.relativize(directory).toString().replace(File.separatorChar, '/');
                return !path.isEmpty() && ignored(path) ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
                if (limit()) return FileVisitResult.TERMINATE;
                String path = root.relativize(file).toString().replace(File.separatorChar, '/');
                if (attributes.isRegularFile() && attributes.size() <= MAX_FILE_BYTES && !ignored(path)) result.add(path);
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFileFailed(Path file, IOException failure) { return FileVisitResult.CONTINUE; }
        });
        java.util.Collections.sort(result);
        return result;
    }

    boolean scanTruncated() { return scanTruncated; }

    static int bytes(String text) { return String.valueOf(text).getBytes(StandardCharsets.UTF_8).length; }

    static String truncate(String value, int maxBytes) {
        String text = value == null ? "" : value;
        int used = 0;
        int end = 0;
        while (end < text.length()) {
            int point = text.codePointAt(end);
            int size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
            if (used + size > maxBytes) break;
            used += size;
            end += Character.charCount(point);
        }
        return text.substring(0, end);
    }

    static String redact(String value) {
        String safe = value == null ? "" : value;
        for (Pattern pattern : SECRETS) safe = pattern.matcher(safe).replaceAll("[REDACTED]");
        return safe;
    }

    static Object redactValue(Object value) throws Exception { return redactValue(value, 0); }

    static boolean exceedsValueLimits(Object value) { return exceedsValueLimits(value, 0); }

    private static boolean exceedsValueLimits(Object value, int depth) {
        if (depth > 12) return true;
        if (value instanceof String) return bytes((String) value) > MAX_TEXT_BYTES;
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            if (array.length() > 100) return true;
            for (int index = 0; index < array.length(); index++) if (exceedsValueLimits(array.opt(index), depth + 1)) return true;
        } else if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            if (object.length() > 128) return true;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (bytes(key) > 256 || exceedsValueLimits(object.opt(key), depth + 1)) return true;
            }
        }
        return false;
    }

    private static Object redactValue(Object value, int depth) throws Exception {
        if (depth > 12) return "[truncated]";
        if (value instanceof JSONObject) {
            JSONObject result = new JSONObject();
            Iterator<String> keys = ((JSONObject) value).keys();
            int count = 0;
            while (keys.hasNext() && count++ < 128) {
                String key = keys.next();
                result.put(truncate(redact(key), 256), SECRET_FIELD.matcher(key).find()
                    ? "[REDACTED]" : redactValue(((JSONObject) value).opt(key), depth + 1));
            }
            return result;
        }
        if (value instanceof JSONArray) {
            JSONArray result = new JSONArray();
            for (int index = 0; index < Math.min(100, ((JSONArray) value).length()); index++)
                result.put(redactValue(((JSONArray) value).opt(index), depth + 1));
            return result;
        }
        return value instanceof String ? truncate(redact((String) value), MAX_TEXT_BYTES) : value;
    }

    private static Pattern glob(String source) {
        String value = source.startsWith("./") ? source.substring(2) : source;
        if (value.startsWith("/")) value = value.substring(1);
        if (value.endsWith("/")) value += "**";
        StringBuilder out = new StringBuilder(value.contains("/") ? "^" : "^(?:.*/)?");
        for (int index = 0; index < value.length(); index++) {
            char c = value.charAt(index);
            if (c == '*' && index + 1 < value.length() && value.charAt(index + 1) == '*') {
                index++;
                if (index + 1 < value.length() && value.charAt(index + 1) == '/') { out.append("(?:.*/)?"); index++; }
                else out.append(".*");
            } else if (c == '*') out.append("[^/]*");
            else if (c == '?') out.append("[^/]");
            else out.append(Pattern.quote(String.valueOf(c)));
        }
        return Pattern.compile(out.append('$').toString(), Pattern.CASE_INSENSITIVE);
    }
}
