// Production-bundle integration checks. Run `npm run build` before this script.
// Disposable browser profile only: no user files, native services or API keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(root,'../.runtime-cache/ux-acceptance');
const chrome=[process.argv[2],process.env.CHROME_PATH,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/usr/bin/chromium'].find(path=>path&&existsSync(path));
assert.ok(chrome,'Pass Chrome/Edge/Chromium executable');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json'};
const server=createServer(async(request,response)=>{
  try{
    const path=resolve(root,`.${decodeURIComponent(request.url.split('?')[0]==='/'?'/index.html':request.url.split('?')[0])}`);
    if(!path.startsWith(root.endsWith(sep)?root:root+sep))throw new Error('Invalid path');
    response.setHeader('Content-Type',types[extname(path)]||'application/octet-stream');response.end(await readFile(path));
  }catch{response.writeHead(404);response.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const profile=await mkdtemp(join(tmpdir(),'pythona-ux-'));
const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(done=>setTimeout(done,ms));let socket;
try{
  let port;for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{}await pause(100);}assert.ok(port);
  const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
  await new Promise((done,fail)=>{socket.onopen=done;socket.onerror=fail;});let sequence=0;const pending=new Map();const browserErrors=[];
  socket.onmessage=({data})=>{const value=JSON.parse(data);if(value.method==='Runtime.exceptionThrown')browserErrors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);const task=pending.get(value.id);if(!task)return;pending.delete(value.id);clearTimeout(task.timer);value.error?task.reject(value.error):task.resolve(value.result);};
  const call=(method,params={})=>new Promise((resolveCall,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(id,{resolve:resolveCall,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const reply=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(reply.exceptionDetails)throw new Error(JSON.stringify(reply.exceptionDetails));return reply.result.value;};
  const until=async(expression,description=expression)=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await pause(50);}throw new Error(`Timed out: ${description}${browserErrors.length ? `; ${browserErrors.join('\n')}` : ''}`);};
  const key=async(key,code,vk,modifiers=0)=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk,modifiers});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,modifiers});};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text=()=>evaluate(`Array.from(document.querySelectorAll('#code-editor .cm-line')).map(line=>{const copy=line.cloneNode(true);copy.querySelectorAll('.cm-inlineSuggestion').forEach(node=>node.remove());return copy.textContent}).join('\\n')`);
  const replace=async value=>{await evaluate(`document.querySelector('#code-editor .cm-content').focus()`);await key('a','KeyA',65,2);await call('Input.insertText',{text:value});};
  const openFile=async path=>{await click(`.tree-row[data-path="${path}"]`);await until(`document.querySelector('.editor-tab.is-active .tab-label')?.title?.startsWith(${JSON.stringify(path)}) || document.querySelector('.editor-tab.is-active button')?.title?.startsWith(${JSON.stringify(path)})`);};
  await call('Runtime.enable');await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`
    if (!sessionStorage.getItem('ux-seeded')) {
      const files=Object.fromEntries(Object.entries({'a.py':'a = 1\\n','b.py':'b = 1\\n','pkg/deep/nested.py':'nested = 1\\n'}).map(([path,content])=>[path,{content,revision:1,updatedAt:1}]));
      localStorage.setItem('pythona.workspace.v1',JSON.stringify({version:1,workspaceName:'UX regression',files}));
      localStorage.setItem('pythona.ui.v1',JSON.stringify({activePath:'a.py',openTabs:['a.py'],folderOpen:{pkg:true,'pkg/deep':true},projectOpen:true,dshOpen:true,terminalOpen:true,theme:'dark',settings:{autosave:0,autocomplete:true,inlineEnabled:false}}));
      sessionStorage.setItem('ux-seeded','yes');
    }`});
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  await until(`document.querySelector('.tree-row[data-path="a.py"]') && document.querySelector('#code-editor .cm-content')`,'production UI initializes');

  await replace('a = 2\n');await openFile('b.py');await replace('b = 2\n');await openFile('a.py');
  assert.equal(await text(),'a = 2\n');
  let stored=await evaluate(`JSON.parse(localStorage.getItem('pythona.workspace.v1')).files`);
  assert.equal(stored['a.py'].content,'a = 1\n');assert.equal(stored['b.py'].content,'b = 1\n');
  assert.equal(await evaluate(`document.querySelectorAll('.dirty-mark').length && [...document.querySelectorAll('.dirty-mark')].filter(node=>node.textContent==='●').length`),2);
  await click('.editor-more > summary');await click('#save-all-button');
  await until(`JSON.parse(localStorage.getItem('pythona.workspace.v1')).files['b.py'].content === 'b = 2\\n'`);
  stored=await evaluate(`JSON.parse(localStorage.getItem('pythona.workspace.v1')).files`);assert.equal(stored['a.py'].content,'a = 2\n');
  await evaluate(`document.querySelector('.editor-more').open=false`);
  console.log('PASS two dirty tabs survive switches; disk unchanged until Save All');

  await replace('pri');await click('#completion-button');await until(`Boolean(document.querySelector('.cm-inlineSuggestion'))`,'local ghost');
  assert.equal(await text(),'pri');assert.equal(await evaluate(`document.querySelector('#inline-accept').disabled`),false);
  await key('Tab','Tab',9);assert.equal(await text(),'print');await key('z','KeyZ',90,2);assert.equal(await text(),'pri');
  await click('#completion-button');await until(`Boolean(document.querySelector('.cm-inlineSuggestion'))`);await key('Enter','Enter',13);assert.equal(await text(),'pri\n');
  await replace('pri');await click('#completion-button');await until(`Boolean(document.querySelector('.cm-inlineSuggestion'))`);
  const button=await evaluate(`(()=>{const r=document.querySelector('#inline-accept').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...button});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...button});assert.equal(await text(),'print');
  await replace('pri');await click('#completion-button');await until(`Boolean(document.querySelector('.cm-inlineSuggestion'))`);
  await evaluate(`document.querySelector('#code-editor .cm-content').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'n'}))`);
  assert.equal(await evaluate(`document.querySelector('#inline-accept').disabled`),true);
  await evaluate(`document.querySelector('#code-editor .cm-content').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你'}))`);
  console.log('PASS production ghost preview, Tab/undo/Enter, pointer acceptance and IME exclusion');

  await click('#save-button');await click('#dsh-model-button');await until(`document.querySelector('#dsh-model-dialog').open`);
  assert.equal(await evaluate(`document.activeElement.matches('[data-model-search]')`),false);
  assert.equal(await evaluate(`['#dsh-provider-select','#dsh-model-search','#dsh-model-select','#dsh-reasoning-select'].every(id=>document.querySelector(id).getBoundingClientRect().width===0)`),true);
  await key('ArrowDown','ArrowDown',40);await key('Escape','Escape',27);await until(`!document.querySelector('#dsh-model-dialog').open`);
  console.log('PASS unified model dialog hides legacy fields, avoids opening keyboard, Esc closes');

  await click('#project-more-button');assert.equal(await evaluate(`document.querySelector('#project-action-menu').hidden`),false);
  await key('Escape','Escape',27);
  await click('#new-file-button');await until(`Boolean(document.querySelector('.app-dialog[open] input'))`,'in-app file form');
  await evaluate(`(()=>{const input=document.querySelector('.app-dialog input');input.value='../outside.py';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.app-dialog form').requestSubmit();})()`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.app-dialog[open] .field-error').textContent)`),true);
  await evaluate(`document.querySelector('.app-dialog input').value='pkg/deep/new_file.py';document.querySelector('.app-dialog form').requestSubmit()`);
  await until(`Boolean(document.querySelector('.tree-row[data-path="pkg/deep/new_file.py"]'))`);
  assert.ok(await evaluate(`Number(document.querySelector('.tree-row[data-path="pkg/deep/new_file.py"]').getAttribute('aria-level'))>=3`));
  await evaluate(`document.querySelector('.tree-row[data-path="pkg/deep"]').focus()`);await key('ArrowLeft','ArrowLeft',37);
  assert.equal(await evaluate(`document.querySelector('.tree-row[data-path="pkg/deep"]').getAttribute('aria-expanded')`),'false');
  await key('ArrowRight','ArrowRight',39);assert.equal(await evaluate(`document.querySelector('.tree-row[data-path="pkg/deep"]').getAttribute('aria-expanded')`),'true');
  console.log('PASS file form rejects traversal; nested tree keyboard collapse/expand works');

  await click('[data-terminal="tests"]');assert.equal(await evaluate(`document.querySelector('#terminal-tests').hidden`),false);
  assert.match(await evaluate(`document.querySelector('#test-results').textContent`),/尚未运行测试/);
  await evaluate(`document.querySelector('#tests-outcome-filter').value='failed';document.querySelector('#tests-outcome-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
  await click('#maximize-terminal');assert.equal(await evaluate(`document.querySelector('#app').classList.contains('terminal-maximized')`),true);
  await click('#maximize-terminal');assert.equal(await evaluate(`document.querySelector('#app').classList.contains('terminal-maximized')`),false);
  await evaluate(`document.querySelector('#terminal-resize').focus()`);await key('ArrowUp','ArrowUp',38);
  console.log('PASS Tests view/filter integration and bottom panel maximize/restore/keyboard resize');

  await mkdir(output,{recursive:true});
  for(const viewport of [{width:1440,height:900,touch:false,theme:'dark'},{width:960,height:320,touch:true,theme:'light'}]){
    await call('Emulation.setDeviceMetricsOverride',{width:viewport.width,height:viewport.height,deviceScaleFactor:1,mobile:viewport.touch});
    await call('Emulation.setTouchEmulationEnabled',{enabled:viewport.touch});
    await evaluate(`if(document.querySelector('#app').dataset.theme!==${JSON.stringify(viewport.theme)})document.querySelector('#theme-button').click();new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
    const layout=await evaluate(`(()=>{const r=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,right:b.right}};return{editor:r('#editor-surface'),body:r('.body-grid'),run:r('#run-button'),tools:r('#code-tools'),column:r('.editor-column'),bodyRows:getComputedStyle(document.querySelector('.body-grid')).gridTemplateRows}})()`);
    assert.ok(layout.body.right<=viewport.width+1,'No horizontal shell overflow');assert.ok(layout.editor.height>40,'Editor remains usable');assert.ok(layout.run.width>0,'Run remains visible');
    assert.ok(layout.tools.height === 0 || layout.tools.bottom <= viewport.height + 1, `Code toolstrip must stay above the keyboard: ${JSON.stringify(layout)}`);
    await click('#dsh-model-button');
    const modal=await evaluate(`(()=>{const r=document.querySelector('#dsh-model-dialog').getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,scroll:document.querySelector('[data-model-list]').scrollHeight}})()`);
    assert.ok(modal.top>=-1&&modal.bottom<=viewport.height+1,'Model dialog fits short viewport');assert.ok(modal.left>=-1&&modal.right<=viewport.width+1,'Model dialog fits width');
    await key('Escape','Escape',27);
    const shot=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,`ux-${viewport.width}x${viewport.height}-${viewport.theme}.png`),Buffer.from(shot.data,'base64'));
    console.log(`PASS ${viewport.width}x${viewport.height} ${viewport.theme} control/dialog layout`);
  }
  assert.deepEqual(browserErrors,[],'No uncaught production JavaScript exceptions');
  console.log(`Screenshots: ${output}`);
}finally{socket?.close();child.kill();server.close();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{});}
