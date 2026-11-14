'use strict';
const reviewPositions={agree:'认可',change:'需修改',reject:'不认可',uncertain:'待澄清'};
const reviewSeverity={info:'提示',minor:'一般问题',major:'重要问题',blocker:'阻断问题'};
const reviewClasses={aligned:'结构化判断一致',different:'判断或严重度有分歧',single:'仅一方提及',uncertain:'存在待澄清判断'};
const reviewActions={adopt:'采纳建议（待落实，非最终验收）',return:'退回修改',clarify:'要求澄清'};
let reviewRounds=[],activeReview=null,reviewLoadSequence=0,parsedReviewBinding;
function reviewItemRow(item={topic:'整体方案',position:'change',severity:'major',detail:'',suggestion:''}){
  const block=text('div','','opinion-item');block.append(text('h4','一项意见'));
  for(const [key,label,kind,max]of [['topic','主题','input',200],['position','判断','position'],['severity','严重程度','severity'],['detail','具体依据','textarea',4000],['suggestion','处理建议','textarea',4000]]){
    const field=document.createElement(kind==='position'||kind==='severity'?'select':kind);field.dataset.reviewKey=key;field.id=`opinion-${crypto.randomUUID()}`;const lab=text('label',label);lab.htmlFor=field.id;
    if(kind==='position'||kind==='severity')optionsInto(field,Object.entries(kind==='position'?reviewPositions:reviewSeverity),item[key]);else{field.value=typeof item[key]==='string'?item[key]:'';field.maxLength=max;if(kind==='textarea')field.rows=2;}
    field.required=true;block.append(lab,field);
  }
  const remove=text('button','移除此项','quiet');remove.type='button';remove.onclick=()=>{if($('review-items').children.length===1){message('至少保留一项结构化意见。');return;}block.remove();};block.append(remove);return block;
}
function readReviewItems(){return [...$('review-items').children].map(block=>{const item={};for(const field of block.querySelectorAll('[data-review-key]')){if(!field.value.trim())throw Object.assign(new Error('请补全每项意见的主题、依据与建议。'),{field:field.id});item[field.dataset.reviewKey]=field.value.trim();}return item;});}
function clearReviewDraft(){parsedReviewBinding=undefined;for(const id of ['review-platform','review-model','review-source','review-raw','review-conclusion'])$(id).value='';$('review-independent').checked=false;$('review-identity-verified').checked=false;$('review-file').value='';$('review-items').replaceChildren(reviewItemRow());clearInvalid($('review-submit'),$('review-submit-error'));}
async function refreshReviews(){
  const projectId=$('task-project').value,oldTask=$('review-task').value;
  const available=taskList.filter(t=>t.projectId===projectId);optionsInto($('review-task'),available.map(t=>[t.id,`${t.title}${t.selectedReceiptId?'':'（需先回收主执行结果）'}`]),oldTask);
  reviewRounds=await api('/api/review-rounds');await refreshReviewChoices(false);
}
async function refreshReviewChoices(clearDraft=true){
  const id=$('review-task').value,task=taskList.find(t=>t.id===id),old=$('review-round').value;
  $('review-empty').textContent=!task?'还没有任务。请先在“任务与交接”建立任务并回收主执行结果。':!task.selectedReceiptId?'本任务尚未选定主执行结果。请先到“任务与交接”回收并解决内容冲突。':'可对当前选用产物发起独立评审；期望分工从配置带入。';
  $('open-review').dataset.locked=String(!task?.selectedReceiptId||task.status==='needs_resolution');$('open-review').disabled=$('open-review').dataset.locked==='true';
  const rounds=reviewRounds.filter(r=>r.taskId===id);optionsInto($('review-round'),rounds.map((r,i)=>[r.id,`第 ${i+1} 个评审记录 · ${r.stale?'依据已过期':r.ready?'两方齐全':'等待独立意见'} · ${when(r.createdAt)}`]),old);
  if(rounds.length&&!rounds.some(r=>r.id===old))$('review-round').value=rounds.at(-1).id;
  if($('review-round').value)await loadReview($('review-round').value,clearDraft);else{reviewLoadSequence++;activeReview=null;$('review-workspace').hidden=true;}
}
async function loadReview(id,clearDraft=false){
  const sequence=++reviewLoadSequence,round=await api(`/api/review-rounds/${encodeURIComponent(id)}`);if(sequence!==reviewLoadSequence||round.taskId!==$('review-task').value)return;
  const changed=activeReview?.id!==round.id;activeReview=round;$('review-workspace').hidden=false;
  const task=taskList.find(t=>t.id===round.taskId);$('review-title').textContent=task?.title||'独立评审';
  $('review-state').textContent=round.stale?'本轮依据已过期，历史保留，不能再作有效复核':round.ready?(round.identitiesVerified?'两份意见已齐，可以交叉与人工逐项处理':'两份意见已齐，存在模型身份待核验；可比较，不可评分通过'):`已收 ${Object.values(round.slots).filter(s=>s.submitted).length} / 2 份独立评审；齐全后解锁对比，双方齐前不揭示原文`;
  $('review-next').textContent=round.stale?'下一步：在任务页选定当前产物，再发起新轮。旧决定只作历史。':round.ready&&!round.identitiesVerified?'下一步：先核实待核验来源；可阅读比较，不能评分通过。核实或更换评审后可重新收集本产物意见，旧轮保留。':round.ready?'下一步：查看下方每个主题的两方依据，选择采纳建议、退回修改或要求澄清，并写理由。':'下一步：分别发送 A、B 任务包，在独立上下文完成后回收；不要把一方意见提前交给另一方。';
  $('review-binding').textContent=`任务版本：${round.taskVersion}\n评审记录：${round.id}\n目标结果：${round.targetReceiptId||'未记录'}\n结果摘要：${round.targetContentHash||'未记录'}\n评审依据摘要：${round.snapshotHash||'未记录'}\n冻结规则：${round.ruleSummary?.configured?JSON.stringify(round.ruleSummary,null,2):'规则未配置；本批只收集意见和人工处理，不计算评分'}`;
  $('review-packets').replaceChildren();for(const slot of ['reviewerA','reviewerB']){const expected=round.slots[slot].expected;if(!round.stale){const link=text('a',`下载${roleNames[slot]}任务包`,'button');link.href=`/api/review-rounds/${round.id}/packets/${slot}`;link.download=`${slot}-review.md`;$('review-packets').append(link);}$('review-packets').append(text('p',`${roleNames[slot]}期望：${expected?.platform||'未知'} / ${expected?.name||'未知'} · ${round.slots[slot].submitted?'意见已提交锁定':'待提交'}${round.reviews?.find(r=>r.slot===slot)?`；实际：${round.reviews.find(r=>r.slot===slot).actualPlatform} / ${round.reviews.find(r=>r.slot===slot).actualModel}${round.reviews.find(r=>r.slot===slot).identityVerified===false?'（仅参考）':''}`:''}`,'hint'));}
  if(round.codeArtifacts?.available){$('review-packets').append(text('p',`本轮代码产物：${round.codeArtifacts.files.length} 个候选文件；同一产物摘要 ${round.codeArtifacts.bundleHash}。未运行或验收；双方 ZIP 内容一致，不含他评。`,'hint'));if(!round.stale)for(const slot of ['reviewerA','reviewerB']){const zip=text('a',`下载${roleNames[slot]}同版代码 ZIP`,'button');zip.href=`/api/review-rounds/${round.id}/artifacts/${slot}`;zip.download=`review-${slot}-code.zip`;$('review-packets').append(zip);}}
  else if(round.codeArtifacts)$('review-packets').append(text('p','代码包格式或摘要未通过检查。原始回执保留，先请协调方核查，勿执行或解压其中路径。','field-error'));
  await renderReviewDispatch(round);if(sequence!==reviewLoadSequence)return;
  if(changed||clearDraft)clearReviewDraft();showReviewSlot();$('review-import-panel').open=!round.ready&&!round.stale;
  $('review-comparison').hidden=!round.ready;if(round.ready)renderReviewComparison();
  if(typeof loadGate==='function')await loadGate(round);
  if(task?.projectId===$('task-project').value){const link=document.querySelector('.next .button');$('next-title').textContent=round.stale?'评审依据变化，需重新发起':round.ready?'逐项处理评审共识与分歧':'收齐两份独立意见';$('next-description').textContent=$('review-next').textContent;link.href='#review';link.textContent='进入评审与人工复核';}
}
function showReviewSlot(){
  if(!activeReview)return;const slot=$('review-slot').value,info=activeReview.slots[slot];$('review-expected').textContent=`期望：${info.expected?.platform||'未知'} / ${info.expected?.name||'未知'}；这不是实际运行身份。`;
  const restart=$('restart-review-form').querySelector('button');restart.dataset.locked=String(activeReview.stale);restart.disabled=activeReview.stale;const locked=info.submitted||activeReview.stale;$('review-edit-fields').disabled=locked;$('review-submit-button').dataset.locked=String(locked);$('review-submit-button').disabled=locked;
  $('review-slot-state').textContent=activeReview.stale?'本轮已过期，不能继续提交。':info.submitted?'这份原文已锁定，不能覆盖；双方齐全后可追加更正。':'请如实填写实际来源，核对独立性后提交。';
}
function appendOpinion(parent,items,slot){parent.append(text('strong',roleNames[slot]));const source=activeReview?.reviews?.find(r=>r.slot===slot);if(source?.identityVerified===false)parent.append(text('p','实际模型待核验 · 仅作参考，不计入有效评分','unverified-opinion'));if(!items.length){parent.append(text('p','未提及此主题。'));return;}for(const item of items){parent.append(text('p',`${reviewPositions[item.position]} · ${reviewSeverity[item.severity]}`),text('p',`依据：${item.detail}`),text('p',`建议：${item.suggestion}`));}}
function renderReviewComparison(){
  const round=activeReview,groups=round.groups||[];
  const different=groups.filter(g=>g.classification==='different').length,clarify=groups.filter(g=>g.classification==='single'||g.classification==='uncertain').length,pending=groups.filter(g=>!g.currentDecision).length;
  $('review-counts').textContent=`共 ${groups.length} 项主题：${different} 项判断有分歧，${clarify} 项单方或待澄清，${pending} 项尚无人工处理决定。${round.stale?'本轮已过期，所有决定仅为历史。':''}`;
  $('review-groups').replaceChildren();
  for(const group of groups){const panel=text('article','','review-group');panel.id='review-topic-'+group.id;panel.append(text('h3',group.topic),text('span',reviewClasses[group.classification],`classification ${group.classification}`));const columns=text('div','','opinion-columns');for(const slot of ['reviewerA','reviewerB']){const column=document.createElement('div');appendOpinion(column,group[slot],slot);columns.append(column);}panel.append(columns);
    if(group.currentDecision)panel.append(text('p',`${round.stale?'历史决定':'当前处理'}：${reviewActions[group.currentDecision.action]}；理由：${group.currentDecision.reason}`,'decision-current'));
    const form=document.createElement('form'),action=document.createElement('select'),reason=document.createElement('textarea'),evidence=document.createElement('input'),error=text('p','','field-error'),button=text('button','保存本项人工处理决定');
    action.id=`action-${group.id}`;reason.id=`decision-reason-${group.id}`;evidence.id=`decision-evidence-${group.id}`;optionsInto(action,[['','请选择处理方式'],...Object.entries(reviewActions)]);reason.rows=2;reason.maxLength=4000;evidence.maxLength=2000;error.hidden=true;button.type='submit';
    for(const [field,label]of [[action,'这项意见怎么处理'],[reason,'处理理由（必填）'],[evidence,'核对证据或后续待办引用（可选）']]){const lab=text('label',label);lab.htmlFor=field.id;form.append(lab,field);}form.append(error,button);for(const field of [action,reason,evidence,button])field.disabled=round.stale;
    form.onsubmit=event=>{event.preventDefault();busy(button,async()=>{error.hidden=true;if(!action.value){invalidate(action,'请选择处理方式。',error);return;}if(!reason.value.trim()){invalidate(reason,'请说明为什么这样处理。',error);return;}await api(`/api/review-rounds/${round.id}/decisions`,{groupId:group.id,action:action.value,reason:reason.value.trim(),evidence:evidence.value.trim()});await refresh();});};panel.append(form);
    if(group.history.length){const details=document.createElement('details');details.append(text('summary',`查看 ${group.history.length} 条人工决定历史`));for(const d of group.history)details.append(text('p',`${when(d.createdAt)} · ${reviewActions[d.action]} · ${d.reason}${d.evidence?`；证据：${d.evidence}`:''}`));panel.append(details);}$('review-groups').append(panel);
  }
  const originals=document.createElement('details');originals.append(text('summary','查看两方锁定的完整原文'));for(const review of round.reviews){originals.append(text('h3',`${roleNames[review.slot]} · ${review.actualPlatform} / ${review.actualModel}`),text('p',`来源：${review.sourceEvidence}；身份：${review.identityVerified===false?'待核验，仅作参考':'已按来源手动核对'}`,'hint'),text('p',`结论：${review.conclusion}`),text('pre',review.raw));}$('review-groups').append(originals);
  $('review-comments').replaceChildren();for(const c of round.comments)$('review-comments').append(text('p',`${when(c.createdAt)} · ${c.actor==='human'?'人工负责人':roleNames[c.actor]}：${c.text}（来源：${c.sourceEvidence}）`));if(!round.comments.length)$('review-comments').append(text('p','暂无交叉补充。','hint'));
  for(const field of $('review-comment-form').querySelectorAll('input,select,textarea,button')){field.disabled=round.stale;if(field.tagName==='BUTTON')field.dataset.locked=String(round.stale);}
}
$('review-task').onchange=()=>busy($('open-review'),()=>refreshReviewChoices(true));
$('review-round').onchange=()=>busy($('open-review'),()=>loadReview($('review-round').value,true));
$('review-slot').onchange=()=>{clearReviewDraft();showReviewSlot();};
$('open-review').onclick=()=>busy($('open-review'),async()=>{const task=taskList.find(t=>t.id===$('review-task').value);if(!task)throw new Error('请先选定有主执行结果的任务。');const round=await api(`/api/tasks/${task.id}/review-rounds`,{expectedVersion:task.version});await refresh();$('review-round').value=round.id;await loadReview(round.id,true);});
$('add-review-item').onclick=()=>{if($('review-items').children.length>=30){message('最多30项意见。');return;}$('review-items').append(reviewItemRow());};
$('review-file').onchange=async()=>{try{const file=$('review-file').files[0];if(!file)return;if(!/\.(json|md|txt)$/i.test(file.name)||file.size>1024*1024)throw new Error('请使用最多1MB的JSON、Markdown或文本文件。');$('review-raw').value=await file.text();parsedReviewBinding=undefined;$('review-independent').checked=false;$('review-identity-verified').checked=false;}catch(error){invalidate($('review-file'),error.message,$('review-submit-error'));}};
$('parse-review').onclick=()=>{try{const raw=$('review-raw').value.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const parsed=JSON.parse(raw);if(!parsed||typeof parsed.conclusion!=='string'||!Array.isArray(parsed.items)||parsed.items.length<1||parsed.items.length>30)throw Error('请按任务包JSON格式提供conclusion和1至30条items。');if(!parsed.items.every(item=>item&&typeof item==='object'&&Object.hasOwn(reviewPositions,item.position)&&Object.hasOwn(reviewSeverity,item.severity)&&['topic','detail','suggestion'].every(key=>typeof item[key]==='string'&&item[key].trim())))throw Error('每项需有有效主题、判断、严重程度、依据和建议，不能自动猜测缺项');const bindingKeys=['roundId','taskVersion','targetReceiptId','targetContentHash'];parsedReviewBinding=undefined;if(bindingKeys.some(key=>Object.hasOwn(parsed,key))){const expectedBinding=activeReview?{roundId:activeReview.id,taskVersion:activeReview.taskVersion,targetReceiptId:activeReview.targetReceiptId,targetContentHash:activeReview.targetContentHash}:null;if(!expectedBinding||!bindingKeys.every(key=>parsed[key]===expectedBinding[key]))throw Error('这份JSON不属于当前评审产物或版本，请重新核对任务包');parsedReviewBinding=Object.fromEntries(bindingKeys.map(key=>[key,parsed[key]]));}$('review-conclusion').value=parsed.conclusion;$('review-items').replaceChildren(...parsed.items.map(item=>reviewItemRow(item||{})));$('review-independent').checked=false;$('review-identity-verified').checked=false;clearInvalid($('review-submit'),$('review-submit-error'));}catch(error){invalidate($('review-raw'),`无法读取结构化意见：${error.message}；也可在下方手动整理。`,$('review-submit-error'));}};
bindForm('review-submit','review-submit-error',async()=>{if(!activeReview)throw new Error('请先发起评审。');if(!$('review-independent').checked)throw Object.assign(new Error('请先核对未参与实现，并确认意见独立完成。'),{field:'review-independent'});const payload={slot:$('review-slot').value,actualPlatform:need('review-platform','实际评审平台'),actualModel:need('review-model','实际评审模型'),sourceEvidence:need('review-source','来源依据'),independentConfirmed:true,identityVerified:$('review-identity-verified').checked,raw:$('review-raw').value,conclusion:need('review-conclusion','评审结论'),items:readReviewItems(),...(parsedReviewBinding?{binding:parsedReviewBinding}:{})};if(!payload.raw.trim()||new TextEncoder().encode(payload.raw).length>1024*1024)throw Object.assign(new Error('请提供非空且最多1MB的评审原文。'),{field:'review-raw'});await api(`/api/review-rounds/${activeReview.id}/submissions`,payload);clearReviewDraft();await refresh();});
bindForm('review-comment-form','review-comment-error',async()=>{await api(`/api/review-rounds/${activeReview.id}/comments`,{actor:$('comment-actor').value,text:need('comment-text','补充内容'),sourceEvidence:need('comment-source','实际来源')});$('comment-text').value='';$('comment-source').value='';await refresh();});
$('review-items').append(reviewItemRow());

$('review-raw').addEventListener('input',()=>{parsedReviewBinding=undefined;$('review-independent').checked=false;$('review-identity-verified').checked=false;});

bindForm('restart-review-form','restart-review-error',async()=>{if(!activeReview)throw Error('请先选择评审轮。');const round=await api(`/api/tasks/${activeReview.taskId}/review-rounds`,{expectedVersion:activeReview.taskVersion,restartRoundId:activeReview.id,restartReason:need('restart-review-reason','重新收集理由')});$('restart-review-reason').value='';reviewRounds=await api('/api/review-rounds');await refreshReviewChoices();$('review-round').value=round.id;await loadReview(round.id,true);});

async function renderReviewDispatch(round){
 const runs=await api(`/api/review-rounds/${round.id}/runs`);
 const rows=await api(`/api/review-rounds/${round.id}/dispatch`);if(activeReview?.id!==round.id)return;
 const box=text('section','','overview-focus');box.append(text('h3','双评审交接进度'),text('p','Codex 可自动进行冻结任务包的文本评审；其他平台需应用交接。自动意见不代表身份已核验或验收通过。','hint'));
 for(const slot of ['reviewerA','reviewerB']){const run=runs.find(j=>j.slot===slot),expected=round.slots[slot].expected;
 if(run){const panel=text('article','','page-comment-reply');panel.append(text('strong',roleNames[slot]+' · 自动文本评审'),text('p',({queued:'◷ 排队中',running:'◉ 独立评审运行中',completed:'✓ 意见已回收（底模未核验）',blocked:'⚠ 运行或回收受阻',cancelled:'已取消',interrupted:'⚠ 重启中断，需先核对旧进程'})[run.status]||run.status));if(run.reason)panel.append(text('p',run.reason,'hint'));
 if(['queued','running'].includes(run.status)){const cancel=text('button','取消此方自动评审','quiet');cancel.type='button';cancel.onclick=()=>busy(cancel,async()=>{await api(`/api/review-runs/${run.id}/cancel`,{});await loadReview(round.id);});panel.append(cancel);}
 if(run.status==='interrupted'&&!run.interruptionResolution){panel.append(text('p',`旧进程 PID：${run.pid??'未记录'}；目录：${run.workspace??'尚未建立'}。不会自动重跑。`));agentForm(panel,'登记旧进程已停止的实际证据',[['evidence','已核对旧进程不存在或安全停止的依据','textarea']],v=>api(`/api/review-runs/${run.id}/resolve`,{...v,confirmedStopped:true}).then(()=>loadReview(round.id)));}box.append(panel);}
 else if(expected?.platform==='Codex'&&!round.stale&&!round.slots[slot].submitted){const start=text('button',`自动启动${roleNames[slot]}（只读文本）`);start.type='button';start.onclick=()=>busy(start,async()=>{await api(`/api/review-rounds/${round.id}/runs`,{slot});await loadReview(round.id);await refreshUser();});box.append(start);}}
 if(!rows.length&&!round.stale){const enqueue=text('button','准备两方独立评审交接');enqueue.type='button';enqueue.onclick=()=>busy(enqueue,async()=>{await api(`/api/review-rounds/${round.id}/dispatch`,{});await loadReview(round.id);});box.append(enqueue);}
 for(const row of rows){const part=text('article','','page-comment-reply');part.append(text('strong',`${roleNames[row.slot]} · 期望 ${row.platform} / ${row.expectedModel}`),text('p',({waiting_handoff:'◷ 等待协调方应用交接',waiting_result:'⇄ 已登记交接，等待意见；外部运行状态未知',received:'✓ 意见已收回，仍需核查与人工复核',stale:'⚠ 依据已过期，请发起新轮'})[row.status]));
 if(row.evidence){const d=document.createElement('details');d.append(text('summary','查看交接依据'),text('p',row.evidence));part.append(d);}
 if(row.status==='waiting_handoff')agentForm(part,'登记此方实际交接',[['evidence','应用提交记录或实际交接证据','textarea']],v=>api(`/api/review-rounds/${round.id}/confirm-dispatch`,{slot:row.slot,...v}).then(()=>loadReview(round.id)));
 box.append(part);}$('review-packets').append(box);
}
