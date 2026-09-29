import { pythonLanguage } from '@codemirror/lang-python';
import { syntaxTree } from '@codemirror/language';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { pythonBuiltins } from './python-completions.js';

const pythonBuiltinSet = new Set(pythonBuiltins);

function isInsideSyntaxNode(node, name) {
  for (let current = node?.parent; current; current = current.parent) {
    if (current.name === name) return true;
  }
  return false;
}

function normalizedErrorRange(from, to, doc) {
  if (to > from) return { from, to };
  const line = doc.lineAt(Math.max(0, Math.min(from, doc.length)));
  if (from < line.to) return { from, to: from + 1 };
  if (from > line.from) return { from: from - 1, to: from };
  return null;
}

function collectPythonHighlights(tree, doc, ranges = null) {
  const results = [];
  const seen = new Set();
  const scan = (from, to) => tree.iterate({
    from,
    to,
    enter(reference) {
      let kind = null;
      let tokenFrom = reference.from;
      let tokenTo = reference.to;
      if (reference.name === '⚠') {
        kind = 'invalid';
        const normalized = normalizedErrorRange(tokenFrom, tokenTo, doc);
        if (!normalized) return;
        ({ from: tokenFrom, to: tokenTo } = normalized);
      } else if ((reference.name === 'VariableName' || reference.name === 'PropertyName')
        && isInsideSyntaxNode(reference.node, 'Decorator')) {
        kind = 'decorator';
      } else if (reference.name === 'VariableName'
        && pythonBuiltinSet.has(doc.sliceString(tokenFrom, tokenTo))) {
        kind = 'builtin';
      }
      if (!kind || tokenTo <= tokenFrom) return;
      const key = `${kind}:${tokenFrom}:${tokenTo}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ kind, from: tokenFrom, to: tokenTo });
    }
  });
  if (ranges?.length) ranges.forEach((range) => scan(range.from, range.to));
  else scan(0, doc.length);
  return results;
}

/** Exposed for parser-level regression tests without requiring a browser DOM. */
export function classifyPythonHighlightTokens(source) {
  const text = String(source ?? '');
  const doc = {
    length: text.length,
    sliceString: (from, to) => text.slice(from, to),
    lineAt(position) {
      const before = text.lastIndexOf('\n', Math.max(0, position - 1));
      const after = text.indexOf('\n', position);
      return { from: before + 1, to: after < 0 ? text.length : after };
    }
  };
  return collectPythonHighlights(pythonLanguage.parser.parse(text), doc)
    .map((entry) => ({ ...entry, text: text.slice(entry.from, entry.to) }));
}

function buildDecorations(view) {
  const ranges = collectPythonHighlights(syntaxTree(view.state), view.state.doc, view.visibleRanges);
  return Decoration.set(ranges.map((range) => Decoration.mark({
    class: `cm-python-${range.kind}`
  }).range(range.from, range.to)), true);
}

/** Adds semantic color classes missing from the Python Lezer tag set. */
export const pythonTokenHighlighting = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });
