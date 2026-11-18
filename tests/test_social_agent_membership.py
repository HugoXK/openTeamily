"""Existing-group roster edits on the selected single-agent reply protocol.

HTTP inference integration uses only the existing labeled local fake provider.
No vendor, container or Teamily acceptance is claimed.
"""
from dataclasses import replace
from pathlib import Path
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import ORIGIN
from tests import test_social as social_tests
from tests import test_group_agent_reply as reply_tests


class SocialAgentMembershipTests(unittest.TestCase):
    setUp = social_tests.SocialMessengerTests.setUp
    _user_id = social_tests.SocialMessengerTests._user_id
    base = social_tests.SocialMessengerTests.base
    create = social_tests.SocialMessengerTests.create
    make_agent = social_tests.SocialMessengerTests.make_agent
    trigger = reply_tests.GroupAgentReplyTests.trigger
    connect = reply_tests.GroupAgentReplyTests.connect

    def empty_group(self):
        created = self.create(self.alice, 'group', [self.bob_id])
        self.assertEqual(created['status'], 201, created)
        self.cid = created['body']['conversation']['id']
        return self.base() + '/' + self.cid

    def group(self):
        path = self.empty_group()
        self.aid = self.make_agent()
        result = self.edit(path, [self.aid])
        self.assertEqual(result['status'], 200, result)
        return path

    def edit(self, path, ids, client=None):
        return (client or self.alice).call('POST', path + '/agents', {'agent_ids': ids})

    def remove(self, path, aid=None, client=None):
        return (client or self.alice).call('POST', path + '/agents/' + (aid or self.aid) + '/remove', {})

    def test_add_remove_repeat_and_reopen_preserve_humans(self):
        path = self.empty_group()
        self.aid = self.make_agent()
        self.now += 1
        for _ in range(2):
            result = self.edit(path, [self.aid])
            self.assertEqual(result['status'], 200, result)
            self.assertEqual([a['agent_id'] for a in result['body']['conversation']['agent_members']], [self.aid])
        reopened = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.bob.app = reopened
        snap = self.bob.call('GET', path)['body']['conversation']
        self.assertEqual([a['agent_id'] for a in snap['agent_members']], [self.aid])
        self.assertEqual({m['user_id'] for m in snap['members']}, {self.alice_id, self.bob_id})
        self.assertEqual(snap['updated'], self.now)
        self.assertEqual(self.bob.call('GET', self.base())['body']['items'][0]['agent_members'], snap['agent_members'])
        for _ in range(2):
            self.assertEqual(self.remove(path)['status'], 200)
        self.assertEqual(self.bob.call('GET', path)['body']['conversation']['agent_members'], [])
        self.assertEqual(self.trigger(path, key='removed-agent-request1')['status'], 400)
        self.assertEqual(self.edit(path, [self.aid])['status'], 200)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM social_agent_members').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_tasks').fetchone()[0], 0)

    def test_group_and_workspace_authorization_before_mutation(self):
        path = self.group()
        for client, expected in ((self.bob, 403), (self.carol, 404), (self.eve, 404)):
            self.assertEqual(self.edit(path, [self.aid], client)['status'], expected)
            self.assertEqual(self.remove(path, client=client)['status'], expected)
        # Workspace admin still needs actual group membership.
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{self.wid}/members/{self.carol_id}',
                                         {'role': 'admin'})['status'], 200)
        self.assertEqual(self.edit(path, [self.aid], self.carol)['status'], 404)
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{self.wid}/members/{self.bob_id}',
                                         {'role': 'admin'})['status'], 200)
        self.assertEqual(self.remove(path, client=self.bob)['status'], 200)
        self.assertEqual(self.edit(path, [self.aid], self.bob)['status'], 200)

    def test_batch_membership_and_creation_replay_do_not_resurrect_removed_agents(self):
        path = self.group()
        other = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents', {'name': 'Another helper'},
                                {'HTTP_IDEMPOTENCY_KEY': 'another-member-agent1'})['body']['agent']['id']
        result = self.edit(path, [other, self.aid])
        self.assertEqual(result['status'], 200, result)
        self.assertEqual({a['agent_id'] for a in result['body']['conversation']['agent_members']}, {other, self.aid})
        self.assertEqual(self.remove(path)['status'], 200)
        # Original creation is still idempotent; it never reapplies initial roster state.
        replay = self.create(self.alice, 'group', [self.bob_id])
        self.assertEqual(replay['status'], 200, replay)
        self.assertEqual([a['agent_id'] for a in replay['body']['conversation']['agent_members']], [other])
        foreign_wid = self.eve.workspace()['body']['workspace']['id']
        self.assertEqual(self.edit(self.base(foreign_wid) + '/' + self.cid, [other])['status'], 404)

    def test_invalid_foreign_archived_and_atomic_batch(self):
        path = self.empty_group()
        self.aid = self.make_agent()
        foreign_wid = self.eve.workspace()['body']['workspace']['id']
        foreign = self.make_agent(self.eve, foreign_wid)
        for value in (None, '', {}, False, [], [self.aid, self.aid], ['bad'], ['f' * 32], [self.aid, foreign]):
            result = self.edit(path, value)
            self.assertEqual(result['status'], 400, result)
            self.assertEqual(result['body']['error']['code'], 'invalid')
            self.assertEqual(self.alice.call('GET', path)['body']['conversation']['agent_members'], [])
        self.assertEqual(self.remove(path, foreign)['status'], 400)
        self.assertEqual(self.remove(path, 'f' * 32)['status'], 400)
        self.assertEqual(self.edit(path, [self.aid])['status'], 200)
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{self.aid}/archive', {'revision': 1})
        self.assertEqual(self.edit(path, [self.aid])['status'], 400)
        self.assertEqual(self.remove(path)['status'], 200)  # stale archived member can be removed

    def test_dm_csrf_origin_body_method_and_capacity(self):
        path = self.group()
        dm = self.create(self.alice, 'dm', [self.bob_id], key='membership-dm-test1')['body']['conversation']
        dm_path = self.base() + '/' + dm['id']
        self.assertEqual(self.edit(dm_path, [self.aid])['status'], 400)
        self.assertEqual(self.remove(dm_path)['status'], 400)
        for suffix, body in (('/agents', {'agent_ids': [self.aid]}), ('/agents/' + self.aid + '/remove', {})):
            for headers in ({'HTTP_X_CSRF_TOKEN': ''}, {'HTTP_ORIGIN': 'https://evil.invalid'}):
                self.assertEqual(self.alice.call('POST', path + suffix, body, headers)['status'], 403)
            self.assertEqual(self.alice.call('GET', path + suffix)['status'], 400)
            self.assertEqual(self.alice.call('POST', path + suffix + '?extra=1', body)['status'], 400)
            self.assertEqual(self.alice.call('POST', path + suffix, {**body, 'extra': True})['status'], 400)
        self.remove(path)
        self.app.config = replace(self.app.config, max_social_members_per_conversation=2)
        self.assertEqual(self.edit(path, [self.aid])['status'], 429)
        self.assertEqual(self.alice.call('GET', path)['body']['conversation']['agent_members'], [])
        self.app.config = replace(self.app.config, max_social_members_per_conversation=3)
        self.assertEqual(self.edit(path, [self.aid])['status'], 200)
        self.assertEqual(self.edit(path, [self.aid])['status'], 200)  # repeat at capacity

    def test_busy_agent_cannot_be_removed_then_terminal_failure_allows_it(self):
        path = self.group()
        runtime = self.connect()
        sent = self.trigger(path)
        self.assertEqual(sent['body']['reply']['status'], 'queued')
        self.assertEqual(self.remove(path)['status'], 409)
        tid = sent['body']['reply']['task_id']
        self.assertEqual(runtime.call('POST', f'/v1/agent/tasks/{tid}/claim', {})['status'], 200)
        self.assertEqual(self.remove(path)['status'], 409)
        runtime.call('POST', f'/v1/agent/tasks/{tid}/result', {'status': 'failed', 'result': {'error': 'synthetic failure'}})
        self.assertEqual(self.remove(path)['status'], 200)
        snapshot = self.alice.call('GET', path)['body']
        self.assertEqual(snapshot['conversation']['agent_members'], [])
        self.assertEqual(snapshot['agent_replies'][0]['status'], 'failed')
        self.assertEqual(self.trigger(path, key='removed-agent-request2')['status'], 400)

    def test_invited_agent_http_claim_result_and_history_survive_removal(self):
        # The existing real HTTP + subprocess fake-provider integration now starts
        # with an empty group and invites the agent through the new API.
        reply_tests.GroupAgentReplyTests.test_http_claim_model_access_result_persists_agent_message(self)
        path = self.base() + '/' + self.cid
        before = self.bob.call('GET', path)['body']
        self.assertEqual(self.remove(path)['status'], 200)
        after = self.bob.call('GET', path)['body']
        self.assertEqual(after['items'], before['items'])
        self.assertEqual(after['agent_replies'], before['agent_replies'])
        self.assertEqual(after['conversation']['agent_members'], [])
        self.assertEqual(self.edit(path, [self.aid])['status'], 200)
        self.assertEqual(self.bob.call('GET', path)['body']['items'], before['items'])
