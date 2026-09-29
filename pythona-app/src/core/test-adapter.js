/** Protocol-v2 client for workspace test discovery and execution. */

export class TestError extends Error {
  constructor(message, code = 'test-error', details = null) {
    super(message);
    this.name = 'TestError';
    this.code = code;
    this.details = details;
  }
}

function parse(value) {
  const result = typeof value === 'string' ? JSON.parse(value) : value;
  if (result?.error) {
    const detail = typeof result.error === 'string' ? { message: result.error } : result.error;
    throw new TestError(detail?.message || 'Test request failed', detail?.code || result.code || 'test-error', detail?.details || null);
  }
  return result?.result ?? result;
}

export function normalizeTestResult(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const counts = source.counts && typeof source.counts === 'object' ? source.counts : {};
  const cases = Array.isArray(source.cases) ? source.cases : [];
  return {
    framework: source.framework === 'pytest' ? 'pytest' : 'unittest',
    status: String(source.status || 'error'),
    message: String(source.message || ''),
    restartRequired: Boolean(source.restartRequired),
    counts: {
      collected: Number.isFinite(Number(counts.collected)) ? Number(counts.collected) : cases.length,
      passed: Number(counts.passed) || 0,
      failed: Number(counts.failed) || 0,
      skipped: Number(counts.skipped) || 0,
      errors: Number(counts.errors) || 0
    },
    cases: cases.slice(0, 500).map((item) => ({
      id: String(item?.id || item?.nodeId || item?.path || ''),
      nodeId: String(item?.nodeId || item?.id || ''),
      name: String(item?.name || item?.nodeId || ''),
      path: String(item?.path || ''),
      line: Number(item?.line) || 0,
      column: Number(item?.column) || 0,
      outcome: ['passed', 'failed', 'skipped', 'error'].includes(item?.outcome) ? item.outcome : 'error',
      durationMillis: Number(item?.durationMillis) || 0,
      message: String(item?.message || ''),
      traceback: String(item?.traceback || '')
    })),
    stdout: String(source.stdout || ''),
    stderr: String(source.stderr || ''),
    truncated: Boolean(source.truncated),
    durationMillis: Number(source.durationMillis) || 0
  };
}

export class TestAdapter {
  constructor(options = {}) {
    this.bridge = options.bridge || null;
    this.listeners = new Set();
    this.runs = new Map();
    this.activeRunId = null;
    this.reportedCapabilities = null;
    this.unsubscribeBridge = typeof this.bridge?.subscribe === 'function'
      ? this.bridge.subscribe('test', (event) => this.handleEvent(event))
      : null;
    this.unsubscribeLifecycle = typeof this.bridge?.subscribe === 'function'
      ? this.bridge.subscribe('runtime', (event) => this.handleLifecycle(event))
      : null;
    this.unsubscribeStatus = typeof this.bridge?.subscribeStatus === 'function'
      ? this.bridge.subscribeStatus((event) => this.handleLifecycle(event))
      : null;
  }

  get available() { return Boolean(this.bridge?.available && typeof this.bridge?.request === 'function'); }
  get running() {
    return this.activeRunId ? this.runs.get(this.activeRunId) || { runId: this.activeRunId } : null;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  emit(event) { this.listeners.forEach((listener) => listener({ ...event, timestamp: Date.now() })); }

  capabilities() {
    if (!this.reportedCapabilities) return {
      available: false, framework: 'unittest', fallback: 'unittest', pytest: false,
      methods: [], network: false, reason: this.available ? 'capability-pending' : 'android-only'
    };
    return {
      ...this.reportedCapabilities,
      methods: Array.isArray(this.reportedCapabilities.methods) ? [...this.reportedCapabilities.methods] : []
    };
  }

  async refreshCapabilities(options = {}) {
    if (!this.available) { this.reportedCapabilities = null; return this.capabilities(); }
    try {
      const value = parse(await this.bridge.request('test', 'capabilities', {}, options));
      this.reportedCapabilities = {
        ...value,
        available: Boolean(value?.available),
        framework: value?.framework === 'pytest' ? 'pytest' : 'unittest',
        fallback: 'unittest',
        pytest: Boolean(value?.pytest || value?.framework === 'pytest'),
        methods: Array.isArray(value?.methods) ? value.methods.map(String) : []
      };
      this.emit({ type: 'capabilities', capabilities: this.capabilities() });
    } catch (error) {
      this.emit({ type: 'capabilities-failed', error });
    }
    return this.capabilities();
  }

  async discover(options = {}) {
    if (!this.available) return { framework: 'unittest', files: [], count: 0, available: false };
    try {
      return parse(await this.bridge.request('test', 'discover', this.payload(options), options)) || {};
    } catch (error) {
      throw error instanceof TestError ? error : new TestError(error?.message || String(error), error?.code || 'test-discover-failed');
    }
  }

  async run(options = {}) {
    if (!this.available) throw new TestError('Workspace tests require Android Runtime', 'test-android-only');
    if (this.running) throw new TestError('A test task is already active', 'test-busy');
    const runId = String(options.runId || 'test-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + ++TestAdapter.sequence));
    if (this.runs.has(runId)) throw new TestError('Duplicate test run id', 'duplicate-run-id');
    const payload = this.payload({ ...options, runId });
    payload.sessionId = options.sessionId || runId;
    let resolve;
    const terminal = new Promise(done => { resolve = done; });
    const state = { runId, identity: { workspaceId: payload.workspaceId, sessionId: payload.sessionId,
      uri: payload.uri, epoch: payload.epoch, bufferVersion: payload.bufferVersion },
      output: [], outputChars: 0, result: null, terminal, resolve };
    this.runs.set(runId, state);
    this.activeRunId = runId;
    try {
      const value = parse(await this.bridge.request('test', 'run', payload, options));
      if (value?.accepted !== true || (value.runId != null && value.runId !== runId)) {
        throw new TestError('Test admission rejected', 'test-run-rejected');
      }
      if (!state.result) this.emit({ type: 'accepted', runId });
      return { ...value, runId };
    } catch (error) {
      this.finish(state, { status: 'error', message: error.message, counts: { errors: 1 } });
      throw error;
    }
  }

  wait(runId) {
    const state = this.runs.get(String(runId));
    if (!state) return Promise.reject(new TestError('Unknown test run id', 'unknown-run-id'));
    return state.terminal;
  }

  async cancel(runId, options = {}) {
    const id = String(runId || '').trim();
    if (!id) throw new TestError('A test run id is required', 'invalid-run-id');
    if (!this.available) return { accepted: false, runId: id };
    const response = parse(await this.bridge.request('test', 'cancel', { runId: id }, options));
    if (response?.accepted) this.emit({ type: 'stopping', runId: id });
    return response;
  }

  payload(options) {
    const paths = Array.isArray(options.paths) ? options.paths.map(String) : undefined;
    const payload = {
      workspaceId: options.workspaceId || 'default',
      uri: options.uri || undefined,
      epoch: options.epoch == null ? undefined : Number(options.epoch),
      bufferVersion: options.bufferVersion == null ? undefined : Number(options.bufferVersion),
      framework: options.framework || undefined,
      path: options.path || undefined,
      paths,
      nodeId: options.nodeId || undefined,
      args: Array.isArray(options.args || options.testArgs) ? (options.args || options.testArgs).map(String) : [],
      workingDirectory: options.workingDirectory || options.cwd || '/',
      environment: options.environment || options.env || {},
      envFiles: Array.isArray(options.envFiles) ? options.envFiles.map(String) : [],
      timeoutMillis: Number(options.timeoutMillis) || 0,
      runId: options.runId || undefined
    };
    Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
    return payload;
  }

  handleEvent(event = {}) {
    const id = String(event.runId || '');
    const state = this.runs.get(id);
    if (!state || state.result) return;
    for (const [key, value] of Object.entries(state.identity)) {
      if (value != null && event[key] != null && String(value) !== String(event[key])) {
        this.emit({ type: 'stale-result', runId: id });
        return;
      }
    }
    if (event.type === 'output') {
      const text = String(event.text || '');
      const remaining = Math.max(0, 65536 - state.outputChars);
      state.output.push({ stream: event.stream || 'stdout', text: text.slice(0, remaining) });
      state.outputChars += Math.min(remaining, text.length);
      state.outputTruncated ||= text.length > remaining;
      if (!remaining) state.output.pop();
    }
    if (event.type === 'finished') this.finish(state, event.result || {});
    else this.emit({ ...event, runId: id });
  }

  finish(state, result) {
    if (!state || state.result) return;
    state.result = normalizeTestResult({ framework: this.reportedCapabilities?.framework, ...result });
    state.result.stdout ||= state.output.filter(x => x.stream === 'stdout').map(x => x.text).join('');
    state.result.stderr ||= state.output.filter(x => x.stream === 'stderr').map(x => x.text).join('');
    state.result.truncated ||= Boolean(state.outputTruncated);
    if (this.activeRunId === state.runId) this.activeRunId = null;
    state.resolve(state.result);
    this.emit({ type: 'finished', runId: state.runId, result: state.result });
    // Bound retained reports across an all-day IDE session.
    while (this.runs.size > 8) {
      const removable = [...this.runs.values()].find(s => s.result && s !== state);
      if (!removable) break;
      this.runs.delete(removable.runId);
    }
  }

  handleLifecycle(event = {}) {
    if (event.channel && !['runtime', 'test'].includes(event.channel)) return;
    if (!['disconnected', 'reconnecting', 'binding-died', 'null-binding', 'service-crashed', 'service-disconnected'].includes(event.type)) return;
    this.reportedCapabilities = null;
    this.finish(this.running, { status: 'error', message: event.message || 'Runtime restarted',
      counts: { collected: 0, errors: 1 }, truncated: true });
  }

  dispose() {
    this.finish(this.running, { status: 'cancelled', message: 'Test adapter closed', truncated: true });
    this.unsubscribeBridge?.(); this.unsubscribeLifecycle?.();
    this.unsubscribeStatus?.();
    this.listeners.clear(); this.runs.clear(); this.activeRunId = null;
  }
}

TestAdapter.sequence = 0;

export function createTestResultTree(result) {
  const tree = new Map();
  for (const item of normalizeTestResult(result).cases) {
    const key = item.path || '<workspace>';
    const list = tree.get(key) || [];
    list.push(item);
    tree.set(key, list);
  }
  return [...tree.entries()].map(([path, cases]) => ({ path, cases }));
}
