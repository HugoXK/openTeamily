"""Per-account installed skills.

The catalogue itself lives in `static/skills/app.mjs`; this module only keeps the
server-side allowlist and the rows that say which account installed which skill.
Tests assert both catalogues stay in step.
"""

SCHEMA = '''
CREATE TABLE IF NOT EXISTS skill_installs (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 skill_id TEXT NOT NULL,
 installed INTEGER NOT NULL,
 PRIMARY KEY (user_id, skill_id));
CREATE INDEX IF NOT EXISTS skill_install_user ON skill_installs(user_id, installed);
'''

# Mirrors SKILLS in openteamily/static/skills/app.mjs, in the same order.
SKILL_IDS = (
    'meeting-notes', 'web-summary', 'slide-draft', 'data-brief', 'email-draft',
    'doc-rewrite', 'code-review', 'market-watch', 'trip-plan', 'know-how',
)


def valid_skill(value):
    return type(value) is str and value in SKILL_IDS


def listing(db, user_id):
    rows = db.execute(
        'SELECT skill_id FROM skill_installs WHERE user_id=? ORDER BY installed, skill_id',
        (user_id,),
    ).fetchall()
    return {'installed': [row['skill_id'] for row in rows]}


def install(db, user_id, skill_id, now):
    db.execute(
        'INSERT INTO skill_installs VALUES(?,?,?) ON CONFLICT(user_id, skill_id) DO NOTHING',
        (user_id, skill_id, now),
    )


def uninstall(db, user_id, skill_id):
    return db.execute(
        'DELETE FROM skill_installs WHERE user_id=? AND skill_id=?', (user_id, skill_id)
    ).rowcount
