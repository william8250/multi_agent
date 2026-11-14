// Only explicit references count as traceability; no text matching or inferred acceptance.
export function requirementTrace({requests=[],plans=[],tasks=[],commentJobs=[]}){
 return requests.map(r=>{
  const relatedPlans=plans.filter(p=>p.requestId===r.id&&p.projectId===r.projectId);
  const currentPlans=relatedPlans.filter(p=>p.current);
  const ids=new Set([...currentPlans.flatMap(p=>(p.tasks||[]).map(t=>t.taskId)),...(r.replies||[]).map(x=>x.taskId).filter(Boolean)]);
  const linked=tasks.filter(t=>ids.has(t.id)&&t.projectId===r.projectId);
  const jobs=commentJobs.filter(j=>j.requestId===r.id);const job=jobs.at(-1);
  const accepted=linked.filter(t=>t.status==='valid_passed'&&t.gate?.approved&&!t.review?.stale&&!(t.controls||[]).length).length;
  let state='unlinked',next='协调方建立需求与任务关联';
  if(linked.length){state='in_progress';next='协调方推进任务与评审';if(accepted===linked.length){state='accepted';next='已关联任务验收通过，范围以关联任务为准';}else if(linked.some(t=>t.controls?.length)){state='blocked';next='协调方处理阻塞项';}else if(linked.every(t=>['result_received','valid_passed'].includes(t.status))){state='review';next='协调方补齐评审与验收证据';}}
  else if(job){state=job.status==='applied'?'basic_checked':['failed','blocked'].includes(job.status)?'blocked':['queued','running','validating','applying'].includes(job.status)?'in_progress':'planned';next=state==='basic_checked'?'用户体验修改，正式验收仍待登记':state==='blocked'?'协调方排查处理失败原因':state==='planned'?'协调方继续实施':'后台处理，用户可继续补充反馈';}
  else if(currentPlans.length){state=currentPlans.some(p=>p.status==='pending')?'decision':'planned';next=state==='decision'?'用户查看需要我决定':'协调方准备执行任务';}
  return {requestId:r.id,projectId:r.projectId,body:r.body,kind:r.kind,state,next,taskIds:linked.map(t=>t.id),planIds:currentPlans.map(p=>p.id),historicalPlanCount:relatedPlans.length-currentPlans.length,linkedTasks:linked.length,acceptedTasks:accepted,source:'explicit-links-only'};
 });
}
