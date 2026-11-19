import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { target, oldHelper, newHelper, transformAnnotationFixture, load } from './upstream-test-clock-loader.mjs';

const original=readFileSync(new URL(target),'utf8');
function clock(){
  let now=0,next=0;const timers=new Map();
  return {
    setTimeout(fn,delay){const id=++next;timers.set(id,{fn,due:now+Math.max(1,delay)});return id},
    elapse(ms){now+=ms},
    async flush(){
      for(;;){const pending=[...timers].sort((a,b)=>a[1].due-b[1].due||a[0]-b[0]);
        if(!pending.length||pending[0][1].due>now)return;
        const [id,{fn}]=pending[0];timers.delete(id);fn();await Promise.resolve();
      }
    },
  };
}
async function scenario(helper,{late=true,failed=false}={}){
  const timers=clock();let dismissed=0,cleared=0,sent=0,settled=false;
  const settle=Function('setTimeout','return ('+helper.replace('const settle = ','')+')')(timers.setTimeout);
  const send=async()=>{try{await (failed?Promise.reject(new Error('send failed')):Promise.resolve(++sent));cleared++;timers.setTimeout(()=>{dismissed++},0)}catch{}};
  void send();const wait=settle().then(()=>{settled=true;return dismissed});
  // This models a delayed event-loop turn, NOT an added wall-clock sleep.
  if(late)timers.elapse(20);
  await Promise.resolve();await Promise.resolve();
  timers.elapse(1);await timers.flush();
  // Original5ms timer is now due before the later-scheduled dismiss timer.
  if(!late){timers.elapse(5);await timers.flush()}
  assert.equal(settled,true);
  return {observed:await wait,dismissed,cleared,sent};
}

test('reproduces the old fixture ordering failure without timing luck or dependencies',async()=>{
  // Take one due timer at a time: the old settle continuation observes before
  // the close timer, even though all send/clear assertions already passed.
  const timers=clock();let dismissed=0,observed;
  const send=async()=>{await Promise.resolve();timers.setTimeout(()=>dismissed++,0)};
  void send();const wait=new Promise(resolve=>timers.setTimeout(resolve,5)).then(()=>{observed=dismissed});
  timers.elapse(20);await Promise.resolve();await timers.flush();await wait;
  assert.equal(observed,0);assert.equal(dismissed,0);
});
test('causal barrier retains dismiss/send/clear assertions on normal and delayed turns',async()=>{
  for(const late of [false,true])assert.deepEqual(await scenario(newHelper,{late}),{observed:1,dismissed:1,cleared:1,sent:1});
  assert.deepEqual(await scenario(newHelper,{failed:true}),{observed:0,dismissed:0,cleared:0,sent:0});
});
test('only the reviewed upstream helper changes; all upstream assertions stay identical',async()=>{
  const patched=transformAnnotationFixture(original);
  assert.equal(patched.replace(newHelper,oldHelper),original);
  assert.equal(patched.includes('setTimeout(resolve, 5)'),false);
  assert.equal((await load(target,{},async()=>({format:'module',source:Buffer.from(original)}))).source,patched);
  const other={format:'module'};
  assert.equal(await load('file:///other.test.js',{},async()=>other),other);
  assert.throws(()=>transformAnnotationFixture(original+'\n'),/fixture changed/);
  assert.throws(()=>transformAnnotationFixture(original.replace('app.calls.dismiss, 1','app.calls.dismiss, 0')),/fixture changed/);
});
