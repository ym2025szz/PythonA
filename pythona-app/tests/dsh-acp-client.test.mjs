import test from 'node:test';
import assert from 'node:assert/strict';
import { ACP_PROTOCOL_VERSION, DshAcpClient } from '../src/core/dsh-acp-client.js';

class FakeTransport {
  available = true;
  calls = [];
  events = new Set();
  statuses = new Set();
  pendingPrompt = null;
  promptAccepted = false;

  subscribe(channel, listener) {
    assert.equal(channel, 'dsh');
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  subscribeStatus(listener) {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }

  request(channel, method, payload) {
    assert.equal(channel, 'dsh');
    this.calls.push({ channel, method, payload });
    if (method === 'initialize') {
      return Promise.resolve({
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
        agentCapabilities: {
          sessionCapabilities: { close: {}, list: {}, resume: {} },
          promptCapabilities: { image: false, audio: false, embeddedContext: false }
        },
        authMethods: []
      });
    }
    if (method === 'session/new') {
      return Promise.resolve({
        sessionId: 's-1',
        configOptions: [{
          id: 'model', category: 'model', type: 'select', currentValue: '["deepseek","deepseek-v4"]',
          options: [{ group: 'deepseek', name: 'DeepSeek', options: [{ value: '["deepseek","deepseek-v4"]', name: 'deepseek-v4' }] }]
        }]
      });
    }
    if (method === 'session/resume') {
      return Promise.resolve({ sessionId: payload.sessionId, configOptions: [] });
    }
    if (method === 'session/set_config_option') {
      return Promise.resolve({ configOptions: [{ id: payload.configId, currentValue: payload.value }] });
    }
    if (method === 'session/prompt') {
      if (this.promptAccepted) return Promise.resolve({ accepted: true, requestId: 7, sessionId: payload.sessionId });
      this.pendingPrompt = {};
      return new Promise((resolve) => { this.pendingPrompt.resolve = resolve; });
    }
    if (method === 'session/cancel') return Promise.resolve({ cancelled: true, sessionId: payload.sessionId });
    if (method === 'session/close') return Promise.resolve({ closed: true, sessionId: payload.sessionId });
    if (method === 'session/list') return Promise.resolve({ sessions: [] });
    return Promise.resolve({});
  }

  emit(event) { this.events.forEach((listener) => listener(event)); }
  status(event) { this.statuses.forEach((listener) => listener(event)); }
}

async function connected() {
  const transport = new FakeTransport();
  const client = new DshAcpClient(transport, { workspaceRoot: '/data/user/0/com.pythona.app/files/workspace' });
  await client.initialize();
  return { transport, client };
}

test('ACP handshake and model catalog keep credentials out of the native payload', async () => {
  const { client, transport } = await connected();
  const session = await client.newSession();
  assert.equal(session.sessionId, 's-1');
  const initialize = transport.calls.find((call) => call.method === 'initialize');
  assert.equal(initialize.payload.clientCapabilities.fs, undefined);
  assert.equal(transport.calls.some((call) => JSON.stringify(call).includes('apiKey')), false);
  assert.equal(session.configOptions[0].options[0].options[0].name, 'deepseek-v4');
  const options = await client.setConfigOption('s-1', 'model', '["deepseek","deepseek-v4"]');
  assert.equal(options.configOptions[0].currentValue, '["deepseek","deepseek-v4"]');
  client.dispose();
});

test('ACP rejects credential fields and relative workspaces before transport', async () => {
  const { client, transport } = await connected();
  await assert.rejects(() => client.newSession({ cwd: 'relative' }), (error) => error.code === 'invalid-params');
  await assert.rejects(() => client.newSession({ cwd: '/tmp/work', apiKey: 'sk-secret' }), (error) => error.code === 'credential-field-forbidden');
  await assert.rejects(() => client.newSession({ cwd: '/tmp/work', mcpServers: [{ headers: { Authorization: 'Bearer x' } }] }), (error) => error.code === 'credential-field-forbidden');
  assert.equal(transport.calls.filter((call) => call.method === 'session/new').length, 0);
  client.dispose();
});

test('ACP prompt is single-flight and cancellation reaches official dsh', async () => {
  const { client, transport } = await connected();
  await client.newSession();
  const prompt = client.prompt('s-1', 'inspect the workspace');
  await assert.rejects(() => client.prompt('s-1', 'second prompt'), (error) => error.code === 'session-busy');
  await client.cancel('s-1');
  assert.equal(transport.calls.at(-1).method, 'session/cancel');
  assert.equal(transport.calls.at(-1).payload.sessionId, 's-1');
  client.dispose();
  // The underlying bridge may settle after a user cancellation. It must not
  // become an unhandled rejection in an embedding UI.
  transport.pendingPrompt?.resolve({ stopReason: 'cancelled' });
  await prompt;
});

test('ACP events are delivered while current and dropped after reconnect', async () => {
  const { client, transport } = await connected();
  await client.newSession();
  const updates = [];
  const statuses = [];
  client.subscribe((event) => updates.push(event));
  client.subscribeStatus((event) => statuses.push(event.type));
  transport.emit({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.content.text, 'ok');

  transport.status({ type: 'disconnected' });
  transport.emit({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } } } });
  assert.equal(updates.length, 1);
  assert.ok(statuses.includes('bridge-disconnected'));

  transport.status({ type: 'reconnected' });
  await client.initialize();
  await client.resumeSession({ sessionId: 's-1', cwd: '/data/user/0/com.pythona.app/files/workspace' });
  transport.emit({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh' } } } });
  assert.equal(updates.length, 2);
  assert.equal(updates[1].update.content.text, 'fresh');
  client.dispose();
});

test('accepted ACP prompt remains single-flight until its terminal event', async () => {
  const { client, transport } = await connected();
  await client.newSession();
  transport.promptAccepted = true;
  const accepted = await client.prompt('s-1', 'long turn');
  assert.equal(accepted.accepted, true);
  await assert.rejects(() => client.prompt('s-1', 'overlap'), (error) => error.code === 'session-busy');
  transport.emit({ method: 'bridge/prompt_done', params: { sessionId: 's-1', requestId: 7, stopReason: 'end_turn' } });
  const next = await client.prompt('s-1', 'next turn');
  assert.equal(next.accepted, true);
  client.dispose();
});

test('ACP permission requests are surfaced without exposing provider secrets', async () => {
  const { client, transport } = await connected();
  await client.newSession();
  const requests = [];
  client.subscribe((event) => requests.push(event));
  transport.emit({ method: 'session/request_permission', params: { sessionId: 's-1', requestId: 'p-1', options: [{ optionId: 'allow-once' }] } });
  assert.equal(requests[0].type, 'permission-request');
  assert.equal(requests[0].request.options[0].optionId, 'allow-once');
  await client.respondPermission('p-1', 'reject-once');
  assert.equal(transport.calls.at(-1).method, 'bridge/permission_response');
  assert.equal(transport.calls.at(-1).payload.optionId, 'reject-once');
  client.dispose();
});
