"""Meeting transcript sessions and speaker-labelled segments (issue #212 follow-up).

In-process App/Store/Config with a temporary SQLite database only. No audio,
ASR engine, network or browser E2E is involved.
"""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily import transcription
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


NOW = 1800000000


class TranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: NOW)
        self.alice = Client(self.app)
        self.assertEqual(self.alice.register('alice')['status'], 201)
        self.bob = Client(self.app, peer='127.0.0.2')
        self.assertEqual(self.bob.register('bob')['status'], 201)
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.other_wid = self.bob.workspace(
            name='另一个工作区', key='request_example_0002')['body']['workspace']['id']
        with self.app.store.connect() as db:
            transcription.ensure_schema(db)
            self.alice_id = db.execute(
                "SELECT id FROM users WHERE username='alice'").fetchone()[0]
            self.bob_id = db.execute(
                "SELECT id FROM users WHERE username='bob'").fetchone()[0]

    def start(self, wid=None, meeting_id='meeting-1', created_by=None, consent=True, **kw):
        with self.app.store.connect() as db:
            return transcription.start_session(
                db, wid or self.wid, meeting_id, created_by or self.alice_id, NOW,
                consent=consent, **kw)

    def append(self, session_id, speaker='alice', start_ms=0, end_ms=1000,
               text='hello', confidence=None, wid=None):
        with self.app.store.connect() as db:
            return transcription.append_segment(
                db, wid or self.wid, session_id, speaker, start_ms, end_ms, text, NOW,
                confidence=confidence)

    def test_schema_is_idempotent(self):
        with self.app.store.connect() as db:
            transcription.ensure_schema(db)
            transcription.ensure_schema(db)
            tables = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            indexes = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index'")}
        self.assertIn('transcription_sessions', tables)
        self.assertIn('transcript_segments', tables)
        self.assertTrue({'transcription_session_workspace',
                         'transcription_session_meeting',
                         'transcript_segment_session'}.issubset(indexes))
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
        session = self.start()
        self.assertEqual(session['status'], 'recording')

    def test_start_requires_consent(self):
        with self.app.store.connect() as db:
            with self.assertRaises(transcription.TranscriptionError) as caught:
                transcription.start_session(db, self.wid, 'meeting-1', self.alice_id, NOW)
            self.assertEqual(caught.exception.code, 'consent_required')
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM transcription_sessions').fetchone()[0], 0)
        session = self.start(consent=True, language='zh-CN')
        self.assertEqual(session['status'], 'recording')
        self.assertTrue(session['consent'])
        self.assertEqual(session['consent_by'], self.alice_id)
        self.assertEqual(session['consent_at'], NOW)
        self.assertEqual(session['language'], 'zh-CN')
        self.assertEqual(session['started'], NOW)
        self.assertIsNone(session['ended'])

    def test_append_requires_order_and_rejects_overlap(self):
        session = self.start()
        first = self.append(session['id'], 'alice', 0, 1000, 'first')
        second = self.append(session['id'], 'bob', 1000, 2000, 'second')
        self.assertNotEqual(first['id'], second['id'])
        with self.app.store.connect() as db:
            with self.assertRaises(transcription.TranscriptionError):
                transcription.append_segment(
                    db, self.wid, session['id'], 'carol', 1500, 2500, 'overlap', NOW)
            with self.assertRaises(transcription.TranscriptionError):
                transcription.append_segment(
                    db, self.wid, session['id'], 'carol', 500, 800, 'backwards', NOW)
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM transcript_segments WHERE session_id=?',
                (session['id'],)).fetchone()[0], 2)

    def test_invalid_time_ranges_are_rejected(self):
        session = self.start()
        with self.app.store.connect() as db:
            for start_ms, end_ms in ((-1, 1000), (1000, 1000), (2000, 1500),
                                     (0, transcription.MAX_MS + 1),
                                     (True, 1000), ('0', 1000)):
                with self.assertRaises(transcription.TranscriptionError, msg=(start_ms, end_ms)):
                    transcription.append_segment(
                        db, self.wid, session['id'], 'alice', start_ms, end_ms,
                        'bad range', NOW)
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM transcript_segments').fetchone()[0], 0)

    def test_confidence_is_bounded_and_optional(self):
        session = self.start()
        self.assertEqual(self.append(session['id'], start_ms=0, end_ms=1000,
                                     confidence=0.0)['confidence'], 0.0)
        self.assertEqual(self.append(session['id'], start_ms=1000, end_ms=2000,
                                     confidence=1.0)['confidence'], 1.0)
        self.assertIsNone(self.append(session['id'], start_ms=2000, end_ms=3000,
                                      confidence=None)['confidence'])
        with self.app.store.connect() as db:
            for confidence in (-0.01, 1.01, 'high', True):
                with self.assertRaises(transcription.TranscriptionError, msg=confidence):
                    transcription.append_segment(
                        db, self.wid, session['id'], 'alice', 3000, 4000,
                        'bad confidence', NOW, confidence=confidence)
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM transcript_segments').fetchone()[0], 3)

    def test_finalize_rejects_more_segments(self):
        session = self.start()
        self.append(session['id'], start_ms=0, end_ms=1000)
        with self.app.store.connect() as db:
            final = transcription.finalize_session(db, self.wid, session['id'], NOW + 5)
            self.assertEqual(final['status'], 'transcribed')
            self.assertEqual(final['ended'], NOW + 5)
            with self.assertRaises(transcription.TranscriptionError):
                transcription.append_segment(
                    db, self.wid, session['id'], 'alice', 1000, 2000, 'late', NOW)
            with self.assertRaises(transcription.TranscriptionError):
                transcription.finalize_session(db, self.wid, session['id'], NOW + 6)
        failed = self.start(meeting_id='meeting-2')
        with self.app.store.connect() as db:
            row = transcription.fail_session(db, self.wid, failed['id'], NOW + 7)
            self.assertEqual(row['status'], 'failed')
            with self.assertRaises(transcription.TranscriptionError):
                transcription.append_segment(
                    db, self.wid, failed['id'], 'alice', 0, 1000, 'after failure', NOW)

    def test_withdraw_consent_blocks_append(self):
        session = self.start()
        self.append(session['id'], start_ms=0, end_ms=1000)
        with self.app.store.connect() as db:
            withdrawn = transcription.withdraw_consent(db, self.wid, session['id'], NOW + 3)
            self.assertFalse(withdrawn['consent'])
            self.assertEqual(withdrawn['status'], 'failed')
            self.assertEqual(withdrawn['ended'], NOW + 3)
            with self.assertRaises(transcription.TranscriptionError) as caught:
                transcription.append_segment(
                    db, self.wid, session['id'], 'alice', 1000, 2000, 'blocked', NOW)
            self.assertEqual(caught.exception.code, 'consent_required')
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM transcript_segments WHERE session_id=?',
                (session['id'],)).fetchone()[0], 1)
            self.assertFalse(transcription.get_session(
                db, self.wid, session['id'])['consent'])

    def test_list_time_range_and_paging(self):
        session = self.start()
        expected = []
        for index in range(5):
            row = self.append(session['id'], 'alice', index * 1000, index * 1000 + 1000,
                              'segment-%d' % index)
            expected.append(row['id'])
        with self.app.store.connect() as db:
            first = transcription.list_segments(db, self.wid, session['id'],
                                                limit=2, cursor='')
            self.assertEqual([row['id'] for row in first], expected[:2])
            second = transcription.list_segments(db, self.wid, session['id'],
                                                 limit=2, cursor=first[-1]['id'])
            self.assertEqual([row['id'] for row in second], expected[2:4])
            third = transcription.list_segments(db, self.wid, session['id'],
                                                limit=2, cursor=second[-1]['id'])
            self.assertEqual([row['id'] for row in third], expected[4:])
            self.assertEqual(transcription.list_segments(
                db, self.wid, session['id'], limit=2, cursor=third[-1]['id']), [])
            ranged = transcription.list_segments(
                db, self.wid, session['id'], start_ms=2000, end_ms=4000,
                limit=10, cursor='')
            self.assertEqual([row['start_ms'] for row in ranged], [2000, 3000])
            tail = transcription.list_segments(
                db, self.wid, session['id'], start_ms=3500, limit=10, cursor='')
            self.assertEqual([row['start_ms'] for row in tail], [3000, 4000])
            self.assertEqual(transcription.list_segments(
                db, self.wid, session['id'], limit=10, cursor='missing'), [])
            for limit in (0, transcription.LIMIT_MAX + 1):
                with self.assertRaises(transcription.TranscriptionError):
                    transcription.list_segments(
                        db, self.wid, session['id'], limit=limit, cursor='')

    def test_search_finds_text_and_respects_workspace(self):
        first = self.start(meeting_id='meeting-search-1')
        self.append(first['id'], start_ms=0, end_ms=1000, text='Alpha budget review')
        self.append(first['id'], start_ms=1000, end_ms=2000, text='Beta 100% done')
        second = self.start(meeting_id='meeting-search-2')
        self.append(second['id'], start_ms=0, end_ms=1000, text='Alpha in second session')
        ellsewhere = self.start(wid=self.other_wid, created_by=self.bob_id,
                                meeting_id='meeting-search-3')
        self.append(ellsewhere['id'], wid=self.other_wid, start_ms=0, end_ms=1000,
                    text='Alpha elsewhere')
        with self.app.store.connect() as db:
            found = transcription.search(db, self.wid, 'alpha', limit=10)
            self.assertEqual(len(found), 2)
            self.assertEqual({row['session_id'] for row in found}, {first['id'], second['id']})
            self.assertTrue(all(row['meeting_id'] for row in found))
            other = transcription.search(db, self.other_wid, 'alpha', limit=10)
            self.assertEqual([row['session_id'] for row in other], [ellsewhere['id']])
            literal = transcription.search(db, self.wid, '100%', limit=10)
            self.assertEqual([row['text'] for row in literal], ['Beta 100% done'])
            for query in ('', '   ', 'x' * (transcription.QUERY_MAX + 1)):
                with self.assertRaises(transcription.TranscriptionError):
                    transcription.search(db, self.wid, query, limit=10)
            with self.assertRaises(transcription.TranscriptionError):
                transcription.search(db, self.wid, 'alpha', limit=0)

    def test_delete_session_cascades_and_is_workspace_scoped(self):
        session = self.start()
        self.append(session['id'], start_ms=0, end_ms=1000)
        self.append(session['id'], start_ms=1000, end_ms=2000)
        with self.app.store.connect() as db:
            self.assertFalse(transcription.delete_session(db, self.other_wid, session['id']))
            self.assertIsNotNone(transcription.get_session(db, self.wid, session['id']))
            self.assertTrue(transcription.delete_session(db, self.wid, session['id']))
            self.assertIsNone(transcription.get_session(db, self.wid, session['id']))
            self.assertEqual(transcription.list_segments(
                db, self.wid, session['id'], limit=10, cursor=''), [])
            self.assertFalse(transcription.delete_session(db, self.wid, session['id']))
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM transcript_segments WHERE session_id=?',
                (session['id'],)).fetchone()[0], 0)

    def test_oversize_and_control_text_are_rejected(self):
        with self.app.store.connect() as db:
            with self.assertRaises(transcription.TranscriptionError):
                transcription.start_session(
                    db, self.wid, 'meeting-1', self.alice_id, NOW, consent=True,
                    language='x' * (transcription.LANGUAGE_MAX + 1))
            with self.assertRaises(transcription.TranscriptionError):
                transcription.start_session(
                    db, self.wid, 'x' * (transcription.MEETING_MAX + 1), self.alice_id,
                    NOW, consent=True)
        session = self.start()
        with self.app.store.connect() as db:
            bad = (
                dict(speaker='x' * (transcription.SPEAKER_MAX + 1), text='ok'),
                dict(speaker='alice', text='x' * (transcription.TEXT_MAX + 1)),
                dict(speaker='alice', text='   '),
                dict(speaker='alice', text='bad\x00text'),
            )
            for index, fields in enumerate(bad):
                with self.assertRaises(transcription.TranscriptionError, msg=fields):
                    transcription.append_segment(
                        db, self.wid, session['id'], fields['speaker'], index * 1000,
                        index * 1000 + 1000, fields['text'], NOW)
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM transcript_segments').fetchone()[0], 0)

    def test_workspace_isolation(self):
        session = self.start()
        self.append(session['id'], start_ms=0, end_ms=1000, text='private hello')
        with self.app.store.connect() as db:
            self.assertIsNone(transcription.get_session(db, self.other_wid, session['id']))
            with self.assertRaises(transcription.TranscriptionError):
                transcription.append_segment(
                    db, self.other_wid, session['id'], 'bob', 1000, 2000,
                    'foreign append', NOW)
            self.assertEqual(transcription.list_segments(
                db, self.other_wid, session['id'], limit=10, cursor=''), [])
            self.assertEqual(transcription.search(db, self.other_wid, 'private'), [])
            self.assertIsNotNone(transcription.get_session(db, self.wid, session['id']))
            self.assertEqual(len(transcription.list_segments(
                db, self.wid, session['id'], limit=10, cursor='')), 1)


if __name__ == '__main__':
    unittest.main()
