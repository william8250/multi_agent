import {platformAdapter,executionAdapter} from './platform-adapters.mjs';
import {randomUUID} from 'node:crypto';
const live=new Set(['queued','running','waiting_handoff','waiting_result']);
export class Scheduler {
 constructor(store,tasks,user,executions,{clock=()=>Date.now(),timeoutMs=24*60*60*1000}={}){Object.assign(this,{store,tasks,user,executions,clock,timeoutMs});this.busy=false;this.closing=false;store.db.exec('CREATE TABLE IF NOT EXISTS scheduler_jobs(id TEXT PRIMARY KEY,package_id TEXT NOT NULL UNIQUE REFERENCES task_packages(id),state TEXT NOT NULL)');}
 list(){return this.store.db.prepare('SELECT state FROM scheduler_jobs ORDER BY rowid').all().map(r=>JSON.parse(r.state));}
 get(id){const j=this.list().find(j=>j.id===id);if(!j)throw Error('Scheduled job not found');return j;}
 async change(id,fields){return this.tasks.write('scheduler_updated',id,()=>{const current=this.get(id);if(current.status==='cancelled')return current;const j={...current,...fields,updatedAt:new Date(this.clock()).toISOString()};this.store.db.prepare('UPDATE scheduler_jobs SET state=? WHERE id=?').run(JSON.stringify(j),id);return j;});}
 async enqueue(taskId,{packageId,expectedVersion}){return this.tasks.write('scheduler_enqueued',taskId,()=>{
 const task=this.tasks.mustTask(taskId);this.tasks.requireVersion(task,expectedVersion);const pkg=this.tasks.packageFor(task,packageId);this.user.assertExecution(task);this.tasks.checkReady(task);
 const previous=this.list().find(j=>j.packageId===packageId);if(previous)return {...previous,duplicate:true};
 if(!['primary','support'].includes(pkg.role))throw Error('Unsupported scheduled role');
 const identity=this.tasks.getOptions(task.projectId).stages.find(s=>s.id===task.stage)?.roles[pkg.role];const adapter=platformAdapter(identity?.platform);
 const stamp=new Date(this.clock()).toISOString(),j={id:randomUUID(),taskId,projectId:task.projectId,packageId,version:task.version,epoch:this.user.state(task.projectId).epoch,platform:identity.platform,mode:adapter.mode,adapterId:adapter.id,status:'queued',executionId:null,receiptId:null,reason:null,createdAt:stamp,updatedAt:stamp,deadline:this.clock()+this.timeoutMs};
 this.store.db.prepare('INSERT INTO scheduler_jobs VALUES(?,?,?)').run(j.id,packageId,JSON.stringify(j));return j;});}
 async cancel(id){const j=this.get(id);if(!live.has(j.status))return j;const driver=executionAdapter(j.platform,{executions:this.executions});if(j.executionId){const e=driver.get(j.executionId);if(['queued','starting','running'].includes(e.status))await driver.cancel(e.id);}
 return this.change(id,{status:'cancelled',reason:j.mode==='application-relay'?'已停止本机调度跟踪；外部应用需另行停止，未宣称已撤销外部执行':'已取消调度'});}
 async tick(){if(this.busy||this.closing)return;this.busy=true;try{for(const j of this.list().filter(j=>live.has(j.status))){try{
 const driver=executionAdapter(j.platform,{executions:this.executions}),task=this.tasks.mustTask(j.taskId),state=this.user.state(j.projectId);
 if(state.epoch!==j.epoch||task.version!==j.version||!this.store.configVersion(j.projectId).isLatest){if(j.executionId&&['queued','starting','running'].includes(driver.get(j.executionId).status))await driver.cancel(j.executionId);await this.change(j.id,{status:'blocked',reason:'任务版本或项目方向已变化；禁止继续分发旧任务'});continue;}
 if(j.executionId){const e=driver.get(j.executionId);if(e.status==='completed')await this.change(j.id,{status:'completed',receiptId:e.receiptId,reason:'成果已回收，尚未验收'});else if(['failed','cancelled','interrupted','collection_pending'].includes(e.status))await this.change(j.id,{status:'blocked',reason:e.reason||e.status});continue;}
 const receipts=task.receipts.filter(r=>r.packageId===j.packageId);if(receipts.length){await this.change(j.id,{status:receipts.length===1?'completed':'blocked',receiptId:receipts.length===1?receipts[0].id:null,reason:receipts.length===1?'成果已登记，来源身份仍以原交接证据为准；尚未验收':'存在多版成果，需要协调方选用'});continue;}
 if(state.paused)continue;
 this.user.assertExecution(task);this.tasks.checkReady(task);
 if(this.clock()>j.deadline){await this.change(j.id,{status:'blocked',reason:'调度等待超时，不自动重试；请协调方核查平台与交接状态'});continue;}
 if(!platformAdapter(j.platform).automaticExecution){const next=task.handoffs.some(h=>h.packageId===j.packageId)?'waiting_result':'waiting_handoff';if(j.status!==next)await this.change(j.id,{status:next,reason:'平台尚无后台执行适配器；需应用操作或人工交接，未验证外部运行心跳'});continue;}
 const existing=driver.find(j.packageId);
 if(existing){await this.change(j.id,{status:'running',executionId:existing.id});continue;}
 if(this.executions.list().some(e=>['queued','starting','running','collection_pending'].includes(e.status)))continue;
 const e=await driver.start(task.id,{packageId:j.packageId,expectedVersion:j.version});if(this.get(j.id).status==='cancelled'){await driver.cancel(e.id);continue;}await this.change(j.id,{status:'running',executionId:e.id,reason:null});
 }catch(error){if(error.message==='Execution busy')continue;await this.change(j.id,{status:'blocked',reason:error.message});}}
 }finally{this.busy=false;}}
 start(){this.timer=setInterval(()=>{this.pending=this.tick().catch(e=>{this.lastError=e.message;});},2000);this.timer.unref();}
 async shutdown(){this.closing=true;clearInterval(this.timer);await this.pending;}
}
