import assert from 'node:assert/strict';
import test from 'node:test';
import {mountAgentSharing} from '../openteamily/static/agents/sharing.mjs';

class Element {
  constructor() { this.children=[]; this.handlers={}; this.value=''; this.textContent=''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, callback) { this.handlers[type] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  focus() {}
  select() {}
}

test('sender shares the saved revision with the selected teammate and can revoke after archiving', async () => {
  const elements = new Map();
  const doc = {defaultView:{location:{origin:'https://local.example'}},createElement:()=>new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id,new Element());
      return elements.get(id);
    }};
  const el = id => doc.getElementById('agent-share-'+id);
  const source = {id:'agent-a', revision:7, name:'草稿助理', instructions:'私人指令', quick_starts:['私人开场']};
  const actor = {agent:source,workspace:'space-a',user:'sender-id'};
  const recipient = {owner_id:'recipient-id',handle:'real-teammate',display_name:'同名成员'};
  const other = {owner_id:'other-id',handle:'other-teammate',display_name:'同名成员'};
  const grant = {id:'otag_'+'A'.repeat(26),state:'active',source_agent_id:source.id,recipient};
  const path = '/v1/workspaces/space-a/agents/agent-a/shares';
  const calls = [];
  let savedGrant;
  let firstAttempt = true;
  const panel = mountAgentSharing(doc,{context:()=>actor,idempotencyKey:()=>`scope-send-key-${calls.length}`,
    request:async (method,route,body,headers)=>{
      calls.push({method,route,body,headers});
      if (route.startsWith('/v1/agent-copy-grants/recipients?')) return {status:200,body:{items:[recipient,other]}};
      if (route === path + '?limit=30') return {status:200,body:{items:savedGrant ? [savedGrant] : []}};
      if (route === path) {
        if (firstAttempt) { firstAttempt = false; throw new Error('response lost'); }
        savedGrant = grant;
        return {status:201,body:{grant}};
      }
      if (route === `${path}/${grant.id}/revoke`) {
        savedGrant = {...grant,state:'revoked'};
        return {status:200,body:{grant:savedGrant}};
      }
      throw new Error(route);
    }});
  panel.open();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(el('submit').disabled,true);
  assert.deepEqual(el('recipient').children.slice(1).map(row=>row.textContent),['同名成员 · @real-teammate','同名成员 · @other-teammate']);
  el('recipient').value = recipient.owner_id;
  el('recipient').handlers.change();
  assert.equal(el('instructions').checked,false);
  assert.equal(el('quick-starts').checked,false);
  el('quick-starts').checked = true;
  const send = ()=>el('form').handlers.submit({preventDefault() {}});
  await send();
  await send();
  const [first,retry] = calls.filter(call=>call.method==='POST');
  assert.deepEqual(first.body,{recipient_owner_id:recipient.owner_id,revision:7,share_instructions:false,share_quick_starts:true});
  assert.deepEqual(first,retry);
  assert.equal(el('link').value,`https://local.example/discover?tab=agents&share=${grant.id}`);

  panel.close();
  actor.agent = {...source,archived:true};
  panel.open();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(el('form').hidden,true);
  assert.equal(calls.filter(call=>call.route.includes('/recipients')).length,1);
  const row = el('sent').children[0];
  row.children.find(button=>button.textContent==='撤销').handlers.click();
  assert.equal(calls.some(call=>call.route.endsWith('/revoke')),false);
  row.children.find(button=>button.textContent==='确认撤销').handlers.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.at(-1),{method:'POST',route:`${path}/${grant.id}/revoke`,body:{},headers:undefined});
  assert.equal(el('sent').children[0].children[0].textContent,'同名成员 · @real-teammate · 已撤销');
});
