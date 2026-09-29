function splitLines(text) {
  const lines = String(text).replaceAll('\r\n', '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(before, after, options = {}) {
  const left = splitLines(before);
  const right = splitLines(after);
  const maxCells = options.maxCells || 250000;
  if (left.length * right.length > maxCells) {
    return [
      ...left.map((line) => ({ type: 'remove', line })),
      ...right.map((line) => ({ type: 'add', line }))
    ];
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({ type: 'equal', line: left[i] });
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || table[i][j + 1] >= table[i + 1][j])) {
      result.push({ type: 'add', line: right[j] });
      j += 1;
    } else {
      result.push({ type: 'remove', line: left[i] });
      i += 1;
    }
  }
  return result;
}

export function makeHunks(before, after, options = {}) {
  const operations = diffLines(before, after, options);
  const context = options.context ?? 2;
  const changed = operations
    .map((operation, index) => (operation.type === 'equal' ? -1 : index))
    .filter((index) => index >= 0);
  if (!changed.length) return [];
  const ranges = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(operations.length - 1, changed[0] + context);
  for (let index = 1; index < changed.length; index += 1) {
    const nextStart = Math.max(0, changed[index] - context);
    const nextEnd = Math.min(operations.length - 1, changed[index] + context);
    if (nextStart <= end + 1) end = Math.max(end, nextEnd);
    else {
      ranges.push([start, end]);
      start = nextStart;
      end = nextEnd;
    }
  }
  ranges.push([start, end]);
  return ranges.map(([from, to], index) => ({
    id: 'hunk-' + (index + 1),
    operations: operations.slice(from, to + 1),
    start: from,
    end: to
  }));
}

export function createPatch(path, before, after, metadata = {}) {
  const operations = diffLines(before, after);
  const additions = operations.filter((operation) => operation.type === 'add').length;
  const removals = operations.filter((operation) => operation.type === 'remove').length;
  return {
    id: 'patch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    path,
    before: String(before),
    after: String(after),
    operations,
    hunks: makeHunks(before, after),
    additions,
    removals,
    ...metadata
  };
}

export function formatPatch(patch) {
  return patch.operations.map((operation) => {
    const prefix = operation.type === 'add' ? '+' : operation.type === 'remove' ? '-' : ' ';
    return prefix + ' ' + operation.line;
  }).join('\n');
}

function randomId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Immutable description of a cross-file assistant edit.  A transaction never
 * mutates a WorkspaceStore by itself; the native workspace validates every
 * revision/hash and commits the whole batch atomically.
 */
export class MultiFilePatchTransaction {
  constructor(files = [], metadata = {}) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new TypeError('A multi-file patch requires at least one file');
    }
    if (files.length > 128) throw new RangeError('A multi-file patch may contain at most 128 files');
    const seen = new Set();
    let stagedBytes = 0;
    this.transactionId = metadata.transactionId || randomId('dsh');
    this.createdAt = Number(metadata.createdAt) || Date.now();
    this.title = String(metadata.title || 'DSH workspace changes');
    this.files = files.map((input) => {
      const path = String(input?.path || '').replaceAll('\\', '/').trim();
      if (!path || path.includes('\u0000') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new TypeError(`Unsafe patch path: ${path || '<empty>'}`);
      }
      if (seen.has(path)) throw new TypeError(`Duplicate patch path: ${path}`);
      seen.add(path);
      const beforeText = String(input.beforeText ?? input.before ?? '');
      const afterText = String(input.afterText ?? input.after ?? '');
      stagedBytes += new TextEncoder().encode(afterText).length;
      if (stagedBytes > 32 * 1024 * 1024) throw new RangeError('A multi-file patch exceeds the 32 MiB staging limit');
      const patch = createPatch(path, beforeText, afterText, {
        baseRevision: Number(input.baseRevision) || 0,
        baseSha256: String(input.baseSha256 || input.sha256 || ''),
        bufferVersion: input.bufferVersion == null ? null : Number(input.bufferVersion)
      });
      return Object.freeze({
        path,
        baseRevision: patch.baseRevision,
        baseSha256: patch.baseSha256,
        bufferVersion: patch.bufferVersion,
        beforeText,
        afterText,
        hunks: patch.hunks,
        additions: patch.additions,
        removals: patch.removals,
        patch
      });
    });
    this.additions = this.files.reduce((total, file) => total + file.additions, 0);
    this.removals = this.files.reduce((total, file) => total + file.removals, 0);
    Object.freeze(this.files);
  }

  get changedFiles() {
    return this.files.filter((file) => file.beforeText !== file.afterText);
  }

  toBatchPayload(workspaceId = 'default') {
    return {
      workspaceId,
      transactionId: this.transactionId,
      files: this.changedFiles.map((file) => ({
        path: file.path,
        content: file.afterText,
        expectedRevision: file.baseRevision,
        expectedSha256: file.baseSha256
      })),
      source: 'dsh'
    };
  }
}

export function createMultiFilePatch(files, metadata = {}) {
  return new MultiFilePatchTransaction(files, metadata);
}
