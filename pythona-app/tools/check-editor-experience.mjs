// Exercises the real CodeMirror view, keymaps and DOM decorations in Chromium.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = [process.argv[2], process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/chromium'].find(path => path && existsSync(path));
assert.ok(chrome, 'Chromium executable required');
const bundle = await build({ bundle:true, write:false, format:'iife', absWorkingDir:root, stdin:{resolveDir:root,contents:`
import {EditorAdapter} from './src/editor/editor-adapter.js';
import {closeCompletion, hasNextSnippetField} from '@codemirror/autocomplete';
import {undoDepth} from '@codemirror/commands';
import {renderTestResults} from './src/ui/test-results-view.js';
let doc={path:'a.py',buffer:'',bufferVersion:1}; let changes=0;
const adapter=new EditorAdapter({parent:document.querySelector('#editor'),settings:{theme:'light'},
 getDocument:()=>doc,getWorkspaceFiles:()=>[],getInlineIdentity:()=>({epoch:1,modelSelectionVersion:1}),
 onChange:text=>{doc={...doc,buffer:text,bufferVersion:doc.bufferVersion+1};changes++;}});
const reset=(text='')=>{doc={path:'a.py',buffer:text,bufferVersion:doc.bufferVersion+1};adapter.open('a.py',text,doc.bufferVersion);adapter.goTo(text.length);changes=0;};
window.qa={adapter,reset,close:()=>closeCompletion(adapter.view),get:()=>({text:adapter.documentText(),version:doc.bufferVersion,changes,undo:undoDepth(adapter.view.state),ghost:adapter.inlineState(),cursor:adapter.view.state.selection.main.head,snippet:hasNextSnippetField(adapter.view.state),composing:adapter.view.composing}),
 setAI:text=>adapter.setInlineSuggestion({text,token:adapter.inlineSnapshot(),source:'ai'}),renderTestResults};reset();`}});
const server = createServer((request,response)=>{
  response.setHeader('Content-Type',request.url==='/app.js'?'text/javascript':'text/html; charset=utf-8');
  response.end(request.url==='/app.js'?bundle.outputFiles[0].text:'<!doctype html><body><div id="editor"></div><input id="other"><script src="/app.js"></script>');
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const profile=await mkdtemp(join(tmpdir(),'pythona-editor-'));
const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(done=>setTimeout(done,ms)); let socket;
try {
  let port;
  for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{} await pause(100);}
  assert.ok(port,'Browser debug port');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
  await new Promise((done,fail)=>{socket.onopen=done;socket.onerror=fail;});
  let sequence=0; const pending=new Map();
  socket.onmessage=({data})=>{const message=JSON.parse(data);const task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(message.error):task.resolve(message.result);};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(new Error(`CDP timeout ${method}`)),10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  const key=async(name,code,vk)=>{await call('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,windowsVirtualKeyCode:vk});await call('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:vk});};
  const until=async expression=>{for(let i=0;i<50;i++){if(await evaluate(expression))return;await pause(50);}throw new Error(`Timed out: ${expression}`);};
  await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await until('Boolean(window.qa)');

  await call('Input.insertText',{text:'pri'}); await evaluate('qa.adapter.startCompletion()');
  await until('qa.get().ghost.visible');
  const before=await evaluate('qa.get()'); assert.equal(before.text,'pri'); assert.equal(before.ghost.text,'nt');
  assert.equal(await evaluate('document.querySelector(".cm-inlineSuggestion").textContent'),'nt');
  await pause(100); const unchanged=await evaluate('qa.get()');
  assert.equal(unchanged.version,before.version); assert.equal(unchanged.undo,before.undo);
  await key('Tab','Tab',9); assert.equal((await evaluate('qa.get()')).text,'print');
  await evaluate('qa.adapter.undo()'); assert.equal((await evaluate('qa.get()')).text,'pri');
  console.log('PASS local ghost does not edit text/history; Tab accepts and one undo restores');

  await evaluate('qa.reset("pri");qa.adapter.startCompletion()'); await until('qa.get().ghost.visible');
  await key('Enter','Enter',13); assert.equal((await evaluate('qa.get()')).text,'pri\n');
  await evaluate('qa.reset("pri");qa.adapter.startCompletion()'); await until('qa.get().ghost.visible');
  await key('Escape','Escape',27); assert.equal((await evaluate('qa.get()')).ghost.visible,false);
  console.log('PASS Enter remains newline and Esc dismisses candidate');

  await evaluate('qa.reset("x = ");qa.close()');
  assert.equal(await evaluate('qa.setAI("1\\nprint(x)")'),true);
  const ai=await evaluate('qa.get()'); assert.equal(ai.text,'x = '); assert.equal(ai.undo,0);
  await key('Tab','Tab',9); assert.equal((await evaluate('qa.get()')).text,'x = 1\nprint(x)');
  await evaluate('qa.adapter.undo()'); assert.equal((await evaluate('qa.get()')).text,'x = ');
  await evaluate('qa.close();qa.setAI("2");qa.adapter.goTo(1)'); assert.equal((await evaluate('qa.get()')).ghost.visible,false);
  console.log('PASS AI multiline decoration, isolated undo, caret invalidation');

  await evaluate('qa.reset("x = ");qa.close();qa.setAI("2");document.querySelector("#other").focus()');
  assert.equal((await evaluate('qa.get()')).ghost.visible,false);
  await evaluate('qa.adapter.focus();qa.setAI("2");qa.adapter.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:"n"}))');
  assert.equal((await evaluate('qa.get()')).ghost.visible,false);
  assert.equal(await evaluate('qa.adapter.touchEdit("accept")'),false);
  await evaluate('qa.adapter.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"你"}))');
  console.log('PASS blur and IME composition clear ghost and prevent acceptance');

  await evaluate('qa.reset("de");qa.adapter.startCompletion()'); await until('document.querySelector(".cm-tooltip-autocomplete") !== null');
  await key('Tab','Tab',9); assert.equal((await evaluate('qa.get()')).snippet,true);
  const snippet=await evaluate('qa.get()'); await key('Tab','Tab',9); const moved=await evaluate('qa.get()');
  assert.equal(moved.text,snippet.text); assert.notEqual(moved.cursor,snippet.cursor);
  console.log('PASS snippet Tab moves placeholder without inserting a competing completion');

  await evaluate(`(()=>{
    const container=document.createElement('div');document.body.append(container);let opened=0,rerun=0;
    const item={id:'1',nodeId:'a.py::test_a',name:'<script>bad()</script>',path:'a.py',outcome:'failed',line:3,message:'assert false',traceback:'<img src=x onerror=bad()>',durationMillis:1};
    const result={framework:'pytest',status:'failed',cases:[item],counts:{collected:1,failed:1,passed:0,errors:0,skipped:0}};
    const options={onOpen:()=>opened++,onRerun:()=>rerun++};qa.renderTestResults(container,result,options);
    container.querySelector('.result-row').click();container.querySelector('.test-case > button:last-of-type').click();
    container.querySelector('[data-test-suite]').open=false;qa.renderTestResults(container,result,options);
    window.resultQA={opened,rerun,collapsed:!container.querySelector('[data-test-suite]').open,unsafe:container.querySelectorAll('script,img').length};
    qa.renderTestResults(container,result,{...options,busy:true});window.resultQA.disabled=container.querySelector('.test-case > button:last-of-type').disabled;
  })()`);
  assert.deepEqual(await evaluate('resultQA'),{opened:1,rerun:1,collapsed:true,unsafe:0,disabled:true});
  console.log('PASS Tests DOM collapse persists, callbacks target one case, busy disables rerun, traceback escapes markup');
} finally {
  socket?.close();child.kill();server.close();
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{});
}
