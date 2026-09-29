package com.pythona.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** SQLite-backed, single-worker incremental project index. */
final class ProjectIndexDatabase extends SQLiteOpenHelper {
    private static final int VERSION = 1;
    private static final Pattern SYMBOL = Pattern.compile(
        "^(\\s*)(?:async\\s+)?(class|def)\\s+([A-Za-z_][A-Za-z0-9_]*)");
    private static final Pattern IMPORT = Pattern.compile(
        "^\\s*(?:from\\s+([A-Za-z0-9_.]+)\\s+import|import\\s+([A-Za-z0-9_.]+))");
    private volatile String state = "stale";
    private volatile String failure = "";
    private volatile long generation;

    ProjectIndexDatabase(Context context, String workspaceId) throws Exception {
        super(context, databaseFile(context, workspaceId).getCanonicalPath(), null, VERSION);
    }

    private static File databaseFile(Context context, String workspaceId) throws Exception {
        File directory = new File(new File(context.getNoBackupFilesDir(), ".pythona"), workspaceId);
        if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) {
            throw new java.io.IOException("Unable to create project index directory");
        }
        return new File(directory, "index.db");
    }

    @Override
    public void onConfigure(SQLiteDatabase database) {
        database.setForeignKeyConstraintsEnabled(true);
        database.enableWriteAheadLogging();
    }

    @Override
    public void onCreate(SQLiteDatabase database) {
        database.execSQL("CREATE TABLE files(path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, language TEXT NOT NULL, ignored INTEGER NOT NULL DEFAULT 0)");
        database.execSQL("CREATE TABLE symbols(uri TEXT NOT NULL, name TEXT NOT NULL, qualifiedName TEXT NOT NULL, kind TEXT NOT NULL, startLine INTEGER NOT NULL, startCharacter INTEGER NOT NULL, endLine INTEGER NOT NULL, endCharacter INTEGER NOT NULL)");
        database.execSQL("CREATE INDEX symbols_name ON symbols(name)");
        database.execSQL("CREATE INDEX symbols_uri ON symbols(uri)");
        database.execSQL("CREATE TABLE imports(uri TEXT NOT NULL, moduleName TEXT NOT NULL, targetUri TEXT)");
        database.execSQL("CREATE INDEX imports_uri ON imports(uri)");
        database.execSQL("CREATE VIRTUAL TABLE content_fts USING fts4(path, line, text)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
        database.execSQL("DROP TABLE IF EXISTS content_fts");
        database.execSQL("DROP TABLE IF EXISTS imports");
        database.execSQL("DROP TABLE IF EXISTS symbols");
        database.execSQL("DROP TABLE IF EXISTS files");
        onCreate(database);
    }

    synchronized JSONObject status() throws Exception {
        return new JSONObject().put("status", state).put("generation", generation)
            .put("error", failure.isEmpty() ? JSONObject.NULL : failure);
    }

    synchronized JSONObject index(WorkspaceRepository workspace) throws Exception {
        state = "indexing";
        failure = "";
        SQLiteDatabase database = getWritableDatabase();
        database.beginTransaction();
        try {
            List<WorkspaceRepository.Summary> summaries = workspace.list();
            List<Pattern> ignoreRules = loadIgnoreRules(workspace, summaries);
            Set<String> present = new HashSet<>();
            for (WorkspaceRepository.Summary summary : summaries) {
                present.add(summary.path);
                boolean ignored = ignored(summary.path, ignoreRules) || !summary.editable;
                String priorHash = null;
                int priorIgnored = -1;
                try (Cursor cursor = database.query("files", new String[]{"sha256", "ignored"},
                    "path=?", new String[]{summary.path}, null, null, null)) {
                    if (cursor.moveToFirst()) { priorHash = cursor.getString(0); priorIgnored = cursor.getInt(1); }
                }
                if (summary.sha256.equals(priorHash) && priorIgnored == (ignored ? 1 : 0)) continue;
                removePath(database, summary.path);
                ContentValues file = new ContentValues();
                file.put("path", summary.path);
                file.put("sha256", summary.sha256);
                file.put("size", summary.size);
                file.put("language", language(summary.path));
                file.put("ignored", ignored ? 1 : 0);
                database.insertOrThrow("files", null, file);
                if (!ignored) indexFile(database, workspace.read(summary.path));
            }
            ArrayList<String> deleted = new ArrayList<>();
            try (Cursor cursor = database.query("files", new String[]{"path"}, null, null, null, null, null)) {
                while (cursor.moveToNext()) if (!present.contains(cursor.getString(0))) deleted.add(cursor.getString(0));
            }
            for (String path : deleted) removePath(database, path);
            resolveImports(database);
            database.setTransactionSuccessful();
            generation += 1;
            state = "ready";
            return status().put("fileCount", summaries.size());
        } catch (Exception error) {
            state = "failed";
            failure = safeMessage(error);
            throw error;
        } finally {
            database.endTransaction();
        }
    }

    synchronized JSONArray search(String query, int requestedLimit) throws Exception {
        SQLiteDatabase database = getReadableDatabase();
        String value = query == null ? "" : query.trim();
        if (value.isEmpty()) return new JSONArray();
        int limit = Math.max(1, Math.min(500, requestedLimit));
        JSONArray result = new JSONArray();
        String like = "%" + value.replace("%", "\\%").replace("_", "\\_") + "%";
        try (Cursor cursor = database.rawQuery(
            "SELECT path FROM files WHERE ignored=0 AND path LIKE ? ESCAPE '\\' ORDER BY path LIMIT ?",
            new String[]{like, String.valueOf(limit)})) {
            while (cursor.moveToNext()) result.put(new JSONObject()
                .put("kind", "file").put("path", cursor.getString(0)));
        }
        if (result.length() < limit) try (Cursor cursor = database.rawQuery(
            "SELECT uri,name,qualifiedName,kind,startLine,startCharacter,endLine,endCharacter FROM symbols WHERE name LIKE ? ESCAPE '\\' OR qualifiedName LIKE ? ESCAPE '\\' LIMIT ?",
            new String[]{like, like, String.valueOf(limit - result.length())})) {
            while (cursor.moveToNext()) result.put(symbolJson(cursor).put("kind", "symbol"));
        }
        String fts = ftsQuery(value);
        if (!fts.isEmpty() && result.length() < limit) try (Cursor cursor = database.rawQuery(
            "SELECT path,line,text FROM content_fts WHERE content_fts MATCH ? LIMIT ?",
            new String[]{fts, String.valueOf(limit - result.length())})) {
            while (cursor.moveToNext()) result.put(new JSONObject()
                .put("kind", "text").put("path", cursor.getString(0))
                .put("line", Integer.parseInt(cursor.getString(1)))
                .put("text", cursor.getString(2)));
        }
        return result;
    }

    synchronized JSONArray symbols(String uriOrPath) throws Exception {
        String uri = uri(uriOrPath);
        JSONArray result = new JSONArray();
        try (Cursor cursor = getReadableDatabase().rawQuery(
            "SELECT uri,name,qualifiedName,kind,startLine,startCharacter,endLine,endCharacter FROM symbols WHERE uri=? ORDER BY startLine,startCharacter",
            new String[]{uri})) {
            while (cursor.moveToNext()) result.put(symbolJson(cursor));
        }
        return result;
    }

    /** Return all indexed symbols for the lightweight language-channel API. */
    synchronized JSONArray workspaceSymbols() throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor cursor = getReadableDatabase().rawQuery(
            "SELECT uri,name,qualifiedName,kind,startLine,startCharacter,endLine,endCharacter "
                + "FROM symbols ORDER BY uri,startLine,startCharacter", null)) {
            while (cursor.moveToNext()) result.put(symbolJson(cursor));
        }
        return result;
    }

    synchronized JSONObject definition(
        WorkspaceRepository workspace,
        String uriOrPath,
        JSONObject position
    ) throws Exception {
        String path = path(uriOrPath);
        String[] lines = workspace.read(path).text().split("\\n", -1);
        int lineNumber = Math.max(0, Math.min(lines.length - 1, position.optInt("line", 0)));
        String line = lines[lineNumber];
        int character = Math.max(0, Math.min(line.length(), position.optInt("character", 0)));
        int start = character;
        int end = character;
        while (start > 0 && Character.isJavaIdentifierPart(line.charAt(start - 1))) start--;
        while (end < line.length() && Character.isJavaIdentifierPart(line.charAt(end))) end++;
        if (start == end) return null;
        String name = line.substring(start, end);
        try (Cursor cursor = getReadableDatabase().rawQuery(
            "SELECT uri,name,qualifiedName,kind,startLine,startCharacter,endLine,endCharacter FROM symbols WHERE name=? ORDER BY CASE WHEN uri=? THEN 0 ELSE 1 END LIMIT 1",
            new String[]{name, uri(path)})) {
            return cursor.moveToFirst() ? symbolJson(cursor) : null;
        }
    }

    synchronized JSONArray contextFor(String uriOrPath) throws Exception {
        String sourceUri = uri(uriOrPath);
        JSONArray result = new JSONArray().put(path(sourceUri));
        try (Cursor cursor = getReadableDatabase().rawQuery(
            "SELECT targetUri FROM imports WHERE uri=? AND targetUri IS NOT NULL",
            new String[]{sourceUri})) {
            while (cursor.moveToNext()) result.put(path(cursor.getString(0)));
        }
        return result;
    }

    private static void indexFile(SQLiteDatabase database, WorkspaceRepository.Entry entry)
        throws Exception {
        String uri = uri(entry.path);
        String[] lines = entry.text().split("\\n", -1);
        ArrayDeque<Scope> scopes = new ArrayDeque<>();
        for (int lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
            String line = lines[lineNumber];
            ContentValues content = new ContentValues();
            content.put("path", entry.path);
            content.put("line", String.valueOf(lineNumber));
            content.put("text", line);
            database.insertOrThrow("content_fts", null, content);
            if (!"python".equals(language(entry.path))) continue;
            Matcher symbol = SYMBOL.matcher(line);
            if (symbol.find()) {
                int indent = symbol.group(1).replace("\t", "    ").length();
                while (!scopes.isEmpty() && scopes.peekLast().indent >= indent) scopes.removeLast();
                String name = symbol.group(3);
                String qualified = scopes.isEmpty() ? name : scopes.peekLast().qualified + "." + name;
                ContentValues values = new ContentValues();
                values.put("uri", uri); values.put("name", name); values.put("qualifiedName", qualified);
                values.put("kind", "class".equals(symbol.group(2)) ? "Class" : "Function");
                values.put("startLine", lineNumber); values.put("startCharacter", line.indexOf(name));
                values.put("endLine", lineNumber); values.put("endCharacter", line.length());
                database.insertOrThrow("symbols", null, values);
                scopes.addLast(new Scope(indent, qualified));
            }
            Matcher imported = IMPORT.matcher(line);
            if (imported.find()) {
                ContentValues values = new ContentValues();
                values.put("uri", uri);
                values.put("moduleName", imported.group(1) == null ? imported.group(2) : imported.group(1));
                database.insertOrThrow("imports", null, values);
            }
        }
    }

    private static void removePath(SQLiteDatabase database, String path) {
        String uri = uri(path);
        database.delete("symbols", "uri=?", new String[]{uri});
        database.delete("imports", "uri=?", new String[]{uri});
        database.delete("content_fts", "path=?", new String[]{path});
        database.delete("files", "path=?", new String[]{path});
    }

    private static void resolveImports(SQLiteDatabase database) {
        Map<String, String> modules = new HashMap<>();
        try (Cursor cursor = database.rawQuery("SELECT path FROM files WHERE language='python' AND ignored=0", null)) {
            while (cursor.moveToNext()) {
                String path = cursor.getString(0);
                String module = path.replaceAll("\\.pyi?$", "").replace('/', '.');
                if (module.endsWith(".__init__")) module = module.substring(0, module.length() - 9);
                modules.put(module, uri(path));
                if (module.startsWith("src.")) modules.put(module.substring(4), uri(path));
            }
        }
        try (Cursor cursor = database.rawQuery("SELECT rowid,moduleName FROM imports", null)) {
            while (cursor.moveToNext()) {
                ContentValues update = new ContentValues();
                update.put("targetUri", modules.get(cursor.getString(1)));
                database.update("imports", update, "rowid=?", new String[]{String.valueOf(cursor.getLong(0))});
            }
        }
    }

    private static JSONObject symbolJson(Cursor cursor) throws Exception {
        return new JSONObject()
            .put("uri", cursor.getString(0)).put("path", path(cursor.getString(0)))
            .put("name", cursor.getString(1)).put("qualifiedName", cursor.getString(2))
            .put("symbolKind", cursor.getString(3))
            .put("range", new JSONObject()
                .put("start", new JSONObject().put("line", cursor.getInt(4)).put("character", cursor.getInt(5)))
                .put("end", new JSONObject().put("line", cursor.getInt(6)).put("character", cursor.getInt(7))));
    }

    private static String ftsQuery(String value) {
        StringBuilder result = new StringBuilder();
        for (String token : value.split("\\s+")) {
            String safe = token.replaceAll("[^\\p{L}\\p{N}_]", "");
            if (safe.isEmpty()) continue;
            if (result.length() > 0) result.append(" AND ");
            result.append('"').append(safe).append("*\"");
        }
        return result.toString();
    }

    private static String language(String path) {
        return path.toLowerCase(Locale.ROOT).matches(".*\\.pyi?$") ? "python" : "text";
    }

    private static boolean ignored(String path, List<Pattern> rules) {
        String normalized = "/" + path.replace('\\', '/') + "/";
        if (normalized.contains("/.git/") || normalized.contains("/.venv/")
            || normalized.contains("/venv/") || normalized.contains("/node_modules/")
            || normalized.contains("/__pycache__/") || path.equals(".env")
            || path.toLowerCase(Locale.ROOT).endsWith(".pem")
            || path.toLowerCase(Locale.ROOT).endsWith(".key")
            || new File(path).getName().toLowerCase(Locale.ROOT).startsWith("credentials")
            || new File(path).getName().toLowerCase(Locale.ROOT).startsWith("secrets")) return true;
        for (Pattern rule : rules) if (rule.matcher(path.replace('\\', '/')).matches()) return true;
        return false;
    }

    private static List<Pattern> loadIgnoreRules(
        WorkspaceRepository workspace,
        List<WorkspaceRepository.Summary> summaries
    ) {
        ArrayList<Pattern> result = new ArrayList<>();
        boolean present = false;
        for (WorkspaceRepository.Summary summary : summaries) {
            if (".pyaignore".equals(summary.path) && summary.editable) { present = true; break; }
        }
        if (!present) return result;
        try {
            for (String raw : workspace.read(".pyaignore").text().split("\\r?\\n")) {
                String value = raw.trim().replace('\\', '/');
                if (value.isEmpty() || value.startsWith("#") || value.startsWith("!")) continue;
                if (value.startsWith("./")) value = value.substring(2);
                if (value.endsWith("/")) value += "**";
                boolean anywhere = value.indexOf('/') < 0;
                StringBuilder regex = new StringBuilder(anywhere ? "^(?:.*/)?" : "^");
                for (int index = 0; index < value.length(); index += 1) {
                    char character = value.charAt(index);
                    if (character == '*') {
                        if (index + 1 < value.length() && value.charAt(index + 1) == '*') {
                            regex.append(".*"); index += 1;
                        } else regex.append("[^/]*");
                    } else {
                        if (".[]{}()+-^$|?\\".indexOf(character) >= 0) regex.append('\\');
                        regex.append(character);
                    }
                }
                regex.append('$');
                result.add(Pattern.compile(regex.toString(), Pattern.CASE_INSENSITIVE));
            }
        } catch (Exception ignored) {
            // A malformed optional ignore file must not make the index unusable.
        }
        return result;
    }

    private static String uri(String uriOrPath) {
        if (uriOrPath != null && uriOrPath.startsWith("file:///workspace/")) return uriOrPath;
        return "file:///workspace/" + path(uriOrPath);
    }

    private static String path(String uriOrPath) {
        String value = uriOrPath == null ? "" : uriOrPath;
        return value.startsWith("file:///workspace/")
            ? value.substring("file:///workspace/".length()) : value.replace('\\', '/');
    }

    private static String safeMessage(Throwable error) {
        String value = error == null ? null : error.getMessage();
        return value == null || value.isEmpty()
            ? (error == null ? "Unknown index error" : error.getClass().getSimpleName())
            : value;
    }

    private static final class Scope {
        final int indent;
        final String qualified;
        Scope(int indent, String qualified) { this.indent = indent; this.qualified = qualified; }
    }
}
