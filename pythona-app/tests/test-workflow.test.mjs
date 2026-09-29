import test from 'node:test';
import assert from 'node:assert/strict';
import { LanguageService, LocalLanguageProvider } from '../src/core/language-service.js';
import { RunConfigurationStore, normalizeRunConfiguration } from '../src/core/run-configurations.js';
import { TestAdapter, normalizeTestResult } from '../src/core/test-adapter.js';
import { WorkspaceStore } from '../src/core/workspace-store.js';
import { DocumentSession } from '../src/core/document-session.js';
import { captureRenameBase, createRenameTransaction, validateRenameBase } from '../src/core/refactor.js';

test('language service exposes workspace references and atomic rename input', async () => {
  const provider = new LocalLanguageProvider();
  const language = new LanguageService({ providers: [provider] });
  await language.openDocument({ path: 'src/a.py', text: 'value = 1\nprint(value)\n' });
  await language.openDocument({ path: 'src/b.py', text: 'from src.a import value\nprint(value)\n' });
  const refs = await language.references({ uri: 'pythona://workspace/src/a.py', position: { line: 0, character: 2 }, version: 1, epoch: 1 });
  assert.equal(refs.result.length, 4);
  await assert.rejects(() => language.rename({ uri: 'pythona://workspace/src/a.py', position: { line: 0, character: 2 }, version: 1, epoch: 1, newName: 'renamed' }), { code: 'refactor-unsupported' });
  await assert.rejects(() => language.rename({ uri: 'pythona://workspace/src/a.py', position: { line: 0, character: 2 }, version: 1, epoch: 1, newName: 'not valid' }), { code: 'invalid-rename' });
  language.dispose();
});

test('test adapter preserves structured completion events and cancellation', async () => {
  let listener;
  const broker = {
    available: true,
    subscribe(channel, callback) {
      if (channel === 'test') listener = callback;
      return () => {};
    },
    request(channel, method, payload) {
      assert.equal(channel, 'test');
      if (method === 'run') {
        queueMicrotask(() => listener({ type: 'started', runId: payload.runId }));
        queueMicrotask(() => listener({ type: 'output', runId: payload.runId, stream: 'stdout', text: 'ok\n' }));
        queueMicrotask(() => listener({ type: 'finished', runId: payload.runId, result: { framework: 'pytest', status: 'passed', counts: { collected: 1, passed: 1 }, cases: [{ id: 'tests/test_ok.py::test_ok', path: 'tests/test_ok.py', outcome: 'passed' }] } }));
        return Promise.resolve({ accepted: true, runId: payload.runId });
      }
      if (method === 'cancel') return Promise.resolve({ accepted: true, cancelled: true, runId: payload.runId });
      return Promise.resolve({ available: true, framework: 'pytest', methods: ['capabilities', 'discover', 'run', 'cancel'] });
    }
  };
  const adapter = new TestAdapter({ bridge: broker });
  const accepted = await adapter.run({ paths: ['tests'] });
  const result = await adapter.wait(accepted.runId);
  assert.equal(result.framework, 'pytest');
  assert.equal(result.counts.passed, 1);
  assert.equal(result.stdout, 'ok\n');
  assert.equal(adapter.running, null);
  assert.deepEqual(await adapter.cancel(accepted.runId), { accepted: true, cancelled: true, runId: accepted.runId });
  adapter.dispose();
});

test('test run configurations carry framework, paths and node id', () => {
  const config = normalizeRunConfiguration({ type: 'test', name: 'Tests', paths: ['tests'], framework: 'unittest', nodeId: 'Case.test_ok', testArgs: ['-q'] });
  assert.equal(config.type, 'test');
  assert.equal(config.framework, 'unittest');
  assert.deepEqual(config.paths, ['tests']);
  assert.equal(config.nodeId, 'Case.test_ok');
  assert.deepEqual(config.testArgs, ['-q']);
});

test('test result normalizer applies bounded, explicit outcome fields', () => {
  const result = normalizeTestResult({ framework: 'unittest', counts: { collected: 1, errors: 1 }, cases: [{ id: 'x', outcome: 'error', traceback: 'trace' }] });
  assert.equal(result.counts.errors, 1);
  assert.equal(result.cases[0].outcome, 'error');
});

test('rename preview becomes invalid on local edits or external file revision changes', async () => {
  const store = new WorkspaceStore({ storage: null, files: { 'a.py': 'x=1\n', 'b.py': 'print(x)\n' } });
  const doc = new DocumentSession(store); doc.open('a.py');
  const base = captureRenameBase(store, doc.snapshot());
  const transaction = createRenameTransaction({ newName: 'y', changes: {
    'pythona://workspace/a.py': [{ path: 'a.py', before: 'x=1\n', newText: 'y=1\n' }],
    'pythona://workspace/b.py': [{ path: 'b.py', before: 'print(x)\n', newText: 'print(y)\n' }]
  } }, base);
  assert.equal(store.read('a.py').content, 'x=1\n');
  assert.ok(transaction.files[0].patch.operations.some(o => o.type === 'add'));
  doc.edit('x=2\n');
  assert.throws(() => validateRenameBase(store, doc.snapshot(), base, transaction), /缓冲区/);
  store.simulateExternalChange('b.py', 'print("external")\n');
  await assert.rejects(store.applyBatchAsync(transaction));
  assert.equal(store.read('a.py').content, 'x=1\n');
  assert.equal(store.read('b.py').content, 'print("external")\n');
  doc.dispose(); store.dispose();
});

test('test events cannot revive completed runs, and restart resolves pending waiters', async () => {
  const callbacks = new Map();
  const bridge = { available: true, subscribe(c, f) { callbacks.set(c, f); return () => {}; },
    async request(c, method, payload) { return { accepted: true, runId: payload.runId }; } };
  const adapter = new TestAdapter({ bridge });
  const first = await adapter.run({ runId: 'first', sessionId: 'session' });
  callbacks.get('test')({ type: 'finished', runId: 'first', sessionId: 'wrong', result: { status: 'passed' } });
  assert.equal(adapter.running.runId, 'first');
  callbacks.get('test')({ type: 'finished', runId: 'first', sessionId: 'session', result: { status: 'timeout', counts: { collected: 0 } } });
  assert.equal((await adapter.wait(first.runId)).status, 'timeout');
  callbacks.get('runtime')({ type: 'service-crashed' });
  callbacks.get('test')({ type: 'finished', runId: 'first', result: { status: 'passed' } });
  assert.equal((await adapter.wait(first.runId)).status, 'timeout');
  const second = await adapter.run({ runId: 'second' });
  callbacks.get('runtime')({ type: 'service-crashed', message: 'crash' });
  assert.equal((await adapter.wait(second.runId)).status, 'error');
  assert.equal(adapter.running, null);
  adapter.dispose();
});

test('UI normalization preserves suite totals above the retained case limit', () => {
  const r = normalizeTestResult({ framework: 'pytest', status: 'failed', counts: { collected: 510, passed: 509, failed: 1 }, cases: [], truncated: true });
  assert.equal(r.counts.collected, 510);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.status, 'failed');
});
