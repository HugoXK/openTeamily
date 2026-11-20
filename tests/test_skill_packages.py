"""Real install/material/ack/model-context lifecycle against a synthetic provider only."""
import copy
import json
import unittest
from openteamily import skill_packages
from openteamily.app import App, Config
from openteamily.store import Store
from openteamily.flybot import AgentError, handle_task, load_skill_material
from tests import test_social_message_tools as helpers
from tests import test_message_utilities as utility_helpers
from tests.test_management import ORIGIN, Client, PASSWORD


class SkillPackageTests(unittest.TestCase):
    setUp = helpers.MessageToolTests.setUp
    start_provider = utility_helpers.UtilityTests.start_provider

    def package(self):
        seen=self.alice.call('GET','/v1/skills/catalog')
        self.assertEqual(seen['status'],200,seen)
        return seen['body']['items'][0]

    def binding(self,item=None,scope='account',enabled=True,**changes):
        item=item or self.package()
        return {'skill_id':item['id'],'version':item['version'],'digest':item['digest'],'scope':scope,'enabled':enabled,'permissions':['model_context'],**changes}

    def install(self,**changes):
        response=self.alice.call('POST','/v1/skills/bindings',self.binding(**changes))
        self.assertEqual(response['status'],200,response)
        return response

    def test_content_version_permission_ownership_persistence_and_no_archive_surface(self):
        item=self.package();self.assertGreater(len(item['content']),150)
        body=self.binding(item)
        self.assertEqual(self.alice.call('POST','/v1/skills/bindings',body,csrf=False)['status'],403)
        for changes in ({'skill_id':'../evil'},{'skill_id':'archive.zip'},{'permissions':['shell']},{'scope':'../../tmp'}):
            self.assertIn(self.alice.call('POST','/v1/skills/bindings',{**body,**changes})['status'],(400,404))
        for changes in ({'version':'9.9.9'},{'digest':'0'*64}):
            self.assertEqual(self.alice.call('POST','/v1/skills/bindings',{**body,**changes})['status'],409)
        for extra in ('archive','path','files','script','user_id'):
            self.assertEqual(self.alice.call('POST','/v1/skills/bindings',{**body,extra:'untrusted'})['status'],400)
        self.install();self.install()
        self.assertEqual(len(self.alice.call('GET','/v1/skills/bindings')['body']['items']),1)
        self.assertEqual(self.bob.call('GET','/v1/skills/bindings')['body']['items'],[])
        reopened=App(Store(self.app.store.data_dir),Config(ORIGIN,allow_registration=True),clock=lambda:1800000000)
        fresh=Client(reopened)
        self.assertEqual(fresh.call('POST','/v1/auth/login',{'username':'alice','password':PASSWORD})['status'],200)
        self.assertEqual(fresh.call('GET','/v1/skills/bindings')['body']['items'][0]['digest'],item['digest'])
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM skill_bindings').fetchone()[0],1)
        self.install(enabled=False)
        self.assertEqual(self.alice.call('GET','/v1/skills/bindings')['body']['items'],[])

    def task(self):
        made=self.alice.call('POST','/v1/runtime/tasks',{'kind':'infer','prompt':'Summarize the supplied transcript: We decided to test first.'})
        self.assertEqual(made['status'],201,made)
        return made['body']['task']

    def requester(self,agent):
        def request(origin,method,path,token,body=None):
            response=agent.call(method,path,body)
            if response['status']>=400: raise AgentError(response['status'],response['body'])
            return response['status'],response['body']
        return request

    def test_daemon_model_gets_installed_content_then_uninstall_removes_it(self):
        agent,seen=self.start_provider();self.install();item=self.package()
        task=self.task();agent.call('POST',f'/v1/agent/tasks/{task["id"]}/claim',{})
        status,result=handle_task(task,ORIGIN,'synthetic-runtime-token',requester=self.requester(agent))
        self.assertEqual(status,'succeeded',result)
        model_prompt=json.loads(seen['body'])['messages'][0]['content']
        embedded=json.loads(model_prompt.split('permission):\n',1)[1].split('\n\nUser task:',1)[0])
        self.assertEqual(embedded[0]['content'],item['content'])
        done=agent.call('POST',f'/v1/agent/tasks/{task["id"]}/result',{'status':status,'result':result})
        self.assertEqual(done['status'],200,done)
        bindings=self.alice.call('GET','/v1/skills/bindings')['body']['items']
        self.assertEqual(bindings[0]['last_loaded_task'],task['id'])
        self.install(enabled=False)
        next_task=self.task();agent.call('POST',f'/v1/agent/tasks/{next_task["id"]}/claim',{})
        status,result=handle_task(next_task,ORIGIN,'synthetic-runtime-token',requester=self.requester(agent))
        self.assertEqual(status,'succeeded',result)
        self.assertNotIn('Installed instruction-only skills',json.loads(seen['body'])['messages'][0]['content'])
        self.assertEqual(seen['count'],2)

    def test_revocation_before_ack_cancels_loaded_task_and_old_runtime_cannot_claim_success(self):
        agent,_seen=self.start_provider();self.install();item=self.package();task=self.task();tid=task['id']
        agent.call('POST',f'/v1/agent/tasks/{tid}/claim',{})
        legacy=agent.call('POST',f'/v1/agent/tasks/{tid}/model-access',{})
        self.assertEqual(legacy['status'],409,legacy)
        self.assertEqual(legacy['body']['error']['code'],'runtime_upgrade_required')
        access=agent.call('POST',f'/v1/agent/tasks/{tid}/model-access',{'skill_format':'openteamily.prompt-skill.v1'})
        self.assertEqual(access['body']['skills'][0]['digest'],item['digest'])
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{tid}/result',{'status':'succeeded','result':{'text':'pretend'}})['status'],409)
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{tid}/skills/ack',{'digests':['0'*64]})['status'],409)
        self.install(enabled=False)
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{tid}/skills/ack',{'digests':[item['digest']]})['status'],409)
        self.assertEqual(self.alice.call('GET',f'/v1/runtime/tasks/{tid}')['body']['task']['status'],'cancelled')

    def test_agent_scope_permission_and_runtime_material_is_not_global(self):
        agent,seen=self.start_provider();base=f'/v1/workspaces/{self.wid}/agents'
        made=self.alice.call('POST',base,{'name':'Scoped','summary':'','instructions':''},{'HTTP_IDEMPOTENCY_KEY':'scoped-skill-agent-01'})
        self.assertEqual(made['status'],201,made);aid=made['body']['agent']['id'];scope=self.wid+':'+aid
        body=self.binding(scope=scope)
        self.assertEqual(self.bob.call('POST','/v1/skills/bindings',body)['status'],403)
        self.install(scope=scope)
        self.assertEqual(self.bob.call('POST','/v1/skills/bindings',{**body,'enabled':False})['status'],200)
        self.assertEqual(len(self.alice.call('GET','/v1/skills/bindings')['body']['items']),1)
        task=self.task();agent.call('POST',f'/v1/agent/tasks/{task["id"]}/claim',{})
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{task["id"]}/model-access',{'skill_format':'openteamily.prompt-skill.v1'})['body']['skills'],[])
        conv=self.alice.call('POST',base+f'/{aid}/conversations',{'title':'Scoped'},{'HTTP_IDEMPOTENCY_KEY':'scoped-skill-conv-001'})['body']['conversation']['id']
        sent=self.alice.call('POST',base+f'/{aid}/conversations/{conv}/messages',{'body':'Use my installed skill.'},{'HTTP_IDEMPOTENCY_KEY':'scoped-skill-message1'})
        self.assertEqual(sent['status'],201,sent);tid=sent['body']['reply']['task_id']
        task=next(t for t in agent.call('GET','/v1/agent/tasks')['body']['items'] if t['id']==tid)
        agent.call('POST',f'/v1/agent/tasks/{tid}/claim',{})
        other_key=self.bob.call('POST','/v1/runtime-keys',{'name':'bob-runtime'})['body']['token']
        other=utility_helpers.AgentClient(self.app,other_key)
        self.assertEqual(other.call('POST','/v1/agent/connect',{'hostname':'bob-runtime'})['status'],201)
        self.assertEqual(other.call('POST',f'/v1/agent/tasks/{tid}/skills/ack',{'digests':[body['digest']]})['status'],404)
        status,result=handle_task(task,ORIGIN,'synthetic-runtime-token',requester=self.requester(agent))
        self.assertEqual(status,'succeeded',result)
        embedded=json.loads(json.loads(seen['body'])['messages'][0]['content'].split('permission):\n',1)[1].split('\n\nUser task:',1)[0])
        self.assertEqual([i['id'] for i in embedded],[body['skill_id']])
        self.assertEqual(self.alice.call('POST',base+f'/{aid}/archive',{'revision':1})['status'],200)
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{tid}/skills/ack',{'digests':[body['digest']]})['status'],409)
        self.assertEqual(self.alice.call('POST','/v1/skills/bindings',{**body,'enabled':False})['status'],200)
        self.assertEqual(self.alice.call('GET','/v1/skills/bindings')['body']['items'],[])

    def test_runtime_rejects_path_archive_version_content_and_permission_injection(self):
        item=self.package()
        for changes in ({'id':'../../tmp'},{'version':'../../1'},{'content':item['content']+'tampered'},{'permissions':['exec']},{'files':['../SKILL.md']},{'archive':'evil.zip'}):
            with self.assertRaises(AgentError):load_skill_material([{**item,**changes}],'task')
        self.assertEqual(load_skill_material([],'unchanged'),'unchanged')
