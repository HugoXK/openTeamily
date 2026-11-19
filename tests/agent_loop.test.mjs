import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRuntimeKey } from '../runtime/flybot-image/agent-loop.mjs'

test('loadRuntimeKey ignores a missing or empty file', () => {
  assert.equal(loadRuntimeKey({OPENTEAMILY_RUNTIME_KEY_FILE: '/no/such/runtime-key.json'}), null)
  const empty = loadRuntimeKey({OPENTEAMILY_RUNTIME_KEY_FILE: 'x'}, () => '')
  assert.equal(empty, null)
})

test('loadRuntimeKey reads origin token hostname and does not throw the token', () => {
  const payload = JSON.stringify({
    origin: 'https://management.test',
    token: 'secret-token-value-0001',
    hostname: 'flybot-abcd1234ef00',
  })
  const loaded = loadRuntimeKey({OPENTEAMILY_RUNTIME_KEY_FILE: 'x'}, () => payload)
  assert.equal(loaded.origin, 'https://management.test')
  assert.equal(loaded.token, 'secret-token-value-0001')
  assert.equal(loaded.hostname, 'flybot-abcd1234ef00')
})

// Synthetic model/management/Composio bridge only. No external requests.
import {infer, toolBridge, runCycle} from '../runtime/flybot-image/agent-loop.mjs'

test('container infer discovers a tool, forwards the proposal, and feeds the result back to the model', async () => {
  const messages = []
  const calls = []
  const bridge = {
    discover: async () => ({tools: [{type: 'function', function: {name: 'GITHUB_GET_USER', parameters: {type: 'object'}}}]}),
    execute: async (id, name, args) => { calls.push({id, name, args}); return {data: {login: 'synthetic'}} },
  }
  const fetcher = async (_url, options) => {
    messages.push(JSON.parse(options.body))
    return {ok: true, json: async () => ({choices: [{message: messages.length === 1
      ? {content: null, tool_calls: [{id: 'call_1', type: 'function', function: {name: 'GITHUB_GET_USER', arguments: '{"username":"fake"}'}}]}
      : {content: 'Synthetic profile read.'}}]})}
  }
  const text = await infer({model: 'fake', base_url: 'https://model.invalid/v1', api_key: 'model-key'}, 'read profile', bridge, fetcher)
  assert.equal(text, 'Synthetic profile read.')
  assert.deepEqual(calls, [{id: 'call_1', name: 'GITHUB_GET_USER', args: {username: 'fake'}}])
  assert.equal(messages[1].messages.at(-1).role, 'tool')
})

test('container broker waits for owner decision, with stable call id and no direct Composio key', async () => {
  const seen = []
  let step = 0
  const requester = async (origin, token, method, path, body) => {
    seen.push({origin, token, method, path, body})
    if (path.endsWith('/tools')) return {tools: []}
    if (path.endsWith('/heartbeat')) return {}
    if (path.endsWith('/calls')) return {call: {id: 'local_1', status: 'pending'}}
    step += 1
    return {call: {id: 'local_1', status: step === 1 ? 'pending' : 'succeeded', result: step === 1 ? null : {data: 'synthetic'}}}
  }
  const bridge = toolBridge('https://manager.invalid', 'runtime-key', {id: 'task_1'}, requester, {wait: async () => {}, now: () => 0})
  await bridge.discover()
  assert.deepEqual(await bridge.execute('call_1', 'GITHUB_GET_USER', {}), {data: 'synthetic'})
  assert.equal(seen.filter(c => c.path.endsWith('/calls')).length, 1)
  assert.equal(seen.find(c => c.path.endsWith('/calls')).body.call_id, 'call_1')
  assert.ok(seen.every(c => c.origin === 'https://manager.invalid' && c.token === 'runtime-key'))
})

test('container broker does not retry denied or ambiguous execution', async () => {
  for (const state of ['denied', 'unknown', 'executing']) {
    let count = 0
    const requester = async (_o, _t, _m, path) => {
      if (path.endsWith('/heartbeat')) return {}
      count += 1
      return {call: {id: 'one', status: count === 1 ? 'pending' : state}}
    }
    const bridge = toolBridge('https://manager.invalid', 'runtime-key', {id: 'task_1'}, requester, {wait: async () => {}, now: () => 0})
    assert.equal((await bridge.execute('call_1', 'GITHUB_GET_USER', {})).error, 'tool_' + state)
    assert.equal(count, 2)
  }
})

test('container infer rejects hallucinated tools and caps model tool rounds', async () => {
  const bridge = {discover: async () => ({tools: []}), execute: () => {throw Error('must not run')}}
  const fetcher = async () => ({ok: true, json: async () => ({choices: [{message: {tool_calls: [
    {id: 'one', function: {name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: '{}'}},
  ]}}]})})
  await assert.rejects(infer({model: 'fake', base_url: 'https://model.invalid', api_key: 'fake'}, 'x', bridge, fetcher), /not discovered/)
})

import {createHash} from 'node:crypto'
import {loadSkillMaterial} from '../runtime/flybot-image/agent-loop.mjs'

test('container verifies material, acknowledges loading, and model context loses revoked skills', async () => {
  const content='Original skill: separate decisions from unsupported assumptions.'
  const item={id:'meeting-notes',name:'Meeting notes',version:'1.0.0',content,digest:createHash('sha256').update(content).digest('hex'),permissions:['model_context'],format:'openteamily.prompt-skill.v1',source:'bundled-original'}
  for(const installed of [true,false]) {
    let ack=false, modelPrompt='', result
    const requester=async(_origin,_token,_method,path,body) => {
      if(path==='/v1/agent/tasks')return {items:[{id:'a'.repeat(32),kind:'infer',prompt:'Summarize the supplied meeting.'}]}
      if(path.endsWith('/claim'))return {task:{id:'a'.repeat(32),kind:'infer',prompt:'Summarize the supplied meeting.'}}
      if(path.endsWith('/model-access'))return {model_api:{model:'fake',base_url:'https://synthetic.invalid',api_key:'synthetic-only'},skills:installed?[item]:[]}
      if(path.endsWith('/skills/ack')) {assert.deepEqual(body.digests,[item.digest]);ack=true;return {acknowledged:true}}
      if(path.endsWith('/result')) {result=body;return {}}
      return {}
    }
    await runCycle({origin:'https://manager.invalid',token:'synthetic-runtime',hostname:'synthetic'}, {requester,inferer:async(model,prompt) => {
      assert.equal(ack,installed)
      return infer(model,prompt,null,async(_url,options) => {modelPrompt=JSON.parse(options.body).messages[0].content;return {ok:true,json:async()=>({choices:[{message:{content:'synthetic result'}}]})}})
    }})
    assert.equal(modelPrompt.includes(content),installed)
    assert.equal(result.status,'succeeded')
  }
  for(const delta of [{id:'../escape'},{version:'../1'},{content:content+'tampered'},{permissions:['shell']},{files:['../../x']},{archive:'x.zip'}])assert.throws(()=>loadSkillMaterial([{...item,...delta}],'task'))
})

test('container refuses inference when verified skill loading is not acknowledged',async()=>{
  const content='Original bounded instruction material.';
  const item={id:'meeting-notes',name:'Notes',version:'1.0.0',content,digest:createHash('sha256').update(content).digest('hex'),permissions:['model_context'],format:'openteamily.prompt-skill.v1',source:'bundled-original'};
  let result,inferred=false;
  const task={id:'b'.repeat(32),kind:'infer',prompt:'Supplied task'};
  const requester=async(_origin,_token,_method,path,body)=>{
    if(path==='/v1/agent/tasks')return {items:[task]};
    if(path.endsWith('/claim'))return {task};
    if(path.endsWith('/model-access')){assert.equal(body.skill_format,'openteamily.prompt-skill.v1');return {model_api:{api_key:'synthetic-only'},skills:[item]}};
    if(path.endsWith('/skills/ack'))return {acknowledged:false};
    if(path.endsWith('/result'))result=body;
    return {};
  };
  await runCycle({origin:'https://manager.invalid',token:'synthetic',hostname:'synthetic'},{requester,inferer:async()=>{inferred=true}});
  assert.equal(inferred,false);assert.equal(result.status,'failed');assert.match(result.result.error,/skill verification\/loading failed/);
});
