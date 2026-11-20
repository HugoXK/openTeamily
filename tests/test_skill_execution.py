"""Synthetic local provider, actual persistence/daemon/scheduler paths; not vendor acceptance."""
import json
import unittest
from openteamily.app import App
from openteamily.store import Store
from openteamily.settings_page import SettingsPage
from tests.test_settings_page import RawClient
from openteamily.flybot import AgentError, handle_task, run_cycle
from openteamily.scheduler import Scheduler, AgentAutomationBackend
from tests import test_skill_packages as skill_helpers
from tests import test_scheduler as scheduler_helpers
from tests.test_management import Client, PASSWORD


class SkillExecutionTests(unittest.TestCase):
    setUp = skill_helpers.SkillPackageTests.setUp
    start_provider = skill_helpers.SkillPackageTests.start_provider
    package = skill_helpers.SkillPackageTests.package
    binding = skill_helpers.SkillPackageTests.binding
    install = skill_helpers.SkillPackageTests.install
    requester = skill_helpers.SkillPackageTests.requester
    create_automation = scheduler_helpers.SchedulerTests.create

    def capable(self, agent):
        result = agent.call('POST','/v1/agent/connect',{'hostname':'compatible-runtime','skill_formats':['openteamily.prompt-skill.v1']})
        self.assertEqual(result['status'],200,result)

    def run_skill(self, scope='account', key='skill-execution-00001', **changes):
        return self.alice.call('POST','/v1/skills/runs',{'scope':scope,'skill_id':self.package()['id'],'prompt':'Summarize this supplied transcript: test first.',**changes},{'HTTP_IDEMPOTENCY_KEY':key})

    def execute(self, agent, task):
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{task["id"]}/claim',{})['status'],200)
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{task["id"]}/tools',{})['status'],403)
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{task["id"]}/result',{'status':'succeeded','result':{'text':'pretend without model access'}})['status'],409)
        status,result=handle_task(task,'http://127.0.0.1','synthetic',requester=self.requester(agent))
        self.assertEqual(status,'succeeded',result)
        done=agent.call('POST',f'/v1/agent/tasks/{task["id"]}/result',{'status':status,'result':result})
        self.assertEqual(done['status'],200,done)

    def test_readiness_detects_actual_legacy_offline_model_and_downgrade_without_secret(self):
        self.assertEqual(self.alice.call('GET','/v1/skills/readiness')['body']['code'],'runtime_offline')
        agent,_=self.start_provider()
        self.assertEqual(self.alice.call('GET','/v1/skills/readiness')['body']['code'],'runtime_upgrade_required')
        self.capable(agent)
        state=self.alice.call('GET','/v1/skills/readiness')
        self.assertTrue(state['body']['ready'],state)
        self.assertNotIn('api_key',json.dumps(state['body']))
        self.assertEqual(agent.call('POST','/v1/agent/connect',{'skill_formats':['../../evil']})['status'],400)
        agent.call('POST','/v1/agent/connect',{'hostname':'old-runtime'})
        self.assertEqual(self.alice.call('GET','/v1/skills/readiness')['body']['code'],'runtime_upgrade_required')
        self.assertEqual(self.alice.call('GET','/v1/skills/readiness?scope=../../x')['status'],404)
        self.assertEqual(self.alice.call('GET','/v1/skills/readiness?scope=account&scope=account')['status'],400)

    def test_isolated_run_model_content_restart_replay_cancel_and_real_artifact(self):
        agent,seen=self.start_provider();self.capable(agent);self.install()
        other=self.alice.call('GET','/v1/skills/catalog')['body']['items'][1]
        self.assertEqual(self.alice.call('POST','/v1/skills/bindings',self.binding(other))['status'],200)
        made=self.run_skill();self.assertEqual(made['status'],201,made);task=made['body']['task']
        self.assertFalse(made['body']['verified'])
        self.assertEqual(self.run_skill()['body']['task']['id'],task['id'])
        self.assertEqual(self.run_skill(prompt='different')['status'],409)
        self.assertEqual(self.bob.call('GET','/v1/skills/runs')['body']['items'],[])
        self.execute(agent,task)
        prompt=json.loads(seen['body'])['messages'][0]['content']
        embedded=json.loads(prompt.split('permission):\n',1)[1].split('\n\nUser task:',1)[0])
        self.assertEqual([i['id'] for i in embedded],[self.package()['id']])
        self.assertNotIn(other['content'],prompt)
        history=self.alice.call('GET','/v1/skills/runs')['body']['items'];self.assertTrue(history[0]['verified'])
        reopened=App(Store(self.app.store.data_dir),self.app.config,clock=lambda:1800000000)
        fresh=Client(reopened);self.assertEqual(fresh.call('POST','/v1/auth/login',{'username':'alice','password':PASSWORD})['status'],200)
        self.assertTrue(fresh.call('GET','/v1/skills/runs')['body']['items'][0]['verified'])
        save=f'/v1/runtime/tasks/{task["id"]}/artifact'
        saved=self.alice.call('POST',save,{'workspace_id':self.wid});self.assertEqual(saved['status'],201,saved)
        self.assertEqual(self.alice.call('POST',save,{'workspace_id':self.wid})['body']['artifact']['id'],saved['body']['artifact']['id'])
        self.assertEqual(self.bob.call('POST',save,{'workspace_id':self.wid})['status'],404)
        artifact = saved['body']['artifact']['id']
        # Exercise the actual HTML wrapper, then its authenticated document API.
        wrapped = SettingsPage(reopened)
        self.assertEqual(RawClient(wrapped).call('GET', '/space', query=f'workspace={self.wid}&artifact={artifact}')['status'], 200)
        endpoint = f'/v1/workspaces/{self.wid}/artifacts/{artifact}'
        self.assertEqual(fresh.call('GET', endpoint)['status'], 200)
        anonymous = Client(wrapped)
        self.assertEqual(anonymous.call('GET', endpoint)['status'], 401)
        outsider = Client(wrapped)
        outsider.register('outside')
        self.assertIn(outsider.call('GET', endpoint)['status'], (403, 404))
        self.assertEqual(fresh.call('GET', f'/v1/workspaces/{"f" * 32}/artifacts/{artifact}')['status'], 404)
        self.assertEqual(fresh.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{"e" * 32}')['status'], 404)

        pending=self.run_skill(key='skill-execution-00002')['body']['task']
        self.assertEqual(self.alice.call('POST',f'/v1/runtime/tasks/{pending["id"]}/cancel',{})['body']['task']['status'],'cancelled')

    def test_uninstall_cancels_queued_selected_task_before_any_material_access(self):
        agent,seen=self.start_provider();self.capable(agent);self.install()
        made=self.run_skill();task=made['body']['task'];self.install(enabled=False)
        view=self.alice.call('GET',f'/v1/runtime/tasks/{task["id"]}')
        self.assertEqual(view['body']['task']['status'],'cancelled')
        self.assertEqual(seen['count'],0)
        self.assertEqual(self.run_skill(key='skill-execution-00002')['status'],409)
        self.assertFalse(self.alice.call('GET','/v1/skills/runs')['body']['items'][0]['verified'])
        self.assertEqual(self.alice.call('POST','/v1/skills/runs',{},csrf=False)['status'],403)
        for invalid in ({},[], '../bad',None):
            self.assertEqual(self.run_skill(key='skill-invalid-type001',skill_id=invalid)['status'],400)

    def test_scheduled_skill_is_explicit_owned_and_never_inherits_account_packages(self):
        agent,seen=self.start_provider();self.capable(agent)
        aid=self.create_automation();scope='automation:'+self.wid+':'+aid
        self.install(scope=scope)
        other=self.alice.call('GET','/v1/skills/catalog')['body']['items'][1]
        self.alice.call('POST','/v1/skills/bindings',self.binding(other))
        self.assertEqual(self.bob.call('POST','/v1/skills/bindings',self.binding(scope=scope))['status'],403)
        scheduler=Scheduler(self.app.store,AgentAutomationBackend(),clock=lambda:1800000000)
        fired=scheduler.tick_all();self.assertEqual(len(fired),1,fired)
        task=agent.call('GET','/v1/agent/tasks')['body']['items'][0]
        self.execute(agent,task)
        embedded=json.loads(json.loads(seen['body'])['messages'][0]['content'].split('permission):\n',1)[1].split('\n\nUser task:',1)[0])
        self.assertEqual([i['id'] for i in embedded],[self.package()['id']])
        runs=scheduler.reconcile_all();self.assertEqual(runs[0]['status'],'succeeded',runs)
        scopes=self.alice.call('GET','/v1/skills/scopes')['body']['items'];self.assertIn(scope,[i['scope'] for i in scopes])
        self.assertNotIn(scope,[i['scope'] for i in self.bob.call('GET','/v1/skills/scopes')['body']['items']])
        history=self.alice.call('GET','/v1/skills/runs')['body']['items'];self.assertTrue(history[0]['verified']);self.assertEqual(history[0]['scope'],scope)
        self.install(scope=scope,enabled=False)
        self.assertEqual(self.run_skill(scope=scope,key='skill-execution-00004')['status'],409)

    def test_automation_does_not_delegate_private_skills_or_accept_legacy_runtime(self):
        agent,_=self.start_provider();aid=self.create_automation();scope='automation:'+self.wid+':'+aid;self.install(scope=scope)
        backend=AgentAutomationBackend()
        payload={'workspace_id':self.wid,'automation_id':aid,'now':1800000000,'prompt':'test'}
        with self.app.store.transaction() as db:
            self.assertEqual(backend.dispatch_automation(payload,db=db)['error_code'],'runtime_upgrade_required')
            db.execute('UPDATE runtime_connections SET last_seen=0')
            result=backend.dispatch_automation(payload,db=db)
            self.assertEqual(result['error_code'],'no_agent')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_tasks').fetchone()[0],0)

    def test_python_daemon_cancelled_claim_and_result_do_not_kill_later_work(self):
        tasks=[{'id':str(i),'kind':'echo','prompt':'task'}for i in range(3)];seen=[]
        def request(origin,method,path,token,body=None):
            if path.endswith('/connect'):
                self.assertEqual(body['skill_formats'],['openteamily.prompt-skill.v1','openteamily.prompt-skill.v2']);return 200,{'connection':{'id':'own'}}
            if path.endswith('/tasks'):return 200,{'items':tasks}
            if '/0/claim' in path:raise AgentError(409,{})
            if '/1/result' in path:raise AgentError(409,{})
            if path.endswith('/claim'):return 200,{'task':next(t for t in tasks if '/'+t['id']+'/' in path)}
            if path.endswith('/result'):seen.append(path)
            return 200,{}
        _,done=run_cycle('http://127.0.0.1','synthetic','test',once=True,requester=request)
        self.assertEqual(done,['2']);self.assertEqual(len(seen),1)
        def forbidden(*args,**kwargs):raise AgentError(403,{})
        with self.assertRaises(AgentError):run_cycle('http://127.0.0.1','synthetic','test',once=True,requester=forbidden)

    def test_regular_member_account_skill_reaches_real_agent_conversation_model_context(self):
        _alice_runtime,seen=self.start_provider()
        from tests.test_runtime_connect import AgentClient
        token=self.bob.call('POST','/v1/runtime-keys',{'name':'bob-own-runtime'})['body']['token']
        runtime=AgentClient(self.app,token)
        self.assertEqual(runtime.call('POST','/v1/agent/connect',{'hostname':'bob-own-runtime','skill_formats':['openteamily.prompt-skill.v1']})['status'],201)
        self.assertEqual(self.bob.call('POST','/v1/skills/bindings',self.binding())['status'],200)
        base=f'/v1/workspaces/{self.wid}/agents'
        made=self.alice.call('POST',base,{'name':'Member skill test','summary':'','instructions':''},{'HTTP_IDEMPOTENCY_KEY':'member-skill-agent001'})
        aid=made['body']['agent']['id']
        conversation=self.bob.call('POST',base+f'/{aid}/conversations',{'title':'Member skill'},{'HTTP_IDEMPOTENCY_KEY':'member-skill-conv0001'})
        cid=conversation['body']['conversation']['id']
        sent=self.bob.call('POST',base+f'/{aid}/conversations/{cid}/messages',{'body':'Use my installed meeting skill on: We agreed to test.'},{'HTTP_IDEMPOTENCY_KEY':'member-skill-message1'})
        self.assertEqual(sent['status'],201,sent)
        tid=sent['body']['reply']['task_id']
        task=next(t for t in runtime.call('GET','/v1/agent/tasks')['body']['items']if t['id']==tid)
        runtime.call('POST',f'/v1/agent/tasks/{tid}/claim',{})
        status,result=handle_task(task,'http://127.0.0.1','synthetic',requester=self.requester(runtime))
        self.assertEqual(status,'succeeded',result)
        self.assertIn(self.package()['content'],json.loads(json.loads(seen['body'])['messages'][0]['content'].split('permission):\n',1)[1].split('\n\nUser task:',1)[0])[0]['content'])

    def test_other_administrator_cannot_take_over_installed_automation_skills(self):
        aid=self.create_automation();scope='automation:'+self.wid+':'+aid;self.install(scope=scope)
        bob_id=self.bob.call('GET','/v1/auth/session')['body']['user']['id']
        response=self.alice.call('POST',f'/v1/workspaces/{self.wid}/members/{bob_id}',{'role':'admin'})
        self.assertEqual(response['status'],200,response)
        self.assertEqual(self.bob.call('POST','/v1/skills/bindings',self.binding(scope=scope))['status'],409)
        self.assertEqual(self.bob.call('POST','/v1/skills/bindings',self.binding(scope=scope,enabled=False))['status'],200)
        self.assertEqual(len(self.alice.call('GET','/v1/skills/bindings')['body']['items']),1)
