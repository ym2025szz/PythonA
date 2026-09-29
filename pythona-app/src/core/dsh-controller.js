import { createMultiFilePatch, createPatch } from './patch-engine.js';
import { redactSecrets } from './context-indexer.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function checkpointRevision(content) {
  const source = String(content);
  if (source.includes('save_checkpoint')) return source;
  if (source.includes('def train(')) {
    return source
      .replace('def train() -> None:\n', 'def train(start_epoch: int = 0) -> None:\n    # DSH: checkpoint resume path\n')
      .replace('    print("ready", model)\n', '    print("ready", model)\n    save_checkpoint(model, start_epoch)\n');
  }
  return source + '\n\n# DSH: checkpoint resume path\ndef save_checkpoint(model, epoch):\n    return {"epoch": epoch, "model": model}\n';
}

/** Browser-only deterministic preview. Android builds always use DshGateway. */
export class BrowserPreviewGateway {
  async *stream(request) {
    yield { type: 'scope', text: '浏览器预览模式；所有写入仍需事务确认' };
    yield { type: 'tool', text: '读取 ' + request.path };
    await wait(40);
    const after = checkpointRevision(request.content);
    const patch = createPatch(request.path, request.content, after, { title: '增加断点续训路径' });
    yield { type: 'hunk', index: 1, total: Math.max(1, patch.hunks.length), hunk: patch.hunks[0], patch, preview: after };
    yield { type: 'ready', patch, summary: '已生成可撤销补丁，等待确认' };
  }
  cancel() { return Promise.resolve({ cancelled: true }); }
}

function normalizedKind(event) {
  if (event.kind) return event.kind;
  if (event.type === 'tool') return 'tool_result';
  if (event.type === 'ready' || event.type === 'hunk') return 'patch_preview';
  return event.type;
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (error) { return {}; }
}

function safeToolPath(value) {
  const path = String(value || '').trim().replaceAll('\\', '/');
  if (!path || path.includes('\u0000') || path.startsWith('/')
      || /^[A-Za-z]:/.test(path)
      || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw Object.assign(new Error('DSH tool requested an unsafe workspace path'), {
      code: 'invalid-tool-arguments'
    });
  }
  return path;
}

function redactStructuredValue(value) {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value ?? null)).text);
  } catch (error) {
    return null;
  }
}

function toolSchemas() {
  return [
    { name: 'read_file', description: 'Read one UTF-8 workspace file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'search_workspace', description: 'Search file names, symbols and source text', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'list_symbols', description: 'List symbols declared by one file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'propose_patch', description: 'Propose complete replacement text for one or more files. This only creates a preview.', parameters: { type: 'object', properties: { title: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, afterText: { type: 'string' } }, required: ['path', 'afterText'] } } }, required: ['files'] } },
    { name: 'request_run', description: 'Request user approval to run a saved configuration', parameters: { type: 'object', properties: { configurationId: { type: 'string' } }, required: ['configurationId'] } }
  ];
}

export class DshAgentController {
  constructor({ store, document, gateway = new BrowserPreviewGateway(), projectIndex = null, contextIndexer = null, runtime = null, maxToolSteps = 12, timeoutMs = 120_000 }) {
    this.store = store;
    this.document = document;
    this.gateway = gateway;
    this.projectIndex = projectIndex;
    this.contextIndexer = contextIndexer;
    this.runtime = runtime;
    this.maxToolSteps = Math.max(1, Number(maxToolSteps) || 12);
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 120_000);
    this.listeners = new Set();
    this.abortController = null;
    this.activeStreamId = null;
    this.pending = null;
    this.pendingRun = null;
    this.lastTransaction = null;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { this.listeners.forEach((listener) => listener(event)); }

  isCurrentBase(transaction) {
    if (!transaction) return false;
    // A preview belongs to the exact editor focus in which it was created.
    // Switching tabs invalidates it even if every persisted file still has
    // the same revision; this keeps an approval card from acting on stale UI.
    if (transaction.activePath && this.document.path !== transaction.activePath) return false;
    const files = transaction.transaction?.files || transaction.files;
    if (Array.isArray(files)) {
      return files.every((file) => {
        let record;
        try { record = this.store.read(file.path); } catch (error) { return file.baseRevision === 0 && file.beforeText === ''; }
        const bufferMatches = this.document.path !== file.path
          || (this.document.buffer === file.beforeText && this.document.bufferVersion === file.bufferVersion && !this.document.conflict);
        return record.revision === file.baseRevision
          && record.content === file.beforeText
          && (!file.baseSha256 || (record.sha256 || record.hash) === file.baseSha256)
          && bufferMatches;
      });
    }
    const snapshot = this.document.snapshot();
    return snapshot.path === transaction.path
      && snapshot.buffer === transaction.before
      && snapshot.revision === transaction.baseRevision
      && snapshot.bufferVersion === transaction.baseBufferVersion
      && !snapshot.conflict;
  }

  discardStale(type, transaction, reason) {
    this.pending = null;
    if (this.document.preview) this.document.clearPreview();
    this.emit({ type, transaction, reason });
  }

  async start(prompt, options = {}) {
    if (!this.document.path) throw new Error('Open a file before asking DSH');
    this.cancel();
    const controller = new AbortController();
    this.abortController = controller;
    const initial = this.document.snapshot();
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      if (this.abortController === controller) this.abortController = null;
      throw new Error('A DSH prompt is required');
    }
    const deadline = Date.now() + this.timeoutMs;
    let context;
    try {
      if (this.contextIndexer) {
        context = await this.contextIndexer.build({
          path: initial.path,
          content: initial.buffer,
          selection: options.selection,
          attachedFiles: options.attachedFiles,
          provider: options.provider,
          model: options.model,
          uploadEnabled: options.uploadEnabled
        });
      } else {
        // Keep the safety boundary even for embedders that provide a custom
        // gateway without the optional indexer service.
        const safe = redactSecrets(initial.buffer);
        const bytes = new TextEncoder().encode(safe.text).length;
        context = {
          files: [{ path: initial.path, bytes, content: safe.text, redactions: safe.findings }],
          excluded: [],
          redactions: safe.findings.map((finding) => ({ path: initial.path, ...finding })),
          estimatedBytes: bytes
        };
      }
      if (context.uploadEnabled === false) throw new Error('Code upload is disabled in DSH privacy settings');
    } catch (error) {
      if (this.abortController === controller) this.abortController = null;
      throw error;
    }
    if (controller.signal.aborted || this.abortController !== controller) return;
    const safePrompt = redactSecrets(cleanPrompt);
    if (safePrompt.findings.length) {
      context = {
        ...context,
        promptRedactions: safePrompt.findings,
        redactions: [
          ...(context.redactions || []),
          ...safePrompt.findings.map((finding) => ({ path: '<prompt>', ...finding }))
        ]
      };
    }
    this.emit({ type: 'task-started', prompt: safePrompt.text, path: initial.path });
    this.emit({ type: 'context-manifest', context });

    const messages = [{ role: 'user', content: safePrompt.text }];
    let step = 0;
    try {
      while (!controller.signal.aborted) {
        if (Date.now() >= deadline) throw Object.assign(new Error('DSH task exceeded 120 seconds'), { code: 'dsh-timeout' });
        let nextTool = null;
        const request = {
          prompt: safePrompt.text,
          messages,
          path: initial.path,
          content: initial.buffer,
          revision: initial.revision,
          bufferVersion: initial.bufferVersion,
          epoch: Number(options.epoch ?? initial.bufferVersion ?? 0),
          uri: `file:///workspace/${initial.path}`,
           sessionId: options.sessionId || `dsh-${initial.bufferVersion}`,
           // The official bridge treats model/reasoning as a request snapshot:
           // changing the selector while a stream is active never mutates the
           // in-flight request. Compatibility providers simply ignore fields
           // they do not understand.
           provider: options.provider || null,
           model: options.model || null,
           reasoningLevel: options.reasoningLevel || null,
           officialMode: options.officialMode !== false,
           conversationId: options.conversationId,
           turnId: options.turnId,
           context: { trust: 'untrusted-workspace-context', files: context.files.map(({ path, content, bytes, redactions }) => ({ path, content, bytes, redactions })) },
          profileId: options.profileId,
          tools: toolSchemas(),
          toolChoice: 'auto',
          maxOutputTokens: options.maxOutputTokens
        };
        this.emit({ type:'stream-starting' });
        for await (const rawEvent of this.gateway.stream(request, { signal: controller.signal, timeoutMs: Math.max(1_000, deadline - Date.now()) })) {
          if (controller.signal.aborted || this.abortController !== controller) return;
          this.activeStreamId = rawEvent.streamId || this.activeStreamId;
          const kind = normalizedKind(rawEvent);
          const event = { ...rawEvent, kind };
          if (kind === 'tool_call') { nextTool = event; this.emit({ ...event, type: 'tool-call' }); continue; }
          if (rawEvent.type === 'ready' && rawEvent.patch) {
            if (!this.isCurrentBase({ path: initial.path, before: initial.buffer, baseRevision: initial.revision, baseBufferVersion: initial.bufferVersion })) {
              this.discardStale('task-stale', { path: initial.path, before: initial.buffer }, 'document-changed');
              return;
            }
            await this.acceptPatchPreview({ files: [{ path: rawEvent.patch.path, afterText: rawEvent.patch.after }], title: rawEvent.patch.title }, rawEvent.summary);
            continue;
          }
          if (rawEvent.type === 'hunk' && rawEvent.patch) {
            if (!this.isCurrentBase({ path: initial.path, before: initial.buffer, baseRevision: initial.revision, baseBufferVersion: initial.bufferVersion })) {
              this.discardStale('task-stale', { path: initial.path, before: initial.buffer }, 'document-changed');
              return;
            }
            this.document.setPreview(rawEvent.preview, { source: 'dsh', hunk: rawEvent.index, total: rawEvent.total });
            this.emit({ ...rawEvent, type: 'hunk-preview' });
            continue;
          }
          if (kind === 'patch_preview' && rawEvent.patch) {
            if (!this.isCurrentBase({ path: initial.path, before: initial.buffer, baseRevision: initial.revision, baseBufferVersion: initial.bufferVersion })) {
              this.discardStale('task-stale', { path: initial.path, before: initial.buffer }, 'document-changed');
              return;
            }
            await this.acceptPatchPreview(rawEvent.patch, rawEvent.summary);
            continue;
          }
          if (kind === 'delta' || kind === 'thought') this.emit({ ...event, type: kind, text: event.text || '' });
          else if (kind === 'scope') this.emit({ ...event, type: 'scope' });
          else if (kind === 'tool_result') this.emit({ ...event, type: rawEvent.type === 'tool' ? 'tool' : 'tool-result' });
          else if (kind === 'approval_required') this.emit({ ...event, type: 'approval-required' });
          else if (kind === 'usage') this.emit({ ...event, type: 'usage' });
          else if (kind === 'stream_reset') this.emit({ ...event, type: 'stream_reset' });
          else if (kind === 'error') throw Object.assign(new Error(event.message || 'DSH request failed'), { code: event.code || 'dsh-error' });
          else if (kind === 'done') this.emit({ ...event, type: 'done' });
          else this.emit(rawEvent);
        }
        if (!nextTool) break;
        step += 1;
        if (step > this.maxToolSteps) throw Object.assign(new Error('DSH exceeded the 12-step tool limit'), { code: 'tool-step-limit' });
        const toolResult = await this.executeTool(nextTool, deadline);
        const callId = nextTool.callId || nextTool.id || `tool-${step}`;
        messages.push({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: nextTool.name, arguments: JSON.stringify(parseArguments(nextTool.arguments)) } }] });
        messages.push({ role: 'tool', name: nextTool.name, tool_call_id: callId, content: JSON.stringify(toolResult) });
      }
    } catch (error) {
      if (!controller.signal.aborted && this.abortController === controller) this.emit({ type: 'task-error', error });
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
        this.activeStreamId = null;
        this.emit({ type: 'task-finished' });
      }
    }
  }

  boundToolResult(result) {
    const limit = 32 * 1024;
    const encoded = new TextEncoder().encode(JSON.stringify(result ?? null));
    if (encoded.length <= limit) return result;
    if (result && typeof result === 'object') {
      const bounded = { ...result, truncated: true };
      for (const key of ['content', 'output', 'text', 'preview']) {
        if (typeof bounded[key] !== 'string') continue;
        const bytes = new TextEncoder().encode(bounded[key]);
        bounded[key] = new TextDecoder().decode(bytes.slice(0, limit - 1024));
      }
      if (new TextEncoder().encode(JSON.stringify(bounded)).length <= limit) return bounded;
    }
    return { truncated: true, preview: new TextDecoder().decode(encoded.slice(0, limit - 128)) };
  }

  async executeTool(call, deadline = Date.now() + this.timeoutMs) {
    const name = String(call.name || call.tool || '');
    const args = parseArguments(call.arguments ?? call.input);
    let result;
    if (name === 'read_file') {
      const path = safeToolPath(args.path);
      const record = this.store.readAsync ? await this.store.readAsync(path) : this.store.read(path);
      const safe = redactSecrets(record.content);
      result = { path: record.path, content: safe.text, redactions: safe.findings, revision: record.revision, sha256: record.sha256 || record.hash };
    } else if (name === 'search_workspace') {
      const query = String(args.query || '').trim();
      if (!query) throw Object.assign(new Error('search_workspace requires a query'), { code: 'invalid-tool-arguments' });
      const matches = await this.projectIndex?.search?.(query) || this.fallbackSearch(query);
      result = { results: redactStructuredValue(matches) || [] };
    } else if (name === 'list_symbols') {
      const symbols = await this.projectIndex?.symbols?.(safeToolPath(args.path)) || [];
      result = { symbols: redactStructuredValue(symbols) || [] };
    } else if (name === 'propose_patch') {
      const transaction = await this.createTransaction(args.files, args.title);
      this.setPendingTransaction(transaction, args.title || 'Workspace changes');
      result = { transactionId: transaction.transactionId, files: transaction.files.map((file) => file.path), approvalRequired: true };
    } else if (name === 'request_run') {
      const configurationId = String(args.configurationId || '').trim();
      if (!configurationId) throw Object.assign(new Error('request_run requires a configurationId'), { code: 'invalid-tool-arguments' });
      const requestId = call.callId || call.id || `run-${Date.now().toString(36)}`;
      const remaining = Math.max(0, deadline - Date.now());
      result = !remaining ? { status: 'expired' } : await new Promise((resolve) => {
          const pending = { requestId, configurationId, resolve, timer: null };
          pending.timer = setTimeout(() => {
            if (this.pendingRun !== pending) return;
            this.pendingRun = null;
            resolve({ status: 'expired' });
            this.emit({ type: 'run-expired', approval: { requestId, configurationId: pending.configurationId } });
          }, remaining);
          this.pendingRun = pending;
          this.emit({ type: 'approval-required', kind: 'approval_required', action: 'run', requestId, configurationId: this.pendingRun.configurationId });
        });
    } else throw Object.assign(new Error(`Unsupported DSH tool: ${name}`), { code: 'unsupported-tool' });
    result = this.boundToolResult(result);
    this.emit({ type: 'tool-result', kind: 'tool_result', name, callId: call.callId || call.id, result });
    return result;
  }

  fallbackSearch(query) {
    const needle = String(query || '').toLocaleLowerCase();
    if (!needle) return [];
    const results = [];
    for (const file of this.store.listFiles()) {
      if (file.path.toLocaleLowerCase().includes(needle)) results.push({ kind: 'file', path: file.path });
      String(file.content || '').split('\n').forEach((text, line) => {
        if (results.length < 100 && text.toLocaleLowerCase().includes(needle)) {
          const safe = redactSecrets(text);
          results.push({ kind: 'text', path: file.path, line, text: safe.text, redactions: safe.findings });
        }
      });
    }
    return results;
  }

  async createTransaction(files, title = '') {
    if (!Array.isArray(files) || !files.length) throw new Error('propose_patch requires at least one file');
    this.document.assertClean?.(files.map(file => file.path));
    const entries = [];
    for (const proposal of files) {
      if (!proposal || typeof proposal !== 'object') throw new TypeError('Each patch file must be an object');
      let record = null;
      try { record = this.store.read(proposal.path); } catch (error) { /* new file */ }
      const active = this.document.path === proposal.path ? this.document.snapshot() : null;
      const hasBefore = Object.prototype.hasOwnProperty.call(proposal, 'beforeText')
        || Object.prototype.hasOwnProperty.call(proposal, 'before');
      const beforeText = hasBefore
        ? String(proposal.beforeText ?? proposal.before ?? '')
        : (active?.buffer ?? record?.content ?? '');
      const baseRevision = proposal.baseRevision == null
        ? (active?.revision ?? record?.revision ?? 0)
        : Number(proposal.baseRevision);
      const baseSha256 = String(proposal.baseSha256 ?? proposal.sha256
        ?? record?.sha256 ?? record?.hash ?? '');
      const bufferVersion = proposal.bufferVersion == null
        ? (active?.bufferVersion ?? null) : Number(proposal.bufferVersion);
      const afterText = String(proposal.afterText ?? proposal.after
        ?? proposal.content ?? proposal.preview ?? '');
      entries.push({ path: proposal.path, baseRevision, baseSha256, bufferVersion, beforeText, afterText });
    }
    return createMultiFilePatch(entries, { title });
  }

  setPendingTransaction(transaction, summary) {
    if (!this.isCurrentBase({ transaction })) throw Object.assign(new Error('Workspace changed while DSH created the patch'), { code: 'patch-stale' });
    const active = transaction.files.find((file) => file.path === this.document.path);
    if (active) this.document.setPreview(active.afterText, { source: 'dsh', transactionId: transaction.transactionId });
    this.pending = { transaction, files: transaction.files, transactionId: transaction.transactionId, activePath: this.document.path, path: active?.path || transaction.files[0].path, before: active?.beforeText ?? transaction.files[0].beforeText, after: active?.afterText ?? transaction.files[0].afterText, baseRevision: active?.baseRevision ?? transaction.files[0].baseRevision, baseBufferVersion: active?.bufferVersion ?? transaction.files[0].bufferVersion, patch: active?.patch || transaction.files[0].patch };
    this.emit({ type: 'task-ready', kind: 'patch_preview', transaction, patch: this.pending.patch, summary: summary || '已生成跨文件事务，等待确认' });
  }

  async acceptPatchPreview(patch, summary) {
    const files = Array.isArray(patch?.files)
      ? patch.files
      : (patch?.path ? [patch] : []);
    const transaction = await this.createTransaction(files, patch?.title || summary);
    this.setPendingTransaction(transaction, summary);
  }

  cancel() {
    this.abortController?.abort();
    this.abortController = null;
    if (this.activeStreamId) this.gateway.cancel?.(this.activeStreamId).catch?.(() => {});
    this.activeStreamId = null;
    if (this.document.preview) this.document.clearPreview();
    this.pending = null;
    if (this.pendingRun) {
      if (this.pendingRun.timer) clearTimeout(this.pendingRun.timer);
      this.pendingRun.resolve({ status: 'cancelled' });
      this.pendingRun = null;
    }
  }

  accept() {
    if (this.store.nativeAuthoritative) throw new Error('Use acceptAsync for native atomic transactions');
    if (!this.pending) throw new Error('There is no DSH patch to accept');
    if (!this.isCurrentBase(this.pending)) { const stale = this.pending; this.discardStale('patch-stale', stale, 'document-changed'); throw new Error('The workspace changed after this DSH patch was generated'); }
    const transaction = { ...this.pending, acceptedAt: Date.now() };
    if (transaction.files?.length > 1) throw new Error('Use acceptAsync for multi-file transactions');
    this.document.applyContent(transaction.after, 'dsh');
    this.document.save('dsh');
    this.document.clearPreview();
    transaction.appliedRevision = this.document.revision;
    transaction.appliedBufferVersion = this.document.bufferVersion;
    this.lastTransaction = transaction;
    this.pending = null;
    this.emit({ type: 'patch-accepted', transaction });
    return transaction;
  }

  async acceptAsync() {
    if (this.applyingTransaction) throw new Error('A patch transaction is already being applied');
    if (!this.pending) throw new Error('There is no DSH patch to accept');
    this.document.assertClean?.(this.pending.files?.map(file => file.path) || [this.pending.path]);
    if (!this.isCurrentBase(this.pending)) { const stale = this.pending; this.discardStale('patch-stale', stale, 'document-changed'); throw new Error('The workspace changed after this DSH patch was generated'); }
    const transaction = { ...this.pending, acceptedAt: Date.now() };
    this.applyingTransaction = true;
    try {
    let result;
    if (typeof this.store.applyBatchAsync === 'function' && (!this.store.nativeAuthoritative || typeof this.store.nativeClient?.applyBatch === 'function')) {
      result = await this.store.applyBatchAsync(transaction.transaction, { source: 'dsh' });
      if (this.document.preview) this.document.clearPreview();
      if (transaction.files.some((file) => file.path === this.document.path)) await this.document.openAsync(this.document.path);
      const active = this.document.snapshot();
      transaction.appliedRevision = active.revision;
      transaction.appliedBufferVersion = active.bufferVersion;
      transaction.appliedRecords = result.files;
    } else {
      this.document.applyContent(transaction.after, 'dsh');
      await this.document.saveAsync('dsh');
      this.document.clearPreview();
      transaction.appliedRevision = this.document.revision;
      transaction.appliedBufferVersion = this.document.bufferVersion;
    }
    this.lastTransaction = transaction;
    this.pending = null;
    this.emit({ type: 'patch-accepted', transaction, result });
    return transaction;
    } finally { this.applyingTransaction = false; }
  }

  async acceptPatch(transactionId) {
    if (!this.pending || this.pending.transactionId !== transactionId) {
      throw new Error('Patch approval is stale');
    }
    return this.acceptAsync();
  }

  reject() {
    if (!this.pending) return;
    const transaction = this.pending;
    this.pending = null;
    this.document.clearPreview();
    this.emit({ type: 'patch-rejected', transaction });
  }

  rejectPatch(transactionId) {
    if (!this.pending || this.pending.transactionId !== transactionId) return false;
    this.reject();
    return true;
  }

  async approveRun(requestId) {
    if (!this.pendingRun || this.pendingRun.requestId !== requestId) throw new Error('Run approval is stale');
    const approval = this.pendingRun;
    this.pendingRun = null;
    if (approval.timer) clearTimeout(approval.timer);
    try {
      const result = await this.runtime?.runConfiguration?.(approval.configurationId);
      let safeResult = result ?? null;
      try {
        safeResult = JSON.parse(redactSecrets(JSON.stringify(safeResult)).text);
      } catch (error) {
        safeResult = { status: 'completed' };
      }
      const serialized = JSON.stringify(safeResult);
      const encoded = new TextEncoder().encode(serialized);
      const bounded = encoded.length <= 32 * 1024
        ? safeResult
        : { truncated: true, output: new TextDecoder().decode(encoded.slice(0, 32 * 1024 - 256)) };
      let toolResult = { status: 'completed', result: bounded };
      // Keep the complete tool-result JSON below the protocol limit, not just
      // the raw stdout field (wrapper keys and UTF-8 expansion also count).
      while (new TextEncoder().encode(JSON.stringify(toolResult)).length > 32 * 1024
          && typeof toolResult.result?.output === 'string') {
        toolResult.result.output = toolResult.result.output.slice(0, -256);
      }
      approval.resolve(toolResult);
      this.emit({ type: 'run-approved', approval: { requestId: approval.requestId, configurationId: approval.configurationId }, result: bounded });
      return bounded;
    } catch (error) {
      const safeError = redactSecrets(String(error?.message || error)).text.slice(0, 8 * 1024);
      approval.resolve({ status: 'failed', error: safeError });
      this.emit({
        type: 'run-failed',
        approval: { requestId: approval.requestId, configurationId: approval.configurationId },
        error: Object.assign(new Error(safeError), { code: error?.code || 'run-failed' })
      });
      throw Object.assign(new Error(safeError), { code: error?.code || 'run-failed' });
    }
  }

  denyRun(requestId) {
    if (!this.pendingRun || this.pendingRun.requestId !== requestId) return false;
    const approval = this.pendingRun;
    this.pendingRun = null;
    if (approval.timer) clearTimeout(approval.timer);
    approval.resolve({ status: 'denied' });
    this.emit({ type: 'run-denied', approval: { requestId: approval.requestId, configurationId: approval.configurationId } });
    return true;
  }

  undoLast() {
    if (!this.lastTransaction || this.lastTransaction.files?.length > 1) return false;
    const transaction = this.lastTransaction;
    const snapshot = this.document.snapshot();
    const safe = snapshot.path === transaction.path && snapshot.buffer === transaction.after && snapshot.revision === transaction.appliedRevision && snapshot.bufferVersion === transaction.appliedBufferVersion && !snapshot.conflict;
    if (!safe) { this.emit({ type: 'undo-blocked', transaction, reason: 'document-changed' }); return false; }
    this.document.applyContent(transaction.before, 'dsh-undo');
    this.document.save('dsh-undo');
    this.lastTransaction = null;
    this.emit({ type: 'patch-undone', transaction });
    return true;
  }

  async undoLastAsync() {
    if (!this.lastTransaction) return false;
    const transaction = this.lastTransaction;
    if (!transaction.files || transaction.files.length === 1 && !transaction.appliedRecords) {
      const snapshot = this.document.snapshot();
      const safe = snapshot.path === transaction.path && snapshot.buffer === transaction.after && snapshot.revision === transaction.appliedRevision && snapshot.bufferVersion === transaction.appliedBufferVersion && !snapshot.conflict;
      if (!safe) { this.emit({ type: 'undo-blocked', transaction, reason: 'document-changed' }); return false; }
      this.document.applyContent(transaction.before, 'dsh-undo');
      await this.document.saveAsync('dsh-undo');
    } else {
      const reverseFiles = [];
      for (const file of transaction.files) {
        const current = this.store.read(file.path);
        if (current.content !== file.afterText) { this.emit({ type: 'undo-blocked', transaction, reason: 'document-changed' }); return false; }
        reverseFiles.push({ path: file.path, beforeText: current.content, afterText: file.beforeText, baseRevision: current.revision, baseSha256: current.sha256 || current.hash, bufferVersion: this.document.path === file.path ? this.document.bufferVersion : null });
      }
      const reverse = createMultiFilePatch(reverseFiles, { title: `Undo ${transaction.transaction.title}` });
      await this.store.applyBatchAsync(reverse, { source: 'dsh-undo' });
      if (transaction.files.some((file) => file.path === this.document.path)) await this.document.openAsync(this.document.path);
    }
    this.lastTransaction = null;
    this.emit({ type: 'patch-undone', transaction });
    return true;
  }
}

// Compatibility name retained for extensions built against PythonA 0.2.
export class DshController extends DshAgentController {}
