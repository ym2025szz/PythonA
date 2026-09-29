import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationClient } from '../src/core/conversation-client.js';

function setup() {
  const calls = [];
  const broker = { available: true, request: async (channel, method, payload) => {
    calls.push({ channel, method, payload });
    if (method === 'conversation.read') return { conversation: { id: payload.conversationId }, messages: [{ role: 'assistant', content: 'past', tools: [{ approvalId: 'retired', options: ['allow'] }] }] };
    return { conversation: { id: payload.conversationId || 'conversation-1', workspaceId: payload.workspaceId, title: payload.title, archived: payload.archived } };
  } };
  return { client: new ConversationClient(broker), calls };
}
test('conversation starts once and next turn keeps stable ID with a fresh turn ID', async () => {
  const { client, calls } = setup();
  const first = await client.beginTurn({ prompt: 'hello' });
  assert.equal(first.conversationId, 'conversation-1');
  assert.equal(client.applyEvent({ ...first, kind: 'done' }), true);
  const second = await client.beginTurn({ prompt: 'remember' });
  assert.equal(second.conversationId, first.conversationId);
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(calls.filter(call => call.method === 'conversation.create').length, 1);
});
test('stale turn terminal cannot unlock a running conversation', async () => {
  const { client } = setup();
  const turn = await client.beginTurn();
  assert.equal(client.applyEvent({ ...turn, turnId: 'previous', kind: 'done' }), false);
  assert.equal(client.applyEvent({ ...turn, workspaceId: 'other', kind: 'error' }), false);
  await assert.rejects(client.beginTurn(), /保存/);
  client.failStart(new Error('offline'));
  assert.equal(client.activeTurn, null);
});
test('history drops old approval authority and supports latest/older paging', async () => {
  const { client, calls } = setup();
  const page = await client.select('conversation-1');
  assert.equal(page.messages[0].historyReadOnly, true);
  assert.equal(page.messages[0].tools[0].approvalId, undefined);
  assert.equal(page.messages[0].tools[0].options, undefined);
  await client.read('conversation-1', { before: 50 });
  assert.equal(calls.at(-1).payload.before, 50);
  await client.saveDraft('conversation-1', 'draft');
  assert.equal(calls.at(-1).method, 'conversation.draft');
});
test('archive/restore use registry methods while browser fallback never pretends model history', async () => {
  const { client, calls } = setup();
  await client.create(); await client.archive('conversation-1');
  assert.equal(client.selected, null);
  await client.archive('conversation-1', false);
  assert.equal(calls.at(-1).payload.archived, false);
  const browser = new ConversationClient({ available: false });
  await assert.rejects(browser.create(), /不支持/);
});

function deferredClient() {
  let resolve, reject, status;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const broker = { available: true, request: () => pending,
    subscribeStatus(callback) { status = callback; return () => {}; } };
  return { client: new ConversationClient(broker), resolve, reject, disconnect: () => status({ type: 'service-disconnected' }) };
}
test('pending history selection blocks sending and other selection changes until loaded', async () => {
  const { client, resolve } = deferredClient();
  client.selected = { id: 'old' };
  const selection = client.select('restored');
  assert.equal(client.loading, true);
  await assert.rejects(client.beginTurn(), { code: 'conversation-loading' });
  await assert.rejects(client.create(), { code: 'conversation-loading' });
  await assert.rejects(client.select('other'), { code: 'conversation-loading' });
  resolve({ conversation: { id: 'restored' }, messages: [] });
  await selection;
  assert.equal(client.loading, false);
  assert.equal((await client.beginTurn()).conversationId, 'restored');
});
test('failed history selection releases loading and preserves previous selected conversation', async () => {
  const { client, reject } = deferredClient();
  client.selected = { id: 'old' };
  const selection = client.select('unavailable');
  reject(new Error('history unavailable'));
  await assert.rejects(selection, /history unavailable/);
  assert.equal(client.loading, false);
  assert.equal(client.selected.id, 'old');
  assert.equal((await client.beginTurn()).conversationId, 'old');
});
test('first turn holds loading throughout conversation creation and rejects duplicate send', async () => {
  const { client, resolve } = deferredClient();
  const first = client.beginTurn({ prompt: 'first' });
  assert.equal(client.loading, true);
  await assert.rejects(client.beginTurn({ prompt: 'duplicate' }), { code: 'conversation-loading' });
  resolve({ conversation: { id: 'new' } });
  assert.equal((await first).conversationId, 'new');
  assert.equal(client.loading, false);
  assert.equal(client.activeTurn.conversationId, 'new');
});
test('create failure releases its loading lock', async () => {
  const { client, reject } = deferredClient();
  const creating = client.create();
  assert.equal(client.loading, true);
  reject(new Error('storage error'));
  await assert.rejects(creating, /storage error/);
  assert.equal(client.loading, false);
  assert.equal(client.selected, null);
});
test('disconnect clears active turn before notifying listeners that can release the UI', async () => {
  const { client, disconnect } = deferredClient();
  await client.beginTurn({ conversationId: 'existing' });
  let interrupted;
  client.subscribe(event => {
    interrupted = event;
    assert.equal(client.activeTurn, null);
    assert.doesNotThrow(() => client.assertIdle());
  });
  disconnect();
  assert.equal(interrupted.type, 'interrupted');
  assert.equal(interrupted.conversationId, 'existing');
});

test('raw per-channel service crash interrupts a live conversation without matching turn IDs', async () => {
  const { client } = setup();
  const turn = await client.beginTurn();
  let interruption;
  client.subscribe(event => { interruption = event; assert.equal(client.activeTurn, null); });
  assert.equal(client.applyEvent({ channel: 'dsh', type: 'service-crashed', sessionId: 'dsh-service', streamId: '' }), true);
  assert.equal(interruption.type, 'interrupted');
  assert.equal(interruption.turnId, turn.turnId);
  assert.equal(interruption.code, 'service-disconnected');
  assert.equal(client.applyEvent({ ...turn, kind: 'done' }), false);
});
test('unrelated service restart leaves conversation turn and history operation untouched', async () => {
  const { client } = setup();
  const turn = await client.beginTurn();
  assert.equal(client.handleLifecycle({ channel: 'runtime', type: 'service-crashed' }), false);
  assert.equal(client.handleLifecycle({ channel: 'language', type: 'reconnecting' }), false);
  assert.equal(client.activeTurn.turnId, turn.turnId);
});
test('restart invalidates pending selection and a late old reply cannot overwrite new selection', async () => {
  const operations = [];
  const client = new ConversationClient({ available: true, request: () => new Promise((resolve, reject) => operations.push({ resolve, reject })) });
  client.selected = { id: 'original' };
  const stale = client.select('old-target');
  const rejected = assert.rejects(stale, { code: 'service-disconnected' });
  client.applyEvent({ channel: 'dsh', type: 'service-crashed', sessionId: 'dsh-service', streamId: '' });
  assert.equal(client.loading, false);
  const current = client.select('new-target');
  await rejected;
  assert.equal(client.loading, true, 'old finally must not release the new operation lock');
  operations[0].resolve({ conversation: { id: 'old-target' }, messages: [] });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(client.selected.id, 'original');
  assert.equal(client.loading, true);
  operations[1].resolve({ conversation: { id: 'new-target' }, messages: [] });
  await current;
  assert.equal(client.selected.id, 'new-target');
  assert.equal(client.loading, false);
});
test('restart during first-turn creation prevents later response from creating an active request', async () => {
  const { client, resolve } = deferredClient();
  const turn = client.beginTurn();
  const rejected = assert.rejects(turn, { code: 'service-disconnected' });
  client.applyEvent({ type: 'binding-died', sessionId: 'dsh-service', streamId: '' });
  resolve({ conversation: { id: 'retired' } });
  await rejected;
  assert.equal(client.activeTurn, null);
  assert.equal(client.selected, null);
  assert.equal(client.loading, false);
});
