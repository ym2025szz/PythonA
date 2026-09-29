import { EditorAdapter } from './editor-adapter.js';

function keyForPreview(snapshot) {
  const preview = snapshot.preview;
  if (!preview) return '';
  return [snapshot.path, snapshot.buffer.length, preview.content.length, preview.hunk || 0, preview.total || 0, preview.content].join(':');
}

function validBufferVersion(value, fallback = 0) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 0 ? version : fallback;
}

export class EditorCoordinator {
  constructor(options) {
    this.activePath = null;
    this.activeBufferVersion = 0;
    this.entries = new Map();
    this.preview = null;
    this.onChange = options.onChange || (() => {});
    const adapterOptions = {
      ...options,
      onChange: (content, metadata) => this.handleChange(content, metadata),
      onState: (state, scroll, settings) => this.handleState(state, scroll, settings)
    };
    this.adapter = options.adapter || (options.createAdapter
      ? options.createAdapter(adapterOptions)
      : new EditorAdapter(adapterOptions));
  }

  handleState(state, scroll, settings = this.adapter.appliedSettings) {
    if (!this.activePath || this.preview) return;
    this.entries.set(this.activePath, {
      state,
      scroll,
      settings: settings ? { ...settings } : undefined,
      bufferVersion: this.activeBufferVersion
    });
  }

  handleChange(content, metadata) {
    if (!this.activePath || this.preview) return;
    this.onChange(content, metadata);
  }

  saveActive() {
    if (!this.activePath || this.preview) return;
    this.entries.set(this.activePath, {
      ...this.adapter.capture(),
      bufferVersion: this.activeBufferVersion
    });
  }

  open(path, content, bufferVersion = 0) {
    if (this.adapter.view?.composing) {
      this.adapter.runAfterComposition(() => this.open(path, content, bufferVersion));
      return;
    }
    if (path === this.activePath && !this.preview) {
      this.activeBufferVersion = validBufferVersion(bufferVersion, this.activeBufferVersion);
      this.adapter.currentBufferVersion = this.activeBufferVersion;
      return;
    }
    this.leavePreview();
    this.saveActive();
    this.activePath = path || null;
    this.activeBufferVersion = validBufferVersion(bufferVersion);
    this.adapter.currentPath = this.activePath;
    this.adapter.currentBufferVersion = this.activeBufferVersion;
    if (!path) {
      const entry = this.adapter.open('', '', this.activeBufferVersion);
      this.entries.delete('');
      return entry;
    }
    const expected = String(content ?? '');
    let entry = this.entries.get(path);
    if (!entry) {
      entry = {
        ...this.adapter.open(path, expected, this.activeBufferVersion),
        bufferVersion: this.activeBufferVersion
      };
      this.entries.set(path, entry);
      return;
    }
    this.adapter.restore(entry);
    if (entry.state.doc.toString() !== expected) {
      this.adapter.applySessionText(expected, 'session-open', false);
    }
  }

  resetActive(content, { origin = 'session-refresh', addToHistory = false, bufferVersion = null } = {}) {
    if (!this.activePath) return;
    if (bufferVersion != null) this.activeBufferVersion = validBufferVersion(bufferVersion);
    this.adapter.currentBufferVersion = this.activeBufferVersion;
    return this.adapter.applySessionText(content, origin, addToHistory);
  }

  enterPreview(snapshot) {
    const key = keyForPreview(snapshot);
    if (this.preview?.key === key) return;
    if (!this.preview) this.saveActive();
    this.preview = {
      key,
      path: snapshot.path,
      before: snapshot.buffer,
      after: snapshot.preview.content
    };
    this.adapter.enterPreview(snapshot.buffer, snapshot.preview.content, {
      path: snapshot.path,
      scroll: this.entries.get(snapshot.path)?.scroll || { top: 0, left: 0 }
    });
  }

  leavePreview() {
    if (!this.preview) return null;
    const preview = this.preview;
    this.preview = null;
    if (!this.adapter.leavePreview()) {
      const entry = this.entries.get(preview.path);
      if (entry) this.adapter.restore(entry, { preview: false });
      else this.adapter.previewMode = false;
    }
    return preview;
  }

  present(snapshot, settings) {
    if (this.adapter.view?.composing) {
      this.adapter.runAfterComposition(() => this.present(snapshot, settings));
      return;
    }
    if (snapshot.path !== this.activePath) {
      this.open(snapshot.path, snapshot.buffer, snapshot.bufferVersion);
    }
    this.activeBufferVersion = validBufferVersion(snapshot.bufferVersion, this.activeBufferVersion);
    this.adapter.currentBufferVersion = this.activeBufferVersion;
    if (!snapshot.path) {
      this.adapter.reconfigure(settings);
      return;
    }
    if (snapshot.preview) this.enterPreview(snapshot);
    else {
      const previousPreview = this.leavePreview();
      if (this.adapter.documentText() !== snapshot.buffer) {
        const acceptedPreview = previousPreview
          && previousPreview.after !== previousPreview.before
          && snapshot.buffer === previousPreview.after;
        this.resetActive(snapshot.buffer, {
          origin: acceptedPreview ? 'dsh-accept' : 'session-refresh',
          addToHistory: Boolean(acceptedPreview),
          bufferVersion: snapshot.bufferVersion
        });
      }
    }
    this.adapter.reconfigure(settings);
  }

  retain(paths) {
    const keep = new Set(paths || []);
    for (const path of this.entries.keys()) if (!keep.has(path) && path !== this.activePath) this.entries.delete(path);
  }

  close(path) {
    this.entries.delete(path);
  }

  undo() { return this.adapter.undo(); }
  redo() { return this.adapter.redo(); }
  openSearch() { return this.adapter.openSearch(); }
  startCompletion() { return this.adapter.startCompletion(); }
  inlineSnapshot() { return this.adapter.inlineSnapshot(); }
  inlineState() { return this.adapter.inlineState(); }
  setInlineSuggestion(value) { return this.adapter.setInlineSuggestion(value); }
  clearInlineSuggestion(reason) { return this.adapter.clearInlineSuggestion(reason); }
  acceptInlineSuggestion() { return this.adapter.acceptInlineSuggestion(); }
  touchEdit(action) { return this.adapter.touchEdit(action); }
  focus() { this.adapter.focus(); }
  goTo(offset) { return this.adapter.goTo(offset); }
  isFocused() { return this.adapter.isFocused(); }
  destroy() { this.adapter.destroy(); }
}
