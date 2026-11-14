'use strict';
const stageNames={requirements:'需求分析',design:'方案设计',acceptancePlan:'验收方案',coding:'编码',debugging:'调试',testing:'测试',acceptance:'验收',release:'发布'};
const roleNames={primary:'主执行',support:'配合执行',reviewerA:'评审 A',reviewerB:'评审 B'};
const executionStateNames={queued:'等待本机启动',starting:'正在准备独立目录',running:'本机 CLI 进程运行中，等待完整回复',collection_pending:'完整输出已保存，成果回收待重试',completed:'成果已回收，尚未验收',failed:'本次运行失败，未计为成功',cancelled:'本机运行已取消',interrupted:'服务重启后状态待核查，不自动重跑'};
const stateNames={draft:'待准备任务包',ready:'主执行包已准备，主执行尚未确认提交',awaiting_primary:'配合结果已回收，等待主执行提交',submitted:'主执行已登记提交',result_received:'已回收结果，尚未验收',needs_resolution:'不同内容待选用，尚未验收',valid_passed:'本任务已有效通过人工验收',needs_revalidation:'上游依据已变化，需要重新验收'};
let taskList=[], currentTask=null, stageOptions=[], optionRequest=0, detailRequest=0, taskUIInitialized=false;
function optionsInto(select,items,selected){select.replaceChildren();for(const [value,label]of items){const option=text('option',label);option.value=value;select.append(option);}if(items.some(x=>x[0]===selected))select.value=selected;}
function invalidate(input,error,box){input.setAttribute('aria-invalid','true');box.hidden=false;box.textContent=error;input.focus();}
function clearInvalid(form,box){for(const field of form.querySelectorAll('[aria-invalid]'))field.removeAttribute('aria-invalid');box.hidden=true;box.textContent='';}
function need(id,label){const input=$(id);if(!input.value.trim())throw Object.assign(new Error(`请填写${label}。`),{field:id});return input.value.trim();}
function bindForm(formId,errorId,run){$(formId).onsubmit=event=>{event.preventDefault();busy(event.submitter||$(formId).querySelector('button[type=submit]'),async()=>{clearInvalid($(formId),$(errorId));try{await run();}catch(error){invalidate($(error.field||$(formId).querySelector('input,textarea,select').id),error.message,$(errorId));throw error;}});};}
function selectedPackage(){return currentTask?.packages.find(pkg=>pkg.id===$('package-choice').value);}
function latestHandoff(){const pkg=selectedPackage();return currentTask?.handoffs.filter(h=>h.packageId===pkg?.id).at(-1);}
async function loadStageOptions(){
  const request=++optionRequest,projectId=$('task-project').value;
  if(!projectId){stageOptions=[];optionsInto($('task-stage'),[]);$('stage-roles').textContent='请先保存开发配置。';return;}
  const result=await api(`/api/projects/${encodeURIComponent(projectId)}/task-options`);if(request!==optionRequest)return;
  stageOptions=result.stages;const old=$('task-stage').value;
  optionsInto($('task-stage'),stageOptions.map(s=>[s.id,stageNames[s.id]||s.id]),old||'coding');showStageRoles();
}
function showStageRoles(){const s=stageOptions.find(s=>s.id===$('task-stage').value);$('stage-roles').textContent=s?Object.entries(s.roles).map(([role,who])=>`${roleNames[role]}：${who?`${who.platform} / ${who.name}`:(role.startsWith('reviewer')?'未配置；请先补齐评审角色':'未配置，此角色交接将暂停')}`).join('；'):'此项目尚未配置阶段。';}
function updateTaskChoices(){
  const projectId=$('task-project').value,old=$('task-choice').value;
  const rows=taskList.filter(t=>t.projectId===projectId);
  optionsInto($('task-choice'),rows.map(t=>[t.id,`${t.title} · ${stateNames[t.status]||t.status}`]),old);
  optionsInto($('task-dependencies'),rows.map(t=>[t.id,t.title]));
  $('task-empty').hidden=rows.length>0;
}
async function refreshTasks(projects){
  const old=$('task-project').value||new URLSearchParams(location.search).get('project')||projects.find(p=>p.isLatest)?.id;
  optionsInto($('task-project'),projects.map(p=>[p.id,`${p.name} · V${p.version}${p.isLatest?'':'（历史）'}`]),old);
  taskList=await api('/api/tasks');updateTaskChoices();await loadStageOptions();
  if($('task-choice').value)await loadTask($('task-choice').value,false);else{currentTask=null;$('task-workspace').hidden=true;}
  if(!taskUIInitialized){$('create-task-panel').open=!taskList.some(t=>t.projectId===$('task-project').value);taskUIInitialized=true;}
  updateNextAction();
}
function updateNextAction(){
  if(!$('task-project').value)return;
  const mine=taskList.filter(t=>t.projectId===$('task-project').value),open=mine.find(t=>t.status==='needs_resolution');
  $('next-title').textContent=open?'处理回收结果的内容冲突':mine.some(t=>t.status==='result_received')?'任务结果已回收，前往评审页发起独立评审':mine.length?'继续任务交接':'建立第一份任务包';
  $('next-description').textContent='按保存的配置分工，预览任务包，手动提交并回收原文；下载和回收都不会自动标为验收通过。';
  const link=document.querySelector('.next .button');link.href='#tasks';link.textContent='进入任务与交接';
}
async function loadTask(id,clearDraft=true){
  const request=++detailRequest,task=await api(`/api/tasks/${encodeURIComponent(id)}`);if(request!==detailRequest)return;
  const changed=currentTask?.id!==task.id;currentTask=task;$('task-workspace').hidden=false;
  $('task-current-title').textContent=task.title;$('task-state').textContent=`${stageNames[task.stage]||task.stage} · 第 ${task.version} 版 · ${stateNames[task.status]||task.status}`;
  $('task-next').textContent=task.status==='awaiting_primary'?'配合方回收已生效，没有报错；下一步选择主执行角色，准备并提交其任务包。':task.status==='needs_resolution'?'下一步：查看所有不同原文，为存在冲突的包填写理由后选用一版。':task.status==='result_received'?'结果已保留。下一步进入“独立评审与复核”，冻结选用结果并分别交给两位评审，再核对评分与最终裁决。':task.handoffs.length?'下一步：核对上方任务包，导入目标应用的回复原文。':'下一步：选择角色准备任务包，预览后在目标应用提交。';
  $('task-scope').textContent=`需求\n${task.requirement}\n\n验收\n${task.acceptance}`;
  const old=$('package-choice').value;optionsInto($('package-choice'),task.packages.map(p=>[p.id,`${roleNames[p.role]||p.role} · ${when(p.createdAt)} · ${p.id.slice(0,8)}`]),changed?'':old);
  if(changed&&task.packages.length)$('package-choice').value=task.packages.at(-1).id;
  $('package-preview').hidden=!task.packages.length;
  if(changed||clearDraft){$('result-raw').value='';$('result-source').value='';$('result-file').value='';$('result-status').textContent='';}
  showPackage();renderReceipts();if(typeof renderArtifactOutputs==='function')renderArtifactOutputs(task);if(typeof renderWorkspaceOutputs==='function')renderWorkspaceOutputs(task);
  $('handoff-history').replaceChildren();for(const h of task.handoffs){$('handoff-history').append(text('p',`${when(h.createdAt)} · 提交登记：${h.actualPlatform} / ${h.actualModel}；依据：${h.evidence}`));}
  $('resolution-history').replaceChildren();for(const item of task.invalidations||[]){$('resolution-history').append(text('p',`选用已失效 · ${when(item.createdAt)} · ${item.reason==='new conflicting result'?'新原文与原选用不同，需重新选用':item.reason}`));}for(const r of task.resolutions||[]){$('resolution-history').append(text('p',`历史选用记录 · ${when(r.createdAt)} · 理由：${r.reason}（有效性以当前选用标记为准）`));}
}
function showPackage(){
  const pkg=selectedPackage();$('package-preview').hidden=!pkg;if(!pkg)return;
  $('package-text').textContent=pkg.markdown;$('package-download').href=`/api/tasks/${encodeURIComponent(currentTask.id)}/packages/${encodeURIComponent(pkg.id)}/download`;
  const handoff=latestHandoff();$('handoff-platform').value=handoff?.actualPlatform||'';$('handoff-model').value=handoff?.actualModel||'';$('handoff-evidence').value=handoff?.evidence||'';$('handoff-confirmed').checked=false;$('handoff-inflight').checked=false;$('handoff-submitted-at').value='';
  renderManagedExecution();
}
let managedRequest=0;
async function renderManagedExecution(){
  const seq=++managedRequest,task=currentTask,pkg=selectedPackage(),box=$('managed-execution');box.replaceChildren();if(!task||!pkg)return;
  try{const jobs=await api('/api/executions');if(seq!==managedRequest||currentTask?.id!==task.id||selectedPackage()?.id!==pkg.id)return;
    const scheduled=await api('/api/scheduler');if(seq!==managedRequest||currentTask?.id!==task.id||selectedPackage()?.id!==pkg.id)return;
    const scheduledJob=scheduled.find(j=>j.packageId===pkg.id),scheduleBox=text('section','','overview-focus');scheduleBox.append(text('h3','跨平台调度'));
    if(scheduledJob){const names={queued:'排队等待',running:'本机受管执行',waiting_handoff:'等待协调方应用接力，尚未启动',waiting_result:'已登记交接，等待成果；外部运行状态未知',completed:'成果已回收，尚未验收',blocked:'受阻，需协调方核查',cancelled:'本机调度已取消'};scheduleBox.append(text('p',scheduledJob.platform+' · '+(names[scheduledJob.status]||scheduledJob.status)));if(scheduledJob.reason)scheduleBox.append(text('p',scheduledJob.reason,'hint'));if(['queued','running','waiting_handoff','waiting_result'].includes(scheduledJob.status)){const cancel=text('button','取消此调度','quiet');cancel.type='button';cancel.onclick=()=>busy(cancel,async()=>{await api(`/api/scheduler/${scheduledJob.id}/cancel`,{});await renderManagedExecution();await refreshUser();});scheduleBox.append(cancel);}}
    else{scheduleBox.append(text('p','按任务包的平台分工排队：Codex 自动只读执行；WorkBuddy、豆包等待应用交接。独立评审仍在评审模块处理。','hint'));const enqueue=text('button','加入跨平台调度');enqueue.type='button';enqueue.onclick=()=>busy(enqueue,async()=>{await api(`/api/tasks/${task.id}/schedule`,{packageId:pkg.id,expectedVersion:task.version});await renderManagedExecution();await refreshUser();});scheduleBox.append(enqueue);}box.append(scheduleBox);
    const job=jobs.find(j=>j.packageId===pkg.id);box.append(text('h3','本机执行'),text('p','当前支持 Codex 只读分析与代码候选文件。每个任务包只运行一次，请先选定格式。使用配置中的模型和已有账号额度；不修改项目代码、不自动验收。','hint'));
    if(!job){for(const [label,outputFormat]of [['按配置启动 Codex 只读任务','text'],['生成代码候选文件（只读）','collab-artifacts/v1']]){const start=text('button',label);start.type='button';start.disabled=task.handoffs.some(h=>h.packageId===pkg.id);start.onclick=()=>busy(start,async()=>{await api(`/api/tasks/${task.id}/executions`,{packageId:pkg.id,expectedVersion:task.version,outputFormat});await loadTask(task.id,false);await refreshUser();});box.append(start);}return;}
    box.append(text('p',executionStateNames[job.status]||job.status),text('p',`请求模型 ${job.model}；底层型号未核验。运行 ${job.id}`,'hint'));
    box.append(text('p',job.outputFormat==='collab-artifacts/v1'?'本次输出格式：代码候选文件。':'本次输出格式：普通分析。','hint'));
    if(job.reason==='execution_input_mismatch')box.append(text('p','执行输入摘要发生变化，已在启动模型前阻止运行；请协调方核对任务和日志，再建立新的明确任务。','field-error'));
    if(job.status==='interrupted')box.append(text('p',`异常退出后可能仍有进程消耗额度。PID：${job.pid??'未记录'}；独立目录：${job.workspace??'未记录'}。协调方须核对进程已停止，再登记证据；不会自动杀死身份不确定的进程。`,'user-warning'));
    if(job.status==='interrupted'&&!job.interruptionResolution){const form=document.createElement('form'),evidence=document.createElement('textarea'),label=text('label','进程停止核查证据（协调方填写）'),check=document.createElement('input'),checkLabel=text('label','已核对该运行的进程不存在或已安全停止'),button=text('button','登记已停止的核查证据'),error=text('p','','field-error');evidence.id='orphan-'+job.id;label.htmlFor=evidence.id;check.type='checkbox';check.id='orphan-check-'+job.id;checkLabel.htmlFor=check.id;error.hidden=true;button.type='submit';form.append(label,evidence,check,checkLabel,error,button);form.onsubmit=e=>{e.preventDefault();busy(button,async()=>{if(!check.checked||!evidence.value.trim()){invalidate(evidence,'请核对进程，勾选确认并填写实际证据。',error);return;}await api(`/api/executions/${job.id}/resolveInterruption`,{confirmedStopped:true,evidence:evidence.value.trim()});await renderManagedExecution();});};box.append(form);}
    if(['failed','cancelled','interrupted'].includes(job.status)&&(job.status!=='interrupted'||job.interruptionResolution)){
      if(job.replacementTaskId)box.append(text('p',`恢复任务已建立：${job.replacementTaskId}。请刷新任务列表后继续；原任务包不会重跑。`,'hint'));
      else{const form=document.createElement('form'),reason=document.createElement('textarea'),label=text('label','恢复任务的原因（旧记录保留）'),button=text('button','建立关联恢复任务，不立即运行'),error=text('p','','field-error');reason.id='replace-'+job.id;label.htmlFor=reason.id;error.hidden=true;button.type='submit';form.append(label,reason,error,button);form.onsubmit=e=>{e.preventDefault();busy(button,async()=>{if(!reason.value.trim()){invalidate(reason,'请填写核查结论及恢复原因。',error);return;}const result=await api(`/api/executions/${job.id}/replace`,{reason:reason.value.trim()});await refresh();$('task-choice').value=result.replacementTaskId;await loadTask(result.replacementTaskId);});};box.append(form);}
    }
    if(['queued','starting','running'].includes(job.status)){const cancel=text('button','停止这次本机运行','quiet');cancel.type='button';cancel.onclick=()=>busy(cancel,async()=>{await api(`/api/executions/${job.id}/cancel`,{});await renderManagedExecution();});box.append(cancel);}
    if(job.status==='collection_pending'){const collect=text('button','重试回收已保存的成果');collect.type='button';collect.onclick=()=>busy(collect,async()=>{await api(`/api/executions/${job.id}/collect`,{});await loadTask(task.id,false);await refreshUser();});box.append(collect);}
    const logs=document.createElement('details');logs.append(text('summary','查看本机运行日志'));logs.ontoggle=async()=>{if(!logs.open||logs.dataset.loaded)return;try{const detail=await api(`/api/executions/${job.id}`);logs.append(text('pre',`${detail.reason||''}\n${detail.stdout||''}\n${detail.stderr||''}`));logs.dataset.loaded='true';}catch{logs.append(text('p','日志读取失败，请关闭后重新打开。','field-error'));}};box.append(logs);
  }catch{box.append(text('p','运行状态暂时不可读取，请刷新任务记录。','field-error'));}
}
function renderReceipts(){
  $('result-history').replaceChildren();
  if(!currentTask.receipts.length){$('result-history').append(text('p','尚未回收回复。','hint'));return;}
  for(const receipt of currentTask.receipts){
    const block=text('div','','receipt'),chosen=currentTask.selections?.some(s=>s.receiptId===receipt.id),pkg=currentTask.packages.find(p=>p.id===receipt.packageId);
    block.append(text('strong',`${roleNames[pkg?.role]||'执行'} · ${receipt.actualPlatform} / ${receipt.actualModel}`),text('p',`${when(receipt.createdAt)} · ${receipt.sourceEvidence}`,'meta'));
    const detail=document.createElement('details'),summary=text('summary','查看回复原文');detail.append(summary,text('pre',receipt.raw));block.append(detail);
    if(chosen)block.append(text('p',currentTask.resolutions?.some(r=>r.receiptId===receipt.id)?'手动选用版本（不代表验收通过）':'当前唯一回收版本（未人工选用，尚未验收）','chosen'));
    else {const form=document.createElement('form'),label=text('label','选用这一版的理由'),reason=document.createElement('input'),button=text('button','选用为后续评审基准（非验收通过）');reason.required=true;reason.maxLength=1000;reason.id=`reason-${receipt.id}`;label.htmlFor=reason.id;button.type='submit';const error=text('p','','field-error');error.hidden=true;form.append(label,reason,error,button);
      form.onsubmit=event=>{event.preventDefault();busy(button,async()=>{if(!reason.value.trim()){invalidate(reason,'请填写选用理由。',error);return;}await api(`/api/tasks/${currentTask.id}/resolve`,{receiptId:receipt.id,reason:reason.value.trim()});await refresh();});};block.append(form);}
    $('result-history').append(block);
  }
}
$('task-project').onchange=()=>busy($('tasks-refresh'),async()=>{currentTask=null;updateTaskChoices();await loadStageOptions();if($('task-choice').value)await loadTask($('task-choice').value);else $('task-workspace').hidden=true;updateNextAction();});
$('task-stage').onchange=showStageRoles;
$('task-choice').onchange=()=>busy($('tasks-refresh'),()=>loadTask($('task-choice').value));
$('package-choice').onchange=()=>{showPackage();$('result-raw').value='';$('result-source').value='';$('result-file').value='';$('result-status').textContent='';};
$('tasks-refresh').onclick=()=>busy($('tasks-refresh'),refresh);
bindForm('task-create','task-create-error',async()=>{
  const payload={projectId:need('task-project','所属项目'),stage:need('task-stage','开发阶段'),title:need('task-title','任务标题'),requirement:need('task-requirement','本次任务需求'),acceptance:need('task-acceptance','验收要求'),dependencies:[...$('task-dependencies').selectedOptions].map(o=>o.value)};
  const task=await api('/api/tasks',payload);await refresh();$('task-choice').value=task.id;await loadTask(task.id);$('create-task-panel').open=false;$('task-current-title').scrollIntoView({block:'center'});
});
$('prepare-package').onclick=()=>busy($('prepare-package'),async()=>{if(!currentTask)throw new Error('请先选择任务。');const pkg=await api(`/api/tasks/${currentTask.id}/packages`,{role:$('package-role').value,expectedVersion:currentTask.version});await refresh();$('package-choice').value=pkg.id;showPackage();});
bindForm('handoff-form','handoff-error',async()=>{
  const pkg=selectedPackage();if(!pkg)throw Object.assign(new Error('请先准备并选定任务包。'),{field:'handoff-platform'});
  if(!$('handoff-confirmed').checked)throw Object.assign(new Error('请在目标应用实际提交后勾选确认。'),{field:'handoff-confirmed'});
  await api(`/api/tasks/${currentTask.id}/handoffs`,{packageId:pkg.id,actualPlatform:need('handoff-platform','实际平台'),actualModel:need('handoff-model','实际模型'),evidence:need('handoff-evidence','提交依据'),confirmed:true,inFlight:$('handoff-inflight').checked,submittedAt:$('handoff-inflight').checked?new Date(need('handoff-submitted-at','暂停前已发生提交的实际时间')).toISOString():undefined});await refresh();
});
$('result-file').onchange=async()=>{try{const file=$('result-file').files[0];if(!file)return;if(!/\.(md|txt|json)$/i.test(file.name)||file.size>1024*1024)throw new Error('只支持最多1MB的文本、Markdown或JSON，请保留完整原件。');$('result-raw').value=await file.text();}catch(error){invalidate($('result-file'),error.message,$('result-error'));}};
bindForm('result-form','result-error',async()=>{
  const pkg=selectedPackage(),handoff=latestHandoff();if(!pkg||!handoff)throw Object.assign(new Error('请先为选定任务包完成提交确认。'),{field:'result-raw'});
  need('result-raw','结果原文');const raw=$('result-raw').value;if(new TextEncoder().encode(raw).length>1024*1024)throw Object.assign(new Error('回复超过1MB，请精简后导入并保留完整原件。'),{field:'result-raw'});
  const receipt=await api(`/api/tasks/${currentTask.id}/receipts`,{packageId:pkg.id,raw,actualPlatform:handoff.actualPlatform,actualModel:handoff.actualModel,sourceEvidence:need('result-source','回复来源证据')});await refresh();$('result-status').textContent=receipt.duplicate?'相同原文已保存，本次没有重复添加。':'原文已回收并保留；如有不同版本，请在下方选择并说明理由。';
});

$('package-download').onclick=()=>{$('download-status').textContent='已准备下载，尚未向目标应用提交。请手动提交后，在下一步登记实际平台、模型和依据。';};
