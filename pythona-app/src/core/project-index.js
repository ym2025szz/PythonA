import { toDocumentUri } from './language-service.js';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function normalizeQuery(value) { return String(value || '').trim().toLocaleLowerCase(); }

function symbolsForFile(path, text) {
  if (!/\.pyi?$/i.test(path)) return [];
  const symbols = [];
  const lines = String(text).split('\n');
  const stack = [];
  for (let line = 0; line < lines.length; line += 1) {
    const source = lines[line];
    const match = /^(\s*)(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/.exec(source);
    if (!match) continue;
    const indent = match[1].replaceAll('\t', '    ').length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1)?.qualifiedName;
    const qualifiedName = parent ? `${parent}.${match[3]}` : match[3];
    const item = {
      uri: toDocumentUri(path), path, name: match[3], qualifiedName,
      symbolKind: match[2] === 'class' ? 'Class' : 'Function',
      range: { start: { line, character: source.indexOf(match[3]) }, end: { line, character: source.length } }
    };
    symbols.push(item);
    stack.push({ indent, qualifiedName });
  }
  return symbols;
}

function importsForFile(path, text) {
  if (!/\.pyi?$/i.test(path)) return [];
  const imports = [];
  String(text).split('\n').forEach((line, index) => {
    let match = /^\s*import\s+([\w.]+)/.exec(line);
    if (!match) match = /^\s*from\s+([\w.]+)\s+import\s+/.exec(line);
    if (match) imports.push({ uri: toDocumentUri(path), path, moduleName: match[1], line: index });
  });
  return imports;
}

export class ProjectIndexService {
  constructor(options = {}) {
    this.bridge = options.bridge || null;
    this.workspace = options.workspace || null;
    this.state = 'stale';
    this.error = null;
    this.files = new Map();
    this.symbolRecords = [];
    this.importRecords = [];
    this.generation = 0;
  }

  status() {
    return { state: this.state, generation: this.generation, error: this.error?.message || null, fileCount: this.files.size };
  }

  async index(files = null) {
    this.state = 'indexing';
    this.error = null;
    try {
      if (this.bridge?.available) {
        let result;
        try {
          result = await this.bridge.request('language', 'indexWorkspace', { workspaceId: 'default' }, { timeoutMs: 120_000 });
        } catch (error) {
          if (error?.code !== 'unknown-channel') throw error;
          result = await this.bridge.request('index', 'indexWorkspace', { workspaceId: 'default' }, { timeoutMs: 120_000 });
        }
        this.state = result?.status || 'ready';
        this.generation = Number(result?.generation) || this.generation + 1;
        return this.status();
      }
      const records = files || this.workspace?.listFiles?.() || [];
      const next = new Map();
      for (const summary of records) {
        if (summary.editable === false) continue;
        let content = summary.content;
        if (content == null && this.workspace?.readAsync) content = (await this.workspace.readAsync(summary.path)).content;
        else if (content == null && this.workspace?.read) content = this.workspace.read(summary.path).content;
        next.set(summary.path, { ...summary, content: String(content || '') });
        await Promise.resolve();
      }
      this.files = next;
      this.symbolRecords = [...next.values()].flatMap((file) => symbolsForFile(file.path, file.content));
      this.importRecords = [...next.values()].flatMap((file) => importsForFile(file.path, file.content));
      this.generation += 1;
      this.state = 'ready';
      return this.status();
    } catch (error) {
      this.state = 'failed';
      this.error = error;
      throw error;
    }
  }

  markStale() { if (this.state !== 'indexing') this.state = 'stale'; }

  async search(query, options = {}) {
    if (this.bridge?.available) return (await this.bridge.request('index', 'search', { workspaceId: 'default', query, ...options }))?.results || [];
    const needle = normalizeQuery(query);
    if (!needle) return [];
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const results = [];
    for (const file of this.files.values()) {
      if (file.path.toLocaleLowerCase().includes(needle)) results.push({ kind: 'file', path: file.path, score: 100 });
      const lines = file.content.split('\n');
      for (let line = 0; line < lines.length && results.length < limit; line += 1) {
        const column = lines[line].toLocaleLowerCase().indexOf(needle);
        if (column >= 0) results.push({ kind: 'text', path: file.path, line, column, text: lines[line] });
      }
      if (results.length >= limit) break;
    }
    for (const symbol of this.symbolRecords) {
      if (results.length >= limit) break;
      if (symbol.qualifiedName.toLocaleLowerCase().includes(needle)) results.push({ kind: 'symbol', ...symbol });
    }
    return results.slice(0, limit);
  }

  async symbols(uriOrPath) {
    if (this.bridge?.available) return (await this.bridge.request('index', 'symbols', { workspaceId: 'default', uri: uriOrPath }))?.symbols || [];
    const path = String(uriOrPath || '').replace(/^file:\/\/\/workspace\//, '');
    return clone(this.symbolRecords.filter((symbol) => symbol.path === path));
  }

  async workspaceSymbols() {
    if (this.bridge?.available) {
      let result;
      try {
        result = await this.bridge.request('language', 'workspaceSymbols', { workspaceId: 'default' });
      } catch (error) {
        if (error?.code !== 'unknown-channel') throw error;
        result = await this.bridge.request('index', 'workspaceSymbols', { workspaceId: 'default' });
      }
      return result?.symbols || [];
    }
    return clone(this.symbolRecords);
  }

  async definition(uriOrPath, position = {}) {
    if (this.bridge?.available) return (await this.bridge.request('index', 'definition', { workspaceId: 'default', uri: uriOrPath, position }))?.definition || null;
    const path = String(uriOrPath || '').replace(/^file:\/\/\/workspace\//, '');
    const file = this.files.get(path);
    if (!file) return null;
    const line = file.content.split('\n')[Number(position.line) || 0] || '';
    const offset = Math.max(0, Math.min(line.length, Number(position.character) || 0));
    const left = line.slice(0, offset).match(/[A-Za-z_]\w*$/)?.[0] || '';
    const right = line.slice(offset).match(/^\w*/)?.[0] || '';
    const name = left + right;
    return clone(this.symbolRecords.find((symbol) => symbol.name === name) || null);
  }

  async contextForRequest(request) {
    if (this.bridge?.available) {
      const result = await this.bridge.request('index', 'contextForRequest', {
        workspaceId: 'default', path: request?.path, uri: request?.uri
      });
      const records = [];
      for (const path of result?.paths || []) {
        try {
          const value = this.workspace?.readAsync
            ? await this.workspace.readAsync(path)
            : this.workspace?.read(path);
          if (value) records.push({ path, content: value.content });
        } catch (error) { /* stale index entry */ }
      }
      return records;
    }
    const selected = [];
    if (request?.path && this.files.has(request.path)) selected.push(this.files.get(request.path));
    const imported = new Set(this.importRecords.filter((item) => item.path === request?.path).map((item) => item.moduleName));
    for (const file of this.files.values()) {
      const module = file.path.replace(/\.pyi?$/, '').replaceAll('/', '.');
      if (imported.has(module) || [...imported].some((name) => module.endsWith(`.${name}`))) selected.push(file);
    }
    for (const path of request?.attachedFiles || []) if (this.files.has(path)) selected.push(this.files.get(path));
    return [...new Map(selected.map((item) => [item.path, item])).values()].map((item) => ({ path: item.path, content: item.content }));
  }
}
