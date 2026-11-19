"""Search saved runtime-authored group replies; no vendor or Teamily acceptance."""
from pathlib import Path
import unittest
from urllib.parse import urlencode

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import ORIGIN
from tests import test_group_agent_reply as reply_tests
from tests import test_social as social_tests


class GroupAgentSearchTests(unittest.TestCase):
    setUp = social_tests.SocialMessengerTests.setUp
    _user_id = social_tests.SocialMessengerTests._user_id
    base = social_tests.SocialMessengerTests.base
    create = social_tests.SocialMessengerTests.create
    make_agent = social_tests.SocialMessengerTests.make_agent
    group = reply_tests.GroupAgentReplyTests.group
    trigger = reply_tests.GroupAgentReplyTests.trigger
    connect = reply_tests.GroupAgentReplyTests.connect

    def search(self, text, client=None, wid=None, **query):
        return (client or self.alice).call('GET',
            f'/v1/workspaces/{wid or self.wid}/search/messages?' + urlencode({'q': text, **query}))

    def completed(self, path, text='[FAKE RUNTIME TEST] searchable group answer', key='search-agent-answer1'):
        runtime = self.connect()
        sent = self.trigger(path, key=key, prompt='request text must not be searched')
        self.assertEqual(sent['status'], 201, sent)
        tid = sent['body']['reply']['task_id']
        self.assertEqual(runtime.call('POST', f'/v1/agent/tasks/{tid}/claim', {})['status'], 200)
        done = runtime.call('POST', f'/v1/agent/tasks/{tid}/result',
                            {'status': 'succeeded', 'result': {'text': text}})
        self.assertEqual(done['status'], 200, done)
        self.assertEqual(self.bob.call('GET', path)['body']['items'][0]['body'], text)
        return sent['body']['reply']['id']

    def test_http_runtime_result_is_searchable_and_opens_saved_group(self):
        # Actual HTTP claim/access/result + subprocess labeled local fake provider.
        reply_tests.GroupAgentReplyTests.test_http_claim_model_access_result_persists_agent_message(self)
        path = self.base() + '/' + self.cid
        response = self.search('one group reply', self.bob, kind='social', conversation_id=self.cid)
        self.assertEqual(response['status'], 200, response)
        self.assertEqual(len(response['body']['items']), 1)
        hit = response['body']['items'][0]
        self.assertEqual(hit['kind'], 'social')
        self.assertEqual(hit['role'], 'agent')
        self.assertEqual(hit['agent_id'], self.aid)
        self.assertEqual(hit['agent_name'], 'Group helper')
        self.assertEqual(hit['source'], 'runtime_infer')
        self.assertEqual(hit['conversation_id'], self.cid)
        opened = self.bob.call('GET', path)['body']['items']
        self.assertIn(hit['message_id'], [m['id'] for m in opened])
        self.assertEqual(hit['snippet'], '[FAKE PROVIDER] one group reply')
        self.assertEqual(self.search('one group reply', self.bob, kind='agent')['body']['items'], [])
        # Persisted search survives reopening and no longer needs a connected runtime.
        self.bob.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                           clock=lambda: self.now)
        self.assertEqual(self.search('one group reply', self.bob)['body']['items'], [hit])

    def test_workspace_group_and_private_conversation_isolation(self):
        path = self.group()
        rid = self.completed(path)
        self.assertEqual(self.search('searchable group answer', self.carol)['body']['items'], [])
        self.assertEqual(self.search('searchable group answer', self.carol, conversation_id=self.cid)['body']['items'], [])
        self.assertEqual(self.search('searchable group answer', self.eve)['status'], 404)
        # Workspace admin is not a private-group reader until actually in that group.
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{self.wid}/members/{self.carol_id}',
                                         {'role': 'admin'})['status'], 200)
        self.assertEqual(self.search('searchable group answer', self.carol)['body']['items'], [])
        other = self.alice.workspace('search-other-space', 'search-other-space1')['body']['workspace']['id']
        self.assertEqual(self.search('searchable group answer', wid=other, conversation_id=self.cid)['body']['items'], [])
        other_group = self.create(self.alice, 'group', [self.carol_id], key='search-other-group1')['body']['conversation']['id']
        self.assertEqual(self.search('searchable group answer', conversation_id=other_group)['body']['items'], [])
        # Removing/archiving an agent is not deletion of the group's visible history.
        self.assertEqual(self.alice.call('POST', path + '/agents/' + self.aid + '/remove', {})['status'], 200)
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{self.aid}/archive', {'revision': 1})
        hit = self.search('searchable group answer', self.bob)['body']['items'][0]
        self.assertEqual(hit['message_id'], rid)
        self.assertEqual(hit['agent_name'], 'Group helper')

    def test_only_succeeded_bodies_are_searchable_never_requests_or_failed_output(self):
        path = self.group()
        offline = self.trigger(path, prompt='needle pending request')
        self.assertEqual(offline['body']['reply']['status'], 'failed')
        # Defensive fixtures: even if a non-success row has text, never expose it.
        with self.app.store.connect() as db:
            db.execute('UPDATE social_agent_replies SET body=? WHERE id=?',
                       ('needle failed output', offline['body']['reply']['id']))
            db.commit()
        self.assertEqual(self.search('needle')['body']['items'], [])
        for status in ('queued', 'running', 'cancelled'):
            with self.app.store.connect() as db:
                db.execute('UPDATE social_agent_replies SET status=? WHERE id=?',
                           (status, offline['body']['reply']['id']))
                db.commit()
            self.assertEqual(self.search('needle')['body']['items'], [])
        with self.app.store.connect() as db:
            db.execute("UPDATE social_agent_replies SET status='failed' WHERE id=?",
                       (offline['body']['reply']['id'],))
            db.commit()
        runtime = self.connect()
        queued = self.trigger(path, key='search-queued-agent1', prompt='needle queued prompt')
        tid = queued['body']['reply']['task_id']
        with self.app.store.connect() as db:
            db.execute('UPDATE social_agent_replies SET body=? WHERE id=?',
                       ('needle queued output', queued['body']['reply']['id']))
            db.commit()
        self.assertEqual(self.search('needle')['body']['items'], [])
        self.assertEqual(runtime.call('POST', f'/v1/agent/tasks/{tid}/claim', {})['status'], 200)
        self.assertEqual(self.search('needle')['body']['items'], [])
        runtime.call('POST', f'/v1/agent/tasks/{tid}/result', {'status': 'failed', 'result': {'error': 'needle diagnostic'}})
        self.bob.call('GET', path)
        self.assertEqual(self.search('needle')['body']['items'], [])

    def test_mixed_pagination_scope_literal_matching_and_snippet_bounds(self):
        path = self.group()
        marker = '100%_字面'
        rid = self.completed(path, marker + '\n' + 'x' * 300)
        for i in range(2):
            sent = self.alice.call('POST', path + '/messages', {'body': marker + f' human {i}'},
                                   {'HTTP_IDEMPOTENCY_KEY': f'search-human-mixed-{i}'})
            self.assertEqual(sent['status'], 201)
        dm = self.create(self.alice, 'dm', [self.bob_id], key='search-scope-dm-test1')['body']['conversation']['id']
        self.alice.call('POST', self.base() + '/' + dm + '/messages', {'body': marker + ' other conversation'},
                        {'HTTP_IDEMPOTENCY_KEY': 'search-other-conv-msg1'})
        full = self.search(marker, kind='social', conversation_id=self.cid)['body']['items']
        self.assertEqual(len(full), 3)
        self.assertEqual([m['message_id'] for m in full], sorted(m['message_id'] for m in full))
        agent = next(m for m in full if m['message_id'] == rid)
        self.assertEqual(len(agent['snippet']), 161)
        self.assertNotIn('\n', agent['snippet'])
        self.assertTrue(agent['snippet'].endswith('…'))
        paged, cursor = [], ''
        for _ in range(5):
            args = {'kind': 'social', 'conversation_id': self.cid, 'limit': 1}
            if cursor:
                args['cursor'] = cursor
            page = self.search(marker, **args)['body']
            paged.extend(page['items'])
            cursor = page['cursor']
            if not cursor:
                break
        self.assertEqual(paged, full)
        private_base = f'/v1/workspaces/{self.wid}/agents/{self.aid}/conversations'
        private = self.alice.call('POST', private_base, {'title': 'Private search fixture'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'search-private-conv1'})['body']['conversation']['id']
        self.assertEqual(self.alice.call('POST', private_base + '/' + private + '/messages',
            {'body': marker + ' private message'}, {'HTTP_IDEMPOTENCY_KEY': 'search-private-msg1'})['status'], 201)
        all_hits = self.search(marker)['body']['items']
        self.assertEqual(len(all_hits), 5)
        self.assertEqual(len(self.search(marker, self.bob)['body']['items']), 4)
        self.assertEqual(self.search(marker, self.bob, conversation_id=private)['body']['items'], [])
        global_pages, cursor = [], ''
        for _ in range(7):
            args = {'limit': 1}
            if cursor:
                args['cursor'] = cursor
            page = self.search(marker, **args)['body']
            global_pages.extend(page['items'])
            cursor = page['cursor']
            if not cursor:
                break
        self.assertEqual(global_pages, all_hits)
        self.assertEqual(self.search("' OR 1=1 --")['body']['items'], [])
        for m in full:
            if m['message_id'] != rid:
                self.assertEqual(set(m), {'kind', 'conversation_id', 'message_id', 'title', 'snippet', 'created'})
