"""Explicit group/scheduled/DSH Composio principals. Synthetic only; no vendor keys."""
import unittest

from openteamily import composio_principals, runtime_connect
from openteamily.scheduler import AgentAutomationBackend
import tests.test_connected_tools as _connected_tools_tests
from tests.test_composio import BOB_KEY
from tests.test_runtime_connect import AgentClient
from tests.test_scheduler import DAILY


class ComposioPrincipalTests(unittest.TestCase):
    def setUp(self):
        _connected_tools_tests.ConnectedToolsTests.setUp(self)

    set_key = _connected_tools_tests.ConnectedToolsTests.set_key
    connect = _connected_tools_tests.ConnectedToolsTests.connect
    discover = _connected_tools_tests.ConnectedToolsTests.discover

    def user_id(self, client):
        return client.call('GET', '/v1/auth/session')['body']['user']['id']

    def workspace(self, add_bob=False):
        wid = self.alice.workspace()['body']['workspace']['id']
        if add_bob:
            self.alice.call('POST', f'/v1/workspaces/{wid}/members', {'username': 'bob', 'role': 'member'})
        return wid

    def make_agent(self, wid, key='principal-agent-create1', name='Group helper'):
        created = self.alice.call('POST', f'/v1/workspaces/{wid}/agents', {'name': name},
                                  {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertIn(created['status'], (200, 201), created)
        return created['body']['agent']['id']

    def make_group(self, key='principal-group-0001', agent_key='principal-agent-create1', agent_name='Group helper'):
        wid = self.workspace(add_bob=True)
        aid = self.make_agent(wid, key=agent_key, name=agent_name)
        created = self.alice.call(
            'POST', f'/v1/workspaces/{wid}/social/conversations',
            {'kind': 'group', 'member_ids': [self.user_id(self.bob)], 'agent_ids': [aid]},
            {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        cid = created['body']['conversation']['id']
        return wid, aid, cid, f'/v1/workspaces/{wid}/social/conversations/{cid}'

    def trigger(self, path, aid, key, client=None, prompt='A clearly explicit request'):
        return (client or self.alice).call('POST', path + '/agent-replies',
                                           {'agent_id': aid, 'prompt': prompt},
                                           {'HTTP_IDEMPOTENCY_KEY': key})

    def tools(self, agent, task_id):
        return agent.call('POST', f'/v1/agent/tasks/{task_id}/tools', {})

    def test_group_reply_uses_requester_tools_only_on_same_runtime(self):
        _wid, aid, _cid, path = self.make_group()
        sent = self.trigger(path, aid, 'principal-reply-alice-001')
        self.assertEqual(sent['status'], 201, sent)
        tid = sent['body']['reply']['task_id']
        self.assertTrue(tid)
        self.agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
        discovery = self.tools(self.agent, tid)
        self.assertEqual(discovery['status'], 200, discovery)
        self.assertEqual([t['function']['name'] for t in discovery['body']['tools']], ['GITHUB_GET_USER'])
        with self.app.store.connect() as db:
            principal = composio_principals.load(db, tid)
            self.assertEqual(principal['scope'], 'group')
            self.assertEqual(principal['user_id'], self.user_id(self.alice))
            self.assertTrue(composio_principals.live(db, principal))
        self.set_key(self.bob, BOB_KEY)
        bob_token = self.bob.call('POST', '/v1/runtime-keys', {'name': 'bob-group'})['body']['token']
        bob_agent = AgentClient(self.app, bob_token)
        self.assertIn(bob_agent.call('POST', '/v1/agent/connect', {'hostname': 'bob-group'})['status'], (200, 201))
        self.assertEqual(self.tools(bob_agent, tid)['status'], 404)
        # Bob's own group request on a separate conversation/runtime cannot use Alice's tools.
        _wid, bob_aid, _cid, bob_path = self.make_group(key='principal-group-bob-001', agent_key='principal-agent-bob-001', agent_name='Bob helper')
        # Reuse the already created workspace agent would conflict; this group has its own agent.
        sent = self.trigger(bob_path, bob_aid, 'principal-reply-bob-001', client=self.bob)
        self.assertEqual(sent['status'], 201, sent)
        other = sent['body']['reply']['task_id']
        bob_agent.call('POST', f'/v1/agent/tasks/{other}/claim', {})
        result = self.tools(bob_agent, other)
        self.assertIn(result['status'], (200, 403, 409), result)
        if result['status'] == 200:
            self.assertEqual(result['body']['tools'], [])
        self.assertEqual(self.tools(self.agent, other)['status'], 404)
        self.assertEqual(self.fake.executions, [])

    def test_removed_group_membership_revokes_live_principal(self):
        _wid, aid, cid, path = self.make_group(key='principal-group-0002')
        tid = self.trigger(path, aid, 'principal-reply-alice-002')['body']['reply']['task_id']
        self.agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
        self.assertEqual(self.tools(self.agent, tid)['status'], 200)
        with self.app.store.transaction() as db:
            db.execute('DELETE FROM social_members WHERE conversation_id=?', (cid,))
        self.assertEqual(self.tools(self.agent, tid)['status'], 403)

    def test_scheduled_opt_in_is_per_user_and_does_not_use_skill_material(self):
        wid = self.workspace()
        created = self.alice.call('POST', f'/v1/workspaces/{wid}/automations',
                                  {'title': 'Morning briefing', 'prompt': 'Summarize overnight activity.',
                                   'template_id': 'custom', 'schedule': DAILY, 'participants': ['alice']},
                                  {'HTTP_IDEMPOTENCY_KEY': 'composio-sched-0001'})
        self.assertEqual(created['status'], 201, created)
        aid = created['body']['automation']['id']
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{wid}/automations/{aid}',
                                         {'revision': 1, 'changes': {'enabled': True}})['status'], 200)
        unread = self.alice.call('GET', f'/v1/workspaces/{wid}/automations/{aid}/connected-tools')
        self.assertEqual(unread['status'], 200, unread)
        self.assertFalse(unread['body']['grant']['enabled'])
        # Tick without opt-in uses the injected fake backend and must not invent a principal.
        fired = self.alice.call('POST', f'/v1/workspaces/{wid}/automations/tick', {})
        self.assertEqual(fired['status'], 200, fired)
        self.assertEqual(len(fired['body']['items']), 1)
        self.assertFalse(fired['body']['items'][0].get('dispatch', {}).get('task_id'))
        enabled = self.alice.call('POST', f'/v1/workspaces/{wid}/automations/{aid}/connected-tools',
                                  {'enabled': True, 'revision': 0})
        self.assertEqual(enabled['status'], 200, enabled)
        self.assertTrue(enabled['body']['grant']['enabled'])
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{wid}/automations/{aid}/connected-tools',
                                         {'enabled': False, 'revision': 0})['status'], 409)
        uid = self.user_id(self.alice)
        with self.app.store.transaction() as db:
            connection = runtime_connect.online_connection(db, uid, self.now, 45, personal=True)
            self.assertIsNotNone(connection)
            payload = {'workspace_id': wid, 'automation_id': aid,
                       'prompt': 'Summarize overnight activity.', 'now': self.now}
            result = composio_principals.ScheduledToolBackend(
                AgentAutomationBackend(stale=45, timeout=60)
            ).dispatch_automation(payload, db=db)
        self.assertEqual(result.get('status'), 'queued', result)
        tid = result['task_id']
        self.agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
        discovery = self.tools(self.agent, tid)
        self.assertEqual(discovery['status'], 200, discovery)
        self.assertEqual([t['function']['name'] for t in discovery['body']['tools']], ['GITHUB_GET_USER'])
        # Skill material / skill_task_owners alone never become a Composio grant.
        with self.app.store.transaction() as db:
            connection = runtime_connect.online_connection(db, uid, self.now, 45, personal=True)
            task = runtime_connect.create_task(db, uid, connection['id'], self.now, 'infer', 'skill only', 60, wid)
            skill_tid = task['id']
            db.execute('INSERT INTO skill_task_owners VALUES(?,?,?)',
                       (skill_tid, uid, 'automation:' + wid + ':' + aid))
            self.assertIsNone(composio_principals.load(db, skill_tid))
            self.assertIsNone(composio_principals.authorized_user(db, skill_tid, uid))
        self.agent.call('POST', f'/v1/agent/tasks/{skill_tid}/claim', {})
        self.assertEqual(self.tools(self.agent, skill_tid)['status'], 403)
        self.assertEqual(self.alice.call('POST', f'/v1/workspaces/{wid}/automations/{aid}/connected-tools',
                                         {'enabled': False, 'revision': 1})['status'], 200)
        self.assertEqual(self.tools(self.agent, tid)['status'], 403)
        # Bob's own opt-in cannot revive Alice's revoked principal or use her key.
        self.alice.call('POST', f'/v1/workspaces/{wid}/members', {'username': 'bob', 'role': 'member'})
        bob_enable = self.bob.call('POST', f'/v1/workspaces/{wid}/automations/{aid}/connected-tools',
                                   {'enabled': True, 'revision': 0})
        self.assertEqual(bob_enable['status'], 200, bob_enable)
        alice_grant = self.alice.call('GET', f'/v1/workspaces/{wid}/automations/{aid}/connected-tools')
        self.assertFalse(alice_grant['body']['grant']['enabled'])
        self.assertEqual(self.tools(self.agent, tid)['status'], 403)

    def test_explicit_dsh_flag_and_session_attach_not_cross_user(self):
        wid = self.workspace()
        shared = self.alice.call('POST', '/v1/runtime/tasks', {
            'kind': 'infer', 'prompt': 'standalone dsh without flag', 'workspace_id': wid})
        self.assertEqual(shared['status'], 201, shared)
        sid = shared['body']['task']['id']
        self.agent.call('POST', f'/v1/agent/tasks/{sid}/claim', {})
        self.assertEqual(self.tools(self.agent, sid)['status'], 403)
        flagged = self.alice.call('POST', '/v1/runtime/tasks', {
            'kind': 'infer', 'prompt': 'standalone dsh with tools', 'workspace_id': wid,
            'connected_tools': True})
        self.assertEqual(flagged['status'], 201, flagged)
        fid = flagged['body']['task']['id']
        self.agent.call('POST', f'/v1/agent/tasks/{fid}/claim', {})
        self.assertEqual(self.tools(self.agent, fid)['status'], 200)
        attached = self.alice.call('POST', f'/v1/runtime/tasks/{sid}/connected-tools',
                                   {'action': 'attach', 'scope': 'dsh'})
        self.assertEqual(attached['status'], 200, attached)
        self.assertEqual(self.tools(self.agent, sid)['status'], 200)
        revoked = self.alice.call('POST', f'/v1/runtime/tasks/{sid}/connected-tools', {'action': 'revoke'})
        self.assertEqual(revoked['status'], 200, revoked)
        self.assertEqual(self.tools(self.agent, sid)['status'], 403)
        self.assertEqual(self.alice.call('POST', f'/v1/runtime/tasks/{sid}/connected-tools',
                                         {'action': 'attach', 'scope': 'group'})['status'], 400)
        self.assertEqual(self.bob.call('POST', f'/v1/runtime/tasks/{fid}/connected-tools',
                                       {'action': 'attach', 'scope': 'dsh'})['status'], 404)
        runtime_attach = self.agent.call('POST', f'/v1/runtime/tasks/{sid}/connected-tools',
                                         {'action': 'attach', 'scope': 'dsh'})
        self.assertIn(runtime_attach['status'], (401, 403, 404), runtime_attach)
        self.assertEqual(self.alice.call('POST', '/v1/runtime/tasks', {
            'kind': 'echo', 'prompt': 'no tools', 'connected_tools': True})['status'], 400)
        self.assertEqual(self.alice.call('POST', '/v1/runtime/tasks', {
            'kind': 'infer', 'prompt': 'no tools', 'connected_tools': 'yes'})['status'], 400)

    def test_personal_path_unchanged_and_workspace_task_has_no_implicit_grant(self):
        self.assertEqual(self.discover()['tools'][0]['function']['name'], 'GITHUB_GET_USER')
        wid = self.workspace()
        shared = self.alice.call('POST', '/v1/runtime/tasks', {
            'kind': 'infer', 'prompt': 'still no implicit grant', 'workspace_id': wid})['body']['task']
        self.agent.call('POST', f"/v1/agent/tasks/{shared['id']}/claim", {})
        self.assertEqual(self.tools(self.agent, shared['id'])['status'], 403)
