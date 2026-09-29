import { performance } from 'node:perf_hooks';
import { createWorkspaceCompletionSource } from '../src/editor/python-completions.js';

const files = Array.from({ length: 1000 }, (_, index) => ({
  path: `pkg/module_${index}.py`,
  revision: 1,
  content: `def function_${index}(value):\n    return value\n`
}));
const longPrefix = Array.from({ length: 49_900 }, (_, index) => `# line ${index}`).join('\n');
const symbols = Array.from({ length: 100 }, (_, index) => `symbol_${index} = ${index}`).join('\n');
let activeText = `${longPrefix}\n${symbols}\nsym`;
files[0] = { ...files[0], content: activeText, bufferVersion: 1 };

const source = createWorkspaceCompletionSource({ getFiles: () => files });
const context = {
  explicit: true,
  get pos() { return activeText.length; },
  matchBefore(pattern) {
    const match = activeText.slice(0, this.pos).match(pattern);
    return match ? { from: this.pos - match[0].length, to: this.pos, text: match[0] } : null;
  }
};

// Warm the 1000-file index before measuring repeated edits of the 50k-line
// active document.
source(context);
const durations = [];
for (let iteration = 0; iteration < 30; iteration += 1) {
  activeText = `${longPrefix}\n${symbols}\n# edit ${iteration}\nsym`;
  files[0] = { ...files[0], content: activeText, bufferVersion: iteration + 2 };
  const started = performance.now();
  const result = source(context);
  durations.push(performance.now() - started);
  if (!result.options.some((item) => item.label === 'symbol_99')) {
    throw new Error('completion benchmark lost an active-file symbol');
  }
}

durations.sort((left, right) => left - right);
const percentile = (value) => durations[Math.min(
  durations.length - 1,
  Math.ceil((value / 100) * durations.length) - 1
)];
const report = {
  files: files.length,
  activeLines: activeText.split('\n').length,
  samples: durations.length,
  p50Millis: Number(percentile(50).toFixed(2)),
  p95Millis: Number(percentile(95).toFixed(2)),
  maxMillis: Number(durations.at(-1).toFixed(2))
};
console.log(JSON.stringify(report));
if (report.p95Millis >= 60) process.exitCode = 1;

