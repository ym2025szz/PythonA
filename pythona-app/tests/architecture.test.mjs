import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkspaceStore, RevisionConflictError } from '../src/core/workspace-store.js';
import { DocumentSession } from '../src/core/document-session.js';
import { createMultiFilePatch } from '../src/core/patch-engine.js';
import { DshAgentController } from '../src/core/dsh-controller.js';
import { DshGateway } from '../src/core/dsh-gateway.js';
import { ProjectContextIndexer } from '../src/core/context-indexer.js';
import { ProjectIndexService } from '../src/core/project-index.js';
import { ProjectModelService } from '../src/core/project-model.js';
import { RunConfigurationStore } from '../src/core/run-configurations.js';
import { createDefaultServiceRegistry, SERVICE_KINDS } from '../src/core/service-registry.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

test('multi-file patches commit atomically and reject a stale member without partial writes', async () => {
  const store = new WorkspaceStore({ storage: new MemoryStorage(), files: { 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' } });
  const a = store.read('a.py');
  const b = store.read('b.py');
  const transaction = createMultiFilePatch([
    { path: a.path, beforeText: a.content, afterText: 'a = 2\n', baseRevision: a.revision, baseSha256: a.hash },
    { path: b.path, beforeText: b.content, afterText: 'b = 2\n', baseRevision: b.revision, baseSha256: b.hash }
  ]);
  const result = await store.applyBatchAsync(transaction, { source: 'dsh' });
  assert.equal(result.files.length, 2);
  assert.equal(store.read('a.py').content, 'a = 2\n');
  assert.equal(store.read('b.py').content, 'b = 2\n');

  const currentA = store.read('a.py');
  const currentB = store.read('b.py');
  const stale = createMultiFilePatch([
    { path: 'a.py', beforeText: currentA.content, afterText: 'a = 3\n', baseRevision: currentA.revision - 1, baseSha256: currentA.hash },
    { path: 'b.py', beforeText: currentB.content, afterText: 'b = 3\n', baseRevision: currentB.revision, baseSha256: currentB.hash }
  ]);
  await assert.rejects(store.applyBatchAsync(stale), RevisionConflictError);
  assert.equal(store.read('a.py').content, 'a = 2\n');
  assert.equal(store.read('b.py').content, 'b = 2\n');
});

test('project model migrates a 0.2 workspace and run configurations restore completely', async () => {
  const storage = new MemoryStorage();
  const project = new ProjectModelService({ storage, workspaceName: 'ml-playground' });
  const model = await project.open();
  assert.equal(model.schemaVersion, 1);
  assert.deepEqual(model.modules[0].sourceRoots, ['src']);
  assert.deepEqual(model.modules[0].testRoots, ['tests']);
  assert.equal(project.getInterpreter().id, 'bundled-cpython');

  const runs = new RunConfigurationStore({ storage });
  await runs.open();
  const saved = await runs.create({
    name: 'Train', targetKind: 'module', target: 'src.train', args: ['--epochs', '3'],
    workingDirectory: '/', environment: { TOKEN: 'not-logged' }, envFiles: ['.env']
  });
  const restored = new RunConfigurationStore({ storage });
  await restored.open();
  assert.deepEqual(restored.resolve(saved.id).args, ['--epochs', '3']);
  assert.deepEqual(restored.resolve(saved.id).environment, { TOKEN: 'not-logged' });
  assert.equal(restored.resolve('current-file', 'src/train.py').temporary, true);
});

test('incremental project index supports text, symbols, definitions and import context', async () => {
  const store = new WorkspaceStore({ storage: new MemoryStorage(), files: {
    'src/main.py': 'from src.helper import greet\n\ngreet()\n',
    'src/helper.py': 'def greet():\n    return "你好"\n'
  } });
  const index = new ProjectIndexService({ workspace: store });
  assert.equal(index.status().state, 'stale');
  await index.index();
  assert.equal(index.status().state, 'ready');
  assert.ok((await index.search('greet')).some((item) => item.kind === 'symbol'));
  assert.equal((await index.symbols('src/helper.py'))[0].qualifiedName, 'greet');
  const definition = await index.definition('src/main.py', { line: 2, character: 3 });
  assert.equal(definition.path, 'src/helper.py');
  assert.deepEqual((await index.contextForRequest({ path: 'src/main.py' })).map((item) => item.path), [
    'src/main.py', 'src/helper.py'
  ]);
});

test('context manifests honor selection priority, .pyaignore and secret redaction', async () => {
  const fixtureKey = ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const store = new WorkspaceStore({ storage: new MemoryStorage(), files: {
    '.pyaignore': 'ignored/**\n',
    'src/main.py': `API_KEY=${fixtureKey}\nprint("full file")\n`,
    'ignored/data.py': 'do_not_upload = True\n'
  } });
  const index = new ProjectIndexService({ workspace: store });
  await index.index();
  const context = new ProjectContextIndexer({ workspace: store, projectIndex: index });
  const manifest = await context.build({
    path: 'src/main.py', selection: { text: `TOKEN=${fixtureKey}` },
    attachedFiles: ['ignored/data.py'], provider: 'Test', model: 'fixture', uploadEnabled: true
  });
  assert.equal(manifest.files[0].path, 'src/main.py');
  assert.match(manifest.files[0].content, /\[REDACTED:openai-key\]/);
  assert.doesNotMatch(manifest.files[0].content, /full file/);
  assert.ok(manifest.excluded.some((item) => item.path === 'ignored/data.py' && item.reason === 'ignored'));
  assert.equal(manifest.provider, 'Test');

  const dirtyManifest = await context.build({ path: 'src/main.py', content: 'dirty buffer = True\n' });
  assert.equal(dirtyManifest.files[0].content, 'dirty buffer = True\n');
});

test('context file limits count UTF-8 bytes while allowing a bounded selection', async () => {
  const store = new WorkspaceStore({ storage: new MemoryStorage(), files: {
    'main.py': '你好世界\n'
  } });
  const context = new ProjectContextIndexer({ workspace: store, maxFileBytes: 5 });
  const full = await context.build({ path: 'main.py' });
  assert.equal(full.files.length, 0);
  assert.ok(full.excluded.some((item) => item.path === 'main.py' && item.reason === 'too-large'));
  const selection = await context.build({ path: 'main.py', selection: { text: '你' } });
  assert.equal(selection.files[0].content, '你');
  assert.equal(selection.files[0].bytes, 3);
});

test('DSH gateway cannot lose an immediately emitted first event', async () => {
  let listener;
  const broker = {
    available: true,
    subscribe(channel, callback) { assert.equal(channel, 'dsh'); listener = callback; return () => {}; },
    request(channel, method, payload) {
      assert.equal(channel, 'dsh');
      if (method === 'start') {
        listener({ streamId: payload.streamId, kind: 'delta', text: '你🙂' });
        queueMicrotask(() => listener({ streamId: payload.streamId, kind: 'done' }));
        return new Promise((resolve) => setImmediate(() => resolve({ ok: true })));
      }
      if (method === 'cancel') return Promise.resolve({ cancelled: true });
      throw new Error(`unexpected method ${method}`);
    }
  };
  const gateway = new DshGateway(broker);
  const events = [];
  for await (const event of gateway.stream({ prompt: 'hello' })) events.push(event);
  assert.deepEqual(events.map((event) => event.kind), ['delta', 'done']);
  assert.equal(events[0].text, '你🙂');
  gateway.dispose();
});

test('DSH gateway keeps raw buffers out of native transport and rejects mismatched event identity', async () => {
  let listener;
  let transported;
  const broker = {
    available: true,
    subscribe(channel, callback) { assert.equal(channel, 'dsh'); listener = callback; return () => {}; },
    request(channel, method, payload) {
      assert.equal(channel, 'dsh');
      if (method === 'start') {
        transported = payload;
        queueMicrotask(() => {
          listener({ ...payload, kind: 'delta', sessionId: 'old-session', text: 'stale-session' });
          listener({ ...payload, kind: 'delta', uri: 'file:///workspace/old.py', text: 'stale-uri' });
          listener({ ...payload, kind: 'delta', text: 'safe' });
          listener({ ...payload, kind: 'done' });
        });
        return new Promise((resolve) => setImmediate(() => resolve({ ok: true })));
      }
      if (method === 'cancel') return Promise.resolve({ cancelled: true });
      throw new Error(`unexpected method ${method}`);
    }
  };
  const gateway = new DshGateway(broker);
  const events = [];
  for await (const event of gateway.stream({
    prompt: 'inspect', content: 'raw-secret-buffer', sessionId: 'current-session',
    epoch: 3, workspaceId: 'default', uri: 'file:///workspace/main.py', bufferVersion: 7,
    context: { files: [{ path: 'main.py', content: '[REDACTED]' }] }
  })) events.push(event);
  assert.equal(Object.hasOwn(transported, 'content'), false);
  assert.deepEqual(events.map((event) => event.text).filter(Boolean), ['safe']);
  gateway.dispose();
});

test('DSH accepts a normalized single-file patch preview without writing early', async () => {
  const store = new WorkspaceStore({ storage: new MemoryStorage(), files: { 'main.py': 'value = 1\n' } });
  const document = new DocumentSession(store);
  await document.openAsync('main.py');
  const gateway = {
    async *stream() {
      yield {
        kind: 'patch_preview',
        patch: { path: 'main.py', before: 'value = 1\n', after: 'value = 2\n' },
        summary: 'preview'
      };
      yield { kind: 'done' };
    },
    cancel() { return Promise.resolve({ cancelled: true }); }
  };
  const controller = new DshAgentController({ store, document, gateway });
  await controller.start('change value');
  assert.equal(store.read('main.py').content, 'value = 1\n');
  assert.equal(controller.pending.transaction.files[0].afterText, 'value = 2\n');
  await controller.acceptAsync();
  assert.equal(store.read('main.py').content, 'value = 2\n');
  document.dispose();
});

test('DSH fallback context redacts secrets when no indexer is supplied', async () => {
  const fixtureKey = ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const store = new WorkspaceStore({ storage: new MemoryStorage(), files: { 'main.py': `KEY=${fixtureKey}\n` } });
  const document = new DocumentSession(store);
  await document.openAsync('main.py');
  let captured;
  const gateway = {
    async *stream(request) {
      captured = request;
      yield { kind: 'done' };
    },
    cancel() { return Promise.resolve(); }
  };
  const controller = new DshAgentController({ store, document, gateway });
  await controller.start('inspect');
  assert.doesNotMatch(captured.context.files[0].content, /sk-[A-Za-z0-9_-]{20,}/);
  assert.match(captured.context.files[0].content, /\[REDACTED:openai-key\]/);
  document.dispose();
});

test('DSH redacts prompts and indexed search results before provider transport', async () => {
  const fixtureKey = ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
  const store = new WorkspaceStore({ storage: new MemoryStorage(), files: { 'main.py': 'print("ok")\n' } });
  const document = new DocumentSession(store);
  await document.openAsync('main.py');
  let captured;
  const gateway = {
    async *stream(request) { captured = request; yield { kind: 'done' }; },
    cancel() { return Promise.resolve(); }
  };
  const controller = new DshAgentController({
    store, document, gateway,
    projectIndex: { async search() { return [{ kind: 'text', path: 'main.py', text: `TOKEN=${fixtureKey}` }]; } }
  });
  await controller.start(`inspect ${fixtureKey}`);
  assert.doesNotMatch(captured.prompt, /sk-[A-Za-z0-9_-]{20,}/);
  const result = await controller.executeTool({
    name: 'search_workspace', arguments: JSON.stringify({ query: 'TOKEN' })
  });
  assert.doesNotMatch(JSON.stringify(result), /sk-[A-Za-z0-9_-]{20,}/);
  await assert.rejects(
    controller.executeTool({ name: 'read_file', arguments: '{"path":"../outside.py"}' }),
    (error) => error.code === 'invalid-tool-arguments'
  );
  document.dispose();
});

test('DSH run tool blocks for approval and caps the result returned to the model', async () => {
  const store = new WorkspaceStore({ storage: new MemoryStorage(), files: { 'main.py': 'print("ok")\n' } });
  const document = new DocumentSession(store);
  await document.openAsync('main.py');
  const requests = [];
  const gateway = {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { kind: 'tool_call', callId: 'run-1', name: 'request_run', arguments: '{"configurationId":"train"}' };
        yield { kind: 'done' };
      } else {
        yield { kind: 'done' };
      }
    },
    cancel() { return Promise.resolve(); }
  };
  const controller = new DshAgentController({
    store, document, gateway,
    runtime: { runConfiguration: async () => ({ stdout: '界'.repeat(40_000) }) }
  });
  let approval;
  controller.subscribe((event) => { if (event.type === 'approval-required') approval = event; });
  const running = controller.start('run tests');
  while (!approval) await new Promise((resolve) => setImmediate(resolve));
  await controller.approveRun(approval.requestId);
  await running;
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  assert.ok(new TextEncoder().encode(toolMessage.content).length <= 32 * 1024);
  assert.match(toolMessage.content, /"truncated":true/);
  document.dispose();
});

test('registries expose all extension points and PyCharm-style tool windows', () => {
  const registry = createDefaultServiceRegistry();
  for (const kind of SERVICE_KINDS) assert.ok(registry.list(kind).length > 0, kind);
  assert.deepEqual(registry.list('ToolWindowProvider').map((item) => item.id), [
    'project', 'search', 'problems', 'packages', 'run', 'dsh', 'python-console', 'settings'
  ]);
});
