import {randomUUID,createHash} from 'node:crypto';
const digest=v=>createHash('sha256').update(v).digest('hex');
const required=(v,max=8000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Plan fields invalid');return v.trim();};
export class PlanStore {
 constructor(store,tasks,user){Object.assign(this,{store,tasks,user});tasks.executionPolicy=task=>user.assertExecution(task);try{store.db.exec(`BEGIN IMMEDIATE;
 CREATE TABLE IF NOT EXISTS development_plans(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES user_requests(id),project_id TEXT NOT NULL REFERENCES projects(id),epoch INTEGER NOT NULL,source_hash TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS plan_answers(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES development_plans(id),action TEXT NOT NULL,reply TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS plan_tasks(plan_id TEXT NOT NULL REFERENCES development_plans(id),step_key TEXT NOT NULL,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),PRIMARY KEY(plan_id,step_key));COMMIT;`);}catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}}
 get(id){const r=this.store.db.prepare('SELECT id,request_id AS requestId,project_id AS projectId,epoch,source_hash AS sourceHash,payload,status,revision,created_at AS createdAt FROM development_plans WHERE id=?').get(id);if(!r)throw Error('Plan not found');const latest=this.store.db.prepare('SELECT id FROM development_plans WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(r.requestId);const payload=JSON.parse(r.payload);return {...r,payload,current:latest.id===r.id&&this.store.configVersion(r.projectId).isLatest&&this.user.state(r.projectId).epoch===r.epoch,answers:this.store.db.prepare('SELECT action,reply,created_at AS createdAt FROM plan_answers WHERE plan_id=? ORDER BY rowid').all(id).map(a=>({...a})),tasks:this.store.db.prepare('SELECT step_key AS stepKey,task_id AS taskId FROM plan_tasks WHERE plan_id=? ORDER BY rowid').all(id).map(t=>{const task=this.tasks.mustTask(t.taskId);return {...t,status:task.status,packages:task.packages.map(p=>({id:p.id,role:p.role})),handoffs:task.handoffs.length,receipts:task.receipts.length,version:task.version,ready:!this.user.taskReasons(task).length&&task.dependencies.every(id=>this.tasks.mustTask(id).status==='valid_passed')};})};}
 list(){return this.store.db.prepare('SELECT id FROM development_plans ORDER BY rowid').all().map(p=>this.get(p.id));}
 async publish({requestId,projectId,expectedEpoch,summary,scope,outOfScope,acceptance,risks,steps,platform,model,evidence,requiresDecision=false,decisionReason=''}){return this.user.write('development_plan_proposed',requestId,()=>{
  const project=this.store.getProject(projectId),request=this.store.db.prepare('SELECT rowid,* FROM user_requests WHERE id=?').get(requestId);
  if(!project||!request)throw Error('Plan source invalid');if(!this.store.configVersion(projectId).isLatest)throw Error('Historical configuration');
  if(request.project_id&&!this.user.sameProject(request.project_id,projectId))throw Error('Plan source invalid');
  if(expectedEpoch!==this.user.state(projectId).epoch)throw Error('User revision conflict');
  const corrections=this.store.db.prepare("SELECT rowid,project_id FROM user_requests WHERE kind='correction' AND rowid>?").all(request.rowid);
  if(corrections.some(r=>this.user.sameProject(r.project_id,projectId)))throw Error('Plan source superseded');

  if(!Array.isArray(steps)||steps.length<1||steps.length>12)throw Error('Plan steps invalid');
  const seen=new Set(),stages=this.tasks.getOptions(projectId).stages;
  const clean=steps.map(step=>{if(!step||typeof step!=='object')throw Error('Plan steps invalid');const key=required(step.key,80);if(!/^[a-zA-Z0-9_-]+$/.test(key)||seen.has(key))throw Error('Plan steps invalid');const stage=stages.find(s=>s.id===step.stage);if(!stage?.roles.primary)throw Error('Role identity unknown');const dependencies=step.dependencies??[];if(!Array.isArray(dependencies)||new Set(dependencies).size!==dependencies.length||dependencies.some(k=>!seen.has(k)))throw Error('Plan dependencies invalid');seen.add(key);return {key,stage:stage.id,title:required(step.title,200),requirement:required(step.requirement),acceptance:required(step.acceptance),dependencies,roles:stage.roles};});
  if(typeof requiresDecision!=='boolean'||typeof decisionReason!=='string'||decisionReason.length>4000)throw Error('Plan fields invalid');
  if(clean.some(s=>s.stage==='release')){requiresDecision=true;decisionReason=decisionReason.trim()||'计划包含发布阶段，需要确认目标与影响范围。';}
  if(decisionReason.trim())requiresDecision=true;if(requiresDecision&&!decisionReason.trim())throw Error('Plan fields invalid');
  const held=this.user.state(projectId).paused||this.user.decisions(projectId).some(d=>d.current&&d.blocking&&!d.answers.length);
  for(const value of [platform,model])if(/^(unknown|未知|待确认)$/i.test(required(value,200)))throw Error('Identity unknown');
  const payload={requiresDecision,decisionReason,authorization:requiresDecision?'human-decision-required':'routine-auto-v1',summary:required(summary,2000),scope:required(scope),outOfScope:required(outOfScope),acceptance:required(acceptance),risks:required(risks),steps:clean,source:{platform:required(platform,200),model:required(model,200),evidence:required(evidence,4000)},request:{body:request.body,reference:request.reference,hash:digest(request.body)}};
  const previous=this.store.db.prepare('SELECT id,payload,status,epoch,source_hash FROM development_plans WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(requestId);if(['pending','queued','confirmed','auto_started'].includes(previous?.status)&&previous.payload===JSON.stringify(payload)&&previous.epoch===expectedEpoch&&previous.source_hash===project.sourceHash)return {...this.get(previous.id),duplicate:true};
  if(this.store.db.prepare("SELECT 1 FROM development_plans WHERE request_id=? AND status IN ('confirmed','auto_started')").get(requestId))throw Error('Plan already launched');
  const id=randomUUID(),at=new Date().toISOString();
  this.store.db.prepare("UPDATE development_plans SET status='superseded',revision=revision+1 WHERE request_id=? AND status IN ('pending','queued')").run(requestId);
  this.store.db.prepare('INSERT INTO development_plans VALUES(?,?,?,?,?,?,?,0,?)').run(id,requestId,projectId,expectedEpoch,project.sourceHash,JSON.stringify(payload),requiresDecision?'pending':'queued',at);
  this.store.db.prepare('UPDATE user_requests SET project_id=coalesce(project_id,?) WHERE id=?').run(projectId,requestId);
  const ack={...payload.source,plan:payload.summary,createdAt:at};
  this.store.db.prepare("UPDATE user_requests SET project_id=coalesce(project_id,?),status='acknowledged',ack=? WHERE id=? AND status='pending'").run(projectId,JSON.stringify(ack),requestId);
  if(!requiresDecision&&!held){this.launchWithinTransaction(this.get(id),true);this.store.event('development_plan_auto_started',id,null);}
  return this.get(id);
 });}
 async respond(id,{action,reply='',expectedRevision,expectedControlRevision}){return this.user.write('development_plan_answered',id,()=>{
  const plan=this.get(id);if(!['confirm','request_changes'].includes(action)||typeof reply!=='string'||reply.length>8000)throw Error('Plan response invalid');if(action==='request_changes'&&!reply.trim())throw Error('Plan change reason required');
  const last=plan.answers.at(-1);if(last?.action===action&&last.reply===reply)return {...plan,duplicate:true};
  if(plan.status!=='pending')throw Error('Plan already answered');if(!plan.current)throw Error('Plan stale');
  this.user.checkRevision(plan.revision,expectedRevision);const state=this.user.state(plan.projectId);this.user.checkRevision(state.revision,expectedControlRevision);
  if(action==='confirm'){
   if(state.paused||this.user.decisions(plan.projectId).some(d=>d.current&&d.blocking&&!d.answers.length))throw Error('Configuration held');
   this.launchWithinTransaction(plan,false);
  }
  this.store.db.prepare('INSERT INTO plan_answers VALUES(?,?,?,?,?)').run(randomUUID(),id,action,reply,new Date().toISOString());
  this.store.db.prepare('UPDATE development_plans SET status=?,revision=revision+1 WHERE id=?').run(action==='confirm'?'confirmed':'changes_requested',id);
  return this.get(id);
 });}
 launchWithinTransaction(plan,automatic){
  const id=plan.id;
   const mapped=new Map();
   for(const step of plan.payload.steps){const requirement=`${step.requirement}\n\n原始想法：${plan.payload.request.body}\n本轮范围：${plan.payload.scope}\n暂不包含：${plan.payload.outOfScope}\n来源计划：${id}；输入：${plan.requestId}`;
    const task=this.tasks.createTaskWithinTransaction({projectId:plan.projectId,title:step.title,stage:step.stage,requirement,acceptance:step.acceptance,dependencies:step.dependencies.map(k=>mapped.get(k))});
    this.user.capture(task);this.store.event('task_created',task.id,null);mapped.set(step.key,task.id);
    this.store.db.prepare('INSERT INTO plan_tasks VALUES(?,?,?)').run(id,step.key,task.id);
   }
  if(automatic){this.store.db.prepare("UPDATE development_plans SET status='auto_started',revision=revision+1 WHERE id=?").run(id);}
 }
 async start(id,{expectedRevision}){return this.user.write('development_plan_auto_started',id,()=>{const plan=this.get(id);if(plan.status==='auto_started')return {...plan,duplicate:true};if(plan.status!=='queued'||plan.payload.requiresDecision)throw Error('Plan already answered');if(!plan.current)throw Error('Plan stale');this.user.checkRevision(plan.revision,expectedRevision);if(this.user.state(plan.projectId).paused||this.user.decisions(plan.projectId).some(d=>d.current&&d.blocking&&!d.answers.length))throw Error('Configuration held');this.launchWithinTransaction(plan,true);return this.get(id);});}
 async prepare(id,{taskId,expectedVersion}){const p=this.get(id);if(!['confirmed','auto_started'].includes(p.status)||!p.tasks.some(t=>t.taskId===taskId))throw Error('Plan task invalid');return this.tasks.preparePackage(taskId,{role:'primary',expectedVersion});}
}
