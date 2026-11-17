"""In-process checks for the CI UI screenshot fixtures. No browser and no server."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.ci_ui_fixtures import (
    ACTION_DUE_AT, ACTION_NOTES, ACTION_TITLE, AGENT_NAME, AUTOMATION_TITLE, BOARD_TITLE,
    CHAT_TITLE, CHAT_USER_TEXT, DOCUMENT_TITLE, EMPTY_WORKSPACE_NAME, MEDIA_TITLE,
    MEMBER_USERNAME, MEMORY_BODY, MEMORY_TITLE, MEMORY_TOPIC, RUNTIME_KEY_NAME, TEAM_NAME, TEAM_SLUG,
    USERNAME, WEBSITE_TITLE, seed_fixtures, solid_png,
)
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class CiUiFixtureTests(unittest.TestCase):
    def test_seed_creates_labeled_records_without_leaking_secrets_into_return(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        data_dir = Path(temp.name)
        password = 'fixture-password-not-for-screenshots'
        model_key = 'fixture-model-key-not-for-screenshots'
        seed = seed_fixtures(
            data_dir, ORIGIN, password, 'https://provider.test/v1', model_key, insecure_local=False,
        )
        self.assertEqual(seed['username'], USERNAME)
        self.assertEqual(seed['workspace_name'], TEAM_NAME)
        self.assertEqual(seed['team_slug'], TEAM_SLUG)
        self.assertEqual(seed['agent_name'], AGENT_NAME)
        self.assertTrue(seed['workspace_id'])
        self.assertTrue(seed['automation_id'])
        self.assertNotIn(password, repr(seed['cookies']))
        self.assertNotIn(model_key, repr(seed))
        dumped = repr(seed)
        self.assertNotIn(password, dumped)

        app = App(Store(data_dir / 'state'), Config(ORIGIN, allow_registration=True))
        client = Client(app)
        logged = client.call('POST', '/v1/auth/login', {'username': USERNAME, 'password': password})
        self.assertEqual(logged['status'], 200, logged)
        spaces = client.call('GET', '/v1/workspaces')
        self.assertEqual(spaces['status'], 200)
        names = {row['name'] for row in spaces['body']['items']}
        self.assertEqual(names, {TEAM_NAME, EMPTY_WORKSPACE_NAME})
        team = next(row for row in spaces['body']['items'] if row['name'] == TEAM_NAME)
        empty = next(row for row in spaces['body']['items'] if row['name'] == EMPTY_WORKSPACE_NAME)
        self.assertEqual(team['slug'], TEAM_SLUG)
        self.assertEqual(seed['workspace_id'], team['id'])
        self.assertEqual(seed['empty_workspace_id'], empty['id'])
        self.assertEqual(seed['empty_workspace_name'], EMPTY_WORKSPACE_NAME)
        empty_artifacts = client.call('GET', f'/v1/workspaces/{empty["id"]}/artifacts')
        self.assertEqual(empty_artifacts['status'], 200)
        self.assertEqual(empty_artifacts['body']['items'], [])
        wid = team['id']
        members = client.call('GET', f'/v1/workspaces/{wid}/members')
        self.assertEqual({row['username'] for row in members['body']['items']}, {USERNAME, MEMBER_USERNAME})
        agents = client.call('GET', f'/v1/workspaces/{wid}/agents')
        self.assertEqual([row['name'] for row in agents['body']['items']], [AGENT_NAME])
        agent_id = agents['body']['items'][0]['id']
        self.assertEqual(seed['agent_id'], agent_id)
        convs = client.call('GET', f'/v1/workspaces/{wid}/agents/{agent_id}/conversations')
        self.assertEqual(convs['status'], 200, convs)
        self.assertEqual([row['title'] for row in convs['body']['items']], [CHAT_TITLE])
        messages = client.call(
            'GET', f'/v1/workspaces/{wid}/agents/{agent_id}/conversations/{seed["conversation_id"]}/messages')
        self.assertEqual(messages['status'], 200, messages)
        self.assertTrue(any(row.get('role') == 'user' and row.get('body') == CHAT_USER_TEXT
                            for row in messages['body']['items']), messages)
        autos = client.call('GET', f'/v1/workspaces/{wid}/automations?category=mine')
        self.assertEqual([row['title'] for row in autos['body']['items']], [AUTOMATION_TITLE])
        artifacts = client.call('GET', f'/v1/workspaces/{wid}/artifacts')
        titles = {row['title'] for row in artifacts['body']['items']}
        self.assertEqual(titles, {DOCUMENT_TITLE, WEBSITE_TITLE, MEDIA_TITLE, BOARD_TITLE})
        pages = client.call('GET', f'/v1/workspaces/{wid}/memory')
        self.assertEqual(pages['status'], 200, pages)
        self.assertEqual([row['title'] for row in pages['body']['items']], [MEMORY_TITLE])
        self.assertEqual(pages['body']['items'][0]['topics'], [MEMORY_TOPIC])
        self.assertEqual(seed['memory_id'], pages['body']['items'][0]['id'])
        self.assertEqual(seed['memory_topic'], MEMORY_TOPIC)
        seen_page = client.call('GET', f'/v1/workspaces/{wid}/memory/{seed["memory_id"]}')
        self.assertEqual(seen_page['status'], 200, seen_page)
        self.assertEqual(seen_page['body']['page']['body'], MEMORY_BODY)
        actions = client.call('GET', f'/v1/workspaces/{wid}/memory/actions')
        self.assertEqual(actions['status'], 200, actions)
        self.assertEqual([row['title'] for row in actions['body']['items']], [ACTION_TITLE])
        self.assertEqual(seed['action_id'], actions['body']['items'][0]['id'])
        self.assertEqual(actions['body']['items'][0]['memory_page_title'], MEMORY_TITLE)
        seen_action = client.call('GET', f'/v1/workspaces/{wid}/memory/actions/{seed["action_id"]}')
        self.assertEqual(seen_action['status'], 200, seen_action)
        self.assertEqual(seen_action['body']['action']['notes'], ACTION_NOTES)
        self.assertEqual(seen_action['body']['action']['status'], 'open')
        self.assertEqual(seen_action['body']['action']['due_at'], ACTION_DUE_AT)
        self.assertEqual(seen_action['body']['action']['memory_page_id'], seed['memory_id'])
        keys = client.call('GET', '/v1/runtime-keys')
        self.assertEqual(keys['status'], 200)
        self.assertEqual(keys['body']['items'][0]['name'], RUNTIME_KEY_NAME)
        self.assertNotIn('token', keys['body']['items'][0])
        settings = client.call('GET', '/v1/settings')
        self.assertEqual(settings['body']['settings']['values']['appearance'], 'light')
        model = client.call('GET', '/v1/model-api')
        self.assertTrue(model['body']['model_api']['api_key_set'])
        self.assertNotIn(model_key, str(model['body']))
        self.assertTrue((data_dir / 'runtime-key').exists())
        self.assertEqual((data_dir / 'runtime-key').stat().st_mode & 0o077, 0)

    def test_solid_png_is_a_small_visible_fixture(self):
        data = solid_png()
        self.assertTrue(data.startswith(b'\x89PNG\r\n\x1a\n'))
        self.assertGreater(len(data), 40)


if __name__ == '__main__':
    unittest.main()
