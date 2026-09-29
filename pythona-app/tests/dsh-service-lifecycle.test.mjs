import test from 'node:test';
import assert from 'node:assert/strict';
import { DshGateway } from '../src/core/dsh-gateway.js';

function fixture() {
  const callbacks = new Map();
  const calls = [];
  const broker = { available: true, subscribe(channel, callback) { callbacks.set(channel, callback); return () => {}; },
    subscribeStatus(callback) { callbacks.set('status', callback); return () => {}; },
    request(channel, method, payload) { calls.push({ channel, method, payload }); return Promise.resolve({ accepted: true, sessionId: payload.sessionId }); } };
  return { gateway: new DshGateway(broker), callbacks, calls };
}
test('Binder per-channel crash immediately rejects an accepted stream and never orphans the service event', async () => {
  const { gateway, callbacks, calls } = fixture();
  const events = [];
  gateway.subscribe(event => events.push(event));
  const stream = gateway.stream({ streamId: 'stream-1', sessionId: 'chat-1', requestId: 'r1' });
  const next = stream.next();
  const rejected = assert.rejects(next, { code: 'service-disconnected' });
  await Promise.resolve();
  callbacks.get('dsh')({ channel: 'dsh', type: 'service-crashed', sessionId: 'dsh-service', streamId: '' });
  await rejected;
  assert.equal(gateway.streams.size, 0);
  assert.equal(gateway.streamMetadata.size, 0);
  assert.equal(gateway.orphanEvents.size, 0);
  assert.equal(events.at(-1).code, 'service-disconnected');
  assert.equal(calls.filter(call => call.method === 'cancel').length, 0, 'dead service is not rebound just to cancel a retired task');
  gateway.dispose();
});
test('per-channel restart clears every old stream while a new stream continues normally', async () => {
  const { gateway, callbacks } = fixture();
  const first = gateway.stream({ streamId: 'a', sessionId: 'a', requestId: 'a' }).next();
  const second = gateway.stream({ streamId: 'b', sessionId: 'b', requestId: 'b' }).next();
  const stopped = Promise.all([assert.rejects(first, { code: 'service-disconnected' }), assert.rejects(second, { code: 'service-disconnected' })]);
  callbacks.get('dsh')({ type: 'binding-died', sessionId: 'dsh-service' });
  await stopped;
  const fresh = gateway.stream({ streamId: 'new', sessionId: 'new', requestId: 'new' });
  const next = fresh.next();
  callbacks.get('dsh')({ kind: 'done', streamId: 'new', sessionId: 'new', requestId: 'new' });
  assert.equal((await next).value.kind, 'done');
  assert.equal((await fresh.next()).done, true);
  gateway.dispose();
});
test('another channel reconnect does not stop DSH output', async () => {
  const { gateway, callbacks } = fixture();
  const stream = gateway.stream({ streamId: 'dsh', sessionId: 'chat', requestId: 'r' });
  const next = stream.next();
  callbacks.get('status')({ channel: 'language', type: 'reconnecting' });
  callbacks.get('status')({ channel: 'runtime', type: 'service-crashed' });
  assert.equal(gateway.streams.size, 1);
  callbacks.get('dsh')({ kind: 'done', streamId: 'dsh', sessionId: 'chat', requestId: 'r' });
  assert.equal((await next).value.kind, 'done');
  await stream.next(); gateway.dispose();
});
