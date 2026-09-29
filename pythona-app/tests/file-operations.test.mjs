import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceStore, RevisionConflictError } from '../src/core/workspace-store.js';
import { FileOperationHistory } from '../src/core/file-operations.js';

function fixture(files = { 'main.py': 'print(1)\n' }, options) {
  const store = new WorkspaceStore({ storage: null, files });
  return { store, history: new FileOperationHistory(store, options) };
}

test('create rename delete and chained undo use monotonic guarded atomic batches', async () => {
  const { store, history } = fixture();
  await history.create('src/新文件.py', 'hello');
  await history.rename('src/新文件.py', 'src/renamed.py');
  assert.equal(store.has('src/新文件.py'), false);
  await history.remove('src/renamed.py');
  assert.equal(store.has('src/renamed.py'), false);
  await history.undo();
  assert.equal(store.read('src/renamed.py').content, 'hello');
  await history.undo();
  assert.equal(store.has('src/renamed.py'), false);
  assert.equal(store.read('src/新文件.py').content, 'hello');
  await history.undo();
  assert.equal(store.has('src/新文件.py'), false);
  assert.equal(history.latest, null);
});

test('atomic rename observers never see a partial browser snapshot', async () => {
  const { store, history } = fixture();
  const observed = [];
  store.subscribe(event => { if (event.transactionId) observed.push([store.has('main.py'), store.has('renamed.py')]); });
  await history.rename('main.py', 'renamed.py');
  assert.deepEqual(observed, [[false, true], [false, true]]);
});

test('rename undo refuses an external edit without recreating old name or deleting changed target', async () => {
  const { store, history } = fixture();
  await history.rename('main.py', 'renamed.py');
  store.write('renamed.py', 'external', { source: 'external' });
  await assert.rejects(history.undo(), RevisionConflictError);
  assert.equal(store.has('main.py'), false);
  assert.equal(store.read('renamed.py').content, 'external');
  assert.ok(history.latest);
});

test('undo does not forgive an external revision even when content returns to its old value', async () => {
  const { store, history } = fixture();
  await history.rename('main.py', 'renamed.py');
  const before = store.read('renamed.py').content;
  store.write('renamed.py', 'external', { source: 'external' });
  store.write('renamed.py', before, { source: 'external' });
  await history.remove('renamed.py');
  await history.undo();
  await assert.rejects(history.undo(), RevisionConflictError);
  assert.equal(store.has('main.py'), false);
});

test('file operation history rejects unsafe paths and existing rename targets', async () => {
  const { store, history } = fixture({ 'main.py': 'a', 'taken.py': 'b' });
  for (const path of ['../other.py', 'src/../other.py', '/absolute.py', 'C:/file.py']) await assert.rejects(history.create(path));
  await assert.rejects(history.rename('main.py', 'taken.py'));
  assert.equal(store.read('main.py').content, 'a');
  assert.equal(store.read('taken.py').content, 'b');
});

test('history is bounded and oversized reversible operation is rejected before mutation', async () => {
  const { store, history } = fixture({}, { limit: 2, maxBytes: 1024 });
  await history.create('a.py', 'a'); await history.create('b.py', 'b'); await history.create('c.py', 'c');
  assert.equal(history.history.length, 2);
  await assert.rejects(history.create('huge.py', 'x'.repeat(2048)));
  assert.equal(store.has('huge.py'), false);
});
