const STORAGE_KEY = 'pythona.run-configurations.v1';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function id() { return globalThis.crypto?.randomUUID?.() || `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

export function normalizeRunConfiguration(input = {}) {
  const type = input.type === 'test' ? 'test' : 'python';
  const targetKind = input.targetKind === 'module' ? 'module' : 'file';
  const paths = Array.isArray(input.paths) ? input.paths.map(String).filter(Boolean) : [];
  const target = String(input.target || (type === 'test' ? (paths[0] || 'tests') : '')).trim();
  if (!target) throw new TypeError('Run configuration target is required');
  return {
    id: String(input.id || id()),
    name: String(input.name || target.split('/').at(-1) || target),
    type,
    targetKind,
    target,
    framework: type === 'test' ? (input.framework === 'unittest' ? 'unittest' : 'pytest') : null,
    paths,
    nodeId: type === 'test' && input.nodeId != null ? String(input.nodeId) : null,
    testArgs: type === 'test' && Array.isArray(input.testArgs) ? input.testArgs.map(String) : [],
    timeoutMillis: type === 'test' ? Math.max(0, Number(input.timeoutMillis) || 0) : 0,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    workingDirectory: String(input.workingDirectory || '/'),
    interpreterId: String(input.interpreterId || 'bundled-cpython'),
    environment: Object.fromEntries(Object.entries(input.environment || {}).map(([key, value]) => [String(key), String(value)])),
    envFiles: Array.isArray(input.envFiles) ? input.envFiles.map(String) : [],
    beforeRun: Array.isArray(input.beforeRun) ? input.beforeRun.map((item) => ({ ...item })) : [{ type: 'saveAll' }],
    shared: Boolean(input.shared),
    temporary: Boolean(input.temporary),
    lastRunAt: input.lastRunAt == null ? null : Number(input.lastRunAt)
  };
}

export class RunConfigurationStore {
  constructor(options = {}) {
    this.bridge = options.bridge || null;
    this.storage = options.storage || globalThis.localStorage || null;
    this.configurations = [];
  }

  async open() {
    let values = null;
    if (this.bridge?.available) {
      try { values = (await this.bridge.request('project', 'listRunConfigurations', { workspaceId: 'default' }))?.configurations; }
      catch (error) { if (error?.code !== 'unknown-channel') throw error; }
    }
    if (!values) {
      try { values = JSON.parse(this.storage?.getItem(STORAGE_KEY) || '[]'); } catch (error) { values = []; }
    }
    this.configurations = (Array.isArray(values) ? values : []).map(normalizeRunConfiguration);
    return this.list();
  }

  list() { return clone(this.configurations); }

  async create(value) {
    const configuration = normalizeRunConfiguration(value);
    if (this.configurations.some((item) => item.id === configuration.id)) throw new Error(`Duplicate run configuration: ${configuration.id}`);
    this.configurations.push(configuration);
    await this.persist();
    return clone(configuration);
  }

  async update(configurationId, value) {
    const index = this.configurations.findIndex((item) => item.id === configurationId);
    if (index < 0) throw new Error(`Unknown run configuration: ${configurationId}`);
    this.configurations[index] = normalizeRunConfiguration({ ...this.configurations[index], ...value, id: configurationId });
    await this.persist();
    return clone(this.configurations[index]);
  }

  async remove(configurationId) {
    const before = this.configurations.length;
    this.configurations = this.configurations.filter((item) => item.id !== configurationId);
    if (before !== this.configurations.length) await this.persist();
    return before !== this.configurations.length;
  }

  resolve(configurationId, currentFile = '') {
    const stored = this.configurations.find((item) => item.id === configurationId);
    if (stored) return clone(stored);
    if (configurationId === 'current-file' && currentFile) {
      return normalizeRunConfiguration({ id: 'current-file', name: 'Current File', target: currentFile, temporary: true });
    }
    throw new Error(`Unknown run configuration: ${configurationId}`);
  }

  async markRun(configurationId) {
    return this.update(configurationId, { lastRunAt: Date.now() });
  }

  async persist() {
    if (this.bridge?.available) {
      try {
        await this.bridge.request('project', 'saveRunConfigurations', {
          workspaceId: 'default', configurations: this.configurations
        });
        // Native project storage is private app storage.  Do not mirror
        // interpreter arguments or environment values into WebView
        // localStorage when the Android broker is available.
        return;
      } catch (error) {
        if (error?.code !== 'unknown-channel') throw error;
      }
    }
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.configurations)); } catch (error) { /* private mode */ }
  }
}
