"""Phase D: Flask must not queue a second infer once chat/agents run on DS-Bot.

Group replies (C pages, still on the platform) keep the central path.
No model vendor is contacted.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily import dsbot_gateway as gw
from openteamily import lifecycle
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_runtime_connect import AgentClient


NOW = 1800000000


class LegacyInferCutoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = NOW
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': '值班助手'}, {'HTTP_IDEMPOTENCY_KEY': 'legacy-infer-agent-01'})
        self.assertEqual(created['status'], 201, created)
        self.agent = created['body']['agent']
        self.alice_id = self.alice.call('GET', '/v1/auth/session')['body']['user']['id']
        self.bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']

    def conversations(self):
        return f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/conversations'

    def task_count(self):
        with self.app.store.transaction() as db:
            return db.execute('SELECT COUNT(*) FROM runtime_tasks').fetchone()[0]

    def message_count(self, conversation_id):
        with self.app.store.transaction() as db:
            return db.execute('SELECT COUNT(*) FROM agent_messages WHERE conversation_id=?',
                              (conversation_id,)).fetchone()[0]

    def publish_dsbot(self):
        with self.app.store.transaction() as db:
            gw.ensure_schema(db)
            db.executescript(lifecycle.SCHEMA)
            inst = 'd' * 32
            try:
                db.execute(
                    "INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,desired,revision,"
                    "operation_id,operation_type,observed,observed_revision,health,process_ref,error_code,blocked,create_key,created) "
                    "VALUES(?,?,?,'p','compose','img','vol','running',1,'op','create','running',1,'healthy',NULL,NULL,0,'k',?)",
                    (inst, self.wid, self.alice_id, self.now))
            except Exception:
                db.execute("UPDATE instances SET owner_id=?, desired='running', observed='running', health='healthy', "
                           "blocked=0, observed_revision=revision WHERE workspace_id=?", (self.alice_id, self.wid))
                inst = db.execute("SELECT id FROM instances WHERE workspace_id=?", (self.wid,)).fetchone()[0]
            gw.record_upstream(db, inst, '172.30.0.11:8080', 'dsh-auth-172.30.0.11:8080=' + 'S' * 20, self.now)
        with self.app.store.transaction() as db:
            self.assertTrue(gw.workspace_conversation_moved_to_dsbot(db, self.wid))

    def connect_runtime(self, name='desk'):
        token = self.alice.call('POST', '/v1/runtime-keys', {'name': name})['body']['token']
        agent = AgentClient(self.app, token)
        self.assertIn(agent.call('POST', '/v1/agent/connect', {'hostname': name})['status'], (200, 201))
        return agent

    def test_send_still_queues_when_the_owner_has_no_dsbot(self):
        created = self.alice.call('POST', self.conversations(), {'title': '晨会'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'legacy-infer-conv-0001'})
        self.assertEqual(created['status'], 201, created)
        conv_id = created['body']['conversation']['id']
        sent = self.alice.call('POST', self.conversations() + f'/{conv_id}/messages',
                               {'body': '今天日程是什么？'},
                               {'HTTP_IDEMPOTENCY_KEY': 'legacy-infer-msg-0001'})
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['reply']['status'], 'queued')
        self.assertEqual(sent['body']['reply']['error_code'], 'no_agent')

    def test_send_and_reconcile_stop_after_the_owner_has_a_live_dsbot(self):
        created = self.alice.call('POST', self.conversations(), {'title': '晨会'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'legacy-infer-conv-0002'})
        conv_id = created['body']['conversation']['id']
        sent = self.alice.call('POST', self.conversations() + f'/{conv_id}/messages',
                               {'body': '先问一句'},
                               {'HTTP_IDEMPOTENCY_KEY': 'legacy-infer-msg-0002'})
        self.assertEqual(sent['status'], 201, sent)
        before_messages = self.message_count(conv_id)

        self.connect_runtime()
        self.publish_dsbot()
        blocked = self.alice.call('POST', self.conversations() + f'/{conv_id}/messages',
                                  {'body': '第二句不该再走中央执行'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'legacy-infer-msg-0003'})
        self.assertEqual(blocked['status'], 409, blocked)
        self.assertEqual(blocked['body']['error']['code'], 'moved_to_dsbot')
        self.assertEqual(self.message_count(conv_id), before_messages)
        self.assertEqual(self.task_count(), 0)

        # GET would previously retry a no_agent reply onto the connected runtime.
        listed = self.alice.call('GET', self.conversations() + f'/{conv_id}')
        self.assertEqual(listed['status'], 200, listed)
        self.assertEqual(self.task_count(), 0)
        self.assertEqual(listed['body']['items'][-1]['error_code'], 'no_agent')

    def test_legacy_gateway_invoke_stops_after_the_owner_has_a_live_dsbot(self):
        issued = self.alice.call('POST',
                                 f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/api-keys',
                                 {'name': 'CI caller'})
        self.assertEqual(issued['status'], 201, issued)
        caller = AgentClient(self.app, issued['body']['token'])
        failed = caller.call('POST', f'/v1/gateway/agents/{self.agent["id"]}/invocations',
                             {'prompt': '请问好'}, HTTP_IDEMPOTENCY_KEY='legacy-gw-0001')
        self.assertEqual((failed['status'], failed['body']['invocation']['status'],
                          failed['body']['invocation']['error_code']), (202, 'failed', 'no_agent'))

        self.publish_dsbot()
        blocked = caller.call('POST', f'/v1/gateway/agents/{self.agent["id"]}/invocations',
                              {'prompt': '第二问'}, HTTP_IDEMPOTENCY_KEY='legacy-gw-0002')
        self.assertEqual(blocked['status'], 409, blocked)
        self.assertEqual(blocked['body']['error']['code'], 'moved_to_dsbot')
        self.assertEqual(self.task_count(), 0)
        # Idempotent replay of the earlier invocation is still served from Flask.
        replay = caller.call('POST', f'/v1/gateway/agents/{self.agent["id"]}/invocations',
                             {'prompt': '请问好'}, HTTP_IDEMPOTENCY_KEY='legacy-gw-0001')
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['invocation']['error_code'], 'no_agent')

    def test_group_replies_still_queue_while_c_pages_stay_on_the_platform(self):
        self.publish_dsbot()
        self.connect_runtime()
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/social/conversations',
            {'kind': 'group', 'member_ids': [self.bob_id], 'agent_ids': [self.agent['id']]},
            {'HTTP_IDEMPOTENCY_KEY': 'legacy-infer-group-001'})
        self.assertEqual(created['status'], 201, created)
        path = f"/v1/workspaces/{self.wid}/social/conversations/{created['body']['conversation']['id']}"
        sent = self.alice.call(
            'POST', path + '/agent-replies',
            {'agent_id': self.agent['id'], 'prompt': 'A clearly explicit request'},
            {'HTTP_IDEMPOTENCY_KEY': 'legacy-infer-group-reply-01'})
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['reply']['status'], 'queued')
        self.assertIsNotNone(sent['body']['reply']['task_id'])
        self.assertEqual(self.task_count(), 1)


if __name__ == '__main__':
    unittest.main()
