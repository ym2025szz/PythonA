const PROJECT_SCHEMA_VERSION = 1;
const STORAGE_KEY = 'pythona.project-model.v1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultProjectModel(name = 'ml-playground') {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: 'default',
    name,
    modules: [{
      id: 'app',
      name: 'app',
      contentRoots: ['/'],
      sourceRoots: ['src'],
      testRoots: ['tests'],
      excludeRoots: ['.git', '.venv', 'venv', 'node_modules', '__pycache__']
    }],
    interpreters: [{ id: 'bundled-cpython', name: 'Bundled CPython', kind: 'bundled', selected: true }],
    runConfigurations: [],
    sourceRoots: ['src'],
    excludeRoots: ['.git', '.venv', 'venv', 'node_modules', '__pycache__']
  };
}

function normalizeRoot(value) {
  const root = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!root || root === '/') return root || '/';
  if (root.startsWith('/') || root.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError(`Unsafe project root: ${root}`);
  }
  return root;
}

export function normalizeProjectModel(input, fallbackName = 'ml-playground') {
  const source = input && typeof input === 'object' ? clone(input) : defaultProjectModel(fallbackName);
  const base = defaultProjectModel(source.name || fallbackName);
  const modules = Array.isArray(source.modules) && source.modules.length ? source.modules : base.modules;
  return {
    ...base,
    ...source,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: String(source.projectId || 'default'),
    name: String(source.name || fallbackName),
    modules: modules.map((module, index) => ({
      id: String(module.id || `module-${index + 1}`),
      name: String(module.name || module.id || `module-${index + 1}`),
      contentRoots: (module.contentRoots || ['/']).map(normalizeRoot),
      sourceRoots: (module.sourceRoots || []).map(normalizeRoot),
      testRoots: (module.testRoots || []).map(normalizeRoot),
      excludeRoots: (module.excludeRoots || []).map(normalizeRoot)
    })),
    interpreters: Array.isArray(source.interpreters) ? source.interpreters.map((item) => ({ ...item })) : base.interpreters,
    runConfigurations: Array.isArray(source.runConfigurations) ? source.runConfigurations.map((item) => ({ ...item })) : [],
    sourceRoots: (source.sourceRoots || base.sourceRoots).map(normalizeRoot),
    excludeRoots: (source.excludeRoots || base.excludeRoots).map(normalizeRoot)
  };
}

export class ProjectModelService {
  constructor(options = {}) {
    this.bridge = options.bridge || null;
    this.storage = options.storage || globalThis.localStorage || null;
    this.workspaceName = options.workspaceName || 'ml-playground';
    this.model = null;
  }

  async open() {
    let value = null;
    if (this.bridge?.available) {
      try { value = await this.bridge.request('project', 'open', { workspaceId: 'default' }); }
      catch (error) { if (error?.code !== 'unknown-channel') throw error; }
    }
    if (!value) {
      try { value = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null'); } catch (error) { value = null; }
    }
    this.model = normalizeProjectModel(value, this.workspaceName);
    if (!value) await this.save();
    return clone(this.model);
  }

  async save(next = this.model) {
    this.model = normalizeProjectModel(next, this.workspaceName);
    if (this.bridge?.available) {
      try {
        const saved = await this.bridge.request('project', 'save', { workspaceId: 'default', model: this.model });
        this.model = normalizeProjectModel(saved?.model || saved, this.workspaceName);
        return clone(this.model);
      } catch (error) {
        if (error?.code !== 'unknown-channel') throw error;
      }
    }
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.model)); } catch (error) { /* private mode */ }
    return clone(this.model);
  }

  listModules() { return clone(this.model?.modules || []); }

  async updateModule(module) {
    if (!this.model) await this.open();
    const id = String(module?.id || '');
    const modules = this.model.modules.slice();
    const index = modules.findIndex((item) => item.id === id);
    if (index < 0) modules.push(module); else modules[index] = { ...modules[index], ...module };
    return this.save({ ...this.model, modules });
  }

  getInterpreter() {
    return clone(this.model?.interpreters?.find((item) => item.selected) || this.model?.interpreters?.[0] || null);
  }
}
