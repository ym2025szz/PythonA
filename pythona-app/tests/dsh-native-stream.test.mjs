import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { streamSessionEvent, transformSource, attachInline, createInline } = require('../../android/app/src/main/assets/pythona-acp-stream.cjs');

function harness() {
  const updates = [];
  const record = { agent: { session: { id: 'session-1' } }, inflight: {},
    ctx: { logger: { warn() {} } }, outputTail: Promise.resolve(),
    async notify(value) { updates.push(value.update); } };
  const assistantUpdates = async (_ctx, _session, event) => [
    ...event.data.message.content.map(block => ({
      sessionUpdate: block.type === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
      messageId: 'committed-id', content: { type: 'text', text: block.text },
    })), { sessionUpdate: 'usage_update', used: 10, size: 1024 },
  ];
  return { record, updates,
    chunk(chunk, step = 0) { return streamSessionEvent(record, {}, { type: 'assistant/chunk', data: { turn: 1, step, chunk } }, assistantUpdates); },
    message(content, extra = {}, step = 0) { return streamSessionEvent(record, {}, {
      type: 'assistant/message', data: { turn: 1, step, message: { content }, ...extra },
    }, assistantUpdates); },
    async drain() { await record.outputTail; },
  };
}

test('real text chunks are delivered before final assistant message; no duplicate committed text', async () => {
  const h = harness();
  h.chunk({ type: 'text-delta', index: 0, text: 'hello ' });
  await h.drain();
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].content.text, 'hello ');
  h.chunk({ type: 'text-delta', index: 0, text: 'world' });
  h.chunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } });
  h.message([{ type: 'text', text: 'hello world' }]);
  await h.drain();
  assert.deepEqual(h.updates.map(x => x.sessionUpdate), ['agent_message_chunk', 'agent_message_chunk', 'usage_update']);
  assert.equal(h.updates[1].messageId, h.updates[0].messageId);
});

test('reasoning and multiple text blocks preserve stream order and committed usage', async () => {
  const h = harness();
  h.chunk({ type: 'reasoning-delta', index: 0, text: 'think' });
  h.chunk({ type: 'text-delta', index: 1, text: 'first' });
  h.chunk({ type: 'text-delta', index: 2, text: 'second' });
  h.message([{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }]);
  await h.drain();
  assert.deepEqual(h.updates.map(x => x.content?.text), ['think', 'first', 'second', undefined]);
  assert.deepEqual(h.updates.slice(0, 3).map(x => x._meta?.pythonaBlockIndex), [0, 1, 2]);
  assert.equal(h.updates.at(-1).size, 1024);
});

test('block boundaries retain exact Markdown without inventing whitespace in model text', async () => {
  const h = harness();
  h.chunk({ type: 'text-delta', index: 0, text: '20. 易读。' });
  h.chunk({ type: 'text-delta', index: 1, text: '```python\n' });
  h.chunk({ type: 'text-delta', index: 1, text: 'pass\n```' });
  h.message([{ type: 'text', text: '20. 易读。' }, { type: 'text', text: '```python\npass\n```' }]);
  await h.drain();
  assert.deepEqual(h.updates.slice(0, 3).map(x => x._meta?.pythonaBlockIndex), [0, 1, 1]);
  assert.equal(h.updates.slice(0, 3).map(x => x.content.text).join(''), '20. 易读。```python\npass\n```');
});

test('committed remainder preserves a matching streamed block identity', async () => {
  const h = harness();
  h.chunk({ type: 'text-delta', index: 3, text: 'prefix' });
  h.message([{ type: 'text', text: 'prefix suffix' }]);
  await h.drain();
  assert.equal(h.updates[1].content.text, ' suffix');
  assert.equal(h.updates[1]._meta.pythonaBlockIndex, 3);
});

test('interrupted committed prefixes are neither duplicated nor discarded', async () => {
  const h = harness();
  h.chunk({ type: 'text-delta', index: 0, text: 'partial' });
  h.chunk({ type: 'finish', reason: { kind: 'aborted' } });
  h.message([{ type: 'text', text: 'partial' }], { interrupted: true });
  await h.drain();
  assert.deepEqual(h.updates.map(x => x.sessionUpdate), ['agent_message_chunk', 'usage_update']);
});

test('retry retracts only failed attempt and creates a new stream identity', async () => {
  const h = harness();
  h.chunk({ type: 'text-delta', index: 0, text: 'failed-prefix' });
  h.chunk({ type: 'finish', reason: { kind: 'error' } });
  h.chunk({ type: 'text-delta', index: 0, text: 'retry-ok' });
  h.message([{ type: 'text', text: 'retry-ok' }]);
  await h.drain();
  assert.equal(h.updates[1].sessionUpdate, 'pythona_stream_reset');
  assert.equal(h.updates[1].reason, 'retry');
  assert.equal(h.updates[1].messageId, h.updates[0].messageId);
  assert.notEqual(h.updates[2].messageId, h.updates[0].messageId);
  assert.equal(h.updates[2].content.text, 'retry-ok');
});

test('committed reconciliation replaces only mismatched live segment', async () => {
  const h = harness();
  h.chunk({ type: 'text-delta', index: 0, text: 'draft' });
  h.message([{ type: 'text', text: 'final' }]);
  await h.drain();
  assert.equal(h.updates[1].reason, 'reconcile');
  assert.equal(h.updates[2].content.text, 'final');
  assert.equal(h.updates[2].messageId, h.updates[0].messageId);
});

test('block-end-only providers retain actual block delivery and independent steps', async () => {
  const h = harness();
  h.chunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'one' } });
  h.message([{ type: 'text', text: 'one' }]);
  h.chunk({ type: 'text-delta', index: 0, text: 'two' }, 1);
  h.message([{ type: 'text', text: 'two' }], {}, 1);
  await h.drain();
  assert.equal(h.updates.filter(x => x.content).map(x => x.content.text).join(''), 'onetwo');
  assert.notEqual(h.updates[0].messageId, h.updates[2].messageId);
  assert.equal(h.message([{ type: 'text', text: 'external-producer' }], {}, 2), false);
});

test('transport failure records error without appending sensitive exception strings to logs', async () => {
  const h = harness();
  const logs = [];
  h.record.ctx.logger.warn = value => logs.push(value);
  h.record.notify = async () => { throw new Error('credential-is-not-for-logs'); };
  h.chunk({ type: 'text-delta', index: 0, text: 'hello' });
  await h.drain();
  assert.ok(h.record.inflight.outputError);
  assert.equal(logs.some(x => x.includes('credential')), false);
});

test('adapter fails closed on changed upstream source', () => {
  assert.throws(() => transformSource('changed source'), /version-mismatch/);
});

test('stream bounds stop the agent once and keep later chunks out of the queue', async () => {
  const h = harness();
  let cancelled = 0;
  h.record.agent.cancel = () => cancelled++;
  h.chunk({ type: 'text-delta', index: 0, text: 'a'.repeat(1024 * 1024) });
  h.chunk({ type: 'text-delta', index: 0, text: 'overflow' });
  h.chunk({ type: 'text-delta', index: 0, text: 'ignored' });
  h.message([{ type: 'text', text: 'a'.repeat(1024 * 1024) + 'overflow' }]);
  await h.drain();
  assert.equal(cancelled, 1);
  assert.match(h.record.inflight.outputError.message, /stream-limit/);
  assert.equal(h.updates.length, 1);
});

test('adapter hooks the pinned unmodified official ACP source', { skip: !existsSync(new URL('../../.runtime-cache/dsh-src/usr/local/lib/node_modules/@deepseek-ai/dsh-acp/lib/index.js', import.meta.url)) }, () => {
  const source = readFileSync(new URL('../../.runtime-cache/dsh-src/usr/local/lib/node_modules/@deepseek-ai/dsh-acp/lib/index.js', import.meta.url));
  const transformed = transformSource(source);
  assert.ok(transformed.includes('pythonaAcpStream.streamSessionEvent(this, session, event, assistantUpdates)'));
  assert.ok(transformed.includes('record.onSessionEvent(session, event)'));
  assert.ok(transformed.includes('"pythona/inline_capabilities"'));
  assert.equal(transformed.includes('import pythonaInlineModule'), false);
});

test('inline-only hook mismatch keeps verified base streaming source intact', () => {
  const base = 'import pythonaAcpStream from "file:///root/.pythona-acp-stream.cjs";\n// already verified streaming';
  assert.equal(attachInline(base, 'file:///root/.pythona-acp-stream.cjs'), base);
});

test('missing or broken optional inline module does not abort ACP or chat cancellation', async () => {
  for (const load of [() => { throw new Error('private broken-module detail'); },
    () => ({ create() { throw new Error('private runtime detail'); } }), () => ({ create: () => ({}) })]) {
    const controller = createInline({}, value => value, 'file:///unused.cjs', load);
    assert.equal(controller.capabilities().available, false);
    assert.equal((await controller.complete({})).error.code, 'inline-unavailable');
    assert.equal(controller.cancelActive().cancelled, false);
    assert.equal(JSON.stringify(controller.capabilities()).includes('private'), false);
  }
});

test('native optional-asset copy failure disables stale inline code without stopping ACP', () => {
  const previous = process.env.PYTHONA_INLINE_DISABLED;
  process.env.PYTHONA_INLINE_DISABLED = '1';
  try {
    let loaded = false;
    const controller = createInline({}, value => value, 'file:///stale.cjs', () => { loaded = true; return {}; });
    assert.equal(loaded, false);
    assert.equal(controller.capabilities().available, false);
  } finally {
    if (previous === undefined) delete process.env.PYTHONA_INLINE_DISABLED;
    else process.env.PYTHONA_INLINE_DISABLED = previous;
  }
});
