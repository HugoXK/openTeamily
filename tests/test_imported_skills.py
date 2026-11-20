"""Real persistence/runtime prompt tests against a controlled local provider, NOT vendor acceptance."""
import copy
import hashlib
import json
import unittest
from openteamily.app import App
from openteamily.store import Store
from openteamily import imported_skills
from openteamily.flybot import AgentError, load_skill_material, handle_task
from tests.test_management import Client,PASSWORD,ORIGIN
from tests import test_skill_packages as skill_helpers
from tests import test_skill_execution as execution_helpers

class ImportedSkillTests(unittest.TestCase):
    setUp=skill_helpers.SkillPackageTests.setUp
    start_provider=skill_helpers.SkillPackageTests.start_provider
    binding=skill_helpers.SkillPackageTests.binding
    requester=skill_helpers.SkillPackageTests.requester
    task=skill_helpers.SkillPackageTests.task
    execute=execution_helpers.SkillExecutionTests.execute

    def package(self,**changes):
        return {'id':'import-test-evidence','name':'Original evidence check','version':'1.0.0','format':imported_skills.FORMAT,
                'permissions':['model_context'],'content':'IMPORTED-CONTEXT-SYNTHETIC-ONLY. Read the supplied evidence, quote support, mark unsupported claims. Do not invent sources or execute actions.',**changes}
    def save(self,item=None,revision=0,**changes):
        return self.alice.call('POST','/v1/skills/packages',{'package':item or self.package(),'revision':revision,'consent':True,**changes})
    def import_and_install(self):
        result=self.save();self.assertEqual(result['status'],200,result);item=result['body']['package']
        self.assertEqual(self.alice.call('POST','/v1/skills/bindings',self.binding(item))['status'],200)
        return item
    def run_skill(self,key='import-runtime-test-0001'):
        return self.alice.call('POST','/v1/skills/runs',{'scope':'account','skill_id':self.package()['id'],'prompt':'Check this supplied evidence: build passed.'},{'HTTP_IDEMPOTENCY_KEY':key})

    def test_actual_import_binding_restart_model_context_update_cancel_and_revoke(self):
        agent,seen=self.start_provider();item=self.import_and_install()
        self.assertEqual(self.run_skill()['body']['error']['code'],'runtime_upgrade_required')
        ready=agent.call('POST','/v1/agent/connect',{'hostname':'import-v2-fixture','skill_formats':['openteamily.prompt-skill.v1',imported_skills.FORMAT]})
        self.assertEqual(ready['status'],200,ready)
        made=self.run_skill();self.assertEqual(made['status'],201,made);self.execute(agent,made['body']['task'])
        prompt=json.loads(seen['body'])['messages'][0]['content'];self.assertIn(item['content'],prompt)
        self.assertTrue(self.alice.call('GET','/v1/skills/runs')['body']['items'][0]['verified'])
        reopened=App(Store(self.app.store.data_dir),self.app.config,clock=lambda:1800000000);fresh=Client(reopened)
        self.assertEqual(fresh.call('POST','/v1/auth/login',{'username':'alice','password':PASSWORD})['status'],200)
        self.assertIn(item,fresh.call('GET','/v1/skills/catalog')['body']['items'])
        self.assertEqual(fresh.call('GET','/v1/skills/bindings')['body']['items'][0]['digest'],item['digest'])
        pending=self.run_skill('import-runtime-test-0002')['body']['task']
        changed=self.package(version='1.1.0',content='UPDATED-CONTEXT-ONLY. '+self.package()['content'])
        updated=self.save(changed,1);self.assertEqual(updated['status'],200,updated)
        self.assertEqual(self.alice.call('GET',f'/v1/runtime/tasks/{pending["id"]}')['body']['task']['status'],'cancelled')
        self.assertEqual(self.run_skill('import-runtime-test-0003')['body']['error']['code'],'skill_not_installed')
        self.assertEqual(self.alice.call('POST','/v1/skills/bindings',self.binding(item))['status'],409)
        new=updated['body']['package'];self.assertEqual(self.alice.call('POST','/v1/skills/bindings',self.binding(new))['status'],200)
        queued=self.run_skill('import-runtime-test-0004')['body']['task']
        revoke=self.alice.call('POST','/v1/skills/packages/'+item['id']+'/revoke',{'revision':2});self.assertEqual(revoke['status'],200,revoke)
        self.assertEqual(self.alice.call('GET',f'/v1/runtime/tasks/{queued["id"]}')['body']['task']['status'],'cancelled')
        self.assertEqual(self.alice.call('GET','/v1/skills/bindings')['body']['items'],[])
        self.assertNotIn(new,self.alice.call('GET','/v1/skills/catalog')['body']['items'])
        ordinary=self.task();agent.call('POST',f'/v1/agent/tasks/{ordinary["id"]}/claim',{})
        status,result=handle_task(ordinary,ORIGIN,'synthetic',requester=self.requester(agent));self.assertEqual(status,'succeeded',result)
        self.assertNotIn('IMPORTED-CONTEXT',json.loads(seen['body'])['messages'][0]['content'])
        self.assertNotIn('UPDATED-CONTEXT',json.loads(seen['body'])['messages'][0]['content'])
        restarted=Client(App(Store(self.app.store.data_dir),self.app.config,clock=lambda:1800000000));restarted.call('POST','/v1/auth/login',{'username':'alice','password':PASSWORD})
        self.assertNotIn(new,restarted.call('GET','/v1/skills/catalog')['body']['items'])

    def test_owner_isolation_immutable_versions_export_cas_and_consent(self):
        item=self.save()['body']['package'];path='/v1/skills/packages/'+item['id']
        self.assertEqual(self.save()['status'],409) # revision 0 cannot overwrite revision 1
        self.assertEqual(self.save(revision=1)['body']['revision'],1) # exact idempotence
        self.assertEqual(self.save(self.package(content='changed'),1)['status'],409)
        self.assertEqual(self.save(self.package(version='0.9.0'),1)['status'],409)
        self.assertEqual(self.save(self.package(version='1.1.0'),1,consent=False)['status'],400)
        self.assertNotIn(item,self.bob.call('GET','/v1/skills/catalog')['body']['items'])
        for route in (path,path+'/versions',path+'/versions/1.0.0'):
            self.assertEqual(self.bob.call('GET',route)['status'],404)
        self.assertEqual(self.bob.call('POST',path+'/revoke',{'revision':1})['status'],404)
        self.assertEqual(self.alice.call('POST',path+'/revoke',{'revision':0})['status'],409)
        saved=self.alice.call('GET',path+'/versions/1.0.0');self.assertEqual(saved['status'],200,saved)
        self.assertEqual(saved['body'],item)
        self.assertIn('attachment',dict(saved['headers'])['Content-Disposition'])
        self.assertEqual(self.alice.call('POST','/v1/skills/packages',{'package':item,'revision':1,'consent':True},csrf=False)['status'],403)
        self.assertEqual(self.alice.call('GET',path+'?user_id=other')['status'],400)

    def test_archive_traversal_hooks_permissions_types_digest_and_version_injection(self):
        changes=[{'id':'../../outside'},{'id':'meeting-notes'},{'version':'1.0.0/../../x'}, {'version':'01.0.0'},
                 {'content':'bad\x00text'},{'content':'x'*6001},{'content':'\ud800'}, {'name':[]},{'permissions':['shell']},
                 {'source':'https://example.invalid/package'},{'format':'tar.gz'},{'path':'/tmp/pwned'}, {'archive':'UEs='},
                 {'files':{'../../pwned':'x'}},{'postinstall':'echo bad'},{'tools':['browser']},{'digest':'0'*64}]
        for change in changes:
            with self.subTest(change=list(change)):
                result=self.save(self.package(**change));self.assertIn(result['status'],(400,409),result)
        self.assertEqual(self.alice.call('GET','/v1/skills/packages')['body']['items'],[])
        imported=imported_skills.validate(self.package())
        self.assertIn(imported['content'],load_skill_material([imported],'user task'))
        for change in ({'source':'bundled-original'},{'format':'openteamily.prompt-skill.v1'},{'permissions':['file_write']},{'digest':'0'*64}):
            with self.assertRaises(AgentError):load_skill_material([{**imported,**change}],'task')

    def test_same_id_other_owner_content_does_not_cross_and_installed_skill_limit_is_enforced(self):
        item=self.import_and_install();other=self.package(content='OTHER-OWNER-CONTENT-ONLY. Never load this for Alice.')
        saved=self.bob.call('POST','/v1/skills/packages',{'package':other,'revision':0,'consent':True});self.assertEqual(saved['status'],200,saved)
        own=self.alice.call('GET','/v1/skills/catalog')['body']['items'];foreign=self.bob.call('GET','/v1/skills/catalog')['body']['items']
        self.assertEqual(next(i for i in own if i['id']==item['id'])['content'],item['content'])
        self.assertEqual(next(i for i in foreign if i['id']==item['id'])['content'],other['content'])
        for package in [i for i in own if i['source']=='bundled-original'][:9]:
            self.assertEqual(self.alice.call('POST','/v1/skills/bindings',self.binding(package))['status'],200)
        remaining=[i for i in own if i['source']=='bundled-original'][9]
        self.assertEqual(self.alice.call('POST','/v1/skills/bindings',self.binding(remaining))['status'],429)
        self.assertEqual(len(self.alice.call('GET','/v1/skills/bindings')['body']['items']),10)
