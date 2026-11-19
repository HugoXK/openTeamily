import { csrfCookie } from '../agents/app.mjs';
// Original content packages are loaded from the authenticated catalogue; no fake page-local installation.

export function filterSkills(items = [], query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items.slice();
  return items.filter((item) => `${item.name} ${item.description || item.content || ''}`.toLowerCase().includes(needle));
}

export function skillCountLabel(shown, total) {
  return shown === total ? `共 ${total} 个技能` : `显示 ${shown} / ${total} 个技能`;
}

export function mountSkills(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const list = document.getElementById('skills-list'), input = document.getElementById('skills-search');
  if (!list || !input) return null;
  const error = document.getElementById('skills-error');
  const scope = document.getElementById('skills-scope');
  const permission = document.getElementById('skills-permission');
  let catalogue = [], bindings = [], busy = false;
  async function request(method,path,body) {
    const csrf = csrfCookie(document.cookie);
    const result = await fetcher(path,{method, credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body ? JSON.stringify(body) : undefined});
    const data = await result.json();
    if (!result.ok && result.status !== 200) throw new Error(data.error?.message || '请求失败。');
    return data;
  }
  function render() {
    const matches = filterSkills(catalogue,input.value);
    list.replaceChildren();
    for (const skill of matches) {
      const item = document.createElement('li'); item.className='skill-card';
      const mark = document.createElement('span'); mark.className='skill-mark';mark.textContent=skill.name.slice(0,1);
      const copy = document.createElement('span');copy.className='skill-copy';
      const name = document.createElement('strong');name.textContent=skill.name;
      const status = document.createElement('p');
      const binding = bindings.find(b => b.scope === scope.value && b.skill_id === skill.id);
      if(binding)item.className+=' is-installed';
      status.textContent = binding && (binding.version!==skill.version || binding.digest!==skill.digest) ? '版本已变化；请卸载后重新安装' : binding ? (binding.last_loaded_task ? '已安装；历史任务已有加载回执（新任务重新校验）' : '已安装；等待下次推理任务加载') : '未安装';
      const details = document.createElement('details'), summary = document.createElement('summary');summary.textContent='查看真实技能内容 · '+skill.version;
      const content = document.createElement('pre');content.style.whiteSpace='pre-wrap';content.textContent=skill.content;
      const digest = document.createElement('small');digest.textContent='SHA-256: '+skill.digest;
      details.append(summary,content,digest);copy.append(name,status,details);
      const button=document.createElement('button');button.type='button';button.className='skill-install';button.dataset.skill=skill.id;
      button.textContent=binding ? '卸载' : '安装';button.disabled=busy;button.setAttribute('aria-label',button.textContent+' '+skill.name);
      button.addEventListener('click',async () => {
        if (busy) return;
        if (!binding && !permission.checked) { error.textContent='请先阅读技能内容并勾选允许将其作为模型上下文。'; return; }
        const selected=scope.value;busy=true;error.textContent='';render();
        try {
          await request('POST','/v1/skills/bindings',{skill_id:skill.id,version:skill.version,digest:skill.digest,scope:selected,enabled:!binding,permissions:['model_context']});
          bindings=(await request('GET','/v1/skills/bindings')).items || [];
          error.textContent=binding ? '已撤销绑定；新任务不可再加载该技能。已发往模型的内容无法撤回。' : '内容与绑定已安装；下次任务须通过运行时摘要校验及加载回执后才算已加载。';
        } catch(e) {error.textContent=e.message || '网络错误，结果未知，请刷新检查。';}
        finally {busy=false;render();}
      });
      item.append(mark,copy,button);list.append(item);
    }
    const empty=document.getElementById('skills-empty');if(empty)empty.hidden=matches.length>0;
    const count=document.getElementById('skills-count');if(count)count.textContent=skillCountLabel(matches.length,catalogue.length);
  }
  async function load() {
    try {
      const results = await Promise.all([request('GET','/v1/skills/catalog'),request('GET','/v1/skills/bindings')]);
      catalogue=results[0].items || [];bindings=results[1].items || [];render();
      const options=new Map();
      for(const binding of bindings){
        if(binding.scope==='account'||options.has(binding.scope))continue;
        const option=document.createElement('option');option.value=binding.scope;option.textContent='已绑定智能体（可撤销） · '+binding.scope.slice(-8);scope.append(option);options.set(binding.scope,option);
      }
      const workspaces=(await request('GET','/v1/workspaces')).items || [];
      for (const workspace of workspaces) {
        const agents=(await request('GET',`/v1/workspaces/${workspace.id}/agents?limit=100`)).items || [];
        for (const agent of agents) {
          if(agent.archived)continue;
          const value=workspace.id+':'+agent.id;
          const option=options.get(value)||document.createElement('option');option.value=value;option.textContent=workspace.name+' / '+agent.name;if(!options.has(value)){scope.append(option);options.set(value,option);}
        }
      }
    } catch(e) {error.textContent=e.message || '技能读取失败，请刷新重试。';}
  }
  input.addEventListener('input',render);
  scope.addEventListener('change',() => {permission.checked=false;render();});
  const ready=load();return {render,ready};
}

if (typeof document !== 'undefined') mountSkills(document);
