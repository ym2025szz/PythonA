import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOfficialDshState,
  findOfficialModel,
  modelReasoningLevels,
  normalizeOfficialCatalog
} from '../src/core/dsh-official.js';
import { DshGateway } from '../src/core/dsh-gateway.js';

test('official catalog normalizes grouped models and keeps only key state', () => {
  const catalog = normalizeOfficialCatalog({
    protocol: 'acp',
    official: true,
    providers: [{
      id: 'deepseek',
      name: 'DeepSeek',
      keyConfigured: true,
      modelGroups: [{ models: [{ id: 'deepseek-chat', name: 'Chat', reasoningLevels: ['off', 'high'] }] }]
    }],
    selected: { providerId: 'deepseek', modelId: 'deepseek-chat', reasoningLevel: 'high' }
  });
  assert.equal(catalog.official, true);
  assert.equal(catalog.providers[0].hasKey, true);
  assert.equal(catalog.models[0].id, 'deepseek-chat');
  assert.equal(catalog.selected.model, 'deepseek-chat');
  assert.deepEqual(modelReasoningLevels(catalog.models[0]), ['off', 'high']);
  assert.equal(Object.hasOwn(catalog.providers[0], 'apiKey'), false);
});

test('compatibility profiles remain visible when the official catalog is unavailable', () => {
  const catalog = normalizeOfficialCatalog({ connected: true }, {
    profiles: [{ profileId: 'local', displayName: 'Local', providerKind: 'openai-compatible', model: 'model-a', hasKey: true }]
  });
  assert.equal(catalog.official, false);
  assert.equal(catalog.providers[0].source, 'compatibility');
  assert.equal(catalog.providers[0].models[0].id, 'model-a');
  assert.equal(findOfficialModel(catalog, 'local', 'model-a').model.id, 'model-a');
});

test('saved official configuration is not duplicated as a compatibility provider', () => {
  const catalog = normalizeOfficialCatalog({
    official:true, connected:true,
    providers:[{id:'pythona-custom',name:'My Provider',models:[{id:'model-v2',reasoningLevels:['off']}]}],
    selected:{providerId:'pythona-custom',model:'model-v2',reasoningLevel:'off'}
  }, {profiles:[
    {profileId:'direct-dsh',displayName:'My Provider',model:'model-v2',runtimeMode:'custom'},
    {profileId:'legacy',displayName:'Legacy',model:'legacy-model'}
  ]});
  assert.deepEqual(catalog.providers.map(p=>p.providerId), ['pythona-custom','legacy']);
  assert.equal(catalog.selected.model,'model-v2');
  assert.equal(findOfficialModel(catalog, 'pythona-custom','model-v2').provider.official,true);
});

test('official state rejects catalog events from an older connection generation', () => {
  const state = createOfficialDshState();
  const first = state.beginConnection();
  const second = state.beginConnection();
  assert.equal(state.applyCatalog({ official: true, providers: [{ id: 'old', models: ['old-model'] }] }, {}, first), false);
  assert.equal(state.value.status, 'connecting');
  assert.equal(state.applyCatalog({ official: true, providers: [{ id: 'new', models: ['new-model'] }] }, {}, second), true);
  assert.equal(state.value.catalog.providers[0].providerId, 'new');
});

test('accepted official prompt stays open until ACP terminal event', async () => {
  let notify;
  const broker = {
    available: true,
    subscribe(channel, listener) { assert.equal(channel, 'dsh'); notify = listener; return () => {}; },
    request(channel, method, payload) {
      assert.equal(channel, 'dsh');
      if (method === 'start') {
        queueMicrotask(() => notify({ sessionId: 'official-session', method: 'session/update', params: {
          sessionId: 'official-session', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } }
        }}));
        queueMicrotask(() => notify({ sessionId: 'official-session', method: 'session/update', params: {
          sessionId: 'official-session', update: { sessionUpdate: 'turn_complete', stopReason: 'end_turn' }
        }}));
        return Promise.resolve({ accepted: true, requestId: 'request-1', sessionId: 'official-session' });
      }
      if (method === 'cancel') return Promise.resolve({ cancelled: true });
      throw new Error(`unexpected method ${method}`);
    }
  };
  const gateway = new DshGateway(broker);
  const events = [];
  for await (const event of gateway.stream({ prompt: 'hello', sessionId: 'client-session' })) events.push(event);
  assert.deepEqual(events.map((event) => event.kind), ['delta', 'done']);
  assert.equal(events[0].text, 'hello');
  gateway.dispose();
});
