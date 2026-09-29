import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTestResultsModel } from '../src/ui/test-results-view.js';

const result = (cases,status='passed') => ({framework:'pytest',status,counts:{collected:cases.length,passed:cases.filter(item=>item.outcome==='passed').length,
  failed:cases.filter(item=>item.outcome==='failed').length,errors:cases.filter(item=>item.outcome==='error').length,skipped:cases.filter(item=>item.outcome==='skipped').length},cases});
const item = (id,outcome='passed',path='tests/test_a.py') => ({id,nodeId:`${path}::test_${id}`,name:`test_${id}`,path,outcome,line:10,durationMillis:1});

test('test result filtering precedes pagination and keeps full original counts',()=>{
  const cases=Array.from({length:130},(_,i)=>item(i,i<70?'passed':'failed'));
  const run=result(cases,'failed'); const page=buildTestResultsModel(run,{filter:'failed',page:1});
  assert.equal(page.filteredCount,60); assert.equal(page.pages,2); assert.equal(page.groups[0].cases.length,10);
  assert.equal(page.counts.collected,130); assert.equal(page.counts.passed,70); assert.equal(page.counts.failed,60);
  assert.deepEqual(run.cases,cases);
});
test('failed-first order groups both errors and failures ahead of successful suites',()=>{
  const model=buildTestResultsModel(result([item(1,'passed','a.py'),item(2,'error','b.py'),item(3,'failed','c.py'),item(4,'skipped','a.py')],'error'));
  assert.deepEqual(model.groups.map(group=>group.path),['b.py','c.py','a.py']);
  assert.equal(model.groups[0].failures,1); assert.equal(model.groups[2].cases.length,2);
});
test('sort can be disabled and selected page is clamped after filter change',()=>{
  const model=buildTestResultsModel(result([item(1),item(2,'failed')],'failed'),{failedFirst:false,page:50});
  assert.deepEqual(model.groups[0].cases.map(value=>value.id),[1,2]); assert.equal(model.page,0);
});
test('empty, collection failure, timeout and cancellation never claim a passing run',()=>{
  assert.equal(buildTestResultsModel(result([])).status,'empty');
  for(const status of ['cancelled','timeout','error','collection-error']){
    const model=buildTestResultsModel(result([],status)); assert.equal(model.status,status); assert.notEqual(model.statusLabel,'全部通过');
  }
  assert.equal(buildTestResultsModel(result([item(1,'error')],'passed')).status,'error');
});
test('truncation preserves total counts and only paginates retained cases',()=>{
  const run={...result(Array.from({length:55},(_,i)=>item(i))),truncated:true,counts:{collected:1000,passed:1000,failed:0,skipped:0,errors:0}};
  const model=buildTestResultsModel(run,{page:1}); assert.equal(model.counts.collected,1000); assert.equal(model.groups[0].cases.length,5); assert.equal(model.pages,2);
});
test('passed and skipped filters isolate correct outcomes and failure filter includes errors',()=>{
  const run=result([item(1),item(2,'skipped'),item(3,'failed'),item(4,'error')],'error');
  assert.equal(buildTestResultsModel(run,{filter:'passed'}).filteredCount,1);
  assert.equal(buildTestResultsModel(run,{filter:'skipped'}).filteredCount,1);
  assert.equal(buildTestResultsModel(run,{filter:'failed'}).filteredCount,2);
});
