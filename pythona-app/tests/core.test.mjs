import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore, RevisionConflictError, hashText } from '../src/core/workspace-store.js';
import { DocumentSession } from '../src/core/document-session.js';
import { createPatch, diffLines } from '../src/core/patch-engine.js';
import { DshController } from '../src/core/dsh-controller.js';
import {
  NativePythonPackageClient,
  NativeRuntimePackClient,
  RuntimeAdapter
} from '../src/core/runtime-adapter.js';
import { NativeBroker, NativeWorkspaceClient } from '../src/core/native-broker.js';
import {
  BridgeLanguageProvider,
  ContentModifiedError,
  LanguageService,
  LocalLanguageProvider,
  applyContentChanges,
  toDocumentUri
} from '../src/core/language-service.js';
import { createSemanticCompletionSource, createWorkspaceCompletionSource } from '../src/editor/python-completions.js';
import {
  changedEditorSettings,
  completionTabBinding,
  editorSearchShortcuts,
  normalizeEditorSettings
} from '../src/editor/editor-adapter.js';
import { EditorCoordinator } from '../src/editor/editor-coordinator.js';
import { classifyPythonHighlightTokens } from '../src/editor/python-highlighting.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, value); }
}

function makeStore() {
  return new WorkspaceStore({ storage: new MemoryStorage(), files: { 'src/train.py': 'print("ready")\n', 'README.md': '# demo\n' } });
}

class FakeNativeWorkspace {
  constructor(files = {}) {
    this.available = true;
    this.records = new Map();
    this.listeners = new Set();
    this.tombstones = new Map();
    Object.entries(files).forEach(([path, content]) => this.records.set(path, {
      path, content, revision: 1, sha256: 'sha-' + hashText(content), updatedAt: Date.now()
    }));
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async list() {
    return {
      files: [...this.records.values()].map(({ content, ...summary }) => summary),
      tombstones: [...this.tombstones].map(([path, revision]) => ({ path, revision }))
    };
  }
  async read(path) {
    const record = this.records.get(path);
    if (!record) throw Object.assign(new Error('missing'), { code: 'workspace-io-error' });
    return { ...record };
  }
  async write(path, content, options = {}) {
    const previous = this.records.get(path);
    const actual = previous?.revision ?? this.tombstones.get(path) ?? 0;
    if (options.expectedRevision != null && options.expectedRevision !== actual) {
      throw Object.assign(new Error('conflict'), {
        code: 'revision-conflict', details: { path, actualRevision: actual }
      });
    }
    const record = {
      path, content, revision: actual + 1, sha256: 'sha-' + hashText(content), updatedAt: Date.now()
    };
    this.records.set(path, record);
    this.tombstones.delete(path);
    queueMicrotask(() => this.listeners.forEach((listener) => listener({
      type: previous ? 'changed' : 'created', path, revision: record.revision,
      sha256: record.sha256, source: options.source || 'webview'
    })));
    return { ...record };
  }
  async delete(path, options = {}) {
    const previous = this.records.get(path);
    const actual = previous?.revision ?? this.tombstones.get(path) ?? 0;
    if (options.expectedRevision != null && options.expectedRevision !== actual) {
      throw Object.assign(new Error('conflict'), {
        code: 'revision-conflict', details: { path, actualRevision: actual }
      });
    }
    const revision = actual + 1;
    this.records.delete(path);
    this.tombstones.set(path, revision);
    queueMicrotask(() => this.listeners.forEach((listener) => listener({
      type: 'deleted', path, revision, source: options.source || 'webview'
    })));
    return { deleted: Boolean(previous), path, revision };
  }
  async externalWrite(path, content) {
    const record = await this.write(path, content, { expectedRevision: this.records.get(path)?.revision || 0, source: 'runtime' });
    await new Promise((resolve) => setImmediate(resolve));
    return record;
  }
}

test('native broker emits protocol-v2 envelopes, cancellation and one workspace event', async () => {
  const sent = [];
  const native = {
    postMessage(raw) {
      const request = JSON.parse(raw);
      sent.push(request);
      if (request.method === '$/cancelRequest' || request.method === 'wait') return;
      if (request.method === 'crash') {
        queueMicrotask(() => native.onMessage({
          protocolVersion: 2, id: request.id, channel: request.channel,
          method: request.method, ok: false,
          error: { code: 'service-disconnected', message: 'service restarted' }
        }));
        return;
      }
      queueMicrotask(() => native.onMessage({
        protocolVersion: 2, id: request.id, channel: request.channel,
        method: request.method, ok: true, payload: { echoed: request.payload }
      }));
    }
  };
  const broker = new NativeBroker({ nativeObject: native, timeoutMs: 1000 });
  const events = [];
  const statuses = [];
  broker.subscribe('workspace', (event) => events.push(event));
  broker.subscribeStatus((event) => statuses.push(event.type));
  const response = await broker.request('workspace', 'read', { path: 'src/main.py' });
  assert.equal(response.echoed.path, 'src/main.py');
  assert.deepEqual(Object.keys(sent[0]).sort(), [
    'channel', 'id', 'method', 'payload', 'protocolVersion', 'transportTimeoutMs'
  ]);
  assert.equal(sent[0].transportTimeoutMs, 1000);
  await broker.request('workspace', 'read', { path: 'slow-start.py' }, { timeoutMs: 120_000 });
  assert.equal(sent.at(-1).transportTimeoutMs, 120_000);
  native.onMessage({ protocolVersion: 2, type: 'event', channel: 'workspace', event: { type: 'changed', path: 'src/main.py', revision: 2 } });
  assert.equal(events.length, 1);
  await assert.rejects(() => broker.request('runtime', 'crash', {}), (error) => error.transient === true);
  assert.ok(statuses.includes('reconnecting'));
  assert.equal((await broker.request('workspace', 'read', { path: 'after-restart.py' })).echoed.path, 'after-restart.py');

  const waiting = broker.request('language', 'wait', {});
  waiting.cancel('test');
  await assert.rejects(waiting, (error) => error.code === 'cancelled');
  assert.ok(sent.some((request) => request.method === '$/cancelRequest' && request.payload.requestId === waiting.requestId));
  broker.dispose();
  delete globalThis.PythonANative;
});

test('native broker discards a response from an older request identity', async () => {
  let sent;
  const native = {
    postMessage(raw) {
      sent = JSON.parse(raw);
      queueMicrotask(() => native.onMessage({
        protocolVersion: 2,
        id: sent.id,
        channel: sent.channel,
        method: sent.method,
        requestId: 'old-request',
        sessionId: sent.payload.sessionId,
        workspaceId: sent.payload.workspaceId,
        epoch: sent.payload.epoch,
        bufferVersion: sent.payload.bufferVersion,
        ok: true,
        payload: { stale: true }
      }));
      queueMicrotask(() => native.onMessage({
        protocolVersion: 2,
        id: sent.id,
        channel: sent.channel,
        method: sent.method,
        requestId: sent.payload.requestId,
        sessionId: sent.payload.sessionId,
        workspaceId: sent.payload.workspaceId,
        epoch: sent.payload.epoch,
        bufferVersion: sent.payload.bufferVersion,
        ok: true,
        payload: { stale: false }
      }));
    }
  };
  const broker = new NativeBroker({ nativeObject: native, timeoutMs: 1000 });
  const result = await broker.request('dsh', 'start', {
    requestId: 'current-request', sessionId: 'session-1', workspaceId: 'default',
    epoch: 4, bufferVersion: 9, uri: 'file:///workspace/main.py'
  });
  assert.deepEqual(result, { stale: false });
  broker.dispose();
  delete globalThis.PythonANative;
});

test('native workspace hydrates authoritatively and async document save observes changed events', async () => {
  const nativeClient = new FakeNativeWorkspace({ 'src/native.py': 'print("native")\n' });
  const store = new WorkspaceStore({
    storage: new MemoryStorage(), nativeClient,
    files: { 'src/cached.py': 'print("cached")\n' }
  });
  await store.ready;
  assert.equal(store.mode, 'native');
  assert.equal(store.has('src/native.py'), true);
  assert.equal(store.has('src/cached.py'), false);

  const document = new DocumentSession(store);
  await document.openAsync('src/native.py');
  document.edit('print("saved")\n');
  await document.saveAsync('editor');
  assert.equal(nativeClient.records.get('src/native.py').content, 'print("saved")\n');
  assert.equal(document.dirty, false);

  await nativeClient.externalWrite('src/native.py', 'print("runtime")\n');
  await store.flush();
  assert.equal(document.buffer, 'print("runtime")\n');
  assert.equal(document.conflict, null);
  document.dispose();
  store.dispose();
});

test('native workspace stores only UI metadata and recreates deleted paths monotonically', async () => {
  const storage = new MemoryStorage();
  const nativeClient = new FakeNativeWorkspace({ 'src/native.py': 'secret-source-text\n' });
  const store = new WorkspaceStore({ storage, nativeClient, seedNativeWorkspace: false });
  await store.ready;

  const persisted = storage.getItem('pythona.workspace.v1');
  assert.ok(persisted);
  assert.equal(persisted.includes('secret-source-text'), false);
  assert.deepEqual(JSON.parse(persisted), {
    version: 2, native: true, workspaceName: 'ml-playground'
  });

  assert.equal(await store.deleteAsync('src/native.py'), true);
  const recreated = await store.createFileAsync('src/native.py', 'print("again")\n');
  assert.equal(recreated.revision, 3);
  store.dispose();

  await nativeClient.delete('src/native.py', { expectedRevision: 3, source: 'runtime' });
  const reloaded = new WorkspaceStore({ storage, nativeClient, seedNativeWorkspace: false });
  await reloaded.ready;
  const afterReload = await reloaded.createFileAsync('src/native.py', 'print("reload")\n');
  assert.equal(afterReload.revision, 5);
  reloaded.dispose();
});

test('native workspace does not reseed after its final file was intentionally deleted', async () => {
  const nativeClient = new FakeNativeWorkspace({ 'only.py': 'print("once")\n' });
  const first = new WorkspaceStore({ storage: new MemoryStorage(), nativeClient });
  await first.ready;
  await first.deleteAsync('only.py');
  first.dispose();

  assert.equal(nativeClient.records.size, 0);
  assert.equal(nativeClient.tombstones.get('only.py'), 2);
  const reloaded = new WorkspaceStore({ storage: new MemoryStorage(), nativeClient });
  await reloaded.ready;
  assert.equal(reloaded.listFiles().length, 0);
  assert.equal(nativeClient.records.size, 0);
  reloaded.dispose();
});

test('native directory replacement recreates a tombstoned path monotonically', async () => {
  const nativeClient = new FakeNativeWorkspace({ 'restored.py': 'old\n' });
  const store = new WorkspaceStore({ storage: new MemoryStorage(), nativeClient });
  await store.ready;
  await store.deleteAsync('restored.py');
  await store.replaceFilesAsync({ 'restored.py': 'new\n' }, { source: 'directory-import' });
  assert.equal(nativeClient.records.get('restored.py').revision, 3);
  assert.equal(nativeClient.records.get('restored.py').content, 'new\n');
  store.dispose();
});

test('DSH async accept persists exactly one native workspace revision', async () => {
  const nativeClient = new FakeNativeWorkspace({ 'src/native.py': 'value = 1\n' });
  const store = new WorkspaceStore({ storage: new MemoryStorage(), nativeClient });
  await store.ready;
  const document = new DocumentSession(store);
  await document.openAsync('src/native.py');
  const gateway = {
    async *stream(request) {
      const patch = createPatch(request.path, request.content, 'value = 2\n');
      yield { type: 'ready', patch, summary: 'ready' };
    }
  };
  const controller = new DshController({ store, document, gateway });
  await controller.start('change');
  const before = nativeClient.records.get('src/native.py').revision;
  await controller.acceptAsync();
  await store.flush();
  assert.equal(nativeClient.records.get('src/native.py').revision, before + 1);
  assert.equal(document.buffer, 'value = 2\n');
  document.dispose();
  store.dispose();
});

test('workspace store writes revisions and emits source-aware events', () => {
  const store = makeStore();
  const events = [];
  store.subscribe((event) => events.push(event));
  const first = store.read('src/train.py');
  const next = store.write('src/train.py', 'print("changed")\n', { expectedRevision: first.revision, source: 'editor' });
  assert.equal(next.revision, first.revision + 1);
  assert.equal(next.hash, hashText(next.content));
  assert.equal(store.isModified('src/train.py'), true);
  assert.equal(events.at(-1).source, 'editor');
  assert.throws(() => store.write('src/train.py', 'stale', { expectedRevision: first.revision }), RevisionConflictError);
  store.write('src/train.py', first.content, { expectedRevision: next.revision, source: 'test' });
  assert.equal(store.isModified('src/train.py'), false);
});

test('document session tracks dirty state, undo/redo and clean external refresh', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  document.edit('print("local")\n');
  assert.equal(document.dirty, true);
  document.undo();
  assert.equal(document.buffer, 'print("ready")\n');
  document.redo();
  assert.equal(document.buffer, 'print("local")\n');
  document.save();
  assert.equal(document.dirty, false);
  store.simulateExternalChange('src/train.py', 'print("external")\n');
  assert.equal(document.buffer, 'print("external")\n');
  assert.equal(document.conflict, null);
});

test('document session tracks an unsaved bufferVersion independently from the saved revision', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  const opened = document.open('src/train.py');
  assert.equal(opened.bufferVersion, 1);
  const token = document.captureBuffer();
  const persistedRevision = document.revision;

  document.edit('print("one")\n');
  assert.equal(document.bufferVersion, 2);
  assert.equal(document.revision, persistedRevision);
  assert.equal(document.isCurrentBuffer(token), false);

  const beforeSaveVersion = document.bufferVersion;
  document.save();
  assert.equal(document.revision, persistedRevision + 1);
  assert.equal(document.bufferVersion, beforeSaveVersion);

  store.simulateExternalChange('src/train.py', 'print("external")\n');
  assert.equal(document.bufferVersion, beforeSaveVersion + 1);
  const previewVersion = document.bufferVersion;
  document.setPreview('print("preview only")\n');
  assert.equal(document.bufferVersion, previewVersion);
  document.dispose();
  store.dispose();
});

test('document session reports a conflict when dirty content meets an external write', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  document.edit('print("local")\n');
  store.simulateExternalChange('src/train.py', 'print("external")\n');
  assert.equal(document.conflict.remote, 'print("external")\n');
  document.keepLocal();
  document.save();
  assert.equal(store.read('src/train.py').content, 'print("local")\n');
});

test('workspace store applies cross-tab snapshots as external file events', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  const events = [];
  store.subscribe((event) => events.push(event));
  const snapshot = store.exportSnapshot();
  snapshot.files['src/train.py'].content = 'print("remote")\n';
  snapshot.files['src/train.py'].hash = hashText(snapshot.files['src/train.py'].content);
  snapshot.files['src/train.py'].revision += 1;
  assert.equal(store.applyExternalSnapshot(snapshot, 'external-storage'), true);
  assert.equal(document.buffer, 'print("remote")\n');
  assert.equal(events.at(-1).source, 'external-storage');
  store.dispose();
  document.dispose();
});

test('workspace replacement emits file events and refreshes the active document', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  const previousRevision = document.revision;
  const events = [];
  store.subscribe((event) => events.push(event));

  store.replaceFiles({
    'src/train.py': 'print("imported")\n',
    'README.md': '# imported\n',
    'src/new.py': 'print("new")\n'
  }, { source: 'directory-import' });

  assert.equal(document.buffer, 'print("imported")\n');
  assert.equal(document.dirty, false);
  assert.equal(document.revision, previousRevision + 1);
  assert.ok(events.some((event) => event.type === 'file-changed' && event.path === 'src/train.py' && event.source === 'directory-import'));
  assert.ok(events.some((event) => event.type === 'workspace-replaced' && event.source === 'directory-import'));
  document.dispose();
  store.dispose();
});

test('workspace replacement preserves revisions for unchanged files and avoids a false save conflict', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  store.simulateExternalChange('src/train.py', 'print("remote")\n');
  const revision = document.revision;

  store.replaceFiles({
    'src/train.py': 'print("remote")\n',
    'README.md': '# demo\n'
  }, { source: 'directory-import' });

  assert.equal(store.read('src/train.py').revision, revision);
  assert.equal(document.revision, revision);
  document.edit('print("after import")\n');
  assert.doesNotThrow(() => document.save());
  assert.equal(document.conflict, null);
  assert.equal(store.read('src/train.py').revision, revision + 1);
  document.dispose();
  store.dispose();
});

test('workspace replacement conflicts with a dirty document without losing it on a same-path reopen', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  document.edit('print("local")\n');

  store.replaceFiles({
    'src/train.py': 'print("imported")\n',
    'README.md': '# imported\n'
  }, { source: 'directory-import' });

  assert.equal(document.buffer, 'print("local")\n');
  assert.equal(document.conflict.remote, 'print("imported")\n');
  assert.equal(document.conflict.deleted, false);
  document.open('src/train.py');
  assert.equal(document.buffer, 'print("local")\n');
  assert.equal(document.conflict.remote, 'print("imported")\n');
  document.keepLocal();
  document.save();
  assert.equal(store.read('src/train.py').content, 'print("local")\n');
  document.dispose();
  store.dispose();
});

test('workspace replacement treats imported content matching a dirty buffer as synchronized', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  document.edit('print("already imported")\n');

  store.replaceFiles({
    'src/train.py': 'print("already imported")\n',
    'README.md': '# demo\n'
  }, { source: 'directory-import' });

  assert.equal(document.original, 'print("already imported")\n');
  assert.equal(document.buffer, 'print("already imported")\n');
  assert.equal(document.dirty, false);
  assert.equal(document.conflict, null);
  assert.equal(document.revision, store.read('src/train.py').revision);
  document.dispose();
  store.dispose();
});

test('workspace replacement closes a clean document whose file was deleted', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  const events = [];
  document.subscribe((event) => events.push(event));
  document.open('src/train.py');

  store.replaceFiles({ 'README.md': '# imported\n' }, { source: 'directory-import' });

  assert.equal(document.path, null);
  assert.equal(document.buffer, '');
  assert.equal(document.dirty, false);
  assert.equal(document.conflict, null);
  assert.ok(events.some((event) => event.type === 'external-delete' && event.path === 'src/train.py'));
  document.dispose();
  store.dispose();
});

test('workspace replacement exposes a recoverable deletion conflict for a dirty document', () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  document.edit('print("local survives")\n');

  store.replaceFiles({ 'README.md': '# imported\n' }, { source: 'directory-import' });

  assert.equal(document.path, 'src/train.py');
  assert.equal(document.buffer, 'print("local survives")\n');
  assert.equal(document.conflict.deleted, true);
  assert.equal(document.conflict.remote, null);
  assert.throws(() => document.save(), RevisionConflictError);
  assert.equal(store.has('src/train.py'), false);

  document.keepLocal();
  document.save();
  assert.equal(store.read('src/train.py').content, 'print("local survives")\n');

  document.edit('print("discard me")\n');
  store.replaceFiles({ 'README.md': '# imported again\n' }, { source: 'directory-import' });
  document.acceptRemote();
  assert.equal(document.path, null);
  assert.equal(document.buffer, '');
  assert.equal(document.dirty, false);
  assert.equal(document.conflict, null);
  document.dispose();
  store.dispose();
});

test('patch engine reports additions and removals', () => {
  const patch = createPatch('src/train.py', 'a\nb\n', 'a\nc\n');
  assert.equal(patch.additions, 1);
  assert.equal(patch.removals, 1);
  assert.equal(diffLines('same\n', 'same\n').length, 1);
});

test('DSH streams a patch, accepts it, then can undo it', async () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  const controller = new DshController({ store, document });
  const events = [];
  controller.subscribe((event) => events.push(event.type));
  await controller.start('增加断点续训');
  assert.ok(controller.pending);
  assert.ok(events.includes('hunk-preview'));
  const before = document.buffer;
  controller.accept();
  assert.notEqual(document.buffer, before);
  assert.equal(store.read('src/train.py').content, document.buffer);
  assert.equal(controller.undoLast(), true);
  assert.equal(store.read('src/train.py').content, before);
  assert.equal(document.conflict, null);
});

test('DSH discards a streamed patch when the active document changes', async () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gateway = {
    async *stream(request) {
      yield { type: 'tool', text: '读取 ' + request.path };
      await gate;
      const after = request.content + '# generated\n';
      const patch = createPatch(request.path, request.content, after);
      yield { type: 'hunk', index: 1, total: 1, hunk: patch.hunks[0], patch, preview: after };
      yield { type: 'ready', patch, summary: 'ready' };
    }
  };
  const controller = new DshController({ store, document, gateway });
  const events = [];
  controller.subscribe((event) => events.push(event.type));
  const running = controller.start('modify');
  await new Promise((resolve) => setImmediate(resolve));
  document.open('README.md');
  release();
  await running;

  assert.equal(controller.pending, null);
  assert.equal(document.path, 'README.md');
  assert.equal(document.preview, null);
  assert.ok(events.includes('task-stale'));
  assert.equal(store.read('src/train.py').content, 'print("ready")\n');
  document.dispose();
});

test('DSH discards a streamed patch after an unsaved edit changes away and back', async () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  const original = document.buffer;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gateway = {
    async *stream(request) {
      await gate;
      const after = request.content + '# stale generated\n';
      const patch = createPatch(request.path, request.content, after);
      yield { type: 'ready', patch, summary: 'ready' };
    }
  };
  const controller = new DshController({ store, document, gateway });
  const events = [];
  controller.subscribe((event) => events.push(event.type));
  const running = controller.start('modify');
  await new Promise((resolve) => setImmediate(resolve));
  document.edit(original + '# temporary\n');
  document.edit(original);
  release();
  await running;

  assert.equal(document.buffer, original);
  assert.equal(controller.pending, null);
  assert.ok(events.includes('task-stale'));
  document.dispose();
  store.dispose();
});

test('DSH overlapping starts cannot let an older stream overwrite the newer task', async () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  let releaseOld;
  let releaseNew;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const newGate = new Promise((resolve) => { releaseNew = resolve; });
  const gateway = {
    async *stream(request) {
      await (request.prompt === 'old' ? oldGate : newGate);
      const after = request.content + `# ${request.prompt}\n`;
      const patch = createPatch(request.path, request.content, after);
      yield { type: 'ready', patch, summary: request.prompt };
    }
  };
  const controller = new DshController({ store, document, gateway });
  const oldTask = controller.start('old');
  await new Promise((resolve) => setImmediate(resolve));
  const newTask = controller.start('new');
  await new Promise((resolve) => setImmediate(resolve));
  releaseOld();
  await oldTask;
  assert.equal(controller.pending, null);
  releaseNew();
  await newTask;
  assert.ok(controller.pending?.after.endsWith('# new\n'));
  document.dispose();
  store.dispose();
});

test('DSH cancel during a stream is idempotent and emits no task error', async () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gateway = {
    async *stream(request) {
      await gate;
      const patch = createPatch(request.path, request.content, request.content + '# cancelled\n');
      yield { type: 'ready', patch, summary: 'cancelled' };
    }
  };
  const controller = new DshController({ store, document, gateway });
  const events = [];
  controller.subscribe((event) => events.push(event.type));
  const task = controller.start('cancel me');
  await new Promise((resolve) => setImmediate(resolve));
  controller.cancel();
  controller.cancel();
  release();
  await task;
  assert.equal(controller.pending, null);
  assert.equal(events.includes('task-error'), false);
  document.dispose();
  store.dispose();
});

test('DSH undo never changes a different or subsequently edited document', async () => {
  const store = makeStore();
  const document = new DocumentSession(store);
  document.open('src/train.py');
  const controller = new DshController({ store, document });
  const events = [];
  controller.subscribe((event) => events.push(event.type));
  await controller.start('增加断点续训');
  controller.accept();
  const accepted = store.read('src/train.py').content;

  document.open('README.md');
  const readme = document.buffer;
  assert.equal(controller.undoLast(), false);
  assert.equal(document.buffer, readme);
  assert.equal(store.read('src/train.py').content, accepted);
  assert.ok(events.includes('undo-blocked'));

  document.open('src/train.py');
  document.edit(accepted + '# later edit\n');
  assert.equal(controller.undoLast(), false);
  assert.equal(document.buffer, accepted + '# later edit\n');
  document.dispose();
});

test('runtime fallback refuses execution instead of pretending to be CPython', async () => {
  const runtime = new RuntimeAdapter({ bridge: null });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  const result = await runtime.run('python src/train.py', { fileContent: 'print("hello")\n' });
  assert.equal(result.exitCode, 126);
  assert.match(result.stderr, /did not execute or simulate/);
  assert.equal(runtime.capabilities().mode, 'browser-fallback');
  assert.ok(events.some((event) => event.type === 'output' && event.stream === 'stderr'));
  assert.ok(events.some((event) => event.type === 'finished'));
});

test('runtime bridge reports provider capabilities instead of assuming CPython or PyTorch', async () => {
  const bridge = {
    invoke(requestJson) {
      const request = JSON.parse(requestJson);
      assert.equal(request.method, 'capabilities');
      return JSON.stringify({
        mode: 'android-bridge-stub',
        python: 'CPython service seam (not bundled yet)',
        abi: 'arm64-v8a',
        pytorch: 'provider pending',
        network: false
      });
    }
  };
  const runtime = new RuntimeAdapter({ bridge });
  const capabilities = await runtime.ready;
  assert.equal(capabilities.mode, 'android-bridge-stub');
  assert.match(capabilities.python, /not bundled yet/);
  assert.equal(capabilities.pytorch, 'provider pending');
  assert.equal(capabilities.available, false);
  assert.ok([...runtime.packageSet].some((item) => item.includes('torch') && item.includes('实验包不可用')));
  assert.ok(![...runtime.packageSet].some((item) => item.includes('torch') && item.includes('installed')));
});

test('runtime bridge never turns an invalid or explicit error response into success', async () => {
  const missingExitRuntime = new RuntimeAdapter({
    bridge: {
      invoke(requestJson) {
        const request = JSON.parse(requestJson);
        if (request.method === 'capabilities') return JSON.stringify({ mode: 'native', python: 'CPython 3.12', available: true });
        return JSON.stringify({ stderr: 'provider returned no exit status' });
      }
    }
  });
  await missingExitRuntime.ready;
  const result = await missingExitRuntime.run('python demo.py');
  assert.equal(result.exitCode, 1);

  const errorRuntime = new RuntimeAdapter({
    bridge: {
      invoke(requestJson) {
        const request = JSON.parse(requestJson);
        if (request.method === 'capabilities') return JSON.stringify({ mode: 'native', python: 'CPython 3.12', available: true });
        return JSON.stringify({ error: 'runtime unavailable', code: 'unavailable' });
      }
    }
  });
  await errorRuntime.ready;
  await assert.rejects(() => errorRuntime.run('python demo.py'), /runtime unavailable/);
});

test('content changes use LSP UTF-16 positions and reject backwards ranges', () => {
  const source = '😀x\nprint("ok")\n';
  assert.equal(applyContentChanges(source, [{
    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } },
    text: 'y'
  }]), '😀y\nprint("ok")\n');
  assert.throws(() => applyContentChanges(source, [{
    range: { start: { line: 1, character: 3 }, end: { line: 1, character: 1 } },
    text: ''
  }]), /reversed/);
});

test('local language provider supplies offline Python and workspace completions', async () => {
  const local = new LocalLanguageProvider();
  const service = new LanguageService({ providers: [local] });
  const uri = toDocumentUri('src/demo.py');
  const opened = await service.openDocument({
    uri,
    text: 'def train_model():\n    pass\n\ntra',
    version: 1
  });
  const completion = await service.complete({ uri, version: 1, position: { line: 3, character: 3 } });
  assert.equal(completion.epoch, opened.epoch);
  assert.ok(completion.items.some((item) => item.label === 'train_model' && item.providerId === 'local'));

  await service.changeDocument({ uri, version: 2, text: 'def train_model():\n    pass\n\npri' });
  const builtins = await service.complete({ uri, version: 2, position: { line: 3, character: 3 } });
  assert.ok(builtins.items.some((item) => item.label === 'print'));

  await service.changeDocument({ uri, version: 3, text: 'def train_model():\n    pass\n\ntrain_model()' });
  const definition = await service.definition({ uri, version: 3, position: { line: 3, character: 4 } });
  assert.equal(definition.result[0].uri, uri);
  assert.equal(definition.result[0].range.start.line, 0);
  service.dispose();
});

test('CodeMirror completion replaces only the identifier after a dot', () => {
  const text = 'os.pa';
  const context = {
    pos: text.length,
    explicit: true,
    matchBefore(pattern) {
      const match = text.slice(0, this.pos).match(pattern);
      return match ? { from: this.pos - match[0].length, to: this.pos, text: match[0] } : null;
    }
  };
  const result = createWorkspaceCompletionSource({ getFiles: () => [] })(context);
  assert.equal(result.from, 3);
  assert.equal(text.slice(0, result.from) + 'path', 'os.path');
});

test('local completions index variables, parameters and Unicode Python identifiers', async () => {
  const source = [
    '全局值 = 1',
    'def 训练模型(批次, 学习率=0.1):',
    '    for 样本 in 批次:',
    '        with open("data") as 文件:',
    '            try:',
    '                pass',
    '            except OSError as 错误:',
    '                pass',
    '批'
  ].join('\n');
  const context = {
    pos: source.length,
    explicit: true,
    matchBefore(pattern) {
      const match = source.slice(0, this.pos).match(pattern);
      return match ? { from: this.pos - match[0].length, to: this.pos, text: match[0] } : null;
    }
  };
  const completionSource = createWorkspaceCompletionSource({
    getFiles: () => [{ path: 'src/model.py', content: source, bufferVersion: 9 }]
  });
  const labels = new Set(completionSource(context).options.map((item) => item.label));
  for (const name of ['全局值', '训练模型', '批次', '学习率', '样本', '文件', '错误']) {
    assert.ok(labels.has(name), `missing ${name}`);
  }
  assert.equal(completionSource(context).from, source.length - 1);

  const service = new LanguageService({ providers: [new LocalLanguageProvider()] });
  const uri = toDocumentUri('src/model.py');
  await service.openDocument({ uri, text: source, version: 1 });
  const completion = await service.complete({
    uri,
    version: 1,
    position: { line: 8, character: 1 }
  });
  assert.ok(completion.items.some((item) => item.label === '批次'));
  const symbols = await service.documentSymbols({ uri, version: 1 });
  assert.ok(symbols.result.some((item) => item.name === '学习率'));
  service.dispose();
});

test('workspace completions keep locals in the active file and include import aliases', () => {
  const files = [
    {
      path: 'src/current.py',
      bufferVersion: 2,
      content: [
        'import numpy as np',
        'import os.path',
        'from collections import defaultdict as dd, deque',
        'from .helpers import render as render_result',
        'from . import sibling as local_sibling',
        'def current_job(local_parameter):',
        '    hidden_current = local_parameter',
        'np'
      ].join('\n')
    },
    {
      path: 'src/other.py',
      bufferVersion: 3,
      content: [
        'PUBLIC_LIMIT = 3',
        'def exported_job(other_parameter):',
        '    hidden_other = other_parameter',
        'class ExportedModel:',
        '    pass'
      ].join('\n')
    },
    {
      path: 'src/types.pyi',
      bufferVersion: 1,
      content: 'STUB_ONLY: int\ndef typed_api(value: str) -> int: ...\n'
    }
  ];
  const source = createWorkspaceCompletionSource({
    getFiles: () => files,
    getDocument: () => ({ path: 'src/current.py' })
  });
  const context = {
    pos: files[0].content.length,
    explicit: true,
    matchBefore(pattern) {
      const match = files[0].content.slice(0, this.pos).match(pattern);
      return match ? { from: this.pos - match[0].length, to: this.pos, text: match[0] } : null;
    }
  };
  const labels = new Set(source(context).options.map((item) => item.label));
  for (const name of ['np', 'os', 'dd', 'deque', 'render_result', 'local_sibling', 'local_parameter',
    'hidden_current', 'exported_job', 'ExportedModel', 'PUBLIC_LIMIT', 'STUB_ONLY', 'typed_api']) {
    assert.ok(labels.has(name), `missing ${name}`);
  }
  for (const leaked of ['numpy', 'defaultdict', 'render', 'other_parameter', 'hidden_other']) {
    assert.equal(labels.has(leaked), false, `cross-file or aliased name leaked: ${leaked}`);
  }
});

test('Python token highlighting identifies builtins, decorator names and parse errors', () => {
  const tokens = classifyPythonHighlightTokens([
    '@registry.cached',
    'def run(value):',
    '    print(len(value))',
    'def broken(:'
  ].join('\n'));
  assert.ok(tokens.some((token) => token.kind === 'builtin' && token.text === 'print'));
  assert.ok(tokens.some((token) => token.kind === 'builtin' && token.text === 'len'));
  assert.ok(tokens.some((token) => token.kind === 'decorator' && token.text === 'registry'));
  assert.ok(tokens.some((token) => token.kind === 'decorator' && token.text === 'cached'));
  assert.ok(tokens.some((token) => token.kind === 'invalid'));
});

test('desktop search shortcuts expose replace and go-to-line bindings', () => {
  assert.deepEqual(editorSearchShortcuts.map((binding) => binding.key), ['Mod-h', 'Mod-g']);
  assert.ok(editorSearchShortcuts.every((binding) => binding.preventDefault && typeof binding.run === 'function'));
});

test('editor settings only report compartments whose value actually changed', () => {
  const before = normalizeEditorSettings({
    theme: 'dark', lineNumbers: true, foldGutter: true, wordWrap: false,
    autocomplete: true, tabSize: 4, editorSize: 16
  });
  assert.deepEqual(changedEditorSettings(before, normalizeEditorSettings({ ...before })), []);
  const after = normalizeEditorSettings({ ...before, wrap: true, tabSize: 2, fontSize: 18 });
  assert.deepEqual(changedEditorSettings(before, after), ['wordWrap', 'tabSize', 'fontSize']);
  assert.equal(completionTabBinding.key, 'Tab');
  assert.equal(completionTabBinding.preventDefault, true);
  assert.equal(typeof completionTabBinding.run, 'function');
});

test('semantic completion deduplicates local edits and resolves Jedi documentation lazily', async () => {
  let resolveCalls = 0;
  const local = {
    id: 'local',
    complete() {
      return { items: [{ label: 'print', insertText: 'print', kind: 'Variable', detail: 'local' }] };
    }
  };
  const bridge = {
    id: 'bridge',
    complete() {
      return {
        items: [{
          label: 'print', insertText: 'print', kind: 'Function', detail: 'print(*objects)',
          data: { pythonaCompletion: 'token-1' }
        }]
      };
    },
    resolveCompletion(request) {
      resolveCalls += 1;
      assert.equal(request.item.data.pythonaCompletion, 'token-1');
      return { ...request.item, documentation: { kind: 'markdown', value: 'Print objects to a stream.' } };
    }
  };
  const service = new LanguageService({ providers: [local, bridge] });
  const uri = toDocumentUri('src/resolve.py');
  await service.openDocument({ uri, text: 'pri', version: 7 });
  const merged = await service.complete({ uri, version: 7, position: { line: 0, character: 3 } });
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].providerId, 'bridge');
  const snapshot = { path: 'src/resolve.py', buffer: 'pri', bufferVersion: 7 };
  const context = {
    pos: 3,
    explicit: true,
    matchBefore(pattern) {
      const match = snapshot.buffer.slice(0, this.pos).match(pattern);
      return match ? { from: this.pos - match[0].length, to: this.pos, text: match[0] } : null;
    },
    addEventListener() {}
  };
  const source = createSemanticCompletionSource({
    languageService: service,
    getDocument: () => snapshot,
    getLocalOptions: () => [{ label: 'print', type: 'function', detail: 'Python 内置对象', boost: 20 }]
  });
  const result = await source(context);
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].label, 'print');
  assert.equal(result.options[0].detail, 'Python 内置对象');
  assert.equal(result.options[0].apply, undefined);
  assert.equal(typeof result.options[0].info, 'function');
  assert.equal(await result.options[0].info(result.options[0]), 'Print objects to a stream.');
  assert.equal(resolveCalls, 1);
  service.dispose();
});

test('completionItem resolve never exposes documentation after the buffer version changes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = {
    id: 'bridge',
    complete() {
      return { items: [{ label: 'value', insertText: 'value', kind: 'Variable', data: { pythonaCompletion: 'old' } }] };
    },
    async resolveCompletion(request) {
      await gate;
      return { ...request.item, documentation: 'stale documentation' };
    }
  };
  const service = new LanguageService({ providers: [bridge] });
  const uri = toDocumentUri('src/stale_info.py');
  await service.openDocument({ uri, text: 'val', version: 1 });
  let snapshot = { path: 'src/stale_info.py', buffer: 'val', bufferVersion: 1 };
  const context = {
    pos: 3,
    explicit: true,
    matchBefore(pattern) {
      const match = snapshot.buffer.slice(0, this.pos).match(pattern);
      return match ? { from: this.pos - match[0].length, to: this.pos, text: match[0] } : null;
    },
    addEventListener() {}
  };
  const source = createSemanticCompletionSource({ languageService: service, getDocument: () => snapshot });
  const result = await source(context);
  const pendingInfo = result.options[0].info(result.options[0]);
  snapshot = { path: 'src/stale_info.py', buffer: 'value', bufferVersion: 2 };
  await service.changeDocument({ uri, text: snapshot.buffer, version: 2 });
  release();
  assert.equal(await pendingInfo, null);
  service.dispose();
});

test('editor coordinator restores rejected previews and records an accepted DSH patch once', () => {
  const makeState = (text, history = []) => ({
    doc: { toString: () => text },
    selection: { main: { head: Math.min(4, text.length) } },
    history
  });
  const adapter = {
    text: '',
    state: makeState(''),
    scroll: { top: 0, left: 0 },
    previewMode: false,
    previewReturn: null,
    appliedSettings: normalizeEditorSettings(),
    applyCalls: [],
    capture() { return { state: this.state, scroll: { ...this.scroll }, settings: { ...this.appliedSettings } }; },
    restore(entry, { preview = false } = {}) {
      this.state = entry.state;
      this.text = entry.state.doc.toString();
      this.scroll = { ...entry.scroll };
      this.previewMode = preview;
    },
    open(path, text) {
      this.text = String(text);
      this.state = makeState(this.text);
      const entry = this.capture();
      this.restore(entry);
      return entry;
    },
    enterPreview(before, after, options = {}) {
      if (!this.previewMode) this.previewReturn = this.capture();
      this.text = String(after);
      this.state = makeState(this.text);
      this.scroll = { ...(options.scroll || this.scroll) };
      this.previewMode = true;
    },
    leavePreview() {
      if (!this.previewReturn) return false;
      const saved = this.previewReturn;
      this.previewReturn = null;
      this.restore(saved);
      return true;
    },
    applySessionText(text, origin, addToHistory) {
      this.applyCalls.push({ text, origin, addToHistory });
      const history = [...this.state.history];
      if (addToHistory) history.push(origin);
      this.text = String(text);
      this.state = makeState(this.text, history);
      return true;
    },
    documentText() { return this.text; },
    reconfigure() { return false; },
    destroy() {}
  };
  const coordinator = new EditorCoordinator({ adapter });
  const base = {
    path: 'src/model.py', buffer: 'value = 1\n', bufferVersion: 1, preview: null
  };
  coordinator.present(base, { theme: 'dark' });
  adapter.state = makeState(base.buffer, ['typed-before-preview']);
  adapter.text = base.buffer;
  adapter.scroll = { top: 72, left: 11 };
  const savedState = adapter.state;

  const after = 'value = 2\n';
  coordinator.present({ ...base, preview: { content: after, hunk: 1, total: 1 } }, { theme: 'dark' });
  coordinator.present(base, { theme: 'dark' });
  assert.equal(adapter.state, savedState);
  assert.deepEqual(adapter.scroll, { top: 72, left: 11 });
  assert.deepEqual(adapter.applyCalls, []);

  coordinator.present({ ...base, preview: { content: after, hunk: 1, total: 1 } }, { theme: 'dark' });
  coordinator.present({ ...base, buffer: after, bufferVersion: 2, preview: null }, { theme: 'dark' });
  assert.deepEqual(adapter.applyCalls.at(-1), { text: after, origin: 'dsh-accept', addToHistory: true });
  assert.deepEqual(adapter.state.history, ['typed-before-preview', 'dsh-accept']);
  assert.deepEqual(adapter.scroll, { top: 72, left: 11 });

  coordinator.present({ ...base, buffer: 'value = 3\n', bufferVersion: 3, preview: null }, { theme: 'dark' });
  assert.deepEqual(adapter.applyCalls.at(-1), {
    text: 'value = 3\n', origin: 'session-refresh', addToHistory: false
  });
  assert.deepEqual(adapter.state.history, ['typed-before-preview', 'dsh-accept']);
});

test('language service discards a semantic result after the document version changes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    id: 'delayed',
    async complete() {
      await gate;
      return { items: [{ label: 'stale_result', kind: 'Variable' }] };
    }
  };
  const service = new LanguageService({ providers: [provider] });
  const events = [];
  service.subscribe((event) => events.push(event));
  const uri = toDocumentUri('src/versioned.py');
  await service.openDocument({ uri, text: 'sta', version: 1 });
  const pending = service.complete({ uri, version: 1, position: { line: 0, character: 3 } });
  await service.changeDocument({ uri, text: 'newer', version: 2 });
  release();
  assert.equal(await pending, null);
  assert.ok(events.some((event) => event.type === 'request-discarded' && event.reason === 'content-modified'));
  assert.throws(
    () => service.changeDocument({ uri, text: 'wrong same version', version: 2 }),
    ContentModifiedError
  );
  service.dispose();
});

test('language requests are cancellable and notify every provider', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cancellations = [];
  const provider = {
    id: 'semantic',
    async complete() { await gate; return { items: [{ label: 'late' }] }; },
    cancel(request) { cancellations.push(request); }
  };
  const service = new LanguageService({ providers: [provider] });
  const uri = toDocumentUri('src/cancel.py');
  await service.openDocument({ uri, text: 'lat', version: 7 });
  const pending = service.complete({ uri, version: 7, position: { line: 0, character: 3 } });
  assert.equal(service.cancel(pending.requestId), true);
  release();
  assert.equal(await pending, null);
  assert.equal(cancellations[0].requestId, pending.requestId);
  assert.equal(cancellations[0].version, 7);
  service.dispose();
});

test('bridge language provider uses the namespaced protocol and preserves versions', async () => {
  const calls = [];
  const bridge = {
    invoke(requestJson) {
      const request = JSON.parse(requestJson);
      calls.push(request);
      if (request.method === 'language/complete') {
        return JSON.stringify({ result: { items: [{ label: 'semantic_name', detail: 'Jedi' }] } });
      }
      return JSON.stringify({ result: { ok: true } });
    }
  };
  const provider = new BridgeLanguageProvider(bridge);
  const service = new LanguageService({ providers: [provider] });
  const uri = toDocumentUri('src/bridge.py');
  const opened = await service.openDocument({ uri, text: 'sem', version: 4 });
  const result = await service.complete({ uri, epoch: opened.epoch, version: 4, position: { line: 0, character: 3 } });
  assert.equal(result.items[0].label, 'semantic_name');
  assert.equal(result.items[0].providerId, 'bridge');
  const request = calls.find((call) => call.method === 'language/complete');
  assert.equal(request.payload.version, 4);
  assert.equal(request.payload.epoch, opened.epoch);
  assert.equal(Object.prototype.hasOwnProperty.call(request.payload, 'signal'), false);
  service.dispose();
});

test('bridge language provider sends incremental didChange without a duplicate full buffer', async () => {
  const calls = [];
  const bridge = {
    request(channel, method, payload) {
      calls.push({ channel, method, payload });
      return Promise.resolve({ result: { ok: true } });
    }
  };
  const service = new LanguageService({ bridge });
  const uri = toDocumentUri('src/incremental.py');
  const opened = await service.openDocument({ uri, text: 'value = 1\n', version: 10 });
  await service.changeDocument({
    uri,
    epoch: opened.epoch,
    version: 11,
    changes: [{
      range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } },
      text: '2'
    }]
  });
  const request = calls.find((call) => call.method === 'didChange');
  assert.equal(request.channel, 'language');
  assert.equal(Object.prototype.hasOwnProperty.call(request.payload, 'text'), false);
  assert.equal(request.payload.version, 11);
  assert.deepEqual(request.payload.changes[0].range.start, { line: 0, character: 8 });
  assert.equal(service.document(uri).text, 'value = 2\n');
  service.dispose();
});

test('bridge language provider compacts semantic requests and restores full text after a service crash', async () => {
  const calls = [];
  let lifecycle;
  const bridge = {
    subscribe(channel, listener) {
      assert.equal(channel, 'language');
      lifecycle = listener;
      return () => { lifecycle = null; };
    },
    request(channel, method, payload) {
      calls.push({ channel, method, payload });
      return Promise.resolve({ result: method === 'completion' ? { items: [] } : { ok: true } });
    }
  };
  const provider = new BridgeLanguageProvider(bridge);
  const request = {
    uri: toDocumentUri('src/recovery.py'), epoch: 3, version: 9,
    requestId: 'semantic-1', position: { line: 0, character: 2 }, text: 'pr'
  };
  await provider.complete(request);
  assert.equal(Object.prototype.hasOwnProperty.call(calls.at(-1).payload, 'text'), false);

  lifecycle({ type: 'service-crashed' });
  await provider.complete({ ...request, requestId: 'semantic-2' });
  assert.equal(calls.at(-1).payload.text, 'pr');
  assert.equal(provider.recoveryRequired, false);
  provider.dispose();
  assert.equal(lifecycle, null);
});

test('bridge language provider sends a full snapshot after didOpen transport failure', async () => {
  const calls = [];
  const bridge = {
    subscribe() { return () => {}; },
    request(channel, method, payload) {
      calls.push({ channel, method, payload });
      if (method === 'didOpen') {
        return Promise.reject(Object.assign(new Error('cold service timeout'), { code: 'service-timeout' }));
      }
      return Promise.resolve({ result: method === 'completion' ? { items: [] } : { ok: true } });
    }
  };
  const service = new LanguageService({ bridge });
  const uri = toDocumentUri('src/cold.py');
  const opened = await service.openDocument({ uri, text: 'pri', version: 1 });
  await service.complete({ uri, epoch: opened.epoch, version: 1, position: { line: 0, character: 3 } });
  const completion = calls.find((call) => call.method === 'completion');
  assert.equal(completion.payload.text, 'pri');
  service.dispose();
});

test('bridge language provider retries document-not-open once with the current snapshot', async () => {
  const completions = [];
  const bridge = {
    subscribe() { return () => {}; },
    request(channel, method, payload) {
      if (method === 'completion') {
        completions.push(payload);
        if (completions.length === 1) {
          return Promise.resolve({ error: 'document missing after restart', code: 'document-not-open' });
        }
        return Promise.resolve({ result: { items: [{ label: 'print', kind: 'Function' }] } });
      }
      return Promise.resolve({ result: { ok: true } });
    }
  };
  const service = new LanguageService({ bridge });
  const uri = toDocumentUri('src/retry.py');
  const opened = await service.openDocument({ uri, text: 'pri', version: 4 });
  const result = await service.complete({
    uri, epoch: opened.epoch, version: 4, position: { line: 0, character: 3 }
  });
  assert.equal(completions.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(completions[0], 'text'), false);
  assert.equal(completions[1].text, 'pri');
  assert.equal(result.items[0].label, 'print');
  service.dispose();
});

test('runtime protocol v2 supports runFile, stdin, packages and signed pack activation', async () => {
  const calls = [];
  let finishRun;
  const runGate = new Promise((resolve) => { finishRun = resolve; });
  const methods = ['runFile', 'sendInput', 'listPackages', 'activatePack'];
  const bridge = {
    async invoke(requestJson) {
      const request = JSON.parse(requestJson);
      calls.push(request);
      if (request.method === 'capabilities') {
        return JSON.stringify({ mode: 'native', python: 'CPython 3.14', available: true, protocolVersion: 2, methods });
      }
      if (request.method === 'runFile') {
        await runGate;
        return JSON.stringify({ exitCode: 0, stdout: 'done\n' });
      }
      if (request.method === 'sendInput') return JSON.stringify({ ok: true });
      if (request.method === 'listPackages') {
        return JSON.stringify({ packages: [{ name: 'jedi', version: '0.20.0', source: 'python314' }] });
      }
      if (request.method === 'activatePack') return JSON.stringify({ ok: true, generation: 2 });
      if (request.method === 'stop') return JSON.stringify({ ok: true });
      return JSON.stringify({ error: 'unknown', code: 'bridge-method-missing' });
    }
  };
  const runtime = new RuntimeAdapter({ bridge });
  await runtime.ready;
  const running = runtime.runFile('src/train file.py', { args: ['--epochs', '1'], fileContent: 'print("done")\n' });
  await new Promise((resolve) => setImmediate(resolve));
  const inputResult = await runtime.sendInput('yes\n');
  assert.equal(inputResult.ok, true);
  finishRun();
  assert.equal((await running).exitCode, 0);

  const runCall = calls.find((call) => call.method === 'runFile');
  assert.equal(runCall.payload.file, 'src/train file.py');
  assert.deepEqual(runCall.payload.args, ['--epochs', '1']);
  assert.equal(runCall.payload.content, 'print("done")\n');
  assert.equal(calls.find((call) => call.method === 'sendInput').payload.runId, runCall.payload.runId);

  const packages = await runtime.listPackages();
  assert.deepEqual(packages[0], {
    name: 'jedi', version: '0.20.0', status: 'installed', source: 'python314', packId: null
  });
  const activation = await runtime.activatePack('scientific-arm64', { confirmed: true });
  assert.equal(activation.ok, true);
  assert.equal(activation.generation, 2);
  assert.equal(calls.find((call) => call.method === 'activatePack').payload.confirmed, true);
});

test('runtime pack client uses the isolated broker channel for SAF install and rollback', async () => {
  const calls = [];
  const broker = {
    available: true,
    async request(channel, method, payload, options) {
      calls.push({ channel, method, payload, options });
      if (method === 'capabilities') {
        return {
          installerAvailable: true,
          pickerAvailable: true,
          methods: ['pickAndInstall', 'install', 'rollback'],
          signature: 'Ed25519',
          active: [{ packId: 'numpy-arm64', version: '2.4.0', buildId: 'numpy-1', present: true }]
        };
      }
      if (method === 'pickAndInstall') {
        return {
          accepted: true,
          status: 'staged-not-activated',
          packId: 'torch-arm64',
          buildId: 'torch-1',
          active: false,
          smokeTest: { passed: false, reason: 'runtime-smoke-test-unavailable' }
        };
      }
      if (method === 'install') {
        return { accepted: true, status: 'installed', packId: 'numpy-arm64', buildId: 'numpy-2' };
      }
      if (method === 'rollback') {
        return { accepted: true, status: 'rolled-back', packId: payload.packId, buildId: 'numpy-1' };
      }
      throw new Error('unexpected method');
    }
  };
  const packs = new NativeRuntimePackClient(broker);
  const capabilities = await packs.refreshCapabilities();
  assert.equal(capabilities.pickerAvailable, true);
  assert.equal(capabilities.active[0].packId, 'numpy-arm64');

  await assert.rejects(
    () => packs.pickAndInstall({ skipCapabilityRefresh: true }),
    (error) => error.code === 'confirmation-required'
  );
  const picked = await packs.pickAndInstall({
    confirmed: true,
    skipCapabilityRefresh: true,
    timeoutMs: 1234
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.status, 'staged-not-activated');
  assert.equal(calls.find((call) => call.method === 'pickAndInstall').channel, 'runtimePack');
  assert.equal(calls.find((call) => call.method === 'pickAndInstall').payload.confirmed, true);

  const installed = await packs.install('content://documents/runtime-pack', { confirmed: true });
  assert.equal(installed.status, 'installed');
  assert.equal(calls.find((call) => call.method === 'install').payload.uri, 'content://documents/runtime-pack');

  await assert.rejects(
    () => packs.rollback('numpy-arm64'),
    (error) => error.code === 'confirmation-required'
  );
  const rolledBack = await packs.rollback('numpy-arm64', { confirmed: true });
  assert.equal(rolledBack.status, 'rolled-back');
  assert.deepEqual(calls.find((call) => call.method === 'rollback').payload, {
    packId: 'numpy-arm64',
    confirmed: true
  });
});

test('runtime pack client is honest when Android or its SAF picker is unavailable', async () => {
  const browserPacks = new NativeRuntimePackClient(null);
  assert.equal(browserPacks.capabilities().mode, 'browser-preview');
  await assert.rejects(
    () => browserPacks.pickAndInstall(),
    (error) => error.code === 'runtime-pack-android-only'
  );

  const calls = [];
  const androidPacks = new NativeRuntimePackClient({
    available: true,
    async request(channel, method) {
      calls.push({ channel, method });
      return { installerAvailable: true, active: [], signature: 'Ed25519' };
    }
  });
  const capabilities = await androidPacks.refreshCapabilities();
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.pickerAvailable, false);
  await assert.rejects(
    () => androidPacks.pickAndInstall({ skipCapabilityRefresh: true }),
    (error) => error.code === 'runtime-pack-picker-unavailable'
  );
  assert.equal(calls.filter((call) => call.method !== 'capabilities').length, 0);
  await assert.rejects(
    () => androidPacks.install('file:///sdcard/unsigned.pya-pack'),
    (error) => error.code === 'content-uri-required'
  );
});

test('pure Python package client uses only the isolated wheel broker channel', async () => {
  const calls = [];
  const broker = {
    available: true,
    async request(channel, method, payload, options) {
      calls.push({ channel, method, payload, options });
      if (method === 'capabilities') {
        return {
          available: true,
          pickerAvailable: true,
          mode: 'pure-python-wheel',
          methods: ['capabilities', 'list', 'install', 'pickAndInstall'],
          pythonTags: ['py3', 'py314'],
          abiTag: 'none',
          platformTag: 'any',
          nativeExtensions: false,
          sdist: false
        };
      }
      if (method === 'list') {
        return {
          environmentId: payload.environmentId,
          packages: [{ name: 'attrs', version: '25.3.0', source: 'pure-python-wheel' }]
        };
      }
      if (method === 'pickAndInstall') {
        return {
          accepted: true,
          ok: true,
          status: 'installed',
          name: 'attrs',
          version: '25.3.0',
          restartRequired: true
        };
      }
      if (method === 'install') {
        return { accepted: false, ok: false, status: 'runtime-busy' };
      }
      throw new Error('unexpected method');
    }
  };
  const packages = new NativePythonPackageClient(broker, { environmentId: 'default' });
  const capabilities = await packages.refreshCapabilities();
  assert.equal(capabilities.pickerAvailable, true);
  assert.deepEqual(capabilities.pythonTags, ['py3', 'py314']);
  assert.equal(capabilities.nativeExtensions, false);

  const listed = await packages.list();
  assert.equal(listed.packages[0].name, 'attrs');
  assert.equal(calls.find((call) => call.method === 'list').channel, 'pythonPackage');

  await assert.rejects(
    () => packages.pickAndInstall({ skipCapabilityRefresh: true }),
    (error) => error.code === 'confirmation-required'
  );
  const installed = await packages.pickAndInstall({
    confirmed: true,
    skipCapabilityRefresh: true,
    timeoutMs: 4321
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.restartRequired, true);
  const picked = calls.find((call) => call.method === 'pickAndInstall');
  assert.equal(picked.channel, 'pythonPackage');
  assert.deepEqual(picked.payload, { environmentId: 'default', confirmed: true });

  await assert.rejects(
    () => packages.install('content://documents/attrs-wheel'),
    (error) => error.code === 'confirmation-required'
  );
  const busy = await packages.install('content://documents/attrs-wheel', { confirmed: true });
  assert.equal(busy.accepted, false);
  assert.equal(busy.status, 'runtime-busy');
});

test('pure Python package client never claims browser, native wheel or sdist support', async () => {
  const browserPackages = new NativePythonPackageClient(null);
  assert.equal(browserPackages.capabilities().available, false);
  assert.equal(browserPackages.capabilities().nativeExtensions, false);
  assert.equal(browserPackages.capabilities().sdist, false);
  await assert.rejects(
    () => browserPackages.pickAndInstall(),
    (error) => error.code === 'python-package-android-only'
  );

  const androidPackages = new NativePythonPackageClient({
    available: true,
    async request() {
      return {
        available: true,
        methods: ['list'],
        pythonTags: ['py3'],
        nativeExtensions: true,
        sdist: true
      };
    }
  });
  const capabilities = await androidPackages.refreshCapabilities();
  assert.equal(capabilities.pickerAvailable, false);
  assert.equal(capabilities.nativeExtensions, false);
  assert.equal(capabilities.sdist, false);
  await assert.rejects(
    () => androidPackages.pickAndInstall({ skipCapabilityRefresh: true }),
    (error) => error.code === 'python-package-picker-unavailable'
  );
  await assert.rejects(
    () => androidPackages.install('file:///sdcard/native.whl'),
    (error) => error.code === 'content-uri-required'
  );
});

test('runtime runFile falls back to the protocol v1 command method', async () => {
  const calls = [];
  const bridge = {
    invoke(requestJson) {
      const request = JSON.parse(requestJson);
      calls.push(request);
      if (request.method === 'capabilities') {
        return JSON.stringify({ mode: 'native', python: 'CPython legacy', available: true, protocolVersion: 1 });
      }
      if (request.method === 'run') return JSON.stringify({ exitCode: 0, stdout: 'legacy\n' });
      return JSON.stringify({ error: 'unknown bridge method', code: 'bridge-method-missing' });
    }
  };
  const runtime = new RuntimeAdapter({ bridge });
  const result = await runtime.runFile('src/legacy.py', { fileContent: 'print("legacy")\n' });
  assert.equal(result.output, 'legacy\n');
  assert.ok(calls.some((call) => call.method === 'run'));
  assert.ok(!calls.some((call) => call.method === 'runFile'));
  assert.deepEqual(await runtime.activatePack('missing-pack'), { ok: false, supported: false, packId: 'missing-pack' });
});

test('runtime stop waits for a matching terminal event after native acknowledgement', async () => {
  const events = [];
  let runtimeEvent;
  const bridge = {
    subscribe(channel, listener) {
      assert.equal(channel, 'runtime');
      runtimeEvent = listener;
      return () => { runtimeEvent = null; };
    },
    async request(channel, method, payload) {
      assert.equal(channel, 'runtime');
      if (method === 'capabilities') {
        return { available: true, protocolVersion: 2, methods: ['runFile', 'stop'] };
      }
      if (method === 'runFile') return { accepted: true, started: true, runId: payload.runId };
      if (method === 'stop') {
        return {
          ok: true,
          accepted: true,
          cancellationRequested: true,
          stopped: false,
          terminal: false
        };
      }
      throw new Error('unexpected method: ' + method);
    }
  };
  const runtime = new RuntimeAdapter({ bridge });
  runtime.subscribe((event) => events.push(event));
  await runtime.ready;
  await runtime.runFile('src/long.py');

  let settled = false;
  const stopping = runtime.stop().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(runtime.running.phase, 'stopping');
  assert.ok(events.some((event) => event.type === 'stopping'));
  assert.ok(!events.some((event) => event.type === 'stopped'));

  runtimeEvent({ type: 'finished', runId: 'run-1', exitCode: 130, cancelled: true });
  const result = await stopping;
  assert.equal(result.terminal.type, 'stopped');
  assert.equal(runtime.running, null);
  assert.ok(events.some((event) => event.type === 'stopped'));
  runtime.dispose();
});

test('runtime stop preserves the active run when native does not acknowledge it', async () => {
  const events = [];
  let runtimeEvent;
  const bridge = {
    subscribe(channel, listener) {
      runtimeEvent = listener;
      return () => { runtimeEvent = null; };
    },
    async request(channel, method, payload) {
      if (method === 'capabilities') {
        return { available: true, protocolVersion: 2, methods: ['runFile', 'stop'] };
      }
      if (method === 'runFile') return { accepted: true, started: true, runId: payload.runId };
      if (method === 'stop') return { ok: false, accepted: false, stopped: false };
      throw new Error('unexpected method: ' + method);
    }
  };
  const runtime = new RuntimeAdapter({ bridge });
  runtime.subscribe((event) => events.push(event));
  await runtime.ready;
  await runtime.runFile('src/long.py');

  await assert.rejects(
    () => runtime.stop(),
    (error) => error.code === 'stop-not-acknowledged'
  );
  assert.equal(runtime.running.runId, 'run-1');
  assert.equal(runtime.running.phase, 'running');
  assert.ok(events.some((event) => event.type === 'stop-failed'));
  assert.ok(!events.some((event) => event.type === 'stopped'));

  runtimeEvent({ type: 'finished', runId: 'run-1', exitCode: 0, cancelled: false });
  assert.equal(runtime.running, null);
  runtime.dispose();
});

test('runtime stop cannot be undone by a late runFile acknowledgement', async () => {
  let runtimeEvent;
  let acceptStart;
  const startGate = new Promise((resolve) => { acceptStart = resolve; });
  const bridge = {
    subscribe(channel, listener) {
      runtimeEvent = listener;
      return () => { runtimeEvent = null; };
    },
    async request(channel, method, payload) {
      if (method === 'capabilities') {
        return { available: true, protocolVersion: 2, methods: ['runFile', 'stop'] };
      }
      if (method === 'runFile') return startGate;
      if (method === 'stop') {
        return { ok: true, accepted: true, cancellationRequested: true, stopped: false };
      }
      throw new Error('unexpected method: ' + method);
    }
  };
  const runtime = new RuntimeAdapter({ bridge });
  await runtime.ready;
  const starting = runtime.runFile('src/late.py');
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runtime.stop();
  await new Promise((resolve) => setImmediate(resolve));
  acceptStart({ accepted: true, started: true, runId: 'run-1' });
  await starting;

  assert.equal(runtime.running.phase, 'stopping');
  runtimeEvent({ type: 'finished', runId: 'run-1', exitCode: 130, cancelled: true });
  await stopping;
  assert.equal(runtime.running, null);
  runtime.dispose();
});

test('runtime clears its provisional state when run admission fails', async () => {
  const bridge = {
    subscribe() { return () => {}; },
    async request(channel, method) {
      if (method === 'capabilities') {
        return { available: true, protocolVersion: 2, methods: ['runFile', 'stop'] };
      }
      if (method === 'runFile') throw new Error('Another Python run is already active');
      throw new Error('unexpected method: ' + method);
    }
  };
  const runtime = new RuntimeAdapter({ bridge });
  await runtime.ready;
  await assert.rejects(() => runtime.runFile('src/busy.py'), /Another Python run/);
  assert.equal(runtime.running, null);
  runtime.dispose();
});
