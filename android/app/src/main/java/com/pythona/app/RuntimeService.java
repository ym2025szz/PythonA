package com.pythona.app;

import org.json.JSONObject;

/**
 * Native runtime seam. A future CPython/proot service implements this contract;
 * the WebView never gets direct filesystem or process access.
 */
public interface RuntimeService {
    JSONObject capabilities();

    JSONObject run(String runId, String command, String cwd, String file);

    void stop(String runId);
}
