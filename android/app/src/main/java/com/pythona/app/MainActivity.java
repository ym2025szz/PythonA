package com.pythona.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.net.Uri;
import android.view.View;
import android.view.Gravity;
import android.widget.TextView;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Log;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final String TAG = "PythonA.WebView";
    private static final int REQUEST_RUNTIME_PACK = 47021;
    private static final int REQUEST_PYTHON_WHEEL = 47022;
    // Flex gap, logical sizing and accent-color are part of the tablet UI.
    // WebView 93 is the first floor that supports the full stylesheet; the
    // JavaScript bundle remains transpiled more conservatively.
    private static final int MINIMUM_WEBVIEW_MAJOR = 93;
    /**
     * A real HTTPS origin is used for the bundled UI instead of file://.
     * Android WebView treats ES modules loaded from file:// as opaque origins
     * on some device WebView versions, which prevents main.js imports from
     * executing.  LocalOriginClient serves the exact same APK assets under
     * this origin without opening a network listener.
     */
    private static final String LOCAL_ORIGIN = "https://pythona.local";
    private WebView webView;
    private PythonABridge pythonABridge;
    private WebMessagePort nativeMessagePort;
    private WorkspaceFileWatcher workspaceFileWatcher;
    private PythonABridge.RuntimePackPickerCallback pendingRuntimePackPicker;
    private PythonABridge.PythonPackagePickerCallback pendingPythonPackagePicker;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(16, 19, 24));
        getWindow().setNavigationBarColor(Color.rgb(16, 19, 24));

        String webViewIssue = webViewCompatibilityIssue();
        if (webViewIssue != null) {
            showWebViewCompatibilityError(webViewIssue);
            return;
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(20, 23, 28));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setAllowFileAccessFromFileURLs(false);
        webView.getSettings().setAllowUniversalAccessFromFileURLs(false);
        webView.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.getSettings().setBuiltInZoomControls(false);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                // Console messages can contain Provider bodies or user secrets.
                // Keep diagnostics structural, never mirror arbitrary text into logcat.
                Log.d(TAG, "WebView console " + message.messageLevel() + " at line " + message.lineNumber());
                return true;
            }
        });
        webView.setWebViewClient(new LocalOnlyClient(this::setupNativeMessagePort));
        WorkspaceRepository workspace = null;
        try {
            workspace = new WorkspaceRepository(getFilesDir(), "default");
        } catch (IOException error) {
            Log.e(TAG, "Unable to initialize native workspace", error);
        }
        pythonABridge = new PythonABridge(
            this,
            webView,
            workspace,
            new StubRuntimeService(this),
            new PythonABridge.RuntimePackPicker() {
                @Override
                public boolean isAvailable() {
                    return !isFinishing() && !isDestroyed();
                }

                @Override
                public void pick(PythonABridge.RuntimePackPickerCallback callback) {
                    openRuntimePackPicker(callback);
                }
            },
            new PythonABridge.PythonPackagePicker() {
                @Override
                public boolean isAvailable() {
                    return !isFinishing() && !isDestroyed();
                }

                @Override
                public void pick(PythonABridge.PythonPackagePickerCallback callback) {
                    openPythonPackagePicker(callback);
                }
            });
        if (workspace != null) workspaceFileWatcher = new WorkspaceFileWatcher(workspace);
        webView.addJavascriptInterface(pythonABridge, "PythonABridge");
        setContentView(webView);
        webView.loadUrl(LOCAL_ORIGIN + "/index.html");
    }

    private String webViewCompatibilityIssue() {
        try {
            PackageInfo provider = WebView.getCurrentWebViewPackage();
            if (provider == null) return "未找到可用的 Android System WebView。";
            int major = parseWebViewMajor(provider.versionName);
            if (major < MINIMUM_WEBVIEW_MAJOR) {
                return "当前 Android System WebView 版本为 "
                    + String.valueOf(provider.versionName)
                    + "，PythonA 需要 WebView " + MINIMUM_WEBVIEW_MAJOR + " 或更高版本。";
            }
            return null;
        } catch (RuntimeException error) {
            return "无法初始化 Android System WebView：" + error.getMessage();
        }
    }

    static int parseWebViewMajor(String versionName) {
        if (versionName == null) return -1;
        int end = 0;
        while (end < versionName.length() && Character.isDigit(versionName.charAt(end))) {
            end += 1;
        }
        if (end == 0) return -1;
        try {
            return Integer.parseInt(versionName.substring(0, end));
        } catch (NumberFormatException error) {
            return -1;
        }
    }

    private void showWebViewCompatibilityError(String detail) {
        TextView message = new TextView(this);
        int padding = Math.round(32 * getResources().getDisplayMetrics().density);
        message.setPadding(padding, padding, padding, padding);
        message.setGravity(Gravity.CENTER);
        message.setTextColor(Color.rgb(217, 224, 232));
        message.setBackgroundColor(Color.rgb(20, 23, 28));
        message.setTextSize(17);
        message.setText("PythonA 无法启动\n\n" + detail
            + "\n\n请更新 Android System WebView 后重新打开 PythonA。"
            + "应用不会在不兼容的 WebView 中加载编辑器，以免出现白屏或数据损坏。");
        setContentView(message);
    }

    @Override
    protected void onDestroy() {
        PythonABridge.RuntimePackPickerCallback pendingPicker = pendingRuntimePackPicker;
        pendingRuntimePackPicker = null;
        if (pendingPicker != null) pendingPicker.onError("PythonA was closed before a file was selected");
        PythonABridge.PythonPackagePickerCallback pendingWheel = pendingPythonPackagePicker;
        pendingPythonPackagePicker = null;
        if (pendingWheel != null) {
            pendingWheel.onError("PythonA was closed before a wheel was selected");
        }
        if (webView != null) {
            webView.removeJavascriptInterface("PythonABridge");
            if (pythonABridge != null) pythonABridge.close();
            if (workspaceFileWatcher != null) workspaceFileWatcher.close();
            nativeMessagePort = null;
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }

    private void openRuntimePackPicker(PythonABridge.RuntimePackPickerCallback callback) {
        runOnUiThread(() -> {
            if (pendingRuntimePackPicker != null || pendingPythonPackagePicker != null) {
                callback.onError("Another Runtime Pack selection is already in progress");
                return;
            }
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                "application/octet-stream",
                "application/zip",
                "application/x-zip-compressed"
            });
            pendingRuntimePackPicker = callback;
            try {
                startActivityForResult(intent, REQUEST_RUNTIME_PACK);
            } catch (ActivityNotFoundException error) {
                pendingRuntimePackPicker = null;
                callback.onError("This Android device has no document picker");
            } catch (RuntimeException error) {
                pendingRuntimePackPicker = null;
                callback.onError(error.getMessage());
            }
        });
    }

    private void openPythonPackagePicker(PythonABridge.PythonPackagePickerCallback callback) {
        runOnUiThread(() -> {
            if (pendingRuntimePackPicker != null || pendingPythonPackagePicker != null) {
                callback.onError("Another package selection is already in progress");
                return;
            }
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                "application/vnd.python.wheel",
                "application/octet-stream",
                "application/zip",
                "application/x-zip-compressed"
            });
            pendingPythonPackagePicker = callback;
            try {
                startActivityForResult(intent, REQUEST_PYTHON_WHEEL);
            } catch (ActivityNotFoundException error) {
                pendingPythonPackagePicker = null;
                callback.onError("This Android device has no document picker");
            } catch (RuntimeException error) {
                pendingPythonPackagePicker = null;
                callback.onError(error.getMessage());
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_RUNTIME_PACK) {
            PythonABridge.RuntimePackPickerCallback callback = pendingRuntimePackPicker;
            pendingRuntimePackPicker = null;
            if (callback == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                callback.onCancelled();
                return;
            }
            Uri uri = data.getData();
            persistReadGrant(data, uri);
            callback.onPicked(uri.toString());
            return;
        }
        if (requestCode == REQUEST_PYTHON_WHEEL) {
            PythonABridge.PythonPackagePickerCallback callback = pendingPythonPackagePicker;
            pendingPythonPackagePicker = null;
            if (callback == null) return;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                callback.onCancelled();
                return;
            }
            Uri uri = data.getData();
            persistReadGrant(data, uri);
            callback.onPicked(uri.toString());
        }
    }

    private void persistReadGrant(Intent data, Uri uri) {
        int grantFlags = data.getFlags()
            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            if ((data.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) {
                getContentResolver().takePersistableUriPermission(
                    uri, grantFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
        } catch (RuntimeException ignored) {
            // The one-shot read grant remains valid while the selected file
            // is copied into app-private storage by the broker/runtime.
        }
    }

    private void setupNativeMessagePort() {
        if (webView == null || pythonABridge == null) return;
        final WebMessagePort[] ports = webView.createWebMessageChannel();
        nativeMessagePort = ports[0];
        nativeMessagePort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort port, WebMessage message) {
                if (pythonABridge != null && message != null) {
                    pythonABridge.postMessage(message.getData());
                }
            }
        });
        pythonABridge.attachMessagePort(nativeMessagePort);

        String bootstrap = "(()=>{"
            + "if(window.__PythonAPortBootstrap)return;window.__PythonAPortBootstrap=true;"
            + "window.PythonANative=window.PythonANative||{};"
            + "addEventListener('message',e=>{"
            + "if((e.origin&&e.origin!=='" + LOCAL_ORIGIN + "')||e.data!=='PythonA.port.v2'||!e.ports[0])return;"
            + "const p=e.ports[0];window.PythonANative.port=p;"
            + "p.onmessage=m=>{let v=m.data;try{if(typeof v==='string')v=JSON.parse(v)}catch(_){}"
            + "if(typeof window.PythonANative.onMessage==='function')window.PythonANative.onMessage(v);"
            + "dispatchEvent(new CustomEvent('pythona:native-message',{detail:v}))};"
            + "window.PythonANative.postMessage=r=>p.postMessage(typeof r==='string'?r:JSON.stringify(r));"
            + "p.start();dispatchEvent(new Event('pythona:native-ready'));});})();";
        webView.evaluateJavascript(bootstrap, ignored -> webView.postWebMessage(
            new WebMessage("PythonA.port.v2", new WebMessagePort[]{ports[1]}),
            Uri.parse(LOCAL_ORIGIN)));
    }

    private static final class LocalOnlyClient extends WebViewClient {
        private final Runnable pageReady;

        LocalOnlyClient(Runnable pageReady) {
            this.pageReady = pageReady;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (url != null && url.startsWith(LOCAL_ORIGIN + "/")) pageReady.run();
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            final String url = request.getUrl().toString();
            if (!url.startsWith(LOCAL_ORIGIN + "/")) {
                Log.w(TAG, "Blocked non-local request: " + url);
                return blockedResponse();
            }

            String path = request.getUrl().getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) path = "/index.html";
            try {
                path = URLDecoder.decode(path, StandardCharsets.UTF_8.name());
            } catch (Exception error) {
                Log.w(TAG, "Invalid asset path: " + path, error);
                return notFoundResponse();
            }
            // Never allow URL path traversal, even though all requests are local.
            if (path.contains("..") || path.contains("\\")) return notFoundResponse();
            String assetPath = path.substring(1);
            try {
                InputStream stream = view.getContext().getAssets().open(assetPath);
                String mimeType = mimeType(assetPath);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-cache");
                headers.put("Access-Control-Allow-Origin", LOCAL_ORIGIN);
                return new WebResourceResponse(mimeType, "UTF-8", 200, "OK", headers, stream);
            } catch (FileNotFoundException missing) {
                Log.w(TAG, "Asset not found: " + assetPath);
                return notFoundResponse();
            } catch (Exception error) {
                Log.e(TAG, "Unable to serve asset: " + assetPath, error);
                return new WebResourceResponse("text/plain", "UTF-8", 500, "Asset error", null, null);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !request.getUrl().toString().startsWith(LOCAL_ORIGIN + "/");
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            Log.e(TAG, "Resource error " + error.getErrorCode() + " for " + request.getUrl() + ": " + error.getDescription());
            super.onReceivedError(view, request, error);
        }

        private static WebResourceResponse blockedResponse() {
            return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", null, null);
        }

        private static WebResourceResponse notFoundResponse() {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, null);
        }

        private static String mimeType(String path) {
            String lower = path.toLowerCase(java.util.Locale.ROOT);
            if (lower.endsWith(".html")) return "text/html";
            if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
            if (lower.endsWith(".css")) return "text/css";
            if (lower.endsWith(".json") || lower.endsWith(".webmanifest")) return "application/json";
            if (lower.endsWith(".svg")) return "image/svg+xml";
            if (lower.endsWith(".png")) return "image/png";
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
            if (lower.endsWith(".woff")) return "font/woff";
            if (lower.endsWith(".woff2")) return "font/woff2";
            if (lower.endsWith(".ttf")) return "font/ttf";
            if (lower.endsWith(".otf")) return "font/otf";
            if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
            return "application/octet-stream";
        }
    }
}
