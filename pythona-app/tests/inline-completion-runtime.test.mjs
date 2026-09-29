import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const inline = require('../../android/app/src/main/assets/pythona-inline-completion.cjs');
const request = extra => ({ completionId: 'fixture', provider: 'custom', model: 'model', prefix: 'def hello():\n    ', suffix: '\n', ...extra });
function setup(chunks, model = {}) {
  const calls = [];
  const ctx = { llm: {
    async resolveModelInfo() { return model; },
    async *stream(value) { calls.push(value); for (const chunk of chunks) yield chunk; },
  } };
  Object.defineProperty(ctx, 'agents', { get() { throw new Error('must not use Agent'); } });
  return { runtime: inline.create(ctx, value => ({ role: 'user', ...value })), calls };
}
test('inline official route is one LLM request with no Agent/session/MCP/tools or exposed partials', async () => {
  const { runtime, calls } = setup([{ type: 'text-delta', text: 'return ' }, { type: 'text-delta', text: '42' },
    { type: 'finish', reason: { kind: 'stop' } }], { reasoning: { efforts: [{ id: 'high' }, { id: 'low' }, { id: 'off' }] } });
  const result = await runtime.complete(request());
  assert.equal(result.text, 'return 42');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].maxTokens, 256);
  assert.equal(calls[0].reasoningEffort, 'off');
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[0].messages.length, 1);
  assert.match(calls[0].messages[0].content[0].text, /<prefix>/);
});
test('non-reasoning model omits unsupported effort; provider errors do not auto retry', async () => {
  const { runtime, calls } = setup([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }]);
  assert.equal((await runtime.complete(request())).error.code, 'inline-auth');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, undefined);
});
test('tool calls and oversized/too-many-line/token outputs are rejected whole', async () => {
  for (const chunks of [
    [{ type: 'tool-call-delta', name: 'read_file', argumentsDelta: '{}' }],
    [{ type: 'text-delta', text: 'a'.repeat(2049) }],
    [{ type: 'text-delta', text: 'a\n'.repeat(8) }],
    [{ type: 'text-delta', text: '```python\npass\n```' }],
    [{ type: 'text-delta', text: 'good' }, { type: 'usage', usage: { outputTokens: 257 } }],
  ]) {
    const { runtime } = setup(chunks);
    const result = await runtime.complete(request());
    assert.equal(result.status, 'error'); assert.equal(result.text, undefined);
  }
});
test('current-file context limits reject before calling model', async () => {
  const { runtime, calls } = setup([]);
  for (const extra of [{ prefix: 'a'.repeat(6145) }, { suffix: '你'.repeat(700) }, { completionId: '../bad' }]) {
    assert.equal((await runtime.complete(request(extra))).status, 'error');
  }
  assert.equal(calls.length, 0);
});
test('chat priority cancels only the independent inline controller', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const runtime = inline.create({ llm: { async resolveModelInfo() { return {}; }, async *stream(value) {
    started(); await new Promise(resolve => value.signal.addEventListener('abort', resolve, { once: true }));
  } } }, value => value);
  const pending = runtime.complete(request());
  await entered;
  assert.equal((await runtime.complete(request({ completionId: 'second' }))).error.code, 'inline-busy');
  assert.equal(runtime.cancel('wrong-id').cancelled, false);
  assert.equal(runtime.cancelActive().cancelled, true);
  assert.equal((await pending).status, 'cancelled');
});
test('bounded deadline does not wait forever for an adapter that ignores cancellation', async () => {
  const runtime = inline.create({ llm: { async resolveModelInfo() { return {}; }, async *stream() {
    await new Promise(() => {});
  } } }, value => value, { timeoutMs: 5 });
  assert.equal((await runtime.complete(request())).error.code, 'inline-timeout');
});
test('cancel arriving just before queued complete prevents a charged late request', async () => {
  const { runtime, calls } = setup([{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }]);
  runtime.cancel('fixture');
  assert.equal((await runtime.complete(request())).status, 'cancelled');
  assert.equal(calls.length, 0);
});
test('capability only advertises actual official LLM primitives', async () => {
  const missing = inline.create({}, value => value);
  assert.equal(missing.capabilities().available, false);
  assert.equal((await missing.complete(request())).error.code, 'inline-unavailable');
  const partial = inline.create({ llm: { stream() {} } }, value => value);
  assert.equal(partial.capabilities().available, false);
  const { runtime } = setup([]);
  assert.deepEqual(runtime.capabilities(), { version: 1, available: true, execution: 'llm-only', tools: false, sessions: false });
});
