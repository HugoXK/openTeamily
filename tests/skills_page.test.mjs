import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterSkills, mountSkills, skillCountLabel,
} from '../openteamily/static/skills/app.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.handlers = {};
    this.className = '';
    this.style = {};
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.classList = {
      add: (name) => { if (!this.className.split(' ').includes(name)) this.className = (this.className + ' ' + name).trim(); },
      contains: (name) => this.className.split(' ').includes(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
}

function fakeDocument() {
  const nodes = new Map();
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element(id === 'skills-search' ? 'input' : 'div'));
      return nodes.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const SKILLS = JSON.parse(execFileSync('python3', ['-c', 'import json;from openteamily.skill_packages import catalogue;print(json.dumps(catalogue()))'], {encoding:'utf8'}));
function service({failWrite=false} = {}) {
  let bindings=[];const calls=[];
  return {calls, fetcher:async(path, options) => {
    calls.push({path,options});
    if(options.method==='POST') {
      if(failWrite)return {status:403,ok:false,json:async()=>({error:{message:'permission denied'}})};
      const b=JSON.parse(options.body);bindings=b.enabled ? [{scope:b.scope,skill_id:b.skill_id,version:b.version,digest:b.digest,last_loaded_task:null}] : [];
      return {status:200,ok:true,json:async()=>({enabled:b.enabled})};
    }
    return {status:200,ok:true,json:async()=>path.endsWith('/catalog') ? {items:SKILLS} : path.endsWith('/bindings') ? {items:bindings} : {items:[]}};
  }};
}

test('authoritative catalogue has real bounded version-pinned prompt packages', () => {
  assert.equal(SKILLS.length,10);
  assert.equal(new Set(SKILLS.map(i=>i.id)).size,10);
  for(const item of SKILLS) {
    assert.ok(item.content.length>100);
    assert.equal(createHash('sha256').update(item.content).digest('hex'),item.digest);
    assert.deepEqual(item.permissions,['model_context']);
  }
});

test('filter searches actual server content and counts it', () => {
  assert.equal(filterSkills(SKILLS,'').length,10);
  assert.deepEqual(filterSkills(SKILLS,'会议').map(i=>i.id),['meeting-notes']);
  assert.equal(filterSkills(SKILLS,'找不到的技能').length,0);
  assert.equal(skillCountLabel(1,10),'显示 1 / 10 个技能');
});

test('installation needs permission, persists through service reload, and uninstall revokes', async () => {
  const svc=service();const {doc,el}=fakeDocument();doc.cookie='__Host-ot_csrf=synthetic-csrf';el('skills-scope').value='account';
  const mounted=mountSkills(doc,{fetcher:svc.fetcher});await mounted.ready;
  assert.equal(el('skills-list').children.length,10);
  let button=el('skills-list').children[0].children[2];await button.handlers.click();
  assert.match(el('skills-error').textContent,/勾选/);assert.equal(svc.calls.filter(c=>c.options.method==='POST').length,0);
  el('skills-permission').checked=true;await button.handlers.click();
  assert.equal(el('skills-list').children[0].children[2].textContent,'卸载');
  assert.match(el('skills-list').children[0].children[1].children[1].textContent,/等待/);
  const posted=svc.calls.find(c=>c.options.method==='POST');assert.equal(posted.options.headers['X-CSRF-Token'],'synthetic-csrf');
  const next=fakeDocument();next.doc.cookie='__Host-ot_csrf=x';next.el('skills-scope').value='account';await mountSkills(next.doc,{fetcher:svc.fetcher}).ready;
  assert.equal(next.el('skills-list').children[0].children[2].textContent,'卸载');
  await next.el('skills-list').children[0].children[2].handlers.click();
  assert.equal(next.el('skills-list').children[0].children[2].textContent,'安装');
});

test('server refusal never invents installed or runtime-loaded state', async () => {
  const svc=service({failWrite:true}),{doc,el}=fakeDocument();doc.cookie='';el('skills-scope').value='account';el('skills-permission').checked=true;
  await mountSkills(doc,{fetcher:svc.fetcher}).ready;await el('skills-list').children[0].children[2].handlers.click();
  assert.equal(el('skills-list').children[0].children[2].textContent,'安装');assert.equal(el('skills-error').textContent,'permission denied');
});
