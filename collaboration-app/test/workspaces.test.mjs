import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { TaskStore } from '../lib/tasks.mjs';
import { ReviewStore } from '../lib/reviews.mjs';
import { GateStore } from '../lib/gates.mjs';
import { UserConsole } from '../lib/console.mjs';
import { WorkspaceStore } from '../lib/workspaces.mjs';
async function fixture(run,options={}){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'collab-workspace-test-'))),root=join(dir,'source');mkdirSync(root);mkdirSync(join(root,'src'));writeFileSync(join(root,'src/a.mjs'),'export const a=1;\n');
  const store=new Store(join(dir,'data')),tasks=new TaskStore(store),reviews=new ReviewStore(store,tasks),gates=new GateStore(store,tasks,reviews),user=new UserConsole(store,tasks,reviews,gates),workspaces=new WorkspaceStore(store,tasks,user,options);
  const p=await store.importConfig(JSON.stringify({schemaVersion:'1.0',fields:{projectName:'Synthetic workspace',workspace:root},platforms:[],skills:[],models:[{id:'p',platform:'Exec',name:'Model'},{id:'a',platform:'Review',name:'A'},{id:'b',platform:'Review',name:'B'}],stages:[{id:'coding',primary:'p',reviewerA:'a',reviewerB:'b'}]}));
  const task=await tasks.createTask({projectId:p.id,title:'Synthetic candidate',stage:'coding',requirement:'Return a module',acceptance:'Candidate syntax only'});user.capture(task);
  const pkg=await tasks.preparePackage(task.id,{role:'primary',expectedVersion:1});await tasks.confirmHandoff(task.id,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'Model',evidence:'Synthetic',confirmed:true});
  const add=files=>tasks.importResult(task.id,{packageId:pkg.id,raw:JSON.stringify({format:'collab-artifacts/v1',files}),actualPlatform:'Exec',actualModel:'Model',sourceEvidence:'Synthetic test output'});
  const receipt=await add([{path:'src/a.mjs',content:'export const a=2;\n'},{path:'src/new.mjs',content:'export const b=3;\n'}]);
  try{await run({dir,root,store,tasks,reviews,user,workspaces,p,task,pkg,receipt,add});}finally{await workspaces.shutdown();store.close();rmSync(dir,{recursive:true,force:true});}
}
test('source snapshot and isolated candidate preserve original files, hashes and deduplicate identical baselines',()=>fixture(async x=>{
  const c=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1});assert.equal(c.fresh,true);assert.equal(readFileSync(join(x.root,'src/a.mjs'),'utf8'),'export const a=1;\n');assert.equal(readFileSync(join(c.directory,'candidate/src/a.mjs'),'utf8'),'export const a=2;\n');assert.equal(c.baselineFiles[1].exists,false);assert.equal((await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1})).duplicate,true);
  const detail=x.workspaces.detail(c.id);assert.equal(detail.comparison.scope,'frozen-source-files-to-candidate');assert.match(detail.comparison.patch,/-export const a=1/);assert.equal(x.tasks.getTask(x.task.id).status,'result_received');
  const backup=await x.store.createBackup('workspace-test');assert.equal((await x.store.verifyBackup(backup.id)).ok,true);
}));
test('real Node syntax check parses but never executes candidate code',()=>fixture(async x=>{
  const candidate=await x.add([{path:'src/a.mjs',content:'throw new Error("MUST NOT EXECUTE");\nexport const x=2;\n'},{path:'note.md',content:'Not a runnable test'}]);await x.tasks.resolveResult(x.task.id,{receiptId:candidate.id,reason:'Synthetic selection'});
  const c=await x.workspaces.prepare(x.task.id,{receiptId:candidate.id,expectedVersion:1}),v=await x.workspaces.validate(c.id);assert.equal(v.status,'syntax_passed');assert.equal(v.skipped[0],'note.md');assert.equal(v.checks.length,1);assert.equal(x.tasks.getTask(x.task.id).status,'result_received');
}));
test('source or staged file edits make a snapshot stale and block validation',()=>fixture(async x=>{
  const c=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1});writeFileSync(join(x.root,'src/a.mjs'),'export const changed=1;');assert.equal(x.workspaces.detail(c.id).reason,'source_changed');await assert.rejects(x.workspaces.validate(c.id),/basis stale/);
  writeFileSync(join(x.root,'src/a.mjs'),'export const a=1;\n');writeFileSync(join(c.directory,'candidate/src/a.mjs'),'changed');assert.equal(x.workspaces.detail(c.id).reason,'candidate_changed');
}));
test('symlinks and protected source paths never enter a snapshot',()=>fixture(async x=>{
  rmSync(join(x.root,'src/a.mjs'));symlinkSync('/etc/hosts',join(x.root,'src/a.mjs'));await assert.rejects(x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1}),/unsafe path/);assert.equal(x.workspaces.list().length,0);
  const receipt=await x.add([{path:'.env.json',content:'{}'}]);await x.tasks.resolveResult(x.task.id,{receiptId:receipt.id,reason:'Synthetic protected fixture'});await assert.rejects(x.workspaces.prepare(x.task.id,{receiptId:receipt.id,expectedVersion:1}),/protected path/);
}));
test('syntax failures are recorded and validation retries append history without approving',()=>fixture(async x=>{
  const receipt=await x.add([{path:'src/a.mjs',content:'export const = ;'}]);await x.tasks.resolveResult(x.task.id,{receiptId:receipt.id,reason:'Synthetic invalid syntax'});const c=await x.workspaces.prepare(x.task.id,{receiptId:receipt.id,expectedVersion:1});assert.equal((await x.workspaces.validate(c.id)).status,'failed');assert.equal((await x.workspaces.validate(c.id)).status,'failed');assert.equal(x.workspaces.validations(c.id).length,2);assert.deepEqual(x.workspaces.policyReasons(x.tasks.getTask(x.task.id)),['workspace_validation_incomplete']);
}));
test('pause or direction change during validation prevents a passing result',()=>fixture(async x=>{
  const c=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1});x.workspaces.checkSyntax=async()=>{await x.user.control(x.p.id,{action:'pause',expectedRevision:0});return {ok:true,output:''};};const v=await x.workspaces.validate(c.id);assert.equal(v.status,'blocked');await assert.rejects(x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1}),/project_paused/);
}));
test('UTF-8 BOM remains byte-exact in captured source and baseline copy',()=>fixture(async x=>{
  const original='\ufeffexport const a=1;\n';writeFileSync(join(x.root,'src/a.mjs'),original);const c=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1});assert.equal(readFileSync(join(c.directory,'baseline/src/a.mjs'),'utf8'),original);assert.equal(c.fresh,true);
}));
test('workspace basis binds review, changes stale old rounds and blocks new packets',()=>fixture(async x=>{
  x.reviews.workspaceBasis=t=>x.workspaces.reviewBasis(t);x.reviews.workspacePolicyReasons=t=>x.workspaces.policyReasons(t);x.reviews.workspaceAppendix=t=>x.workspaces.reviewAppendix(t);
  const before=await x.reviews.openRound(x.task.id,{expectedVersion:1}),c=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1});assert.equal(x.reviews.getRound(before.id).stale,true);await assert.rejects(x.reviews.openRound(x.task.id,{expectedVersion:1}),/validation required/);
  await x.workspaces.validate(c.id);const round=await x.reviews.openRound(x.task.id,{expectedVersion:1}),packet=x.reviews.prepareReviewPacket(round.id,{slot:'reviewerA'});assert.ok(packet.markdown.includes(c.baselineHash));assert.match(packet.markdown,/export const a=1/);
  writeFileSync(join(x.root,'src/a.mjs'),'export const a=9;');assert.equal(x.reviews.getRound(round.id).stale,true);assert.throws(()=>x.reviews.prepareReviewPacket(round.id,{slot:'reviewerA'}),/validation required/);
}));
test('lost materialization can be rebuilt with a new audited candidate instead of returning a stale duplicate',()=>fixture(async x=>{
  const original=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1});rmSync(original.directory,{recursive:true,force:true});const rebuilt=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1});assert.notEqual(rebuilt.id,original.id);assert.equal(rebuilt.fresh,true);assert.equal(x.workspaces.list().length,2);
}));
test('hidden credential locations and home roots are excluded before source capture',()=>fixture(async x=>{
  for(const path of ['.docker/config.json','.config/gh/hosts.yml','.kube/config.json']){const r=await x.add([{path,content:'Synthetic credential fixture'}]);await x.tasks.resolveResult(x.task.id,{receiptId:r.id,reason:'Synthetic protected path test'});await assert.rejects(x.workspaces.prepare(x.task.id,{receiptId:r.id,expectedVersion:1}),/protected path/);}
  const {homedir}=await import('node:os');const get=x.store.getProject.bind(x.store);x.store.getProject=id=>{const p=get(id);return {...p,config:{...p.config,fields:{...p.config.fields,workspace:homedir()}}};};assert.throws(()=>x.workspaces.configuredRoot(x.tasks.mustTask(x.task.id)),/concrete root required/);
}));
test('failed final persistence becomes interrupted and retry can recover without restarting the service',()=>fixture(async x=>{
  const c=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1}),write=x.tasks.write.bind(x.tasks);x.tasks.write=(event,...args)=>event==='workspace_validation_finished'?Promise.reject(Error('Injected finish failure')):write(event,...args);
  await assert.rejects(x.workspaces.validate(c.id),/Injected/);assert.equal(x.workspaces.validations(c.id).at(-1).status,'interrupted');x.tasks.write=write;assert.equal((await x.workspaces.validate(c.id)).status,'syntax_passed');assert.equal(x.workspaces.validations(c.id).length,2);
}));
test('persistent storage failure is visible as memory-only interrupted and does not leave the UI locked',()=>fixture(async x=>{
  const c=await x.workspaces.prepare(x.task.id,{receiptId:x.receipt.id,expectedVersion:1}),write=x.tasks.write.bind(x.tasks),log=console.error,logs=[];console.error=(...a)=>logs.push(a);
  try{x.tasks.write=(event,...args)=>['workspace_validation_finished','workspace_validation_interrupted'].includes(event)?Promise.reject(Error('Injected unavailable storage')):write(event,...args);await assert.rejects(x.workspaces.validate(c.id),/Injected/);const last=x.workspaces.validations(c.id).at(-1);assert.equal(last.status,'interrupted');assert.match(last.persistence,/memory-only/);assert.equal(logs.length,1);x.tasks.write=write;assert.equal((await x.workspaces.validate(c.id)).status,'syntax_passed');}finally{console.error=log;x.tasks.write=write;}
}));
test('uppercase CJS uses CommonJS syntax rules instead of accepting module-only top-level await',()=>fixture(async x=>{
  const r=await x.add([{path:'src/upper.CJS',content:'await Promise.resolve();\n'}]);await x.tasks.resolveResult(x.task.id,{receiptId:r.id,reason:'Synthetic CJS fixture'});const c=await x.workspaces.prepare(x.task.id,{receiptId:r.id,expectedVersion:1});assert.equal((await x.workspaces.validate(c.id)).status,'failed');
}));
test('PWA manifest and SVG are preserved as inert snapshot text, not executed or validated as JS',()=>fixture(async x=>{
 const files=[{path:'manifest.webmanifest',content:'{"name":"Test"}'},{path:'icon.svg',content:'<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>'}];
 for(const f of files)writeFileSync(join(x.root,f.path),f.content);
 const r=await x.add(files);await x.tasks.resolveResult(x.task.id,{receiptId:r.id,reason:'Synthetic PWA files'});const c=await x.workspaces.prepare(x.task.id,{receiptId:r.id,expectedVersion:1});for(const f of files)assert.equal(readFileSync(join(c.directory,'candidate',f.path),'utf8'),f.content);
 const v=await x.workspaces.validate(c.id);assert.ok(v.skipped.includes('icon.svg'));assert.ok(v.skipped.includes('manifest.webmanifest'));assert.equal(v.checks.length,0);
}));
