// Production-bundle DSH context/composer integration checks in Chromium.
// Uses only the offline preview Provider, no credentials or device.
// Run: node tools/check-dsh-context-ui.mjs [path/to/chrome-or-edge]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

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
const profile = await mkdtemp(join(tmpdir(), 'pythona-context-'));
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

  const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await pause(40);
    }
    const ui = await evaluate(`({phase:document.querySelector('#dsh-turn-status')?.textContent,toast:document.querySelector('#toast')?.textContent,assistant:[...document.querySelectorAll('#dsh-stream .assistant')].map(node=>node.textContent).slice(-3)})`);
    throw new Error(`Timed out: ${label}; ${JSON.stringify(ui)}`);
  };
  await evaluate(`document.querySelector('[data-dsh-tab="chat"]').click(); document.querySelector('#dsh-context').open=true;`);
  await waitFor(`document.querySelector('#dsh-context-files').textContent.includes('src/train.py')`, 'automatic current file context');
  const initial = await evaluate(`({label:document.querySelector('#dsh-context-label').textContent,
    preview:document.querySelector('#dsh-context-files pre').textContent,
    usage:document.querySelector('#dsh-context-usage').textContent,
    currentChip:[...document.querySelectorAll('#dsh-attachment-chips button')].some(button=>button.textContent.includes('当前 · train.py'))})`);
  assert.ok(initial.label.includes('待发送预览'));
  assert.ok(initial.preview.includes('TinyClassifier'));
  assert.equal(initial.usage, '用量待返回');
  assert.equal(initial.currentChip, true);
  console.log('PASS expanded context automatically previews the current buffer without inventing token usage');

  await evaluate(`document.querySelector('#dsh-attach-file').click(); const input=document.querySelector('#dsh-attach-search'); input.value='test_checkpoint'; input.dispatchEvent(new Event('input',{bubbles:true}));`);
  const filtered = await evaluate(`[...document.querySelectorAll('#dsh-attach-files button')].map(button=>button.textContent)`);
  assert.deepEqual(filtered, ['＋ tests/test_checkpoint.py']);
  await evaluate(`document.querySelector('#dsh-attach-files button').click()`);
  await waitFor(`document.querySelector('#dsh-context-files').textContent.includes('tests/test_checkpoint.py')`, 'attached file in outgoing context');
  assert.equal(await evaluate(`[...document.querySelectorAll('#dsh-attachment-chips button')].some(button=>button.textContent==='tests/test_checkpoint.py ×')`), true);
  await evaluate(`[...document.querySelectorAll('#dsh-attachment-chips button')].find(button=>button.textContent==='tests/test_checkpoint.py ×').click()`);
  await waitFor(`![...document.querySelectorAll('#dsh-attachment-chips button')].some(button=>button.textContent.includes('test_checkpoint'))`, 'attachment removal');
  console.log('PASS file picker search, attaching a file, context refresh and removing the chip');

  // Put hostile-looking text in an unsaved editor buffer via real input events.
  // The preview must show it literally, and redact a deliberately fake key.
  await evaluate(`document.querySelector('#dsh-attach-picker').hidden=true; document.querySelector('.cm-content').focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  const fakeKey = 'sk-' + 'x'.repeat(32);
  const buffer = `# <img src=x onerror="window.contextPwned=true">\n# ${fakeKey}\ndef train() -> None:\n    print("ready", model)\n`;
  await call('Input.insertText', { text: buffer });
  await evaluate(`document.querySelector('#dsh-context-refresh').click()`);
  await waitFor(`document.querySelector('#dsh-context-files pre').textContent.includes('<img')`, 'preview reflects unsaved editor text');
  const escaped = await evaluate(`({text:document.querySelector('#dsh-context-files pre').textContent,
    images:document.querySelector('#dsh-context-files').querySelectorAll('img,script,iframe').length,
    executed:Boolean(window.contextPwned)})`);
  assert.ok(escaped.text.includes('<img src=x onerror="window.contextPwned=true">'));
  assert.ok(escaped.text.includes('[REDACTED:openai-key]'));
  assert.ok(!escaped.text.includes(fakeKey));
  assert.equal(escaped.images, 0); assert.equal(escaped.executed, false);
  console.log('PASS unsaved context is current, credential-redacted and HTML-escaped');

  await evaluate(`document.querySelector('#save-button').click()`);
  await pause(100);
  await evaluate(`document.querySelector('#dsh-input').value='Preview a checkpoint change'; document.querySelector('#dsh-form').requestSubmit()`);
  await waitFor(`document.querySelector('#dsh-patch-approval').textContent.includes('补丁等待确认')`, 'offline preview creates approval');
  await waitFor(`document.querySelector('#dsh-send').disabled===false`, 'preview finishes');
  const approval = await evaluate(`({approval:document.querySelector('#dsh-patch-approval').childElementCount,
    sent:document.querySelector('#dsh-context-label').textContent,phase:document.querySelector('#dsh-turn-status').textContent,
    actions:[...document.querySelectorAll('#dsh-patch-approval button')].map(button=>button.textContent)})`);
  assert.equal(approval.approval, 1); assert.ok(approval.sent.includes('上次已发送')); assert.equal(approval.phase, '已完成');
  assert.deepEqual(approval.actions, ['拒绝', '应用补丁']);
  console.log('PASS production preview retains a separate actionable patch approval after streamed rows');

  // Start the next request while an unapproved card exists, then use Stop before
  // the asynchronous context build/preview completes. No old card may survive.
  await evaluate(`document.querySelector('#dsh-input').value='Another change'; document.querySelector('#dsh-form').requestSubmit(); document.querySelector('#dsh-cancel').click()`);
  await waitFor(`!document.querySelector('#dsh-send').disabled && document.querySelector('#dsh-turn-status').textContent==='已停止'`, 'cancellation terminal UI');
  assert.equal(await evaluate(`document.querySelector('#dsh-patch-approval').childElementCount`), 0);
  assert.equal(await evaluate(`document.querySelector('#dsh-stream').textContent.includes('已请求停止 DSH')`), true);
  await pause(150);
  assert.equal(await evaluate(`document.querySelector('#dsh-patch-approval').childElementCount`), 0);
  console.log('PASS Stop clears a previous pending approval and aborted preview cannot resurrect it');

  await evaluate(`document.querySelector('#clear-dsh').click()`);
  await waitFor(`document.querySelector('#dsh-turn-status').textContent==='就绪'`, 'clear resets turn state');
  assert.equal(await evaluate(`document.querySelector('#dsh-patch-approval').childElementCount`), 0);
  assert.equal(await evaluate(`document.querySelector('#dsh-context-files').childElementCount`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('#dsh-stream article').length`), 1);
  console.log('PASS Clear resets turn, context and approvals without changing the editor buffer');

  await call('Emulation.setDeviceMetricsOverride', { width: 960, height: 320, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true });
  await evaluate(`document.querySelector('#app').classList.add('dsh-overlay'); document.querySelector('#dsh-context').open=true; document.querySelector('#dsh-context-refresh').click(); document.querySelector('#dsh-attach-file').click();`);
  await waitFor(`document.querySelector('#dsh-context-files pre')!==null`, 'short-screen context loaded');
  const short = await evaluate(`(() => {
    const prompt=document.querySelector('#dsh-form');prompt.scrollTop=prompt.scrollHeight;
    const send=document.querySelector('#dsh-send'), stop=document.querySelector('#dsh-cancel');
    const rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right};};
    const hit=node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===node;};
    return {prompt:rect(prompt),panel:rect(document.querySelector('#dsh-panel')),send:rect(send),stop:rect(stop),
      scrollable:prompt.scrollHeight>prompt.clientHeight,sendHit:hit(send),stopHit:hit(stop),contextOpen:document.querySelector('#dsh-context').open,
      pickerOpen:!document.querySelector('#dsh-attach-picker').hidden};
  })()`);
  assert.equal(short.contextOpen, true); assert.equal(short.pickerOpen, true); assert.equal(short.scrollable, true);
  assert.ok(short.prompt.height > 40);
  assert.ok(short.send.top >= short.prompt.top - 1 && short.send.bottom <= Math.min(320, short.prompt.bottom) + 1, JSON.stringify(short));
  assert.ok(short.stop.top >= short.prompt.top - 1 && short.stop.bottom <= Math.min(320, short.prompt.bottom) + 1, JSON.stringify(short));
  assert.equal(short.sendHit, true, 'Send remains reachable after scrolling the composer');
  assert.equal(short.stopHit, true, 'Stop remains reachable after scrolling the composer');
  console.log('PASS 960×320 touch viewport: open context + picker composer scrolls to visible, hittable Send/Stop');
} finally {
  socket?.close(); child.kill(); server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

