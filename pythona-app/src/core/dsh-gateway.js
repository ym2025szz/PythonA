import { isDshDisconnect, dshDisconnectedError } from './dsh-service-lifecycle.js';

function id(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

class AsyncEventQueue {
  constructor() { this.values = []; this.waiters = []; this.closed = false; this.error = null; }
  push(value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false }); else this.values.push(value);
  }
  finish(error = null, discardBuffered = false) {
    if (this.closed) return;
    if (discardBuffered) this.values.length = 0;
    this.closed = true; this.error = error;
    for (const waiter of this.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ done: true });
  }
  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator]() { return this; }
}

function normalizeAcpEvent(event) {
  const outer = event?.event && typeof event.event === 'object' ? event.event : event;
  const method = String(outer?.method || outer?.type || '');
  if (method === 'session/update') {
    const params = outer.params || {};
    const update = params.update || {};
    const updateKind = String(update.sessionUpdate || update.type || update.kind || '');
    const content = update.content || {};
    const identity = {
      ...event,
      sessionId: event.sessionId || params.sessionId,
      requestId: event.requestId || params.requestId,
      streamId: event.streamId || params.streamId
    };
    const textFromContent = (value) => {
      if (Array.isArray(value)) return value.map((item) => textFromContent(item)).filter(Boolean).join('');
      if (value && typeof value === 'object') return String(value.text ?? value.value ?? value.content ?? '');
      return String(value ?? '');
    };
    if (updateKind === 'agent_message_chunk' || updateKind === 'agent_thought_chunk') {
      const text = textFromContent(content) || textFromContent(update.text);
      return { ...identity, kind: updateKind === 'agent_message_chunk' ? 'delta' : 'thought', text,
        messageId: update.messageId || update._meta?.pythona?.messageId,
        blockIndex: update._meta?.pythonaBlockIndex };
    }
    if (updateKind === 'tool_call' || updateKind === 'tool_call_update') {
      // ACP tools execute inside official DSH. They are activity updates, not
      // a request for PythonA's compatibility tool executor to run twice.
      return { ...identity, kind: 'scope', callId: update.toolCallId, title: update.title || update.name,
        status: update.status, locations: update.locations, text: String(update.title || update.name || 'DSH 工具活动') };
    }
    if (updateKind === 'usage_update') return { ...identity, kind: 'usage', usage: update };
    if (updateKind === 'pythona_stream_reset') return { ...identity, kind: 'stream_reset', messageId: update.messageId, reason: update.reason };
    if (updateKind === 'turn_end' || updateKind === 'turn_complete') return { ...identity, kind: 'done', stopReason: update.stopReason };
    return { ...identity, kind: 'scope', text: String(update.title || updateKind || 'DSH 状态已更新') };
  }
  if (method === 'session/prompt/completed' || method === 'session/prompt/finished') {
    return { ...event, kind: outer.error ? 'error' : 'done', stopReason: outer.params?.stopReason || outer.stopReason,
      message: outer.error?.message || outer.params?.error?.message || '' };
  }
  if (method === 'session/request_permission') {
    return { ...event, kind: 'approval_required', action: 'permission', permission: outer.params || outer };
  }
  return { ...event, kind: event.kind || event.type };
}

/** Protocol-v2 DSH client. Provider secrets never cross this boundary. */
export class DshGateway {
  constructor(broker, options = {}) {
    this.broker = broker;
    this.workspaceId = options.workspaceId || 'default';
    this.listeners = new Set();
    this.streams = new Map();
    this.streamMetadata = new Map();
    this.orphanEvents = new Map();
    this.unsubscribe = broker?.subscribe?.('dsh', (event) => this.receive(event)) || (() => {});
    this.unsubscribeStatus = broker?.subscribeStatus?.((event) => this.handleBrokerStatus(event)) || (() => {});
  }

  get available() { return Boolean(this.broker?.available); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  handleBrokerStatus(event = {}) {
    if (!isDshDisconnect(event)) return false;
    const error = dshDisconnectedError(event);
    for (const queue of this.streams.values()) queue.finish(error, true);
    this.streams.clear();
    this.streamMetadata.clear();
    this.orphanEvents.clear();
    this.listeners.forEach((listener) => { try { listener({ type: 'service-disconnected', kind: 'error', code: error.code, error, message: error.message }); } catch (_) {} });
    return true;
  }
  receive(event) {
    const outer = event?.event && typeof event.event === 'object' ? event.event : event;
    if (this.handleBrokerStatus(outer)) return;
    if (event?.kind === 'inlineCompletion') return;
    const normalized = normalizeAcpEvent(event);
    if (!normalized.streamId && normalized.sessionId) {
      for (const [streamId, metadata] of this.streamMetadata) {
        if (metadata.sessionId && metadata.sessionId === normalized.sessionId) {
          normalized.streamId = streamId;
          break;
        }
      }
    }
    if (!normalized.streamId && normalized.sessionId) {
      const pending = this.orphanEvents.get(String(normalized.sessionId)) || [];
      pending.push(normalized);
      this.orphanEvents.set(String(normalized.sessionId), pending.slice(-64));
      while (this.orphanEvents.size > 64) this.orphanEvents.delete(this.orphanEvents.keys().next().value);
      return;
    }
    const metadata = this.streamMetadata.get(normalized.streamId);
    if (metadata) {
      // A restarted provider or a delayed Binder packet must never update a
      // newer editor buffer.  Missing optional fields remain compatible with
      // older providers; present identity fields must match the request.
      for (const key of ['requestId', 'sessionId', 'workspaceId', 'uri', 'conversationId', 'turnId']) {
        if (metadata[key] && normalized[key]
            && String(normalized[key]) !== String(metadata[key])) return;
      }
      for (const key of ['epoch', 'bufferVersion']) {
        if (metadata[key] == null || normalized[key] == null) continue;
        const expected = Number(metadata[key]);
        const received = Number(normalized[key]);
        if (Number.isFinite(expected) && Number.isFinite(received)
            && received !== expected) return;
      }
    }
    this.listeners.forEach((listener) => listener(normalized));
    const queue = this.streams.get(normalized.streamId);
    if (!queue) return;
    queue.push(normalized);
    if (['done', 'error'].includes(normalized.kind)) {
      queue.finish(normalized.kind === 'error' ? Object.assign(new Error(normalized.message || 'DSH request failed'), { code: normalized.code }) : null);
      this.streams.delete(normalized.streamId);
      this.streamMetadata.delete(normalized.streamId);
    }
  }

  listProviders(options = {}) { return this.broker.request('dsh', 'listProviders', {}, options); }
  listProfiles(options = {}) { return this.broker.request('dsh', 'listProfiles', {}, options); }
  /** Official DSH/ACP capability and catalog surfaces. Older bridges may
   * reject these methods; callers intentionally keep the compatibility
   * profile flow as a fallback. */
  capabilities(options = {}) { return this.broker.request('dsh', 'capabilities', {}, options); }
  listModels(options = {}) { return this.broker.request('dsh', 'listModels', {}, options); }
  selectModel(selection, options = {}) {
    return this.broker.request('dsh', 'selectModel', { selection }, options);
  }
  openOfficialSettings(options = {}) { return this.broker.request('dsh', 'openSettings', {}, options); }
  reconnect(options = {}) { return this.broker.request('dsh', 'reconnect', {}, options); }
  respondToolApproval(approvalId, allowed, options = {}) {
    const { result, ...transportOptions } = options;
    return this.broker.request('dsh', 'respondToolApproval', {
      approvalId: String(approvalId || ''), allowed: Boolean(allowed),
      ...(result == null ? {} : { result })
    }, transportOptions);
  }
  saveProfile(profile, secret = '', options = {}) {
    return this.broker.request('dsh', 'saveProfile', { profile, secret: String(secret || '') }, options);
  }
  deleteProfile(profileId, options = {}) { return this.broker.request('dsh', 'deleteProfile', { profileId }, options); }
  testProfile(profileId, options = {}) { return this.broker.request('dsh', 'testProfile', { profileId }, options); }
  networkStatus(options = {}) { return this.broker.request('dsh', 'networkStatus', {}, options); }
  configureCredential(options = {}) {
    const { profile, ...transport } = options;
    const payload = {};
    if (profile) payload.profile = Object.fromEntries(
      ['displayName', 'baseUrl', 'model', 'runtimeMode', 'allowLocalEndpoint'].filter(key => profile[key] != null).map(key => [key, profile[key]]));
    return this.broker.request('dsh', 'configureCredential', payload, transport);
  }

  start(request, options = {}) {
    const streamId = request.streamId || id('stream');
    const requestId = request.requestId || id('request');
    // The active buffer is needed by browser/test gateways to construct a
    // preview, but the native provider only needs the already-redacted
    // context manifest. Never copy the unredacted duplicate into Binder or
    // its large-message spool.
    const { content: localContent, ...transportRequest } = request;
    const promise = this.broker.request('dsh', 'start', {
      ...transportRequest, streamId, requestId,
      workspaceId: request.workspaceId || this.workspaceId
    }, { ...options, id: requestId, timeoutMs: options.timeoutMs || 135_000 });
    return Object.assign(promise, { streamId, requestId });
  }

  async *stream(request, options = {}) {
    const queue = new AsyncEventQueue();
    // Register the queue before asking the native service to start. A fast
    // mock/provider can emit its first Binder event before the start response
    // resolves, and losing that event would corrupt the normalized stream.
    const streamId = request.streamId || id('stream');
    const requestId = request.requestId || id('request');
    this.streams.set(streamId, queue);
    this.streamMetadata.set(streamId, {
      requestId,
      conversationId: request.conversationId || null,
      turnId: request.turnId || null,
      sessionId: request.sessionId || null,
      workspaceId: request.workspaceId || this.workspaceId,
      uri: request.uri || null,
      epoch: request.epoch == null ? null : request.epoch,
      bufferVersion: request.bufferVersion == null ? null : request.bufferVersion
    });
    const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 135_000);
    const timeout = setTimeout(() => queue.finish(Object.assign(new Error('DSH stream timed out'), { code: 'dsh-timeout' })), timeoutMs);
    const abort = () => queue.finish(Object.assign(new Error('DSH request cancelled'), { code: 'cancelled' }));
    options.signal?.addEventListener?.('abort', abort, { once: true });
    let operation;
    try { operation = this.start({ ...request, streamId, requestId }, options); }
    catch (error) {
      this.streams.delete(streamId);
      this.streamMetadata.delete(streamId);
      queue.finish(error);
      throw error;
    }
    const metadata = this.streamMetadata.get(streamId);
    if (metadata && operation?.requestId) metadata.requestId = operation.requestId;
    operation.then((result) => {
      if (!queue.closed) {
        if (result?.event) queue.push(result.event);
        const current = this.streamMetadata.get(streamId);
        if (current) {
          if (result?.sessionId) current.sessionId = String(result.sessionId);
        if (result?.requestId) current.requestId = String(result.requestId);
        if (current?.sessionId) {
          const pending = this.orphanEvents.get(current.sessionId) || [];
          this.orphanEvents.delete(current.sessionId);
          pending.forEach((event) => this.receive({ ...event, streamId }));
        }
        }
        // The official dsh accepts a prompt immediately. ACP updates and the final turn
        // status arrive asynchronously; closing here would lose all output.
        if (result?.accepted !== true) {
          queue.finish();
          this.streams.delete(streamId);
          this.streamMetadata.delete(streamId);
        }
      }
    }, (error) => {
      queue.finish(error);
      this.streams.delete(streamId);
      this.streamMetadata.delete(streamId);
    });
    let terminal = false;
    try {
      for await (const event of queue) {
        if (['done', 'error'].includes(event.kind || event.type)) terminal = true;
        yield event;
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener?.('abort', abort);
      // Aborting the broker's start request only releases its response
      // promise; the HTTP call lives in another process and needs an explicit
      // stream-id cancellation as well.
      if (!terminal && this.streams.has(streamId)) this.cancel(streamId).catch(() => {});
    }
  }

  cancel(streamId, options = {}) {
    const queue = this.streams.get(streamId);
    queue?.finish();
    this.streams.delete(streamId);
    this.streamMetadata.delete(streamId);
    return this.broker.request('dsh', 'cancel', { streamId }, { ...options, timeoutMs: options.timeoutMs || 5_000 });
  }

  dispose() {
    this.unsubscribe();
    this.unsubscribeStatus();
    for (const queue of this.streams.values()) queue.finish();
    this.streams.clear();
    this.streamMetadata.clear();
    this.orphanEvents.clear();
    this.listeners.clear();
  }
}
