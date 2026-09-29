package com.pythona.app;

import android.content.Context;

import org.json.JSONException;
import org.json.JSONObject;

/** Safe bridge placeholder used until the isolated CPython service is bundled. */
public final class StubRuntimeService implements RuntimeService {
    private final Context context;

    public StubRuntimeService() {
        this(null);
    }

    public StubRuntimeService(Context context) {
        this.context = context == null ? null : context.getApplicationContext();
    }

    @Override
    public JSONObject capabilities() {
        JSONObject result = new JSONObject();
        try {
            result.put("protocolVersion", BridgeProtocol.VERSION);
            result.put("mode", "embedded-cpython");
            result.put("available", false);
            result.put("reason", context == null
                ? "runtime-context-unavailable"
                : "embedded-runtime-not-initialized");
            result.put("python", "CPython 3.14.7 unavailable");
            result.put("abi", "arm64-v8a");
            result.put("pytorch", "Unavailable");
            result.put("terminal", "managed-console-unavailable");
            result.put("features", new JSONObject()
                .put("execution", false)
                .put("language", false)
                .put("pty", false)
                .put("pip", false));
        } catch (JSONException ignored) {
        }
        return result;
    }

    @Override
    public JSONObject run(String runId, String command, String cwd, String file) {
        JSONObject result = new JSONObject();
        try {
            result.put("runId", runId);
            result.put("exitCode", 126);
            result.put("stderr", "Matching PythonA Runtime Pack is unavailable; command was not executed.\n" + command);
            result.put("unsupported", true);
            result.put("reason", capabilities().optString("reason", "runtime-unavailable"));
        } catch (JSONException ignored) {
        }
        return result;
    }

    @Override
    public void stop(String runId) {
        // No process exists in the stub.
    }
}
