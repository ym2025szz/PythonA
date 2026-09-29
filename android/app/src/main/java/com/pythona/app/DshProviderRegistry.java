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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/** Persistent provider profiles. Secret values live only in DshCredentialStore. */
final class DshProviderRegistry {
    static final String OPENAI_COMPATIBLE = "openai-compatible";
    static final String OPENAI = "openai";
    static final String ANTHROPIC = "anthropic";
    static final String GEMINI = "gemini";
    static final String QWEN = "qwen";
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private static final int MAX_FILE_BYTES = 1024 * 1024;

    private final File root;
    private final File profilesFile;
    private final DshCredentialStore credentials;
    private final Map<String, JSONObject> profiles = new LinkedHashMap<>();

    DshProviderRegistry(Context context, DshCredentialStore credentials) throws Exception {
        root = new File(context.getNoBackupFilesDir(), "dsh").getCanonicalFile();
        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) {
            throw new IOException("Unable to create DSH profile storage");
        }
        profilesFile = new File(root, "profiles.json");
        this.credentials = credentials;
        load();
    }

    synchronized JSONArray providers() throws Exception {
        return new JSONArray()
            .put(provider(OPENAI_COMPATIBLE, "OpenAI-compatible", "", ""))
            .put(provider(OPENAI, "OpenAI", "https://api.openai.com/v1", "gpt-5-mini"))
            .put(provider(ANTHROPIC, "Anthropic", "https://api.anthropic.com/v1", "claude-sonnet-4-5"))
            .put(provider(GEMINI, "Gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini-2.5-flash"))
            .put(provider(QWEN, "Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"));
    }

    synchronized JSONArray publicProfiles() throws Exception {
        JSONArray result = new JSONArray();
        for (JSONObject profile : profiles.values()) result.put(publicProfile(profile));
        return result;
    }

    synchronized JSONObject profile(String profileId) throws Exception {
        JSONObject profile = profiles.get(requireId(profileId));
        if (profile == null) throw new IllegalArgumentException("Unknown DSH profile");
        return new JSONObject(profile.toString());
    }

    synchronized JSONObject enabledProfile(String requestedId) throws Exception {
        if (requestedId != null && !requestedId.trim().isEmpty()) return profile(requestedId);
        for (JSONObject profile : profiles.values()) {
            if (profile.optBoolean("enabled", false)) return new JSONObject(profile.toString());
        }
        throw new IllegalStateException("No enabled DSH provider profile");
    }

    synchronized JSONObject save(JSONObject requested, String secret) throws Exception {
        JSONObject normalized = normalize(requested);
        String profileId = normalized.getString("profileId");
        JSONObject previous = profiles.get(profileId);
        if (previous != null && !requested.has("headers")) {
            normalized.put("headers", previous.optJSONObject("headers") == null
                ? new JSONObject() : previous.optJSONObject("headers"));
        }
        String previousRef = previous == null ? "" : previous.optString("keyRef", "");
        String keyRef = previousRef;
        String rotatedRef = "";
        if (secret != null && !secret.isEmpty()) {
            rotatedRef = credentials.put(previousRef, secret);
            keyRef = rotatedRef;
        }
        normalized.put("keyRef", keyRef);
        profiles.put(profileId, normalized);
        try {
            persist();
        } catch (Exception failure) {
            if (previous == null) profiles.remove(profileId);
            else profiles.put(profileId, previous);
            if (!rotatedRef.isEmpty()) {
                try { credentials.delete(rotatedRef); } catch (Exception cleanup) {
                    failure.addSuppressed(cleanup);
                }
            }
            throw failure;
        }
        if (!rotatedRef.isEmpty() && !previousRef.isEmpty()
            && !rotatedRef.equals(previousRef)) {
            // The active profile now points at the replacement. If a
            // filesystem failure prevents immediate scrubbing, the next DSH
            // service start retries cleanup of this unreferenced ciphertext.
            try { credentials.delete(previousRef); } catch (Exception ignored) { }
        }
        return publicProfile(normalized);
    }

    synchronized boolean delete(String profileId) throws Exception {
        JSONObject removed = profiles.remove(requireId(profileId));
        if (removed == null) return false;
        persist();
        credentials.delete(removed.optString("keyRef", ""));
        return true;
    }

    synchronized char[] secret(JSONObject profile) throws Exception {
        String keyRef = profile.optString("keyRef", "");
        if (keyRef.isEmpty()) throw new IllegalStateException("This profile has no API key");
        return credentials.get(keyRef);
    }

    private void load() throws Exception {
        profiles.clear();
        if (!profilesFile.isFile()) {
            credentials.deleteUnreferenced(java.util.Collections.emptySet());
            return;
        }
        if (profilesFile.length() > MAX_FILE_BYTES) throw new IOException("DSH profile file is too large");
        byte[] bytes;
        try (FileInputStream input = new FileInputStream(profilesFile)) {
            bytes = new byte[(int) profilesFile.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int read = input.read(bytes, offset, bytes.length - offset);
                if (read < 0) throw new IOException("Truncated DSH profile file");
                offset += read;
            }
        }
        JSONArray stored = new JSONArray(new String(bytes, StandardCharsets.UTF_8));
        for (int index = 0; index < stored.length(); index += 1) {
            JSONObject profile = normalize(stored.getJSONObject(index));
            String storedRef = stored.getJSONObject(index).optString("keyRef", "");
            profile.put("keyRef", storedRef.isEmpty() ? "" : requireKeyRef(storedRef));
            profiles.put(profile.getString("profileId"), profile);
        }
        java.util.Set<String> referenced = new java.util.HashSet<>();
        for (JSONObject profile : profiles.values()) {
            String keyRef = profile.optString("keyRef", "");
            if (!keyRef.isEmpty()) referenced.add(keyRef);
        }
        credentials.deleteUnreferenced(referenced);
    }

    private void persist() throws Exception {
        JSONArray serialized = new JSONArray();
        for (JSONObject profile : profiles.values()) serialized.put(profile);
        byte[] bytes = serialized.toString().getBytes(StandardCharsets.UTF_8);
        File temporary = new File(root, "profiles-" + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.flush();
                output.getFD().sync();
            }
            Files.move(temporary.toPath(), profilesFile.toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            if (temporary.exists() && !temporary.delete()) temporary.deleteOnExit();
        }
    }

    private static JSONObject normalize(JSONObject input) throws Exception {
        if (input == null) throw new IllegalArgumentException("Provider profile is required");
        String kind = input.optString("providerKind", OPENAI_COMPATIBLE).trim();
        if (!List.of(OPENAI_COMPATIBLE, OPENAI, ANTHROPIC, GEMINI, QWEN).contains(kind)) {
            throw new IllegalArgumentException("Unsupported provider kind");
        }
        String profileId = input.optString("profileId", "").trim();
        if (profileId.isEmpty()) profileId = "profile-" + UUID.randomUUID();
        requireId(profileId);
        String baseUrl = input.optString("baseUrl", defaults(kind, "baseUrl")).trim();
        String model = input.optString("model", defaults(kind, "model")).trim();
        if (baseUrl.isEmpty()) throw new IllegalArgumentException("Provider baseUrl is required");
        if (model.isEmpty() || model.length() > 256) throw new IllegalArgumentException("Provider model is required");
        return new JSONObject()
            .put("profileId", profileId)
            .put("displayName", bounded(input.optString("displayName", kind), 128))
            .put("providerKind", kind)
            .put("runtimeMode", input.optString("runtimeMode", "deepseek"))
            .put("baseUrl", baseUrl)
            .put("apiVersion", bounded(input.optString("apiVersion", ""), 64))
            .put("model", model)
            .put("contextWindow", boundedLong(input.optLong("contextWindow", 128_000), 1_024, 10_000_000))
            .put("maxOutputTokens", boundedLong(input.optLong("maxOutputTokens", 4_096), 1, 1_000_000))
            .put("temperature", Math.max(0.0, Math.min(2.0, input.optDouble("temperature", 0.2))))
            .put("supportsTools", input.optBoolean("supportsTools", true))
            .put("supportsStreaming", input.optBoolean("supportsStreaming", true))
            .put("keyRef", requireKeyRef(input.optString("keyRef", "")))
            .put("enabled", input.optBoolean("enabled", true))
            .put("allowLocalEndpoint", input.optBoolean("allowLocalEndpoint", false))
            .put("headers", sanitizeHeaders(input.optJSONObject("headers")));
    }

    private static JSONObject publicProfile(JSONObject profile) throws Exception {
        JSONObject result = new JSONObject(profile.toString());
        String keyRef = result.optString("keyRef", "");
        result.remove("keyRef");
        result.put("hasKey", !keyRef.isEmpty());
        JSONObject headers = result.optJSONObject("headers");
        if (headers != null) {
            JSONObject safe = new JSONObject();
            java.util.Iterator<String> keys = headers.keys();
            while (keys.hasNext()) safe.put(keys.next(), "configured");
            result.put("headers", safe);
        }
        return result;
    }

    private static JSONObject sanitizeHeaders(JSONObject source) throws Exception {
        JSONObject result = new JSONObject();
        if (source == null) return result;
        java.util.Iterator<String> keys = source.keys();
        int count = 0;
        while (keys.hasNext()) {
            String name = keys.next();
            if (++count > 32 || !name.matches("[A-Za-z0-9-]{1,64}")) {
                throw new IllegalArgumentException("Invalid custom provider header");
            }
            String lower = name.toLowerCase(java.util.Locale.ROOT);
            if (lower.equals("authorization") || lower.equals("proxy-authorization")
                || lower.equals("x-api-key") || lower.equals("x-goog-api-key")
                || lower.equals("cookie") || lower.contains("secret")
                || lower.contains("token") || lower.contains("password")) {
                throw new IllegalArgumentException("Credential-bearing headers must use the API key field");
            }
            String value = bounded(source.optString(name, ""), 4_096);
            if (value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0 || value.indexOf('\0') >= 0) {
                throw new IllegalArgumentException("Invalid custom provider header value");
            }
            result.put(name, value);
        }
        return result;
    }

    private static JSONObject provider(String kind, String name, String baseUrl, String model)
        throws Exception {
        return new JSONObject()
            .put("providerKind", kind).put("displayName", name)
            .put("defaultBaseUrl", baseUrl).put("defaultModel", model)
            .put("supportsTools", true).put("supportsStreaming", true);
    }

    private static String defaults(String kind, String field) {
        if (OPENAI.equals(kind)) return "baseUrl".equals(field) ? "https://api.openai.com/v1" : "gpt-5-mini";
        if (ANTHROPIC.equals(kind)) return "baseUrl".equals(field) ? "https://api.anthropic.com/v1" : "claude-sonnet-4-5";
        if (GEMINI.equals(kind)) return "baseUrl".equals(field) ? "https://generativelanguage.googleapis.com/v1beta" : "gemini-2.5-flash";
        if (QWEN.equals(kind)) return "baseUrl".equals(field) ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "qwen-plus";
        return "";
    }

    private static String requireId(String value) {
        String id = value == null ? "" : value.trim();
        if (!SAFE_ID.matcher(id).matches()) throw new IllegalArgumentException("Invalid profile id");
        return id;
    }

    private static String requireKeyRef(String value) {
        String ref = value == null ? "" : value.trim();
        if (ref.isEmpty()) return "";
        if (!ref.matches("key-[A-Za-z0-9-]{8,80}")) {
            throw new IllegalArgumentException("Invalid credential reference");
        }
        return ref;
    }

    private static String bounded(String value, int maximum) {
        String result = value == null ? "" : value.trim();
        if (result.length() > maximum) throw new IllegalArgumentException("Provider field is too long");
        return result;
    }

    private static long boundedLong(long value, long minimum, long maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }
}
