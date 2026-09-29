// Native Chromium tests for the standalone production DSH stream renderer.
// No Provider, credentials, device or external network is involved.
// Run: node tools/check-dsh-stream-view.mjs [path/to/chrome-or-edge]
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
const source = await readFile(new URL('../src/ui/dsh-stream-view.js', import.meta.url), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>
#stream { width:450px; height:300px; overflow:auto; overflow-anchor:none; border:1px solid; }
.dsh-message {padding:8px; border-bottom:1px solid #bbb; } p {margin:0 0 8px; white-space:pre-wrap; overflow-wrap:anywhere;}
pre {white-space:pre-wrap;} .dsh-message-label {height:20px;} .dsh-card-status {margin-left:16px;}
[hidden] {display:none!important;} .dsh-history-notice {height:30px;}
</style><div id="stream"><div id="tail">External approval host</div></div><button id="latest">Latest</button>
<script type="module">import {DshStreamView} from '/view.js';
window.stream = document.querySelector('#stream'); window.latest = document.querySelector('#latest');
window.view = new DshStreamView(stream,{jumpButton:latest,maxRows:32,maxText:4096});
window.ready=true;</script>`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/view.js' ? 'text/javascript' : 'text/html; charset=utf-8');
  response.end(request.url === '/view.js' ? source : html);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const profile = await mkdtemp(join(tmpdir(), 'pythona-stream-'));
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
  const pending = new Map(); let sequence = 0;
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data); const handler = pending.get(reply.id);
    if (!handler) return;
    pending.delete(reply.id); clearTimeout(handler.timer);
    reply.error ? handler.reject(reply.error) : handler.resolve(reply.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; attempt < 100 && !await evaluate('Boolean(window.ready)'); attempt++) await pause(100);
  assert.equal(await evaluate('Boolean(window.ready)'), true);

  const incremental = await evaluate(`(() => {
    window.messages=[{id:'answer',role:'assistant',text:'First',streaming:true}]; view.render(messages);
    const row=stream.querySelector('article'), paragraph=row.querySelector('p'), text=paragraph.firstChild;
    for(let i=0;i<100;i++){messages[0].text+=' delta'; view.render(messages);}
    return {sameRow:row===stream.querySelector('article'),sameParagraph:paragraph===row.querySelector('p'),
      sameText:text===paragraph.firstChild,text:text.data,tail:document.querySelector('#tail').isConnected,
      streaming:row.classList.contains('is-streaming')};
  })()`);
  assert.equal(incremental.sameRow, true); assert.equal(incremental.sameParagraph, true); assert.equal(incremental.sameText, true);
  assert.equal(incremental.text, 'First' + ' delta'.repeat(100)); assert.equal(incremental.tail, true); assert.equal(incremental.streaming, true);
  console.log('PASS 100 growing deltas retain row, paragraph, text node and external approval host');

  const structured = await evaluate(String.raw`(() => {
    messages=[{id:'thought',role:'assistant',kind:'thought',text:'Provider reasoning',streaming:true},
      {id:'tool',role:'system',kind:'tool',tool:{title:'read_file',status:'running',locations:[{path:'src/main.py',line:4}]},text:'Reading workspace'},
      {id:'code',role:'assistant',text:'\u0060\u0060\u0060python\nprint("hel',streaming:true}];view.render(messages);
    const thought=stream.querySelector('.dsh-thought-details'),tool=stream.querySelector('.dsh-tool-details');
    const initiallyClosed=!thought.open&&!tool.open; thought.open=true;tool.open=true;
    const code=stream.querySelector('pre code'),content=code.firstChild;
    messages[0].text+=' continues';messages[1].tool.status='completed';messages[2].text='\u0060\u0060\u0060python\nprint("hello")\n\u0060\u0060\u0060';
    messages.forEach(message=>message.streaming=false);view.render(messages);
    return {initiallyClosed,thoughtOpen:thought.open,toolOpen:tool.open,
      sameThought:thought===stream.querySelector('.dsh-thought-details'),status:tool.querySelector('.dsh-card-status').textContent,
      sameCode:code===stream.querySelector('pre code')&&content===code.firstChild,code:code.textContent,streaming:stream.querySelectorAll('.is-streaming').length,
      location:tool.querySelector('.dsh-tool-locations').textContent};
  })()`);
  assert.equal(structured.initiallyClosed, true); assert.equal(structured.thoughtOpen, true); assert.equal(structured.toolOpen, true);
  assert.equal(structured.sameThought, true); assert.equal(structured.sameCode, true); assert.equal(structured.code, 'print("hello")');
  assert.equal(structured.status, '已完成'); assert.equal(structured.streaming, 0); assert.equal(structured.location, 'src/main.py:4');
  console.log('PASS streamed code and structured tool/thought details retain open state and completion status');

  const safe = await evaluate(String.raw`(() => {
    messages=[{id:'unsafe',role:'assistant',text:'<img src=x onerror="window.pwned=true"> <script>window.pwned=true<\\/script>\n\n[evil](javascript:alert) [local](file:///data/key) [link](https://example.com/a)\n\n- **bold**\n- \u0060code\u0060'}];view.render(messages);
    return {dangerous:stream.querySelectorAll('img,script,iframe,input').length,pwned:Boolean(window.pwned),
      anchors:[...stream.querySelectorAll('a')].map(a=>({href:a.href,rel:a.rel})),literal:stream.textContent.includes('<img'),
      strong:stream.querySelector('strong').textContent,code:stream.querySelector('li code').textContent};
  })()`);
  assert.equal(safe.dangerous, 0); assert.equal(safe.pwned, false); assert.equal(safe.literal, true);
  assert.deepEqual(safe.anchors, [{ href: 'https://example.com/a', rel: 'noopener noreferrer' }]);
  assert.equal(safe.strong, 'bold'); assert.equal(safe.code, 'code');
  console.log('PASS model HTML, scripts and unsafe URLs remain inert; safe Markdown renders');

  const reading = await evaluate(`(() => {
    messages=Array.from({length:32},(_,i)=>({id:'m'+i,role:'assistant',text:('Message '+i+' text. ').repeat(15)}));view.render(messages);
    stream.scrollTop=500;stream.dispatchEvent(new Event('scroll'));const before=stream.scrollTop;
    const anchor=[...stream.querySelectorAll('article')].find(row=>row.getBoundingClientRect().bottom>stream.getBoundingClientRect().top);
    const anchorTop=anchor.getBoundingClientRect().top;
    messages.at(-1).text+=' latest '.repeat(100);view.render(messages);
    const afterDelta=stream.scrollTop,unfollow=!view.following&&!latest.hidden;
    messages.push({id:'m32',role:'assistant',text:'New message'});view.render(messages);
    const anchored=Math.abs(anchor.getBoundingClientRect().top-anchorTop)<2;
    latest.click();return {before,afterDelta,unfollow,anchored,following:view.following,hidden:latest.hidden,
      atBottom:stream.scrollHeight-stream.scrollTop-stream.clientHeight<2};
  })()`);
  assert.equal(reading.afterDelta, reading.before); assert.equal(reading.unfollow, true); assert.equal(reading.anchored, true);
  assert.equal(reading.following, true); assert.equal(reading.hidden, true); assert.equal(reading.atBottom, true);
  console.log('PASS reading position survives new deltas and bounded-history eviction; jump latest resumes following');

  const bounded = await evaluate(`(() => {
    const result=view.render(Array.from({length:1000},(_,i)=>({id:'bounded'+i,role:'assistant',text:'x'.repeat(6000)})));
    const rows=stream.querySelectorAll('article').length,notice=stream.querySelector('.dsh-history-notice').textContent;
    const maxText=Math.max(...[...stream.querySelectorAll('.dsh-message-content')].map(node=>node.textContent.length));
    view.dispose();return {result,rows,notice,maxText,remaining:stream.querySelectorAll('article').length,tail:document.querySelector('#tail').isConnected};
  })()`);
  assert.equal(bounded.rows, 32); assert.equal(bounded.result.omittedRows, 968); assert.ok(bounded.notice.includes('968'));
  assert.ok(bounded.maxText < 4150); assert.equal(bounded.remaining, 0); assert.equal(bounded.tail, true);
  console.log('PASS 1000 messages stay bounded to 32 DOM rows and 4096 display characters; dispose preserves external UI');
} finally {
  socket?.close(); child.kill(); server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
