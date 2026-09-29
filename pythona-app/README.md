# PythonA

PythonA 0.4.0 is a landscape Android tablet IDE foundation. Its CodeMirror editor,
embedded official dsh ACP runtime, app-private workspace, project index, run configurations,
language service and managed Python Console share one versioned asynchronous protocol.

## Current slice

- Persistent workspace repository with atomic writes, revisions, hashes, import/export hooks, and file events.
- One document session shared by the editor, Diff view, and DSH transactions.
- CodeMirror 6 Python editor with syntax highlighting, completion, per-tab history, touch/IME support, search, folding and a unified Diff view.
- Android app-private workspace with atomic native revisions, asynchronous save/open, live file events, conflict detection and a browser-only fallback.
- Official dsh runs directly in PythonA without a separate DSHA app. The official
  credential entry uses an Android dialog; its secret never enters the WebView.
  Compatibility Provider adapters remain available under their own settings section.
- Streaming, workspace MCP tools, context manifests and approve/reject/undo remain
  available. A DSH run request waits for user approval and a terminal run result.
- Protocol-v2 WebMessagePort broker for workspace, Jedi/LSP and isolated Runtime requests, with cancellation and service-restart handling.
- Managed Python Console for script output and `input()`; it is explicitly not Bash or a PTY.
- Native-validated SAF import for `py3/py314-none-any` pure Python wheels; sdists,
  native extensions, online dependency resolution and arbitrary pip commands are excluded.
- Compact adaptive three-column shell, collapsible DSH rail, Project/Index/Search/
  Problems/Packages/Run tool windows, settings, theme switching, and distinct UI/code/DSH font tokens.
- Startup readiness follows actual Runtime capabilities, a native semantic response,
  and the official dsh model catalog. A transport connection alone is not readiness.
- Single-flight saves preserve edits typed during a write, dirty tab closing asks
  save/discard/cancel, and restored tabs retain their cursor positions.
- Project offers text-file creation, path rename, deletion and undo. Rename and
  undo are guarded atomic batches including tombstones; external changes reject
  the whole inverse. History is limited to 16 operations and 8 MiB per app session.
- Tests render in pages of 50 cases. Streaming text reuses existing rows, file event
  refreshes are coalesced by animation frame, and IME Enter does not submit prompts.

## Session diagnostics

Settings → About exposes a bounded numeric performance report with p50/p95/max
values. Android supports viewing/copying its JSON; browser preview also offers a
JSON download. No source, prompts, file paths or credentials enter this report.
WebView startup, resume frames, input-to-next-frame, model catalog, first token,
indexing, test discovery and run cancellation measurements are distinct from
native cold start, actual input latency, PSS, and a same-device 0.3 benchmark.
Missing samples mean an operation has not been measured, not a zero duration.

## Run locally

```powershell
cd <repository>\pythona-app
npm run build
npm test
npm run dev
```

`npm run build` creates `src/main.bundle.js`, so opening `index.html` directly
from a local file also works on browsers that block cross-file ES modules. Open
the printed local URL on a tablet or desktop browser for live development. The
Android host stages the generated runtime assets.

## Build the Android shell

The Android project is intentionally offline-buildable with the toolchain used
in this workspace:

```powershell
$env:JAVA_HOME='C:\path\to\jdk-17'
$env:ANDROID_HOME='C:\path\to\android-sdk'
& 'C:\path\to\gradle-8.5\bin\gradle.bat' --offline assembleDebug
```

The app is locked to landscape orientation and requires Android System WebView
93 or newer. Its WebView serves the generated
browser bundle from an app-local HTTPS origin; there is no network listener
and external requests are rejected.

Android packaging stages only `index.html`, `manifest.webmanifest`,
`src/main.bundle.js`, `src/styles.css`, and `assets/fonts/**`; source modules,
tests, and development tooling are not copied into the APK. The local artifact
`release/PythonA-0.3.0-release.apk`, when present, is a development-signed
installable build (not a Play Store production signing key).

## Runtime boundary

The browser fallback is deliberately not presented as CPython. On Android,
`window.PythonANative` carries protocol-v2 messages to isolated language and
runtime services. The UI trusts provider capabilities and never simulates
execution when CPython is unavailable. Pure Python wheels use the dedicated
`pythonPackage` broker and are integrity-checked before becoming importable;
they are not a native-library path or security sandbox. PyTorch remains marked “实验包不可用”
until a signed ARM64 CPU pack passes its acceptance gate. Native/desktop
wheels, CUDA, Bash and multiprocessing are not advertised.

## Next Android milestones

1. Complete CPython/Jedi device acceptance and crash-recovery soak tests.
2. Signed NumPy runtime pack plus wheel dependency resolution/uninstall UX.
3. Cross-compiled PyTorch ARM64 CPU experimental pack and validation gate.
4. Pyright, rename and references in a later editor release.
