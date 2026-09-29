import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeDshLayout,
  normalizeTerminalTab,
  withoutDiagnosticsForPath
} from '../src/core/ui-policy.js';

test('narrow landscape keeps an expandable overlay DSH', () => {
  assert.deepEqual(
    computeDshLayout({ width: 960, dshOpen: true, mode: 'landscape' }),
    { narrow: true, fullDsh: true, overlayDsh: true }
  );
  assert.equal(computeDshLayout({ width: 960, dshOpen: false, mode: 'landscape' }).fullDsh, false);
  assert.equal(computeDshLayout({ width: 960, dshOpen: true, mode: 'compact' }).fullDsh, true);
});

test('closing a language document removes only its diagnostics', () => {
  const remaining = withoutDiagnosticsForPath([
    { path: 'old.py', text: 'old' },
    { path: 'new.py', text: 'new' }
  ], 'old.py');
  assert.deepEqual(remaining, [{ path: 'new.py', text: 'new' }]);
});

test('bottom panel exposes only implemented terminal tabs', () => {
  assert.equal(normalizeTerminalTab('problems'), 'problems');
  assert.equal(normalizeTerminalTab('run'), 'run');
  assert.equal(normalizeTerminalTab('debug'), 'terminal');
});
