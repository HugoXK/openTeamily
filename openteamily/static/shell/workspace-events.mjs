// Server invalidations only: content remains behind the ordinary authenticated APIs.
export function mountWorkspaceEvents(document,{onInvalidate=()=>{},EventSource=globalThis.EventSource}={}){
  let source=null,wid='',fingerprints={},closed=false,generation=0;
  const status=document.getElementById('workspace-events-status');
  const show=text=>{if(status)status.textContent=text;};
  function disconnect(){generation++;source?.close();source=null;}
  function connect(){
    disconnect();
    if(closed||!wid||document.visibilityState==='hidden')return;
    if(typeof EventSource!=='function'){show('此浏览器不支持实时更新；保留定时 / 手动刷新。');return;}
    const own=wid,ownGeneration=generation;
    try{source=new EventSource('/v1/workspaces/'+wid+'/events',{withCredentials:true});}
    catch{show('无法建立实时连接，保留定时 / 手动刷新。');return;}
    show('连接实时更新…');
    source.addEventListener('open',()=>{if(wid===own&&generation===ownGeneration)show('实时更新已连接（非模型逐字推送）。');});
    source.addEventListener('error',()=>{if(wid===own&&generation===ownGeneration)show('实时连接中断，正在重连；仍可定时 / 手动刷新。');});
    source.addEventListener('invalidate',event=>{
      if(wid!==own||closed||generation!==ownGeneration)return;
      try{
        const data=JSON.parse(event.data);
        if(!/^[a-f0-9]{64}$/.test(data.version)||!data.domains||Object.keys(data.domains).some(k=>!['social','artifacts','notifications'].includes(k)||!/^[a-f0-9]{64}$/.test(data.domains[k])))return;
        const initial=Object.keys(fingerprints).length===0;
        const changed=Object.keys(data.domains).filter(k=>fingerprints[k]!==data.domains[k]);
        fingerprints={...data.domains};
        if(changed.length)Promise.resolve(onInvalidate({workspace:own,changed,initial})).catch(()=>show('更新读取失败，请手动刷新；未丢弃草稿。'));
      }catch{show('实时事件格式错误，未应用内容。');}
    });
    for(const name of ['revoked','unavailable'])source.addEventListener(name,()=>{
      if(wid!==own||generation!==ownGeneration)return;disconnect();show(name==='revoked'?'访问已失效，实时更新已关闭。':'实时更新暂不可用，请重试或手动刷新。');
    });
  }
  const visible=()=>{if(document.visibilityState==='hidden')disconnect();else connect();};
  const retry=()=>connect();
  document.addEventListener?.('visibilitychange',visible);
  document.getElementById('workspace-events-retry')?.addEventListener('click',retry);
  return {
    start(value){if(value===wid&&source)return;if(value!==wid)fingerprints={};wid=value||'';connect();},
    close(){closed=true;disconnect();document.removeEventListener?.('visibilitychange',visible);document.getElementById('workspace-events-retry')?.removeEventListener('click',retry);},
  };
}
