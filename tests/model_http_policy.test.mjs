import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {createServer,request as httpRequest} from 'node:http'
import {once} from 'node:events'
import {fetchHttpTask,MODEL_HTTP_FORMAT,publicHttpBase,validHttpGrant,validateModelEndpoint} from '../runtime/flybot-image/model-http-policy.mjs'
import {parseModelApi,applyModelApi} from '../runtime/flybot-image/model-api.js'
import {infer,runCycle} from '../runtime/flybot-image/agent-loop.mjs'

const base='http://8.8.4.4:8080/v1' // fixture only; never dialed
const key='synthetic-only-http-model-key'
const grant=url=>({format:MODEL_HTTP_FORMAT,base_url:url})
const doc=url=>({provider:'custom',base_url:url,model:'synthetic-model',api_key:key,source:'platform',http_endpoint_grant:grant(url)})

test('shared Python/JS canonical public IPv4 corpus rejects multicast/special/aliases',()=>{
  const cases=JSON.parse(readFileSync(new URL('./fixtures/model_http_urls.json',import.meta.url)))
  for(const {url,allowed} of cases) assert.equal(publicHttpBase(url),allowed,url)
})
test('exact grant and every field binding fail closed',()=>{
  assert.equal(validHttpGrant(base,grant(base)),true)
  for(const g of [undefined,null,true,{}, {...grant(base),format:'old'}, {...grant(base),base_url:base+'/other'},{...grant(base),allow_all:true}]) {
    assert.equal(validHttpGrant(base,g),false)
    assert.throws(()=>validateModelEndpoint(base,g))
  }
  for(const changed of [base+'2',base.replace('8080','8081'),base.replace('8.8.4.4','9.9.9.9')]) assert.equal(validHttpGrant(changed,grant(base)),false)
  assert.equal(validateModelEndpoint('https://provider.test/v1'),false)
  assert.equal(validateModelEndpoint('http://127.0.0.1:8080/v1'),false)
})
test('secret parser preserves grant but native SDK never receives this HTTP key',()=>{
  const parsed=parseModelApi(JSON.stringify(doc(base)))
  assert.deepEqual(parsed.http_endpoint_grant,grant(base))
  const env={CUSTOM_API_KEY:'stale',OPENTEAMILY_MODEL_BASE_URL:'https://stale.test'};const lines=[]
  applyModelApi(parsed,env,{info:line=>lines.push(line)})
  assert.equal(env.CUSTOM_API_KEY,undefined);assert.equal(env.OPENTEAMILY_MODEL_BASE_URL,undefined)
  assert.equal(env.OPENTEAMILY_MODEL_TASK_ONLY,'1');assert.equal(JSON.stringify(lines).includes(key),false)
  for(const altered of [{...doc(base),http_endpoint_grant:null},{...doc(base),http_endpoint_grant:grant(base+'/other')},{...doc(base),base_url:' '+base},{...doc(base),http_endpoint_grant:undefined}]) assert.throws(()=>parseModelApi(JSON.stringify(altered)))
  const secure=parseModelApi(JSON.stringify({...doc('https://provider.test/v1'),http_endpoint_grant:undefined}))
  applyModelApi(secure,env,{info:()=>{}});assert.equal(env.CUSTOM_API_KEY,key);assert.equal(env.OPENTEAMILY_MODEL_TASK_ONLY,undefined)
})
test('bad runtime grant causes zero fetches and no credential forwarding',async()=>{
  const seen=[];const fetcher=async(...args)=>{seen.push(args);throw new Error('must not run')}
  for(const d of [{...doc(base),http_endpoint_grant:undefined},{...doc(base),http_endpoint_grant:grant(base+'/other')},doc('http://224.0.0.1:8080/v1')]) await assert.rejects(()=>infer(d,'benign',null,fetcher))
  assert.equal(seen.length,0)
})
test('real fetch obeys redirect:error with no requests or Authorization to second target',async t=>{
  const seen={provider:0,exfil:0,auth:undefined,bodies:[]};let code=200;let location=''
  const exfil=createServer((req,res)=>{seen.exfil++;res.end('unexpected')})
  exfil.listen(0,'127.0.0.1');await once(exfil,'listening');t.after(()=>{exfil.closeAllConnections();exfil.close()})
  const server=createServer(async(req,res)=>{
    seen.provider++;seen.auth=req.headers.authorization;let body='';for await(const chunk of req)body+=chunk;seen.bodies.push(JSON.parse(body))
    if(code!==200){res.writeHead(code,{Location:location});res.end();return}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'synthetic HTTP reply'}}]}))
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
  const url=`http://8.8.4.4:${server.address().port}/v1`;const config=doc(url);const options=[]
  // Test-only wire mapping. The production infer path receives and validates the
  // exact public URL; only this injected fixture routes bytes to a loopback server.
  const fetcher=(target,init)=>{
    assert.equal(target,url+'/chat/completions');assert.equal(init.redirect,'error');options.push(init)
    return fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,init).then(response=>({
      ok:response.ok,status:response.status,redirected:response.redirected,url:target,json:()=>response.json(),
    }))
  }
  assert.equal(await infer(config,'synthetic skill context + task',null,fetcher),'synthetic HTTP reply')
  assert.equal(seen.auth,'Bearer '+key);assert.equal(seen.bodies[0].messages[0].content,'synthetic skill context + task')
  for(const status of [301,302,303,307,308]){
    code=status
    for(const loc of [`http://127.0.0.1:${exfil.address().port}/steal`,`http://127.0.0.1:${server.address().port}/other`]){
      location=loc;await assert.rejects(()=>infer(config,'benign',null,fetcher))
    }
  }
  assert.equal(seen.provider,11);assert.equal(seen.exfil,0)
})
test('even an injected transport reporting a followed redirect is rejected before parsing',async()=>{
  let parsed=false
  await assert.rejects(()=>infer(doc(base),'benign',null,async()=>({ok:true,status:200,redirected:true,url:base+'/other',json:()=>{parsed=true}})),/redirect/)
  assert.equal(parsed,false)
})
test('HTTPS regression: normal verified fetch is not opted into HTTP capability',async()=>{
  const secure={...doc('https://provider.test/v1'),http_endpoint_grant:undefined}
  const fetcher=async(url,init)=>{assert.equal(url,'https://provider.test/v1/chat/completions');assert.equal(init.redirect,undefined);return {ok:true,json:async()=>({choices:[{message:{content:'HTTPS synthetic'}}]})}}
  assert.equal(await infer(secure,'benign',null,fetcher),'HTTPS synthetic')
})
test('task loop consumes server grant and persists text only, not key/grant',async()=>{
  const model=doc(base);const tid='a'.repeat(32);let persisted
  const requester=async(origin,token,method,path,body)=>{
    if(path==='/v1/agent/tasks')return {items:[{id:tid,kind:'infer',prompt:'benign task'}]}
    if(path.endsWith('/claim'))return {task:{id:tid,kind:'infer',prompt:'benign task'}}
    if(path.endsWith('/model-access'))return {model_api:model,skills:[]}
    if(path.endsWith('/result'))persisted=body
    return {}
  }
  const inferer=(api,prompt)=>infer(api,prompt,null,async(url,init)=>{
    assert.equal(init.redirect,'error');assert.equal(url,base+'/chat/completions')
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:'persisted synthetic'}}]})}
  })
  assert.deepEqual(await runCycle({origin:'https://management.test',token:'synthetic-runtime',hostname:'fixture'},{requester,inferer}),[tid])
  assert.equal(persisted.status,'succeeded');assert.equal(persisted.result.text,'persisted synthetic')
  assert.equal(JSON.stringify(persisted).includes(key),false);assert.equal(JSON.stringify(persisted).includes('http_endpoint_grant'),false);assert.equal(model.api_key,undefined)
})

test('production direct HTTP transport rejects redirects without proxy/dispatcher or second request',async t=>{
  let code=200; let requests=0; let exfil=0
  const trap=createServer((_req,res)=>{exfil++;res.end('wrong')})
  trap.listen(0,'127.0.0.1');await once(trap,'listening');t.after(()=>{trap.closeAllConnections();trap.close()})
  const server=createServer((req,res)=>{
    requests++;assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+key)
    req.resume();res.writeHead(code,code===200?{'Content-Type':'application/json'}:{Location:`http://127.0.0.1:${trap.address().port}/steal`})
    res.end(code===200?JSON.stringify({choices:[{message:{content:'direct synthetic'}}]}):'')
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close()})
  const url=`http://8.8.4.4:${server.address().port}/v1`
  const requester=(options,callback)=>{
    assert.equal(options.hostname,'8.8.4.4');assert.equal(Number(options.port),server.address().port);assert.equal(options.agent,false)
    return httpRequest({...options,hostname:'127.0.0.1'},callback)
  }
  const init={method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key},body:'{}',signal:AbortSignal.timeout(5000)}
  const response=await fetchHttpTask(url,grant(url),init,requester)
  assert.equal((await response.json()).choices[0].message.content,'direct synthetic')
  for(const status of [301,302,303,307,308]){code=status;await assert.rejects(()=>fetchHttpTask(url,grant(url),init,requester),/redirect/)}
  assert.equal(requests,6);assert.equal(exfil,0)
  let called=false;await assert.rejects(()=>fetchHttpTask(url,grant(url+'/other'),init,()=>{called=true}));assert.equal(called,false)
})

test('real JS management call advertises capability without extending strict JSON schema',async t=>{
  const original=globalThis.fetch;let capability=false
  globalThis.fetch=async(url,init)=>{
    const path=new URL(url).pathname;let data={}
    if(path==='/v1/agent/tasks')data={items:[{id:'b'.repeat(32),kind:'infer',prompt:'benign'}]}
    if(path.endsWith('/claim'))data={task:{id:'b'.repeat(32),kind:'infer',prompt:'benign'}}
    if(path.endsWith('/model-access')){
      assert.equal(init.headers['X-Openteamily-Model-HTTP'],MODEL_HTTP_FORMAT)
      assert.deepEqual(JSON.parse(init.body),{skill_format:'openteamily.prompt-skill.v2'});capability=true
      data={model_api:doc(base),skills:[]}
    }
    return {ok:true,status:200,json:async()=>data}
  }
  t.after(()=>{globalThis.fetch=original})
  await runCycle({origin:'https://management.test',token:'synthetic-runtime',hostname:'fixture'},{inferer:async()=> 'synthetic only'})
  assert.equal(capability,true)
})
