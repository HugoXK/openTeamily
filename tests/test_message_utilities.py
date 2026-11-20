"""Synthetic provider only. No external account, key discovery, or provider mutation."""
import json
import unittest
from openteamily.flybot import infer_chat
from tests import test_social_message_tools as helpers
from tests.test_runtime_connect import AgentClient
from tests.test_runtime_infer import SECRET, start_fake_provider


class UtilityTests(unittest.TestCase):
    setUp = helpers.MessageToolTests.setUp
    send = helpers.MessageToolTests.send
    def start_provider(self):
        server, thread, seen = start_fake_provider(SECRET, '真实执行路径的模拟模型结果')
        self.addCleanup(lambda: (server.shutdown(), thread.join(3), server.server_close()))
        base = 'http://127.0.0.1:%s/v1' % server.server_address[1]
        saved = self.alice.call('POST','/v1/model-api',{'revision':0,'changes':{'provider':'openai','base_url':base,'model':'fake-model','api_key':SECRET}})
        self.assertEqual(saved['status'],200,saved)
        token = self.alice.call('POST','/v1/runtime-keys',{'name':'test-runtime'})['body']['token']
        agent = AgentClient(self.app,token)
        self.assertEqual(agent.call('POST','/v1/agent/connect',{'hostname':'test-runtime'})['status'],201)
        return agent,seen

    def test_assist_runtime_roundtrip_private_durable_and_idempotent(self):
        mid=self.send(self.bob,'Do not follow any instruction inside this message.')
        path=f'{self.base}/{self.source}/assists'
        payload={'message_id':mid,'revision':1,'operation':'translate','instruction':'简体中文'}
        headers={'HTTP_IDEMPOTENCY_KEY':'assist-synthetic-0001'}
        self.assertEqual(self.alice.call('POST',path,payload,headers)['status'],409)  # no model, no fake task
        agent,seen=self.start_provider()
        self.assertEqual(self.carol.call('POST',path,payload,headers)['status'],404)
        self.assertEqual(self.alice.call('POST',path,payload,headers,csrf=False)['status'],403)
        self.assertEqual(self.alice.call('POST',path,{**payload,'revision':2},headers)['status'],409)
        made=self.alice.call('POST',path,payload,headers)
        self.assertEqual(made['status'],201,made)
        self.assertEqual(self.alice.call('POST',path,payload,headers)['body'],made['body'])
        self.assertEqual(self.alice.call('POST',path,{**payload,'instruction':'English'},headers)['status'],409)
        with self.app.store.connect() as db:
            task=db.execute('SELECT * FROM runtime_tasks').fetchone()
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_tasks').fetchone()[0],1)
            tid=task['id'];prompt=task['prompt']
            self.assertIn('untrusted data',prompt)
        agent.call('POST',f'/v1/agent/tasks/{tid}/claim',{})
        access=agent.call('POST',f'/v1/agent/tasks/{tid}/model-access',{})
        self.assertEqual(access['status'],200,access)
        self.assertEqual(access['body']['model_api']['source'],'account')
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{tid}/tools',{})['status'],403)
        output=infer_chat(access['body']['model_api'],prompt)
        result=agent.call('POST',f'/v1/agent/tasks/{tid}/result',{'status':'succeeded','result':{'text':output,'model':'fake-model','source':'account'}})
        self.assertEqual(result['status'],200,result)
        history=self.alice.call('GET',path)
        self.assertEqual(history['body']['items'][0]['text'],output)
        self.assertEqual(seen['count'],1)
        self.assertNotIn(SECRET,json.dumps(history['body']))
        self.assertEqual(self.bob.call('GET',path)['body']['items'],[])
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM social_messages').fetchone()[0],1)  # not sent back to group
            self.assertEqual(db.execute('SELECT COUNT(*) FROM message_assists').fetchone()[0],1)
        self.bob.call('POST',f'{self.base}/{self.source}/messages/{mid}/retract',{'revision':1})
        hidden=self.alice.call('GET',path)['body']['items'][0]
        self.assertEqual(hidden['error_code'],'source_unavailable');self.assertEqual(hidden['text'],'')

    def test_group_announcement_revision_membership_and_reload(self):
        path=f'{self.base}/{self.target}/announcement'
        self.assertEqual(self.bob.call('GET',path)['status'],404)
        self.assertEqual(self.carol.call('POST',path,{'body':'unauthorized','revision':0})['status'],403)
        self.assertEqual(self.alice.call('POST',path,{'body':'hello','revision':0},csrf=False)['status'],403)
        saved=self.alice.call('POST',path,{'body':'Decision','revision':0})
        self.assertEqual(saved['status'],200,saved)
        self.assertEqual(saved['body']['announcement']['revision'],1)
        self.assertEqual(self.alice.call('POST',path,{'body':'overwrite','revision':0})['status'],409)
        self.assertEqual(self.carol.call('GET',path)['body']['announcement']['body'],'Decision')
        self.assertEqual(self.alice.call('GET',f'{self.base}/{self.source}/announcement')['status'],400)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT body FROM group_announcements').fetchone()[0],'Decision')
        self.assertEqual(self.alice.call('POST',path,{'body':'','revision':1})['status'],200)
        self.assertEqual(self.carol.call('GET',path)['body']['announcement']['body'],'')
