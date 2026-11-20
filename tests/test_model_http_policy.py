"""Synthetic policy/API/credential/transport chain; no real provider or Docker."""
import io
import json
import os
from pathlib import Path
import socket
import ssl
import tempfile
import subprocess
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from urllib.error import HTTPError

from openteamily.app import App, Config
from openteamily import model_api
from openteamily.flybot import AgentError, infer_chat, open_http_model
from openteamily.lifecycle import Lifecycle
from openteamily.manager.client import ManagerClient
from openteamily.manager.engine import ComposeEngine
from openteamily.manager.safety import ManagerError
from openteamily.model_http_policy import ModelHttpPolicy, FORMAT, WSGI_HEADER, public_http_base, valid_grant, completion_url, load_model_http_policy
from openteamily.operator_config import OperatorAdmin
from openteamily.security import digest
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_runtime_connect import AgentClient
from tests import test_runtime as runtime_fixtures
from tests.test_runtime_infer import start_fake_provider

BASE = 'http://8.8.4.4:8080/v1'  # public literal fixture, NEVER contacted
SECRET = 'synthetic-only-http-model-key'
TOKEN = 'Z' * 43
FIELDS = {'provider':'custom', 'base_url':BASE, 'model':'synthetic-model', 'api_key':SECRET}


class PolicyTests(unittest.TestCase):
    def test_shared_adversarial_url_corpus(self):
        vectors = json.loads((Path(__file__).parent/'fixtures/model_http_urls.json').read_text())
        for item in vectors:
            with self.subTest(url=item['url']):
                self.assertEqual(public_http_base(item['url']), item['allowed'])
                if not item['allowed']:
                    with self.assertRaises(ValueError): ModelHttpPolicy((item['url'],))

    def test_exact_matching_and_grant_tampering(self):
        p=ModelHttpPolicy((BASE,));grant=p.grant_for(BASE)
        self.assertFalse(ModelHttpPolicy().allows(BASE));self.assertTrue(p.allows(BASE))
        self.assertEqual(completion_url(BASE,grant),BASE+'/chat/completions')
        for bad in [BASE+'2',BASE.replace('8080','8081'),BASE.replace('8.8.4.4','9.9.9.9')]:
            self.assertFalse(p.allows(bad));self.assertFalse(valid_grant(bad,grant))
        for g in [None,True,{},dict(grant,format='old'),dict(grant,base_url=BASE+'/other'),dict(grant,all_http=True)]:
            self.assertFalse(valid_grant(BASE,g))
        for doc in [[],{}, {'version':True,'allowed_http_model_bases':[BASE]},
                    {'version':1,'allowed_http_model_bases':[BASE,BASE]},
                    {'version':1,'allowed_http_model_bases':[BASE],'allow_all':True}]:
            with self.assertRaises(ValueError):ModelHttpPolicy.from_document(doc)
        with self.assertRaises(Exception):p.bases=()

    def test_private_operator_loader_and_failure_modes(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);root.chmod(0o700);p=root/'policy.json'
            good=json.dumps({'version':1,'allowed_http_model_bases':[BASE]})
            def write(text=good):p.write_text(text);p.chmod(0o600)
            write();self.assertTrue(load_model_http_policy(p).allows(BASE))
            for text in ['{"version":1,"version":1,"allowed_http_model_bases":[]}', 'x'*16385, '{}']:
                write(text)
                with self.assertRaises(ValueError):load_model_http_policy(p)
            write();p.chmod(0o644)
            with self.assertRaises(ValueError):load_model_http_policy(p)
            p.chmod(0o600);alias=root/'alias';alias.symlink_to(p)
            with self.assertRaises((ValueError,OSError)):load_model_http_policy(alias)
            hard=root/'hard';os.link(p,hard)
            with self.assertRaises(ValueError):load_model_http_policy(p)
            hard.unlink();root.chmod(0o755)
            with self.assertRaises(ValueError):load_model_http_policy(p)
            root.chmod(0o700);fifo=root/'fifo';os.mkfifo(fifo,0o600)
            with self.assertRaises(ValueError):load_model_http_policy(fifo)

    def test_management_origin_policy_is_not_broadened(self):
        with self.assertRaises(ValueError):Config('http://8.8.4.4:8080',insecure_local=True)
        self.assertTrue(model_api.valid_base_url('https://provider.test/v1'))
        self.assertFalse(model_api.valid_base_url(BASE))
        self.assertTrue(model_api.valid_base_url(BASE,ModelHttpPolicy((BASE,))))
        self.assertTrue(model_api.valid_base_url('http://172.18.0.1:8080/v1'))
        self.assertTrue(model_api.valid_base_url('http://[::1]:8080/v1'))


class HttpModelAPITests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup)
        self.store=Store(Path(t.name)/'state');self.policy=ModelHttpPolicy((BASE,));self.now=1800000000
        self.app=App(self.store,Config(ORIGIN,allow_registration=True),clock=lambda:self.now,
                     model_http_policy=self.policy,operator_admin=OperatorAdmin(digest(TOKEN)))
        self.alice=Client(self.app);self.assertEqual(self.alice.register()['status'],201)
        self.wid=self.alice.workspace()['body']['workspace']['id']
        token=self.alice.call('POST','/v1/runtime-keys',{'name':'test'})['body']['token']
        self.agent=AgentClient(self.app,token);self.agent.call('POST','/v1/agent/connect',{'hostname':'test'})

    def save(self,fields=FIELDS,path='/v1/model-api',revision=0,**kw):
        return self.alice.call('POST',path,{'revision':revision,'changes':fields},**kw)

    def claim(self):
        result=self.alice.call('POST','/v1/runtime/tasks',{'kind':'infer','prompt':'benign synthetic task'})
        self.assertEqual(result['status'],201,result)
        tid=result['body']['task']['id'];self.assertEqual(self.agent.call('POST',f'/v1/agent/tasks/{tid}/claim',{})['status'],200)
        return tid

    def access(self,tid,cap=FORMAT):
        return self.agent.call('POST',f'/v1/agent/tasks/{tid}/model-access',{},**({WSGI_HEADER:cap} if cap is not None else {}))

    def test_save_issuance_capability_and_write_only_response(self):
        self.assertEqual(self.save()['status'],200)
        seen=self.alice.call('GET','/v1/model-api');self.assertNotIn(SECRET,json.dumps(seen));self.assertNotIn('http_endpoint_grant',json.dumps(seen))
        tid=self.claim();old=self.access(tid,None);self.assertEqual(old['status'],409,old);self.assertEqual(old['body']['error']['code'],'runtime_upgrade_required');self.assertNotIn(SECRET,json.dumps(old))
        granted=self.access(tid);self.assertEqual(granted['status'],200,granted)
        self.assertTrue(valid_grant(BASE,granted['body']['model_api']['http_endpoint_grant']))
        self.assertEqual(self.access(tid)['status'],409)

    def test_user_cannot_expand_policy_or_forge_grants_and_csrf_remains(self):
        for changes in [dict(FIELDS,base_url=BASE+'/other'),dict(FIELDS,http_endpoint_grant=self.policy.grant_for(BASE)),dict(FIELDS,allowed_http_model_bases=[BASE]),dict(FIELDS,allow_http=True)]:
            self.assertEqual(self.save(changes)['status'],400,changes)
        self.assertEqual(self.save(dict(FIELDS,provider='anthropic'))['status'],400)
        self.assertEqual(self.save(csrf=False)['status'],403)
        self.assertEqual(self.save(origin='https://elsewhere.test')['status'],403)
        self.app.model_http_policy=ModelHttpPolicy()
        self.assertEqual(self.save(headers={WSGI_HEADER:FORMAT})['status'],400)

    def test_revoked_policy_blocks_existing_row_without_consuming_grant_and_allows_clear(self):
        self.save();tid=self.claim();self.app.model_http_policy=ModelHttpPolicy()
        denied=self.access(tid);self.assertEqual(denied['status'],409);self.assertNotIn(SECRET,json.dumps(denied))
        self.app.model_http_policy=self.policy;self.assertEqual(self.access(tid)['status'],200)
        self.app.model_http_policy=ModelHttpPolicy();self.assertEqual(self.save({'api_key':None},revision=1)['status'],200)

    def test_platform_and_workspace_scopes_obey_same_policy_override_and_removal(self):
        admin=Client(self.app)
        body={'revision':0,'changes':FIELDS};headers={'HTTP_AUTHORIZATION':'Bearer '+TOKEN}
        result=admin.call('POST','/v1/admin/model-api',body,headers,origin=None,csrf=False);self.assertEqual(result['status'],200,result)
        effective=self.alice.call('GET','/v1/model-api')['body']['effective'];self.assertEqual(effective['source'],'platform')
        local=dict(FIELDS,base_url='https://override.test/v1',api_key='synthetic-user-own-key')
        self.assertEqual(self.save(local)['status'],200)
        self.assertEqual(self.alice.call('GET','/v1/model-api')['body']['effective']['source'],'account')
        path=f'/v1/workspaces/{self.wid}/model-api';self.assertEqual(self.save(path=path)['status'],200)
        self.app.model_http_policy=ModelHttpPolicy()
        # Another account cannot grant a new endpoint via the now-stored platform row.
        other=Client(self.app);other.register('bob');r=other.call('POST','/v1/model-api',body);self.assertEqual(r['status'],400)

    def test_user_endpoint_metadata_cannot_retarget_platform_key(self):
        platform=dict(FIELDS,base_url='https://platform.test/v1')
        result=Client(self.app).call('POST','/v1/admin/model-api',{'revision':0,'changes':platform},
            {'HTTP_AUTHORIZATION':'Bearer '+TOKEN},origin=None,csrf=False)
        self.assertEqual(result['status'],200)
        no_key={k:v for k,v in FIELDS.items() if k!='api_key'}
        self.assertEqual(self.save(no_key)['status'],200)
        tid=self.claim();doc=self.access(tid)['body']['model_api']
        self.assertEqual(doc['base_url'],'https://platform.test/v1');self.assertNotIn('http_endpoint_grant',doc)
        self.assertEqual(self.save(dict(FIELDS,api_key='synthetic-user-own-key'),revision=1)['status'],200)
        tid=self.claim();doc=self.access(tid)['body']['model_api']
        self.assertTrue(valid_grant(BASE,doc['http_endpoint_grant']));self.assertEqual(doc['api_key'],'synthetic-user-own-key')

    def test_api_issued_document_crosses_python_json_to_js_task_consumer(self):
        self.assertEqual(self.save()['status'],200);tid=self.claim();doc=self.access(tid)['body']['model_api']
        script = """
import {readFileSync} from 'node:fs';
import {infer} from './runtime/flybot-image/agent-loop.mjs';
const doc=JSON.parse(readFileSync(0,'utf8'));let count=0;
const text=await infer(doc,'synthetic context',null,async(url,init)=>{
  if(url!==doc.base_url+'/chat/completions'||init.redirect!=='error')throw new Error('wire policy');count++;
  return {ok:true,status:200,json:async()=>({choices:[{message:{content:'cross-language synthetic result'}}]})};
});
let denied=false;try{await infer({...doc,http_endpoint_grant:{...doc.http_endpoint_grant,base_url:doc.base_url+'/other'}},'benign',null,async()=>{count++;throw new Error('unexpected fetch')})}catch{denied=true}
console.log(JSON.stringify({text,count,denied}));
"""
        result=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(doc),text=True,capture_output=True,
            cwd=Path(__file__).resolve().parents[1],timeout=10,check=True)
        data=json.loads(result.stdout);self.assertEqual(data,{'text':'cross-language synthetic result','count':1,'denied':True})
        self.assertNotIn(SECRET,result.stdout+result.stderr)

    def test_save_to_issuance_to_real_loopback_transport_to_persisted_result(self):
        provider,thread,seen=start_fake_provider(SECRET,'synthetic HTTP task result')
        self.addCleanup(lambda:(provider.shutdown(),thread.join(3),provider.server_close()))
        base='http://8.8.4.4:%s/v1'%provider.server_port
        self.app.model_http_policy=ModelHttpPolicy((base,));self.assertEqual(self.save(dict(FIELDS,base_url=base))['status'],200)
        tid=self.claim();grant=self.access(tid)['body']['model_api'];original=socket.create_connection
        def route(address,*args,**kw):
            self.assertEqual(address,('8.8.4.4',provider.server_port))
            return original(('127.0.0.1',provider.server_port),*args,**kw)
        with patch('socket.create_connection',side_effect=route),patch.dict(os.environ,{'HTTP_PROXY':'http://invalid.proxy:9','ALL_PROXY':'http://invalid.proxy:9'}):
            text=infer_chat(grant,'synthetic skill context + benign task')
        self.assertEqual(text,'synthetic HTTP task result');self.assertEqual(seen['count'],1);self.assertEqual(seen['authorization'],'Bearer '+SECRET)
        done=self.agent.call('POST',f'/v1/agent/tasks/{tid}/result',{'status':'succeeded','result':{'text':text}})
        self.assertEqual(done['status'],200);self.assertNotIn(SECRET,json.dumps(done))
        persisted=self.alice.call('GET',f'/v1/runtime/tasks/{tid}');self.assertEqual(persisted['body']['task']['result']['text'],text)


class LeaseSecretPolicyTests(unittest.TestCase):
    create=runtime_fixtures.RuntimeTests.create
    manager=runtime_fixtures.RuntimeTests.manager
    manager_call=runtime_fixtures.RuntimeTests.manager_call

    def setUp(self):
        runtime_fixtures.RuntimeTests.setUp(self);self.app.model_http_policy=ModelHttpPolicy((BASE,))
        self.client.call('POST','/v1/model-api',{'revision':0,'changes':FIELDS})
        self.iid=self.create()['instance']['id'];self.identity=self.manager(self.iid)
        self.claim=self.manager_call('POST','/v1/internal/jobs/claim',{'instance_id':self.iid})['body']['claim']
        self.path=f'/v1/internal/instances/{self.iid}/runtime-secret'
        self.body={'job_id':self.claim['job']['id'],'observed_revision':self.claim['job']['revision'],'lease':self.claim['lease']}

    def test_lease_capability_and_removed_policy_are_checked_before_returning_secret(self):
        old=self.manager_call('POST',self.path,self.body);self.assertEqual(old['status'],409);self.assertNotIn(SECRET,json.dumps(old))
        good=self.manager_call('POST',self.path,self.body,**{WSGI_HEADER:FORMAT});self.assertEqual(good['status'],200,good)
        doc=good['body']['model_api'];self.assertTrue(valid_grant(BASE,doc['http_endpoint_grant']))
        self.app.model_http_policy=ModelHttpPolicy()
        revoked=self.manager_call('POST',self.path,self.body,**{WSGI_HEADER:FORMAT});self.assertEqual(revoked['status'],409);self.assertNotIn(SECRET,json.dumps(revoked))
        badlease=self.manager_call('POST',self.path,dict(self.body,lease='wrong'),**{WSGI_HEADER:FORMAT});self.assertNotEqual(badlease['status'],200)

    def test_real_manager_http_client_advertises_capability_to_server(self):
        from wsgiref.simple_server import make_server
        from openteamily.server import QuietHandler
        import threading
        server=make_server('127.0.0.1',0,self.app,handler_class=QuietHandler)
        thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01},daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),thread.join(3),server.server_close()))
        client=ManagerClient('http://127.0.0.1:%s'%server.server_port,'manager-a',self.token,enabled=True,host_header='management.test')
        doc=client.runtime_secret(self.iid,self.claim);self.assertTrue(valid_grant(BASE,doc['http_endpoint_grant']))
        self.app.model_http_policy=ModelHttpPolicy()
        with self.assertRaises(ManagerError):client.runtime_secret(self.iid,self.claim)

    def test_manager_client_and_image_capability_fail_before_materialization(self):
        payload=dict(FIELDS,source='user',http_endpoint_grant=self.app.model_http_policy.grant_for(BASE))
        client=object.__new__(ManagerClient)
        client.call=lambda *a,**kw:{'model_api_present':True,'model_api':payload}
        self.assertEqual(client.runtime_secret(self.iid,self.claim),payload)
        payload['http_endpoint_grant']=dict(payload['http_endpoint_grant'],all_http=True)
        with self.assertRaises(ManagerError):client.runtime_secret(self.iid,self.claim)
        payload['http_endpoint_grant']=ModelHttpPolicy((BASE,)).grant_for(BASE)
        root=Path(self.temp.name)/'secret-operator';root.mkdir(mode=0o700);(root/'secrets').mkdir(mode=0o700)
        image='operator/runtime@sha256:'+'a'*64
        registry=SimpleNamespace(root=root,config={'instances':{self.iid:{'image':image}}},entry=lambda iid:None)
        labels={};calls=[]
        def run(argv,**kw):calls.append(argv);return json.dumps(labels),''
        engine=ComposeEngine(registry,SimpleNamespace(run=run))
        with self.assertRaises(ManagerError):engine.install_secret(self.iid,payload)
        self.assertFalse(engine.secret_path(self.iid).exists())
        labels['io.openteamily.model-http']=FORMAT;engine.install_secret(self.iid,payload)
        self.assertEqual(json.loads(engine.secret_path(self.iid).read_text()),payload)
        self.assertEqual(calls[-1],['image','inspect',image,'--format','{{json .Config.Labels}}'])


class OutboundTransportTests(unittest.TestCase):
    def doc(self,base=BASE):return dict(FIELDS,base_url=base,http_endpoint_grant=ModelHttpPolicy((base,)).grant_for(base))

    def test_bad_grant_stops_python_before_transport(self):
        calls=[]
        for grant in [None,{},True,{'format':FORMAT,'base_url':BASE+'/other'},{'format':FORMAT,'base_url':BASE,'extra':1}]:
            doc=self.doc();doc['http_endpoint_grant']=grant
            with self.assertRaises(AgentError):infer_chat(doc,'benign',opener=lambda *a,**kw:calls.append(a))
        self.assertEqual(calls,[])

    def test_https_uses_verified_context_without_public_http_grant(self):
        contexts=[]
        class Response(io.BytesIO):
            pass
        def fake(req,**kw):
            self.assertEqual(req.full_url,'https://provider.test/v1/chat/completions');contexts.append(kw['context'])
            return Response(b'{"choices":[{"message":{"content":"HTTPS fake"}}]}')
        doc=dict(FIELDS,base_url='https://provider.test/v1')
        self.assertEqual(infer_chat(doc,'benign',opener=fake),'HTTPS fake')
        self.assertTrue(contexts[0].check_hostname);self.assertEqual(contexts[0].verify_mode,ssl.CERT_REQUIRED)

    def test_actual_urllib_redirect_denied_and_credential_never_forwarded(self):
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        import threading
        seen={'provider':0,'exfil':0,'auth':None};code=[302];location=[''];
        class Trap(BaseHTTPRequestHandler):
            def do_GET(self):seen['exfil']+=1;self.send_response(200);self.end_headers()
            do_POST=do_GET
            def log_message(self,*a):pass
        trap=ThreadingHTTPServer(('127.0.0.1',0),Trap)
        class Provider(BaseHTTPRequestHandler):
            def do_POST(self):
                seen['provider']+=1;seen['auth']=self.headers.get('Authorization')
                self.send_response(code[0]);self.send_header('Location',location[0]);self.send_header('Content-Length','0');self.end_headers()
            do_GET=do_POST
            def log_message(self,*a):pass
        provider=ThreadingHTTPServer(('127.0.0.1',0),Provider)
        threads=[]
        for server in [provider,trap]:
            t=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01},daemon=True);t.start();threads.append(t)
        self.addCleanup(lambda:[(s.shutdown(),t.join(3),s.server_close()) for s,t in zip([provider,trap],threads)])
        base='http://8.8.4.4:%s/v1'%provider.server_port;original=socket.create_connection
        def route(address,*a,**kw):
            self.assertEqual(address,('8.8.4.4',provider.server_port),'No redirected destination may be dialed')
            return original(('127.0.0.1',provider.server_port),*a,**kw)
        for status in [301,302,303,307,308]:
            code[0]=status
            for target in ['http://127.0.0.1:%s/steal'%trap.server_port,base+'/other']:
                location[0]=target
                with self.subTest(status=status,target=target),patch('socket.create_connection',side_effect=route):
                    with self.assertRaises(AgentError) as e:infer_chat(self.doc(base),'benign')
                    self.assertNotIn(SECRET,str(e.exception))
        self.assertEqual(seen['provider'],10);self.assertEqual(seen['exfil'],0);self.assertEqual(seen['auth'],'Bearer '+SECRET)

    def test_python_agent_advertises_capability_without_changing_request_body(self):
        from openteamily.flybot import request
        class Response(io.BytesIO):status=200
        def fake(req,**kw):
            headers={k.lower():v for k,v in req.header_items()}
            self.assertEqual(headers['x-openteamily-model-http'],FORMAT)
            self.assertEqual(json.loads(req.data),{'skill_format':'openteamily.prompt-skill.v2'})
            return Response(b'{}')
        with patch('openteamily.flybot.urlopen',side_effect=fake):
            request('https://management.test','POST','/v1/agent/tasks/'+'a'*32+'/model-access','synthetic-runtime',{'skill_format':'openteamily.prompt-skill.v2'})

    def test_reserved_addresses_do_not_sneak_through_legacy_private_heuristic(self):
        for ip in ['0.1.2.3','192.0.2.1','198.18.0.1','203.0.113.1','224.0.0.1','239.1.2.3','240.0.0.1','255.255.255.255']:
            self.assertFalse(model_api.valid_base_url('http://'+ip+':8080/v1',ModelHttpPolicy((BASE,))),ip)
