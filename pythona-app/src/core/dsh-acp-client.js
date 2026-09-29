/**
 * Small PythonA-side client for the official DeepSeek Harness ACP surface.
 *
 * The Android bridge owns the transport and all provider credentials.  This
 * module only sends ACP parameters (workspace, prompt, session and model
 * option ids); an API key, bearer token or credential header is rejected
 * before it can cross the WebView/native boundary.
 */

export const ACP_PROTOCOL_VERSION = 1;

const SECRET_FIELD = /(?:api.?key|secret|password|credential|authorization|bearer|access.?token|refresh.?token)/i;
const TRANSIENT_ERROR = /(?:disconnected|binding|unavailable|timeout|reconnect|transport)/i;

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function randomId(prefix) {
  return globalThis.crypto?.randomUUID?.()
    || `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorWithCode(message, code = 'dsh-acp-error', details = null) {
  const error = new Error(String(message || 'DSH ACP request failed'));
  error.code = code;
  if (details != null) error.details = details;
  error.transient = TRANSIENT_ERROR.test(code) || TRANSIENT_ERROR.test(error.message);
  return error;
}

function assertNoCredentials(value, path = 'params', seen = new Set()) {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) throw errorWithCode('Cyclic ACP parameters are not supported', 'invalid-params');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentials(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) {
      throw errorWithCode(`Credential-bearing ACP field is forbidden: ${path}.${key}`, 'credential-field-forbidden');
    }
    assertNoCredentials(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function requireAbsoluteWorkspace(cwd) {
  const value = String(cwd || '').trim().replaceAll('\\', '/');
  // Android app-private paths are POSIX paths. Windows paths are accepted for
  // desktop tests, but relative paths and URI schemes are never sent to ACP.
  if (!value || value.includes('\0') || value.startsWith('file:')
      || (!value.startsWith('/') && !/^[A-Za-z]:\//.test(value))) {
    throw errorWithCode('ACP session cwd must be an absolute path', 'invalid-params');
  }
  return value;
}

function normalizePrompt(prompt) {
  if (typeof prompt === 'string') {
    if (!prompt.trim()) throw errorWithCode('ACP prompt is required', 'invalid-params');
    return [{ type: 'text', text: prompt }];
  }
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw errorWithCode('ACP prompt is required', 'invalid-params');
  }
  const result = prompt.map((part, index) => {
    if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
      throw errorWithCode(`Invalid ACP prompt part at index ${index}`, 'invalid-params');
    }
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw errorWithCode('ACP text prompt must be a string', 'invalid-params');
      return { type: 'text', text: part.text };
    }
    if (part.type === 'resource_link') {
      if (typeof part.uri !== 'string' || !part.uri.trim()) throw errorWithCode('ACP resource link requires a URI', 'invalid-params');
      return { ...part };
    }
    // PythonA intentionally exposes no base64 or inline image upload path;
    // The official dsh can add one later without silently moving binary data through IPC.
    throw errorWithCode(`Unsupported ACP prompt part: ${part.type}`, 'unsupported-prompt');
  });
  assertNoCredentials(result);
  return result;
}

function asError(error) {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object') return errorWithCode(error.message || 'DSH ACP request failed', error.code || 'dsh-acp-error', error.details);
  return errorWithCode(String(error || 'DSH ACP request failed'));
}

/**
 * ACP client over a PythonA native broker.
 *
 * The default transport is `NativeBroker.request(channel, method, params,
 * options)` and `NativeBroker.subscribe(channel, listener)`. Tests and a
 * a future transport adapter can provide `request(method, params, options)` via
 * `options.request` instead.
 */
export class DshAcpClient {
  constructor(transport, options = {}) {
    if (!transport || typeof transport.request !== 'function') {
      throw new TypeError('A DSH ACP transport is required');
    }
    this.transport = transport;
    this.channel = options.channel || 'dsh';
    this.workspaceRoot = options.workspaceRoot || '';
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 120_000);
    this.clientInfo = {
      name: String(options.clientName || 'PythonA'),
      version: String(options.clientVersion || '0.4.0')
    };
    this.requestOverride = typeof options.request === 'function' ? options.request : null;
    this.notifyOverride = typeof options.notify === 'function' ? options.notify : null;
    this.state = transport.available === false ? 'offline' : 'disconnected';
    this.generation = 0;
    this.capabilities = null;
    this.sessions = new Map();
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.closed = false;
    this.initializing = null;

    this.unsubscribeEvents = typeof transport.subscribe === 'function'
      ? transport.subscribe(this.channel, (event) => this.receive(event)) : null;
    this.unsubscribeStatus = typeof transport.subscribeStatus === 'function'
      ? transport.subscribeStatus((event) => this.handleTransportStatus(event)) : null;
  }

  get available() {
    return !this.closed && this.state !== 'offline' && this.transport.available !== false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emit(event) {
    const safe = clone(event);
    this.listeners.forEach((listener) => {
      try { listener(safe); } catch (_) { /* UI listeners must not stop ACP */ }
    });
  }

  emitStatus(event) {
    const safe = { ...clone(event), generation: this.generation, timestamp: Date.now() };
    this.statusListeners.forEach((listener) => {
      try { listener(safe); } catch (_) { /* diagnostics are best effort */ }
    });
  }

  handleTransportStatus(event = {}) {
    const type = String(event.type || '');
    if (['reconnecting', 'disconnected', 'binding-died', 'null-binding', 'request-timeout'].includes(type)) {
      this.generation += 1;
      this.state = 'offline';
      for (const session of this.sessions.values()) {
        session.generation = -1;
        session.inflight = null;
      }
      this.emitStatus({ type: 'bridge-disconnected', cause: type, detail: event.error?.message || event.message || '' });
      return;
    }
    if (['connected', 'reconnected'].includes(type)) {
      this.generation += 1;
      this.state = 'disconnected';
      this.emitStatus({ type: 'bridge-connected', cause: type });
    }
  }

  request(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(errorWithCode('DSH ACP client is closed', 'client-closed'));
    assertNoCredentials(params);
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.timeoutMs;
    try {
      if (this.requestOverride) return Promise.resolve(this.requestOverride(method, clone(params), { ...options, timeoutMs }));
      // NativeBroker carries the ACP method in its protocol-v2 method field.
      return Promise.resolve(this.transport.request(
        this.channel, method, clone(params), { ...options, timeoutMs }
      ));
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  notify(method, params = {}, options = {}) {
    assertNoCredentials(params);
    if (this.notifyOverride) return Promise.resolve(this.notifyOverride(method, clone(params), options));
    if (typeof this.transport.notify === 'function') {
      return Promise.resolve(this.transport.notify(this.channel, method, clone(params), options));
    }
    // The Android v2 bridge has no one-way request primitive. A request whose
    // response is ignored still gives the official dsh a deterministic cancellation path.
    return this.request(method, params, { ...options, timeoutMs: options.timeoutMs || 5_000 }).catch((error) => {
      if (error?.code === 'cancelled' || error?.code === 'service-disconnected') return { cancelled: true };
      throw error;
    });
  }

  async initialize(options = {}) {
    if (this.initializing) return this.initializing;
    if (this.state === 'ready' && this.capabilities) return this.capabilities;
    this.closed = false;
    this.state = 'connecting';
    this.generation += 1;
    const generation = this.generation;
    const params = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: this.clientInfo,
      clientCapabilities: { ...options.clientCapabilities }
    };
    this.initializing = this.request('initialize', params, options).then((result) => {
      if (generation !== this.generation) throw errorWithCode('Stale ACP initialize response', 'stale-result');
      const response = result?.result || result?.payload || result;
      if (Number(response?.protocolVersion) !== ACP_PROTOCOL_VERSION) {
        throw errorWithCode('Unsupported ACP protocol version', 'protocol-version-mismatch', { protocolVersion: response?.protocolVersion });
      }
      this.capabilities = clone(response);
      this.state = 'ready';
      this.emitStatus({ type: 'ready', capabilities: this.capabilities });
      return this.capabilities;
    }).catch((error) => {
      const failure = asError(error);
      this.state = failure.transient ? 'offline' : 'error';
      this.emitStatus({ type: 'error', code: failure.code, message: failure.message });
      throw failure;
    }).finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async authenticate(params = {}, options = {}) {
    await this.initialize(options);
    return this.request('authenticate', params, options);
  }

  async ensureReady(options = {}) {
    if (this.state !== 'ready' || !this.capabilities) await this.initialize(options);
    return this.capabilities;
  }

  async newSession(params = {}, options = {}) {
    await this.ensureReady(options);
    const cwd = requireAbsoluteWorkspace(params.cwd || this.workspaceRoot);
    const payload = { ...params, cwd };
    assertNoCredentials(payload);
    const result = await this.request('session/new', payload, options);
    const session = result?.result || result?.payload || result;
    if (!session?.sessionId) throw errorWithCode('ACP session/new returned no sessionId', 'protocol-error');
    this.sessions.set(String(session.sessionId), {
      sessionId: String(session.sessionId),
      generation: this.generation,
      configOptions: clone(session.configOptions || []),
      inflight: null,
      cwd
    });
    return clone(session);
  }

  async listSessions(params = {}, options = {}) {
    await this.ensureReady(options);
    if (params.cwd != null) params = { ...params, cwd: requireAbsoluteWorkspace(params.cwd) };
    return this.request('session/list', params, options).then((result) => clone(result?.result || result?.payload || result));
  }

  async resumeSession(params = {}, options = {}) {
    await this.ensureReady(options);
    const sessionId = String(params.sessionId || '');
    if (!sessionId) throw errorWithCode('ACP session/resume requires sessionId', 'invalid-params');
    const cwd = requireAbsoluteWorkspace(params.cwd || this.workspaceRoot);
    const result = await this.request('session/resume', { ...params, sessionId, cwd }, options);
    const session = result?.result || result?.payload || result;
    if (!session?.sessionId) throw errorWithCode('ACP session/resume returned no sessionId', 'protocol-error');
    this.sessions.set(sessionId, { sessionId, generation: this.generation, configOptions: clone(session.configOptions || []), inflight: null, cwd });
    return clone(session);
  }

  async closeSession(sessionId, options = {}) {
    const id = String(sessionId || '');
    if (!id) return { closed: false };
    const result = await this.request('session/close', { sessionId: id }, options);
    this.sessions.delete(id);
    return clone(result?.result || result?.payload || result);
  }

  async setConfigOption(sessionId, configId, value, options = {}) {
    const id = String(sessionId || '');
    const session = this.sessions.get(id);
    if (!session || session.generation !== this.generation) throw errorWithCode('ACP session is unavailable; reconnect and resume it', 'session-stale');
    if (!String(configId || '').trim()) throw errorWithCode('ACP configId is required', 'invalid-params');
    const result = await this.request('session/set_config_option', { sessionId: id, configId: String(configId), value: String(value ?? '') }, options);
    const payload = result?.result || result?.payload || result;
    session.configOptions = clone(payload?.configOptions || payload || []);
    return clone(payload);
  }

  prompt(sessionId, prompt, options = {}) {
    const id = String(sessionId || '');
    const session = this.sessions.get(id);
    if (!session || session.generation !== this.generation) {
      return Promise.reject(errorWithCode('ACP session is unavailable; reconnect and resume it', 'session-stale'));
    }
    if (session.inflight) return Promise.reject(errorWithCode('ACP session already has a prompt in flight', 'session-busy'));
    const operation = this.request('session/prompt', { sessionId: id, prompt: normalizePrompt(prompt) }, options);
    const wrapped = Promise.resolve(operation).then((result) => {
      if (session.generation !== this.generation) throw errorWithCode('Stale ACP prompt response', 'stale-result');
      const payload = result?.result || result?.payload || result;
      // The official dsh returns `{accepted:true}` before its event stream receives the
      // terminal `bridge/prompt_done`/`bridge/prompt_error`. Keep the slot
      // occupied for that whole turn so ACP's one-prompt-per-session rule is
      // enforced in the WebView too.
      if (!payload?.accepted || payload?.stopReason) session.inflight = null;
      return clone(payload);
    }, (error) => {
      session.inflight = null;
      throw asError(error);
    });
    session.inflight = { operation: wrapped, generation: this.generation };
    return Object.assign(wrapped, {
      requestId: operation?.requestId,
      cancel: () => this.cancel(id, options)
    });
  }

  async cancel(sessionId, options = {}) {
    const id = String(sessionId || '');
    const session = this.sessions.get(id);
    if (!session) return { cancelled: false, sessionId: id };
    const result = await this.notify('session/cancel', { sessionId: id }, options);
    session.inflight = null;
    return clone(result?.result || result?.payload || result || { cancelled: true, sessionId: id });
  }

  /** Respond to an official dsh permission request when the native bridge supports it. */
  respondPermission(requestId, outcome, options = {}) {
    if (!requestId) return Promise.reject(errorWithCode('Permission request id is required', 'invalid-params'));
    if (!['allow-once', 'reject-once', 'cancelled'].includes(outcome)) {
      return Promise.reject(errorWithCode('Unsupported ACP permission outcome', 'invalid-params'));
    }
    const optionId = outcome === 'cancelled' ? 'reject-once' : outcome;
    return this.notify('bridge/permission_response', { requestId, optionId }, options);
  }

  receive(event = {}) {
    const value = event?.event && typeof event.event === 'object' ? event.event : event;
    const method = String(value?.method || value?.type || '');
    const params = value?.params || value?.payload || value;
    const sessionId = String(params?.sessionId || value?.sessionId || '');
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (session && session.generation !== this.generation) {
      this.emitStatus({ type: 'stale-event-discarded', method, sessionId });
      return false;
    }
    if (value?.generation != null && Number(value.generation) !== this.generation) {
      this.emitStatus({ type: 'stale-event-discarded', method, sessionId });
      return false;
    }
    if (session && method === 'session/update') {
      const update = params.update || params;
      this.emit({ type: 'session-update', sessionId, update: clone(update), generation: this.generation });
      if (['done', 'error'].includes(update.sessionUpdate)) session.inflight = null;
      return true;
    }
    // DshHostService also projects ACP events onto the legacy stream shape so
    // existing DshGateway consumers keep working. Accept that projection
    // here when the client is used directly by the WebView.
    if (session && ['delta', 'thought', 'tool_call', 'tool_result', 'usage', 'done', 'error'].includes(value.kind)) {
      const update = value.kind === 'delta'
        ? { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.text || '' } }
        : value.kind === 'thought'
          ? { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value.text || '' } }
          : value.kind === 'done' || value.kind === 'error'
            ? { sessionUpdate: value.kind, stopReason: value.stopReason || value.code || '' }
            : { sessionUpdate: value.kind, ...clone(value) };
      this.emit({ type: 'session-update', sessionId, update, generation: this.generation });
      if (['done', 'error'].includes(value.kind)) session.inflight = null;
      return true;
    }
    if (session && ['bridge/prompt_done', 'bridge/prompt_error', 'session/finished'].includes(method)) {
      const terminal = method === 'bridge/prompt_error' ? 'error' : 'done';
      session.inflight = null;
      this.emit({ type: 'session-update', sessionId,
        update: { sessionUpdate: terminal, stopReason: params.stopReason || params.error || '' },
        generation: this.generation });
      return true;
    }
    if (method === 'session/request_permission' || method === 'request_permission') {
      this.emit({ type: 'permission-request', sessionId, requestId: params.requestId || value.id || randomId('permission'), request: clone(params), generation: this.generation });
      return true;
    }
    this.emit({ ...clone(value), type: method || value.type || 'event', sessionId: sessionId || undefined, generation: this.generation });
    return true;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    try { this.unsubscribeEvents?.(); } catch (_) { }
    try { this.unsubscribeStatus?.(); } catch (_) { }
    this.listeners.clear();
    this.statusListeners.clear();
    this.sessions.clear();
  }
}
