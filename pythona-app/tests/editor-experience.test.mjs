import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { history, undoDepth } from '@codemirror/commands';
import { DocumentSession } from '../src/core/document-session.js';
import { EditorDraftClient } from '../src/core/editor-drafts.js';
import { WorkspaceStore } from '../src/core/workspace-store.js';
import { inlineSuggestionField, localInlineSuggestion, safeInlineText, sameInlineToken, setInline } from '../src/editor/inline-suggestion.js';
import { EditorCoordinator } from '../src/editor/editor-coordinator.js';

const makeStore = () => new WorkspaceStore({ storage: null, files: { 'a.py': 'a = 1\n', 'b.py': 'b = 1\n' } });
const drafts = () => {
  const values = new Map();
  return { values, list: async () => [...values.values()].map(({path}) => ({path})),
    read: async path => values.get(path), write: async draft => values.set(draft.path, {...draft}),
    delete: async path => values.delete(path) };
};

test('file switches preserve independent dirty buffers and undo/redo without writing workspace', () => {
  const store = makeStore(); const session = new DocumentSession(store);
  session.open('a.py'); session.edit('a = 2\n'); const aVersion = session.bufferVersion;
  session.open('b.py'); session.edit('b = 2\n');
  session.open('a.py');
  assert.equal(session.buffer, 'a = 2\n'); assert.equal(session.bufferVersion, aVersion);
  assert.equal(session.dirty, true); assert.equal(store.read('a.py').content, 'a = 1\n');
  session.undo(); assert.equal(session.buffer, 'a = 1\n'); session.redo();
  session.open('b.py'); assert.equal(session.buffer, 'b = 2\n'); session.undo();
  assert.equal(session.buffer, 'b = 1\n');
  session.dispose();
});

test('async save settles original tab after switching without clearing a newer edit', async () => {
  const store = makeStore(); const session = new DocumentSession(store);
  const write = store.writeAsync.bind(store); let release;
  store.writeAsync = async (...args) => { await new Promise(done => { release = done; }); return write(...args); };
  session.open('a.py'); session.edit('a = 2\n'); const pending = session.saveAsync();
  session.edit('a = 3\n'); session.open('b.py'); release(); await pending;
  assert.equal(session.path, 'b.py'); assert.equal(session.snapshotFor('a.py').original, 'a = 2\n');
  assert.equal(session.snapshotFor('a.py').buffer, 'a = 3\n'); assert.equal(session.snapshotFor('a.py').dirty, true);
  session.dispose();
});

test('save failure is persistent, bounded and observable without losing dirty text',async()=>{
  const store=makeStore();const session=new DocumentSession(store);const events=[];session.subscribe(event=>events.push(event));
  session.open('a.py');session.edit('a = 2\n');const revision=session.revision;
  store.writeAsync=async()=>{throw Object.assign(new Error('Storage denied\n'+'x'.repeat(1000)),{code:'workspace-io-error'});};
  await assert.rejects(session.saveAsync(),/Storage denied/);
  assert.equal(session.saving,false);assert.equal(session.dirty,true);assert.equal(session.buffer,'a = 2\n');assert.equal(session.revision,revision);
  assert.equal(session.saveError.message.length,512);assert.equal(session.saveError.message.includes('\n'),false);
  assert.equal(session.saveError.code,'workspace-io-error');assert.ok(events.some(event=>event.type==='save-error'&&event.path==='a.py'));
  const snapshot=session.snapshot();snapshot.saveError.message='changed by caller';assert.notEqual(session.saveError.message,snapshot.saveError.message);
  session.edit('a = 3\n');assert.ok(session.saveError);session.dispose();
});

test('retry success, confirmed external save and discarded edits clear a previous save error',async()=>{
  const store=makeStore();const session=new DocumentSession(store);const write=store.writeAsync.bind(store);
  session.open('a.py');session.edit('a = 2\n');store.writeAsync=async()=>{throw new Error('disk full');};
  await assert.rejects(session.saveAsync(),/disk full/);assert.ok(session.saveError);
  store.writeAsync=write;await session.saveAsync();assert.equal(session.saveError,null);assert.equal(session.dirty,false);
  session.edit('a = 3\n');store.writeAsync=async()=>{throw new Error('offline');};await assert.rejects(session.saveAsync());
  store.simulateExternalChange('a.py','a = 3\n');assert.equal(session.saveError,null);assert.equal(session.dirty,false);
  session.edit('a = 4\n');await assert.rejects(session.saveAsync());session.edit(session.original,{skipHistory:true});
  assert.equal(session.saveError,null);session.dispose();
});

test('an inactive save failure is attached only to its own tab',async()=>{
  const store=makeStore();const session=new DocumentSession(store);const events=[];session.subscribe(event=>events.push(event));let rejectWrite;
  session.open('a.py');session.edit('a = 2\n');store.writeAsync=()=>new Promise((_resolve,reject)=>{rejectWrite=reject;});
  const pending=session.saveAsync();session.open('b.py');rejectWrite(new Error('disk full'));await assert.rejects(pending,/disk full/);
  assert.equal(session.path,'b.py');assert.equal(session.saveError,null);assert.equal(session.snapshotFor('a.py').saveError.message,'disk full');
  const event=events.find(value=>value.type==='save-error');assert.equal(event.inactive,true);assert.equal(event.affectedDocument.path,'a.py');
  session.open('a.py');assert.equal(session.saveError.message,'disk full');session.close('a.py',{discard:true});
  session.open('a.py');assert.equal(session.saveError,null);session.dispose();
});

test('external modification marks inactive dirty tab conflict and rejects affected transaction', () => {
  const store = makeStore(); const session = new DocumentSession(store); const events = [];
  session.subscribe(event => events.push(event));
  session.open('a.py'); session.edit('a = 2\n'); session.open('b.py');
  store.simulateExternalChange('a.py', 'a = 9\n');
  assert.equal(session.snapshotFor('a.py').conflict.remote, 'a = 9\n');
  assert.equal(session.buffer, 'b = 1\n'); assert.ok(events.at(-1).inactive);
  assert.throws(() => session.assertClean(['b.py', 'a.py']), {code: 'dirty-buffers'});
  assert.equal(session.assertClean(['b.py']), true);
  session.open('a.py'); assert.equal(session.buffer, 'a = 2\n'); session.dispose();
});

test('save all persists each buffer and leaves active tab and independent histories intact', async () => {
  const store = makeStore(); const session = new DocumentSession(store);
  session.open('a.py'); session.edit('a = 2\n'); session.open('b.py'); session.edit('b = 2\n');
  await session.saveAllAsync(); assert.equal(session.path, 'b.py'); assert.deepEqual(session.dirtyPaths(), []);
  assert.equal(store.read('a.py').content, 'a = 2\n'); assert.equal(store.read('b.py').content, 'b = 2\n');
  session.undo(); assert.equal(session.buffer, 'b = 1\n'); session.dispose();
});

test('close requires explicit discard and removes only closed draft', async () => {
  const store = makeStore(); const session = new DocumentSession(store); const client = drafts(); session.attachDrafts(client);
  session.open('a.py'); session.edit('a = 2\n'); await session.flushDrafts();
  assert.equal(session.close('a.py'), false); assert.equal(session.close('a.py', {discard:true}), true);
  await session.draftQueue; assert.equal(client.values.has('a.py'), false);
  assert.equal(store.read('a.py').content, 'a = 1\n'); session.dispose();
});

test('draft recovery restores same-revision buffers and flags changed disk without writing it', async () => {
  const store = makeStore(); const client = drafts(); const first = new DocumentSession(store).attachDrafts(client);
  first.open('a.py'); first.edit('a = 2\n'); first.open('b.py'); first.edit('b = 2\n');
  await first.flushDrafts(); first.dispose(); store.simulateExternalChange('b.py', 'b = 9\n');
  const restored = new DocumentSession(store).attachDrafts(client);
  assert.deepEqual(await restored.recoverDrafts(), [{path:'a.py',conflict:false}, {path:'b.py',conflict:true}]);
  restored.open('a.py'); assert.equal(restored.buffer, 'a = 2\n'); assert.equal(restored.dirty, true);
  restored.open('b.py'); assert.equal(restored.buffer, 'b = 2\n'); assert.equal(restored.conflict.remote, 'b = 9\n');
  assert.equal(store.read('b.py').content, 'b = 9\n'); restored.dispose();
});

test('draft transport failures remain visible and do not discard dirty buffer', async () => {
  const session = new DocumentSession(makeStore()); const errors = [];
  session.attachDrafts({write: async () => {throw new Error('disk full');}, delete: async () => {}});
  session.subscribe(event => {if (event.type === 'draft-error') errors.push(event.message);});
  session.open('a.py'); session.edit('keep me'); await assert.rejects(session.flushDrafts(), /disk full/);
  assert.equal(session.buffer, 'keep me'); assert.deepEqual(errors, ['disk full']); session.dispose();
});

test('deleted-file draft remains openable and can be explicitly restored using tombstone revision',async()=>{
  const store=makeStore();const client=drafts();const original=new DocumentSession(store).attachDrafts(client);
  original.open('a.py');original.edit('a = 8\n');await original.flushDrafts();original.dispose();
  store.delete('a.py',{expectedRevision:store.read('a.py').revision,source:'external'});
  const recovered=new DocumentSession(store).attachDrafts(client);await recovered.recoverDrafts();recovered.open('b.py');
  await recovered.openAsync('a.py');assert.equal(recovered.buffer,'a = 8\n');assert.equal(recovered.conflict.deleted,true);
  assert.equal(store.has('a.py'),false);recovered.keepLocal();await recovered.saveAsync();
  assert.equal(store.read('a.py').content,'a = 8\n');recovered.dispose();
});

test('existing recovered buffers do not mask unrelated native read failures',async()=>{
  const store=makeStore();const session=new DocumentSession(store);session.open('a.py');session.edit('draft');session.open('b.py');
  store.readAsync=async()=>{throw Object.assign(new Error('Storage unavailable'),{code:'workspace-io-error'});};
  await assert.rejects(session.openAsync('a.py'),/Storage unavailable/);assert.equal(session.path,'b.py');session.dispose();
});

test('late open response does not steal selection from a subsequently selected tab', async () => {
  const store = makeStore(); const session = new DocumentSession(store); let release;
  const read = store.readAsync.bind(store);
  store.readAsync = async path => { if (path === 'a.py') await new Promise(done => {release = done;}); return read(path); };
  const earlier = session.openAsync('a.py'); await session.openAsync('b.py'); release(); await earlier;
  assert.equal(session.path, 'b.py'); session.dispose();
});

test('close and reopen cannot reuse an old buffer identity', () => {
  const session = new DocumentSession(makeStore()); session.open('a.py'); const token = session.captureBuffer();
  session.close('a.py'); session.open('a.py'); assert.equal(session.isCurrentBuffer(token), false); session.dispose();
});

test('late IME commit targets the original tab after another tab becomes active',()=>{
  const session=new DocumentSession(makeStore());session.open('a.py');session.open('b.py');
  session.editPath('a.py','a = "你好"\n',{composing:false,skipHistory:true});
  assert.equal(session.buffer,'b = 1\n');assert.equal(session.snapshotFor('a.py').buffer,'a = "你好"\n');
  assert.equal(session.snapshotFor('a.py').dirty,true);session.dispose();
});

test('coordinator defers file identity as well as content while composition is active',()=>{
  const pending=[];
  const adapter={view:{composing:false},text:'',state:null,previewMode:false,
    runAfterComposition:action=>pending.push(action),
    capture(){return {state:this.state,scroll:{top:0,left:0}};},
    open(path,text){this.text=text;this.state={doc:{toString:()=>text}};return this.capture();},
    documentText(){return this.text;},reconfigure(){},leavePreview(){return false;}};
  const coordinator=new EditorCoordinator({adapter});
  coordinator.present({path:'a.py',buffer:'a',bufferVersion:1},{});adapter.view.composing=true;
  coordinator.present({path:'b.py',buffer:'b',bufferVersion:2},{});
  assert.equal(coordinator.activePath,'a.py');assert.equal(adapter.currentPath,'a.py');assert.equal(adapter.text,'a');
  adapter.view.composing=false;pending.splice(0).forEach(action=>action());
  assert.equal(coordinator.activePath,'b.py');assert.equal(adapter.currentPath,'b.py');assert.equal(adapter.text,'b');
});

test('revisiting clean inactive tab reconciles an owner-written DSH transaction', () => {
  const store = makeStore(); const session = new DocumentSession(store);
  session.open('a.py'); session.open('b.py');
  store.write('a.py','a = 7\n',{expectedRevision:store.read('a.py').revision,source:'dsh'});
  session.open('a.py'); assert.equal(session.buffer,'a = 7\n'); assert.equal(session.dirty,false); session.dispose();
});

test('native draft client uses isolated protocol channel and never workspace writes', async () => {
  const calls = [];
  const client = new EditorDraftClient({available:true, request: async (...args) => {calls.push(args); return {drafts:[{path:'a.py'}]};}});
  await client.write({path:'a.py',content:'draft',original:'base',revision:1});
  assert.deepEqual(await client.list(), [{path:'a.py'}]); await client.delete('a.py');
  assert.ok(calls.every(([channel]) => channel === 'draft'));
  assert.equal(calls[0][2].workspaceId, 'default');
});

test('native draft disconnect fails visibly instead of pretending browser storage saved it', async () => {
  const broker={available:true, request:async()=>({saved:true})}; const client=new EditorDraftClient(broker);
  broker.available=false; await assert.rejects(client.write({path:'a.py',content:'draft'}), {code:'draft-disconnected'});
});

test('ghost effect changes no text, selection or history and invalidates on edit or caret move', () => {
  let state = EditorState.create({doc:'pri', selection:{anchor:3}, extensions:[history(), inlineSuggestionField]});
  const suggestion = {text:'nt()',source:'ai',token:{path:'a.py',bufferVersion:1,cursor:3}};
  state = state.update({effects:setInline.of(suggestion)}).state;
  assert.equal(state.doc.toString(), 'pri'); assert.equal(state.selection.main.head, 3); assert.equal(undoDepth(state),0);
  assert.deepEqual(state.field(inlineSuggestionField),suggestion);
  assert.equal(state.update({selection:{anchor:2}}).state.field(inlineSuggestionField),null);
  assert.equal(state.update({changes:{from:3,insert:'n'}}).state.field(inlineSuggestionField),null);
});

test('local ghost is insertion-only and hides function-based snippets and mid-word replacements', () => {
  const state = EditorState.create({doc:'obj.pri', selection:{anchor:7}});
  assert.equal(localInlineSuggestion(state,{label:'print'}).text,'nt');
  assert.equal(localInlineSuggestion(state,{label:'print',apply:()=>{}}),null);
  assert.equal(localInlineSuggestion(state,{label:'other'}),null);
  const middle = EditorState.create({doc:'print', selection:{anchor:3}});
  assert.equal(localInlineSuggestion(middle,{label:'print'}),null);
});

test('ghost token and text limits reject stale caret, models, composition-generation and large output', () => {
  const token = {path:'a.py',bufferVersion:2,cursor:4,epoch:3,selectionVersion:9,modelSelectionVersion:7,generation:2};
  assert.equal(sameInlineToken(token,{...token}),true);
  for (const key of Object.keys(token)) assert.equal(sameInlineToken(token,{...token,[key]:`${token[key]}changed`}),false);
  assert.equal(safeInlineText('x'.repeat(2048)),true); assert.equal(safeInlineText('x'.repeat(2049)),false);
  assert.equal(safeInlineText('你'.repeat(683)),false); assert.equal(safeInlineText('x\n'.repeat(8)),false);
  assert.equal(safeInlineText('a\0b'),false);
});
