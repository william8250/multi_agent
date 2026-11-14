'use strict';
const $ = id => document.getElementById(id);
let sessionToken;
const labels = {guide:'用户手册',stage:'阶段成果',overview:'项目全貌',home:'定义需求',progress:'研发进展',decisions:'需要我决定',experience:'体验与审美',coordination:'用户交互队列',project:'项目',config:'配置与资料',tasks:'任务与交接',review:'评审与人工复核',records:'记录与备份'};
function route() {
  const hash=location.hash.slice(1),stageRoute=/^stage-(requirements|design|coding|testing|acceptance|release)$/.test(hash),id=stageRoute?'stage':Object.hasOwn(labels,hash)&&hash!=='stage'?hash:'overview';
  for (const key of Object.keys(labels)) $(key).hidden=key!==id;
  for (const link of document.querySelectorAll('nav a')) {if(link.hash===`#${id}`)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  const userMode=['guide','stage','overview','home','progress','decisions','experience'].includes(id);document.body.dataset.mode=userMode?'user':'agent';
  $('mode-user').setAttribute('aria-pressed',String(userMode));$('mode-agent').setAttribute('aria-pressed',String(!userMode));
  $('crumb').textContent=stageRoute?'项目全貌 / 阶段成果':labels[id];if(id==='stage'&&typeof userData!=='undefined'&&userData)renderUserStage();
}
window.addEventListener('hashchange',route);route();
function message(text) { $('notice').textContent=text; $('notice').hidden=!text; }
function text(tag,content,className) {const e=document.createElement(tag);e.textContent=content;if(className)e.className=className;return e;}
async function api(url,body) {
  const options={headers:{}};
  if(body!==undefined){options.method='POST';options.headers={'Content-Type':'application/json','X-Session-Token':sessionToken};options.body=JSON.stringify(body);}
  const response=await fetch(url,options);
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'本地操作未完成，请重试。'),{code:result.code,errorKey:result.errorKey});return result;
}
function when(value){return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'时间未记录';}
async function refresh(){
  const [health,projects,backups,audit]=await Promise.all([api('/api/health'),api('/api/projects'),api('/api/backups'),api('/api/audit')]);
  $('health').textContent=`本地服务已连接 · ${health.projectCount??projects.length} 个项目`;
  if(health.missing?.length||health.corrupt?.length)message('检测到资料文件缺失或校验失败。请保留当前数据，在“记录与备份”校验可用副本；相关证据不可作为通过依据。');
  else if(health.orphans?.length||health.staged?.length)message('检测到上次操作留下的未关联文件，已保留。请先检查备份，勿手动覆盖原资料。');
  $('projects').replaceChildren();
  if(!projects.length)$('projects').append(text('p','还没有保存的项目。导入配置后会显示在这里。','hint'));
  for(const p of projects){const row=text('div','','row'),info=text('div','');info.append(text('strong',`${p.name} · V${p.version}${p.isLatest?'':'（历史）'}`),text('p',`保存于 ${when(p.createdAt)} · ${p.skillCount} 个 skill 原包`,'meta'));const link=text('a','导出原配置','text-link');link.href=`/api/projects/${encodeURIComponent(p.id)}/export`;link.download='project-config.json';row.append(info,link);$('projects').append(row);}
  if(projects.length){$('next-title').textContent='检查配置已保存，并验证备份';$('next-description').textContent='配置已入库。可以建立任务并手动交接；收到结果后进入独立评审。';const link=document.querySelector('.next .button');link.href='#records';link.textContent='去检查备份';}
  $('backups').replaceChildren();
  if(!backups.length)$('backups').append(text('p','还没有备份。首次导入前将自动创建，也可手动创建。','hint'));
  for(const b of backups){const row=text('div','','row'),info=text('div','');info.append(text('strong',`备份 · ${when(b.createdAt)}`),text('p',`触发原因：${({'manual':'手动创建','before-migration':'导入前','before-task-schema':'任务模块升级前','before-review-schema':'评审模块升级前','before-gate-schema':'评分裁决模块升级前','before-plan-schema':'计划与任务关联升级前','before-user-console-schema':'双态界面升级前','before-gate-approval':'人工批准前','daily-first-write':'每日首写前'})[b.reason]||'系统备份'}`,'meta'));const button=text('button','校验恢复副本','quiet');button.onclick=()=>busy(button,async()=>{const result=await api(`/api/backups/${encodeURIComponent(b.id)}/verify`,{});if(!result.ok)throw new Error('备份校验未通过，请保留当前数据并检查备份文件。');$('backup-status').textContent=`校验通过：${result.projectCount} 个项目、${result.objectCount} 个对象；当前数据未被覆盖。`;await refresh();});row.append(info,button);$('backups').append(row);}
  if(typeof refreshTasks==='function')await refreshTasks(projects);
  if(typeof refreshReviews==='function')await refreshReviews();
  if(typeof refreshUser==='function')await refreshUser();
  $('audit').replaceChildren();
  if(!audit.length)$('audit').append(text('p','还没有操作记录。','hint'));
  const events={development_plan_proposed:'开发计划已整理',development_plan_answered:'重要计划处理已记录',development_plan_auto_started:'普通计划已按授权建立任务',config_revision_saved:'新配置版本已保存',config_imported:'配置已入库',backup_created:'备份已创建',backup_verify_success:'备份恢复校验通过',backup_verify_failure:'备份恢复校验失败',task_created:'任务已建立',task_dependencies_changed:'任务依赖已修改',task_started:'任务前置检查完成',package_prepared:'任务包已准备',handoff_confirmed:'应用提交已手动登记',result_received:'回复原文已回收',result_resolved:'结果版本已选用',selection_invalidated:'新回复使旧选用失效',review_round_opened:'评审依据已冻结',review_submitted:'独立意见已封存',review_comment_added:'交叉补充已追加',review_topic_decided:'人工处理决定已保存',gate_score_added:'评分修订已记录',gate_score_selected:'最新评分已选用',gate_topic_resolved:'落实及独立核查证据已记录',gate_cross_confirmed:'交叉核查已登记',gate_escalation_resolved:'人工升级处理已记录',gate_decided:'人工最终裁决已记录',gate_invalidated:'旧裁决及下游已失效',user_request_recorded:'用户想法或反馈已保存',project_paused:'用户已暂停后续分发',project_resumed:'用户已恢复后续分发',user_request_acknowledged:'协调方已处理用户输入',user_decision_requested:'已向用户提出决策',user_decision_answered:'用户选择已记录',user_preview_registered:'成果入口已登记',user_progress_recorded:'研发进展已更新'};
  for(const e of [...audit].slice(-30).reverse()){const row=text('div','','row');row.append(text('span',events[e.event]||e.event||'本地操作'),text('time',when(e.createdAt||e.at||e.time),'meta'));$('audit').append(row);}
}
async function busy(button,fn){button.disabled=true;const old=button.textContent;button.textContent='处理中…';message('');try{await fn();}catch(error){message(error.message);}finally{button.disabled=button.dataset.locked==='true';button.textContent=old;}}
$('refresh').onclick=()=>busy($('refresh'),refresh);
$('backup').onclick=()=>busy($('backup'),async()=>{await api('/api/backups',{});$('backup-status').textContent='备份已保存。点击下方“校验恢复副本”检查可恢复性。';await refresh();});
$('import-form').onsubmit=event=>{event.preventDefault();const button=event.submitter;busy(button,async()=>{
  const input=$('config-file');$('file-error').hidden=true;input.removeAttribute('aria-invalid');$('import-result').hidden=true;$('conflict-actions').hidden=true;
  try{const file=input.files[0];if(!file)throw new Error('请选择之前导出的开发配置 JSON。');if(file.size>16*1024*1024)throw new Error('配置超过16MB，请减少附件后重新导出。');const raw=await file.text();const result=await api('/api/import',{raw});
    const panel=$('import-result');panel.replaceChildren(text('strong',result.duplicate?'这份配置已经保存，无需重复导入。':'配置已保存到本机资料库。'),text('p',`${result.name} · ${result.skillCount} 个 skill 原包`));
    const warnings=result.attachmentWarnings||[];if(warnings.length){const list=document.createElement('ul');for(const warning of warnings)list.append(text('li',typeof warning==='string'?warning:`${warning.group==='billing'?'账单':'需求'}附件“${warning.name}”仅有文件信息，正文待重新关联。`));panel.append(list);}
    const link=text('a','查看项目与下一步','text-link');link.href='#project';panel.append(link);panel.hidden=false;await refresh();
  }catch(error){input.setAttribute('aria-invalid','true');$('file-error').textContent=error.message;$('file-error').hidden=false;$('conflict-actions').hidden=error.code!=='PROJECT_CONFLICT';input.focus();throw error;}
});};
$('cancel-import').onclick=()=>{$('config-file').value='';$('config-file').removeAttribute('aria-invalid');$('file-error').hidden=true;$('conflict-actions').hidden=true;message('');};
(async()=>{try{sessionToken=(await api('/api/session')).token;await refresh();}catch(error){message(`本地服务未连接：${error.message}。请确认启动窗口仍在运行，再刷新。`);$('health').textContent='连接失败';}})();

$('mode-user').onclick=()=>{location.hash='overview';};$('mode-agent').onclick=()=>{location.hash='coordination';};

// Platform connections use the existing configuration surface and visual components.
const connections=document.createElement('div');connections.id='platform-connections';connections.className='boundary';
connections.append(text('h2','平台连接'),text('p','登录应用不等于已连接自动执行。以下状态来自本机服务。','hint'));
const connectionSummary=text('p','正在检查连接…');connectionSummary.setAttribute('role','status');connections.append(connectionSummary);
const connectButton=text('button','连接 WorkBuddy'),connectionRefresh=text('button','刷新连接状态','quiet'),disconnectButton=text('button','断开本机授权','quiet');
const connectActions=text('div','','form-pair');connectActions.append(connectButton,connectionRefresh,disconnectButton);connections.append(connectActions);
const connectionHelp=document.createElement('details');connectionHelp.append(text('summary','配置方法与当前限制'),text('p','协调方需在本机服务环境配置 WORKBUDDY_CLIENT_ID、WORKBUDDY_CLIENT_SECRET 和 WORKBUDDY_REDIRECT_URI。回调地址须先在官方开发者应用登记。不要在需求、评论或本页面填写密钥。'),text('p','令牌仅保存在服务端内存，重启后需重新授权。授权完成也不会开启自动执行；模型选择、预算和成果回收仍待验证。豆包继续采用应用接力，本期不接 Claude Code。','hint'));connections.append(connectionHelp);
const queryForm=document.createElement('form'),queryLabel=text('label','查询已有 WorkBuddy 云端任务');queryLabel.htmlFor='workbuddy-task-id';const queryInput=document.createElement('input');queryInput.id='workbuddy-task-id';queryInput.required=true;queryInput.maxLength=128;queryInput.pattern='[a-zA-Z0-9_-]+';queryInput.placeholder='输入官方任务 ID';const queryButton=text('button','查询任务状态');queryButton.type='submit';const queryResult=text('p','','hint');queryResult.setAttribute('role','status');queryForm.append(queryLabel,queryInput,queryButton,queryResult);connections.append(queryForm);$('config').prepend(connections);
async function refreshConnections(){
 const s=await api('/api/platforms/workbuddy/status');
 connectionSummary.textContent=s.authorized?'● WorkBuddy 已授权 · 自动执行未启用':s.configured?'○ WorkBuddy 待授权 · 自动执行未启用':'○ WorkBuddy 未配置 · 请由协调方完成官方应用配置';
 connectButton.disabled=!s.configured||s.authorized;connectButton.dataset.locked=String(connectButton.disabled);disconnectButton.disabled=!s.authorized;disconnectButton.dataset.locked=String(disconnectButton.disabled);queryButton.disabled=!s.authorized;
}
connectionRefresh.onclick=()=>busy(connectionRefresh,refreshConnections);
connectButton.onclick=()=>busy(connectButton,async()=>{const r=await api('/api/platforms/workbuddy/authorize',{});const u=new URL(r.authorizationUrl);if(u.origin!=='https://www.workbuddy.cn'||u.pathname!=='/openapi/v2/authorize')throw Error('授权地址校验失败');location.assign(u.href);});
disconnectButton.onclick=()=>busy(disconnectButton,async()=>{await api('/api/platforms/workbuddy/disconnect',{});await refreshConnections();});
queryForm.onsubmit=e=>{e.preventDefault();busy(queryButton,async()=>{queryResult.textContent='正在查询…';try{const r=await api('/api/platforms/workbuddy/inspect-task',{taskId:queryInput.value.trim()});const names={CREATING:'创建中',idle:'空闲',planning:'规划中',working:'执行中',pending:'等待输入',completed:'远端已完成',failed:'失败',archived:'已归档',deleted:'已删除'};queryResult.textContent=`${names[r.status]||'状态待核实'} · 成果尚未回收，不能视为已应用或验收通过。`;}catch(err){queryResult.textContent='查询未完成，请核对授权和任务 ID。';throw err;}});};
refreshConnections().catch(()=>{connectionSummary.textContent='连接状态暂时不可用，请点击刷新重试。';connectButton.disabled=true;disconnectButton.disabled=true;queryButton.disabled=true;});
const connectionNav=text('a','平台连接');connectionNav.href='#config';document.querySelector('nav.user-only')?.append(connectionNav);
