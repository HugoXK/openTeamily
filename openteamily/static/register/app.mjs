// Credentials stay in form memory and the existing same-origin auth API only.
import {publicAgentIntentFromHash, publicAgentContinuation} from '../shell/public-agent-link.mjs';
import {publicWorkIntentFromHash} from '../shell/public-work-link.mjs';
import {teamInviteFromHash, teamInviteHash} from '../shell/team-invite-link.mjs';
import {rememberSignupSession, signupSessionError} from '../home/runtime-readiness.mjs';
const MESSAGES = {
  registration_closed: '本实例尚未开放注册，请联系实例管理员。',
  conflict: '此用户名不可用，请选择其他用户名。',
  rate_limited: '尝试次数过多，请稍后再试。',
  invalid: '请检查用户名和密码格式。',
  quota: '本实例账户数量已达上限。',
};

const platformId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

function personalChatPath(target) {
  const {workspace_id: workspace, agent_id: agent} = target || {};
  return platformId(workspace) && platformId(agent) ? '/chat#workspace=' + workspace + '&agent=' + agent : '';
}

export async function registerAccount(username, password, fetcher = globalThis.fetch, view) {
  try {
    const response = await fetcher('/v1/auth/register', {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify({username, password}),
    });
    if (response.status === 201) {
      const expectedName = username.trim().toLowerCase();
      let personalChat = '', expectedId;
      // Let the destination's existing session read confirm the account when the
      // browser can pass a short-lived ID to the next same-tab document.
      try {
        const {user, personal_chat: target} = await response.json();
        if (user?.username === expectedName && platformId(user.id)) {
          expectedId = user.id;
          personalChat = expectedId ? personalChatPath(target) : '';
          if (rememberSignupSession(view, expectedId)) {
            return {ok: true, pendingSession: true, ...(personalChat && {personalChat})};
          }
        }
      } catch {}
      try {
        const session = await fetcher('/v1/auth/session', {
          method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          headers: {Accept: 'application/json'},
        });
        const {user} = await session.json();
        if (session.status === 200 && user?.id && user.username === expectedName && (!expectedId || user.id === expectedId)) {
          return {ok: true, ...(personalChat && {personalChat})};
        }
      } catch {}
      return {ok:false,created:true,message:signupSessionError};
    }
    const body = await response.json().catch(() => ({}));
    // Never render arbitrary backend bodies or exceptions (which may echo input).
    const code = body?.error?.code;
    return {ok: false, message: Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : '未能创建账户，请稍后重试。'};
  } catch {
    return {ok: false, message: '无法连接到本实例，请稍后重试。'};
  }
}

export function mountRegistration(document, navigate, fetcher = globalThis.fetch) {
  const form = document.getElementById('register-form');
  const button = document.getElementById('register-submit');
  const status = document.getElementById('register-status');
  const username = document.getElementById('register-username');
  const password = document.getElementById('register-password');
  const hash = document.defaultView?.location?.hash;
  const work = publicWorkIntentFromHash(hash);
  const continuation = teamInviteHash(teamInviteFromHash(hash)) ||
    (work?.continuation ?? publicAgentContinuation(publicAgentIntentFromHash(hash)));
  const login = document.querySelector?.('a[href="/login"]');
  if (login && continuation) login.href = '/login' + continuation;
  const helpButton=document.getElementById('help-menu-button'),helpMenu=document.getElementById('help-menu');
  helpButton?.addEventListener('click',()=>{if(helpMenu){helpMenu.hidden=!helpMenu.hidden;helpButton.setAttribute('aria-expanded',String(!helpMenu.hidden));}});
  let attempted=false;
  const policy=document.getElementById('register-policy');
  if(policy)Promise.resolve(fetcher('/v1/auth/policy',{method:'GET',credentials:'same-origin',mode:'same-origin',redirect:'error'})).then(async response=>{
    const data=await response.json();
    if(attempted)return;
    if(response.status!==200||typeof data.registration_open!=='boolean')throw new Error('policy');
    policy.textContent = !data.registration_open ? '本实例尚未开放注册，请联系管理员。'
      : continuation ? '注册后将打开你访问的页面。' : '注册后可进入你的私人聊天。';
  }).catch(()=>{if(!attempted)policy.textContent='无法读取注册策略。请检查实例 HTTPS / 反向代理配置，或联系管理员。';});
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    attempted=true;
    button.disabled = true;
    status.textContent = '正在创建账户…';
    const result = await registerAccount(username.value, password.value, fetcher, document.defaultView);
    password.value = '';
    button.disabled = result.ok || result.created === true;
    if (result.ok) {
      status.textContent = continuation ? '账户已创建，正在打开你访问的页面…'
        : result.personalChat ? '账户已创建，正在打开私人聊天…' : '账户已创建，正在打开个人工作区…';
      navigate(continuation ? '/login' + continuation : result.personalChat || '/');
    } else {
      status.textContent = result.message;
      password.focus();
    }
  });
}

if (typeof document !== 'undefined') {
  mountRegistration(document, path => globalThis.location.assign(path));
}
