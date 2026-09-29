import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const palettes = {
  dark: {
    background: '#14171c', text: '#d9e0e8', gutter: '#101318', gutterText: '#6f7b88',
    active: '#1d252c', selection: '#244f73', cursor: '#63b3ff', border: '#2b333d',
    keyword: '#ff7ab2', builtin: '#82d2ce', variable: '#d9e0e8', definition: '#c792ea',
    function: '#82aaff', className: '#ffc66d', property: '#c099ff', decorator: '#ffd580',
    string: '#c3e88d', number: '#f78c6c', comment: '#6f7f8c', operator: '#89ddff',
    punctuation: '#aab7c4', bool: '#ff966c', invalid: '#ff5370', tooltip: '#1a1f26'
  },
  light: {
    background: '#ffffff', text: '#243241', gutter: '#f5f7fa', gutterText: '#7b8794',
    active: '#eef2f7', selection: '#b9ddff', cursor: '#1267a5', border: '#d8dee7',
    keyword: '#9c2577', builtin: '#006d73', variable: '#243241', definition: '#7b3f98',
    function: '#1f5aa6', className: '#9a5700', property: '#7045a0', decorator: '#8a5b00',
    string: '#3c7814', number: '#a44620', comment: '#687683', operator: '#006d83',
    punctuation: '#526273', bool: '#b33c17', invalid: '#c62846', tooltip: '#ffffff'
  }
};

function highlightStyle(palette) {
  return HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier], color: palette.keyword, fontWeight: '600' },
    { tag: [tags.bool, tags.null], color: palette.bool, fontWeight: '600' },
    { tag: [tags.standard(tags.variableName), tags.standard(tags.name)], color: palette.builtin },
    { tag: tags.definition(tags.function(tags.variableName)), color: palette.function, fontWeight: '700' },
    { tag: tags.definition(tags.className), color: palette.className, fontWeight: '700' },
    { tag: tags.definition(tags.variableName), color: palette.definition, fontWeight: '600' },
    { tag: tags.function(tags.variableName), color: palette.function },
    { tag: [tags.className, tags.typeName], color: palette.className },
    { tag: tags.namespace, color: palette.builtin },
    { tag: [tags.variableName, tags.name], color: palette.variable },
    { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: palette.property },
    { tag: [tags.string, tags.special(tags.string), tags.docComment], color: palette.string },
    { tag: [tags.number, tags.integer, tags.float], color: palette.number },
    { tag: [tags.lineComment, tags.blockComment, tags.comment], color: palette.comment, fontStyle: 'italic' },
    { tag: [tags.operator, tags.updateOperator, tags.logicOperator, tags.compareOperator], color: palette.operator },
    { tag: [tags.punctuation, tags.separator, tags.bracket], color: palette.punctuation },
    { tag: [tags.meta, tags.processingInstruction, tags.annotation], color: palette.decorator, fontStyle: 'italic' },
    { tag: [tags.invalid, tags.deleted], color: palette.invalid, textDecoration: 'underline wavy' },
    { tag: tags.inserted, color: palette.string }
  ]);
}

export function createEditorTheme(theme = 'dark') {
  const dark = theme !== 'light';
  const palette = palettes[dark ? 'dark' : 'light'];
  return [
    EditorView.theme({
      '&': { height: '100%', color: palette.text, backgroundColor: palette.background },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--code-font)', lineHeight: '1.55' },
      '.cm-content': { minHeight: '100%', padding: '12px 0 24px', caretColor: palette.cursor, fontSize: 'var(--editor-font-size, 16px)' },
      '.cm-line': { padding: '0 14px 0 9px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: palette.cursor },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: palette.selection },
      '.cm-activeLine': { backgroundColor: palette.active },
      '.cm-gutters': { color: palette.gutterText, backgroundColor: palette.gutter, borderRight: `1px solid ${palette.border}` },
      '.cm-activeLineGutter': { color: palette.text, backgroundColor: palette.active },
      '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer' },
      '.cm-foldPlaceholder': { color: palette.gutterText, backgroundColor: palette.active, border: `1px solid ${palette.border}` },
      '.cm-indentGuide': { backgroundImage: `linear-gradient(to right, ${palette.border} 0 1px, transparent 1px)`, backgroundRepeat: 'no-repeat' },
      '.cm-matchingBracket': { backgroundColor: palette.selection, outline: `1px solid ${palette.cursor}` },
      '.cm-nonmatchingBracket': { color: palette.invalid },
      '.cm-python-builtin': { color: `${palette.builtin} !important` },
      '.cm-python-decorator': { color: `${palette.decorator} !important`, fontStyle: 'italic' },
      '.cm-python-invalid': { color: `${palette.invalid} !important`, textDecoration: 'underline wavy' },
      '.cm-panels': { color: palette.text, backgroundColor: palette.gutter },
      '.cm-searchMatch': { backgroundColor: dark ? '#725b1f' : '#ffe28a', outline: '1px solid transparent' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: palette.selection },
      '.cm-tooltip': { color: palette.text, backgroundColor: palette.tooltip, border: `1px solid ${palette.border}`, borderRadius: '7px', boxShadow: '0 12px 32px rgba(0,0,0,.22)' },
      '.cm-tooltip-autocomplete > ul > li': { minHeight: '34px', padding: '6px 9px' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { color: palette.text, backgroundColor: palette.selection },
      '.cm-completionLabel': { fontFamily: 'var(--code-font)' },
      '.cm-completionDetail': { color: palette.gutterText, fontStyle: 'normal' },
      '.cm-mergeView .cm-changedLine, .cm-changedLine': { backgroundColor: 'var(--dsh-added)' },
      '.cm-mergeView .cm-changedText, .cm-changedText': { backgroundColor: 'var(--dsh-modified)' },
      '.cm-deletedChunk': { backgroundColor: 'var(--dsh-deleted)' }
    }, { dark }),
    syntaxHighlighting(highlightStyle(palette), { fallback: true })
  ];
}
