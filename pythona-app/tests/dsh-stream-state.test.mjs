import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshTurn, applyDshStreamEvent, finishDshTurn, contextUsage, summarizeDshContext } from '../src/core/dsh-stream-state.js';
import { DshAgentController } from '../src/core/dsh-controller.js';
import { DshGateway } from '../src/core/dsh-gateway.js';
import { WorkspaceStore } from '../src/core/workspace-store.js';
import { DocumentSession } from '../src/core/document-session.js';

test('thinking, answer and tool updates keep incremental identity and complete every segment', () => {
  const turn = createDshTurn({ model: 'provider/model' }), messages = [];
  applyDshStreamEvent(turn, {kind:'thought',text:'first'}, messages);
  const thought = messages[0];
  applyDshStreamEvent(turn, {kind:'thought',text:' second'}, messages);
  assert.equal(messages[0], thought); assert.equal(thought.text, 'first second');
  applyDshStreamEvent(turn, {kind:'scope',callId:'c',title:'read_file',status:'pending'}, messages);
  const tool = messages[1];
  applyDshStreamEvent(turn, {kind:'scope',callId:'c',status:'completed'}, messages);
  assert.equal(messages[1], tool); assert.equal(tool.tool.title, 'read_file');
  applyDshStreamEvent(turn, {kind:'delta',text:'answer'}, messages);
  assert.equal(thought.streaming, false); assert.equal(messages.length, 3);
  finishDshTurn(turn, 'cancelled');
  assert.equal(messages[2].streaming, false); assert.equal(turn.phase, 'cancelled');
  assert.equal(applyDshStreamEvent(turn, {kind:'delta',text:'late'}, messages), false);
  assert.equal(messages[2].text, 'answer');
});

test('context occupancy never fabricates billing tokens, missing capacity or invalid counts', () => {
  assert.equal(contextUsage({inputTokens:100}), null);
  assert.equal(contextUsage({used:-1,size:1000}), null);
  assert.deepEqual(contextUsage({used:0,size:1000}), {used:0,size:1000,percent:0});
  assert.deepEqual(contextUsage({used:50}), {used:50,size:null,percent:null});
  assert.deepEqual(contextUsage({used:200,size:1000}), {used:200,size:1000,percent:20});
});

test('retry retracts only its original incremental blocks before replacement arrives', () => {
  const turn = createDshTurn(), messages = [];
  applyDshStreamEvent(turn,{kind:'delta',messageId:'step1',text:'Earlier valid reply'},messages);
  applyDshStreamEvent(turn,{kind:'thought',messageId:'step2-attempt1',text:'Partial reasoning'},messages);
  applyDshStreamEvent(turn,{kind:'delta',messageId:'step2-attempt1',text:'Partial retry'},messages);
  applyDshStreamEvent(turn,{kind:'stream_reset',messageId:'step2-attempt1'},messages);
  applyDshStreamEvent(turn,{kind:'delta',messageId:'step2-attempt2',text:'Replacement'},messages);
  assert.deepEqual(messages.map(m=>m.text),['Earlier valid reply','Replacement']);
});

test('real upstream block boundaries keep the next fenced block separate from the previous list', () => {
  const turn=createDshTurn(), messages=[];
  applyDshStreamEvent(turn,{kind:'delta',messageId:'m',blockIndex:0,text:'1. A list item'},messages);
  applyDshStreamEvent(turn,{kind:'delta',messageId:'m',blockIndex:1,text:'```python\n'},messages);
  applyDshStreamEvent(turn,{kind:'delta',messageId:'m',blockIndex:1,text:'pass\n```'},messages);
  assert.equal(messages.length,1);
  assert.equal(messages[0].text,'1. A list item\n\n```python\npass\n```');
});

test('bounded stream keeps only visible prefix while consuming complete upstream events', () => {
  const turn = createDshTurn(), messages = [];
  applyDshStreamEvent(turn,{kind:'delta',text:'a'.repeat(65540)},messages);
  applyDshStreamEvent(turn,{kind:'delta',text:'more'},messages);
  assert.equal(messages[0].text.length,65536); assert.equal(messages[0].omittedCharacters,8);
});

test('context preview redacts credentials and caps excerpts without mutating source', () => {
  const secret='sk-'+'x'.repeat(32);
  const source={files:[{path:'example.py',bytes:9000,content:secret+'\n'+'a'.repeat(9000),redactions:[]}]};
  const result=summarizeDshContext(source);
  assert.ok(!result.files[0].preview.includes(secret));
  assert.equal(result.files[0].preview.length,8192); assert.equal(result.files[0].truncated,true);
  assert.ok(source.files[0].content.includes(secret));
});

test('compatibility tool step completion does not discard the following streamed answer', async () => {
  const store = new WorkspaceStore({ storage:null, files:{'a.py':'value = 1\n'} });
  const document = new DocumentSession(store); document.open('a.py');
  let steps = 0;
  const gateway = { cancel:async()=>({cancelled:true}), async *stream() {
    if (++steps === 1) yield {kind:'tool_call',name:'read_file',callId:'read',arguments:{path:'a.py'}};
    else yield {kind:'delta',text:'Answer after actual tool result'};
    yield {kind:'done'};
  } };
  const controller = new DshAgentController({store,document,gateway});
  const turn=createDshTurn(), messages=[], events=[];
  controller.subscribe(event=>{
    events.push(event.type);
    applyDshStreamEvent(turn,event,messages);
    if (event.type==='task-finished') finishDshTurn(turn);
  });
  await controller.start('read and explain');
  assert.equal(steps,2); assert.equal(events.at(-1),'task-finished');
  assert.ok(messages.some(message=>message.text==='Answer after actual tool result'));
  assert.equal(turn.phase,'completed'); assert.equal(messages.at(-1).streaming,false);
});

test('cancel during pending context construction cannot restore cleared UI or start a request', async () => {
  const store=new WorkspaceStore({storage:null,files:{'a.py':'pass\n'}});
  const document=new DocumentSession(store); document.open('a.py');
  let complete, started=false;
  const controller=new DshAgentController({store,document,
    contextIndexer:{build:()=>new Promise(resolve=>{complete=resolve;})},
    gateway:{cancel:async()=>({}),async *stream(){started=true;yield{kind:'done'};}}});
  const events=[];controller.subscribe(event=>events.push(event));
  const pending=controller.start('test');controller.cancel();
  complete({files:[],excluded:[],redactions:[],estimatedBytes:0});await pending;
  assert.equal(started,false);assert.equal(events.length,0);
});

test('raw ACP incremental message identity survives normalization for precise retry removal', () => {
  const gateway=new DshGateway({subscribe:()=>()=>{}});
  const messages=[], turn=createDshTurn();
  gateway.subscribe(event=>applyDshStreamEvent(turn,event,messages));
  const receive=update=>gateway.receive({streamId:'s',method:'session/update',params:{sessionId:'s',update}});
  receive({sessionUpdate:'agent_thought_chunk',messageId:'m',content:{type:'text',text:'partial'}});
  receive({sessionUpdate:'agent_message_chunk',messageId:'m',content:{type:'text',text:'retry me'}});
  assert.equal(messages.length,2);
  receive({sessionUpdate:'pythona_stream_reset',messageId:'m',reason:'retry'});
  assert.equal(messages.length,0);
});
