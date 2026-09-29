import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBroker } from '../src/core/native-broker.js';
import { RuntimeAdapter } from '../src/core/runtime-adapter.js';
import { TestAdapter } from '../src/core/test-adapter.js';
import { BridgeLanguageProvider } from '../src/core/language-service.js';

function bridge() {
  const statuses=new Set();const listeners=new Map();let requests=0;
  return {available:true,statuses,listeners,get requests(){return requests;},
    subscribeStatus(fn){statuses.add(fn);return()=>statuses.delete(fn);},
    subscribe(channel,fn){const values=listeners.get(channel)||new Set();values.add(fn);listeners.set(channel,values);return()=>values.delete(fn);},
    status(event){for(const listener of statuses)listener(event);},
    async request(channel,method,payload={}){
      requests++;
      if(method==='capabilities')return {available:true,protocolVersion:2,methods:['runFile','stop'],framework:'pytest'};
      return {accepted:true,started:true,runId:payload.runId};
    }};
}

test('transient native response failure is scoped by pending request, not response channel',async()=>{
  const original=globalThis.PythonANative;const sent=[];
  const broker=new NativeBroker({nativeObject:{postMessage:raw=>sent.push(JSON.parse(raw))}});const statuses=[];broker.subscribeStatus(event=>statuses.push(event));
  try{
    const pending=broker.request('runtime','capabilities');const request=sent.at(-1);
    broker.receive({protocolVersion:2,id:request.id,channel:'dsh',ok:false,error:{code:'service-disconnected',message:'Runtime restart'}});
    await assert.rejects(pending,{code:'service-disconnected'});
    assert.equal(statuses.at(-1).type,'reconnecting');assert.equal(statuses.at(-1).channel,'runtime');
    broker.emitStatus({type:'disconnected'});assert.equal(statuses.at(-1).channel,undefined);
  }finally{broker.dispose();globalThis.PythonANative=original;}
});

test('DSH failure leaves Run, Tests and language state intact; Runtime and Tests share one failure scope',async()=>{
  const transport=bridge();const runtime=new RuntimeAdapter({bridge:transport});await runtime.ready;
  const tests=new TestAdapter({bridge:transport});const language=new BridgeLanguageProvider(transport);
  await runtime.runFile('a.py');const run=runtime.running;
  const accepted=await tests.run({paths:['tests']});const report=tests.wait(accepted.runId);
  const requests=transport.requests;
  transport.status({type:'reconnecting',channel:'dsh'});
  assert.equal(runtime.running,run);assert.ok(tests.running);assert.equal(language.recoveryRequired,false);
  assert.equal(transport.requests,requests,'unrelated failures must not trigger capability calls');
  transport.status({type:'reconnecting',channel:'test'});
  assert.equal(runtime.running,null);assert.equal((await run.terminal).type,'failed');
  assert.equal((await report).status,'error');assert.equal(language.recoveryRequired,false);
  assert.equal(transport.requests,requests,'status handling must not recurse through a failed capability request');
  runtime.dispose();tests.dispose();language.dispose();assert.equal(transport.statuses.size,0);
});

test('language recovery is isolated, while a transport-wide disconnect still terminates all tasks',async()=>{
  const transport=bridge();const runtime=new RuntimeAdapter({bridge:transport});await runtime.ready;
  const tests=new TestAdapter({bridge:transport});const language=new BridgeLanguageProvider(transport);
  await runtime.runFile('a.py');const run=runtime.running;const accepted=await tests.run({paths:['tests']});
  transport.status({type:'reconnecting',channel:'language'});
  assert.equal(language.recoveryRequired,true);assert.equal(runtime.running,run);assert.ok(tests.running);
  transport.status({type:'disconnected'});
  assert.equal(runtime.running,null);assert.equal((await run.terminal).type,'failed');
  assert.equal((await tests.wait(accepted.runId)).status,'error');
  runtime.dispose();tests.dispose();language.dispose();
});

test('misrouted lifecycle payloads cannot cancel sibling adapters',async()=>{
  const transport=bridge();const runtime=new RuntimeAdapter({bridge:transport});await runtime.ready;
  const tests=new TestAdapter({bridge:transport});await runtime.runFile('a.py');const run=runtime.running;
  await tests.run({paths:['tests']});
  runtime.handleBridgeEvent({type:'service-crashed',channel:'language'});
  tests.handleLifecycle({type:'service-crashed',channel:'dsh'});
  assert.equal(runtime.running,run);assert.ok(tests.running);
  runtime.handleBridgeEvent({type:'service-disconnected',channel:'runtime'});
  tests.handleLifecycle({type:'service-disconnected',channel:'runtime'});
  assert.equal(runtime.running,null);assert.equal(tests.running,null);
  runtime.dispose();tests.dispose();
});
