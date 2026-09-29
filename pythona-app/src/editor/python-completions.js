import { snippetCompletion } from '@codemirror/autocomplete';
import { offsetToPosition, toDocumentUri } from '../core/language-service.js';

const pythonKeywords = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'case', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield'
];

export const pythonBuiltins = [
  'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint',
  'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
  'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
  'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash',
  'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
  'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next',
  'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr',
  'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod',
  'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip', '__import__',
  'BaseException', 'BaseExceptionGroup', 'Exception', 'ExceptionGroup',
  'ArithmeticError', 'AssertionError', 'AttributeError', 'BufferError',
  'EOFError', 'ImportError', 'LookupError', 'MemoryError', 'NameError',
  'OSError', 'ReferenceError', 'RuntimeError', 'StopAsyncIteration',
  'StopIteration', 'SyntaxError', 'SystemError', 'TypeError', 'ValueError',
  'Warning', 'FloatingPointError', 'OverflowError', 'ZeroDivisionError',
  'ModuleNotFoundError', 'IndexError', 'KeyError', 'UnboundLocalError',
  'BlockingIOError', 'ChildProcessError', 'ConnectionError', 'FileExistsError',
  'FileNotFoundError', 'InterruptedError', 'IsADirectoryError',
  'NotADirectoryError', 'PermissionError', 'ProcessLookupError', 'TimeoutError',
  'UnicodeError', 'UnicodeDecodeError', 'UnicodeEncodeError',
  'UnicodeTranslateError', 'NotImplementedError', 'RecursionError',
  'BrokenPipeError', 'ConnectionAbortedError', 'ConnectionRefusedError',
  'ConnectionResetError', 'TabError', 'UnicodeWarning', 'BytesWarning',
  'DeprecationWarning', 'EncodingWarning', 'FutureWarning', 'ImportWarning',
  'PendingDeprecationWarning', 'ResourceWarning', 'RuntimeWarning',
  'SyntaxWarning', 'UserWarning', 'GeneratorExit', 'KeyboardInterrupt',
  'SystemExit', 'Ellipsis', 'NotImplemented'
];

const snippets = [
  snippetCompletion('def ${name}(${parameters}):\n\t${pass}', { label: 'def', type: 'keyword', detail: '定义函数', boost: 90 }),
  snippetCompletion('class ${Name}:\n\tdef __init__(self, ${parameters}):\n\t\t${pass}', { label: 'class', type: 'keyword', detail: '定义类', boost: 85 }),
  snippetCompletion('if ${condition}:\n\t${pass}', { label: 'if', type: 'keyword', detail: '条件分支', boost: 80 }),
  snippetCompletion('for ${item} in ${iterable}:\n\t${pass}', { label: 'for', type: 'keyword', detail: '循环', boost: 80 }),
  snippetCompletion('with ${expression} as ${name}:\n\t${pass}', { label: 'with', type: 'keyword', detail: '上下文管理器', boost: 75 }),
  snippetCompletion('try:\n\t${pass}\nexcept ${Exception} as ${error}:\n\t${pass}', { label: 'try', type: 'keyword', detail: '异常处理', boost: 75 }),
  snippetCompletion('if __name__ == "__main__":\n\t${main}()', { label: 'main', type: 'keyword', detail: '程序入口', boost: 70 }),
  snippetCompletion('async def ${name}(${parameters}):\n\t${pass}', { label: 'async def', type: 'keyword', detail: '异步函数', boost: 70 })
];

const identifierSource = String.raw`[\p{ID_Start}_][\p{ID_Continue}_]*`;
const identifierAtEnd = new RegExp(`${identifierSource}$`, 'u');
const identifierOnly = new RegExp(`^(?:${identifierSource})?$`, 'u');
const isPythonPath = (path) => /\.pyi?$/i.test(String(path || ''));

function addSourceSymbols(source, detail, add) {
  const patterns = [
    { regex: new RegExp(`^\\s*(?:async\\s+)?def\\s+(${identifierSource})`, 'gmu'), type: 'function' },
    { regex: new RegExp(`^\\s*class\\s+(${identifierSource})`, 'gmu'), type: 'class' },
    { regex: new RegExp(`^\\s*(${identifierSource})\\s*(?::[^=\\n]+)?=(?!=)`, 'gmu'), type: 'variable' },
    { regex: new RegExp(`^\\s*(${identifierSource})\\s*:\\s*[^=\\n]+$`, 'gmu'), type: 'variable' },
    { regex: new RegExp(`^\\s*(?:async\\s+)?for\\s+(${identifierSource})\\s+in\\b`, 'gmu'), type: 'variable' },
    { regex: new RegExp(`\\b(?:with\\s+[^\\n:]+|except\\s+[^\\n:]+)\\s+as\\s+(${identifierSource})`, 'gmu'), type: 'variable' }
  ];
  for (const { regex, type } of patterns) {
    for (const match of source.matchAll(regex)) add(match[1], type, detail);
  }

  const functionHeaders = new RegExp(
    `^\\s*(?:async\\s+)?def\\s+${identifierSource}\\s*\\(([^)]*)\\)`,
    'gmu'
  );
  for (const header of source.matchAll(functionHeaders)) {
    for (const parameter of header[1].split(',')) {
      const match = parameter.match(new RegExp(`^\\s*(?:\\*{1,2})?\\s*(${identifierSource})`, 'u'));
      if (match) add(match[1], 'variable', `${detail} · 函数参数`);
    }
  }
}

function moduleName(path) {
  return String(path || '')
    .replace(/\.pyi?$/i, '')
    .replace(/\/__init__$/i, '')
    .replaceAll('/', '.');
}

function collectStaticOptions() {
  const options = [...snippets];
  const seen = new Set(options.map((option) => option.label));
  const add = (label, type, detail) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    options.push({ label, type, detail, boost: type === 'module' ? 35 : 20 });
  };

  for (const keyword of pythonKeywords) add(keyword, 'keyword', 'Python 关键字');
  for (const builtin of pythonBuiltins) add(builtin, 'function', 'Python 内置对象');
  return options;
}

function collectImportBindings(source, detail, add) {
  const importPattern = /^\s*import\s+([^#\n]+)/gmu;
  for (const statement of source.matchAll(importPattern)) {
    for (const item of statement[1].split(',')) {
      const match = item.trim().match(/^([\p{ID_Start}_][\p{ID_Continue}_]*(?:\.[\p{ID_Start}_][\p{ID_Continue}_]*)*)(?:\s+as\s+([\p{ID_Start}_][\p{ID_Continue}_]*))?$/u);
      if (!match) continue;
      // `import a.b` binds `a`; an explicit alias binds only that alias.
      add(match[2] || match[1].split('.')[0], 'module', `${detail} · import ${match[1]}`);
    }
  }

  const relativeOrDottedModule = String.raw`(?:\.+|\.*${identifierSource}(?:\.${identifierSource})*)`;
  const fromPattern = new RegExp(`^\\s*from\\s+(${relativeOrDottedModule})\\s+import\\s+([^#\\n]+)`, 'gmu');
  for (const statement of source.matchAll(fromPattern)) {
    const imported = statement[2].replace(/[()]/g, '');
    for (const item of imported.split(',')) {
      const match = item.trim().match(/^([\p{ID_Start}_][\p{ID_Continue}_]*)(?:\s+as\s+([\p{ID_Start}_][\p{ID_Continue}_]*))?$/u);
      if (!match || match[1] === '*') continue;
      add(match[2] || match[1], 'variable', `${detail} · from ${statement[1]}`);
    }
  }
}

function collectFileOptions(file) {
  const local = [];
  const shared = [];
  const localSeen = new Set();
  const sharedSeen = new Set();
  const makeAdd = (options, seen) => (label, type, detail) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    options.push({ label, type, detail, boost: type === 'module' ? 35 : 20 });
  };
  const addLocal = makeAdd(local, localSeen);
  const addShared = makeAdd(shared, sharedSeen);

  if (file?.editable === false || !isPythonPath(file?.path)) return { local, shared };
  const module = moduleName(file.path);
  if (module) addShared(module, 'module', file.path);
  const source = String(file.content || '');
  addSourceSymbols(source, file.path, addLocal);
  collectImportBindings(source, file.path, addLocal);

  // Workspace-wide candidates intentionally expose only importable surface
  // names. Parameters and indented assignments belong to another file's
  // lexical scope and made otherwise useful completion lists very noisy.
  for (const match of source.matchAll(new RegExp(`^(?:async\\s+)?def\\s+(${identifierSource})`, 'gmu'))) {
    addShared(match[1], 'function', file.path);
  }
  for (const match of source.matchAll(new RegExp(`^class\\s+(${identifierSource})`, 'gmu'))) {
    addShared(match[1], 'class', file.path);
  }
  for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?(?:=|$)/gm)) {
    addLocal(match[1], 'constant', file.path);
    addShared(match[1], 'constant', file.path);
  }
  return { local, shared };
}

export function createWorkspaceCompletionSource({ getFiles, getDocument, isComposing }) {
  const staticOptions = collectStaticOptions();
  const fileIndexes = new Map();
  let cachedOptions = staticOptions;
  let cachedActivePath = null;
  return (context) => {
    if (isComposing?.()) return null;
    // Replace only the final identifier. Matching the entire dotted token
    // would turn `os.pa` + Jedi's `path` candidate into `path`.
    const token = context.matchBefore(identifierAtEnd);
    if (!context.explicit && !token) return null;
    const files = getFiles?.() || [];
    const documentPath = String(getDocument?.()?.path || '');
    const bufferedFiles = documentPath ? [] : files.filter((file) => file?.bufferVersion != null);
    const inferredActive = bufferedFiles.length === 1
      ? bufferedFiles[0]
      : (files.length === 1 ? files[0] : null);
    const activePath = documentPath || String(inferredActive?.path || '');
    const livePaths = new Set();
    let changed = false;
    for (const file of files) {
      const path = String(file.path || '');
      if (file.editable === false || !isPythonPath(path)) continue;
      livePaths.add(path);
      const version = file.bufferVersion ?? file.revision ?? file.hash ?? String(file.content || '').length;
      const signature = `${version}:${file.hash || ''}:${String(file.content || '').length}`;
      const previous = fileIndexes.get(path);
      if (!previous || previous.signature !== signature) {
        fileIndexes.set(path, { signature, ...collectFileOptions(file) });
        changed = true;
      }
    }
    for (const path of fileIndexes.keys()) {
      if (!livePaths.has(path)) {
        fileIndexes.delete(path);
        changed = true;
      }
    }
    if (changed || activePath !== cachedActivePath) {
      cachedActivePath = activePath;
      const seen = new Set();
      cachedOptions = [];
      const activeOptions = fileIndexes.get(activePath)?.local || [];
      const sharedOptions = [...fileIndexes.values()].flatMap((entry) => entry.shared);
      for (const option of [...staticOptions, ...activeOptions, ...sharedOptions]) {
        if (seen.has(option.label)) continue;
        seen.add(option.label);
        cachedOptions.push(option);
      }
    }
    return {
      from: token ? token.from : context.pos,
      options: cachedOptions,
      validFor: identifierOnly
    };
  };
}

const completionKind = {
  2: 'function', 3: 'function', 4: 'class', 5: 'class', 6: 'variable', 7: 'class',
  8: 'module', 9: 'property', 10: 'property', 12: 'function', 13: 'variable',
  14: 'keyword', 15: 'snippet', 21: 'constant', 22: 'class', 25: 'type'
};

function documentationText(item) {
  if (typeof item?.documentation === 'string') return item.documentation;
  if (typeof item?.documentation?.value === 'string') return item.documentation.value;
  return '';
}

function normalizedInsertText(item, label) {
  const insertText = item?.textEdit?.newText ?? item?.insertText ?? label;
  return String(insertText).replace(/\$\{\d+:?([^}]*)\}|\$\{([^}]*)\}/g, '$1$2').replace(/\$\d+/g, '');
}

function completionKey(completion) {
  const apply = typeof completion?.apply === 'string' ? completion.apply : completion?.label;
  return `${completion?.label || ''}\u0000${apply || ''}`;
}

function sameSnapshot(getDocument, expected) {
  const current = getDocument?.();
  return Boolean(current)
    && current.path === expected.path
    && current.bufferVersion === expected.bufferVersion
    && current.buffer === expected.buffer;
}

function resolvedInfo(item, { languageService, getDocument, snapshot, uri, epoch }) {
  const immediate = documentationText(item);
  if (!item.providerId || item.providerId === 'local'
    || typeof languageService?.resolveCompletion !== 'function') {
    return immediate || undefined;
  }
  return async () => {
    if (!sameSnapshot(getDocument, snapshot)) return null;
    const document = languageService.document(uri);
    if (!document || document.epoch !== epoch
      || document.version !== snapshot.bufferVersion
      || document.text !== snapshot.buffer) return null;
    const pending = languageService.resolveCompletion({
      uri,
      epoch,
      version: snapshot.bufferVersion,
      item
    });
    const response = await pending;
    if (!response || !sameSnapshot(getDocument, snapshot)) return null;
    const current = languageService.document(uri);
    if (!current || current.epoch !== epoch || current.version !== snapshot.bufferVersion) return null;
    const resolved = response.result ?? response;
    return documentationText(resolved) || resolved?.detail || immediate || null;
  };
}

function mapCompletion(item, resolution) {
  const label = typeof item.label === 'string' ? item.label : item.label?.label;
  if (!label) return null;
  const insertText = normalizedInsertText(item, label);
  const type = typeof item.kind === 'number'
    ? completionKind[item.kind]
    : String(item.kind || 'variable').toLowerCase();
  const completion = {
    label,
    type,
    detail: item.detail || item.signature || (item.providerId === 'bridge' ? 'Jedi' : 'Python'),
    info: resolvedInfo(item, resolution),
    boost: item.providerId === 'bridge' ? 50 : 5
  };
  // Omitting a no-op `apply` lets CodeMirror identify this as the same edit
  // as an immediate workspace candidate. Non-trivial edits and snippets keep
  // their explicit apply value.
  if (insertText !== label) completion.apply = insertText;
  return completion;
}

/** Async semantic source. The synchronous workspace source is registered next
 * to it, so CodeMirror can paint local candidates without waiting for Jedi. */
export function createSemanticCompletionSource({ languageService, getDocument, isComposing, getLocalOptions }) {
  return async (context) => {
    if (!languageService || isComposing?.()) return null;
    const snapshot = getDocument?.();
    if (!snapshot?.path) return null;
    const token = context.matchBefore(identifierAtEnd);
    if (!context.explicit && !token) return null;
    const uri = toDocumentUri(snapshot.path);
    const document = languageService.document(uri);
    if (!document || document.version !== snapshot.bufferVersion || document.text !== snapshot.buffer) return null;
    const pending = languageService.complete({
      uri,
      epoch: document.epoch,
      version: snapshot.bufferVersion,
      position: offsetToPosition(snapshot.buffer, context.pos)
    });
    context.addEventListener?.('abort', () => pending.cancel?.(), { onDocChange: true });
    const response = await pending;
    if (!response || isComposing?.()) return null;
    if (!sameSnapshot(getDocument, snapshot)) return null;
    const localByKey = new Map((getLocalOptions?.(context) || []).map((option) => [completionKey(option), option]));
    const semanticByKey = new Map();
    for (const item of response.items || []) {
      // The synchronous workspace source already owns dependency-free local
      // candidates. Re-emitting LocalLanguageProvider here would create a
      // second row for snippets whose apply function cannot be serialized.
      if (item.providerId === 'local') continue;
      const mapped = mapCompletion(item, {
        languageService,
        getDocument,
        snapshot,
        uri,
        epoch: document.epoch
      });
      if (!mapped) continue;
      const local = localByKey.get(completionKey(mapped));
      // Match CodeMirror's display identity fields to collapse the immediate
      // and semantic forms into one row. The semantic row still wins because
      // its async info resolver has a higher intrinsic completion score.
      const reconciled = local ? {
        ...mapped,
        type: local.type,
        detail: local.detail,
        apply: local.apply,
        boost: local.boost
      } : mapped;
      semanticByKey.set(completionKey(reconciled), reconciled);
    }
    return {
      from: token ? token.from : context.pos,
      options: [...semanticByKey.values()],
      validFor: identifierOnly,
      filter: true
    };
  };
}
