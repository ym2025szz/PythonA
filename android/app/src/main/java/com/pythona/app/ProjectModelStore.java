package com.pythona.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.UUID;

/** Versioned project/run metadata kept outside the user-visible project tree. */
final class ProjectModelStore {
    private static final int SCHEMA_VERSION = 1;
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private final File root;
    private final File modelFile;

    ProjectModelStore(Context context, String workspaceId) throws IOException {
        this(context.getNoBackupFilesDir(), workspaceId);
    }

    ProjectModelStore(File base, String workspaceId) throws IOException {
        if (!workspaceId.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")) throw new IOException("Invalid workspace id");
        root = new File(new File(base, ".pythona"), workspaceId)
            .getCanonicalFile();
        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) {
            throw new IOException("Unable to create private project metadata");
        }
        modelFile = new File(root, "project.json");
    }

    synchronized JSONObject open() throws Exception {
        if (!modelFile.isFile()) {
            JSONObject migrated = defaults();
            persist(migrated);
            return migrated;
        }
        if (modelFile.length() > MAX_BYTES) throw new IOException("Project metadata is too large");
        byte[] bytes = new byte[(int) modelFile.length()];
        try (FileInputStream input = new FileInputStream(modelFile)) {
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) throw new IOException("Truncated project metadata");
                offset += read;
            }
        }
        JSONObject parsed = normalize(new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
        if (parsed.optInt("schemaVersion", 0) != SCHEMA_VERSION) persist(parsed);
        return parsed;
    }

    synchronized JSONObject save(JSONObject requested) throws Exception {
        JSONObject model = normalize(requested);
        persist(model);
        return model;
    }

    synchronized JSONArray runConfigurations() throws Exception {
        return new JSONArray(open().optJSONArray("runConfigurations").toString());
    }

    synchronized JSONArray saveRunConfigurations(JSONArray configurations) throws Exception {
        if (configurations == null) configurations = new JSONArray();
        if (configurations.length() > 1_000) throw new IllegalArgumentException("Too many run configurations");
        JSONArray normalized = new JSONArray();
        for (int index = 0; index < configurations.length(); index += 1) {
            normalized.put(normalizeRunConfiguration(configurations.getJSONObject(index)));
        }
        JSONObject model = open();
        model.put("runConfigurations", normalized);
        persist(model);
        return normalized;
    }

    private void persist(JSONObject model) throws Exception {
        byte[] bytes = model.toString(2).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("Project metadata is too large");
        File temporary = new File(root, "project-" + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.flush();
                output.getFD().sync();
            }
            try {
                Files.move(temporary.toPath(), modelFile.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (java.nio.file.AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary.toPath(), modelFile.toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }
    }

    private static JSONObject normalize(JSONObject source) throws Exception {
        JSONObject defaults = defaults();
        if (source == null) return defaults;
        JSONObject result = new JSONObject(source.toString());
        result.put("schemaVersion", SCHEMA_VERSION);
        result.put("projectId", bounded(result.optString("projectId", "default"), 128));
        result.put("name", bounded(result.optString("name", "ml-playground"), 256));
        if (result.optJSONArray("modules") == null) result.put("modules", defaults.getJSONArray("modules"));
        if (result.optJSONArray("interpreters") == null) result.put("interpreters", defaults.getJSONArray("interpreters"));
        if (result.optJSONArray("runConfigurations") == null) result.put("runConfigurations", new JSONArray());
        if (result.optJSONArray("sourceRoots") == null) result.put("sourceRoots", defaults.getJSONArray("sourceRoots"));
        if (result.optJSONArray("excludeRoots") == null) result.put("excludeRoots", defaults.getJSONArray("excludeRoots"));
        return result;
    }

    private static JSONObject normalizeRunConfiguration(JSONObject source) throws Exception {
        String id = bounded(source.optString("id", ""), 128);
        String target = bounded(source.optString("target", ""), 4096);
        if (id.isEmpty() || target.isEmpty()) throw new IllegalArgumentException("Run configuration id and target are required");
        boolean test = "test".equals(source.optString("type", ""));
        String targetKind = "module".equals(source.optString("targetKind")) ? "module" : "file";
        JSONObject result = new JSONObject()
            .put("id", id)
            .put("name", bounded(source.optString("name", target), 256))
            .put("type", test ? "test" : "python")
            .put("targetKind", targetKind)
            .put("target", target)
            .put("args", source.optJSONArray("args") == null ? new JSONArray() : source.optJSONArray("args"))
            .put("workingDirectory", bounded(source.optString("workingDirectory", "/"), 4096))
            .put("interpreterId", bounded(source.optString("interpreterId", "bundled-cpython"), 128))
            .put("environment", source.optJSONObject("environment") == null ? new JSONObject() : source.optJSONObject("environment"))
            .put("envFiles", source.optJSONArray("envFiles") == null ? new JSONArray() : source.optJSONArray("envFiles"))
            .put("beforeRun", source.optJSONArray("beforeRun") == null
                ? new JSONArray().put(new JSONObject().put("type", "saveAll"))
                : source.optJSONArray("beforeRun"))
            .put("shared", source.optBoolean("shared", false))
            .put("lastRunAt", source.has("lastRunAt") ? source.opt("lastRunAt") : JSONObject.NULL);
        if (test) {
            String framework = source.optString("framework", "pytest");
            if (!framework.matches("pytest|unittest|auto")) throw new IllegalArgumentException("Invalid framework");
            result.put("framework", framework);
            result.put("paths", stringArray(source, "paths", new JSONArray().put(target)));
            result.put("nodeId", source.has("nodeId") ? source.opt("nodeId") : JSONObject.NULL);
            result.put("testArgs", stringArray(source, "testArgs", new JSONArray()));
            result.put("timeoutMillis", Math.max(0, source.optLong("timeoutMillis", 0)));
        }
        return result;
    }

    private static JSONArray stringArray(JSONObject source, String key, JSONArray fallback) throws Exception {
        if (!source.has(key)) return fallback;
        JSONArray array = source.optJSONArray(key);
        if (array == null || array.length() > 256) throw new IllegalArgumentException("Invalid " + key);
        for (int i = 0; i < array.length(); i++) {
            if (!(array.get(i) instanceof String)) throw new IllegalArgumentException(key + " must contain strings");
        }
        return new JSONArray(array.toString());
    }

    private static JSONObject defaults() throws Exception {
        JSONArray excludes = new JSONArray()
            .put(".git").put(".venv").put("venv").put("node_modules").put("__pycache__");
        return new JSONObject()
            .put("schemaVersion", SCHEMA_VERSION)
            .put("projectId", "default")
            .put("name", "ml-playground")
            .put("modules", new JSONArray().put(new JSONObject()
                .put("id", "app").put("name", "app")
                .put("contentRoots", new JSONArray().put("/"))
                .put("sourceRoots", new JSONArray().put("src"))
                .put("testRoots", new JSONArray().put("tests"))
                .put("excludeRoots", excludes)))
            .put("interpreters", new JSONArray().put(new JSONObject()
                .put("id", "bundled-cpython").put("name", "Bundled CPython")
                .put("kind", "bundled").put("selected", true)))
            .put("runConfigurations", new JSONArray())
            .put("sourceRoots", new JSONArray().put("src"))
            .put("excludeRoots", excludes);
    }

    private static String bounded(String value, int maximum) {
        String result = value == null ? "" : value.trim();
        if (result.length() > maximum) throw new IllegalArgumentException("Project metadata field is too long");
        return result;
    }
}
