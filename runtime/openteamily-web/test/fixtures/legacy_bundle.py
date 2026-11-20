"""CI fixture: create legacy OpenTeamily data for test accounts through the real
legacy API (in-process WSGI, temp state), then print the DS-Bot import bundles
that openteamily.dsbot_bundle builds for one of those accounts.

usage: python3 legacy_bundle.py <feature> [<feature> ...]  -> JSON {feature: bundle_text, "expect": {...}}
Test accounts only (alice, bob); nothing leaves the temp directory.
"""
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from openteamily import dsbot_bundle  # noqa: E402
from openteamily.app import App, Config  # noqa: E402
from openteamily.store import Store  # noqa: E402
from tests.test_management import Client, ORIGIN  # noqa: E402


def seed_meetings(alice, bob, wid, bob_wid):
    created = alice.call('POST', f'/v1/workspaces/{wid}/meetings',
                         {'title': '周会', 'attendees': ['alice'], 'summary': '同步进度。', 'transcript': '讨论排期。',
                          'action_items': [{'text': '订会议室', 'owner': 'alice'}]},
                         {'HTTP_IDEMPOTENCY_KEY': 'fixture-meeting-0001'})
    assert created['status'] == 201, created
    other = bob.call('POST', f'/v1/workspaces/{bob_wid}/meetings', {'title': 'bob 的会'},
                     {'HTTP_IDEMPOTENCY_KEY': 'fixture-meeting-0002'})
    assert other['status'] == 201, other
    return {'meeting_id': created['body']['meeting']['id'], 'title': '周会', 'foreign_title': 'bob 的会'}


def seed_memory(alice, bob, wid, bob_wid):
    created = alice.call('POST', f'/v1/workspaces/{wid}/memory',
                         {'title': '客户偏好', 'body': '喜欢简洁的周报。', 'topics': ['客户']},
                         {'HTTP_IDEMPOTENCY_KEY': 'fixture-memory-0001'})
    assert created['status'] == 201, created
    page = created['body']['page']
    edited = alice.call('POST', f'/v1/workspaces/{wid}/memory/{page["id"]}',
                        {'revision': page['revision'], 'changes': {'body': '喜欢简洁的周报，周五发。'}})
    assert edited['status'] == 200, edited
    other = bob.call('POST', f'/v1/workspaces/{bob_wid}/memory', {'title': 'bob 的记忆', 'body': 'x'},
                     {'HTTP_IDEMPOTENCY_KEY': 'fixture-memory-0002'})
    assert other['status'] == 201, other
    return {'page_id': page['id'], 'title': '客户偏好', 'body': '喜欢简洁的周报，周五发。', 'revision': 2,
            'foreign_title': 'bob 的记忆'}



def seed_artifacts(alice, bob, wid, bob_wid):
    created = alice.call('POST', f'/v1/workspaces/{wid}/artifacts',
                         {'title': '周报', 'body': '本周完成迁移。', 'kind': 'document'},
                         {'HTTP_IDEMPOTENCY_KEY': 'fixture-artifact-0001'})
    assert created['status'] == 201, created
    other = bob.call('POST', f'/v1/workspaces/{bob_wid}/artifacts',
                     {'title': 'bob 的文档', 'body': 'x', 'kind': 'document'},
                     {'HTTP_IDEMPOTENCY_KEY': 'fixture-artifact-0002'})
    assert other['status'] == 201, other
    return {'artifact_id': created['body']['artifact']['id'], 'title': '周报', 'body': '本周完成迁移。',
            'foreign_title': 'bob 的文档'}


SEEDS = {'meetings': seed_meetings, 'memory': seed_memory, 'artifacts': seed_artifacts}


def main(features):
    with tempfile.TemporaryDirectory() as temp:
        store = Store(Path(temp) / 'state')
        app = App(store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        alice, bob = Client(app), Client(app, peer='127.0.0.2')
        alice.register('alice')
        bob.register('bob')
        wid = alice.workspace()['body']['workspace']['id']
        bob_wid = bob.workspace(key='request_example_0002')['body']['workspace']['id']
        expect = {'workspace_id': wid}
        for feature in features:
            expect[feature] = SEEDS[feature](alice, bob, wid, bob_wid)
        with store.connect() as db:
            user_id = db.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            bundles = {feature: dsbot_bundle.dumps(dsbot_bundle.build(db, user_id, feature, now=1800000000, data_dir=store.data_dir))
                       for feature in features}
        print(json.dumps({'bundles': bundles, 'expect': expect}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
