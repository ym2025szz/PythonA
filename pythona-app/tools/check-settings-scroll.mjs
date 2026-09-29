// Real Chromium layout/input regression, using the production dialog and CSS.
// Run: node tools/check-settings-scroll.mjs [path/to/chrome-or-edge]
// No API credentials, Provider requests, bundled app or external test dependency.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = [process.argv[2], process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path => path && existsSync(path));
if (!chrome) throw new Error('Pass a Chrome/Chromium/Edge executable path or set CHROME_PATH.');
const source = await readFile(join(root, 'index.html'), 'utf8');
const dialog = source.match(/<dialog id="settings-dialog"[\s\S]*?<\/dialog>/)?.[0];
assert.ok(dialog, 'Production settings dialog must exist');
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/styles.css">${dialog}`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
      return;
    }
    const path = resolve(root, `.${decodeURIComponent(request.url.split('?')[0])}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Invalid path');
    if (path.endsWith('.css')) response.setHeader('Content-Type', 'text/css');
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const profile = await mkdtemp(join(tmpdir(), 'pythona-scroll-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    if (child.exitCode !== null) throw new Error(`Browser exited: ${child.exitCode}`);
    await pause(100);
  }
  assert.ok(port, 'Browser must expose its debugging port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = reject; });
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    const handler = pending.get(reply.id);
    if (handler) { pending.delete(reply.id); clearTimeout(handler.timer); reply.error ? handler.reject(reply.error) : handler.resolve(reply.result); }
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
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('document.readyState === "complete" && !!document.querySelector("#settings-dialog")')) break;
    await pause(50);
  }
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#settings-dialog")).display'), 'none', 'Closed settings remain hidden');
  await evaluate(`document.querySelectorAll('[data-settings-section]').forEach(section => section.hidden = section.dataset.settingsSection !== 'dsh');
    document.querySelector('.compat-provider-details').open = true;
    document.querySelector('#settings-dialog').showModal();`);

  const cases = [{ width: 1280, height: 800, touch: false }, { width: 960, height: 540, touch: true }, { width: 960, height: 320, touch: true }];
  for (const viewport of cases) {
    await call('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.touch });
    await call('Emulation.setTouchEmulationEnabled', { enabled: viewport.touch });
    await evaluate(`document.querySelector('.settings-content').scrollTop = 0; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));`);
    const before = await evaluate(`(() => {
      const dialog = document.querySelector('#settings-dialog').getBoundingClientRect();
      const content = document.querySelector('.settings-content');
      const rect = content.getBoundingClientRect();
      const footer = document.querySelector('.dialog-footer').getBoundingClientRect();
      return { top: dialog.top, bottom: dialog.bottom, contentHeight: content.clientHeight, scrollHeight: content.scrollHeight,
        footerTop: footer.top, x: rect.right - 28, y: rect.top + rect.height * .72, gestureDistance: Math.min(90, rect.height * .42) };
    })()`);
    assert.ok(before.top >= 0 && before.bottom <= viewport.height + 1, 'Dialog must fit the visible viewport');
    assert.ok(before.contentHeight > 60 && before.scrollHeight > before.contentHeight, 'Provider content must have a bounded scroll viewport');
    if (viewport.touch) {
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: before.x, y: before.y }] });
      for (let step = 1; step <= 8; step++) {
        await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: before.x, y: before.y - before.gestureDistance * step / 8 }] });
        await pause(20);
      }
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: 160 });
    }
    await pause(300);
    assert.ok(await evaluate('document.querySelector(".settings-content").scrollTop > 0'), `${viewport.touch ? 'Touch' : 'Wheel'} input must scroll Provider settings`);
    const after = await evaluate(`(() => {
      const save = document.querySelector('#save-provider');
      save.scrollIntoView({ block: 'center' });
      const rect = save.getBoundingClientRect();
      const content = document.querySelector('.settings-content').getBoundingClientRect();
      const footer = document.querySelector('.dialog-footer').getBoundingClientRect();
      const apply = document.querySelector('#apply-settings');
      const applyRect = apply.getBoundingClientRect();
      return { saveVisible: rect.top >= content.top && rect.bottom <= content.bottom,
        saveHittable: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === save,
        footerTop: footer.top, applyHittable: document.elementFromPoint(applyRect.x + applyRect.width / 2, applyRect.y + applyRect.height / 2) === apply };
    })()`);
    assert.ok(after.saveVisible && after.saveHittable, 'Expanded compatibility Provider save button must be reachable');
    assert.equal(after.footerTop, before.footerTop, 'Footer must remain fixed while the body scrolls');
    assert.ok(after.applyHittable, 'Apply action must remain visible and usable');
    console.log(`PASS settings scroll ${viewport.width}x${viewport.height} ${viewport.touch ? 'touch' : 'wheel'}`);
  }
  await evaluate('document.querySelector("#settings-dialog").close()');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#settings-dialog")).display'), 'none', 'Closing the dialog must hide it');
} finally {
  socket?.close();
  child.kill();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
