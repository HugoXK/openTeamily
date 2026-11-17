"""Persistent authorized user/agent conversations. No model vendor is contacted."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.conversations import compose_prompt
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class AgentChatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': '值班助手', 'summary': '简短回答', 'instructions': '只用中文回复。'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-create-01'})
        self.assertEqual(created['status'], 201, created)
        self.agent = created['body']['agent']

    def conversations(self, client=None, agent_id=None):
        client = client or self.alice
        aid = agent_id or self.agent['id']
        return f'/v1/workspaces/{self.wid}/agents/{aid}/conversations'

    def test_compose_prompt_binds_agent_and_stays_within_runtime_limit(self):
        agent = {'name': '值班助手', 'summary': '简短回答', 'instructions': '只用中文回复。'}
        history = [
            {'role': 'user', 'body': '你好'},
            {'role': 'assistant', 'body': '你好，我是值班助手。'},
        ]
        prompt = compose_prompt(agent, history, '今天有什么安排？')
        self.assertIn('You are 值班助手.', prompt)
        self.assertIn('只用中文回复。', prompt)
        self.assertIn('User: 你好', prompt)
        self.assertIn('Assistant: 你好，我是值班助手。', prompt)
        self.assertTrue(prompt.endswith('User: 今天有什么安排？'))
        self.assertLessEqual(len(prompt), 4000)
        huge = '安排' * 3000
        trimmed = compose_prompt(agent, [{'role': 'user', 'body': '旧消息' * 2000}], huge)
        self.assertLessEqual(len(trimmed), 4000)
        self.assertTrue(trimmed.startswith('You are 值班助手.') or trimmed.startswith('User: '))

    def test_conversation_persists_and_send_queues_without_runtime(self):
        created = self.alice.call(
            'POST', self.conversations(), {'title': '晨会'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-conv-0001'})
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual(conv['agent_id'], self.agent['id'])
        self.assertEqual(conv['user_id'], self.alice.call('GET', '/v1/auth/session')['body']['user']['id'])
        again = self.alice.call(
            'POST', self.conversations(), {'title': '晨会'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-conv-0001'})
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['conversation']['id'], conv['id'])
        conflict = self.alice.call(
            'POST', self.conversations(), {'title': '另一个'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-conv-0001'})
        self.assertEqual(conflict['status'], 409)
        sent = self.alice.call(
            'POST', self.conversations() + f'/{conv["id"]}/messages',
            {'body': '今天日程是什么？'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-msg-0001'})
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['message']['role'], 'user')
        self.assertEqual(sent['body']['message']['status'], 'succeeded')
        self.assertEqual(sent['body']['message']['body'], '今天日程是什么？')
        self.assertEqual(sent['body']['message']['agent_revision'], 1)
        reply = sent['body']['reply']
        self.assertEqual(reply['role'], 'assistant')
        self.assertEqual(reply['status'], 'queued')
        self.assertEqual(reply['error_code'], 'no_agent')
        self.assertIsNone(reply['task_id'])
        listed = self.alice.call('GET', self.conversations() + f'/{conv["id"]}/messages')
        self.assertEqual(listed['status'], 200, listed)
        self.assertEqual([row['role'] for row in listed['body']['items']], ['user', 'assistant'])
        self.assertEqual(listed['body']['items'][1]['error_code'], 'no_agent')
        replay = self.alice.call(
            'POST', self.conversations() + f'/{conv["id"]}/messages',
            {'body': '今天日程是什么？'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-msg-0001'})
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['message']['id'], sent['body']['message']['id'])
        self.assertEqual(replay['body']['reply']['id'], reply['id'])

    def test_permissions_and_workspace_isolation(self):
        created = self.alice.call(
            'POST', self.conversations(), {'title': '私有对话'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-conv-priv1'})
        conv_id = created['body']['conversation']['id']
        self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '只给alice看'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-msg-priv1'})
        listed = self.bob.call('GET', self.conversations())
        self.assertEqual(listed['status'], 200)
        self.assertEqual(listed['body']['items'], [])
        self.assertEqual(self.bob.call('GET', self.conversations() + f'/{conv_id}')['status'], 404)
        self.assertEqual(self.bob.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '冒充发送'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-msg-bobxx1'})['status'], 404)
        self.assertEqual(self.eve.call('GET', self.conversations())['status'], 404)
        other = self.bob.workspace('bobspace', 'request_example_0002')['body']['workspace']['id']
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{other}/agents/{self.agent["id"]}/conversations')['status'], 404)

    def test_archived_agent_rejects_new_sends_but_keeps_history(self):
        created = self.alice.call(
            'POST', self.conversations(), {'title': '归档前'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-conv-arch1'})
        conv_id = created['body']['conversation']['id']
        self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '先记一笔'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-msg-arch1'})
        archived = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/archive',
            {'revision': 1})
        self.assertEqual(archived['status'], 200, archived)
        self.assertEqual(self.alice.call(
            'POST', self.conversations(), {'title': '归档后'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-conv-arch2'})['status'], 409)
        self.assertEqual(self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '再发一条'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-msg-arch2'})['status'], 409)
        history = self.alice.call('GET', self.conversations() + f'/{conv_id}')
        self.assertEqual(history['status'], 200)
        self.assertEqual(history['body']['items'][0]['body'], '先记一笔')

    def test_message_to_library_is_idempotent_and_isolated(self):
        created = self.alice.call(
            'POST', self.conversations(), {'title': '保存消息'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-conv-lib01'})
        conv_id = created['body']['conversation']['id']
        sent = self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages',
            {'body': '把这句话存进作品库。'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-msg-lib01'})
        user_id = sent['body']['message']['id']
        reply_id = sent['body']['reply']['id']
        queued = self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages/{reply_id}/artifact', {})
        self.assertEqual(queued['status'], 409, queued)
        saved = self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages/{user_id}/artifact',
            {'title': '对话摘录'})
        self.assertEqual(saved['status'], 201, saved)
        artifact = saved['body']['artifact']
        self.assertEqual(artifact['title'], '对话摘录')
        self.assertEqual(artifact['body'], '把这句话存进作品库。')
        self.assertEqual(artifact['source']['kind'], 'agent_message')
        self.assertEqual(artifact['source']['id'], user_id)
        self.assertEqual(artifact['source']['conversation_id'], conv_id)
        self.assertEqual(artifact['source']['agent_id'], self.agent['id'])
        again = self.alice.call(
            'POST', self.conversations() + f'/{conv_id}/messages/{user_id}/artifact',
            {'title': '另一个标题'})
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['artifact']['id'], artifact['id'])
        self.assertEqual(again['body']['artifact']['title'], '对话摘录')
        self.assertEqual(self.bob.call(
            'POST', self.conversations() + f'/{conv_id}/messages/{user_id}/artifact', {})['status'], 404)
        evespace = self.eve.workspace('evespace', 'request_example_0003')['body']['workspace']['id']
        # Eve is not a member; even a guessed path is 404.
        self.assertEqual(self.eve.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/conversations/{conv_id}/messages/{user_id}/artifact',
            {})['status'], 404)
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{artifact["id"]}')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(listed['body']['artifact']['source']['kind'], 'agent_message')
        self.assertIsNone(self.eve.call('GET', f'/v1/workspaces/{evespace}/artifacts/{artifact["id"]}')['body'].get('artifact')
                          if self.eve.call('GET', f'/v1/workspaces/{evespace}/artifacts/{artifact["id"]}')['status'] == 200
                          else None)

    def test_listing_preview_is_last_authorized_snippet(self):
        created = self.alice.call(
            'POST', self.conversations(), {'title': '预览对话'},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-preview-01'})
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual(conv['preview'], '')
        empty = self.alice.call('GET', self.conversations())
        self.assertEqual(empty['status'], 200)
        self.assertEqual(empty['body']['items'][0]['preview'], '')
        from openteamily.search import snippet
        long_body = '预览' + ('很长的正文内容' * 30)
        sent = self.alice.call(
            'POST', self.conversations() + f'/{conv["id"]}/messages',
            {'body': long_body},
            {'HTTP_IDEMPOTENCY_KEY': 'agent-chat-preview-m1'})
        self.assertEqual(sent['status'], 201, sent)
        listed = self.alice.call('GET', self.conversations())
        self.assertEqual(listed['status'], 200)
        item = listed['body']['items'][0]
        self.assertEqual(item['id'], conv['id'])
        self.assertEqual(item['preview'], snippet(long_body))
        self.assertTrue(item['preview'].endswith('…'))
        self.assertNotIn(long_body, item['preview'])
        self.assertNotIn('body', item)
        # Workspace members cannot read another user's agent-conversation previews.
        bob_list = self.bob.call('GET', self.conversations())
        self.assertEqual(bob_list['status'], 200)
        self.assertEqual(bob_list['body']['items'], [])

    def test_existing_v1_library_gains_conversation_tables_without_version_bump(self):
        path = Path(self.temp.name) / 'state'
        with sqlite3.connect(path / 'management.sqlite3') as db:
            db.execute('DROP TABLE IF EXISTS artifact_chat_sources')
            db.execute('DROP TABLE IF EXISTS agent_messages')
            db.execute('DROP TABLE IF EXISTS agent_conversations')
        Store(path)
        with sqlite3.connect(path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn('agent_conversations', names)
            self.assertIn('agent_messages', names)
            self.assertIn('artifact_chat_sources', names)
            self.assertIn('workspace_agents', names)


if __name__ == '__main__':
    unittest.main()
