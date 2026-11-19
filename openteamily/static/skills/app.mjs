// Skills library catalogue. The catalogue is a self-written page constant; the
// installed set is stored per account by the management API. The page reads the
// account list on load and writes it on every install/uninstall click.

export const SKILLS = [
  {id: 'meeting-notes', mark: '会', name: '会议纪要', description: '把会议记录整理成结论、待办和负责人。'},
  {id: 'web-summary', mark: '网', name: '网页摘要', description: '提取网页正文并生成一段可读的要点摘要。'},
  {id: 'slide-draft', mark: '演', name: '幻灯片草稿', description: '把一份大纲整理成幻灯片页面和讲解要点。'},
  {id: 'data-brief', mark: '数', name: '数据速览', description: '汇总表格里的关键数字、变化和异常项。'},
  {id: 'email-draft', mark: '邮', name: '邮件起草', description: '根据上下文起草一封语气合适的邮件。'},
  {id: 'doc-rewrite', mark: '文', name: '文档改写', description: '调整文档的语气、长度和段落结构。'},
  {id: 'code-review', mark: '码', name: '代码审阅', description: '标出改动里的风险、边界和遗漏的测试。'},
  {id: 'market-watch', mark: '竞', name: '竞品观察', description: '把公开资料中的产品更新整理成对照清单。'},
  {id: 'trip-plan', mark: '行', name: '行程规划', description: '把时间、地点和预算整理成可执行的行程。'},
  {id: 'know-how', mark: '知', name: '知识检索', description: '在工作区已授权的资料中查找相关答案。'},
];

const INSTALLED = '/v1/skills/installed';

export function filterSkills(items = SKILLS, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items.slice();
  return items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(needle));
}

export function skillButtonLabel(installed) {
  return installed ? '已安装' : '安装';
}

export function skillCountLabel(shown, total) {
  return shown === total ? `共 ${total} 个技能` : `显示 ${shown} / ${total} 个技能`;
}

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

async function errorText(response, fallback) {
  try {
    const payload = await response.json();
    const message = payload && payload.error && payload.error.message;
    if (typeof message === 'string' && message) return message;
  } catch (failure) {
    return fallback;
  }
  return fallback;
}

function installSet(payload) {
  return new Set(payload && Array.isArray(payload.installed) ? payload.installed : []);
}

export async function readInstalled(fetcher = fetch) {
  const response = await fetcher(INSTALLED, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {Accept: 'application/json'},
  });
  if (!response.ok) throw new Error(await errorText(response, '读取已安装技能失败，请重试'));
  return installSet(await response.json());
}

export async function writeInstalled(skillId, wanted, options = {}) {
  const fetcher = options.fetchImpl || fetch;
  const cookie = options.cookie !== undefined
    ? options.cookie
    : (typeof document === 'undefined' ? '' : document.cookie);
  const response = await fetcher(INSTALLED, {
    method: wanted ? 'POST' : 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfCookie(cookie),
    },
    body: JSON.stringify({skill: skillId}),
  });
  if (!response.ok) {
    throw new Error(await errorText(response, wanted ? '安装失败，请重试' : '卸载失败，请重试'));
  }
  return installSet(await response.json());
}

export function mountSkills(document, api) {
  const list = document.getElementById('skills-list');
  const input = document.getElementById('skills-search');
  const empty = document.getElementById('skills-empty');
  const count = document.getElementById('skills-count');
  const error = document.getElementById('skills-error');
  if (!list || !input) return null;
  const handlers = api || {
    read: () => readInstalled(),
    write: (skillId, wanted) => writeInstalled(skillId, wanted),
  };
  const installed = new Set();
  const busy = new Set();
  let loading = true;

  function showError(message) {
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
  }

  function render() {
    list.setAttribute('aria-busy', loading ? 'true' : 'false');
    const matches = filterSkills(SKILLS, input.value);
    list.replaceChildren(...matches.map((skill) => {
      const isInstalled = installed.has(skill.id);
      const item = document.createElement('li');
      item.className = 'skill-card';
      if (isInstalled) item.classList.add('is-installed');

      const mark = document.createElement('span');
      mark.className = 'skill-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = skill.mark;

      const copy = document.createElement('span');
      copy.className = 'skill-copy';
      const name = document.createElement('strong');
      name.textContent = skill.name;
      const description = document.createElement('span');
      description.className = 'skill-description';
      description.textContent = skill.description;
      copy.append(name, description);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'skill-install';
      button.dataset.skill = skill.id;
      button.disabled = loading || busy.has(skill.id);
      button.setAttribute('aria-pressed', isInstalled ? 'true' : 'false');
      button.setAttribute('aria-label', `${isInstalled ? '卸载' : '安装'} ${skill.name}`);
      button.textContent = skillButtonLabel(isInstalled);
      button.addEventListener('click', async () => {
        if (loading || busy.has(skill.id)) return;
        button.disabled = true;
        const wanted = !installed.has(skill.id);
        busy.add(skill.id);
        showError('');
        try {
          const next = await handlers.write(skill.id, wanted);
          installed.clear();
          for (const value of next) installed.add(value);
        } catch (failure) {
          showError(failure && failure.message ? failure.message : '操作失败，请重试');
        } finally {
          busy.delete(skill.id);
          render();
        }
      });

      item.append(mark, copy, button);
      return item;
    }));
    if (empty) empty.hidden = matches.length > 0;
    if (count) count.textContent = skillCountLabel(matches.length, SKILLS.length);
  }

  const ready = (async () => {
    try {
      const current = await handlers.read();
      installed.clear();
      for (const value of current) installed.add(value);
    } catch (failure) {
      showError(failure && failure.message ? failure.message : '读取已安装技能失败，请重试');
    } finally {
      loading = false;
      render();
    }
  })();

  input.addEventListener('input', render);
  showError('');
  render();
  return {installed, render, ready};
}

if (typeof document !== 'undefined') mountSkills(document);
