'use strict';
const planReplyDrafts=new Map();
const planStateLabels={pending:'等你确认范围',changes_requested:'已提出修改，等待协调方更新',superseded:'已由新计划替代',confirmed:'范围已确认，任务已建立',auto_started:'已按自动推进策略建立任务（非用户逐项确认）',queued:'已整理，等待解除暂停或待决策事项'};
function renderPlanPublisher(parent,request,projectId,epoch){
 if(!currentUserProject()?.isLatest){parent.append(text('p','请在用户态选择最新配置，再整理计划。','hint'));return;}
 parent.append(text('p',`将为当前项目整理这条输入的开发计划。输入编号：${request.id}`,'hint'));
 agentForm(parent,'发布计划并按授权推进',[['summary','一句话目标'],['scope','本轮要做什么','textarea'],['outOfScope','本轮暂不做什么','textarea'],['acceptance','用户怎样判断做成了','textarea'],['risks','风险、代价与需要说明的限制','textarea'],['decisionReason','需要用户决定什么（普通计划填“无”）','textarea'],['steps','任务拆解 JSON（key、stage、title、requirement、acceptance、dependencies）','textarea'],['platform','实际整理平台'],['model','实际模型或人员'],['evidence','整理依据与真实来源','textarea']],v=>{
  let steps;try{steps=JSON.parse(v.steps);}catch{throw Error('任务拆解不是有效 JSON，请使用数组，每项包含任务 key、阶段、标题、需求、验收与依赖 key。');}
  const decisionReason=v.decisionReason.trim()==='无'?'':v.decisionReason.trim();return api('/api/plans',{...v,steps,decisionReason,requiresDecision:!!decisionReason,requestId:request.id,projectId,expectedEpoch:epoch});
 });
 parent.lastElementChild.querySelector('textarea[id^=agent-steps-]').placeholder='[{"key":"first","stage":"coding","title":"实现核心功能","requirement":"明确实现内容","acceptance":"可验证的结果","dependencies":[]}]';
}
function renderDevelopmentPlans(){
 const pid=$('user-project').value,plans=(userData.plans||[]).filter(p=>sameUserProject(p.projectId,pid));
 const pending=plans.filter(p=>p.current&&p.status==='pending'),user=$('user-development-plans'),agent=$('agent-development-plans');user.replaceChildren();agent.replaceChildren();const historyHost=$('user-plan-history');historyHost.replaceChildren();const processed=plans.filter(p=>!(p.current&&p.status==='pending'));$('user-plan-history-count').textContent=processed.length?String(processed.length):'';$('user-plan-history-panel').hidden=!processed.length;
 if(pending.length){const total=pending.length+userData.decisions.filter(d=>sameUserProject(d.projectId,pid)&&d.current&&!d.answers.length).length;$('user-decision-count').textContent=String(total);const next=$('user-home-next');next.replaceChildren(text('strong',`有 ${pending.length} 份开发计划等你确认目标与范围。`),text('p','不用审代码或给技术意见打分。确认后建立任务，实际执行仍需协调方接力。','hint'));const link=text('a','看看计划，确认要做什么','text-link');link.href='#decisions';next.append(link);}
 for(const p of [...plans].reverse()){
  const data=p.payload,isPending=p.current&&p.status==='pending',b=userBlock('article',isPending?data.summary:null,null);b.classList.add('plan-readable');if(isPending)b.append(text('span','需要确认范围','plan-status'));
  if(isPending&&data.requiresDecision)b.append(text('p',data.decisionReason,'user-warning'));const scope=document.createElement('details');scope.className='plan-scope';scope.open=isPending;scope.append(text('summary','范围与验收说明'));const dl=document.createElement('dl');for(const [label,value]of [['本轮要做',data.scope],['暂不包含',data.outOfScope],['完成标准',data.acceptance],['风险与限制',data.risks]])dl.append(text('dt',label),text('dd',value));scope.append(dl);b.append(scope);
  const details=document.createElement('details');details.append(text('summary',`查看 ${data.steps.length} 个步骤与来源想法`),text('p',`原始想法：${data.request.body}`));for(const s of data.steps)details.append(text('p',`${s.title}；完成标准：${s.acceptance}`));b.append(details);userSource(b,data.source,data.source.evidence);
  if(p.current&&p.status==='pending'){
   const form=document.createElement('form');form.noValidate=true;const input=document.createElement('textarea');input.rows=2;input.maxLength=8000;input.id='plan-reply-'+p.id;input.value=planReplyDrafts.get(p.id)||'';const label=text('label','想调整哪里？（提出修改时必填）');label.htmlFor=input.id;input.oninput=()=>planReplyDrafts.set(p.id,input.value);
   const error=text('p','','field-error');error.hidden=true;const yes=text('button','确认范围并建立任务'),no=text('button','需要调整');yes.type=no.type='submit';yes.dataset.action='confirm';no.dataset.action='request_changes';no.className='quiet';const held=currentUserProject()?.control.paused||userData.decisions.some(d=>sameUserProject(d.projectId,pid)&&d.current&&d.blocking&&!d.answers.length);yes.disabled=!!held;
   form.append(label,input,error,yes,no,text('p',held?'当前有暂停或其他待决策事项，处理后才能确认建任务；仍可提出修改。':'确认只表示同意范围并建立任务，不表示已调用模型或产品已验收。','hint'));
   form.onsubmit=e=>{e.preventDefault();const button=e.submitter||yes,action=button.dataset.action;busy(button,async()=>{if(action==='request_changes'&&!input.value.trim()){invalidate(input,'请用自己的话说希望怎样调整。',error);return;}await api(`/api/plans/${p.id}/answer`,{action,reply:input.value,expectedRevision:p.revision,expectedControlRevision:currentUserProject().control.revision});planReplyDrafts.delete(p.id);await refreshUser();if(action==='confirm'){message('已确认范围并建立任务，等待协调方实际交接。');location.hash='progress';}else message('修改意见已保留，等待协调方整理新计划。');});};b.append(form);
  }else{
   if(!p.current)b.append(text('p','这份计划的配置、方向或版本依据已变化，保留作历史，不可再次确认。','hint'));
   if(['confirmed','auto_started'].includes(p.status))b.append(text('p',`已建立 ${p.tasks.length} 个任务，其中 ${p.tasks.filter(t=>t.status==='valid_passed').length} 个已验收。准备包、登记提交、回收结果是不同状态。`));
   const last=p.answers.at(-1);if(last?.reply)b.append(text('p',`你的说明：${last.reply}`));
  }
  if(isPending)user.append(b);else{const history=document.createElement('details');history.className='plan-history-item';const summary=document.createElement('summary'),status=({auto_started:'已自动建任务',confirmed:'已确认范围',changes_requested:'待修改',superseded:'已替代',queued:'等待推进'})[p.status]||'历史记录';summary.append(text('span',data.summary,'plan-history-title'),text('span',status,'plan-status'));history.append(summary,b);historyHost.append(history);}
  const ab=userBlock('article',data.summary,planStateLabels[p.status]);ab.append(text('p',`计划 ${p.id} · 原始输入 ${p.requestId}`,'hint'));
  if(p.status==='queued'&&p.current){const start=text('button','解除阻塞后按授权建立任务','quiet');start.onclick=()=>busy(start,async()=>{await api(`/api/plans/${p.id}/start`,{expectedRevision:p.revision});await refreshUser();});ab.append(start);}
  for(const step of data.steps){const task=p.tasks.find(t=>t.stepKey===step.key);ab.append(text('h3',step.title),text('p',`期望主执行：${step.roles.primary.platform} / ${step.roles.primary.name}；${task?(userTaskStates[task.status]||task.status):'尚未建立任务'}`));if(!task)continue;const pkg=task.packages.find(x=>x.role==='primary');
   if(pkg){const download=text('a','下载主执行任务包','text-link');download.href=`/api/tasks/${task.taskId}/packages/${pkg.id}/download`;download.download='task-package.md';ab.append(download,text('p',`已登记交接 ${task.handoffs} 次，已回收 ${task.receipts} 份原文；下载不代表已提交。`,'hint'));}
   else{const prepare=text('button','准备主执行交接包','quiet');prepare.disabled=!task.ready;prepare.onclick=()=>busy(prepare,async()=>{await api(`/api/plans/${p.id}/prepare`,{taskId:task.taskId,expectedVersion:task.version});await refreshUser();});ab.append(prepare);if(!task.ready)ab.append(text('p','项目暂停、方向变化、待决策或前置任务未验收时，不能准备新交接。','hint'));}
  }
  if(['confirmed','auto_started'].includes(p.status)){const link=text('a','打开任务页登记实际提交或回收结果','text-link');link.href=`/?project=${encodeURIComponent(p.projectId)}#tasks`;ab.append(link,text('p','到目标平台实际提交后，再登记真实平台、模型与证据；这里不会自动发送。','hint'));}agent.append(ab);
 }
 if(!plans.length)agent.append(text('p','还没有关联原始输入的开发计划。先在用户交互队列整理计划；普通计划按授权推进，重要事项再请用户决定。','hint'));
}
