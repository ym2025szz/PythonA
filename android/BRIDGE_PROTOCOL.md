# PythonA native bridge protocol v2

The WebView sends asynchronous JSON envelopes through `WebMessagePort` (with
`PythonABridge.postMessage` only as the asynchronous bootstrap fallback):

```json
{"protocolVersion":2,"id":"web-1","channel":"runtime","method":"capabilities","payload":{}}
```

Every direct response preserves `id`, `channel`, and `method`:

```json
{"protocolVersion":2,"id":"web-1","channel":"runtime","method":"capabilities","ok":true,"payload":{}}
```

Errors use `ok:false` and `error:{code,message,details?}`. Language responses
also echo `requestId`, `uri`, `epoch`, and `bufferVersion` when supplied.

Requests whose UTF-8 encoding exceeds 256 KiB do not cross Binder inline.
The activity atomically spools at most 16 MiB under app-private
`cache/ipc-spool`; Binder carries only the random file name, byte length,
SHA-256, request id, and channel. The service validates canonical containment,
size, digest, and enclosed identity, then deletes the file before dispatch.
Timeout, send failure, disconnect, and broker close also delete it.

## Channels and methods

- `workspace`: `list`, `read`, `write`, `delete`
- `workspace.applyBatch`: guarded all-or-nothing text changes. Entries may set
  `delete:true` with an existing revision/hash; results include `files` and
  `deleted` tombstones. File rename and undo use the same journal as patch commits.
- `dsh`: embedded official ACP lifecycle, model directory and `start/cancel`;
  `configureCredential` opens a native password dialog. Its WebView request contains
  no Key and its response reports only `saved/hasKey`. Compatibility profiles remain.
- `runtime`: `capabilities`, `runFile`, `sendInput`, `stop`, `listPackages`,
  `activatePack`
- `test`: `capabilities`, `discover`, `run`, `cancel`
- `language`: `didOpen`, `didChange`, `didSave`, `didClose`, `completion`,
  `completionItem/resolve`, `hover`, `signatureHelp`, `definition`,
  `references`, `rename`, `documentSymbol`, `diagnose`, `$/cancelRequest`
- `runtimePack`: `capabilities`, `install`, `pickAndInstall`, `rollback`
- `pythonPackage`: `capabilities`, `list`, `install`, `pickAndInstall`

`pythonPackage` accepts only Android `content://` selections whose filename,
ZIP central directory, `WHEEL`, `METADATA` and `RECORD` consistently describe
a `py3-none-any` or `py314-none-any` wheel. It rejects sdists, native/foreign
platform payloads and unsafe archive entries, installs into an app-private
versioned environment, then restarts both Runtime and Language services. It
does not download dependencies or execute pip.

`runtimePack.install` only authenticates, hashes, and stages an archive. It
never changes the active environment. Activation is explicit:

```json
{"packId":"org.pythona.scientific.arm64","buildId":"build-2026-09-19"}
```

The `runtime.activatePack` response reports `activation-pending-restart`.
The current `:runtime` process then restarts; before CPython initializes, it
re-verifies the stored Ed25519 signature and every payload hash, resolves exact
`packId@version` dependencies, preloads app-private ARM64 dependency libraries,
and runs imports declared by `capabilities.packages`. Only a passing probe
atomically replaces `active.json`. `active.json` remains unchanged while the
candidate is pending, so an exception, timeout, or process crash restores the
previous environment on the next service start. A response that says
`verified-staged` or `activation-pending-restart` is not an activation success.
Activation and rollback share the Runtime environment-change gate with script
admission, so neither can race a new `runFile`. After a commit, the Language
process reloads only fully verified active `stubs/` and `python/` trees; it does
not preload pack native libraries for completion.

Runtime `runFile` returns immediately with
`{accepted:true,started:true,runId}`. Execution output is delivered as
unsolicited events; user code never occupies the Messenger request worker.

`test.run` has the same admission shape (`{accepted:true,runId}`), but runs
inside the single Runtime execution gate. Test argv is always an array; shell
strings and pip/network installation are never accepted. `test.discover`
defaults to `tests/`, `test_*.py` and `*_test.py`. The Runtime reports the
locked pytest framework when available and otherwise reports unittest as the
active fallback. Completion events carry bounded JUnit-derived structured
cases and retain stdout/stderr as separate output events. A test task restores
workspace imports, `sys.path`, environment variables and working directory
before releasing the gate.

## Event envelope

```json
{"protocolVersion":2,"type":"event","channel":"runtime","event":{}}
```

Runtime event payloads are:

```text
{type:"stdout"|"stderr", runId, stream:"stdout"|"stderr", text}
{type:"input-request", runId, prompt}
{type:"finished", runId, exitCode, cancelled, durationMillis, error?}
{type:"service-crashed", state, message, recoverable:true}
{type:"service-reconnected", state, message, recoverable:true}
```

Official dsh emits `runtime-progress` with `phase/completed/total` while verifying,
extracting, validating and starting. Transport connection alone does not mean ACP is
initialized or the model directory is available. Each process generation owns its
requests, prompt terminal events and permission tokens; a retired reader cannot
finish a replacement process's requests. ACP cancellation is a notification.

Prompt events retain `streamId/requestId/sessionId/workspaceId/uri/epoch/bufferVersion`.
Permission events add `approvalId`; they do not overwrite the prompt request id.
Responses select only advertised one-time permission options. Late/duplicate decisions
are rejected. Process exit/timeout produces a terminal error; a requested cancel
produces a cancelled terminal event, with a two-second process watchdog.

The pinned official ACP package reports committed assistant messages. PythonA's
small `pythona-acp-stream.cjs` compatibility adapter projects its public
`session/event` → `assistant/chunk` text/reasoning deltas through ACP's existing
ordered output queue. A Node load hook checks the exact upstream module SHA-256
before adding that projection; the vendored package/rootfs stays unchanged.
Unknown package revisions fail closed until reviewed. Committed messages retain
their original tools, usage and lifecycle, while already-delivered text is
deduplicated. This is actual model-time delivery, with no simulated typing.

Presentation events are allowlisted and bounded:

```text
{kind:"delta"|"thought", text, messageId?, blockIndex?, truncated?}
{kind:"stream_reset", messageId, reason:"retry"|"reconcile"}
{kind:"scope", callId, title?, status?, toolKind?, locations?:[{path,line?}], text}
{kind:"usage", usage:{used,size,source:"official-acp",measurement:"context"}}
```

`stream_reset` retracts only the matching message segment, preserving previous
successful tool steps. Cancellation retains the delivered prefix. Text is bounded
to 64 KiB per wire event. `blockIndex`, when present, is the original provider
stream block identity, transported as `_meta.pythonaBlockIndex`; clients can render
different Markdown blocks separately without altering the text inside a block.
Tool metadata omits raw input/output and is redacted;
paths are workspace-relative with at most 32 locations. ACP v1 does not specify
the line base: an exact one-based `line` is exposed only when the source explicitly
reports `_meta.pythonaLineBase`; otherwise clients open the file without claiming
an exact source line. Tool/permission metadata never carries model tool arguments
or API keys. The actual official token-meter `used` and model capacity `size`
describe context occupancy, not billed input/output usage. Missing/invalid usage
is unknown rather than zero, and no percentage is invented.

### Independent inline completion

`dsh.inlineComplete` is a low-priority, one-shot code insertion request. It returns
`{accepted,completionId,capabilityVersion:1}` immediately. Its only terminal event
has `kind:"inlineCompletion"`, `status:"completed"|"cancelled"|"error"` and the
original `completionId/requestId/workspaceId/uri/epoch/bufferVersion/cursor/selection/
selectionVersion/modelSelectionVersion/generation`. Successful results contain
final validated `text`; errors contain an allowlisted `error.code`. These events
have no chat stream id and must not enter conversation rendering. `inlineCancel`
accepts only its `completionId`; it cannot cancel Runtime or Tests.

The private `pythona/inline_capabilities` ACP extension reports whether the actual
official LLM primitives are available. Native capability discovery probes it once
per connected process generation with a two-second deadline; missing methods,
unknown versions or failed probes advertise `inlineCompletion.officialAvailable:false`.
The optional inline module loads behind an exception boundary. An inline-only
hook/module failure preserves verified base ACP streaming and chat. The original
upstream-source integrity guard remains mandatory. A supported endpoint advertises
`inlineCompletion:{version:1,officialAvailable,compatibilityAvailable,available,...limits}`.
`available` is the union of the two independent routes. `compatibilityAvailable`
comes from the native HTTP/credential host and requires no official process startup
or probe. Clients use the explicitly selected route's capability; an unavailable
official route never switches implicitly to compatibility. Legacy version-1
payloads containing only `available:true` advertise the official route only.
Admission permits one request, at least 3 seconds apart, no more than 12 per minute.
The editor waits 800 ms after typing and never retries a rejected/failed snapshot
automatically. Failures impose a 30-second cooldown; authentication failures pause
until model/credential configuration changes. The deadline is 30 seconds. Chat
has priority and cancels outstanding inline work, including work still initializing.

Only an editable Python file in the current private default workspace is allowed.
`.pyaignore`, canonical containment and secret exclusions apply. The request has
at most 6 KiB before and 2 KiB after the cursor, no other files or chat history.
If redaction changes the cursor context, the request is skipped. `codeUpload:false`
disables inference. The model receives no tool schemas, Agent, MCP connection or
session. The pinned ACP adapter's `pythona/inline_complete` extension calls the
official `ctx.llm.stream` directly with the selected catalog route, at most 256
output tokens and the lowest known supported reasoning effort. An explicitly
selected compatibility profile uses the existing native HTTP client with one
attempt, separate deadlines and no tools; an official failure never falls back
to HTTP. Only final output passing the 8-line/2-KiB limits reaches the editor.
Keys remain in the native credential route.

Workspace MCP listens on a dynamically assigned IPv4 loopback port. Each PythonA DSH
turn receives a random, expiring token revoked at cancel/completion/restart. Tools
apply .pyaignore, sensitive-file exclusions, secret redaction, canonical containment,
UTF-8 result bounds and a 12-call limit. `request_run` waits for explicit approval
and the actual bounded runtime/test terminal result. `propose_patch` only emits a
Diff preview; it never writes. Its original file bytes are editor-only.

Workspace changes use channel `workspace` and payload:

```text
{type:"created"|"changed"|"deleted", path, revision, sha256, source}
```

The runtime capability intentionally advertises a Python Console rather than
Bash/PTTY, and reports PyTorch unavailable until a signed pack passes its
runtime validation gate.
