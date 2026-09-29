// Real Chromium checks for the production IDE shell at desktop/tablet sizes.
// Uses the bundled browser fallback, with no Provider prompt or credentials.
// Run: node tools/check-compact-layout.mjs [path/to/chrome-or-edge]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, '../.runtime-cache/ui-compact');
const chrome = [process.argv[2], process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path => path && existsSync(path));
assert.ok(chrome, 'Pass a Chromium/Chrome/Edge executable or set CHROME_PATH');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${decodeURIComponent(request.url.split('?')[0] === '/' ? '/index.html' : request.url.split('?')[0])}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Invalid path');
    response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const profile = await mkdtemp(join(tmpdir(), 'pythona-compact-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(done => setTimeout(done, ms));
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    if (child.exitCode !== null) throw new Error(`Browser exited: ${child.exitCode}`);
    await pause(100);
  }
  assert.ok(port, 'Browser debugging port must exist');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    const handler = pending.get(reply.id);
    if (!handler) return;
    pending.delete(reply.id); clearTimeout(handler.timer);
    reply.error ? handler.reject(reply.error) : handler.resolve(reply.result);
  };
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate('document.readyState === "complete" && document.querySelectorAll(".tree-row").length > 0')) break;
    await pause(100);
  }
  assert.ok(await evaluate('document.querySelectorAll(".tree-row").length > 0'), 'Production app must initialize the file tree');
  await mkdir(output, { recursive: true });
  const cases = [
    { width: 1440, height: 900, touch: false, theme: 'dark' },
    { width: 1280, height: 800, touch: true, theme: 'light' },
    { width: 960, height: 540, touch: true, theme: 'dark' },
    { width: 960, height: 320, touch: true, theme: 'light' }
  ];
  for (const viewport of cases) {
    await call('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.touch });
    await call('Emulation.setTouchEmulationEnabled', { enabled: viewport.touch });
    await evaluate(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    await evaluate(`if (document.querySelector('#app').dataset.theme !== '${viewport.theme}') document.querySelector('#theme-button').click(); new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    const layout = await evaluate(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }; };
      const first = document.querySelector('.tree-row');
      const buttons = [...document.querySelectorAll('.topbar .icon-button, .panel-heading .small-button, .dsh-heading .small-button, .editor-toolbar .small-button, .terminal-heading .small-button')].filter(button => button.getBoundingClientRect().width);
      return { coarse: matchMedia('(pointer: coarse)').matches, row: rect('.tree-row'), topbar: rect('.topbar'), editor: rect('.editor-surface'), tabs: rect('.editor-tabs'), body: rect('.body-grid'),
        controlsFit: buttons.every(button => { const own = button.getBoundingClientRect(); const parent = button.parentElement.getBoundingClientRect(); return own.top >= parent.top - 1 && own.bottom <= parent.bottom + 1; }),
        rowTarget: document.elementFromPoint(first.getBoundingClientRect().x + 10, first.getBoundingClientRect().y + 12)?.closest('.tree-row') === first,
        textColor: getComputedStyle(first).color, background: getComputedStyle(document.querySelector('#app')).backgroundColor };
    })()`);
    assert.equal(layout.coarse, viewport.touch, 'Pointer emulation must match the target device');
    assert.equal(layout.row.height, viewport.touch ? 28 : 26, 'Project rows must stay compact on touch screens');
    assert.ok(layout.controlsFit, 'Toolbar controls must stay inside their allocated row');
    assert.ok(layout.rowTarget, 'The full tree row must remain a pointer target');
    assert.ok(layout.editor.height > 50, 'Editor must retain usable space with the keyboard/short viewport');
    assert.ok(layout.body.right <= viewport.width + 1, 'Workspace shell must not overflow horizontally');
    assert.ok(layout.tabs.height <= 36, 'Editor tabs must stay compact');
    assert.notEqual(layout.textColor, layout.background, 'Theme must retain visible file labels');
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, `compact-${viewport.width}x${viewport.height}-${viewport.theme}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`PASS compact layout ${viewport.width}x${viewport.height} ${viewport.touch ? 'touch' : 'mouse'} ${viewport.theme}; tree=${layout.row.height}px tabs=${layout.tabs.height}px`);
  }
  console.log(`Screenshots: ${output}`);
} finally {
  socket?.close();
  child.kill();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
