export const NATIVE_PROTOCOL_VERSION = 2;

const TRANSIENT_ERROR_CODES = new Set([
  'service-disconnected',
  'service-binding-died',
  'service-null-binding',
  'service-bind-failed',
  'service-send-failed',
  'service-timeout',
  'native-timeout',
  'runtime-service-unavailable',
  'language-service-unavailable'
]);

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function redactStatusValue(value, key = '') {
  if (/(?:secret|api.?key|token|password|credential|authorization)/i.test(key)) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) return value.map((item) => redactStatusValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([childKey, childValue]) => [childKey, redactStatusValue(childValue, childKey)]));
}

function safeStatusRequest(request) {
  return redactStatusValue(clone(request));
}

function requestId(sequence) {
  const random = globalThis.crypto?.randomUUID?.();
  return random || `web-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export class NativeBrokerError extends Error {
  constructor(message, code = 'native-error', details = null) {
    super(message || 'Native request failed');
    this.name = 'NativeBrokerError';
    this.code = code;
    this.details = details;
    this.transient = TRANSIENT_ERROR_CODES.has(code);
  }
}

/**
 * Protocol-v2 client shared by workspace, language and runtime adapters.
 *
 * Android normally installs a WebMessagePort after the page is ready. During
 * that short bootstrap window (and after a WebView port recreation), the
 * minimal JavascriptInterface `PythonABridge.postMessage` remains usable.
 * Neither transport performs a synchronous native call.
 */
export class NativeBroker {
  constructor(options = {}) {
    this.protocolVersion = NATIVE_PROTOCOL_VERSION;
    // The first CPython/Jedi request may need to atomically extract thousands
    // of stdlib and typeshed files on slower tablets. Warm requests complete
    // far sooner, but the transport must not abandon that one-time install.
    this.timeoutMs = Number(options.timeoutMs) || 60_000;
    this.nativeObject = options.nativeObject || globalThis.PythonANative || null;
    this.javascriptBridge = options.javascriptBridge || globalThis.PythonABridge || null;
    this.pending = new Map();
    this.listeners = new Map();
    this.statusListeners = new Set();
    this.sequence = 0;
    this.generation = 0;
    this.connected = false;
    this.disposed = false;
    this.boundReceive = (value) => this.receive(value);
    this.boundReady = () => this.handleReady();
    this.installReceiver();
    if (this.canPost()) this.handleReady();
  }

  get available() {
    return !this.disposed && Boolean(this.canPost());
  }

  canPost() {
    return typeof this.nativeObject?.postMessage === 'function'
      || typeof globalThis.PythonANative?.postMessage === 'function'
      || typeof this.javascriptBridge?.postMessage === 'function';
  }

  installReceiver() {
    const target = this.nativeObject || globalThis.PythonANative || {};
    const previous = typeof target.onMessage === 'function' ? target.onMessage : null;
    target.onMessage = (value) => {
      this.boundReceive(value);
      if (previous && previous !== this.boundReceive) {
        try { previous(value); } catch (error) { /* isolate legacy receivers */ }
      }
    };
    globalThis.PythonANative = target;
    this.nativeObject = target;
    globalThis.addEventListener?.('pythona:native-ready', this.boundReady);
    // MainActivity invokes onMessage and also emits a DOM event for legacy
    // observers. Listening to both would duplicate workspace file events.
  }

  handleReady() {
    if (this.disposed) return;
    this.nativeObject = globalThis.PythonANative || this.nativeObject;
    this.connected = this.canPost();
    this.generation += 1;
    this.emitStatus({ type: 'connected', generation: this.generation });
  }

  subscribe(channel, listener) {
    const key = channel || '*';
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
    return () => this.listeners.get(key)?.delete(listener);
  }

  subscribeStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emitStatus(event) {
    this.statusListeners.forEach((listener) => listener({ ...event, timestamp: Date.now() }));
  }

  emitEvent(message) {
    const event = clone(message.event ?? message.payload ?? message);
    for (const key of [message.channel || '*', '*']) {
      this.listeners.get(key)?.forEach((listener) => listener(event, clone(message)));
    }
  }

  request(channel, method, payload = {}, options = {}) {
    if (this.disposed) return Promise.reject(new NativeBrokerError('Native broker is disposed', 'broker-disposed'));
    const id = options.id || requestId(++this.sequence);
    const optionTimeout = Number(options.timeoutMs);
    const timeoutMs = optionTimeout > 0 ? optionTimeout : this.timeoutMs;
    const request = {
      protocolVersion: this.protocolVersion,
      id,
      channel: String(channel || ''),
      method: String(method || ''),
      // The Java Messenger layer has its own watchdog. Carry the caller's
      // policy across WebMessagePort so a first-start 120 s extraction is not
      // abandoned by the native broker's former fixed 60 s timeout.
      transportTimeoutMs: Math.max(1_000, Math.min(600_000, Math.round(timeoutMs))),
      payload: payload == null ? {} : clone(payload)
    };
    if (!request.channel || !request.method) {
      return Promise.reject(new NativeBrokerError('A native channel and method are required', 'invalid-request'));
    }
    if (this.pending.has(id)) {
      return Promise.reject(new NativeBrokerError(`Duplicate native request id: ${id}`, 'duplicate-request-id'));
    }

    let cancelRequest;
    const promise = new Promise((resolve, reject) => {
      const pending = {
        id,
        request,
        resolve,
        reject,
        signal: options.signal || null,
        onAbort: null,
        timer: timeoutMs > 0 ? setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(new NativeBrokerError(`Native request timed out: ${request.channel}/${request.method}`, 'native-timeout'));
          this.emitStatus({ type: 'request-timeout', request: safeStatusRequest(request) });
        }, timeoutMs) : null
      };
      cancelRequest = (reason = 'cancelled') => this.cancel(id, reason);
      if (pending.signal) {
        pending.onAbort = () => cancelRequest('aborted');
        if (pending.signal.aborted) {
          if (pending.timer) clearTimeout(pending.timer);
          reject(new NativeBrokerError('Native request cancelled', 'cancelled'));
          return;
        }
        pending.signal.addEventListener?.('abort', pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        const returned = this.post(request);
        // Test doubles and future host implementations may return a response
        // directly. Android's JavascriptInterface entry point returns void.
        if (returned && typeof returned.then === 'function') {
          returned.then((value) => { if (value != null) this.receive(value); }, (error) => this.failPending(id, error));
        } else if (returned != null) this.receive(returned);
      } catch (error) {
        this.failPending(id, error);
      }
    });
    return Object.assign(promise, { requestId: id, cancel: cancelRequest || (() => false) });
  }

  post(request) {
    const message = JSON.stringify(request);
    const currentNative = globalThis.PythonANative || this.nativeObject;
    if (typeof currentNative?.postMessage === 'function') {
      this.nativeObject = currentNative;
      this.connected = true;
      return currentNative.postMessage(message);
    }
    if (typeof this.javascriptBridge?.postMessage === 'function') {
      this.connected = true;
      return this.javascriptBridge.postMessage(message);
    }
    this.connected = false;
    throw new NativeBrokerError('PythonA native bridge is unavailable', 'native-unavailable');
  }

  receive(raw) {
    if (this.disposed || raw == null) return false;
    let message = raw;
    try { if (typeof message === 'string') message = JSON.parse(message); }
    catch (error) { return false; }
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'event' || (!message.id && (message.event || message.channel))) {
      this.emitEvent(message);
      return true;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    if (this.isStaleIdentity(message, pending.request.payload)) {
      this.emitStatus({ type: 'stale-response-discarded', response: clone(message) });
      return true;
    }
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.signal?.removeEventListener?.('abort', pending.onAbort);
    if (message.ok === false || message.error) {
      const detail = typeof message.error === 'string' ? { message: message.error } : (message.error || {});
      const error = new NativeBrokerError(detail.message || 'Native request failed', detail.code || message.code || 'native-error', detail.details || null);
      if (error.transient) {
        this.connected = false;
        // A Binder service failure does not imply that sibling processes or
        // the WebView transport have disconnected. Unscoped transport events
        // remain global; errors returned for a request belong to its channel.
        this.emitStatus({ type: 'reconnecting', channel: pending.request.channel, generation: this.generation, error });
      }
      pending.reject(error);
      return true;
    }
    this.connected = true;
    pending.resolve(Object.prototype.hasOwnProperty.call(message, 'payload') ? message.payload : message.result ?? message);
    return true;
  }

  isStaleIdentity(message, expected = {}) {
    // A response from an older request can arrive after a service restart even
    // when its editor version happens to be the same.  Compare the identity
    // fields whenever both sides carry them; legacy providers that omit an
    // optional field remain compatible.
    for (const key of ['requestId', 'streamId', 'sessionId', 'workspaceId']) {
      if (!expected?.[key] || !message?.[key]) continue;
      if (String(message[key]) !== String(expected[key])) return true;
    }
    for (const key of ['epoch', 'bufferVersion']) {
      if (expected?.[key] == null || message?.[key] == null) continue;
      const want = Number(expected[key]);
      const got = Number(message[key]);
      if (Number.isFinite(want) && Number.isFinite(got) && got !== want) return true;
    }
    if (expected?.uri && message?.uri && expected.uri !== message.uri) return true;
    return false;
  }

  failPending(id, value) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.signal?.removeEventListener?.('abort', pending.onAbort);
    const error = value instanceof NativeBrokerError
      ? value
      : new NativeBrokerError(value?.message || String(value), value?.code || 'native-transport-error');
    pending.reject(error);
  }

  cancel(id, reason = 'cancelled') {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.signal?.removeEventListener?.('abort', pending.onAbort);
    pending.reject(new NativeBrokerError('Native request cancelled', 'cancelled', { reason }));
    const cancellation = {
      protocolVersion: this.protocolVersion,
      id: requestId(++this.sequence),
      channel: pending.request.channel,
      method: '$/cancelRequest',
      payload: { requestId: id, id, reason }
    };
    try { this.post(cancellation); } catch (error) { /* cancellation is best effort */ }
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    globalThis.removeEventListener?.('pythona:native-ready', this.boundReady);
    for (const id of [...this.pending.keys()]) this.failPending(id, new NativeBrokerError('Native broker is disposed', 'broker-disposed'));
    this.listeners.clear();
    this.statusListeners.clear();
  }
}

export class NativeWorkspaceClient {
  constructor(broker, options = {}) {
    this.broker = broker;
    this.workspaceId = options.workspaceId || 'default';
  }

  get available() { return Boolean(this.broker?.available); }

  list(options = {}) {
    return this.broker.request('workspace', 'list', { workspaceId: this.workspaceId }, options);
  }

  read(path, options = {}) {
    return this.broker.request('workspace', 'read', { workspaceId: this.workspaceId, path }, options);
  }

  write(path, content, options = {}) {
    return this.broker.request('workspace', 'write', {
      workspaceId: this.workspaceId,
      path,
      content: String(content ?? ''),
      expectedRevision: options.expectedRevision ?? null,
      source: options.source || 'webview'
    }, options);
  }

  applyBatch(transaction, options = {}) {
    const payload = typeof transaction?.toBatchPayload === 'function'
      ? transaction.toBatchPayload(this.workspaceId)
      : { ...transaction, workspaceId: transaction?.workspaceId || this.workspaceId };
    return this.broker.request('workspace', 'applyBatch', payload, options);
  }

  delete(path, options = {}) {
    return this.broker.request('workspace', 'delete', {
      workspaceId: this.workspaceId,
      path,
      expectedRevision: options.expectedRevision ?? null,
      source: options.source || 'webview'
    }, options);
  }

  subscribe(listener) {
    return this.broker.subscribe('workspace', listener);
  }
}
