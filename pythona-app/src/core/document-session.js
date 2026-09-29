import { RevisionConflictError } from './workspace-store.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isMissingFile(error) {
  return ['file-not-found', 'not-found', 'ENOENT'].includes(error?.code)
    || /file not found|file does not exist|no such file|文件不存在/i.test(error?.message || '');
}

class SingleDocumentSession {
  constructor(store) {
    this.store = store;
    this.listeners = new Set();
    this.path = null;
    this.original = '';
    this.buffer = '';
    this.revision = 0;
    this.hash = null;
    // `revision` belongs to the persisted workspace record.  Editor and
    // language-service requests need a separate monotonic clock because a
    // buffer can change many times before it is saved.  Never derive one from
    // the other: doing so would allow an old async completion to be applied to
    // a newer, unsaved buffer.
    this.bufferVersion = 0;
    this.dirty = false;
    this.conflict = null;
    this.preview = null;
    this.undoStack = [];
    this.redoStack = [];
    this.savePromise = null;
    this.saving = false;
    this.saveError = null;
    this.viewState = null;
    this.unsubscribeStore = store.subscribe((event) => this.handleStoreEvent(event));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    const snapshot = this.snapshot();
    this.listeners.forEach((listener) => listener({ ...clone(event), document: snapshot }));
  }

  snapshot() {
    return {
      path: this.path,
      original: this.original,
      buffer: this.buffer,
      revision: this.revision,
      hash: this.hash,
      bufferVersion: this.bufferVersion,
      dirty: this.dirty,
      saving: this.saving,
      saveError: this.saveError ? clone(this.saveError) : null,
      viewState: this.viewState ? clone(this.viewState) : null,
      conflict: this.conflict ? clone(this.conflict) : null,
      preview: this.preview ? clone(this.preview) : null,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0
    };
  }

  open(path) {
    const record = this.store.read(path);
    return this.openRecord(record);
  }

  async openAsync(path) {
    const record = await this.store.readAsync(path);
    return this.openRecord(record);
  }

  openRecord(record) {
    // Opening an already-active tab is idempotent. In particular, the
    // directory-import flow may select the first file after replacing the
    // workspace; reopening that same path must not discard a dirty buffer or
    // the conflict raised by the replacement event.
    if (record.path === this.path && (this.dirty || this.conflict)) return this.snapshot();
    const changedDocument = record.path !== this.path || record.content !== this.buffer;
    this.path = record.path;
    this.original = record.content;
    this.buffer = record.content;
    this.revision = record.revision;
    this.hash = record.sha256 || record.hash || null;
    this.dirty = false;
    this.saveError = null;
    this.conflict = null;
    this.preview = null;
    this.undoStack = [];
    this.redoStack = [];
    if (changedDocument) this.bumpBufferVersion();
    this.emit({ type: 'opened', path: this.path });
    return this.snapshot();
  }

  edit(content, options = {}) {
    if (this.path == null) throw new Error('Open a document before editing');
    const next = String(content);
    if (next === this.buffer) return this.snapshot();
    if (!options.skipHistory) this.undoStack.push(this.buffer);
    this.buffer = next;
    this.bumpBufferVersion();
    this.redoStack = [];
    this.dirty = this.buffer !== this.original;
    if (!this.dirty && !this.conflict) this.saveError = null;
    this.preview = null;
    this.emit({
      type: options.source === 'dsh' ? 'dsh-edit' : 'edited',
      source: options.source || 'editor',
      composing: Boolean(options.composing),
      changes: Array.isArray(options.changes) ? options.changes : null
    });
    return this.snapshot();
  }

  setPreview(content, metadata = {}) {
    if (this.path == null) return this.snapshot();
    this.preview = { content: String(content), ...metadata };
    this.emit({ type: 'preview', source: metadata.source || 'dsh' });
    return this.snapshot();
  }

  clearPreview() {
    if (!this.preview) return;
    this.preview = null;
    this.emit({ type: 'preview-cleared' });
  }

  save(source = 'editor') {
    if (!this.path) throw new Error('Open a document before saving');
    if (!this.dirty) return this.snapshot();
    try {
      const record = this.store.write(this.path, this.buffer, { expectedRevision: this.revision, source });
      return this.applySavedRecord(record, source);
    } catch (error) {
      this.handleSaveError(error);
      throw error;
    }
  }

  saveAsync(source = 'editor') {
    if (this.savePromise) return this.savePromise;
    this.saving = true;
    this.emit({ type: 'saving', source });
    this.savePromise = this.performSave(source).finally(() => {
      this.savePromise = null;
      this.saving = false;
      this.emit({ type: 'save-settled', source });
    });
    return this.savePromise;
  }

  async performSave(source) {
    if (!this.path) throw new Error('Open a document before saving');
    const path = this.path;
    try {
      if (!this.dirty) {
        await this.store.flush?.();
        this.saveError = null;
        return this.snapshot();
      }
      const record = await this.store.writeAsync(path, this.buffer, {
        expectedRevision: this.revision,
        source
      });
      // A delayed save must not overwrite the identity of a newly opened
      // tab, or mark edits typed while the write was pending as persisted.
      return this.path === path ? this.applySavedRecord(record, source) : this.snapshot();
    } catch (error) {
      if (this.path === path) this.handleSaveError(error);
      throw error;
    }
  }

  applySavedRecord(record, source) {
    if (this.revision > record.revision || this.conflict?.remoteRevision > record.revision) return this.snapshot();
    this.original = record.content;
    this.revision = record.revision;
    this.hash = record.sha256 || record.hash || null;
    this.dirty = this.buffer !== record.content;
    this.saveError = null;
    this.conflict = null;
    this.preview = null;
    this.emit({ type: 'saved', source });
    return this.snapshot();
  }

  handleSaveError(error) {
    this.saveError = {
      message: String(error?.message || '文件无法保存，请重试').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512),
      code: String(error?.code || (error instanceof RevisionConflictError ? 'revision-conflict' : 'save-failed')).slice(0, 64)
    };
    this.emit({ type: 'save-error', path: this.path, error: this.saveError });
    if (!(error instanceof RevisionConflictError)) return;
    const actual = error.actualRecord;
    this.conflict = {
      path: this.path,
      local: this.buffer,
      remote: actual?.deleted ? null : (actual?.content ?? null),
      remoteRevision: actual?.revision || 0,
      deleted: !actual || actual.deleted === true
    };
    this.emit({ type: 'conflict', error });
  }

  applyContent(content, source = 'dsh') {
    return this.edit(content, { source });
  }

  /**
   * Capture the identity of the active in-memory buffer for an async request.
   * The returned token is intentionally independent from the saved revision.
   */
  captureBuffer() {
    return Object.freeze({ path: this.path, bufferVersion: this.bufferVersion });
  }

  isCurrentBuffer(token) {
    return Boolean(token)
      && token.path != null
      && this.path != null
      && token.path === this.path
      && token.bufferVersion === this.bufferVersion;
  }

  bumpBufferVersion() {
    this.bufferVersion += 1;
    return this.bufferVersion;
  }

  acceptRemote() {
    if (!this.conflict) return this.snapshot();
    if (this.conflict.deleted) {
      const path = this.path;
      this.path = null;
      this.original = '';
      this.buffer = '';
      this.revision = 0;
      this.dirty = false;
      this.saveError = null;
      this.conflict = null;
      this.preview = null;
      this.undoStack = [];
      this.redoStack = [];
      this.bumpBufferVersion();
      this.emit({ type: 'conflict-resolved', resolution: 'remote', path, deleted: true });
      return this.snapshot();
    }
    const record = this.store.read(this.path);
    const changedBuffer = record.content !== this.buffer;
    this.original = record.content;
    this.buffer = record.content;
    this.revision = record.revision;
    this.hash = record.sha256 || record.hash || null;
    this.dirty = false;
    this.saveError = null;
    this.conflict = null;
    this.undoStack = [];
    this.redoStack = [];
    if (changedBuffer) this.bumpBufferVersion();
    this.emit({ type: 'conflict-resolved', resolution: 'remote' });
    return this.snapshot();
  }

  keepLocal() {
    if (!this.conflict) return this.snapshot();
    this.revision = this.conflict.remoteRevision;
    this.conflict = null;
    this.dirty = true;
    this.emit({ type: 'conflict-resolved', resolution: 'local' });
    return this.snapshot();
  }

  undo() {
    if (!this.undoStack.length) return this.snapshot();
    this.redoStack.push(this.buffer);
    this.buffer = this.undoStack.pop();
    this.bumpBufferVersion();
    this.dirty = this.buffer !== this.original;
    if (!this.dirty && !this.conflict) this.saveError = null;
    this.emit({ type: 'undo' });
    return this.snapshot();
  }

  redo() {
    if (!this.redoStack.length) return this.snapshot();
    this.undoStack.push(this.buffer);
    this.buffer = this.redoStack.pop();
    this.bumpBufferVersion();
    this.dirty = this.buffer !== this.original;
    if (!this.dirty && !this.conflict) this.saveError = null;
    this.emit({ type: 'redo' });
    return this.snapshot();
  }

  handleStoreEvent(event) {
    // Writes made by this document session are already reflected in the
    // buffer.  DSH uses a few transaction-specific source labels
    // (`dsh`, `dsh-undo`, …); treating all of them as local prevents the
    // synchronous store event from being misclassified as an external
    // conflict while a save is in progress.
    const localWrite = event.source === 'editor' || String(event.source || '').startsWith('dsh');
    if (event.path !== this.path) return;
    if (event.type === 'file-deleted') {
      const path = this.path;
      if (this.dirty) {
        this.preview = null;
        this.conflict = {
          path,
          local: this.buffer,
          remote: null,
          remoteRevision: Number(event.revision) || this.revision + 1,
          deleted: true
        };
        this.emit({ type: 'conflict', source: event.source, deleted: true });
        return;
      }
      this.path = null;
      this.original = '';
      this.buffer = '';
      this.revision = 0;
      this.dirty = false;
      this.saveError = null;
      this.conflict = null;
      this.preview = null;
      this.undoStack = [];
      this.redoStack = [];
      this.bumpBufferVersion();
      this.emit({ type: 'external-delete', path, source: event.source });
      return;
    }
    if (event.type !== 'file-changed' || localWrite) return;
    const incoming = event.current;
    // An external/imported version that matches the buffer confirms the
    // local edit rather than conflicting with it.
    if (incoming.content === this.buffer) {
      this.original = incoming.content;
      this.revision = incoming.revision;
      this.hash = incoming.sha256 || incoming.hash || null;
      this.dirty = false;
      this.saveError = null;
      this.conflict = null;
      this.preview = null;
      this.emit({ type: 'external-refresh', source: event.source });
      return;
    }
    if (!this.dirty) {
      const changedBuffer = incoming.content !== this.buffer;
      this.original = incoming.content;
      this.buffer = incoming.content;
      this.revision = incoming.revision;
      this.hash = incoming.sha256 || incoming.hash || null;
      this.saveError = null;
      this.conflict = null;
      this.preview = null;
      if (changedBuffer) this.bumpBufferVersion();
      this.emit({ type: 'external-refresh', source: event.source });
      return;
    }
    // A revision-only update does not conflict with a dirty buffer. Advance
    // the expected revision so the next save does not report a false conflict.
    if (incoming.content === event.previous?.content) {
      if (this.conflict) this.conflict.remoteRevision = incoming.revision;
      else this.revision = incoming.revision;
      return;
    }
    this.conflict = { path: this.path, local: this.buffer, remote: incoming.content, remoteRevision: incoming.revision, deleted: false };
    this.emit({ type: 'conflict', source: event.source });
  }

  dispose() {
    this.unsubscribeStore?.();
    this.listeners.clear();
  }
}

/** Each tab owns its buffer and save operation; the facade exposes the active tab. */
export class DocumentSession {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
    this.listeners = new Set();
    this.active = new SingleDocumentSession(store);
    this.empty = this.active;
    this.drafts = null;
    this.draftTimer = null;
    this.draftQueue = Promise.resolve();
    this.recovery = new Map();
    this.openSequence = 0;
    this.bufferClock = 0;
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { this.listeners.forEach((listener) => listener({ ...event, document: this.snapshot() })); }
  snapshot() { return this.active.snapshot(); }
  snapshotFor(path) { return this.sessions.get(path)?.snapshot() || null; }
  snapshots() { return [...this.sessions.values()].map((session) => session.snapshot()).filter((value) => value.path); }
  dirtyPaths() { return this.snapshots().filter((value) => value.dirty || value.conflict).map((value) => value.path); }
  hasDirty(paths = null) { const selected = paths ? new Set(paths) : null; return this.dirtyPaths().some((path) => !selected || selected.has(path)); }
  assertClean(paths) {
    const selected = new Set(paths || []);
    const conflicts = this.dirtyPaths().filter((path) => selected.has(path));
    if (conflicts.length) {
      const error = new Error(`请先保存或处理这些文件的未保存内容：${conflicts.join('、')}`);
      error.code = 'dirty-buffers'; error.paths = conflicts; throw error;
    }
    return true;
  }

  createSession(record) {
    const session = new SingleDocumentSession(this.store);
    session.bumpBufferVersion = () => {
      this.bufferClock = Math.max(this.bufferClock, session.bufferVersion) + 1;
      session.bufferVersion = this.bufferClock;
      return session.bufferVersion;
    };
    this.sessions.set(record.path, session);
    session.subscribe((event) => {
      if (!event.document.path && event.path && ['external-delete', 'conflict-resolved'].includes(event.type)) {
        this.queueDraft(() => this.drafts?.delete(event.path));
      }
      this.scheduleDrafts();
      this.emit({ ...event, affectedDocument: event.document, inactive: session !== this.active });
    });
    return session;
  }

  open(path) {
    this.openSequence += 1;
    try { return this.openRecord(this.store.read(path)); }
    catch (error) { return this.openMissing(path, error); }
  }
  async openAsync(path) {
    const sequence = ++this.openSequence;
    try {
      const record = await this.store.readAsync(path);
      if (sequence !== this.openSequence) return this.snapshot();
      return this.openRecord(record);
    } catch (error) {
      if (sequence !== this.openSequence) return this.snapshot();
      return this.openMissing(path, error);
    }
  }
  openMissing(path, error) {
    const session = this.sessions.get(path);
    if (!isMissingFile(error) || !session || (!session.dirty && !session.conflict)) throw error;
    if (this.path && this.path !== path) this.flushDrafts().catch(() => {});
    if (!session.conflict?.deleted) session.conflict = {
      path, local: session.buffer, remote: null, remoteRevision: this.store.tombstones?.get(path) || 0,
      deleted: true, recoveredDraft: true
    };
    this.active = session;
    this.emit({ type:'opened', path });
    return this.snapshot();
  }
  openRecord(record) {
    if (this.path && record.path !== this.path) this.flushDrafts().catch(() => {});
    const session = this.sessions.get(record.path) || this.createSession(record);
    const switching = session !== this.active;
    this.active = session;
    // Revisiting an existing tab must not reset its undo stack or its preview.
    if (session.path === record.path) {
      if (record.revision !== session.revision || record.content !== session.original) {
        session.handleStoreEvent({ type: 'file-changed', path: record.path, current: record,
          previous: { content: session.original }, source: 'open-refresh' });
      }
      if (switching) this.emit({ type: 'opened', path: record.path });
    } else session.openRecord(record);
    return this.snapshot();
  }
  async saveAllAsync(source = 'editor') {
    const results = [];
    for (const session of this.sessions.values()) if (session.dirty || session.conflict) {
      if (session.conflict) throw Object.assign(new Error(`请先处理文件冲突：${session.path}`), { code: 'buffer-conflict', path: session.path });
      results.push(await session.saveAsync(source));
    }
    await this.flushDrafts();
    return results;
  }
  savePathAsync(path, source = 'editor') {
    const session = this.sessions.get(path);
    if (!session) return Promise.resolve(null);
    return session.saveAsync(source);
  }
  editPath(path, content, options = {}) {
    const session = this.sessions.get(path);
    if (!session) throw new Error('Open a document before editing');
    return session.edit(content, options);
  }
  close(path, { discard = false } = {}) {
    const session = this.sessions.get(path);
    if (!session) return true;
    if ((session.dirty || session.conflict || session.saving) && !discard) return false;
    if (session.saving) return false;
    session.dispose(); this.sessions.delete(path); this.recovery.delete(path);
    if (this.active === session) this.active = this.empty;
    this.queueDraft(() => this.drafts?.delete(path));
    this.emit({ type: 'closed', path });
    return true;
  }
  attachDrafts(client) { this.drafts = client; return this; }
  setViewState(path, value) {
    const session = this.sessions.get(path);
    if (!session) return;
    session.viewState = {
      cursor: Math.max(0, Math.min(session.buffer.length, Number(value?.cursor) || 0)),
      scroll: { top: Math.max(0, Number(value?.scroll?.top) || 0), left: Math.max(0, Number(value?.scroll?.left) || 0) }
    };
    if (session.dirty) this.scheduleDrafts();
  }
  scheduleDrafts() {
    if (!this.drafts) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.flushDrafts().catch(() => {}), 1000);
  }
  queueDraft(operation) {
    const pending = this.draftQueue.catch(() => {}).then(operation);
    this.draftQueue = pending;
    pending.catch((error) => this.emit({ type: 'draft-error', message: error.message }));
    return pending;
  }
  flushDrafts() {
    clearTimeout(this.draftTimer); this.draftTimer = null;
    if (!this.drafts) return Promise.resolve();
    const snapshots = this.snapshots();
    return this.queueDraft(async () => {
      for (const snapshot of snapshots) {
        if (snapshot.dirty || snapshot.conflict) await this.drafts.write({
          path: snapshot.path, content: snapshot.buffer, original: snapshot.original,
          revision: snapshot.revision, hash: snapshot.hash, bufferVersion: snapshot.bufferVersion,
          viewState: snapshot.viewState,
          updatedAt: Date.now()
        });
        else await this.drafts.delete(snapshot.path);
      }
    });
  }
  async recoverDrafts() {
    if (!this.drafts) return [];
    const recovered = [];
    const entries = await this.drafts.list();
    if (this.drafts.warnings?.length) this.emit({ type: 'draft-error', message: '部分草稿无法读取，原文件已保留；其他草稿仍可恢复。' });
    for (const metadata of entries) {
      const draft = await this.drafts.read(metadata.path);
      if (!draft || this.sessions.get(draft.path)?.dirty) continue;
      let record = null;
      try { record = await this.store.readAsync(draft.path); } catch (error) {
        // Only a confirmed missing file is a deletion conflict; transport errors fail.
        if (!isMissingFile(error)) throw error;
      }
      if (record?.content === draft.content) { await this.drafts.delete(draft.path); continue; }
      const session = this.sessions.get(draft.path) || this.createSession(record || {
        path: draft.path, content: draft.original || '', revision: draft.revision, hash: draft.hash
      });
      if (!session.path) session.openRecord(record || { path: draft.path, content: draft.original || '', revision: draft.revision, hash: draft.hash });
      const matches = record && record.revision === draft.revision
        && (!draft.hash || (record.sha256 || record.hash) === draft.hash) && record.content === draft.original;
      session.original = draft.original || '';
      session.revision = draft.revision;
      session.hash = draft.hash || null;
      session.viewState = draft.viewState || null;
      session.buffer = draft.content;
      session.bufferVersion = Math.max(session.bufferVersion, Number(draft.bufferVersion) || 0) + 1;
      this.bufferClock = Math.max(this.bufferClock, session.bufferVersion);
      session.dirty = true;
      session.undoStack = []; session.redoStack = [];
      if (!matches) session.conflict = {
        path: draft.path, local: draft.content, remote: record?.content ?? null,
        remoteRevision: record?.revision || this.store.tombstones?.get(draft.path) || 0, deleted: !record, recoveredDraft: true
      };
      const result = { path: draft.path, conflict: !matches };
      this.recovery.set(draft.path, result); recovered.push(result);
    }
    if (recovered.length) this.emit({ type: 'drafts-recovered', recovered });
    return recovered;
  }
  dispose() {
    clearTimeout(this.draftTimer);
    for (const session of this.sessions.values()) session.dispose();
    this.empty.dispose(); this.listeners.clear();
  }
}

for (const property of ['path', 'original', 'buffer', 'revision', 'hash', 'bufferVersion', 'dirty', 'conflict',
  'preview', 'undoStack', 'redoStack', 'savePromise', 'saving', 'saveError']) {
  Object.defineProperty(DocumentSession.prototype, property, {
    get() { return this.active[property]; }, set(value) { this.active[property] = value; }
  });
}
for (const method of ['edit', 'setPreview', 'clearPreview', 'save', 'saveAsync', 'applyContent', 'captureBuffer',
  'isCurrentBuffer', 'bumpBufferVersion', 'acceptRemote', 'keepLocal', 'undo', 'redo']) {
  DocumentSession.prototype[method] = function (...args) { return this.active[method](...args); };
}
