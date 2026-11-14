import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, parse } from 'node:path';
import { platformPaths } from './platform-probe.mjs';
import { artifactFormat } from './artifacts.mjs';

const now = () => new Date().toISOString();
const active = new Set(['queued', 'starting', 'running']);
const hash = value => createHash('sha256').update(value).digest('hex');
const cleanModel = name => name.toLowerCase().replace(/\s+/g, '-');
export const executionModel = name => typeof name === 'string' && /^gpt-[a-z0-9][a-z0-9.-]{0,99}$/.test(cleanModel(name)) ? cleanModel(name) : null;

export function parseCodexResult(stdout, code, signal) {
  let events;
  try { events = stdout.split('\n').filter(x => x.trim()).map(x => JSON.parse(x)); } catch { return { ok: false, reason: 'invalid_jsonl' }; }
  const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text).filter(x => typeof x === 'string');
  const raw = messages.at(-1);
  if (code !== 0 || signal || !events.some(e => e.type === 'turn.completed') || events.some(e => ['turn.failed', 'error'].includes(e.type)) || !raw?.trim()) return { ok: false, reason: 'incomplete_turn' };
  return { ok: true, raw, contentHash: hash(raw) };
}

// Each package is launched at most once, including after a crash. Read-only analysis
// and code proposals only: workspace-write and automatic repository mutation come later.
export class ExecutionStore {
  constructor(store, tasks, user, { spawnProcess = spawn, timeoutMs = 180000, pollMs = 1000 } = {}) {
    this.store = store; this.tasks = tasks; this.user = user;
    this.spawnProcess = spawnProcess; this.timeoutMs = timeoutMs; this.pollMs = pollMs;
    this.children = new Map(); this.pending = new Set(); this.collecting = new Map(); this.closing = false;
    store.db.exec('CREATE TABLE IF NOT EXISTS execution_jobs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), package_id TEXT NOT NULL UNIQUE REFERENCES task_packages(id), state TEXT NOT NULL)');
    const recover = this.list().filter(j => active.has(j.status));
    if (recover.length) tasks.transaction('executions_interrupted_on_restart', null, () => {
      for (const job of recover) this.save({ ...job, status: 'interrupted', reason: 'server_restart_no_auto_retry', finishedAt: now() });
    });
  }
  save(job) { this.store.db.prepare('UPDATE execution_jobs SET state=? WHERE id=?').run(JSON.stringify(job), job.id); return job; }
  get(id) { const row = this.store.db.prepare('SELECT state FROM execution_jobs WHERE id=?').get(id); if (!row) throw Error('Execution not found'); return JSON.parse(row.state); }
  list() { return this.store.db.prepare('SELECT state FROM execution_jobs ORDER BY rowid').all().map(r => JSON.parse(r.state)); }
  publicList() { return this.list().map(({ stdout, stderr, prompt, ...job }) => job); }
  async change(id, event, fn) { return this.tasks.write(event, id, () => this.save(fn(this.get(id)))); }
  async start(taskId, { packageId, expectedVersion, outputFormat = 'text' }) {
    if (this.closing) throw Error('Execution stopping');
    if(!['text',artifactFormat].includes(outputFormat))throw Error('Execution output format invalid');
    const job = await this.tasks.write('execution_queued', taskId, () => {
      const task = this.tasks.mustTask(taskId); this.tasks.requireVersion(task, expectedVersion);
      const pkg = this.tasks.packageFor(task, packageId);
      const previous = this.list().find(j => j.packageId === pkg.id);
      if (previous) {if((previous.outputFormat??'text')!==outputFormat)throw Error('Execution format conflict');return { ...previous, duplicate: true };}
      this.user.assertExecution(task); this.tasks.checkReady(task);
      if(this.externalBusy?.())throw Error('Execution busy');
      if(this.list().some(j=>active.has(j.status)))throw Error('Execution busy');
      if(this.list().some(j=>j.status==='interrupted'&&!j.interruptionResolution))throw Error('Execution orphan unresolved');
      if (!['primary', 'support'].includes(pkg.role) || task.handoffs.some(h => h.packageId === packageId) || task.receipts.some(r => r.packageId === packageId)) throw Error('Execution already handed off');
      const identity = this.tasks.getOptions(task.projectId).stages.find(s => s.id === task.stage)?.roles[pkg.role];
      if (identity?.platform !== 'Codex') throw Error('Execution platform unsupported');
      const model = executionModel(identity.name);
      if (!model) throw Error('Execution model unmapped');
      const result = { id: randomUUID(), taskId, projectId: task.projectId, packageId, version: task.version, inputHash: pkg.inputHash, epoch: this.user.state(task.projectId).epoch, model, expectedModel: identity.name, actualModel: `CLI 请求 ${model}；底层型号未核验`, mode: 'read-only', status: 'queued', createdAt: now(), startedAt: null, finishedAt: null, reason: null, receiptId: null, stdout: '', stderr: '', prompt: pkg.markdown };
      result.outputFormat=outputFormat;result.protocolVersion='readonly-artifacts-v1';
      result.prompt=buildExecutionPrompt(result);
      result.executionInputHash=hash(result.prompt);
      this.store.db.prepare('INSERT INTO execution_jobs VALUES(?,?,?,?)').run(result.id, taskId, packageId, JSON.stringify(result));
      return result;
    });
    if (!job.duplicate) {
      const promise = new Promise(resolve => setImmediate(resolve)).then(() => this.execute(job.id));
      this.pending.add(promise); promise.finally(() => this.pending.delete(promise));
    }
    const { stdout, stderr, prompt, ...publicJob } = job; return publicJob;
  }
  check(job) {
    const task = this.tasks.mustTask(job.taskId, job.version);
    const pkg = this.tasks.packageFor(task, job.packageId);
    if (pkg.inputHash !== job.inputHash || this.user.state(job.projectId).epoch !== job.epoch) throw Error('Execution basis changed');
    this.user.assertExecution(task); this.tasks.checkReady(task);
    return task;
  }
  workspace(id) {
    const dir = resolve(this.store.root, 'execution-workspaces', id);
    let current = parse(dir).root;
    for (const part of dir.slice(current.length).split('/').filter(Boolean)) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw Error('Execution workspace unsafe'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (realpathSync(dir) !== dir) throw Error('Execution workspace unsafe');
    return dir;
  }
  async execute(id) {
    let job, child, timer, poll, killTimer, stdin, stdout = '', stderr = '', stopped = null, flushing = false, savedLength = 0, closed = false;
    const stop = reason => {
      if (stopped || closed) return;
      stopped = reason;
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 1000);
      } else child?.kill('SIGTERM');
    };
    try {
      job = this.get(id);
      if (job.status !== 'queued') return;
      await this.change(id, 'execution_starting', j => { if (this.closing||j.cancelRequested) throw Error('Execution stopping'); this.check(j); return { ...j, status: 'starting' }; });
      const cwd = this.workspace(id);
      writeFileSync(join(cwd, 'task-package.md'), this.tasks.packageFor(this.tasks.mustTask(job.taskId),job.packageId).markdown, { mode: 0o600, flag: 'wx' });
      // Recheck and spawn synchronously in the same serialized transaction, without a
      // pause/edit window between the final guard and creating the child process.
      let resolveExit,spawnFailed=false;
      const exitPromise=new Promise(resolve=>{resolveExit=resolve;});
      await this.change(id, 'execution_process_started', j => {
        if (this.closing||j.cancelRequested) throw Error('Execution stopping'); this.check(j);
        stdin=j.protocolVersion?j.prompt:buildExecutionPrompt(j);
        if(j.protocolVersion&&hash(Buffer.from(stdin,'utf8'))!==j.executionInputHash)throw Error('Execution input mismatch');
        writeFileSync(join(cwd,'execution-input.txt'),stdin,{mode:0o600,flag:'wx'});
        child = this.spawnProcess(platformPaths.codex, ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', j.model, '--json', '-'], { cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.once('error',()=>{spawnFailed=true;});
        child.once('close',(code,signal)=>{closed=true;resolveExit({code,signal,spawnFailed});});
        for(const channel of ['stdout','stderr']){
          child[channel].setEncoding?.('utf8');
          child[channel].on('data',chunk=>{
            if(channel==='stdout')stdout+=chunk;else stderr+=chunk;
            if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>2*1024*1024){stdout=stdout.slice(0,512*1024);stderr=stderr.slice(0,512*1024);stop('output_limit');}
          });
        }
        this.children.set(id, { child, stop });
        return { ...j, executionInputVerified:!!j.protocolVersion, status: 'running', startedAt: now(), workspace: cwd, pid: child.pid ?? null };
      });
      if (stopped) stop(stopped);
        child.stdin.on('error', () => {});
        child.stdin.end(stdin);
        timer = setTimeout(() => stop('timeout'), this.timeoutMs);
        poll = setInterval(() => {
          try { this.check(this.get(id)); } catch { stop('project_held_or_basis_changed'); }
          if(!flushing&&stdout.length+stderr.length!==savedLength){
            flushing=true;const currentOut=stdout,currentErr=stderr;savedLength=currentOut.length+currentErr.length;
            this.change(id,'execution_log_checkpoint',j=>active.has(j.status)?{...j,stdout:currentOut,stderr:currentErr}:j).catch(()=>stop('log_persistence_failed')).finally(()=>{flushing=false;});
          }
        }, this.pollMs);
      const result=await exitPromise;
      clearTimeout(timer); clearInterval(poll); clearTimeout(killTimer); this.children.delete(id);
      const parsed = parseCodexResult(stdout, result.code, result.signal);
      job = await this.change(id, 'execution_output_saved', j => ({ ...j, stdout, stderr, exitCode: result.code, signal: result.signal, finishedAt: now(), status: stopped||j.cancelRequested ? 'cancelled' : parsed.ok && !result.spawnFailed ? 'collection_pending' : 'failed', reason: stopped || (j.cancelRequested?'cancelled_by_coordinator':result.spawnFailed ? 'spawn_failed' : parsed.ok ? null : parsed.reason), contentHash: parsed.contentHash ?? null }));
      if (job.status === 'collection_pending') await this.collect(id);
    } catch (error) {
      stop('execution_failed');
      try { await this.change(id, 'execution_failed', j => ({ ...j, stdout, stderr, status: j.status === 'collection_pending' ? 'collection_pending' : j.cancelRequested ? 'cancelled' : 'failed', reason: error.message==='Execution input mismatch'?'execution_input_mismatch':'execution_or_collection_failed', finishedAt: now() })); } catch { /* preserve the original durable record; never retry a model on uncertain state */ }
    } finally { clearTimeout(timer); clearInterval(poll); this.children.delete(id); }
  }
  async collect(id) {
    if(this.collecting.has(id))return this.collecting.get(id);
    const promise=this.collectOnce(id);this.collecting.set(id,promise);
    try{return await promise;}finally{this.collecting.delete(id);}
  }
  async collectOnce(id) {
    const job = this.get(id);
    if(job.cancelRequested)throw Error('Execution result unavailable');
    if (job.status === 'completed') return { ...job, duplicate: true };
    if (job.status !== 'collection_pending') throw Error('Execution result unavailable');
    const parsed = parseCodexResult(job.stdout, job.exitCode, job.signal);
    if (!parsed.ok || parsed.contentHash !== job.contentHash) throw Error('Execution result unavailable');
    const task = this.tasks.mustTask(job.taskId);
    const evidence = `本机 Codex CLI 运行 ${id}；任务包 ${job.packageId}；输入 ${job.inputHash}；执行输入 ${job.executionInputHash??'旧版未记录'}（${job.executionInputVerified?'启动前按实际 stdin 字节复核一致':'旧版未绑定'}）；输出格式 ${job.outputFormat??'text'}；进程开始 ${job.startedAt}，结束 ${job.finishedAt}；exit=0，已收到 turn.completed；请求模型 ${job.model}，不代表底层型号认证。`;
    if (!task.handoffs.some(h => h.packageId === job.packageId && h.actualPlatform === 'Codex' && h.actualModel === job.actualModel)) {
      const held = this.user.taskReasons(task).length > 0;
      await this.tasks.confirmHandoff(job.taskId, { packageId: job.packageId, actualPlatform: 'Codex', actualModel: job.actualModel, evidence, confirmed: true, inFlight: held, submittedAt: job.startedAt });
    }
    const receipt = await this.tasks.importResult(job.taskId, { packageId: job.packageId, raw: parsed.raw, actualPlatform: 'Codex', actualModel: job.actualModel, sourceEvidence: evidence });
    return this.change(id, 'execution_collected', j => ({ ...j, status: 'completed', receiptId: receipt.id, reason: null }));
  }
  async cancel(id) {
    const job = await this.change(id, 'execution_cancel_requested', j => active.has(j.status) ? { ...j, cancelRequested: true } : j);
    const managed = this.children.get(id);
    if (managed) managed.stop('cancelled_by_coordinator');
    else if (job.status === 'queued') await this.change(id, 'execution_cancelled', j => ({ ...j, status: 'cancelled', reason: 'cancelled_before_start', finishedAt: now() }));
    return this.get(id);
  }
  async resolveInterruption(id,{confirmedStopped,evidence}){
    return this.change(id,'execution_interruption_reviewed',job=>{
      if(job.status!=='interrupted'||confirmedStopped!==true||typeof evidence!=='string'||!evidence.trim()||evidence.length>4000)throw Error('Execution recovery invalid');
      if(job.interruptionResolution)return job;
      return {...job,interruptionResolution:{evidence:evidence.trim(),confirmedStopped:true,recordedAt:now(),source:'coordinator-declaration-not-automatic-verification'}};
    });
  }
  async replace(id,{reason}){
    return this.tasks.write('execution_replacement_created',id,()=>{
      const job=this.get(id);
      if(job.replacementTaskId)return {...job,duplicate:true};
      if(!['failed','cancelled','interrupted'].includes(job.status)||this.children.has(id)||typeof reason!=='string'||!reason.trim()||reason.length>4000)throw Error('Execution recovery invalid');
      if(job.status==='interrupted'&&!job.interruptionResolution)throw Error('Execution orphan unresolved');
      const original=this.tasks.mustTask(job.taskId);this.user.assertExecution(original);
      const task=this.tasks.createTaskWithinTransaction({projectId:original.projectId,title:original.title+'（恢复任务）',stage:original.stage,requirement:original.requirement+`\n\n恢复来源任务 ${original.id}；原运行 ${id}；处置原因：${reason.trim()}。旧记录保留，不表示已成功。`,acceptance:original.acceptance,dependencies:original.dependencies});
      this.user.capture(task);this.store.event('task_created',task.id,null);
      return this.save({...job,replacementTaskId:task.id,replacementReason:reason.trim(),replacedAt:now()});
    });
  }
  async shutdown() { this.closing = true; for (const { stop } of this.children.values()) stop('server_shutdown'); await Promise.allSettled([...this.pending]); }
}

export function buildExecutionPrompt(job){
  const format=job.outputFormat===artifactFormat?'\n最终回复必须是一个纯 JSON 对象，不加 Markdown 围栏：{"format":"collab-artifacts/v1","files":[{"path":"src/example.js","content":"完整文件内容"}]}。只输出与需求有关的完整候选文件，路径必须是相对路径，禁止 ..、反斜杠或 .git；最多 30 个文件、每文件 256KB、合计 512KB。不要自行增加无关功能，不声称文件已写入或测试已通过。':'\n输出最终分析或方案，不声称未发生的实施、测试或验收。';
  return '你正在执行协作台的只读任务。只分析所提供的任务包并输出最终成果，不执行命令、不修改文件、不访问其他项目；不发布、不部署、不安装依赖。不要自行调用其他平台。'+format+'\n\n'+job.prompt;
}
