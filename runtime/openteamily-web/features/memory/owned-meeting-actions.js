import { digest, HEX32, idempotencyKey, refuse, requireBodyKeys, validLongText } from '../../featurekit/http.js'
import { personalMemoryWorkspace, requireMemoryWorkspace } from './access.js'
import { validTitle } from './common.js'
import { actionView, createAction } from './extras.js'

function sourceReference(input) {
  const source = requireBodyKeys(input, ['workspace_id', 'meeting_id', 'action_index', 'revision'])
  const {workspace_id,meeting_id,action_index,revision} = source
  if (![workspace_id,meeting_id].every(id => typeof id === 'string' && HEX32.test(id)) ||
      !Number.isInteger(action_index) || action_index < 0 || action_index >= 50 ||
      !Number.isSafeInteger(revision) || revision < 1) {
    refuse(400, 'invalid', '请选择已保存的会议行动项。')
  }
  return source
}

async function savedAction(host, source) {
  const {workspace_id:workspace,meeting_id:id,action_index:index,revision} = source
  await requireMemoryWorkspace(host, workspace)
  const result = await host.call('meetings/v1', {
    method:'GET',path:`/v1/workspaces/${workspace}/meetings/${id}/action`,query:new URLSearchParams({index,revision}).toString(),
  })
  if ([403,404].includes(result?.status)) refuse(404, 'not_found', '无法访问原行动项。')
  if (result?.status === 409) refuse(409, 'source_changed', '会议行动项已更新，请重新打开并核对。')
  const {meeting,action} = result?.body || {}
  if (result?.status !== 200 || meeting?.id !== id || meeting.workspace_id !== workspace ||
      meeting.revision !== revision || typeof action?.text !== 'string' || !action.text || action.done !== false) {
    refuse(503, 'source_unavailable', '暂时无法核对原会议行动项。')
  }
  return action
}

export const ownedMeetingActionRoutes = [{
  pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/memory\/actions\/from-meeting$/,
  async handle(req, workspace) {
    if (req.method !== 'POST') refuse(405, 'method', 'Only POST is supported')
    if (req.queryString) refuse(400, 'invalid', 'Invalid meeting action request')
    if (await personalMemoryWorkspace(req.host) !== workspace) refuse(404, 'not_found', '请选择你的个人工作区。')
    idempotencyKey(req.headers)
    const {source:input,title,notes,due_at} = requireBodyKeys(await req.json(8192), ['source','title','notes','due_at'])
    const source = sourceReference(input)
    if (!validTitle(title) || !validLongText(notes, 2000) || (due_at !== null &&
        (!Number.isInteger(due_at) || due_at < 0 || due_at > 2 ** 31))) {
      refuse(400, 'invalid', '请检查待办标题、备注和截止日期。')
    }
    const original = await savedAction(req.host, source)
    const {workspace_id,meeting_id,revision,action_index} = source
    const key = digest('memory-action-meeting:' + JSON.stringify([workspace_id,meeting_id,original.text,
      original.owner ?? '',original.due_date ?? '']))
    return req.store.transaction(() => {
      const prior = req.store.get('SELECT * FROM memory_actions WHERE workspace_id=? AND key_hash=?', workspace, key)
      if (prior) return {body:{action:actionView(req.store,prior)}}
      const {status,action} = createAction(req, workspace, {title,notes,due_at}, key)
      req.store.run('INSERT INTO memory_owned_meeting_action_sources VALUES(?,?,?,?,?)',
        action.id, workspace_id, meeting_id, revision, action_index)
      return {status,body:{action:{...action,source:{kind:'meeting', ...source}}}}
    })
  },
}]
