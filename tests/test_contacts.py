"""Personal contacts/address book tests. In-process SQLite only; no external sync."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily import contacts
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


NOW = 1800000000


class ContactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.store = Store(self.path)
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: NOW)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        with self.store.connect() as db:
            self.ids = {row['username']: row['id'] for row in db.execute('SELECT id, username FROM users')}
            contacts.ensure_schema(db)
        self.alice_id = self.ids['alice']
        self.bob_id = self.ids['bob']

    def create(self, name='Alice Smith', owner=None, now=NOW, **fields):
        with self.store.connect() as db:
            return contacts.create_contact(db, owner or self.alice_id, name, now, **fields)

    def group(self, name='Friends', owner=None, now=NOW):
        with self.store.connect() as db:
            return contacts.create_group(db, owner or self.alice_id, name, now)

    def get(self, contact_id, owner=None):
        with self.store.connect() as db:
            return contacts.get_contact(db, owner or self.alice_id, contact_id)

    def list_contacts(self, owner=None, **kw):
        with self.store.connect() as db:
            return contacts.list_contacts(db, owner or self.alice_id, **kw)

    def list_groups(self, owner=None):
        with self.store.connect() as db:
            return contacts.list_groups(db, owner or self.alice_id)

    def add(self, group_id, contact_id, owner=None):
        with self.store.connect() as db:
            return contacts.add_to_group(db, owner or self.alice_id, group_id, contact_id)

    def remove(self, group_id, contact_id, owner=None):
        with self.store.connect() as db:
            return contacts.remove_from_group(db, owner or self.alice_id, group_id, contact_id)

    def count(self, sql, *params):
        with self.store.connect() as db:
            return db.execute(sql, params).fetchone()[0]

    def test_schema_creation_is_idempotent_and_keeps_store_version(self):
        with self.store.connect() as db:
            contacts.ensure_schema(db)
            contacts.ensure_schema(db)
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            indexes = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}
            version = db.execute('PRAGMA user_version').fetchone()[0]
        self.assertTrue({'contacts', 'contact_groups', 'contact_group_members'} <= tables)
        self.assertTrue({'contact_owner_name', 'contact_group_owner',
                         'contact_group_member_contact'} <= indexes)
        self.assertEqual(version, 1)

    def test_create_get_update_delete_round_trip(self):
        created = self.create(
            email='alice@example.com', phone='+86 138 0000 0000', company='Acme',
            notes='Met at a conference.', tags=['work', 'friend', 'Work'],
            linked_user_id=self.bob_id,
        )
        self.assertEqual(created['display_name'], 'Alice Smith')
        self.assertEqual(created['tags'], ['work', 'friend'])
        self.assertEqual(created['linked_user_id'], self.bob_id)
        self.assertEqual(created['created'], NOW)
        self.assertEqual(created['updated'], NOW)
        self.assertEqual(self.get(created['id'])['email'], 'alice@example.com')
        with self.store.connect() as db:
            row = db.execute('SELECT tags FROM contacts WHERE id=?', (created['id'],)).fetchone()
        self.assertEqual(json.loads(row['tags']), ['work', 'friend'])

        updated = self.update(created['id'], {
            'display_name': 'Alice B.', 'email': 'alice.b@example.com',
            'phone': None, 'company': 'Acme Labs', 'tags': ['vip'],
        }, now=NOW + 5)
        self.assertEqual(updated['display_name'], 'Alice B.')
        self.assertEqual(updated['email'], 'alice.b@example.com')
        self.assertIsNone(updated['phone'])
        self.assertEqual(updated['company'], 'Acme Labs')
        self.assertEqual(updated['tags'], ['vip'])
        self.assertEqual(updated['created'], NOW)
        self.assertEqual(updated['updated'], NOW + 5)
        with self.assertRaises(ValueError):
            self.update(created['id'], {'owner_id': self.bob_id})

        with self.store.connect() as db:
            self.assertTrue(contacts.delete_contact(db, self.alice_id, created['id']))
        with self.assertRaises(LookupError):
            self.get(created['id'])
        with self.store.connect() as db:
            with self.assertRaises(LookupError):
                contacts.delete_contact(db, self.alice_id, created['id'])

    def update(self, contact_id, changes, owner=None, now=NOW + 1):
        with self.store.connect() as db:
            return contacts.update_contact(db, owner or self.alice_id, contact_id, changes, now)

    def test_duplicate_email_is_scoped_to_one_owner(self):
        self.create(name='One', email='same@example.com')
        with self.assertRaises(ValueError):
            self.create(name='Two', email='same@example.com')
        with self.assertRaises(ValueError):
            self.create(name='Case', email='SAME@example.com')
        other = self.create(name='Bob One', owner=self.bob_id, email='same@example.com')
        self.assertEqual(other['owner_id'], self.bob_id)

    def test_search_by_name_email_and_company_with_literal_wildcards(self):
        self.create(name='Alice Zhang', email='alice@example.com', company='Acme')
        self.create(name='Bob Li', email='bob@corp.example', company='Beta')
        self.create(name='Carol', email='carol@example.org', company='Acme Labs')
        self.create(name='100% Real', email='literal@example.com')

        items, cursor = self.list_contacts(query='alice')
        self.assertEqual([item['display_name'] for item in items], ['Alice Zhang'])
        self.assertIsNone(cursor)
        items, _ = self.list_contacts(query='CORP')
        self.assertEqual([item['display_name'] for item in items], ['Bob Li'])
        items, _ = self.list_contacts(query='Acme')
        self.assertEqual([item['display_name'] for item in items], ['Alice Zhang', 'Carol'])
        items, _ = self.list_contacts(query='100%')
        self.assertEqual([item['display_name'] for item in items], ['100% Real'])
        items, _ = self.list_contacts(query='_')
        self.assertEqual(items, [])

    def test_tag_filter_is_case_insensitive_and_exact(self):
        self.create(name='Friend', tags=['friend', 'work'])
        self.create(name='Work', tags=['work'])
        self.create(name='Other', tags=['workmate'])
        items, _ = self.list_contacts(tag='FRIEND')
        self.assertEqual([item['display_name'] for item in items], ['Friend'])
        items, _ = self.list_contacts(tag='work')
        self.assertEqual([item['display_name'] for item in items], ['Friend', 'Work'])

    def test_group_crud_membership_and_duplicate_names(self):
        friends = self.group('Friends')
        work = self.group('Work')
        self.assertEqual(friends['contact_count'], 0)
        with self.assertRaises(ValueError):
            self.group('Friends')
        self.assertEqual(self.group('Friends', owner=self.bob_id)['name'], 'Friends')
        with self.assertRaises(ValueError):
            self.group('')

        contact = self.create(name='Alice Smith')
        other = self.create(name='Bob Jones')
        self.assertTrue(self.add(friends['id'], contact['id']))
        self.assertFalse(self.add(friends['id'], contact['id']))
        self.assertTrue(self.add(work['id'], contact['id']))
        self.assertTrue(self.add(friends['id'], other['id']))

        items, _ = self.list_contacts(group_id=friends['id'])
        self.assertEqual([item['display_name'] for item in items], ['Alice Smith', 'Bob Jones'])
        groups = {row['name']: row for row in self.list_groups()}
        self.assertEqual(groups['Friends']['contact_count'], 2)
        self.assertEqual(groups['Work']['contact_count'], 1)

        with self.store.connect() as db:
            renamed = contacts.rename_group(db, self.alice_id, friends['id'], 'Close Friends')
        self.assertEqual(renamed['name'], 'Close Friends')
        with self.store.connect() as db:
            with self.assertRaises(ValueError):
                contacts.rename_group(db, self.alice_id, friends['id'], 'Work')

        self.assertTrue(self.remove(friends['id'], other['id']))
        self.assertFalse(self.remove(friends['id'], other['id']))
        with self.store.connect() as db:
            self.assertTrue(contacts.delete_group(db, self.alice_id, work['id']))
        self.assertEqual(self.count('SELECT COUNT(*) FROM contact_group_members WHERE group_id=?', work['id']), 0)
        self.assertEqual(len(self.list_groups()), 1)
        self.assertEqual(len(self.list_contacts()[0]), 2)
        with self.store.connect() as db:
            with self.assertRaises(LookupError):
                contacts.delete_group(db, self.alice_id, work['id'])

    def test_deleting_a_contact_removes_group_membership(self):
        group = self.group('Friends')
        contact = self.create()
        self.add(group['id'], contact['id'])
        self.assertEqual(self.count('SELECT COUNT(*) FROM contact_group_members'), 1)
        with self.store.connect() as db:
            self.assertTrue(contacts.delete_contact(db, self.alice_id, contact['id']))
        self.assertEqual(self.count('SELECT COUNT(*) FROM contact_group_members'), 0)
        items, _ = self.list_contacts(group_id=group['id'])
        self.assertEqual(items, [])
        self.assertEqual(self.list_groups()[0]['contact_count'], 0)
        with self.store.connect() as db:
            self.assertTrue(contacts.delete_group(db, self.alice_id, group['id']))

    def test_owner_isolation_for_contacts_and_groups(self):
        contact = self.create(name='Alice Private', email='private@example.com')
        group = self.group('Alice Group')
        bob_contact = self.create(name='Bob Private', owner=self.bob_id)
        bob_group = self.group('Bob Group', owner=self.bob_id)

        with self.store.connect() as db:
            with self.assertRaises(PermissionError):
                contacts.get_contact(db, self.bob_id, contact['id'])
            with self.assertRaises(PermissionError):
                contacts.update_contact(db, self.bob_id, contact['id'], {'notes': 'x'}, NOW)
            with self.assertRaises(PermissionError):
                contacts.delete_contact(db, self.bob_id, contact['id'])
            with self.assertRaises(PermissionError):
                contacts.list_contacts(db, self.bob_id, group_id=group['id'])
            with self.assertRaises(PermissionError):
                contacts.rename_group(db, self.bob_id, group['id'], 'Stolen')
            with self.assertRaises(PermissionError):
                contacts.delete_group(db, self.bob_id, group['id'])
            with self.assertRaises(PermissionError):
                contacts.add_to_group(db, self.bob_id, group['id'], bob_group['id'])
            with self.assertRaises(PermissionError):
                contacts.add_to_group(db, self.alice_id, group['id'], bob_contact['id'])
            with self.assertRaises(PermissionError):
                contacts.remove_from_group(db, self.bob_id, group['id'], contact['id'])
            with self.assertRaises(LookupError):
                contacts.get_contact(db, self.bob_id, '0' * 32)

        bob_contacts, _ = self.list_contacts(owner=self.bob_id)
        self.assertEqual([row['display_name'] for row in bob_contacts], ['Bob Private'])
        self.assertEqual([row['name'] for row in self.list_groups(owner=self.bob_id)], ['Bob Group'])
        self.assertEqual(len(self.list_contacts()[0]), 1)

    def test_invalid_fields_tags_and_oversize_are_rejected(self):
        bad_tags = [
            'friend', [''], ['   '], [1], ['ok', 1], ['x' * 31],
            ['tag%d' % index for index in range(13)],
            ['bad\x01tag'],
        ]
        for tags in bad_tags:
            with self.assertRaises(ValueError):
                self.create(tags=tags)
        with self.assertRaises(ValueError):
            self.create(name='')
        with self.assertRaises(ValueError):
            self.create(name='x' * 81)
        with self.assertRaises(ValueError):
            self.create(name='bad\x01name')
        with self.assertRaises(ValueError):
            self.create(email='not-an-email')
        with self.assertRaises(ValueError):
            self.create(email='a' * 250 + '@example.com')
        with self.assertRaises(ValueError):
            self.create(phone='1' * 41)
        with self.assertRaises(ValueError):
            self.create(company='c' * 121)
        with self.assertRaises(ValueError):
            self.create(notes='n' * 2001)
        with self.assertRaises(LookupError):
            self.create(linked_user_id='f' * 32)

        contact = self.create(tags=['a' * 30] + ['tag%d' % index for index in range(11)])
        self.assertEqual(len(contact['tags']), 12)
        with self.assertRaises(ValueError):
            self.update(contact['id'], {'tags': ['bad\x01tag']})

    def test_cursor_paging_is_stable_and_filterable(self):
        names = ['Charlie', 'Alice', 'Bob', 'Dave', 'Eve', 'Frank', 'Grace']
        for name in names:
            self.create(name=name, tags=['team'] if name in ('Alice', 'Bob') else [])
        expected = sorted(names, key=str.lower)
        seen = []
        cursor = None
        pages = 0
        while True:
            items, cursor = self.list_contacts(limit=2, cursor=cursor)
            self.assertLessEqual(len(items), 2)
            seen.extend(item['display_name'] for item in items)
            pages += 1
            if cursor is None:
                break
        self.assertEqual(seen, expected)
        self.assertEqual(pages, 4)

        seen = []
        cursor = None
        while True:
            items, cursor = self.list_contacts(query='a', limit=1, cursor=cursor)
            seen.extend(item['display_name'] for item in items)
            if cursor is None:
                break
        self.assertEqual(seen, [name for name in expected if 'a' in name.lower()])

        items, cursor = self.list_contacts(tag='team', limit=1)
        self.assertEqual([item['display_name'] for item in items], ['Alice'])
        self.assertIsNotNone(cursor)
        items, cursor = self.list_contacts(tag='team', limit=1, cursor=cursor)
        self.assertEqual([item['display_name'] for item in items], ['Bob'])
        self.assertIsNone(cursor)

        for bad in ('not-a-cursor', '', 'e30'):
            with self.assertRaises(ValueError):
                self.list_contacts(cursor=bad)
        for limit in (0, 101, True, '2'):
            with self.assertRaises(ValueError):
                self.list_contacts(limit=limit)
        with self.assertRaises(ValueError):
            self.list_contacts(query='q' * 101)


if __name__ == '__main__':
    unittest.main()
