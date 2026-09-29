export class RuntimeError extends Error {
  constructor(message, code = 'runtime-error') {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

export class RuntimePackError extends RuntimeError {
  constructor(message, code = 'runtime-pack-error', details = null) {
    super(message, code);
    this.name = 'RuntimePackError';
    this.details = details;
  }
}

export class PythonPackageError extends RuntimeError {
  constructor(message, code = 'python-package-error', details = null) {
    super(message, code);
    this.name = 'PythonPackageError';
    this.details = details;
  }
}

function parseBridgeValue(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed?.error) throw new RuntimeError(parsed.error, parsed.code || 'bridge-error');
  return parsed;
}

function shellQuote(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./-]+$/.test(text)) return text;
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

function normalizePackage(item) {
  if (item && typeof item === 'object') {
    return {
      name: String(item.name || item.package || 'unknown'),
      version: item.version == null ? null : String(item.version),
      status: item.status || 'installed',
      source: item.source || null,
      packId: item.packId || null
    };
  }
  const [name, detail = 'provider pending'] = String(item || '').split(/\s+·\s+/, 2);
  const versionMatch = detail.match(/^v?(\d+(?:\.\d+)+(?:[-+._A-Za-z0-9]*)?)/);
  return {
    name: name || 'unknown',
    version: versionMatch ? versionMatch[1] : null,
    status: versionMatch ? 'installed' : detail,
    source: null,
    packId: null
  };
}

function packageLabel(item) {
  const detail = item.version || item.status || 'installed';
  return item.name + ' · ' + detail;
}

function parseRuntimePackValue(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RuntimePackError('Runtime Pack response is invalid', 'invalid-runtime-pack-response');
    }
    if (parsed.error) {
      const detail = typeof parsed.error === 'string' ? { message: parsed.error } : parsed.error;
      throw new RuntimePackError(
        detail?.message || 'Runtime Pack request failed',
        detail?.code || parsed.code || 'runtime-pack-error',
        detail?.details || null
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof RuntimePackError) throw error;
    throw new RuntimePackError(error?.message || String(error), 'invalid-runtime-pack-response');
  }
}

function normalizeRuntimePackResult(value, fallbackStatus) {
  const result = parseRuntimePackValue(value);
  const hasAccepted = Object.prototype.hasOwnProperty.call(result, 'accepted');
  const hasOk = Object.prototype.hasOwnProperty.call(result, 'ok');
  const accepted = hasAccepted
    ? Boolean(result.accepted)
    : (hasOk ? Boolean(result.ok) : !/(?:failed|invalid|unavailable|required)$/i.test(String(result.status || '')));
  return {
    ...result,
    status: String(result.status || fallbackStatus),
    accepted,
    ok: accepted
  };
}

function parsePythonPackageValue(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PythonPackageError('Python package response is invalid', 'invalid-python-package-response');
    }
    if (parsed.error) {
      const detail = typeof parsed.error === 'string' ? { message: parsed.error } : parsed.error;
      throw new PythonPackageError(
        detail?.message || 'Python package request failed',
        detail?.code || parsed.code || 'python-package-error',
        detail?.details || null
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof PythonPackageError) throw error;
    throw new PythonPackageError(error?.message || String(error), 'invalid-python-package-response');
  }
}

function normalizePythonPackageResult(value, fallbackStatus) {
  const result = parsePythonPackageValue(value);
  const hasAccepted = Object.prototype.hasOwnProperty.call(result, 'accepted');
  const hasOk = Object.prototype.hasOwnProperty.call(result, 'ok');
  const status = String(result.status || fallbackStatus);
  const accepted = hasAccepted
    ? Boolean(result.accepted)
    : (hasOk ? Boolean(result.ok) : !/(?:failed|invalid|unavailable|required|busy)$/i.test(status));
  return { ...result, status, accepted, ok: hasOk ? Boolean(result.ok) : accepted };
}

/**
 * Client for user-selected, platform-independent pure Python wheels.
 *
 * Native extensions and sdists deliberately do not share this path. Android
 * validates the wheel filename, WHEEL metadata and every ZIP entry before an
 * atomic install into the app-private environment.
 */
export class NativePythonPackageClient {
  constructor(broker, options = {}) {
    this.broker = broker || null;
    this.environmentId = options.environmentId || 'default';
    this.reportedCapabilities = null;
  }

  get available() {
    return Boolean(this.broker?.available && typeof this.broker?.request === 'function');
  }

  capabilities() {
    if (!this.reportedCapabilities) {
      return {
        available: false,
        pickerAvailable: false,
        mode: this.available ? 'pure-python-wheel' : 'browser-preview',
        methods: [],
        pythonTags: [],
        abiTag: 'none',
        platformTag: 'any',
        nativeExtensions: false,
        sdist: false,
        reason: this.available ? 'capability-pending' : 'android-only'
      };
    }
    return {
      ...this.reportedCapabilities,
      methods: [...this.reportedCapabilities.methods],
      pythonTags: [...this.reportedCapabilities.pythonTags]
    };
  }

  async refreshCapabilities(options = {}) {
    if (!this.available) {
      this.reportedCapabilities = null;
      return this.capabilities();
    }
    let reported;
    try {
      reported = parsePythonPackageValue(
        await this.broker.request('pythonPackage', 'capabilities', {
          environmentId: this.environmentId
        }, options)
      );
    } catch (error) {
      throw error instanceof PythonPackageError
        ? error
        : new PythonPackageError(
          error?.message || String(error),
          error?.code || 'python-package-capabilities-failed',
          error?.details || null
        );
    }
    const methods = Array.isArray(reported.methods) ? reported.methods.map(String) : [];
    const pythonTags = Array.isArray(reported.pythonTags) ? reported.pythonTags.map(String) : [];
    const available = Boolean(reported.available);
    const pickerAvailable = Boolean(
      available && (reported.pickerAvailable || methods.includes('pickAndInstall'))
    );
    this.reportedCapabilities = {
      ...reported,
      available,
      pickerAvailable,
      methods,
      pythonTags,
      nativeExtensions: false,
      sdist: false,
      reason: reported.reason || (pickerAvailable ? null : 'saf-picker-unavailable')
    };
    return this.capabilities();
  }

  async request(method, payload = {}, options = {}) {
    if (!this.available) {
      throw new PythonPackageError(
        'Pure Python wheel management is only available in the PythonA Android app',
        'python-package-android-only'
      );
    }
    try {
      return await this.broker.request('pythonPackage', method, {
        environmentId: this.environmentId,
        ...payload
      }, options);
    } catch (error) {
      throw error instanceof PythonPackageError
        ? error
        : new PythonPackageError(
          error?.message || String(error),
          error?.code || 'python-package-request-failed',
          error?.details || null
        );
    }
  }

  async list(options = {}) {
    const value = parsePythonPackageValue(await this.request('list', {}, options));
    const packages = Array.isArray(value.packages)
      ? value.packages.filter((item) => item && typeof item === 'object').map((item) => ({ ...item }))
      : [];
    return { ...value, packages };
  }

  async pickAndInstall(options = {}) {
    const capabilities = options.skipCapabilityRefresh
      ? this.capabilities()
      : await this.refreshCapabilities(options);
    if (!capabilities.pickerAvailable) {
      throw new PythonPackageError(
        capabilities.available
          ? 'This Android build does not expose a wheel SAF picker'
          : 'Pure Python wheel import is only available in the PythonA Android app',
        capabilities.available ? 'python-package-picker-unavailable' : 'python-package-android-only'
      );
    }
    if (options.confirmed !== true) {
      throw new PythonPackageError(
        'User confirmation is required before installing a wheel',
        'confirmation-required'
      );
    }
    const result = await this.request('pickAndInstall', { confirmed: true }, options);
    return normalizePythonPackageResult(result, 'installed');
  }

  async install(uri, options = {}) {
    const contentUri = String(uri || '').trim();
    if (!contentUri.startsWith('content://')) {
      throw new PythonPackageError(
        'Wheel install requires an Android content URI',
        'content-uri-required'
      );
    }
    if (options.confirmed !== true) {
      throw new PythonPackageError(
        'User confirmation is required before installing a wheel',
        'confirmation-required'
      );
    }
    const result = await this.request('install', {
      uri: contentUri,
      confirmed: true
    }, options);
    return normalizePythonPackageResult(result, 'installed');
  }
}

/**
 * Client for authenticated `.pya-pack` lifecycle operations.
 *
 * This intentionally stays separate from RuntimeAdapter.activatePack(): the
 * Runtime service activates an already installed environment, while this
 * client owns the Android document picker, signature verification, staging
 * and rollback transaction exposed by the local `runtimePack` channel.
 */
export class NativeRuntimePackClient {
  constructor(broker) {
    this.broker = broker || null;
    this.reportedCapabilities = null;
  }

  get available() {
    return Boolean(this.broker?.available && typeof this.broker?.request === 'function');
  }

  capabilities() {
    if (!this.reportedCapabilities) {
      return {
        available: false,
        installerAvailable: false,
        pickerAvailable: false,
        mode: this.available ? 'android-runtime-pack' : 'browser-preview',
        methods: [],
        active: [],
        signature: 'Ed25519',
        reason: this.available ? 'capability-pending' : 'android-only'
      };
    }
    return {
      ...this.reportedCapabilities,
      methods: [...this.reportedCapabilities.methods],
      active: this.reportedCapabilities.active.map((item) => ({ ...item }))
    };
  }

  async refreshCapabilities(options = {}) {
    if (!this.available) {
      this.reportedCapabilities = null;
      return this.capabilities();
    }
    let reported;
    try {
      reported = parseRuntimePackValue(
        await this.broker.request('runtimePack', 'capabilities', {}, options)
      );
    } catch (error) {
      throw error instanceof RuntimePackError
        ? error
        : new RuntimePackError(error?.message || String(error), error?.code || 'runtime-pack-capabilities-failed');
    }
    const methods = Array.isArray(reported.methods) ? reported.methods.map(String) : [];
    const active = Array.isArray(reported.active)
      ? reported.active.filter((item) => item && typeof item === 'object').map((item) => ({ ...item }))
      : [];
    const pickerAvailable = Boolean(
      reported.pickerAvailable
      || reported.safPickerAvailable
      || methods.includes('pickAndInstall')
    );
    this.reportedCapabilities = {
      ...reported,
      available: Boolean(reported.installerAvailable),
      installerAvailable: Boolean(reported.installerAvailable),
      pickerAvailable,
      methods,
      active,
      reason: reported.reason || (pickerAvailable ? null : 'saf-picker-unavailable')
    };
    return this.capabilities();
  }

  async request(method, payload = {}, options = {}) {
    if (!this.available) {
      throw new RuntimePackError(
        'Signed Runtime Pack management is only available in the PythonA Android app',
        'runtime-pack-android-only'
      );
    }
    try {
      return await this.broker.request('runtimePack', method, payload, options);
    } catch (error) {
      throw error instanceof RuntimePackError
        ? error
        : new RuntimePackError(error?.message || String(error), error?.code || 'runtime-pack-request-failed', error?.details || null);
    }
  }

  /** Open the native SAF picker and let Android authenticate and install it. */
  async pickAndInstall(options = {}) {
    const capabilities = options.skipCapabilityRefresh
      ? this.capabilities()
      : await this.refreshCapabilities(options);
    if (!capabilities.pickerAvailable) {
      throw new RuntimePackError(
        capabilities.available
          ? 'This Android build does not expose a Runtime Pack SAF picker'
          : 'Signed Runtime Pack import is only available in the PythonA Android app',
        capabilities.available ? 'runtime-pack-picker-unavailable' : 'runtime-pack-android-only'
      );
    }
    if (options.confirmed !== true) {
      throw new RuntimePackError(
        'User confirmation is required before importing a Runtime Pack',
        'confirmation-required'
      );
    }
    const result = await this.request('pickAndInstall', { confirmed: true }, options);
    return normalizeRuntimePackResult(result, 'install-complete');
  }

  /** Install a content URI supplied by an already-authorized Android layer. */
  async install(uri, options = {}) {
    const contentUri = String(uri || '').trim();
    if (!contentUri.startsWith('content://')) {
      throw new RuntimePackError('Runtime Pack install requires an Android content URI', 'content-uri-required');
    }
    if (options.confirmed !== true) {
      throw new RuntimePackError(
        'User confirmation is required before importing a Runtime Pack',
        'confirmation-required'
      );
    }
    const result = await this.request('install', {
      uri: contentUri,
      confirmed: true
    }, options);
    return normalizeRuntimePackResult(result, 'install-complete');
  }

  async rollback(packId, options = {}) {
    const id = String(packId || '').trim();
    if (!id) throw new RuntimePackError('A Runtime Pack id is required', 'invalid-pack-id');
    if (options.confirmed !== true) {
      throw new RuntimePackError(
        'User confirmation is required before rolling back a Runtime Pack',
        'confirmation-required'
      );
    }
    const result = await this.request('rollback', { packId: id, confirmed: true }, options);
    return normalizeRuntimePackResult(result, 'rollback-complete');
  }
}

export class RuntimeAdapter {
  constructor(options = {}) {
    this.bridge = options.bridge || globalThis.PythonABridge || null;
    this.listeners = new Set();
    this.running = null;
    this.sequence = 0;
    this.capabilityRetryAttempt = 0;
    this.capabilityRetryTimer = null;
    this.mode = this.bridge ? 'android-bridge' : 'browser-fallback';
    this.reportedCapabilities = null;
    // These are candidate packages shown by the UI, not claims about an
    // installed Android environment. A native provider replaces the pending
    // capability state once it has inspected its actual ABI and wheel store.
    this.packageSet = new Set([
      'pip · Runtime 报告后可用',
      'setuptools · Runtime 报告后可用',
      'torch · 实验包不可用',
      'numpy · 签名运行包未安装',
      'pytest · Runtime 报告后可用'
    ]);
    this.unsubscribeBridge = typeof this.bridge?.subscribe === 'function'
      ? this.bridge.subscribe('runtime', (event) => this.handleBridgeEvent(event))
      : null;
    this.unsubscribeStatus = typeof this.bridge?.subscribeStatus === 'function'
      ? this.bridge.subscribeStatus((event) => this.handleStatus(event))
      : null;
    // First launch may extract the embedded stdlib and Jedi tree. Give that
    // one-time readiness probe more time than ordinary requests.
    this.ready = this.bridge
      ? this.refreshCapabilities({ timeoutMs: 120_000 })
      : Promise.resolve(this.capabilities());
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    this.listeners.forEach((listener) => listener({ ...event, timestamp: Date.now() }));
  }

  settleRun(state, terminal) {
    if (!state || state.settled) return false;
    state.settled = true;
    if (this.running === state) this.running = null;
    state.resolveTerminal?.(terminal);
    return true;
  }

  capabilities() {
    if (this.reportedCapabilities) {
      const explicitlyAvailable = Object.prototype.hasOwnProperty.call(this.reportedCapabilities, 'available');
      const inferredUnavailable = /stub|pending|not bundled/i.test([
        this.reportedCapabilities.mode,
        this.reportedCapabilities.python
      ].join(' '));
      return {
        mode: this.reportedCapabilities.mode || this.mode,
        python: this.reportedCapabilities.python || 'Android Runtime bridge',
        abi: this.reportedCapabilities.abi || 'provider pending',
        pytorch: this.reportedCapabilities.pytorch || '实验包不可用',
        network: Boolean(this.reportedCapabilities.network),
        available: explicitlyAvailable ? Boolean(this.reportedCapabilities.available) : !inferredUnavailable,
        terminal: this.reportedCapabilities.terminal || 'provider pending',
        protocolVersion: Number(this.reportedCapabilities.protocolVersion) || 1,
        methods: Array.isArray(this.reportedCapabilities.methods) ? [...this.reportedCapabilities.methods] : [],
        packs: Array.isArray(this.reportedCapabilities.packs) ? [...this.reportedCapabilities.packs] : [],
        features: this.reportedCapabilities.features && typeof this.reportedCapabilities.features === 'object'
          ? { ...this.reportedCapabilities.features }
          : {},
        reason: this.reportedCapabilities.reason || null
      };
    }
    return {
      mode: this.mode,
      python: this.mode === 'android-bridge' ? 'Android Runtime bridge · capability pending' : 'browser fallback',
      abi: this.mode === 'android-bridge' ? 'provider pending' : 'n/a',
      pytorch: '实验包不可用',
      network: false,
      available: false,
      terminal: this.mode === 'android-bridge' ? 'provider pending' : 'managed console unavailable',
      protocolVersion: 1,
      methods: [],
      packs: [],
      features: {},
      reason: this.mode === 'android-bridge' ? 'capability-pending' : 'native-runtime-unavailable'
    };
  }

  async refreshCapabilities(options = {}) {
    if (!this.bridge) return this.capabilities();
    try {
      const reported = await this.invokeBridge('capabilities', {}, options);
      if (!reported || typeof reported !== 'object') throw new RuntimeError('Runtime capability response is invalid', 'invalid-capabilities');
      this.reportedCapabilities = reported;
      this.capabilityRetryAttempt = 0;
      if (this.capabilityRetryTimer) clearTimeout(this.capabilityRetryTimer);
      this.capabilityRetryTimer = null;
      const capabilities = this.capabilities();
      this.emit({ type: 'capabilities', capabilities });
      return capabilities;
    } catch (error) {
      const wrapped = error instanceof RuntimeError ? error : new RuntimeError(error.message || String(error), 'capability-check-failed');
      this.emit({ type: 'capabilities-failed', error: wrapped });
      const transient = new Set([
        'native-timeout', 'service-timeout', 'service-disconnected',
        'service-binding-died', 'service-send-failed', 'runtime-service-unavailable'
      ]).has(wrapped.code);
      if (transient && this.bridge && this.capabilityRetryAttempt < 3 && !this.capabilityRetryTimer) {
        const delay = 1000 * (2 ** this.capabilityRetryAttempt++);
        this.capabilityRetryTimer = setTimeout(() => {
          this.capabilityRetryTimer = null;
          this.refreshCapabilities({ timeoutMs: 120_000 });
        }, delay);
        this.capabilityRetryTimer.unref?.();
      }
      return this.capabilities();
    }
  }

  async invokeBridge(method, payload, options = {}) {
    if (!this.bridge) return null;
    if (typeof this.bridge.request === 'function') {
      try { return parseBridgeValue(await this.bridge.request('runtime', method, payload || {}, options)); }
      catch (error) { throw new RuntimeError(error?.message || String(error), error?.code || 'bridge-error'); }
    }
    if (typeof this.bridge.invoke === 'function') {
      const result = await this.bridge.invoke(JSON.stringify({ method, payload }));
      return parseBridgeValue(result);
    }
    if (typeof this.bridge[method] === 'function') {
      return parseBridgeValue(await this.bridge[method](JSON.stringify(payload || {})));
    }
    throw new RuntimeError('PythonA Android bridge does not expose ' + method, 'bridge-method-missing');
  }

  supportsMethod(method) {
    if (!this.bridge) return false;
    if (typeof this.bridge[method] === 'function') return true;
    const capabilities = this.capabilities();
    if (capabilities.methods.includes(method)) return true;
    const features = this.reportedCapabilities?.features;
    if (features && (features[method] === true || features[method]?.available === true)) return true;
    if (Number(capabilities.protocolVersion) >= 2) {
      if (method === 'runFile') return capabilities.available && (features?.execution !== false);
      if (method === 'stop') return capabilities.available;
      if (method === 'sendInput') return capabilities.available && features?.input !== false;
    }
    return false;
  }

  async run(command, options = {}) {
    return this.executeRun('run', String(command || ''), {
      command,
      cwd: options.cwd || '',
      file: options.file || null
    }, options);
  }

  async executeRun(method, command, payload, options = {}) {
    const runId = 'run-' + (++this.sequence);
    if (this.running) await this.stop();
    let resolveTerminal;
    const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
    const state = {
      runId,
      cancelled: false,
      phase: 'starting',
      startAccepted: false,
      settled: false,
      stopPromise: null,
      terminal,
      resolveTerminal
    };
    this.running = state;
    this.emit({ type: 'started', runId, command, mode: this.mode });
    try {
      if (this.bridge) {
        const result = await this.invokeBridge(method, { runId, ...payload });
        const stdout = result?.stdout ?? result?.output;
        if (stdout) this.emit({ type: 'output', runId, stream: 'stdout', text: stdout });
        if (result?.stderr) this.emit({ type: 'output', runId, stream: 'stderr', text: result.stderr });
        const hasExitCode = result != null && Object.prototype.hasOwnProperty.call(result, 'exitCode');
        if (!hasExitCode && (result?.started || result?.accepted || result?.running)) {
          const nativeRunId = result.runId || runId;
          state.startAccepted = true;
          state.runId = nativeRunId;
          if (this.running === state && state.phase === 'starting') state.phase = 'running';
          return { runId: nativeRunId, started: true, output: stdout || '', stderr: result?.stderr || '' };
        }
        const reportedExitCode = Number(result?.exitCode);
        const exitCode = Number.isFinite(reportedExitCode) ? reportedExitCode : 1;
        const terminalEvent = { type: 'finished', runId, exitCode };
        this.settleRun(state, terminalEvent);
        this.emit(terminalEvent);
        return { runId, exitCode, output: stdout || '', stderr: result?.stderr || '' };
      }
      const result = await this.runFallback(runId, command, options);
      this.settleRun(state, { type: 'finished', runId, exitCode: result.exitCode });
      return result;
    } catch (error) {
      const wrapped = error instanceof RuntimeError ? error : new RuntimeError(error.message || String(error));
      this.settleRun(state, { type: 'failed', runId, error: wrapped });
      this.emit({ type: 'failed', runId, error: wrapped });
      throw wrapped;
    }
  }

  /** Execute a workspace file through protocol v2, or the legacy command API. */
  async runFile(file, options = {}) {
    const path = String(file || '').trim();
    if (!path) throw new RuntimeError('A file path is required', 'invalid-file');
    await this.ready;
    const args = Array.isArray(options.args) ? options.args.map(String) : [];
    const command = ['python', shellQuote(path), ...args.map(shellQuote)].join(' ');
    if (!this.supportsMethod('runFile')) {
      return this.run(command, { ...options, file: path });
    }
    return this.executeRun('runFile', command, {
      path,
      file: path,
      workspaceId: options.workspaceId || 'default',
      environmentId: options.environmentId || options.environment || 'default',
      cwd: options.cwd || '',
      args,
      env: options.env || {},
      content: options.fileContent ?? options.content ?? null
    }, options);
  }

  /** Execute a validated persistent Python Run Configuration. */
  async runConfiguration(configuration, options = {}) {
    if (!configuration || typeof configuration !== 'object') {
      throw new RuntimeError('A resolved run configuration is required', 'invalid-run-configuration');
    }
    const targetKind = configuration.targetKind === 'module' ? 'module' : 'file';
    const target = String(configuration.target || '').trim();
    if (!target) throw new RuntimeError('Run configuration target is required', 'invalid-run-configuration');
    await this.ready;
    const args = Array.isArray(configuration.args) ? configuration.args.map(String) : [];
    const command = targetKind === 'module'
      ? ['python', '-m', shellQuote(target), ...args.map(shellQuote)].join(' ')
      : ['python', shellQuote(target), ...args.map(shellQuote)].join(' ');
    if (!this.supportsMethod('runConfiguration')) {
      const fallbackPath = targetKind === 'module' ? target.replaceAll('.', '/') + '.py' : target;
      return this.runFile(fallbackPath, {
        ...options,
        args,
        cwd: configuration.workingDirectory || '/',
        environmentId: configuration.interpreterId || 'bundled-cpython',
        env: configuration.environment || {}
      });
    }
    return this.executeRun('runConfiguration', command, {
      workspaceId: options.workspaceId || 'default',
      configuration
    }, options);
  }

  /** Send stdin to an active native process without claiming browser support. */
  async sendInput(text) {
    if (!this.running) throw new RuntimeError('There is no running process', 'no-running-process');
    await this.ready;
    if (!this.supportsMethod('sendInput')) return false;
    const runId = this.running.runId;
    const value = String(text ?? '');
    const result = await this.invokeBridge('sendInput', { runId, text: value });
    this.emit({ type: 'input', runId, text: value });
    return result == null ? true : result;
  }

  /** Return normalized package records while preserving the legacy packageSet. */
  async listPackages(options = {}) {
    await this.ready;
    if (!this.supportsMethod('listPackages')) {
      return [...this.packageSet].map(normalizePackage);
    }
    const result = await this.invokeBridge('listPackages', {
      environment: options.environment || null,
      packId: options.packId || null
    });
    const source = Array.isArray(result) ? result : result?.packages;
    if (!Array.isArray(source)) throw new RuntimeError('Runtime package response is invalid', 'invalid-packages');
    const packages = source.map(normalizePackage);
    this.packageSet = new Set(packages.map(packageLabel));
    this.emit({ type: 'packages', packages });
    return packages;
  }

  /** Activate a separately installed runtime pack when the provider supports it. */
  async activatePack(packId, options = {}) {
    const id = String(packId || '').trim();
    if (!id) throw new RuntimeError('A runtime pack id is required', 'invalid-pack-id');
    await this.ready;
    if (!this.supportsMethod('activatePack')) {
      return { ok: false, supported: false, packId: id };
    }
    const result = await this.invokeBridge('activatePack', {
      packId: id,
      buildId: options.buildId || null,
      environment: options.environment || null,
      confirmed: options.confirmed === true
    });
    this.emit({ type: 'pack-activated', packId: id, result });
    if (result?.status !== 'activation-pending-restart') await this.refreshCapabilities();
    return { ...result, ok: result?.ok !== false, supported: true, packId: id };
  }

  async runFallback(runId, command, options) {
    const stderr = 'CPython Runtime is unavailable. PythonA did not execute or simulate this script.\n';
    this.emit({ type: 'output', runId, stream: 'stderr', text: stderr });
    this.emit({ type: 'finished', runId, exitCode: 126 });
    return { runId, exitCode: 126, output: '', stderr };
  }

  handleStatus(event = {}) {
    if (event.channel && !['runtime', 'test'].includes(event.channel)) return;
    if (!['disconnected', 'reconnecting', 'binding-died', 'null-binding', 'service-crashed', 'service-disconnected'].includes(event.type)) return;
    this.reportedCapabilities = null;
    const state = this.running;
    if (state) {
      const error = new RuntimeError(event.error?.message || event.message || 'Runtime service disconnected', 'runtime-disconnected');
      const terminal = state.phase === 'stopping'
        ? { type:'stopped', runId:state.runId, exitCode:130, cancelled:true, forced:true, recoverable:true }
        : { type:'failed', runId:state.runId, error, recoverable:true };
      this.settleRun(state, terminal);
      this.emit(terminal);
    }
    // Do not recursively issue another capabilities call from its own error.
    this.emit({ type:'service-disconnected', channel:'runtime', recoverable:true });
  }

  handleBridgeEvent(event = {}) {
    if (event.channel && !['runtime', 'test'].includes(event.channel)) return;
    const type = event.type || event.event || event.kind;
    if (type === 'service-disconnected') {
      this.handleStatus({ ...event, type, channel: event.channel || 'runtime' });
      return;
    }
    const state = this.running;
    const runId = event.runId || state?.runId || null;
    if (type === 'stdout' || type === 'stderr' || type === 'output') {
      this.emit({
        type: 'output', runId,
        stream: type === 'stderr' ? 'stderr' : (event.stream || 'stdout'),
        text: String(event.text ?? event.data ?? '')
      });
      return;
    }
    if (type === 'input-request' || type === 'stdin-request') {
      this.emit({ type: 'input-request', runId, prompt: String(event.prompt || '') });
      return;
    }
    if (type === 'finished' || type === 'exit') {
      if (!state || (runId && state.runId !== runId)) return;
      const exitCode = Number.isFinite(Number(event.exitCode)) ? Number(event.exitCode) : 1;
      const cancelled = event.cancelled === true || state.cancelled;
      const terminalEvent = {
        type: cancelled ? 'stopped' : 'finished',
        runId,
        exitCode,
        cancelled
      };
      this.settleRun(state, terminalEvent);
      this.emit(terminalEvent);
      return;
    }
    if (type === 'crashed' || type === 'service-crashed') {
      const error = new RuntimeError(event.message || 'Runtime process crashed and will restart', 'runtime-crashed');
      const terminalEvent = state?.phase === 'stopping'
        ? { type: 'stopped', runId, exitCode: 130, cancelled: true, forced: true, recoverable: true }
        : { type: 'failed', runId, error, recoverable: true };
      if (state) this.settleRun(state, terminalEvent);
      this.emit(terminalEvent);
      this.refreshCapabilities();
      return;
    }
    if (type === 'service-connected' || type === 'service-reconnected') {
      this.emit({ type, recoverable: true });
      this.refreshCapabilities({ timeoutMs: 120_000 });
    }
  }

  async stop() {
    const state = this.running;
    if (!state) return { ok: true, alreadyStopped: true };
    if (state.stopPromise) return state.stopPromise;
    state.cancelled = true;
    state.phase = 'stopping';

    const operation = (async () => {
      let acknowledgement;
      try {
        acknowledgement = this.bridge
          ? await this.invokeBridge('stop', { runId: state.runId })
          : null;
      } catch (error) {
        if (this.running === state && !state.settled) {
          state.cancelled = false;
          state.phase = state.startAccepted ? 'running' : 'starting';
        }
        const wrapped = error instanceof RuntimeError
          ? error
          : new RuntimeError(error?.message || String(error), error?.code || 'stop-failed');
        this.emit({ type: 'stop-failed', runId: state.runId, error: wrapped });
        throw wrapped;
      }

      const acknowledged = acknowledgement === true
        || acknowledgement?.ok === true
        || acknowledgement?.accepted === true
        || acknowledgement?.cancellationRequested === true
        || acknowledgement?.stopped === true;
      if (!acknowledged && !state.settled) {
        state.cancelled = false;
        state.phase = state.startAccepted ? 'running' : 'starting';
        const error = new RuntimeError(
          'Runtime did not acknowledge the stop request',
          'stop-not-acknowledged'
        );
        this.emit({ type: 'stop-failed', runId: state.runId, error, acknowledgement });
        throw error;
      }
      if (!state.settled && this.running === state) {
        this.emit({ type: 'stopping', runId: state.runId, acknowledgement });
      }
      const terminalEvent = await state.terminal;
      return { ok: true, acknowledgement, terminal: terminalEvent };
    })();
    state.stopPromise = operation;
    const clearStopPromise = () => {
      if (state.stopPromise === operation) state.stopPromise = null;
    };
    operation.then(clearStopPromise, clearStopPromise);
    return operation;
  }

  dispose() {
    if (this.capabilityRetryTimer) clearTimeout(this.capabilityRetryTimer);
    this.capabilityRetryTimer = null;
    this.unsubscribeBridge?.();
    this.unsubscribeStatus?.();
    this.unsubscribeBridge = null;
    this.unsubscribeStatus = null;
    this.listeners.clear();
  }
}
