import test from 'node:test';
import assert from 'node:assert/strict';
import { InlineCompletionClient } from '../src/core/inline-completion-client.js';
import { InlineCompletionController, inlineContext, validInlineText } from '../src/core/inline-completion-controller.js';

const snap = () => ({ path: 'src/main.py', uri: 'pythona://default/src/main.py', workspaceId: 'default', epoch: 1,
  bufferVersion: 1, cursor: 4, selection: { anchor: 4, head: 4 }, selectionVersion: 1,
  modelSelectionVersion: 1, generation: 1, codeUpload: true, text: 'foo.\n', focused: true });
const selection = () => ({ provider: 'p', model: 'm', officialMode: true, modelSelectionVersion: 1, generation: 1 });
function fakeClock() {
  let now = 0, counter = 0; const timers = new Map();
  return { clock: () => now, setTimer: (fn, delay) => { timers.set(++counter, { fn, at: now + delay }); return counter; },
    clearTimer: id => timers.delete(id), async tick(delta) {
      now += delta;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await Promise.resolve(); await Promise.resolve();
    } };
}
function fixture() {
  const time = fakeClock(); const snapshot = snap(); const model = selection();
  const calls = [], suggestions = [], states = [];
  const client = { available: true, complete: (payload, options) => new Promise(resolve => calls.push({ payload, options, resolve })) };
  const controller = new InlineCompletionController({ client, getSnapshot: () => snapshot, getSelection: () => model,
    onSuggestion: value => suggestions.push(value), onState: value => states.push(value), ...time });
  return { controller, snapshot, model, calls, suggestions, states, time };
}
test('idle completion waits 800ms, sends only bounded current-file context and final suggestion', async () => {
  const h = fixture(); h.controller.schedule();
  await h.time.tick(799); assert.equal(h.calls.length, 0);
  await h.time.tick(1); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.prefix, 'foo.');
  assert.equal(h.calls[0].payload.suffix, '\n');
  assert.equal(h.calls[0].payload.tools, undefined);
  assert.equal(h.suggestions.filter(Boolean).length, 0);
  h.calls[0].resolve({ status: 'completed', text: 'bar()' }); await h.time.tick(0);
  assert.equal(h.suggestions.at(-1).text, 'bar()');
  h.controller.dispose();
});
test('edits cancel inference; old completion cannot create ghost or overwrite editor', async () => {
  const h = fixture(); h.controller.schedule(); await h.time.tick(800);
  h.snapshot.bufferVersion++; h.controller.invalidate('edit'); h.controller.schedule();
  assert.equal(h.calls[0].options.signal.aborted, true);
  h.calls[0].resolve({ status: 'completed', text: 'stale' }); await h.time.tick(0);
  assert.equal(h.suggestions.filter(Boolean).length, 0);
  await h.time.tick(2999); assert.equal(h.calls.length, 1);
  await h.time.tick(1); assert.equal(h.calls.length, 2);
  h.controller.dispose();
});
test('IME, selection, disabled upload, browser absence and sensitive context never call provider', async () => {
  for (const extra of [{ composing: true }, { codeUpload: false }, { focused: false }, { diff: true },
    { selection: { anchor: 2, head: 4 } }, { text: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX', cursor: 27, selection: { anchor: 27, head: 27 } }]) {
    const h = fixture(); Object.assign(h.snapshot, extra); h.controller.schedule(); await h.time.tick(5000);
    assert.equal(h.calls.length, 0); h.controller.dispose();
  }
  const h = fixture(); h.controller.client.available = false; h.controller.schedule(); await h.time.tick(5000);
  assert.equal(h.calls.length, 0); h.controller.dispose();
});
test('provider errors cool down 30s with no auto retry; auth pauses until explicit reset or model change', async () => {
  const h = fixture(); h.controller.schedule(); await h.time.tick(800);
  h.calls[0].resolve({ status: 'error', error: { code: 'inline-provider-error' } }); await h.time.tick(0);
  h.snapshot.bufferVersion++; h.controller.schedule(); await h.time.tick(29999); assert.equal(h.calls.length, 1);
  await h.time.tick(1); assert.equal(h.calls.length, 1); // No automatic retry timer.
  h.controller.schedule(); await h.time.tick(800); assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ status: 'error', error: { code: 'inline-auth' } }); await h.time.tick(0);
  h.snapshot.bufferVersion++; h.controller.schedule(); await h.time.tick(60000); assert.equal(h.calls.length, 2);
  h.model.modelSelectionVersion++; h.controller.schedule(); await h.time.tick(800); assert.equal(h.calls.length, 3);
  h.controller.dispose();
});
test('dismissed unchanged snapshot is never automatically regenerated', async () => {
  const h = fixture(); h.controller.schedule(); await h.time.tick(800);
  h.calls[0].resolve({ status: 'completed', text: 'x' }); await h.time.tick(0);
  h.controller.reject(); h.controller.schedule(); await h.time.tick(60000); assert.equal(h.calls.length, 1);
  h.controller.dispose();
});
test('request budget is twelve per rolling minute and allows only one in flight', async () => {
  const h = fixture();
  for (let i = 0; i < 12; i++) {
    h.snapshot.bufferVersion++;
    h.controller.schedule(); await h.time.tick(3000);
    assert.equal(h.calls.length, i + 1);
    h.controller.schedule(); await h.time.tick(0); assert.equal(h.calls.length, i + 1);
    h.calls[i].resolve({ status: 'completed', text: '' }); await h.time.tick(0);
  }
  h.snapshot.bufferVersion++; h.controller.schedule(); await h.time.tick(10000);
  assert.equal(h.calls.length, 12); assert.equal(h.states.at(-1).status, 'cooldown');
  h.controller.dispose();
});
test('large files use bounded Unicode-safe excerpts and reject malformed or excessive output', () => {
  const text = '你🙂'.repeat(500000);
  const result = inlineContext({ text, cursor: 600000 });
  assert.ok(new TextEncoder().encode(result.prefix).length <= 6144);
  assert.ok(new TextEncoder().encode(result.suffix).length <= 2048);
  assert.equal(result.prefix.includes('\ufffd'), false);
  assert.equal(inlineContext({ text: '🙂', cursor: 1 }), null);
  assert.equal(inlineContext({ text: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX', cursor: 15 }), null);
  for (const value of ['a'.repeat(2049), 'a\n'.repeat(8), '```py\npass\n```']) assert.equal(validInlineText(value), false);
  assert.equal(validInlineText('    return x\n'), true);
});
test('native client requires capability and matches complete identity before resolving', async () => {
  let listener; const sent = [];
  const broker = { available: true, subscribe: (_channel, cb) => { listener = cb; return () => {}; },
    request: async (channel, method, payload) => { sent.push({ channel, method, payload }); return { accepted: true }; } };
  const client = new InlineCompletionClient(broker);
  assert.equal(client.available, false); client.setCapabilities({ version: 1, available: true });
  const payload = { ...snap(), completionId: 'c1' };
  let result;
  const promise = client.complete(payload).then(value => { result = value; });
  listener({ ...payload, kind: 'inlineCompletion', capabilityVersion: 1, status: 'completed', bufferVersion: 2, text: 'stale' });
  await Promise.resolve(); assert.equal(result, undefined);
  listener({ ...payload, kind: 'inlineCompletion', capabilityVersion: 1, status: 'completed', text: 'current' });
  await promise; assert.equal(result.text, 'current');
  assert.equal(sent[0].method, 'inlineComplete'); client.dispose();
});
test('explicit compatibility completion works with official extension unavailable and never substitutes routes', async () => {
  let listener; const sent = [];
  const broker = { available: true, subscribe: (_channel, fn) => { listener = fn; return () => {}; },
    request: async (channel, method, payload) => {
      sent.push({ channel, method, payload });
      queueMicrotask(() => listener({ ...payload, kind: 'inlineCompletion', capabilityVersion: 1, status: 'completed', text: 'compat()' }));
      return { accepted: true };
    } };
  const client = new InlineCompletionClient(broker);
  client.setCapabilities({ version: 1, available: true, officialAvailable: false, compatibilityAvailable: true });
  assert.equal(client.supports({ officialMode: true }), false); assert.equal(client.supports({ officialMode: false }), true);
  assert.equal((await client.complete({ ...snap(), completionId: 'official', officialMode: true })).error.code, 'inline-unavailable');
  assert.equal(sent.length, 0);
  const result = await client.complete({ ...snap(), completionId: 'compat', officialMode: false, profileId: 'explicit-profile' });
  assert.equal(result.text, 'compat()'); assert.equal(sent[0].payload.profileId, 'explicit-profile');
  assert.equal(sent[0].payload.officialMode, false); client.dispose();
});
test('legacy capability remains official-only and scheduler checks the selected route', async () => {
  const client = new InlineCompletionClient({ available: true }); client.setCapabilities({ version: 1, available: true });
  assert.equal(client.supports({}), true); assert.equal(client.supports({ officialMode: false }), false); client.dispose();
  const h = fixture(); h.controller.client.supports = route => route.officialMode === false;
  h.controller.schedule(); await h.time.tick(5000); assert.equal(h.calls.length, 0);
  h.model.officialMode = false; h.model.profileId = 'explicit-profile'; h.controller.schedule(); await h.time.tick(800);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].payload.officialMode, false);
  h.controller.dispose();
});
test('per-channel DSH lifecycle clears pending and capability even with dsh-service session id', async () => {
  for (const lifecycle of [
    { type: 'service-crashed', sessionId: 'dsh-service' },
    { type: 'service-disconnected', sessionId: 'dsh-service' },
    { type: 'runtime-stopped', sessionId: 'dsh-service' },
    { type: 'runtime-progress', phase: 'stopped', generation: 1 },
    { type: 'runtime-progress', phase: 'starting', generation: 2 },
  ]) {
    let receive; const invalidations = [];
    const broker = { available: true, subscribe: (_channel, fn) => { receive = fn; return () => {}; }, request: async () => ({ accepted: true }) };
    const client = new InlineCompletionClient(broker, { onInvalidate: event => invalidations.push(event) });
    client.setCapabilities({ generation: 1, inlineCompletion: { version: 1, available: true } });
    const payload = { ...snap(), completionId: 'pending' };
    const pending = client.complete(payload); receive(lifecycle);
    assert.equal((await pending).error.code, 'inline-disconnected'); assert.equal(client.available, false);
    assert.equal(client.pending.size, 0); assert.equal(invalidations.length, 1);
    receive({ ...payload, kind: 'inlineCompletion', capabilityVersion: 1, status: 'completed', text: 'old' });
    assert.equal(client.pending.size, 0); client.dispose();
  }
});
test('Runtime scoped status cannot cancel DSH inline and stale generation cannot start inference', async () => {
  let status, receive; const sent = [];
  const broker = { available: true, subscribe: (_channel, fn) => { receive = fn; return () => {}; },
    subscribeStatus: fn => { status = fn; return () => {}; },
    request: async (_channel, _method, payload) => { sent.push(payload); return { accepted: true }; } };
  const client = new InlineCompletionClient(broker);
  client.setCapabilities({ generation: 1, inlineCompletion: { version: 1, available: true } });
  assert.equal((await client.complete({ ...snap(), generation: 0, completionId: 'stale' })).error.code, 'inline-stale-generation');
  assert.equal(sent.length, 0);
  const payload = { ...snap(), completionId: 'current' }; const pending = client.complete(payload);
  status({ type: 'service-disconnected', channel: 'runtime' }); assert.equal(client.pending.size, 1); assert.equal(client.available, true);
  receive({ ...payload, kind: 'inlineCompletion', capabilityVersion: 1, status: 'completed', text: 'ok' });
  assert.equal((await pending).text, 'ok');
  status({ type: 'service-disconnected', channel: 'dsh' }); assert.equal(client.available, false); client.dispose();
});
test('lifecycle invalidation also clears a completed visible suggestion through controller subscription', async () => {
  let receive; const suggestions = []; const time = fakeClock();
  const broker = { available: true, subscribe: (_channel, fn) => { receive = fn; return () => {}; },
    request: async (_channel, method, payload) => {
      if (method === 'inlineComplete') queueMicrotask(() => receive({ ...payload, kind: 'inlineCompletion', capabilityVersion: 1, status: 'completed', text: 'visible' }));
      return { accepted: true };
    } };
  const client = new InlineCompletionClient(broker); client.setCapabilities({ generation: 1, inlineCompletion: { version: 1, available: true } });
  const controller = new InlineCompletionController({ client, getSnapshot: snap, getSelection: selection,
    onSuggestion: value => suggestions.push(value), ...time });
  controller.schedule(); await time.tick(800); await time.tick(0);
  assert.equal(suggestions.at(-1).text, 'visible');
  receive({ type: 'service-crashed', sessionId: 'dsh-service' }); assert.equal(suggestions.at(-1), null);
  controller.dispose();
});
