import { selectedCompletion } from '@codemirror/autocomplete';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';

// Suggestions deliberately live outside the document and its undo history.
export const setInline = StateEffect.define();
export const inlineSuggestionField = StateField.define({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) value = null;
    for (const effect of transaction.effects) if (effect.is(setInline)) value = effect.value;
    return value;
  }
});

export function safeInlineText(text) {
  return typeof text === 'string' && text.length > 0
    && text.split('\n').length <= 8 && new TextEncoder().encode(text).length <= 2048
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

export function sameInlineToken(left, right) {
  return Boolean(left && right) && left.path === right.path
    && left.bufferVersion === right.bufferVersion && left.cursor === right.cursor
    && left.epoch === right.epoch
    && (left.modelSelectionVersion ?? left.modelVersion) === (right.modelSelectionVersion ?? right.modelVersion)
    && left.selectionVersion === right.selectionVersion
    && (left.generation ?? 0) === (right.generation ?? 0);
}

export function localInlineSuggestion(state, completion = selectedCompletion(state)) {
  const selection = state.selection;
  if (!completion || selection.ranges.length !== 1 || !selection.main.empty
    || typeof completion.apply === 'function') return null;
  const cursor = selection.main.head;
  const line = state.doc.lineAt(cursor);
  // A suffix widget cannot honestly preview replacement of text after the caret.
  if (/[\p{L}\p{N}_]/u.test(state.doc.sliceString(cursor, cursor + 1))) return null;
  const prefix = /[\p{L}\p{N}_]+$/u.exec(state.doc.sliceString(line.from, cursor))?.[0] || '';
  const full = completion.apply ?? completion.label;
  if (typeof full !== 'string' || !full.startsWith(prefix)) return null;
  const text = full.slice(prefix.length);
  return safeInlineText(text) ? { source: 'local', cursor, text, completion } : null;
}

class SuggestionWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-inlineSuggestion';
    span.textContent = this.text;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() { return true; }
}

export function inlineSuggestionExtension(adapter) {
  return [inlineSuggestionField, EditorView.baseTheme({
    '.cm-inlineSuggestion': { color: '#7c8593', opacity: '0.65', whiteSpace: 'pre-wrap', pointerEvents: 'none' }
  }), ViewPlugin.fromClass(class {
    constructor(view) { this.refresh(view); }
    update(update) { this.refresh(update.view); }
    refresh(view) {
      const enabled = view.hasFocus && !view.composing && !adapter.previewMode
        && !view.state.readOnly && /\.pyi?$/i.test(adapter.currentPath || '');
      let value = enabled && adapter.settings.autocomplete ? localInlineSuggestion(view.state) : null;
      if (!value && enabled) {
        const ai = view.state.field(inlineSuggestionField, false);
        if (ai && sameInlineToken(ai.token, adapter.inlineSnapshot())) value = ai;
      }
      this.decorations = value
        ? Decoration.set([Decoration.widget({ widget: new SuggestionWidget(value.text), side: 1 }).range(view.state.selection.main.head)])
        : Decoration.none;
      adapter.visibleInlineSuggestion = value || null;
      const key = value ? `${value.source}:${value.text}:${value.token?.bufferVersion ?? ''}` : '';
      if (this.lastKey !== key) {
        this.lastKey = key;
        // View plugins may not dispatch during update. Notify after it settles.
        queueMicrotask(() => adapter.onInlineState?.(adapter.inlineState()));
      }
    }
  }, { decorations: (plugin) => plugin.decorations })];
}
