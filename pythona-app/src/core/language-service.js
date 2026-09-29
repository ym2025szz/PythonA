const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'case', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield'
];

const PYTHON_BUILTINS = [
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint',
  'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
  'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
  'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash',
  'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
  'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next',
  'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr',
  'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod',
  'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__'
];

const BUILTIN_SIGNATURES = {
  enumerate: 'enumerate(iterable, start=0)',
  input: 'input(prompt="")',
  len: 'len(obj)',
  open: 'open(file, mode="r", buffering=-1, encoding=None, errors=None, newline=None, closefd=True, opener=None)',
  print: 'print(*objects, sep=" ", end="\\n", file=None, flush=False)',
  range: 'range(stop) | range(start, stop[, step])',
  super: 'super() | super(type, object_or_type=None)',
  zip: 'zip(*iterables, strict=False)'
};

const PYTHON_SNIPPETS = [
  { label: 'def', detail: 'Function definition', insertText: 'def ${name}(${params}):\n    ${pass}', kind: 'Snippet' },
  { label: 'class', detail: 'Class definition', insertText: 'class ${Name}:\n    ${pass}', kind: 'Snippet' },
  { label: 'for', detail: 'For loop', insertText: 'for ${item} in ${iterable}:\n    ${pass}', kind: 'Snippet' },
  { label: 'if', detail: 'If statement', insertText: 'if ${condition}:\n    ${pass}', kind: 'Snippet' },
  { label: 'ifmain', detail: 'Python module entry point', insertText: 'if __name__ == "__main__":\n    ${main()}', kind: 'Snippet' },
  { label: 'try', detail: 'Try / except', insertText: 'try:\n    ${pass}\nexcept ${Exception} as ${error}:\n    ${raise}', kind: 'Snippet' },
  { label: 'with', detail: 'Context manager', insertText: 'with ${expression} as ${name}:\n    ${pass}', kind: 'Snippet' }
];

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function stripSignal(value) {
  const copy = { ...value };
  delete copy.signal;
  return copy;
}

function parseBridgeResult(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed?.error) throw new LanguageServiceError(parsed.error, parsed.code || 'bridge-error');
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'result')) return parsed.result;
  return parsed;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'cancelled';
}

function abortError() {
  const error = new LanguageServiceError('Language request cancelled', 'cancelled');
  error.name = 'AbortError';
  return error;
}

function normalizeCompletionResult(value, providerId) {
  const source = Array.isArray(value) ? { items: value } : (value || {});
  const items = Array.isArray(source.items) ? source.items : [];
  return {
    items: items.map((item) => ({ ...item, providerId: item.providerId || providerId })),
    isIncomplete: Boolean(source.isIncomplete)
  };
}

function completionInsertion(item, label) {
  return item?.textEdit?.newText ?? item?.insertText ?? label ?? '';
}

function mergeCompletionResults(results) {
  const items = new Map();
  let isIncomplete = false;
  for (const entry of results) {
    const normalized = normalizeCompletionResult(entry.result, entry.provider.id);
    isIncomplete ||= normalized.isIncomplete;
    for (const item of normalized.items) {
      const label = typeof item.label === 'string' ? item.label : item.label?.label;
      // Kind/detail commonly differ between the dependency-free provider and
      // Jedi even when both options perform the exact same edit. Treat those
      // as one candidate, while retaining intentionally distinct candidates
      // such as a `def` keyword and the expanded `def ...` snippet.
      const key = [label || '', completionInsertion(item, label)].join('\u0000');
      // Providers later in the chain are normally semantic providers.  Their
      // richer item replaces a matching local candidate without changing the
      // stable display order established by the immediate local result.
      items.set(key, { ...(items.get(key) || {}), ...item });
    }
  }
  return { items: [...items.values()], isIncomplete };
}

function normalizeDiagnostics(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.diagnostics)) return value.diagnostics;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function completionPrefix(text, offset) {
  const match = text.slice(0, offset).match(/[\p{ID_Start}_][\p{ID_Continue}_]*$/u);
  return match ? match[0] : '';
}

function wordAt(text, offset) {
  let start = Math.max(0, Math.min(offset, text.length));
  let end = start;
  while (start > 0) {
    const codePoint = text.codePointAt(start - 1);
    const character = String.fromCodePoint(codePoint);
    const width = character.length;
    const candidateStart = start - width;
    if (candidateStart < 0 || !/[\p{ID_Continue}_]/u.test(character)) break;
    start = candidateStart;
  }
  while (end < text.length) {
    const character = String.fromCodePoint(text.codePointAt(end));
    if (!/[\p{ID_Continue}_]/u.test(character)) break;
    end += character.length;
  }
  return { word: text.slice(start, end), start, end };
}

function collectPythonSymbols(uri, text) {
  const symbols = [];
  const identifier = String.raw`[\p{ID_Start}_][\p{ID_Continue}_]*`;
  const patterns = [
    { regex: new RegExp(`^(\\s*)async\\s+def\\s+(${identifier})`, 'gmu'), kind: 'Function' },
    { regex: new RegExp(`^(\\s*)def\\s+(${identifier})`, 'gmu'), kind: 'Function' },
    { regex: new RegExp(`^(\\s*)class\\s+(${identifier})`, 'gmu'), kind: 'Class' },
    { regex: new RegExp(`^(\\s*)(${identifier})\\s*(?::[^=\\n]+)?=(?!=)`, 'gmu'), kind: 'Variable' }
  ];
  const seen = new Set();
  for (const { regex, kind } of patterns) {
    for (const match of text.matchAll(regex)) {
      const name = match[2];
      const offset = (match.index || 0) + match[0].lastIndexOf(name);
      const key = kind + ':' + name + ':' + offset;
      if (seen.has(key)) continue;
      seen.add(key);
      const start = offsetToPosition(text, offset);
      symbols.push({
        name,
        label: name,
        kind,
        uri,
        range: { start, end: { line: start.line, character: start.character + name.length } },
        selectionRange: { start, end: { line: start.line, character: start.character + name.length } }
      });
    }
  }
  const contextualPatterns = [
    new RegExp(`^\\s*(?:async\\s+)?for\\s+(${identifier})\\s+in\\b`, 'gmu'),
    new RegExp(`\\b(?:with\\s+[^\\n:]+|except\\s+[^\\n:]+)\\s+as\\s+(${identifier})`, 'gmu')
  ];
  for (const regex of contextualPatterns) {
    for (const match of text.matchAll(regex)) {
      const name = match[1];
      const offset = (match.index || 0) + match[0].lastIndexOf(name);
      const start = offsetToPosition(text, offset);
      const key = `Variable:${name}:${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbols.push({
        name, label: name, kind: 'Variable', uri,
        range: { start, end: { line: start.line, character: start.character + name.length } },
        selectionRange: { start, end: { line: start.line, character: start.character + name.length } }
      });
    }
  }
  const functionHeaders = new RegExp(
    `^\\s*(?:async\\s+)?def\\s+${identifier}\\s*\\(([^)]*)\\)`,
    'gmu'
  );
  for (const header of text.matchAll(functionHeaders)) {
    const parameters = header[1];
    const parametersOffset = (header.index || 0) + header[0].indexOf(parameters);
    let consumed = 0;
    for (const parameter of parameters.split(',')) {
      const match = parameter.match(new RegExp(`^\\s*(?:\\*{1,2})?\\s*(${identifier})`, 'u'));
      if (match) {
        const name = match[1];
        const offset = parametersOffset + consumed + parameter.indexOf(name);
        const start = offsetToPosition(text, offset);
        const key = `Variable:${name}:${offset}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({
            name, label: name, kind: 'Variable', uri,
            range: { start, end: { line: start.line, character: start.character + name.length } },
            selectionRange: { start, end: { line: start.line, character: start.character + name.length } }
          });
        }
      }
      consumed += parameter.length + 1;
    }
  }
  return symbols.sort((a, b) => positionToOffset(text, a.range.start) - positionToOffset(text, b.range.start));
}

function providerResultValue(results) {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const value = results[index].result;
    if (value != null && (!Array.isArray(value) || value.length)) return value;
  }
  return null;
}

export function toDocumentUri(pathOrUri) {
  const value = String(pathOrUri || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  const path = value.replaceAll('\\', '/').replace(/^\/+/, '');
  return 'pythona://workspace/' + path.split('/').map(encodeURIComponent).join('/');
}

/** Convert an LSP UTF-16 position to a JavaScript string offset. */
export function positionToOffset(text, position = {}) {
  const source = String(text || '');
  const targetLine = integer(position.line, 0);
  const targetCharacter = integer(position.character, 0);
  let line = 0;
  let offset = 0;
  while (line < targetLine && offset < source.length) {
    const newline = source.indexOf('\n', offset);
    if (newline < 0) return source.length;
    offset = newline + 1;
    line += 1;
  }
  const newline = source.indexOf('\n', offset);
  const lineEnd = newline < 0 ? source.length : newline;
  return Math.min(lineEnd, offset + targetCharacter);
}

/** Convert a JavaScript UTF-16 string offset to an LSP position. */
export function offsetToPosition(text, requestedOffset) {
  const source = String(text || '');
  const target = Math.max(0, Math.min(integer(requestedOffset, 0), source.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < target; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: target - lineStart };
}

export function applyContentChanges(text, changes = []) {
  let next = String(text || '');
  for (const change of changes) {
    if (!change || typeof change.text !== 'string') throw new LanguageServiceError('A content change must include text', 'invalid-change');
    if (!change.range) {
      next = change.text;
      continue;
    }
    const start = positionToOffset(next, change.range.start);
    const end = positionToOffset(next, change.range.end);
    if (end < start) throw new LanguageServiceError('A content change range is reversed', 'invalid-change');
    next = next.slice(0, start) + change.text + next.slice(end);
  }
  return next;
}

function validPythonIdentifier(value) {
  const name = String(value ?? '');
  return Boolean(name) && name === name.trim() && /^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(name)
    && !PYTHON_KEYWORDS.includes(name);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathFromDocumentUri(uri) {
  const prefix = 'pythona://workspace/';
  if (!String(uri || '').startsWith(prefix)) return null;
  try { return String(uri).slice(prefix.length).split('/').map((part) => decodeURIComponent(part)).join('/'); }
  catch (error) { return null; }
}

function referenceRange(text, start, length) {
  const position = offsetToPosition(text, start);
  return { start: position, end: offsetToPosition(text, start + length) };
}

function workspacePath(path, root) {
  const value = String(path || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!value || value.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return value;
}

export class LanguageServiceError extends Error {
  constructor(message, code = 'language-service-error') {
    super(message);
    this.name = 'LanguageServiceError';
    this.code = code;
  }
}

export class ContentModifiedError extends LanguageServiceError {
  constructor(message = 'The document version is no longer current') {
    super(message, 'content-modified');
    this.name = 'ContentModifiedError';
    this.lspCode = -32801;
  }
}

/**
 * Dependency-free completion provider that remains available without a
 * Python runtime pack.  It intentionally provides structural, not inferred,
 * results; Jedi can enrich or replace them through BridgeLanguageProvider.
 */
export class LocalLanguageProvider {
  constructor() {
    this.id = 'local';
    this.documents = new Map();
  }

  openDocument(document) {
    this.documents.set(document.uri, { ...document });
  }

  changeDocument(document) {
    this.documents.set(document.uri, { ...document });
  }

  closeDocument(document) {
    this.documents.delete(document.uri);
  }

  complete(request) {
    if (request.signal?.aborted) throw abortError();
    const offset = positionToOffset(request.text, request.position);
    const prefix = completionPrefix(request.text, offset).toLowerCase();
    const candidates = [];
    for (const keyword of PYTHON_KEYWORDS) {
      candidates.push({ label: keyword, insertText: keyword, kind: 'Keyword', detail: 'Python keyword', sortText: '2-' + keyword });
    }
    for (const name of PYTHON_BUILTINS) {
      candidates.push({
        label: name,
        insertText: name,
        kind: BUILTIN_SIGNATURES[name] ? 'Function' : 'Variable',
        detail: BUILTIN_SIGNATURES[name] || 'Python built-in',
        sortText: '1-' + name
      });
    }
    for (const snippet of PYTHON_SNIPPETS) candidates.push({ ...snippet, sortText: '0-' + snippet.label });
    for (const document of this.documents.values()) {
      for (const symbol of collectPythonSymbols(document.uri, document.text)) {
        candidates.push({
          label: symbol.name,
          insertText: symbol.name,
          kind: symbol.kind,
          detail: (document.uri === request.uri ? 'Current document' : 'Workspace') + ' · ' + symbol.kind,
          sortText: (document.uri === request.uri ? '0-' : '1-') + symbol.name,
          definition: { uri: symbol.uri, range: symbol.selectionRange }
        });
      }
    }
    const items = [];
    const seen = new Set();
    for (const candidate of candidates) {
      if (prefix && !candidate.label.toLowerCase().startsWith(prefix)) continue;
      const key = candidate.label + ':' + candidate.kind;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(candidate);
    }
    items.sort((a, b) => String(a.sortText).localeCompare(String(b.sortText)));
    return { items, isIncomplete: false };
  }

  resolveCompletion(request) {
    return request.item || null;
  }

  signatureHelp(request) {
    const offset = positionToOffset(request.text, request.position);
    const before = request.text.slice(0, offset);
    const match = before.match(/([A-Za-z_]\w*)\s*\([^()]*$/);
    if (!match || !BUILTIN_SIGNATURES[match[1]]) return null;
    const label = BUILTIN_SIGNATURES[match[1]];
    return { signatures: [{ label }], activeSignature: 0, activeParameter: Math.max(0, (match[0].match(/,/g) || []).length) };
  }

  hover(request) {
    const offset = positionToOffset(request.text, request.position);
    const { word } = wordAt(request.text, offset);
    if (BUILTIN_SIGNATURES[word]) return { contents: [{ language: 'python', value: BUILTIN_SIGNATURES[word] }, 'Python built-in'] };
    if (PYTHON_KEYWORDS.includes(word)) return { contents: '`' + word + '` — Python keyword' };
    const symbol = [...this.documents.values()]
      .flatMap((document) => collectPythonSymbols(document.uri, document.text))
      .find((item) => item.name === word);
    return symbol ? { contents: '`' + symbol.name + '` — ' + symbol.kind } : null;
  }

  definition(request) {
    const offset = positionToOffset(request.text, request.position);
    const { word } = wordAt(request.text, offset);
    const symbols = [...this.documents.values()].flatMap((document) => collectPythonSymbols(document.uri, document.text));
    const match = symbols.find((symbol) => symbol.name === word);
    return match ? [{ uri: match.uri, range: match.selectionRange }] : [];
  }

  references(request) {
    if (request.signal?.aborted) throw abortError();
    const offset = positionToOffset(request.text, request.position);
    const { word } = wordAt(request.text, offset);
    if (!word) return [];
    const output = [];
    for (const document of this.documents.values()) {
      const path = workspacePath(document.path || pathFromDocumentUri(document.uri), request.workspaceRoot);
      if (!path) continue;
      const regex = new RegExp(`(?:^|[^\\p{ID_Continue}_])${escapeRegExp(word)}(?=$|[^\\p{ID_Continue}_])`, 'gu');
      for (const match of document.text.matchAll(regex)) {
        const start = (match.index || 0) + (match[0].length - word.length);
        output.push({ uri: document.uri, path, range: referenceRange(document.text, start, word.length), name: word });
        if (output.length >= 1000) return output;
      }
    }
    return output;
  }

  rename() {
    throw new LanguageServiceError('Rename requires the Android language service', 'refactor-unsupported');
  }

  documentSymbols(request) {
    return collectPythonSymbols(request.uri, request.text).map(({ uri, label, ...symbol }) => symbol);
  }

  diagnose() {
    // Lezer/Jedi own syntax diagnostics. Returning no speculative errors here
    // avoids showing false positives while a user is in the middle of typing.
    return [];
  }

  cancel() {}
}

/** Adapter for the future Android language-service bridge. */
export class BridgeLanguageProvider {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.id = options.id || 'bridge';
    this.prefix = options.prefix || 'language/';
    this.channel = options.channel || 'language';
    this.methodMap = {
      openDocument: 'didOpen',
      changeDocument: 'didChange',
      saveDocument: 'didSave',
      closeDocument: 'didClose',
      complete: 'completion',
      resolveCompletion: 'completionItem/resolve',
      signatureHelp: 'signatureHelp',
      hover: 'hover',
      definition: 'definition',
      references: 'references',
      rename: 'rename',
      documentSymbols: 'documentSymbol',
      diagnose: 'diagnose',
      cancel: '$/cancelRequest',
      ...options.methodMap
    };
    this.recoveryRequired = false;
    this.unsubscribeLifecycle = typeof this.bridge?.subscribe === 'function'
      ? this.bridge.subscribe(this.channel, (event) => {
        if (event?.channel && event.channel !== this.channel) return;
        if (event?.type === 'service-crashed') this.recoveryRequired = true;
      })
      : null;
    this.unsubscribeStatus = typeof this.bridge?.subscribeStatus === 'function'
      ? this.bridge.subscribeStatus((event) => {
        if (event?.channel && event.channel !== this.channel) return;
        if (['disconnected', 'reconnecting', 'binding-died', 'null-binding', 'service-crashed', 'service-disconnected'].includes(event?.type)) {
          this.recoveryRequired = true;
        }
      }) : null;
  }

  async invoke(method, payload) {
    if (!this.bridge) throw new LanguageServiceError('Language bridge is unavailable', 'bridge-unavailable');
    const cleanPayload = stripSignal(payload || {});
    if (cleanPayload.version != null && cleanPayload.bufferVersion == null) {
      cleanPayload.bufferVersion = cleanPayload.version;
    }
    const nativeMethod = this.methodMap[method] || method;
    if (typeof this.bridge.request === 'function') {
      try {
        const raw = await this.bridge.request(
          this.channel,
          nativeMethod,
          cleanPayload,
          { signal: payload?.signal }
        );
        const wire = typeof raw === 'string' ? JSON.parse(raw) : raw;
        for (const key of ['uri', 'epoch', 'bufferVersion']) {
          if (wire?.[key] != null && cleanPayload[key] != null && wire[key] !== cleanPayload[key]) throw new ContentModifiedError('Language response identity mismatch');
        }
        const result = parseBridgeResult(wire);
        if (method === 'openDocument' || method === 'changeDocument'
          || (this.recoveryRequired && Object.prototype.hasOwnProperty.call(cleanPayload, 'text'))) {
          this.recoveryRequired = false;
        }
        return result;
      }
      catch (error) {
        if (error?.code === 'cancelled') throw abortError();
        // didOpen/didChange acknowledgements are intentionally swallowed by
        // LanguageService so local editing remains available. If either call
        // failed, however, the isolated process may have no matching buffer;
        // the next semantic request must carry a full identity snapshot.
        if (method === 'openDocument' || method === 'changeDocument'
          || !['cancelled', 'content-modified'].includes(error?.code)) {
          this.recoveryRequired = true;
        }
        throw new LanguageServiceError(error?.message || String(error), error?.code || 'bridge-error');
      }
    }
    if (typeof this.bridge.invoke === 'function') {
      return parseBridgeResult(await this.bridge.invoke(JSON.stringify({ method: this.prefix + method, payload: cleanPayload })));
    }
    if (typeof this.bridge[method] === 'function') return parseBridgeResult(await this.bridge[method](cleanPayload));
    throw new LanguageServiceError('Language bridge does not expose ' + method, 'bridge-method-missing');
  }

  openDocument(document) { return this.invoke('openDocument', document); }
  changeDocument(document) {
    const payload = { ...document };
    // Keep the local coordinator's full snapshot, but do not push that entire
    // buffer through Binder for every keystroke when LSP changes are present.
    if (!this.recoveryRequired && Array.isArray(payload.changes) && payload.fullText === false) delete payload.text;
    return this.invoke('changeDocument', payload);
  }
  saveDocument(document) {
    const { text, changes, fullText, ...metadata } = document || {};
    return this.invoke('saveDocument', metadata);
  }
  closeDocument(document) { return this.invoke('closeDocument', document); }
  compactSemanticRequest(request) {
    if (this.recoveryRequired) return request;
    const payload = { ...request };
    delete payload.text;
    return payload;
  }
  async semantic(method, request) {
    try {
      return await this.invoke(method, this.compactSemanticRequest(request));
    } catch (error) {
      // A language process can restart between didOpen and a query without a
      // lifecycle event reaching the WebView first. Retry document-not-open
      // exactly once with URI + epoch + version + full text so the host can
      // reconstruct only the matching snapshot.
      if (error?.code !== 'document-not-open'
        || !Object.prototype.hasOwnProperty.call(request || {}, 'text')) throw error;
      this.recoveryRequired = true;
      return this.invoke(method, request);
    }
  }
  complete(request) { return this.semantic('complete', request); }
  resolveCompletion(request) { return this.semantic('resolveCompletion', request); }
  signatureHelp(request) { return this.semantic('signatureHelp', request); }
  hover(request) { return this.semantic('hover', request); }
  definition(request) { return this.semantic('definition', request); }
  references(request) { return this.semantic('references', request); }
  rename(request) { return this.semantic('rename', request); }
  documentSymbols(request) { return this.semantic('documentSymbols', request); }
  diagnose(request) { return this.semantic('diagnose', request); }

  async cancel(request) {
    try { await this.invoke('cancel', request); } catch (error) {
      if (error?.code !== 'bridge-method-missing') throw error;
    }
  }

  dispose() {
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }
}

/**
 * Version-gated coordinator for immediate local and asynchronous semantic
 * language features. Every result is checked against URI + epoch + version
 * before it is exposed to the editor.
 */
export class LanguageService {
  constructor(options = {}) {
    this.listeners = new Set();
    this.documents = new Map();
    this.inflight = new Map();
    this.epochSequence = 0;
    this.requestSequence = 0;
    if (options.providers) this.providers = [...options.providers];
    else {
      const local = options.localProvider === false ? null : (options.localProvider || new LocalLanguageProvider());
      const semantic = options.semanticProvider || (options.bridge ? new BridgeLanguageProvider(options.bridge) : null);
      this.providers = [local, semantic].filter(Boolean);
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    this.listeners.forEach((listener) => listener({ ...event, timestamp: Date.now() }));
  }

  document(uriOrPath) {
    const record = this.documents.get(toDocumentUri(uriOrPath));
    return record ? clone(record) : null;
  }

  openDocument(input) {
    const identity = input?.uri || input?.path;
    if (!input || !identity) throw new LanguageServiceError('A document URI or path is required', 'invalid-document');
    const uri = toDocumentUri(identity);
    const document = {
      uri,
      path: input.path || null,
      languageId: input.languageId || 'python',
      text: String(input.text ?? input.content ?? ''),
      version: integer(input.version ?? input.bufferVersion, 1),
      epoch: ++this.epochSequence
    };
    this.documents.set(uri, document);
    this.emit({ type: 'document-opened', document: clone(document) });
    return this.notifyProviders('openDocument', document).then(() => clone(document));
  }

  changeDocument(input) {
    const identity = input?.uri || input?.path;
    if (!identity) throw new LanguageServiceError('A document URI or path is required', 'invalid-document');
    const uri = toDocumentUri(identity);
    const current = this.documents.get(uri);
    if (!current) throw new LanguageServiceError('Document is not open: ' + uri, 'document-not-open');
    if (input.epoch != null && input.epoch !== current.epoch) throw new ContentModifiedError('Document epoch is no longer current');
    const text = Object.prototype.hasOwnProperty.call(input, 'text') || Object.prototype.hasOwnProperty.call(input, 'content')
      ? String(input.text ?? input.content ?? '')
      : applyContentChanges(current.text, input.changes || []);
    const version = integer(input.version ?? input.bufferVersion, current.version + 1);
    if (version < current.version || (version === current.version && text !== current.text)) {
      throw new ContentModifiedError('Document versions must increase monotonically');
    }
    if (version === current.version && text === current.text) return Promise.resolve(clone(current));
    const document = { ...current, text, version };
    this.documents.set(uri, document);
    this.emit({ type: 'document-changed', document: clone(document), changes: clone(input.changes || null) });
    return this.notifyProviders('changeDocument', {
      ...document,
      changes: input.changes ? clone(input.changes) : undefined,
      fullText: !input.changes
    }).then(() => clone(document));
  }

  closeDocument(input) {
    const uri = toDocumentUri(typeof input === 'string' ? input : input?.uri || input?.path);
    const current = this.documents.get(uri);
    if (!current) return Promise.resolve(false);
    this.documents.delete(uri);
    this.epochSequence += 1;
    for (const request of this.inflight.values()) {
      if (request.uri === uri) this.cancel(request.requestId, 'document-closed');
    }
    this.emit({ type: 'document-closed', document: clone(current) });
    return this.notifyProviders('closeDocument', current).then(() => true);
  }

  saveDocument(input) {
    const identity = input?.uri || input?.path;
    if (!identity) throw new LanguageServiceError('A document URI or path is required', 'invalid-document');
    const uri = toDocumentUri(identity);
    const current = this.documents.get(uri);
    if (!current) return Promise.resolve(false);
    if ((input.epoch != null && input.epoch !== current.epoch)
      || (input.version != null && input.version !== current.version)) {
      throw new ContentModifiedError('The saved document is no longer current');
    }
    const document = {
      ...current,
      revision: input.revision ?? null,
      text: Object.prototype.hasOwnProperty.call(input, 'text') ? String(input.text) : current.text
    };
    this.emit({ type: 'document-saved', document: clone(document) });
    return this.notifyProviders('saveDocument', document).then(() => clone(document));
  }

  async notifyProviders(method, document) {
    await Promise.all(this.providers.map(async (provider) => {
      if (typeof provider[method] !== 'function') return;
      try { await provider[method](clone(document)); } catch (error) {
        this.emit({ type: 'provider-error', providerId: provider.id || 'unknown', method, error });
      }
    }));
  }

  complete(params, options = {}) { return this.startRequest('complete', params, options); }
  resolveCompletion(params, options = {}) { return this.startRequest('resolveCompletion', params, options); }
  signatureHelp(params, options = {}) { return this.startRequest('signatureHelp', params, options); }
  hover(params, options = {}) { return this.startRequest('hover', params, options); }
  definition(params, options = {}) { return this.startRequest('definition', params, options); }
  references(params, options = {}) { return this.startRequest('references', params, options); }
  rename(params, options = {}) {
    if (!validPythonIdentifier(params?.newName)) {
      return Promise.reject(new LanguageServiceError('A valid Python identifier is required', 'invalid-rename'));
    }
    return this.startRequest('rename', params, options);
  }
  documentSymbols(params, options = {}) { return this.startRequest('documentSymbols', params, options); }
  diagnose(params, options = {}) { return this.startRequest('diagnose', params, options); }

  startRequest(method, params = {}, options = {}) {
    const uri = toDocumentUri(params.uri || params.path);
    const current = this.documents.get(uri);
    const requestId = params.requestId || 'language-' + (++this.requestSequence);
    if (!current || (params.epoch != null && params.epoch !== current.epoch)
      || (params.version != null && params.version !== current.version)) {
      this.emit({ type: 'request-discarded', requestId, method, uri, reason: 'content-modified' });
      const discarded = Promise.resolve(null);
      return Object.assign(discarded, { requestId, cancel: () => false });
    }
    const controller = new AbortController();
    const externalSignal = options.signal || params.signal;
    const onExternalAbort = () => this.cancel(requestId, 'external-abort');
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
    const token = { uri, epoch: current.epoch, version: current.version };
    const request = {
      ...params,
      ...token,
      requestId,
      languageId: current.languageId,
      text: current.text,
      signal: controller.signal
    };
    const inflight = { ...token, requestId, method, controller, onExternalAbort, externalSignal };
    this.inflight.set(requestId, inflight);
    this.emit({ type: 'request-started', requestId, method, ...token });
    const promise = this.executeRequest(method, request, options, token)
      .finally(() => {
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
        if (this.inflight.get(requestId) === inflight) this.inflight.delete(requestId);
      });
    return Object.assign(promise, { requestId, cancel: () => this.cancel(requestId) });
  }

  async executeRequest(method, request, options, token) {
    if (request.signal.aborted) {
      this.emit({ type: 'request-cancelled', requestId: request.requestId, method, ...token });
      return null;
    }
    let providers = this.providers.filter((provider) => typeof provider[method] === 'function');
    if (['rename', 'references'].includes(method) && providers.some(p => p instanceof BridgeLanguageProvider)) {
      providers = providers.filter(p => p instanceof BridgeLanguageProvider);
    }
    if (method === 'resolveCompletion' && request.item?.providerId) {
      const selected = providers.filter((provider) => provider.id === request.item.providerId);
      if (selected.length) providers = selected;
    }
    if (!providers.length) return this.envelope(method, request, method === 'complete' ? { items: [], isIncomplete: false } : null);
    const results = new Array(providers.length);
    const errors = [];
    await Promise.all(providers.map(async (provider, providerIndex) => {
      try {
        const result = await provider[method](request);
        if (request.signal.aborted || !this.isCurrent(token)) return;
        const entry = { provider, result };
        results[providerIndex] = entry;
        const partial = this.envelope(method, request, method === 'complete'
          ? normalizeCompletionResult(result, provider.id || 'unknown')
          : result, provider.id || 'unknown');
        try { options.onPartial?.(partial); } catch (error) {
          this.emit({ type: 'callback-error', requestId: request.requestId, method, error });
        }
        this.emit({ type: 'request-partial', providerId: provider.id || 'unknown', response: partial });
      } catch (error) {
        if (!isAbortError(error) && !request.signal.aborted) {
          errors.push({ provider, error });
          this.emit({ type: 'provider-error', providerId: provider.id || 'unknown', method, requestId: request.requestId, error });
        }
      }
    }));
    if (request.signal.aborted) {
      this.emit({ type: 'request-cancelled', requestId: request.requestId, method, ...token });
      return null;
    }
    if (!this.isCurrent(token)) {
      this.emit({ type: 'request-discarded', requestId: request.requestId, method, ...token, reason: 'content-modified' });
      return null;
    }
    const completedResults = results.filter(Boolean);
    if (!completedResults.length && errors.length) throw errors[0].error;
    let value;
    if (method === 'complete') value = mergeCompletionResults(completedResults);
    else if (method === 'diagnose') value = completedResults.flatMap((entry) => normalizeDiagnostics(entry.result));
    else value = providerResultValue(completedResults);
    const response = this.envelope(method, request, value);
    this.emit({ type: 'request-finished', response });
    return response;
  }

  envelope(method, request, value, providerId = null) {
    const response = {
      requestId: request.requestId,
      method,
      uri: request.uri,
      epoch: request.epoch,
      version: request.version,
      stale: false,
      result: value
    };
    if (providerId) response.providerId = providerId;
    if (method === 'complete') {
      response.items = value?.items || [];
      response.isIncomplete = Boolean(value?.isIncomplete);
    }
    if (method === 'diagnose') response.diagnostics = value || [];
    return response;
  }

  isCurrent(token) {
    const current = this.documents.get(token.uri);
    return Boolean(current) && current.epoch === token.epoch && current.version === token.version;
  }

  cancel(requestId, reason = 'cancelled') {
    const request = this.inflight.get(requestId);
    if (!request) return false;
    request.controller.abort();
    const payload = { requestId, uri: request.uri, epoch: request.epoch, version: request.version, reason };
    for (const provider of this.providers) {
      if (typeof provider.cancel !== 'function') continue;
      Promise.resolve(provider.cancel(payload)).catch((error) => {
        this.emit({ type: 'provider-error', providerId: provider.id || 'unknown', method: 'cancel', requestId, error });
      });
    }
    return true;
  }

  dispose() {
    for (const requestId of [...this.inflight.keys()]) this.cancel(requestId, 'service-disposed');
    for (const provider of this.providers) provider.dispose?.();
    this.documents.clear();
    this.listeners.clear();
  }
}
