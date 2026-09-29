// Exercise production inline scheduling against real Window timers. Node fake
// clocks cannot catch WebView/Chromium's "Illegal invocation" receiver checks.
// No Provider, credentials or device is used; the native broker is a local stub.
// Run: node tools/check-inline-completion-browser.mjs [path/to/chrome-or-edge]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = [process.argv[2], process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path => path && existsSync(path));
assert.ok(chrome, 'Pass a Chromium/Chrome/Edge executable or set CHROME_PATH');
const files = new Map(await Promise.all(['inline-completion-client.js', 'inline-completion-controller.js', 'context-indexer.js']
  .map(async name => ['/' + name, await readFile(new URL('../src/core/' + name, import.meta.url), 'utf8')])));
const html = `<!doctype html><meta charset="utf-8"><script type="module">
import {InlineCompletionClient} from '/inline-completion-client.js';
import {InlineCompletionController} from '/inline-completion-controller.js';
window.errors=[]; window.addEventListener('error',event=>errors.push(event.message));
window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
window.calls=[]; window.suggestions=[]; window.states=[]; window.listeners=new Set(); window.hold=false;
window.snapshot={path:'main.py',uri:'pythona://default/main.py',workspaceId:'default',epoch:1,bufferVersion:1,
 cursor:4,selection:{anchor:4,head:4},selectionVersion:1,modelSelectionVersion:1,generation:1,
 text:'foo.\\n',codeUpload:true,focused:true};
window.broker={available:true,subscribe:(_channel,fn)=>{listeners.add(fn);return()=>listeners.delete(fn);},
 request:async(channel,method,payload)=>{calls.push({channel,method,payload,at:performance.now()});
  if(method==='inlineComplete'&&!hold)globalThis.setTimeout(()=>listeners.forEach(fn=>fn({...payload,
   kind:'inlineCompletion',capabilityVersion:1,status:'completed',text:'bar()'})),25);
  return method==='inlineComplete'?{accepted:true,completionId:payload.completionId}:{cancelled:true};}};
window.client=new InlineCompletionClient(broker); client.setCapabilities({version:1,available:true});
window.controller=new InlineCompletionController({client,getSnapshot:()=>snapshot,
 getSelection:()=>({provider:'fixture',model:'mock',officialMode:true,modelSelectionVersion:1,generation:1}),
 onSuggestion:value=>suggestions.push(value),onState:value=>states.push(value)});
window.pause=ms=>new Promise(resolve=>globalThis.setTimeout(resolve,ms)); window.ready=true;
</script>`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', files.has(request.url) ? 'text/javascript' : 'text/html; charset=utf-8');
  response.end(files.get(request.url) || html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'pythona-inline-browser-'));
const child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
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
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(); let sequence = 0;
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data), handler = pending.get(reply.id); if (!handler) return;
    pending.delete(reply.id); clearTimeout(handler.timer);
    reply.error ? handler.reject(reply.error) : handler.resolve(reply.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; attempt < 100 && !await evaluate('Boolean(window.ready)'); attempt++) await pause(50);
  assert.equal(await evaluate('Boolean(window.ready)'), true);
  const idle = await evaluate(`(async()=>{const started=performance.now();controller.schedule();controller.schedule();
    await pause(250);const early=calls.length;await pause(750);return{early,calls:calls.length,
    latency:calls[0]?.at-started,text:suggestions.filter(Boolean).at(-1)?.text,errors};})()`);
  assert.equal(idle.early, 0); assert.equal(idle.calls, 1); assert.ok(idle.latency >= 750);
  assert.equal(idle.text, 'bar()'); assert.deepEqual(idle.errors, []);
  console.log('PASS real Window timers: 800ms idle → native-capable client → final AI suggestion');
  const cancelled = await evaluate(`(async()=>{snapshot.bufferVersion++;controller.invalidate('edit');controller.schedule();
    await pause(50);snapshot.focused=false;controller.invalidate('blur');await pause(3100);
    return{calls:calls.length,visible:suggestions.at(-1),timer:controller.timer,errors};})()`);
  assert.equal(cancelled.calls, 1); assert.equal(cancelled.visible, null); assert.equal(cancelled.timer, null); assert.deepEqual(cancelled.errors, []);
  console.log('PASS real Window clearTimeout: edit/blur cancels the scheduled request without invocation errors');
  const inflight = await evaluate(`(async()=>{snapshot.focused=true;snapshot.bufferVersion++;hold=true;controller.schedule();
    await pause(850);const request=calls.filter(x=>x.method==='inlineComplete').at(-1).payload;
    controller.invalidate('cursor');listeners.forEach(fn=>fn({...request,kind:'inlineCompletion',capabilityVersion:1,status:'completed',text:'stale'}));
    await pause(10);return{requests:calls.filter(x=>x.method==='inlineComplete').length,
    cancellations:calls.filter(x=>x.method==='inlineCancel').length,last:suggestions.at(-1),errors};})()`);
  assert.equal(inflight.requests, 2); assert.equal(inflight.cancellations, 1); assert.equal(inflight.last, null); assert.deepEqual(inflight.errors, []);
  console.log('PASS real browser in-flight cancellation rejects the late response');
  await evaluate('controller.dispose()');
} finally {
  socket?.close(); child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
