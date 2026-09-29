import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap, hasNextSnippetField, nextSnippetField, moveCompletionSelection, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, indentWithTab, isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { gotoLine, highlightSelectionMatches, openSearchPanel, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  hoverTooltip,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin
} from '@codemirror/view';
import { createEditorTheme } from './editor-theme.js';
import { createSemanticCompletionSource, createWorkspaceCompletionSource } from './python-completions.js';
import { pythonTokenHighlighting } from './python-highlighting.js';
import { inlineSuggestionExtension, inlineSuggestionField, safeInlineText, sameInlineToken, setInline } from './inline-suggestion.js';

const isPythonPath = (path) => /\.pyi?$/i.test(String(path || ''));

export const normalizeEditorSettings = (settings = {}) => ({
  theme: settings.theme === 'light' ? 'light' : 'dark',
  lineNumbers: settings.lineNumbers !== false,
  foldGutter: settings.foldGutter !== false,
  wordWrap: Boolean(settings.wrap ?? settings.wordWrap),
  autocomplete: settings.autocomplete !== false,
  tabSize: Number(settings.tabSize) || 4,
  fontSize: Number(settings.fontSize ?? settings.editorSize) || 16
});

const settingKeys = Object.freeze([
  'theme', 'lineNumbers', 'foldGutter', 'wordWrap', 'autocomplete', 'tabSize', 'fontSize'
]);

export function changedEditorSettings(previous, next) {
  return settingKeys.filter((key) => previous?.[key] !== next?.[key]);
}

function openReplacePanel(view) {
  const opened = openSearchPanel(view);
  queueMicrotask(() => view.dom.querySelector('.cm-search input[name="replace"]')?.focus());
  return opened;
}

export const editorSearchShortcuts = Object.freeze([
  { key: 'Mod-h', preventDefault: true, run: openReplacePanel },
  { key: 'Mod-g', preventDefault: true, run: gotoLine }
]);

// CodeMirror's completion keymap intentionally leaves Tab unbound. Keep this
// binding at the highest precedence: accept a visible completion first, then
// return false so the regular indentWithTab binding handles normal editing.
export const completionTabBinding = Object.freeze({
  key: 'Tab',
  preventDefault: true,
  run: (view) => hasNextSnippetField(view.state) ? nextSnippetField(view) : acceptCompletion(view)
});

function preserveSelection(selection, length) {
  const ranges = selection.ranges.map((range) => EditorSelection.range(
    Math.min(range.anchor, length),
    Math.min(range.head, length)
  ));
  return EditorSelection.create(ranges, Math.min(selection.mainIndex, ranges.length - 1));
}

function buildIndentGuideDecorations(view) {
  const ranges = [];
  const tabSize = view.state.tabSize || 4;
  for (const visible of view.visibleRanges) {
    let position = visible.from;
    while (position <= visible.to) {
      const line = view.state.doc.lineAt(position);
      const indentation = /^[\t ]+/.exec(line.text)?.[0] || '';
      let index = 0;
      while (index < indentation.length) {
        const start = index;
        if (indentation[index] === '\t') index += 1;
        else {
          let columns = 0;
          while (index < indentation.length
            && indentation[index] === ' '
            && columns < tabSize) {
            index += 1;
            columns += 1;
          }
        }
        ranges.push(Decoration.mark({ class: 'cm-indentGuide' }).range(
          line.from + start,
          line.from + index
        ));
      }
      if (line.to >= view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const indentationGuides = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildIndentGuideDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.startState.tabSize !== update.state.tabSize) {
      this.decorations = buildIndentGuideDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

function lspPosition(doc, offset) {
  const line = doc.lineAt(Math.max(0, Math.min(offset, doc.length)));
  return { line: line.number - 1, character: offset - line.from };
}

function incrementalContentChanges(update) {
  const changes = [];
  update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    // CodeMirror reports every range against startState. LSP applies an array
    // sequentially, so send disjoint ranges from bottom to top: edits at a
    // larger offset cannot move any range that precedes them.
    changes.unshift({
      range: {
        start: lspPosition(update.startState.doc, fromA),
        end: lspPosition(update.startState.doc, toA)
      },
      text: inserted.toString()
    });
  });
  return changes;
}

export class EditorAdapter {
  constructor(options) {
    this.parent = options.parent;
    this.onChange = options.onChange || (() => {});
    this.onCursor = options.onCursor || (() => {});
    this.onHistory = options.onHistory || (() => {});
    this.onState = options.onState || (() => {});
    this.onInlineState = options.onInlineState || (() => {});
    this.onInputFrame = options.onInputFrame || (() => {});
    this.onInlineDismiss = options.onInlineDismiss || (() => {});
    this.getInlineIdentity = options.getInlineIdentity || (() => ({}));
    this.visibleInlineSuggestion = null;
    this.onSave = options.onSave || (() => false);
    this.onRun = options.onRun || (() => false);
    this.onCompositionEnd = options.onCompositionEnd || null;
    this.onHover = options.onHover || null;
    this.onSignatureHelp = options.onSignatureHelp || null;
    this.onDefinition = options.onDefinition || null;
    this.onReferences = options.onReferences || null;
    this.onRename = options.onRename || null;
    this.languageService = options.languageService || null;
    this.getDocument = options.getDocument || (() => null);
    this.getWorkspaceFiles = options.getWorkspaceFiles || (() => []);
    this.settings = normalizeEditorSettings(options.settings);
    this.appliedSettings = { ...this.settings };
    this.suppressCallbacks = 0;
    this.previewMode = false;
    this.previewReturn = null;
    this.currentPath = null;
    this.currentBufferVersion = 0;
    this.selectionVersion = 0;
    this.pendingCompositionActions = [];
    this.compositionHadChange = false;

    this.themeCompartment = new Compartment();
    this.gutterCompartment = new Compartment();
    this.foldCompartment = new Compartment();
    this.wrapCompartment = new Compartment();
    this.completionCompartment = new Compartment();
    this.readOnlyCompartment = new Compartment();
    this.languageCompartment = new Compartment();
    this.mergeCompartment = new Compartment();
    this.tabSizeCompartment = new Compartment();
    this.fontSizeCompartment = new Compartment();

    this.workspaceCompletion = createWorkspaceCompletionSource({
      getFiles: () => this.getWorkspaceFiles(),
      getDocument: () => this.getDocument(),
      isComposing: () => Boolean(this.view?.composing)
    });
    this.semanticCompletion = createSemanticCompletionSource({
      languageService: this.languageService,
      getDocument: () => this.getDocument(),
      isComposing: () => Boolean(this.view?.composing),
      getLocalOptions: (context) => this.workspaceCompletion(context)?.options || []
    });

    this.view = new EditorView({
      parent: this.parent,
      state: this.createState('', '')
    });
    this.view.contentDOM.setAttribute('aria-label', 'Python 代码编辑器');
    this.view.contentDOM.setAttribute('spellcheck', 'false');
    this.view.contentDOM.addEventListener('compositionstart', () => {
      this.compositionHadChange = false;
      this.clearInlineSuggestion('composition');
      closeCompletion(this.view);
    });
    this.view.contentDOM.addEventListener('compositionend', () => {
      const pending = this.pendingCompositionActions.splice(0);
      const shouldComplete = this.compositionHadChange;
      this.compositionHadChange = false;
      queueMicrotask(() => {
        pending.forEach((action) => action());
        const readiness = this.onCompositionEnd?.();
        // CodeMirror deliberately suppresses completion while Android/IME is
        // composing. Re-query once the committed text is visible so a user
        // does not have to type an extra character after accepting Chinese
        // (or any other composing) input.
        if (shouldComplete && this.settings.autocomplete && !this.previewMode && this.view) {
          const expected = this.getDocument?.();
          queueMicrotask(() => {
            if (!this.view?.composing && !this.previewMode) startCompletion(this.view);
          });
          // Local symbols render immediately. Once didChange has reached Jedi,
          // re-trigger only if the same buffer is still active so semantic
          // candidates can merge without ever showing a stale response.
          Promise.resolve(readiness).then(() => {
            const current = this.getDocument?.();
            if (!expected || !current
              || current.path !== expected.path
              || current.bufferVersion !== expected.bufferVersion) return;
            if (!this.view?.composing && !this.previewMode && this.view.hasFocus) {
              startCompletion(this.view);
            }
          }).catch(() => {});
        }
      });
    });
    this.emitCursorAndHistory();
  }

  languageExtension(path) {
    if (isPythonPath(path)) {
      return [python(), pythonLanguage.data.of({ autocomplete: this.workspaceCompletion })];
    }
    return [];
  }

  completionExtension() {
    return autocompletion({
      defaultKeymap: false,
      activateOnTyping: this.settings.autocomplete,
      interactionDelay: 0,
      maxRenderedOptions: 48,
      override: [this.workspaceCompletion, this.semanticCompletion].filter(Boolean),
      optionClass: (completion) => completion.type ? `pythona-completion-${completion.type}` : ''
    });
  }

  async hoverAt(position) {
    if (!this.onHover || this.previewMode || this.view?.composing) return null;
    const value = await this.onHover(position);
    if (!value) return null;
    const contents = Array.isArray(value.contents) ? value.contents : [value.contents ?? value.value ?? value];
    const text = contents.map((item) => typeof item === 'string' ? item : item?.value || '').filter(Boolean).join('\n');
    if (!text) return null;
    return {
      pos: position,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-pythona-hover';
        dom.textContent = text;
        return { dom };
      }
    };
  }

  baseExtensions(path, options = {}) {
    const externalKeymap = [
      { key: 'Mod-s', preventDefault: true, run: () => Boolean(this.onSave()) || true },
      { key: 'Shift-F10', preventDefault: true, run: () => { this.onRun(); return true; } },
      { key: 'Mod-Space', preventDefault: true, run: startCompletion },
      { key: 'F12', preventDefault: true, run: (view) => { this.onDefinition?.(view.state.selection.main.head); return Boolean(this.onDefinition); } },
      { key: 'Shift-F12', preventDefault: true, run: (view) => { this.onReferences?.(view.state.selection.main.head); return Boolean(this.onReferences); } },
      { key: 'F2', preventDefault: true, run: (view) => { this.onRename?.(view.state.selection.main.head); return Boolean(this.onRename); } },
      ...editorSearchShortcuts
    ];
    return [
      highlightSpecialChars(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      bracketMatching(),
      indentationGuides,
      inlineSuggestionExtension(this),
      pythonTokenHighlighting,
      closeBrackets(),
      indentOnInput(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.clickAddsSelectionRange.of((event) => event.altKey || event.ctrlKey || event.metaKey),
      EditorView.updateListener.of((update) => this.handleUpdate(update)),
      EditorView.domEventHandlers({ blur: () => { this.clearInlineSuggestion('blur'); return false; } }),
      EditorView.exceptionSink.of((error) => console.error('CodeMirror extension error', error)),
      this.onHover ? hoverTooltip((view, pos) => this.hoverAt(pos), { hoverTime: 350 }) : [],
      Prec.highest(keymap.of([
        { key: 'Tab', preventDefault: true, run: (view) => {
          if (view.composing) return false;
          if (hasNextSnippetField(view.state)) return nextSnippetField(view);
          return this.acceptInlineSuggestion() || acceptCompletion(view);
        } },
        { key: 'Escape', run: () => this.clearInlineSuggestion('dismiss') || closeCompletion(this.view) },
        ...externalKeymap
      ])),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap.filter((binding) => binding.key !== 'Enter'),
        indentWithTab
      ]),
      options.history === false ? [] : history(),
      this.themeCompartment.of(createEditorTheme(this.settings.theme)),
      this.gutterCompartment.of(this.settings.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
      this.foldCompartment.of(this.settings.foldGutter ? foldGutter() : []),
      this.wrapCompartment.of(this.settings.wordWrap ? EditorView.lineWrapping : []),
      this.completionCompartment.of(this.completionExtension()),
      this.readOnlyCompartment.of([
        EditorState.readOnly.of(Boolean(options.readOnly) || !path),
        EditorView.editable.of(!options.readOnly && Boolean(path))
      ]),
      this.languageCompartment.of(this.languageExtension(path)),
      this.mergeCompartment.of(options.previewOriginal == null ? [] : unifiedMergeView({
        original: options.previewOriginal,
        gutter: true,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        mergeControls: false,
        allowInlineDiffs: true,
        diffConfig: { scanLimit: 50000, timeout: 600 }
      })),
      this.tabSizeCompartment.of(EditorState.tabSize.of(this.settings.tabSize)),
      this.fontSizeCompartment.of(EditorView.theme({
        '.cm-content': { fontSize: `${this.settings.fontSize}px` }
      }))
    ];
  }

  createState(doc, path, options = {}) {
    return EditorState.create({
      doc: String(doc ?? ''),
      extensions: this.baseExtensions(path, options)
    });
  }

  createPreviewState({ path, before, after }) {
    return this.createState(after, path, { readOnly: true, history: false, previewOriginal: before });
  }

  handleUpdate(update) {
    if (update.docChanged || update.selectionSet) this.selectionVersion += 1;
    if (this.suppressCallbacks) return;
    if(update.docChanged && update.transactions.some(transaction=>transaction.isUserEvent('input'))) this.onInputFrame();
    this.onState(update.state, this.captureScroll(), { ...this.appliedSettings });
    if (update.docChanged && !this.previewMode) {
      if (update.view.composing) this.compositionHadChange = true;
      this.onChange(update.state.doc.toString(), {
        path: this.currentPath,
        composing: update.view.composing,
        changes: incrementalContentChanges(update)
      });
      if (!update.view.composing && this.onSignatureHelp) {
        let trigger = false;
        update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          if (/[,(]$/.test(inserted.toString())) trigger = true;
        });
        if (trigger) queueMicrotask(() => this.onSignatureHelp?.(update.state.selection.main.head));
      }
    }
    if (update.docChanged || update.selectionSet) this.emitCursorAndHistory();
  }

  emitCursorAndHistory() {
    if (!this.view) return;
    const position = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(position);
    this.onCursor({ line: line.number, column: position - line.from + 1, offset: position });
    this.onHistory({ canUndo: undoDepth(this.view.state) > 0, canRedo: redoDepth(this.view.state) > 0 });
  }

  captureScroll() {
    return { top: this.view?.scrollDOM.scrollTop || 0, left: this.view?.scrollDOM.scrollLeft || 0 };
  }

  capture() {
    return {
      state: this.view.state,
      scroll: this.captureScroll(),
      settings: { ...this.appliedSettings }
    };
  }

  runAfterComposition(action) {
    if (!this.view.composing) { action(); return; }
    // File switches and settings reconfiguration can both arrive before an
    // Android IME finishes composition. Preserve every action in order: a
    // single overwriteable slot could switch the coordinator's active path
    // while leaving the old document visible and route the next edit into the
    // wrong file.
    this.pendingCompositionActions.push(action);
  }

  restore(entry, { preview = false } = {}) {
    this.runAfterComposition(() => {
      this.clearInlineSuggestion('restore');
      this.suppressCallbacks += 1;
      this.previewMode = preview;
      try {
        this.view.setState(entry.state);
        // Cached editor states retain history, never a previously visible AI suggestion.
        if (this.view.state.field(inlineSuggestionField, false)) this.view.dispatch({ effects: setInline.of(null) });
        this.appliedSettings = normalizeEditorSettings(entry.settings || this.settings);
        this.view.scrollDOM.scrollTop = entry.scroll?.top || 0;
        this.view.scrollDOM.scrollLeft = entry.scroll?.left || 0;
      } finally {
        this.suppressCallbacks -= 1;
      }
      // Cached tab states carry their own compartment configuration. A file
      // switch queued behind IME composition may restore an older state after
      // the caller's reconfigure() call has already returned, so reconcile it
      // at the point where the state actually becomes active.
      if (changedEditorSettings(this.appliedSettings, this.settings).length) {
        this.configure(this.settings);
      }
      this.emitCursorAndHistory();
    });
  }

  open(path, text, bufferVersion = 0) {
    const entry = {
      state: this.createState(text, path),
      scroll: { top: 0, left: 0 },
      settings: { ...this.settings }
    };
    this.currentPath = path || null;
    const version = Number(bufferVersion);
    this.currentBufferVersion = Number.isSafeInteger(version) && version >= 0 ? version : 0;
    this.previewReturn = null;
    this.restore(entry, { preview: false });
    return entry;
  }

  applySessionText(text, origin = 'session', addToHistory = false) {
    const nextText = String(text ?? '');
    if (!this.view.composing && nextText === this.documentText()) return false;
    const apply = () => {
      if (nextText === this.documentText()) return;
      const scroll = this.captureScroll();
      const selection = preserveSelection(this.view.state.selection, nextText.length);
      const annotations = [Transaction.addToHistory.of(Boolean(addToHistory))];
      if (addToHistory) annotations.push(isolateHistory.of('full'));
      this.suppressCallbacks += 1;
      try {
        this.view.dispatch({
          changes: { from: 0, to: this.view.state.doc.length, insert: nextText },
          selection,
          annotations,
          userEvent: `input.${String(origin || 'session').replace(/[^\w.-]/g, '-')}`
        });
        this.view.scrollDOM.scrollTop = scroll.top;
        this.view.scrollDOM.scrollLeft = scroll.left;
      } finally {
        this.suppressCallbacks -= 1;
      }
      this.onState(this.view.state, this.captureScroll(), { ...this.appliedSettings });
      this.emitCursorAndHistory();
    };
    this.runAfterComposition(apply);
    return true;
  }

  enterPreview(before, after, options = {}) {
    if (!this.previewMode) this.previewReturn = this.capture();
    const path = options.path ?? this.currentPath ?? '';
    const entry = {
      state: this.createPreviewState({ path, before, after }),
      scroll: options.scroll || this.previewReturn?.scroll || this.captureScroll(),
      settings: { ...this.settings }
    };
    this.restore(entry, { preview: true });
    return entry;
  }

  leavePreview() {
    if (!this.previewMode && !this.previewReturn) return false;
    const entry = this.previewReturn;
    this.previewReturn = null;
    if (entry) this.restore(entry, { preview: false });
    else this.previewMode = false;
    return true;
  }

  configure(settings = {}) {
    const normalizedInput = {
      ...settings,
      wordWrap: settings.wrap ?? settings.wordWrap ?? this.settings.wordWrap,
      fontSize: settings.fontSize ?? settings.editorSize ?? this.settings.fontSize
    };
    const next = normalizeEditorSettings({ ...this.settings, ...normalizedInput });
    const desiredChanged = changedEditorSettings(this.settings, next).length > 0;
    this.settings = next;
    if (!desiredChanged && !changedEditorSettings(this.appliedSettings, next).length) return false;
    const apply = () => {
      const changed = changedEditorSettings(this.appliedSettings, this.settings);
      if (!changed.length) return;
      const effects = [];
      if (changed.includes('theme')) {
        effects.push(this.themeCompartment.reconfigure(createEditorTheme(this.settings.theme)));
      }
      if (changed.includes('lineNumbers')) {
        effects.push(this.gutterCompartment.reconfigure(
          this.settings.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []
        ));
      }
      if (changed.includes('foldGutter')) {
        effects.push(this.foldCompartment.reconfigure(this.settings.foldGutter ? foldGutter() : []));
      }
      if (changed.includes('wordWrap')) {
        effects.push(this.wrapCompartment.reconfigure(this.settings.wordWrap ? EditorView.lineWrapping : []));
      }
      if (changed.includes('autocomplete')) {
        effects.push(this.completionCompartment.reconfigure(this.completionExtension()));
      }
      if (changed.includes('tabSize')) {
        effects.push(this.tabSizeCompartment.reconfigure(EditorState.tabSize.of(this.settings.tabSize)));
      }
      if (changed.includes('fontSize')) {
        effects.push(this.fontSizeCompartment.reconfigure(EditorView.theme({
          '.cm-content': { fontSize: `${this.settings.fontSize}px` }
        })));
      }
      this.suppressCallbacks += 1;
      try {
        this.view.dispatch({ effects });
        this.appliedSettings = { ...this.settings };
      } finally {
        this.suppressCallbacks -= 1;
      }
    };
    this.runAfterComposition(apply);
    return true;
  }

  reconfigure(settings = {}) { return this.configure(settings); }

  documentText() { return this.view.state.doc.toString(); }
  isFocused() { return this.view.hasFocus; }
  focus() { this.view.focus(); }
  undo() { if (!this.previewMode) return undo(this.view); return false; }
  redo() { if (!this.previewMode) return redo(this.view); return false; }
  openSearch() { return openSearchPanel(this.view); }
  startCompletion() { return startCompletion(this.view); }
  inlineSnapshot() {
    if (!this.view) return null;
    const document = this.getDocument?.();
    const range = this.view.state.selection.main;
    return {
      ...this.getInlineIdentity(), path: document?.path ?? this.currentPath,
      bufferVersion: document?.bufferVersion ?? this.currentBufferVersion,
      cursor: range.head,
      selection: { anchor: range.anchor, head: range.head },
      selectionVersion: this.selectionVersion,
      // The document session already holds the current string; avoid joining
      // CodeMirror's rope again for every cursor/identity check in large files.
      text: document?.buffer ?? this.documentText(),
      eligible: this.view.hasFocus && !this.view.composing && !this.previewMode
        && !this.view.state.readOnly && this.view.state.selection.ranges.length === 1 && range.empty
        && isPythonPath(document?.path ?? this.currentPath)
    };
  }
  inlineState() {
    const value = this.visibleInlineSuggestion;
    return { visible: Boolean(value), text: value?.text || '', source: value?.source || null, token: value?.token || null };
  }
  setInlineSuggestion({ text, token, source = 'ai' }) {
    if (!safeInlineText(text) || !this.inlineSnapshot()?.eligible || !sameInlineToken(token, this.inlineSnapshot())) return false;
    this.view.dispatch({ effects: setInline.of({ text, token, source }) });
    return true;
  }
  clearInlineSuggestion(reason = 'clear') {
    if (!this.view) return false;
    const value = this.visibleInlineSuggestion || this.view.state.field(inlineSuggestionField, false);
    if (reason === 'dismiss' && value) this.onInlineDismiss(value.token || this.inlineSnapshot());
    if (this.view.state.field(inlineSuggestionField, false)) this.view.dispatch({ effects: setInline.of(null) });
    if (value?.source === 'local') closeCompletion(this.view);
    this.visibleInlineSuggestion = null;
    this.onInlineState({ visible: false, text: '', source: null, token: null, reason });
    return Boolean(value);
  }
  acceptInlineSuggestion() {
    const value = this.visibleInlineSuggestion;
    const current = this.inlineSnapshot();
    if (!value || !current?.eligible || this.view.composing) return false;
    if (value.source === 'local') {
      this.view.dispatch({ annotations: isolateHistory.of('full') });
      const accepted = acceptCompletion(this.view);
      this.view.dispatch({ annotations: isolateHistory.of('full') });
      return accepted;
    }
    if (!sameInlineToken(value.token, current)) { this.clearInlineSuggestion('stale'); return false; }
    this.view.dispatch({
      changes: { from: current.cursor, insert: value.text },
      selection: { anchor: current.cursor + value.text.length },
      effects: setInline.of(null), annotations: isolateHistory.of('full'), userEvent: 'input.complete'
    });
    return true;
  }
  touchEdit(action) {
    if (this.view.composing || this.previewMode || this.view.state.readOnly) return false;
    if (action === 'accept') return this.acceptInlineSuggestion();
    if (action === 'dismiss') return this.clearInlineSuggestion('dismiss');
    if (action === 'next' || action === 'previous') return moveCompletionSelection(action === 'next')(this.view);
    this.focus();
    if (action === 'indent') return indentMore(this.view);
    if (action === 'outdent') return indentLess(this.view);
    if (action === 'left' || action === 'right') {
      this.goTo(this.view.state.selection.main.head + (action === 'left' ? -1 : 1));
      return true;
    }
    if (typeof action === 'string' && action.length <= 4) {
      this.view.dispatch(this.view.state.replaceSelection(action), { userEvent: 'input.type' });
      return true;
    }
    return false;
  }
  goTo(offset) {
    const position = Math.max(0, Math.min(Number(offset) || 0, this.view.state.doc.length));
    this.view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
    this.focus();
    return position;
  }
  destroy() { this.view.destroy(); }
}

export class MergeDiffView {
  constructor(parent, settings = {}) {
    this.parent = parent;
    this.settings = normalizeEditorSettings(settings);
    this.themeCompartment = new Compartment();
    this.view = null;
    this.patch = null;
  }

  show(patch) {
    this.destroy();
    this.patch = patch;
    if (!patch) return;
    const language = isPythonPath(patch.path) ? python() : [];
    this.view = new EditorView({
      parent: this.parent,
      doc: patch.after,
      extensions: [
        highlightSpecialChars(),
        drawSelection(),
        lineNumbers(),
        language,
        this.themeCompartment.of(createEditorTheme(this.settings.theme)),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        unifiedMergeView({
          original: patch.before,
          gutter: true,
          highlightChanges: true,
          syntaxHighlightDeletions: true,
          mergeControls: false,
          allowInlineDiffs: true,
          diffConfig: { scanLimit: 50000, timeout: 600 }
        })
      ]
    });
    this.view.contentDOM.setAttribute('aria-label', `${patch.path} Diff`);
  }

  configure(settings = {}) {
    const next = normalizeEditorSettings({ ...this.settings, ...settings });
    const themeChanged = next.theme !== this.settings.theme;
    this.settings = next;
    if (this.view && themeChanged) {
      this.view.dispatch({ effects: this.themeCompartment.reconfigure(createEditorTheme(this.settings.theme)) });
    }
    return themeChanged;
  }

  destroy() {
    this.view?.destroy();
    this.view = null;
    this.parent.replaceChildren();
  }
}
