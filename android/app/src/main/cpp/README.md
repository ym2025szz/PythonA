# PythonA embedded CPython/Jedi wiring

This directory embeds the official CPython 3.14.7 Android ARM64 prefix. It is
not a shell or PTY implementation. Each Android service process gets one
persistent interpreter, and user-code failure is contained by the existing
`:runtime` process boundary.

## Gradle/packaging contract

Configure the existing `android` block with ARM64 only and CMake:

```groovy
defaultConfig {
    ndk { abiFilters 'arm64-v8a' }
    externalNativeBuild.cmake.arguments(
        '-DPYTHONA_PYTHON_PREFIX=' + file('../../.runtime-cache/cpython/prefix'),
        '-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON')
}
externalNativeBuild.cmake { path 'src/main/cpp/CMakeLists.txt' }
```

The source checkout path is a build input, not an APK runtime path. A generated
JNI source directory must stage these files under `arm64-v8a/`:

- `prefix/lib/libpython3.14.so`
- `prefix/lib/lib*_python.so` (OpenSSL and SQLite dependencies)

A generated asset source directory must stage:

```text
assets/python/lib/python3.14/**              <- prefix/lib/python3.14/**
assets/python/lib/python3.14/site-packages/pythona_runtime_host.py
assets/python/lib/python3.14/site-packages/pythona_jedi_host.py
assets/python/lib/python3.14/site-packages/jedi/**
assets/python/lib/python3.14/site-packages/parso/**
assets/python/lib/python3.14/site-packages/*-info/**
```

Copy Jedi/Parso from `.runtime-cache/site-packages`. Exclude `__pycache__` and
`.pyc`. As in CPython's official Android testbed, rename every asset ending in
`.gz` to `.gz-` and every asset already ending in `-` to `--`; the installer
reverses this because AAPT otherwise transparently decompresses gzip files.

`PythonRuntimeInstaller.ensureInstalled()` uses an inter-process file lock,
bounded extraction, path validation, a staging sibling and completion marker.
Both service processes may call it concurrently. No runtime file is written
inside the source tree.

## Java service contract

Initialize once from `Service.onCreate`:

```java
PythonRuntimeInstaller.Layout layout =
    new PythonRuntimeInstaller(this).ensureInstalled();
PythonEngine engine = new PythonEngine(
    PythonEngine.Configuration.from(layout),
    new PythonEngine.Listener() {
        public void onOutput(String runId, String stream, String text) {
            // Forward a runtime event over the broker. Keep this non-blocking.
        }
        public void onInputRequested(String runId, String prompt) {
            // Show the console input row.
        }
    });
```

`runFile` is intentionally a blocking native call. Run it on a dedicated
single-thread `ExecutorService`, never on the Messenger/Binder request handler:

```java
PythonEngine.RunResult result = engine.runFile(
    runId, workspaceRoot, scriptFile, args);
```

The request handler remains free to call `sendInput(runId, text)` or
`stop(runId)` concurrently. `input()` waits on a native condition-variable
queue. Stop wakes that queue and schedules `KeyboardInterrupt`. Python bytecode
stops cooperatively; a native extension which never returns to Python may
require killing/restarting the `:runtime` process.

The `:language` service calls `engine.callJson(json)` only from its one Jedi
worker. Use `engine.cancelRequest(requestId)` from the control handler without
waiting for the worker lock. Jedi operations check cancellation between result
items; a single long Jedi internal call itself is not forcibly unwound. The JS
URI + epoch + bufferVersion gate still discards any late result.

Accepted language method names include both PythonA and LSP spellings:

- `openDocument` / `textDocument/didOpen`
- `changeDocument` / `textDocument/didChange`
- `closeDocument` / `textDocument/didClose`
- `complete`, `resolveCompletion`, `hover`, `signatureHelp`
- `definition`, `documentSymbols`, `diagnose`, `cancel`
- `completion`, `completionItem/resolve`, `documentSymbol`,
  `publishDiagnostics`, `$/cancelRequest`

`callJson` returns JSON containing `result` plus the request identity fields, or
`error` and `code`. `load_unsafe_extensions` is always false. Do not add runtime
pack paths to the language process' `sys.path`; this keeps NumPy/PyTorch native
extensions out of semantic analysis.

Android may kill and recreate only `:language`, which clears the Python host's
in-memory document table while the WebView still considers buffers open. A
semantic request or `didChange` self-heals only when that same request carries
an explicit URI, complete `text`, `epoch`, and `version`/`bufferVersion`.
Ranged-only changes and identity-incomplete requests still fail with
`document-not-open`; recovery therefore does not weaken stale-result gating.

## Lifecycle notes

- `PythonEngine.close()` detaches Java callbacks but deliberately does not call
  `Py_FinalizeEx`; Android destroys the dedicated process as the hard lifecycle
  boundary. Reinitializing CPython after finalization is not supported.
- `os._exit`, OOM and native crashes terminate only `:runtime`, not the editor
  or the independent `:language` process.
- stdout/stderr chunks and Java/Python strings are converted through UTF-16,
  preserving CJK and non-BMP emoji rather than relying on JNI modified UTF-8.
