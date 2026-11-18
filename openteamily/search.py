"""Workspace-authorized message search (issue #88).

Self-written for OpenTeamily; no upstream or Teamily source. Searches only the
messages the caller may already read: their own user↔agent conversations and
social conversations they belong to. It is a simple substring scan with a
bounded page, not a full-text index, ranking model or semantic search.
"""
import re

CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
HEX32 = re.compile(r'[0-9a-f]{32}')
QUERY_MAX = 80
SNIPPET_MAX = 160
KINDS = ('all', 'agent', 'social')


def valid_query(value):
    return (isinstance(value, str) and 1 <= len(value.strip()) <= QUERY_MAX
            and not CONTROL.search(value))


def snippet(body):
    text = ' '.join((body or '').split())
    if len(text) <= SNIPPET_MAX:
        return text
    return text[:SNIPPET_MAX] + '…'


def agent_rows(db, workspace_id, user_id, text, cursor, limit, conversation_id=''):
    return db.execute(
        'SELECT m.id, m.conversation_id, m.body, m.created, m.role, '
        'c.title, a.name AS agent_name '
        'FROM agent_messages m JOIN agent_conversations c ON c.id=m.conversation_id '
        'LEFT JOIN workspace_agents a ON a.id=c.agent_id '
        'WHERE m.workspace_id=? AND c.user_id=? AND m.id>? '
        "AND (?='' OR m.conversation_id=?) "
        'AND instr(lower(m.body), lower(?))>0 ORDER BY m.id LIMIT ?',
        (workspace_id, user_id, cursor, conversation_id, conversation_id, text, limit),
    ).fetchall()


def social_rows(db, workspace_id, user_id, text, cursor, limit, conversation_id=''):
    # Import at call time: social already uses search.snippet for previews.
    # Reuse exactly the authorized message stream's success-only projection,
    # never task output, pending/error bodies or the original request prompt.
    from .social import MESSAGE_ROWS
    return db.execute(
        'SELECT m.id, m.conversation_id, m.body, m.created, m.agent_id, m.agent_name, '
        'c.title, c.kind AS conversation_kind '
        f'FROM ({MESSAGE_ROWS}) m JOIN social_conversations c ON c.id=m.conversation_id '
        'AND c.workspace_id=m.workspace_id '
        'JOIN social_members s ON s.conversation_id=c.id AND s.workspace_id=c.workspace_id AND s.user_id=? '
        'WHERE m.workspace_id=? AND m.id>? '
        "AND (?='' OR m.conversation_id=?) "
        'AND instr(lower(m.body), lower(?))>0 ORDER BY m.id LIMIT ?',
        (user_id, workspace_id, cursor, conversation_id, conversation_id, text, limit),
    ).fetchall()


def item(kind, row):
    if kind == 'agent':
        title = row['agent_name'] or row['title'] or '对话'
    else:
        title = row['title'] or ('群聊' if row['conversation_kind'] == 'group' else '单聊')
    data = {
        'kind': kind,
        'conversation_id': row['conversation_id'],
        'message_id': row['id'],
        'title': title,
        'snippet': snippet(row['body']),
        'created': row['created'],
    }
    if kind == 'social' and row['agent_id']:
        data.update(role='agent', agent_id=row['agent_id'], agent_name=row['agent_name'],
                    source='runtime_infer')
    return data


def messages(db, workspace_id, user_id, text, kind, cursor, limit, conversation_id=''):
    collected = []
    if kind in ('all', 'agent'):
        collected.extend(item('agent', row) for row in agent_rows(
            db, workspace_id, user_id, text, cursor, limit, conversation_id))
    if kind in ('all', 'social'):
        collected.extend(item('social', row) for row in social_rows(
            db, workspace_id, user_id, text, cursor, limit, conversation_id))
    collected.sort(key=lambda entry: entry['message_id'])
    return collected[:limit]
