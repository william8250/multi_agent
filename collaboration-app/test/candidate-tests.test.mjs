import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../lib/store.mjs';
import {TaskStore} from '../lib/tasks.mjs';
import {ReviewStore} from '../lib/reviews.mjs';
import {GateStore} from '../lib/gates.mjs';
import {UserConsole} from '../lib/console.mjs';
import {WorkspaceStore} from '../lib/workspaces.mjs';
import {CandidateTests} from '../lib/candidate-tests.mjs';
const passed={ok:true,exitCode:0,reportedTests:1,output:'Synthetic runner output'};
async function fixture(fn,options={}){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'collab-candidate-tests-'))),root=join(dir,'source');mkdirSync(root);writeFileSync(join(root,'module.mjs'),'export const n=1;');
  const store=new Store(join(dir,'data')),tasks=new TaskStore(store),reviews=new ReviewStore(store,tasks),gates=new GateStore(store,tasks,reviews),user=new UserConsole(store,tasks,reviews,gates),workspaces=new WorkspaceStore(store,tasks,user),tests=new CandidateTests(store,tasks,user,workspaces,options);workspaces.tests=tests;
  reviews.workspaceBasis=t=>workspaces.reviewBasis(t);reviews.workspacePolicyReasons=t=>workspaces.policyReasons(t);reviews.workspaceAppendix=t=>workspaces.reviewAppendix(t);
  const project=await store.importConfig(JSON.stringify({schemaVersion:'1.0',fields:{projectName:'Synthetic functional test fixture',workspace:root},platforms:[],skills:[],models:[{id:'p',platform:'Exec',name:'M'},{id:'a',platform:'Review',name:'A'},{id:'b',platform:'Review',name:'B'}],stages:[{id:'coding',primary:'p',reviewerA:'a',reviewerB:'b'}]}));
  const task=await tasks.createTask({projectId:project.id,title:'Synthetic candidate',stage:'coding',requirement:'Return n=2',acceptance:'Unit test n=2'});user.capture(task);
  const pkg=await tasks.preparePackage(task.id,{role:'primary',expectedVersion:1});await tasks.confirmHandoff(task.id,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'M',evidence:'Synthetic fixture',confirmed:true});
  const receipt=await tasks.importResult(task.id,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'M',sourceEvidence:'Synthetic fixture, not a model run',raw:JSON.stringify({format:'collab-artifacts/v1',files:[{path:'module.mjs',content:'export const n=2;'},{path:'module.test.mjs',content:'import test from "node:test";import assert from "node:assert/strict";import {n} from "./module.mjs";test("n is 2",()=>assert.equal(n,2));'}]})});
  const c=await workspaces.prepare(task.id,{receiptId:receipt.id,expectedVersion:1});await workspaces.validate(c.id);
  const admission={inspected:true,inspector:'Synthetic inspector',evidence:'Synthetic inspection declaration; full fixture is visible in test source',bundleHash:c.bundleHash,baselineHash:c.baselineHash};
  const finish=async r=>{await tests.running.get(r.id);return tests.get(r.id);};
  try{await fn({dir,root,store,tasks,reviews,user,workspaces,tests,project,task,c,admission,finish});}finally{await tests.shutdown();await workspaces.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
}
test('real inspected candidate tests persist logs and basis, leave source unchanged and enter review packet',()=>fixture(async x=>{
  assert.deepEqual(x.workspaces.policyReasons(x.tasks.mustTask(x.task.id)),['workspace_functional_tests_missing']);
  const r=await x.finish(await x.tests.start(x.c.id,x.admission));assert.equal(r.status,'command_passed',JSON.stringify(r));assert.equal(r.result.reportedTests,1);assert.match(r.result.output,/n is 2/);assert.equal(typeof r.pid,'number');assert.equal(r.bundleHash,x.c.bundleHash);assert.equal(readFileSync(join(x.root,'module.mjs'),'utf8'),'export const n=1;');assert.equal(readFileSync(join(r.directory,'module.mjs'),'utf8'),'export const n=2;');assert.notEqual(r.directory,join(x.c.directory,'candidate'));assert.deepEqual(x.workspaces.policyReasons(x.tasks.mustTask(x.task.id)),[]);
  const round=await x.reviews.openRound(x.task.id,{expectedVersion:1}),packet=x.reviews.prepareReviewPacket(round.id,{slot:'reviewerA'});assert.match(packet.markdown,/command_passed/);assert.match(packet.markdown,/n is 2/);assert.match(packet.markdown,/Synthetic inspector/);assert.equal(x.tasks.getTask(x.task.id).status,'result_received');
  const backup=await x.store.createBackup('candidate-test-history');assert.equal((await x.store.verifyBackup(backup.id)).ok,true);
}));
test('inspection, hash and syntax checks reject dispatch before runner',()=>fixture(async x=>{
  let calls=0;x.tests.runner=async()=>{calls++;return passed;};
  for(const args of [{...x.admission,inspected:false},{...x.admission,bundleHash:'wrong'},{...x.admission,baselineHash:'wrong'},{...x.admission,inspector:''}])await assert.rejects(x.tests.start(x.c.id,args),/inspection/);
  const v=x.workspaces.validations(x.c.id).at(-1);x.workspaces.saveValidation({...v,status:'failed'});await assert.rejects(x.tests.start(x.c.id,x.admission),/syntax/);assert.equal(calls,0);assert.equal(x.tests.list().length,0);
}));
test('failed execution remains blocking even after syntax rerun; retry changes review basis',()=>fixture(async x=>{
  const first=await x.finish(await x.tests.start(x.c.id,x.admission)),round=await x.reviews.openRound(x.task.id,{expectedVersion:1});assert.equal(first.status,'command_passed');
  x.tests.runner=async()=>({...passed,ok:false,exitCode:1});const second=await x.finish(await x.tests.start(x.c.id,x.admission));assert.equal(second.status,'command_failed');assert.equal(x.reviews.getRound(round.id).stale,true);await x.workspaces.validate(x.c.id);assert.ok(x.workspaces.policyReasons(x.tasks.mustTask(x.task.id)).includes('workspace_functional_tests_incomplete'));await assert.rejects(x.reviews.openRound(x.task.id,{expectedVersion:1}),/validation required/);
  x.tests.runner=async()=>passed;assert.equal((await x.finish(await x.tests.start(x.c.id,x.admission))).status,'command_passed');assert.equal(x.tests.list(x.c.id).length,3);
},{runner:async()=>passed}));
test('pause, cancellation and changed run inputs cannot persist a successful result',()=>fixture(async x=>{
  x.tests.runner=async()=>{await x.user.control(x.project.id,{action:'pause',expectedRevision:0});return passed;};assert.equal((await x.finish(await x.tests.start(x.c.id,x.admission))).status,'blocked');await x.user.control(x.project.id,{action:'resume',expectedRevision:1});
  let release;x.tests.runner=()=>new Promise(r=>{release=()=>r(passed);});const running=await x.tests.start(x.c.id,x.admission);await x.tests.cancel(running.id);release();assert.equal((await x.finish(running)).status,'cancelled');
  x.tests.runner=async directory=>{writeFileSync(join(directory,'extra.mjs'),'Unexpected added file');return passed;};const changed=await x.finish(await x.tests.start(x.c.id,x.admission));assert.equal(changed.status,'blocked');assert.match(changed.reason,/input changed/);
},{runner:async()=>passed}));
test('a second dispatch is rejected while one job is active',()=>fixture(async x=>{
  let release;x.tests.runner=()=>new Promise(r=>{release=r;});const r=await x.tests.start(x.c.id,x.admission);await assert.rejects(x.tests.start(x.c.id,x.admission),/busy/);release(passed);await x.finish(r);assert.equal(x.tests.list().length,1);
},{runner:async()=>passed}));
test('restart interrupts without rerunning and requires an explicit stop declaration',()=>fixture(async x=>{
  const r=await x.finish(await x.tests.start(x.c.id,x.admission));x.tests.save({...r,status:'running',finishedAt:null});let calls=0;
  const restarted=new CandidateTests(x.store,x.tasks,x.user,x.workspaces,{runner:async()=>{calls++;return passed;}});assert.equal(restarted.get(r.id).status,'interrupted');await assert.rejects(restarted.start(x.c.id,x.admission),/interruption/);assert.equal(calls,0);await restarted.resolveInterruption(r.id,{evidence:'Synthetic process never existed; injected recovery fixture'});const next=await restarted.start(x.c.id,x.admission);await restarted.running.get(next.id);assert.equal(restarted.get(next.id).status,'command_passed');await restarted.shutdown();
},{runner:async()=>passed}));
test('failed result persistence exposes interrupted memory state and blocks silent retry',()=>fixture(async x=>{
  const write=x.tasks.write.bind(x.tasks),log=console.error;console.error=()=>{};
  try{x.tasks.write=(event,...args)=>['functional_test_finished','functional_test_interrupted'].includes(event)?Promise.reject(Error('Injected disk failure')):write(event,...args);const r=await x.finish(await x.tests.start(x.c.id,x.admission));assert.equal(r.status,'interrupted');assert.match(r.persistence,/memory-only/);await assert.rejects(x.tests.start(x.c.id,x.admission),/interruption/);x.tasks.write=write;await x.tests.resolveInterruption(r.id,{evidence:'Synthetic runner returned and has no child process'});assert.equal((await x.finish(await x.tests.start(x.c.id,x.admission))).status,'command_passed');}finally{x.tasks.write=write;console.error=log;}
},{runner:async()=>passed}));
test('network profile is explicit, persisted and passed to runner; unknown profiles never dispatch',()=>fixture(async x=>{
 await assert.rejects(x.tests.start(x.c.id,{...x.admission,profile:'unrestricted'}),/profile invalid/);
 const run=await x.tests.start(x.c.id,{...x.admission,profile:'loopback-http-v1'});const done=await x.finish(run);assert.equal(done.profile,'loopback-http-v1');assert.equal(x.tests.basis(x.c).profile,'loopback-http-v1');
},{runner:async(directory,entries,options)=>{assert.equal(options.profile,'loopback-http-v1');return passed;}}));
