export function computeDshLayout({ width, dshOpen }) {
  const narrow = Number(width) <= 1120;
  const fullDsh = Boolean(dshOpen);
  return { narrow, fullDsh, overlayDsh: fullDsh && narrow };
}

export function withoutDiagnosticsForPath(diagnostics, path) {
  if (!path) return Array.from(diagnostics || []);
  return Array.from(diagnostics || []).filter((item) => item?.path !== path);
}

export function normalizeTerminalTab(tab) {
  return ['terminal', 'run', 'tests', 'problems'].includes(tab) ? tab : 'terminal';
}
