'use strict';
(async()=>{
 const panel=$('direct-config'),status=$('direct-state');
 const legacy=location.origin==='http://127.0.0.1:8765';
 const direct=location.pathname==='/intake';
 if(!legacy&&!direct)return;
 panel.hidden=false;
 if(legacy){
  status.textContent='原地址草稿保留。把当前填写内容带到直存配置台后，确认目标项目再保存。';
  const button=el('button',{type:'button',class:'primary',text:'带着当前草稿去直存配置台'});panel.append(button);
  button.onclick=()=>{
   const nonce=crypto.randomUUID(),snapshot=collect(),destination='http://127.0.0.1:8766';
   const popup=window.open(destination+'/intake?handoff='+encodeURIComponent(nonce),'_blank');
   if(!popup){status.textContent='未能打开直存页面，请允许本次打开窗口，或导出 JSON 手动导入。';return;}
   const handler=e=>{if(e.origin!==destination||e.source!==popup||e.data?.type!=='intake-ready'||e.data.nonce!==nonce)return;popup.postMessage({type:'intake-draft',nonce,config:snapshot},destination);window.removeEventListener('message',handler);status.textContent='草稿已带入直存页面，尚未保存到项目；此处原草稿不变。';};
   window.addEventListener('message',handler);setTimeout(()=>window.removeEventListener('message',handler),120000);
  };return;
 }
 let base=null,loadedConfig=null,projects=[],saving=false,initializing=true,awaitingTransfer=false;
 const selector=$('direct-project'),save=$('direct-save'),load=$('direct-load');
 const request=async(path,body)=>{const headers={};if(body!==undefined){headers['Content-Type']='application/json';headers['X-Session-Token']=token;}const r=await fetch(path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'保存失败');return d;};
 let token;
 const back=document.querySelector('header a');if(back)back.href='/#home';
 const importLink=document.querySelector('#export a');if(importLink)importLink.href='/#config';
 const next=$('config-next-step');if(next)next.textContent='直接入库请用页首“检查并保存到协作台”，无需导出 JSON。JSON/Markdown 导出仍可用于留档或手动交接。';
 const describe=()=>{status.textContent=base?`当前依据：${base.name} · V${base.version}${base.isLatest?'':'（历史只读，不能从这里保存新版本）'}。保存不会改变旧版任务和评审。`:'当前为新建项目；请先确认项目名称，或选择已有版本并加载。';save.disabled=initializing||awaitingTransfer||saving||!!base&&!base.isLatest;};
 async function projectList(selected=''){
  projects=await request('/api/projects');selector.replaceChildren(el('option',{value:'',text:'新建项目（保留当前填写）'}));
  for(const p of projects)selector.append(el('option',{value:p.id,text:`${p.name} · V${p.version}${p.isLatest?'（最新）':'（历史）'}`}));selector.value=selected;
 }
 async function loadProject(id){
  const p=await request(`/api/projects/${id}/configuration`);restore(p.config);base=p;loadedConfig=structuredClone(p.config);selector.value=id;
  const history=$('direct-history');history.replaceChildren();const detail=el('details'),summary=el('summary',{text:`查看 ${p.history.length} 个配置版本（旧任务留在对应版本）`});detail.append(summary);
  for(const h of p.history){const line=el('p',{text:`V${h.version} · ${new Date(h.createdAt).toLocaleString('zh-CN')} `});const a=el('a',{href:'/?project='+encodeURIComponent(h.id)+'#progress',text:'查看项目进展（含该版记录）'});line.append(a);detail.append(line);}history.append(detail);describe();
 }
 // Loading a selection is explicit; changing the dropdown alone never discards the form.
 load.onclick=async()=>{if(saving)return;load.disabled=true;try{if(selector.value){await loadProject(selector.value);}else{base=null;loadedConfig=null;$('direct-history').replaceChildren();describe();}}catch(e){status.textContent=e.message;}finally{load.disabled=false;}};
 selector.onchange=()=>{save.disabled=true;status.textContent='请点击“加载所选版本”确认依据；加载已有版本会替换当前表单，未保存内容请先保存本机草稿。';};
 save.onclick=async()=>{
  if(saving||initializing)return;const {d,c}=generate(true);if(c.errors.length){status.textContent='请先修正标红配置，点击问题可定位。';return;}
  saving=true;save.disabled=true;load.disabled=true;selector.disabled=true;
  try{
   // Keep unknown envelope and per-record fields through the existing form serializer.
   const data=loadedConfig?{...loadedConfig,...d,fields:{...loadedConfig.fields,...d.fields}}:d;
   const result=await request('/api/configuration/save',{raw:JSON.stringify(data,null,2),...(base?{baseProjectId:base.id,expectedHash:base.sourceHash}:{})});
   await projectList(result.id);base=await request(`/api/projects/${result.id}/configuration`);loadedConfig=structuredClone(base.config);originalEnvelope=structuredClone(base.config);window.history.replaceState(null,'','/intake?project='+encodeURIComponent(base.id));
   const box=$('direct-result');box.replaceChildren(el('p',{class:'notice',text:result.duplicate?'这份配置已保存，没有新增版本。':`已保存 ${base.name} · V${base.version}。旧配置与原任务、评审未覆盖。`}));box.append(el('a',{href:'/?project='+encodeURIComponent(base.id)+'#home',text:'返回协作台，使用这个配置版本'}));
   await loadProject(base.id);
  }catch(e){status.textContent=e.message+'；当前表单未清空，可保存本机草稿后再处理。';}
  finally{saving=false;initializing=false;save.disabled=!!base&&!base.isLatest;load.disabled=false;selector.disabled=false;}
 };
 try{
  token=(await request('/api/session')).token;await projectList();$('direct-controls').hidden=false;
  const params=new URLSearchParams(location.search),id=params.get('project'),nonce=params.get('handoff');
  if(nonce&&window.opener){
   awaitingTransfer=true;status.textContent='等待原配置台带入草稿；尚未保存。';
   const handler=e=>{if(e.origin!=='http://127.0.0.1:8765'||e.source!==window.opener||e.data?.type!=='intake-draft'||e.data.nonce!==nonce)return;try{restore(e.data.config);awaitingTransfer=false;save.disabled=false;base=null;loadedConfig=null;status.textContent='原配置台草稿已带入。新建可直接保存；修改已有项目请先加载该版本，再手动调整。';}catch(error){status.textContent='带入失败：'+error.message;}window.removeEventListener('message',handler);};
   window.addEventListener('message',handler);window.opener.postMessage({type:'intake-ready',nonce},'http://127.0.0.1:8765');
  }else if(id){await loadProject(id);}else describe();
  initializing=false;if(!awaitingTransfer)describe();else save.disabled=true;
 }catch(e){initializing=false;save.disabled=true;status.textContent='未连接协作台：'+e.message+'。原草稿不变，可继续导出 JSON。';}
})();
