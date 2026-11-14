import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Store } from '../lib/store.mjs';
import { TaskStore } from '../lib/tasks.mjs';
import { ReviewStore } from '../lib/reviews.mjs';
import { GateStore } from '../lib/gates.mjs';
import { UserConsole } from '../lib/console.mjs';
import { ExecutionStore, parseCodexResult } from '../lib/executions.mjs';
import { artifactForTask } from '../lib/artifacts.mjs';

const jsonl = raw => [{type:'item.completed',item:{type:'agent_message',text:raw}},{type:'turn.completed'}].map(JSON.stringify).join('\n')+'\n';
function childProcess() {
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{queueMicrotask(()=>child.emit('close',null,'SIGTERM'));return true;};
  return child;
}
async function fixture(run,options={}) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'collab-exec-test-'))),store=new Store(dir),tasks=new TaskStore(store),reviews=new ReviewStore(store,tasks),gates=new GateStore(store,tasks,reviews),user=new UserConsole(store,tasks,reviews,gates);
  tasks.executionPolicy=t=>user.assertExecution(t);tasks.handoffPolicy=(...args)=>user.handoffPolicy(...args);
  const cfg={schemaVersion:'1.0',fields:{projectName:'Synthetic execution test',secret:'PRIVATE_BILL'},platforms:[],skills:[],models:[{id:'m',platform:'Codex',name:'GPT-6.1 Sol'}],stages:[{id:'coding',primary:'m'}]};
  const p=await store.importConfig(JSON.stringify(cfg));
  const task=await tasks.createTask({projectId:p.id,title:'Synthetic',stage:'coding',requirement:'Return a checklist',acceptance:'Three checks'});user.capture(task);
  const pkg=await tasks.preparePackage(task.id,{role:'primary',expectedVersion:1});
  const calls=[];let child;
  const executions=new ExecutionStore(store,tasks,user,{pollMs:5,timeoutMs:3000,spawnProcess:(...args)=>{calls.push(args);child=childProcess();options.onSpawn?.(child);return child;},...options});
  const wait=async()=>{for(let i=0;i<200;i++){if(child)return child;await new Promise(r=>setTimeout(r,5));}throw Error('Child not started');};
  try{await run({store,tasks,user,executions,p,task,pkg,calls,wait,dir});}finally{await executions.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
}
test('bound run collects final reply once, keeps raw logs, and never passes acceptance',()=>fixture(async x=>{
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1});
  const duplicate=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1});assert.equal(duplicate.id,job.id);assert.equal(duplicate.duplicate,true);
  const child=await x.wait();child.stdout.end(jsonl('A real-shaped synthetic reply'));child.emit('close',0,null);await Promise.all([...x.executions.pending]);
  const done=x.executions.get(job.id);assert.equal(done.status,'completed');assert.ok(done.receiptId);assert.equal(x.calls.length,1);
  const task=x.tasks.getTask(x.task.id);assert.equal(task.status,'result_received');assert.equal(task.receipts.length,1);assert.match(task.receipts[0].actualModel,/底层型号未核验/);
  assert.equal((await x.executions.collect(job.id)).duplicate,true);assert.equal(task.handoffs.length,1);
  const [path,args,opts]=x.calls[0];assert.match(path,/codex$/);assert.equal(opts.shell,false);assert.equal(args[args.indexOf('--sandbox')+1],'read-only');assert.equal(args[args.indexOf('--model')+1],'gpt-6.1-sol');
  assert.doesNotMatch(readFileSync(join(done.workspace,'task-package.md'),'utf8'),/PRIVATE_BILL/);
  assert.equal(x.executions.publicList()[0].stdout,undefined);assert.equal(x.executions.publicList()[0].prompt,undefined);
}));
test('paused project and a stale task version do not spawn a process',()=>fixture(async x=>{
  await assert.rejects(x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:2}),/version conflict/);
  await x.user.control(x.p.id,{action:'pause',expectedRevision:0});
  await assert.rejects(x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1}),/project_paused/);assert.equal(x.calls.length,0);
}));
test('incomplete successful exit is failed and does not create a handoff or receipt',()=>fixture(async x=>{
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1}),child=await x.wait();
  child.stdout.end(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Partial'}}));child.emit('close',0,null);await Promise.all([...x.executions.pending]);
  assert.equal(x.executions.get(job.id).status,'failed');assert.equal(x.tasks.getTask(x.task.id).handoffs.length,0);assert.equal(x.tasks.getTask(x.task.id).receipts.length,0);
  assert.equal((await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1})).duplicate,true);assert.equal(x.calls.length,1);
}));
test('pause during a managed process terminates it and cannot import a completed-looking reply',()=>fixture(async x=>{
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1});await x.wait();
  await x.user.control(x.p.id,{action:'pause',expectedRevision:0});await Promise.all([...x.executions.pending]);
  assert.equal(x.executions.get(job.id).status,'cancelled');assert.equal(x.tasks.getTask(x.task.id).receipts.length,0);
}));
test('receipt failure preserves collection_pending and retry does not invoke model again',()=>fixture(async x=>{
  const original=x.tasks.importResult.bind(x.tasks);x.tasks.importResult=async()=>{throw Error('Injected disk failure');};
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1}),child=await x.wait();child.stdout.end(jsonl('Preserved output'));child.emit('close',0,null);await Promise.all([...x.executions.pending]);
  assert.equal(x.executions.get(job.id).status,'collection_pending');assert.equal(x.tasks.getTask(x.task.id).receipts.length,0);
  x.tasks.importResult=original;await Promise.all([x.executions.collect(job.id),x.executions.collect(job.id)]);assert.equal(x.calls.length,1);assert.equal(x.executions.get(job.id).status,'completed');assert.equal(x.tasks.getTask(x.task.id).handoffs.length,1);
}));
test('startup marks an uncertain run interrupted without re-executing it',()=>fixture(async x=>{
  x.store.db.prepare('INSERT INTO execution_jobs VALUES(?,?,?,?)').run('restart',x.task.id,x.pkg.id,JSON.stringify({id:'restart',taskId:x.task.id,packageId:x.pkg.id,status:'running'}));
  const reopened=new ExecutionStore(x.store,x.tasks,x.user,{spawnProcess:()=>{throw Error('Must not spawn');}});
  assert.equal(reopened.get('restart').status,'interrupted');assert.equal(reopened.get('restart').reason,'server_restart_no_auto_retry');await reopened.shutdown();
}));
test('JSON parsing rejects invalid output, failure events and nonzero exit',()=>{
  assert.equal(parseCodexResult(jsonl('ok'),0,null).ok,true);
  for(const [out,code,signal]of [['bad',0,null],[jsonl('ok'),1,null],[jsonl('ok'),0,'SIGTERM'],[jsonl('ok')+JSON.stringify({type:'turn.failed'}),0,null]])assert.equal(parseCodexResult(out,code,signal).ok,false);
});
test('cancelling a queued run before the next event loop does not spawn it',()=>fixture(async x=>{
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1});await x.executions.cancel(job.id);await Promise.all([...x.executions.pending]);
  assert.equal(x.executions.get(job.id).status,'cancelled');assert.equal(x.calls.length,0);
}));
test('timeout stops the process and does not create receipts',()=>fixture(async x=>{
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1});await x.wait();await Promise.all([...x.executions.pending]);
  assert.equal(x.executions.get(job.id).reason,'timeout');assert.equal(x.tasks.getTask(x.task.id).receipts.length,0);
},{timeoutMs:20}));
test('missing executable is recorded as failed without any submission',()=>fixture(async x=>{
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1});await Promise.all([...x.executions.pending]);
  assert.equal(x.executions.get(job.id).status,'failed');assert.equal(x.executions.get(job.id).reason,'spawn_failed');assert.equal(x.tasks.getTask(x.task.id).handoffs.length,0);
},{onSpawn:child=>queueMicrotask(()=>{child.emit('error',new Error('ENOENT'));child.emit('close',-2,null);})}));
test('cancel after close but before output transaction wins over automatic collection',()=>fixture(async x=>{
  const change=x.executions.change.bind(x.executions);let once=false;
  x.executions.change=async(id,event,fn)=>{if(event==='execution_output_saved'&&!once){once=true;await x.executions.cancel(id);}return change(id,event,fn);};
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1}),child=await x.wait();child.stdout.end(jsonl('Already closed output'));child.emit('close',0,null);await Promise.all([...x.executions.pending]);
  assert.equal(x.executions.get(job.id).status,'cancelled');assert.equal(x.executions.get(job.id).cancelRequested,true);assert.equal(x.tasks.getTask(x.task.id).receipts.length,0);
}));
test('interruption blocks new spending until explicit stopped-process evidence; replacement is linked and idempotent',()=>fixture(async x=>{
  x.store.db.prepare('INSERT INTO execution_jobs VALUES(?,?,?,?)').run('uncertain',x.task.id,x.pkg.id,JSON.stringify({id:'uncertain',taskId:x.task.id,packageId:x.pkg.id,status:'interrupted',pid:123,workspace:'/synthetic'}));
  const another=await x.tasks.createTask({projectId:x.p.id,title:'Another',stage:'coding',requirement:'Check',acceptance:'Checklist'}),pkg=await x.tasks.preparePackage(another.id,{role:'primary',expectedVersion:1});
  await assert.rejects(x.executions.start(another.id,{packageId:pkg.id,expectedVersion:1}),/orphan unresolved/);
  await assert.rejects(x.executions.replace('uncertain',{reason:'retry'}),/orphan unresolved/);
  await assert.rejects(x.executions.resolveInterruption('uncertain',{confirmedStopped:true,evidence:''}),/recovery invalid/);
  await x.executions.resolveInterruption('uncertain',{confirmedStopped:true,evidence:'Synthetic process absent; test-only declaration'});
  const replacement=await x.executions.replace('uncertain',{reason:'Synthetic crash recovered'});assert.ok(replacement.replacementTaskId);assert.equal(x.tasks.getTask(replacement.replacementTaskId).status,'draft');assert.equal(x.calls.length,0);
  assert.equal((await x.executions.replace('uncertain',{reason:'Retry request'})).replacementTaskId,replacement.replacementTaskId);assert.equal(x.tasks.listTasks().length,3);
}));
test('artifact-mode execution binds exact stdin, outputs files and still does not pass acceptance',()=>fixture(async x=>{
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1,outputFormat:'collab-artifacts/v1'}),child=await x.wait();
  const state=x.executions.get(job.id);assert.match(state.prompt,/collab-artifacts\/v1/);assert.ok(state.executionInputHash);assert.equal(readFileSync(join(state.workspace,'task-package.md'),'utf8'),x.pkg.markdown);assert.equal(readFileSync(join(state.workspace,'execution-input.txt'),'utf8'),state.prompt);
  child.stdout.end(jsonl(JSON.stringify({format:'collab-artifacts/v1',files:[{path:'src/test.js',content:'export const n=1;\n'}]})));child.emit('close',0,null);await Promise.all([...x.executions.pending]);
  const done=x.executions.get(job.id),bundle=artifactForTask(x.tasks,x.task.id,done.receiptId);assert.equal(bundle.files.length,1);assert.equal(x.tasks.getTask(x.task.id).status,'result_received');assert.equal(x.calls.length,1);
  assert.equal(done.executionInputVerified,true);await assert.rejects(x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1,outputFormat:'text'}),/format conflict/);assert.equal(x.calls.length,1);
}));
test('changed execution prompt fails byte-hash check before any child process is spawned',()=>fixture(async x=>{
  const job=await x.executions.start(x.task.id,{packageId:x.pkg.id,expectedVersion:1});x.executions.save({...x.executions.get(job.id),prompt:'Changed after queue'});await Promise.all([...x.executions.pending]);
  assert.equal(x.executions.get(job.id).status,'failed');assert.equal(x.executions.get(job.id).reason,'execution_input_mismatch');assert.equal(x.calls.length,0);assert.equal(x.tasks.getTask(x.task.id).receipts.length,0);
}));
