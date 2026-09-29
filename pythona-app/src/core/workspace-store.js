const STORAGE_KEY = 'pythona.workspace.v1';

export const DEFAULT_FILES = {
  '.pyaignore': '# PythonA context/index exclusions\n.git/\n.venv/\nvenv/\nnode_modules/\n__pycache__/\n.env\n*.pem\n*.key\ncredentials*\nsecrets*\n',
  'README.md': '# ml-playground\n\nPythonA workspace\n',
  'pyproject.toml': '[project]\nname = "ml-playground"\nversion = "0.1.0"\n',
  'src/train.py': 'from model import TinyClassifier\n\n\ndef train() -> None:\n    model = TinyClassifier()\n    print("ready", model)\n\n\nif __name__ == "__main__":\n    train()\n',
  'src/model.py': 'class TinyClassifier:\n    def __repr__(self) -> str:\n        return "TinyClassifier()"\n',
  'tests/test_model.py': 'from src.model import TinyClassifier\n\n\ndef test_model_name() -> None:\n    assert "TinyClassifier" in repr(TinyClassifier())\n',
  'tests/test_checkpoint.py': 'def test_resume_checkpoint() -> None:\n    assert True\n'
};

export function normalizePath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.')
    .reduce((parts, part) => {
      if (part === '..') parts.pop();
      else parts.push(part);
      return parts;
    }, [])
    .join('/');
}

export function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class RevisionConflictError extends Error {
  constructor(path, expectedRevision, actualRecord) {
    super('Revision conflict for ' + path);
    this.name = 'RevisionConflictError';
    this.path = path;
    this.expectedRevision = expectedRevision;
    this.actualRecord = actualRecord;
  }
}

function nativeRecord(value, fallbackPath = '') {
  if (!value || typeof value !== 'object') return null;
  const content = String(value.content ?? value.text ?? '');
  const path = normalizePath(value.path || fallbackPath);
  if (!path) return null;
  const editable = value.editable !== false && value.kind !== 'binary';
  return {
    path,
    content,
    revision: Number(value.revision) || 0,
    hash: value.sha256 || value.hash || hashText(content),
    sha256: value.sha256 || null,
    updatedAt: Number(value.updatedAt) || Date.now(),
    size: Number(value.size) || content.length,
    editable,
    binary: !editable
  };
}

function nativeSummaryRecord(summary) {
  return nativeRecord({ ...summary, content: '', editable: false }, summary?.path || '');
}

export class WorkspaceStore {
  constructor(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'storage')) {
      this.storage = options.storage;
    } else {
      try { this.storage = globalThis.localStorage ?? null; } catch (error) { this.storage = null; }
    }
    this.storageKey = options.storageKey || STORAGE_KEY;
    this.nativeClient = options.nativeClient || null;
    this.nativeAuthoritative = Boolean(this.nativeClient?.available);
    this.seedNativeWorkspace = options.seedNativeWorkspace !== false;
    this.pendingNative = new Set();
    this.nativeEventQueue = Promise.resolve();
    this.nativeUnsubscribe = null;
    this.listeners = new Set();
    // Native deletion revisions are not files, but they are required as the
    // expectedRevision when a path is recreated. Keep them out of the project
    // tree while retaining them across WebView restarts via workspace/list.
    this.tombstones = new Map();
    this.memorySnapshot = null;
    this.snapshot = this.loadSnapshot(options.files || DEFAULT_FILES);
    // The first loaded snapshot is the workspace baseline used by the UI's
    // modified-file indicators. Revisions remain monotonic for conflict
    // detection, while a file that is changed and then restored can return to
    // a clean state visually.
    this.baseline = Object.fromEntries(Object.entries(this.snapshot.files).map(([path, record]) => [path, record.hash || hashText(record.content)]));
    this.storageListener = null;
    if (typeof globalThis.addEventListener === 'function' && this.storage && !this.nativeAuthoritative) {
      this.storageListener = (event) => {
        if (event.key !== this.storageKey || !event.newValue) return;
        try {
          this.applyExternalSnapshot(JSON.parse(event.newValue), 'external-storage');
        } catch (error) {
          // Ignore malformed snapshots from another tab.
        }
      };
      globalThis.addEventListener('storage', this.storageListener);
    }
    if (this.nativeAuthoritative) {
      this.nativeUnsubscribe = this.nativeClient.subscribe((event) => {
        this.nativeEventQueue = this.nativeEventQueue
          .then(() => this.handleNativeEvent(event))
          .catch((error) => this.emit({ type: 'native-sync-error', error: { message: error.message, code: error.code || 'native-sync-error' } }));
      });
      this.ready = this.hydrateNative(options.files || DEFAULT_FILES);
    } else {
      this.ready = Promise.resolve({ mode: 'browser', files: this.listFiles() });
    }
  }

  get mode() {
    return this.nativeAuthoritative ? 'native' : 'browser';
  }

  loadSnapshot(fallbackFiles) {
    let parsed = null;
    try {
      parsed = this.storage ? JSON.parse(this.storage.getItem(this.storageKey) || 'null') : null;
    } catch (error) {
      parsed = null;
    }
    if (!parsed || !parsed.files || typeof parsed.files !== 'object') {
      const now = Date.now();
      const files = {};
      Object.entries(fallbackFiles).forEach(([path, content]) => {
        files[normalizePath(path)] = { content, revision: 1, hash: hashText(content), updatedAt: now };
      });
      parsed = {
        version: 1,
        workspaceName: parsed?.workspaceName || 'ml-playground',
        files
      };
    }
    return parsed;
  }

  persist() {
    this.memorySnapshot = clone(this.snapshot);
    try {
      if (this.storage) {
        // In Android, the app-private filesystem is authoritative. Persist UI
        // metadata only; mirroring every source file into WebView storage
        // defeats that boundary and quickly exhausts the localStorage quota.
        const persisted = this.nativeAuthoritative
          ? { version: 2, native: true, workspaceName: this.snapshot.workspaceName }
          : this.snapshot;
        this.storage.setItem(this.storageKey, JSON.stringify(persisted));
      }
    } catch (error) {
      // Quota/private mode: keep the authoritative copy in memory for this session.
    }
  }

  trackNative(promise) {
    this.pendingNative.add(promise);
    promise.finally(() => this.pendingNative.delete(promise)).catch(() => {});
    return promise;
  }

  async hydrateNative(fallbackFiles = DEFAULT_FILES) {
    try {
      let listing = await this.nativeClient.list();
      let summaries = Array.isArray(listing) ? listing : listing?.files || [];
      this.tombstones.clear();
      if (!Array.isArray(listing)) {
        for (const tombstone of listing?.tombstones || []) {
          const path = normalizePath(tombstone?.path);
          const revision = Number(tombstone?.revision) || 0;
          if (path && revision > 0) this.tombstones.set(path, revision);
        }
      }
      // An empty file list is not necessarily a new workspace: deleting the
      // final file intentionally leaves a tombstone so revisions remain
      // monotonic. Seed examples only when native storage has no history.
      if (!summaries.length && !this.tombstones.size && this.seedNativeWorkspace) {
        for (const [path, content] of Object.entries(fallbackFiles || {})) {
          const expectedRevision = this.tombstones.get(normalizePath(path)) || 0;
          await this.nativeClient.write(path, content, { expectedRevision, source: 'workspace-seed' });
        }
        listing = await this.nativeClient.list();
        summaries = Array.isArray(listing) ? listing : listing?.files || [];
        this.tombstones.clear();
        for (const tombstone of listing?.tombstones || []) {
          const path = normalizePath(tombstone?.path);
          const revision = Number(tombstone?.revision) || 0;
          if (path && revision > 0) this.tombstones.set(path, revision);
        }
      }
      // Binary/model artifacts and oversized files stay in the shared native
      // workspace but never cross Binder/WebMessagePort or become UTF-8
      // strings. Only editable text is hydrated into the WebView mirror.
      const records = await Promise.all(summaries.map(async (summary) => (
        summary?.editable === false || summary?.kind === 'binary'
          ? nativeSummaryRecord(summary)
          : nativeRecord(await this.nativeClient.read(summary.path), summary.path)
      )));
      const files = {};
      records.forEach((value) => {
        const record = value?.path ? value : nativeRecord(value);
        if (!record) return;
        const { path, ...stored } = record;
        files[path] = stored;
      });
      const previous = this.snapshot;
      this.snapshot = { version: 2, workspaceName: previous.workspaceName || 'ml-playground', files };
      this.baseline = Object.fromEntries(Object.entries(files).map(([path, record]) => [path, record.hash]));
      this.persist();
      this.emitNativeDiff(previous.files, files, 'native-hydrate');
      this.emit({ type: 'workspace-hydrated', source: 'native', files: this.listFiles() });
      return { mode: 'native', files: this.listFiles() };
    } catch (error) {
      // An Android build must never silently promote localStorage to the
      // source of truth. Keep the cached mirror read-only until the broker is
      // available again, while browser previews continue to use the fallback.
      this.emit({ type: 'native-hydration-failed', error: { message: error.message, code: error.code || 'native-hydration-failed' } });
      throw error;
    }
  }

  emitNativeDiff(previousFiles, nextFiles, source) {
    const paths = new Set([...Object.keys(previousFiles || {}), ...Object.keys(nextFiles || {})]);
    paths.forEach((path) => {
      const before = previousFiles?.[path];
      const after = nextFiles?.[path];
      if (!after) {
        this.emit({ type: 'file-deleted', path, source, previous: before ? { path, ...clone(before) } : null });
      } else if (!before || before.revision !== after.revision || before.hash !== after.hash || before.content !== after.content) {
        this.emit({
          type: 'file-changed',
          path,
          source,
          previous: before ? { path, ...clone(before) } : null,
          current: { path, ...clone(after) }
        });
      }
    });
  }

  async handleNativeEvent(event) {
    if (!event || !event.path || !['created', 'changed', 'modified', 'deleted', 'file-changed', 'file-deleted'].includes(event.type)) return;
    const path = normalizePath(event.path);
    await Promise.allSettled([...this.pendingNative]);
    const previous = this.snapshot.files[path];
    if (event.type === 'deleted' || event.type === 'file-deleted') {
      const revision = Number(event.revision) || ((previous?.revision || 0) + 1);
      if (revision > 0) this.tombstones.set(path, revision);
      if (!previous) return;
      delete this.snapshot.files[path];
      this.persist();
      this.emit({
        type: 'file-deleted', path, revision,
        source: event.source || 'native-external',
        previous: { path, ...clone(previous) }
      });
      return;
    }
    const incoming = event.editable === false || event.kind === 'binary'
      ? nativeSummaryRecord(event)
      : nativeRecord(await this.nativeClient.read(path), path);
    if (!incoming) return;
    if (previous && previous.revision === incoming.revision && previous.hash === incoming.hash) return;
    const { path: ignored, ...stored } = incoming;
    this.tombstones.delete(path);
    this.snapshot.files[path] = stored;
    this.persist();
    this.emit({
      type: 'file-changed',
      path,
      source: event.source || 'native-external',
      previous: previous ? { path, ...clone(previous) } : null,
      current: { path, ...clone(stored) }
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    this.listeners.forEach((listener) => listener(clone(event)));
  }

  get workspaceName() {
    return this.snapshot.workspaceName;
  }

  renameWorkspace(name) {
    this.snapshot.workspaceName = String(name || 'ml-playground').trim() || 'ml-playground';
    this.persist();
    this.emit({ type: 'workspace-renamed', workspaceName: this.snapshot.workspaceName });
  }

  listFiles() {
    return Object.entries(this.snapshot.files)
      .map(([path, record]) => ({ path, ...record }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  has(path) {
    return Boolean(this.snapshot.files[normalizePath(path)]);
  }

  isModified(path) {
    const normalized = normalizePath(path);
    const record = this.snapshot.files[normalized];
    if (!record) return false;
    return this.baseline[normalized] !== record.hash;
  }

  read(path) {
    const normalized = normalizePath(path);
    const record = this.snapshot.files[normalized];
    if (!record) throw new Error('File not found: ' + normalized);
    return { path: normalized, ...clone(record) };
  }

  async readAsync(path) {
    await this.ready;
    return this.read(path);
  }

  write(path, content, options = {}) {
    const normalized = normalizePath(path);
    if (!normalized) throw new Error('A file path is required');
    const previous = this.snapshot.files[normalized];
    const actualRevision = previous?.revision
      ?? (this.nativeAuthoritative ? (this.tombstones.get(normalized) || 0) : 0);
    if (options.expectedRevision != null && actualRevision !== options.expectedRevision) {
      throw new RevisionConflictError(
        normalized,
        options.expectedRevision,
        previous ? { path: normalized, ...clone(previous) } : null
      );
    }
    const nextContent = String(content);
    const next = {
      content: nextContent,
      revision: (previous?.revision || 0) + 1,
      hash: hashText(nextContent),
      updatedAt: Date.now()
    };
    this.snapshot.files[normalized] = next;
    this.persist();
    this.emit({
      type: 'file-changed',
      path: normalized,
      source: options.source || 'unknown',
      previous: previous ? { path: normalized, ...clone(previous) } : null,
      current: { path: normalized, ...clone(next) }
    });
    if (this.nativeAuthoritative && !options.skipNative) {
      // Compatibility path for synchronous callers. New UI code uses
      // writeAsync so conflicts are observed before reporting a successful
      // save; flush() still makes this optimistic mirror durable before run.
      const operation = this.nativeClient.write(normalized, nextContent, {
        expectedRevision: actualRevision,
        source: options.source || 'unknown'
      }).then((value) => {
        const authoritative = nativeRecord(value, normalized);
        if (!authoritative) return;
        const current = this.snapshot.files[normalized];
        if (current?.content !== nextContent) return;
        const { path: ignored, ...stored } = authoritative;
        this.tombstones.delete(normalized);
        this.snapshot.files[normalized] = stored;
        this.persist();
      }).catch(async (error) => {
        this.emit({ type: 'native-write-error', path: normalized, source: options.source || 'unknown', error: { message: error.message, code: error.code || 'native-write-error' } });
        try { await this.handleNativeEvent({ type: 'modified', path: normalized, source: 'native-conflict' }); } catch (refreshError) {}
        throw error;
      });
      this.trackNative(operation);
    }
    return { path: normalized, ...clone(next) };
  }

  async writeAsync(path, content, options = {}) {
    await this.ready;
    if (!this.nativeAuthoritative) return this.write(path, content, options);
    const normalized = normalizePath(path);
    if (!normalized) throw new Error('A file path is required');
    const previous = this.snapshot.files[normalized];
    const actualRevision = previous?.revision ?? (this.tombstones.get(normalized) || 0);
    const expectedRevision = options.expectedRevision ?? actualRevision;
    if (actualRevision !== expectedRevision) {
      throw new RevisionConflictError(normalized, expectedRevision, previous ? { path: normalized, ...clone(previous) } : null);
    }
    const operation = this.nativeClient.write(normalized, String(content), {
      expectedRevision,
      source: options.source || 'unknown'
    });
    this.trackNative(operation);
    let value;
    try { value = await operation; }
    catch (error) {
      if (error?.code === 'revision-conflict') {
        let actual = null;
        try { actual = nativeRecord(await this.nativeClient.read(normalized), normalized); } catch (readError) {}
        if (actual) {
          const { path: ignored, ...stored } = actual;
          this.snapshot.files[normalized] = stored;
          this.tombstones.delete(normalized);
          this.persist();
        } else {
          const tombstoneRevision = Number(error?.details?.actualRevision) || 0;
          if (tombstoneRevision > 0) this.tombstones.set(normalized, tombstoneRevision);
          if (tombstoneRevision > 0) {
            actual = { path: normalized, revision: tombstoneRevision, deleted: true };
          }
        }
        throw new RevisionConflictError(normalized, expectedRevision, actual);
      }
      throw error;
    }
    const record = nativeRecord(value, normalized);
    if (!record) throw new Error('Native workspace returned an invalid file record');
    const { path: ignored, ...stored } = record;
    this.tombstones.delete(normalized);
    this.snapshot.files[normalized] = stored;
    this.persist();
    this.emit({
      type: 'file-changed', path: normalized, source: options.source || 'unknown',
      previous: previous ? { path: normalized, ...clone(previous) } : null,
      current: { path: normalized, ...clone(stored) }
    });
    return { path: normalized, ...clone(stored) };
  }

  async applyBatchAsync(transaction, options = {}) {
    await this.ready;
    const files = Array.isArray(transaction?.files) ? transaction.files : [];
    if (!files.length) throw new Error('A workspace batch requires at least one file');
    const normalized = files.map((file) => ({
      path: normalizePath(file.path),
      beforeText: String(file.beforeText ?? file.before ?? ''),
      afterText: String(file.afterText ?? file.after ?? file.content ?? ''),
      delete: file.delete === true,
      baseRevision: Number(file.baseRevision ?? file.expectedRevision) || 0,
      baseSha256: String(file.baseSha256 ?? file.expectedSha256 ?? '')
    }));
    if (normalized.some((file) => !file.path) || new Set(normalized.map((file) => file.path)).size !== normalized.length) {
      throw new Error('A workspace batch contains an unsafe or duplicate path');
    }
    // Validate the complete set before the first mutation, including the
    // browser preview fallback. Android repeats these checks inside its
    // journaled atomic transaction.
    for (const file of normalized) {
      const current = this.snapshot.files[file.path];
      const revision = current?.revision ?? (this.tombstones.get(file.path) || 0);
      const digest = current?.sha256 || current?.hash || hashText(current?.content || '');
      if (file.delete && (!current || !file.baseSha256)) throw new Error('Deletion requires an existing file and its base hash');
      if (revision !== file.baseRevision
          || (file.baseSha256 && digest !== file.baseSha256)
          || (current && current.content !== file.beforeText)) {
        throw new RevisionConflictError(file.path, file.baseRevision, current ? { path: file.path, ...clone(current) } : null);
      }
    }
    const source = options.source || 'dsh';
    if (this.nativeAuthoritative) {
      if (typeof this.nativeClient.applyBatch !== 'function') {
        throw new Error('Native workspace does not support atomic batch writes');
      }
      const operation = this.nativeClient.applyBatch({
        transactionId: transaction.transactionId,
        files: normalized.map((file) => ({
          path: file.path,
          content: file.afterText,
          delete: file.delete,
          expectedRevision: file.baseRevision,
          expectedSha256: file.baseSha256
        })),
        source
      });
      this.trackNative(operation);
      const result = await operation;
      const records = Array.isArray(result?.files) ? result.files : [];
      const deleted = Array.isArray(result?.deleted) ? result.deleted : [];
      const changes = [];
      for (const value of records) {
        const record = nativeRecord(value, value?.path);
        if (!record) continue;
        const previous = this.snapshot.files[record.path];
        const { path, ...stored } = record;
        this.snapshot.files[path] = stored;
        this.tombstones.delete(path);
        changes.push({
          type: 'file-changed', path, source,
          transactionId: result.transactionId || transaction.transactionId,
          previous: previous ? { path, ...clone(previous) } : null,
          current: { path, ...clone(stored) }
        });
      }
      for (const value of deleted) {
        const path = normalizePath(value.path);
        const previous = this.snapshot.files[path];
        delete this.snapshot.files[path];
        this.tombstones.set(path, Number(value.revision) || 0);
        changes.push({ type: 'file-deleted', path, revision: Number(value.revision) || 0, source,
          transactionId: result.transactionId || transaction.transactionId,
          previous: previous ? { path, ...clone(previous) } : null });
      }
      this.persist();
      for (const change of changes) this.emit(change);
      return { ...result, files: records.map((record) => nativeRecord(record, record?.path)).filter(Boolean) };
    }

    const before = this.snapshot.files;
    const next = { ...before };
    const now = Date.now();
    for (const file of normalized) {
      const previous = before[file.path];
      if (file.delete) {
        delete next[file.path];
        this.tombstones.set(file.path, file.baseRevision + 1);
        continue;
      }
      this.tombstones.delete(file.path);
      next[file.path] = {
        content: file.afterText,
        revision: file.baseRevision + 1,
        hash: hashText(file.afterText),
        updatedAt: now
      };
    }
    this.snapshot.files = next;
    this.persist();
    const transactionId = transaction.transactionId || `batch-${now.toString(36)}`;
    for (const file of normalized) {
      this.emit({
        type: file.delete ? 'file-deleted' : 'file-changed', path: file.path, source, transactionId,
        revision: file.baseRevision + 1,
        previous: before[file.path] ? { path: file.path, ...clone(before[file.path]) } : null,
        current: file.delete ? null : { path: file.path, ...clone(next[file.path]) }
      });
    }
    return { transactionId, files: normalized.filter(file => !file.delete).map((file) => this.read(file.path)),
      deleted: normalized.filter(file => file.delete).map(file => ({ path: file.path, revision: file.baseRevision + 1, sha256: '' })) };
  }

  createFile(path, content = '', options = {}) {
    const normalized = normalizePath(path);
    if (this.has(normalized)) throw new Error('File already exists: ' + normalized);
    return this.write(normalized, content, { ...options, source: options.source || 'create' });
  }

  async createFileAsync(path, content = '', options = {}) {
    await this.ready;
    const normalized = normalizePath(path);
    if (this.has(normalized)) throw new Error('File already exists: ' + normalized);
    return this.writeAsync(normalized, content, {
      ...options,
      expectedRevision: options.expectedRevision ?? (this.tombstones.get(normalized) || 0),
      source: options.source || 'create'
    });
  }

  delete(path, options = {}) {
    const normalized = normalizePath(path);
    const previous = this.snapshot.files[normalized];
    if (!previous) return false;
    delete this.snapshot.files[normalized];
    this.persist();
    this.emit({ type: 'file-deleted', path: normalized, source: options.source || 'unknown', previous: { path: normalized, ...clone(previous) } });
    return true;
  }

  async deleteAsync(path, options = {}) {
    await this.ready;
    const normalized = normalizePath(path);
    const previous = this.snapshot.files[normalized];
    if (!previous) return false;
    if (!this.nativeAuthoritative) return this.delete(normalized, options);
    const operation = this.nativeClient.delete(normalized, {
      expectedRevision: options.expectedRevision ?? previous.revision,
      source: options.source || 'unknown'
    });
    this.trackNative(operation);
    const result = await operation;
    const tombstoneRevision = Number(result?.revision) || previous.revision + 1;
    this.tombstones.set(normalized, tombstoneRevision);
    delete this.snapshot.files[normalized];
    this.persist();
    this.emit({
      type: 'file-deleted', path: normalized, revision: tombstoneRevision,
      source: options.source || 'unknown', previous: { path: normalized, ...clone(previous) }
    });
    return true;
  }

  async flush() {
    await this.ready;
    while (this.pendingNative.size) await Promise.all([...this.pendingNative]);
    await this.nativeEventQueue;
    return this.listFiles();
  }

  replaceFiles(files, options = {}) {
    const previousFiles = this.snapshot.files;
    const nextFiles = {};
    const now = Date.now();
    Object.entries(files || {}).forEach(([path, value]) => {
      const normalized = normalizePath(path);
      if (!normalized) return;
      const content = typeof value === 'string' ? value : String(value?.content ?? '');
      const hash = hashText(content);
      const previous = previousFiles[normalized];
      const unchanged = previous?.content === content;
      nextFiles[normalized] = {
        content,
        revision: unchanged ? (Number(previous.revision) || 1) : (Number(previous?.revision) || 0) + 1,
        hash,
        updatedAt: unchanged ? (Number(previous.updatedAt) || now) : now
      };
    });
    this.snapshot.files = nextFiles;
    this.baseline = Object.fromEntries(Object.entries(nextFiles).map(([path, record]) => [path, record.hash]));
    this.persist();
    const source = options.source || 'import';

    // Keep directory imports and other whole-workspace replacements on the
    // same event path as ordinary writes.  A DocumentSession can then refresh
    // a clean active buffer (or surface a conflict for a dirty one), while
    // the UI still receives a single workspace-replaced summary below.
    const paths = new Set([...Object.keys(previousFiles), ...Object.keys(nextFiles)]);
    paths.forEach((path) => {
      const before = previousFiles[path];
      const after = nextFiles[path];
      if (!after) {
        this.emit({ type: 'file-deleted', path, source, previous: before ? { path, ...clone(before) } : null });
      } else if (!before || before.content !== after.content || before.revision !== after.revision) {
        this.emit({
          type: 'file-changed',
          path,
          source,
          previous: before ? { path, ...clone(before) } : null,
          current: { path, ...clone(after) }
        });
      }
    });
    this.emit({ type: 'workspace-replaced', source, files: this.listFiles() });
  }

  applyExternalSnapshot(nextSnapshot, source = 'external') {
    if (!nextSnapshot || typeof nextSnapshot.files !== 'object') return false;
    const previous = this.snapshot;
    const nextFiles = {};
    Object.entries(nextSnapshot.files).forEach(([path, value]) => {
      const normalized = normalizePath(path);
      if (!normalized) return;
      const content = typeof value === 'string' ? value : String(value?.content || '');
      nextFiles[normalized] = {
        content,
        revision: Number(value?.revision) || 1,
        hash: value?.hash || hashText(content),
        updatedAt: Number(value?.updatedAt) || Date.now()
      };
    });
    this.snapshot = {
      version: Number(nextSnapshot.version) || 1,
      workspaceName: String(nextSnapshot.workspaceName || this.snapshot.workspaceName || 'ml-playground'),
      files: nextFiles
    };
    this.memorySnapshot = clone(this.snapshot);
    if (previous.workspaceName !== this.snapshot.workspaceName) {
      this.emit({ type: 'workspace-renamed', workspaceName: this.snapshot.workspaceName, source });
    }
    const paths = new Set([...Object.keys(previous.files), ...Object.keys(nextFiles)]);
    paths.forEach((path) => {
      const before = previous.files[path];
      const after = nextFiles[path];
      if (!after) {
        this.emit({ type: 'file-deleted', path, source, previous: before ? { path, ...clone(before) } : null });
      } else if (!before || before.hash !== after.hash || before.revision !== after.revision) {
        this.emit({
          type: 'file-changed',
          path,
          source,
          previous: before ? { path, ...clone(before) } : null,
          current: { path, ...clone(after) }
        });
      }
    });
    return true;
  }

  simulateExternalChange(path, content) {
    return this.write(path, content, { source: 'external' });
  }

  exportSnapshot() {
    return clone(this.snapshot);
  }

  exportBlob() {
    return new Blob([JSON.stringify(this.snapshot, null, 2)], { type: 'application/json' });
  }

  async importDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') throw new Error('Directory access is not available in this browser');
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const files = {};
    const visit = async (directory, prefix = '') => {
      for await (const entry of directory.values()) {
        const path = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.kind === 'directory') await visit(entry, path);
        else if (entry.kind === 'file' && !path.split('/').some((part) => part.startsWith('.'))) {
          files[path] = await (await entry.getFile()).text();
        }
      }
    };
    await visit(handle);
    if (this.nativeAuthoritative) await this.replaceFilesAsync(files, { source: 'directory-import' });
    else this.replaceFiles(files, { source: 'directory-import' });
    return { handle, files: this.listFiles() };
  }

  async replaceFilesAsync(files, options = {}) {
    await this.ready;
    if (!this.nativeAuthoritative) return this.replaceFiles(files, options);
    const normalizedFiles = {};
    Object.entries(files || {}).forEach(([path, value]) => {
      const normalized = normalizePath(path);
      if (normalized) normalizedFiles[normalized] = typeof value === 'string' ? value : String(value?.content ?? '');
    });
    const source = options.source || 'import';
    for (const current of this.listFiles()) {
      if (!Object.prototype.hasOwnProperty.call(normalizedFiles, current.path)) {
        await this.deleteAsync(current.path, { expectedRevision: current.revision, source });
      }
    }
    for (const [path, content] of Object.entries(normalizedFiles)) {
      const current = this.snapshot.files[path];
      if (current?.content === content) continue;
      const expectedRevision = current?.revision ?? (this.tombstones.get(path) || 0);
      await this.writeAsync(path, content, { expectedRevision, source });
    }
    this.baseline = Object.fromEntries(Object.entries(this.snapshot.files).map(([path, record]) => [path, record.hash]));
    this.emit({ type: 'workspace-replaced', source, files: this.listFiles() });
  }

  async writeDirectory(handle) {
    if (!handle) throw new Error('A directory handle is required');
    for (const file of this.listFiles()) {
      const parts = file.path.split('/');
      const name = parts.pop();
      let directory = handle;
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
      const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
      await writable.write(file.content);
      await writable.close();
    }
  }

  dispose() {
    if (this.storageListener && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('storage', this.storageListener);
      this.storageListener = null;
    }
    this.nativeUnsubscribe?.();
    this.nativeUnsubscribe = null;
    this.listeners.clear();
  }
}
