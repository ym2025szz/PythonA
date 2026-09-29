import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceDiagnostics, shouldSubmitPrompt, runtimeStartupState, dshStartupState, normalizeCursorPositions, dshErrorMessage, boundDshTranscript } from '../src/core/diagnostics.js';
import { DocumentSession } from '../src/core/document-session.js';
import { collectRunResult } from '../src/core/run-result.js';
import { DshGateway } from '../src/core/dsh-gateway.js';

test('startup readiness requires actual runtime capability and an official populated model catalog', () => {
  assert.equal(runtimeStartupState({ connected: true }).state, 'error');
  assert.equal(runtimeStartupState({ available: true, python: 'CPython' }).state, 'ready');
  assert.equal(dshStartupState({ connected: true, official: true }).state, 'error');
  assert.equal(dshStartupState({ connected: true, official: true, providers: [{ official: false, models: [{ id: 'local' }] }] }).state, 'error');
  assert.equal(dshStartupState({ connected: true, official: true, providers: [{ official: true, models: [{ id: 'official' }] }] }).state, 'ready');
});

test('performance diagnostics retain bounded numeric samples, reject free text and finish each timer once', () => {
  let now = 100;
  const metrics = new PerformanceDiagnostics({ limit: 3, now: () => now });
  metrics.start('inputFrameMs'); now = 112; metrics.finish('inputFrameMs');
  assert.equal(metrics.finish('inputFrameMs'), false);
  for (const number of [1, 5, 9, 10]) metrics.record('inputFrameMs', number);
  for (const value of [Infinity, NaN, -1, 'api-key']) assert.equal(metrics.record('inputFrameMs', value), false);
  assert.equal(metrics.record('private/path/key', 10), false);
  assert.deepEqual(metrics.snapshot().metrics.inputFrameMs, { count: 3, latest: 10, p50: 9, p95: 10, max: 10 });
  assert.equal(metrics.starts.size, 0);
});

test('IME Enter and Shift Enter never submit a DSH prompt', () => {
  assert.equal(shouldSubmitPrompt({ key: 'Enter' }), true);
  assert.equal(shouldSubmitPrompt({ key: 'Enter', shiftKey: true }), false);
  assert.equal(shouldSubmitPrompt({ key: 'Enter', isComposing: true }), false);
  assert.equal(shouldSubmitPrompt({ key: 'Enter', keyCode: 229 }), false);
  assert.equal(shouldSubmitPrompt({ key: 'Enter' }, true), false);
});

test('DSH failures explain native error codes and never echo arbitrary secret-bearing errors', () => {
  assert.match(dshErrorMessage(new Error('dsh-key-required')), /配置官方 API Key/);
  assert.match(dshErrorMessage({ code: 'dsh-network-error' }), /检查网络/);
  assert.match(dshErrorMessage({ code: 'dsh-busy' }), /另一项请求/);
  assert.equal(dshErrorMessage(new Error('authorization-secret')), 'DSH 请求未完成，请检查模型配置和连接状态后重试。');
});

test('stream transcript bounds individual messages, total visible text and activity without altering patch objects', () => {
  const patch = { afterText: 'p'.repeat(80000) };
  const message = { role: 'assistant', text: 'x'.repeat(70000), patch };
  const bounded = boundDshTranscript([...Array.from({ length: 200 }, () => ({ text: 'a'.repeat(65536) })), message],
    Array.from({ length: 350 }, () => ({ title: 't'.repeat(1000), detail: 'd'.repeat(3000) })));
  assert.ok(bounded.messages.reduce((sum, item) => sum + item.text.length, 0) <= 2 * 1024 * 1024);
  assert.equal(message.text.length, 65536); assert.equal(message.omittedCharacters, 70000 - 65536);
  assert.equal(patch.afterText.length, 80000); assert.equal(bounded.activities.length, 300);
  assert.equal(bounded.activities[0].detail.length, 2048);
});

test('cursor persistence contains only bounded nonnegative integer positions for open tabs', () => {
  const paths = Array.from({ length: 120 }, (_, index) => `file${index}.py`);
  const positions = Object.fromEntries(paths.map((path, index) => [path, index]));
  positions[paths[119]] = -1;
  const result = normalizeCursorPositions(positions, paths);
  assert.equal(Object.keys(result).length, 99);
  assert.equal(result['file0.py'], undefined);
  assert.equal(result['file118.py'], 118);
});

function delayedStore() {
  let resolve;
  let reject;
  let writes = 0;
  return {
    get writes() { return writes; },
    subscribe() { return () => {}; },
    read(path) { return { path, content: 'old', revision: 1 }; },
    async flush() {},
    writeAsync(path, content) {
      writes++;
      return new Promise((yes, no) => { resolve = () => yes({ path, content, revision: 2 }); reject = no; });
    },
    resolve() { resolve(); }, reject() { reject(new Error('disk unavailable')); }
  };
}

test('save is single flight and input typed during write stays dirty', async () => {
  const store = delayedStore(); const session = new DocumentSession(store);
  session.open('main.py'); session.edit('saved');
  const first = session.saveAsync(); const second = session.saveAsync();
  assert.equal(first, second); assert.equal(store.writes, 1); assert.equal(session.snapshot().saving, true);
  session.edit('newer input'); store.resolve(); await first;
  assert.equal(session.buffer, 'newer input'); assert.equal(session.original, 'saved');
  assert.equal(session.dirty, true); assert.equal(session.saving, false);
});

test('late save does not change the newly opened tab and failed save releases its gate', async () => {
  const store = delayedStore(); const session = new DocumentSession(store);
  session.open('one.py'); session.edit('changed');
  const pending = session.saveAsync(); session.open('two.py'); store.resolve(); await pending;
  assert.equal(session.path, 'two.py'); assert.equal(session.original, 'old'); assert.equal(session.revision, 1);
  session.edit('retry'); const failing = session.saveAsync(); store.reject(); await assert.rejects(failing);
  assert.equal(session.saving, false);
  const retry = session.saveAsync(); store.resolve(); await retry;
  assert.equal(session.dirty, false);
});

test('a late saved record cannot clear a newer external revision conflict', async () => {
  const store = delayedStore(); const session = new DocumentSession(store);
  session.open('main.py'); session.edit('mine'); const pending = session.saveAsync();
  session.conflict = { remoteRevision: 3, remote: 'external' };
  store.resolve(); await pending;
  assert.equal(session.conflict.remoteRevision, 3); assert.equal(session.dirty, true);
});

function emitter() {
  const listeners = new Set();
  return { listeners, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, emit(event) { for (const fn of listeners) fn(event); } };
}

test('DSH run feedback waits for terminal event, ignores another run and bounds output', async () => {
  const adapter = emitter(); let finished = false;
  const result = collectRunResult(adapter, async () => {
    adapter.emit({ type: 'started', runId: 'mine' });
    adapter.emit({ type: 'output', runId: 'other', text: 'private other output' });
    adapter.emit({ type: 'output', runId: 'mine', text: 'a'.repeat(70000) });
    return { accepted: true, runId: 'mine' };
  }).then(value => { finished = true; return value; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false);
  adapter.emit({ type: 'finished', runId: 'mine', exitCode: 0 });
  const value = await result;
  assert.equal(value.status, 'completed'); assert.equal(value.stdout.length, 65536); assert.equal(value.truncated, true);
  assert.equal(adapter.listeners.size, 0);
});

test('DSH run feedback captures fast completion before admission returns and rejects missing admission', async () => {
  const adapter = emitter();
  const value = await collectRunResult(adapter, async () => {
    adapter.emit({ type: 'started', runId: 'fast' });
    adapter.emit({ type: 'finished', runId: 'fast', exitCode: 1 });
    return { started: true, runId: 'fast' };
  });
  assert.equal(value.status, 'error'); assert.equal(value.exitCode, 1);
  assert.equal((await collectRunResult(adapter, async () => undefined)).status, 'error');
});

test('native credential dialog sends no secret fields and approval identity is separate from transport id', async () => {
  const calls = []; const gateway = new DshGateway({ available: true, request(...args) { calls.push(args); return Promise.resolve({}); } });
  await gateway.configureCredential({ timeoutMs: 100 });
  await gateway.respondToolApproval('approval-1', true, { result: { status: 'completed', exitCode: 0 }, timeoutMs: 20 });
  assert.deepEqual(calls[0], ['dsh', 'configureCredential', {}, { timeoutMs: 100 }]);
  assert.deepEqual(calls[1], ['dsh', 'respondToolApproval', { approvalId: 'approval-1', allowed: true, result: { status: 'completed', exitCode: 0 } }, { timeoutMs: 20 }]);
  gateway.dispose();
});
