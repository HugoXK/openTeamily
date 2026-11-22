import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { target, replacements, transformAnnotationFixture, load } from './upstream-test-clock-loader.mjs';

const original=readFileSync(new URL(target),'utf8');
const patched=transformAnnotationFixture(original);
const component=readFileSync(new URL('../runtime/ds-bot-upstream/ds-bot/src/client/text-annotation.js',import.meta.url),'utf8');
// Execute the real pinned async send in its actual separate VM Promise realm.
const sendBody=component.slice(component.indexOf('  const send = async () => {'),component.indexOf('  const onKeyDown ='));
function fixture(){
  const benchBody=patched.slice(patched.indexOf('function bench('),patched.indexOf('const key = patch'));
  return Function('runtime','TextSelectionAction','findAll',benchBody+';return bench')({reset(){}},()=>{},()=>[])();
}
function clock(){
  let now=0,next=0;const timers=new Map();
  return {
    setTimeout(fn,delay){const id=++next;timers.set(id,{fn,due:now+Math.max(1,delay)});return id},
    size:()=>timers.size,
    async flushOne(){const first=[...timers].sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];assert.ok(first&&first[1].due<=now);timers.delete(first[0]);first[1].fn();await Promise.resolve()},
    elapse(ms){now+=ms},
    async flush(){for(;;){const first=[...timers].sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];if(!first||first[1].due>now)return;timers.delete(first[0]);first[1].fn();await Promise.resolve()}},
  };
}
async function microtasksUntil(predicate){
  for(let i=0;i<30&&!predicate();i++)await Promise.resolve();
  assert.equal(predicate(),true,'expected actual callback/timer across VM realm');
}
function sendInVM(app,timers){
  return runInNewContext(sendBody+';send',{
    quoteText:()=> 'selected',closing:false,pending:{current:false},setSending(){},
    actions:app.props.actions,sessionId:'room',annotation:'note',annotatedMessage:()=>'> selected\n> note',
    close(){app.props.clearSelection();timers.setTimeout(app.props.dismiss,0)},field:{current:null},
  });
}
test('reproduces original five-ms wait and insufficient host-microtask barrier against actual VM send',async()=>{
  for(const helper of ['() => new Promise(resolve => setTimeout(resolve, 5))','async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve,0)) }']){
    const app=fixture(),timers=clock();let observed;
    void sendInVM(app,timers)();
    const wait=Function('setTimeout','return ('+helper+')')(timers.setTimeout)().then(()=>{observed=app.calls.dismiss});
    timers.elapse(20);await microtasksUntil(()=>timers.size()===2);timers.elapse(1);await timers.flushOne();await wait;
    assert.equal(observed,0);assert.equal(app.sent.length,1);assert.equal(app.calls.clear,1);assert.equal(app.calls.dismiss,0);
  }
});
test('actual dismiss/error observation preserves all assertions across VM realms, delayed turns and failed sends',async()=>{
  for(const late of [false,true]){
    const app=fixture(),timers=clock();let done=false;const wait=app.settled.then(()=>{done=true});
    void sendInVM(app,timers)();if(late)timers.elapse(20);
    await microtasksUntil(()=>timers.size()===1);assert.equal(done,false);assert.equal(app.calls.dismiss,0);
    timers.elapse(1);await timers.flush();await wait;
    assert.equal(done,true);assert.equal(app.sent.length,1);assert.deepEqual(app.calls,{clear:1,dismiss:1});
  }
  const app=fixture(),timers=clock();app.props.actions.send=async()=>{throw new Error('offline')};
  void sendInVM(app,timers)();await microtasksUntil(()=>app.errors.length===1);await app.settled;
  assert.deepEqual(app.calls,{clear:0,dismiss:0});assert.equal(timers.size(),0);assert.equal(app.sent.length,0);
});
test('an unresolved actual send cannot be accepted as completed',async()=>{
  const app=fixture(),timers=clock();let release,done=false;
  app.props.actions.send=()=>new Promise(resolve=>{release=resolve});app.settled.then(()=>{done=true});
  void sendInVM(app,timers)();await microtasksUntil(()=>typeof release==='function');
  assert.equal(done,false);assert.equal(timers.size(),0);release();await microtasksUntil(()=>timers.size()===1);
  assert.equal(done,false);timers.elapse(1);await timers.flush();await app.settled;assert.equal(done,true);
});
test('overlay retains all pinned assertion bytes, reverses exactly, and rejects source changes',async()=>{
  assert.deepEqual(patched.split('\n').filter(l=>l.includes('assert.')),original.split('\n').filter(l=>l.includes('assert.')));
  let restored=patched;for(const [before,after]of [...replacements].reverse())restored=restored.replaceAll(after,before);
  assert.equal(restored,original);
  assert.equal((await load(target,{},async()=>({format:'module',source:Buffer.from(original)}))).source,patched);
  const other={format:'module'};assert.equal(await load('file:///other.test.js',{},async()=>other),other);
  assert.throws(()=>transformAnnotationFixture(original+'\n'),/fixture changed/);
  assert.throws(()=>transformAnnotationFixture(original.replace('app.calls.dismiss, 1','app.calls.dismiss, 0')),/fixture changed/);
});
