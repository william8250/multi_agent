import { originalConfigPath } from './config-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync, readFileSync,writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { createAppServer } from '../server.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

async function fixture(run,executionOptions={}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(),'collab-http-test-'))), store = new Store(dir), server = createAppServer(store,executionOptions);
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin=`http://127.0.0.1:${server.address().port}`;
    const token=(await (await fetch(origin+'/api/session')).json()).token;
    await run({origin,token,store,server});
  } finally { await server.shutdownExecutions();await new Promise(resolve=>server.close(resolve));store.close();rmSync(dir,{recursive:true,force:true}); }
}

test('functional test HTTP dispatch is guarded, bound and stoppable while async runner is active',async()=>{
  const source=realpathSync(mkdtempSync(path.join(os.tmpdir(),'functional-http-source-')));writeFileSync(path.join(source,'module.mjs'),'export const n=1;');let calls=0,release;
  try{await fixture(async({origin,token})=>{
    const request=async(url,body)=>{const r=await fetch(origin+url,{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
    const post=async(url,body)=>{const r=await request(url,body);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
    const get=async url=>(await fetch(origin+url)).json();
    const project=await post('/api/import',{raw:JSON.stringify({schemaVersion:'1.0',fields:{projectName:'Synthetic functional HTTP',workspace:source},platforms:[],skills:[],models:[{id:'p',platform:'Exec',name:'M'},{id:'a',platform:'Review',name:'A'},{id:'b',platform:'Review',name:'B'}],stages:[{id:'coding',primary:'p',reviewerA:'a',reviewerB:'b'}]})});
    const task=await post('/api/tasks',{projectId:project.id,title:'Functional HTTP',stage:'coding',requirement:'Candidate',acceptance:'Unit check'}),pkg=await post(`/api/tasks/${task.id}/packages`,{role:'primary',expectedVersion:1});
    await post(`/api/tasks/${task.id}/handoffs`,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'M',evidence:'Synthetic',confirmed:true});
    const receipt=await post(`/api/tasks/${task.id}/receipts`,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'M',sourceEvidence:'Synthetic, not a model call',raw:JSON.stringify({format:'collab-artifacts/v1',files:[{path:'module.mjs',content:'export const n=2;'},{path:'module.test.mjs',content:'import test from "node:test";test("synthetic",()=>{});'}]})});
    const c=await post(`/api/tasks/${task.id}/workspaces`,{receiptId:receipt.id,expectedVersion:1});await post(`/api/workspaces/${c.id}/validate`,{});
    for(let i=0;i<100;i++){if((await get(`/api/workspaces/${c.id}`)).validations.at(-1)?.status==='syntax_passed')break;await new Promise(r=>setTimeout(r,10));}
    const args={inspected:true,inspector:'Synthetic HTTP inspector',evidence:'Synthetic full fixture inspection',bundleHash:c.bundleHash,baselineHash:c.baselineHash};
    const denied=await fetch(origin+`/api/workspaces/${c.id}/tests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});assert.equal(denied.status,403);assert.equal((await request(`/api/workspaces/${c.id}/tests`,{...args,bundleHash:'wrong'})).status,400);assert.equal(calls,0);
    await post(`/api/workspaces/${c.id}/tests`,args);
    let detail;for(let i=0;i<100;i++){detail=await get(`/api/workspaces/${c.id}`);if(detail.functionalTests.at(-1)?.status!=='running')break;await new Promise(r=>setTimeout(r,10));}assert.equal(detail.functionalTests.at(-1).status,'command_passed');
    const round=await post(`/api/tasks/${task.id}/review-rounds`,{expectedVersion:1});await post(`/api/workspaces/${c.id}/tests`,args);assert.equal((await get(`/api/review-rounds/${round.id}`)).stale,true);
    const dash=await get('/api/user/dashboard');assert.equal(dash.workspaces[0].lastFunctionalTest.status,'running');assert.equal(dash.workspaces[0].functionalTests,undefined);assert.ok(dash.tasks[0].controls.includes('workspace_functional_tests_incomplete'));
    await post(`/api/user/projects/${project.id}/control`,{action:'pause',expectedRevision:0});release();
    for(let i=0;i<100;i++){detail=await get(`/api/workspaces/${c.id}`);if(detail.functionalTests.at(-1)?.status!=='running')break;await new Promise(r=>setTimeout(r,10));}assert.equal(detail.functionalTests.at(-1).status,'blocked');assert.equal(detail.functionalTests.length,2);assert.equal(readFileSync(path.join(source,'module.mjs'),'utf8'),'export const n=1;');
  },{functionalTestRunner:async()=>{calls++;if(calls>1)await new Promise(r=>{release=r;});return {ok:true,exitCode:0,reportedTests:1,output:'Synthetic runner log, not actual process output'};}});}finally{release?.();rmSync(source,{recursive:true,force:true});}
});

test('workspace HTTP guards, async pause and source edits keep review basis honest without touching the source',async()=>{
  const source=realpathSync(mkdtempSync(path.join(os.tmpdir(),'workspace-http-source-')));writeFileSync(path.join(source,'module.mjs'),'export const n=1;\n');
  let release,started=false,first=true;const blocked=new Promise(r=>{release=r;});
  try{await fixture(async({origin,token})=>{
    const request=async(url,body)=>{const r=await fetch(origin+url,{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
    const post=async(url,body)=>{const r=await request(url,body);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
    const project=await post('/api/import',{raw:JSON.stringify({schemaVersion:'1.0',fields:{projectName:'Synthetic workspace HTTP',workspace:source},platforms:[],skills:[],models:[{id:'p',platform:'Exec',name:'M'},{id:'a',platform:'Review',name:'A'},{id:'b',platform:'Review',name:'B'}],stages:[{id:'coding',primary:'p',reviewerA:'a',reviewerB:'b'}]})});
    const t=await post('/api/tasks',{projectId:project.id,title:'Workspace HTTP',stage:'coding',requirement:'Candidate file',acceptance:'Syntax only'}),pkg=await post(`/api/tasks/${t.id}/packages`,{role:'primary',expectedVersion:1});
    await post(`/api/tasks/${t.id}/handoffs`,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'M',evidence:'Synthetic',confirmed:true});
    const receipt=await post(`/api/tasks/${t.id}/receipts`,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'M',sourceEvidence:'Synthetic',raw:JSON.stringify({format:'collab-artifacts/v1',files:[{path:'module.mjs',content:'export const n=2;\n'}]})});
    const old=await post(`/api/tasks/${t.id}/review-rounds`,{expectedVersion:1});
    const denied=await fetch(origin+`/api/tasks/${t.id}/workspaces`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiptId:receipt.id,expectedVersion:1})});assert.equal(denied.status,403);
    const c=await post(`/api/tasks/${t.id}/workspaces`,{receiptId:receipt.id,expectedVersion:1});assert.equal(c.fresh,true);assert.equal(readFileSync(path.join(source,'module.mjs'),'utf8'),'export const n=1;\n');assert.equal((await request(`/api/tasks/${t.id}/review-rounds`,{expectedVersion:1})).status,400);
    await post(`/api/workspaces/${c.id}/validate`,{});assert.equal(started,true);await post(`/api/user/projects/${project.id}/control`,{action:'pause',expectedRevision:0});release();
    let detail;for(let i=0;i<50;i++){detail=await(await fetch(origin+`/api/workspaces/${c.id}`)).json();if(detail.validations.at(-1)?.status!=='running')break;await new Promise(r=>setTimeout(r,10));}assert.equal(detail.validations.at(-1).status,'blocked');
    await post(`/api/user/projects/${project.id}/control`,{action:'resume',expectedRevision:1});await post(`/api/workspaces/${c.id}/validate`,{});
    for(let i=0;i<50;i++){detail=await(await fetch(origin+`/api/workspaces/${c.id}`)).json();if(detail.validations.at(-1)?.status!=='running')break;await new Promise(r=>setTimeout(r,10));}assert.equal(detail.validations.at(-1).status,'syntax_passed');
    const round=await post(`/api/tasks/${t.id}/review-rounds`,{expectedVersion:1});assert.equal((await request(`/api/workspaces/${c.id}/applications`,{roundId:round.id})).status,400);const packet=await(await fetch(origin+`/api/review-rounds/${round.id}/packets/reviewerA`)).text();assert.ok(packet.includes(c.baselineHash));assert.match(packet,/export const n=1/);
    writeFileSync(path.join(source,'module.mjs'),'export const n=3;');assert.equal((await fetch(origin+`/api/review-rounds/${round.id}/packets/reviewerA`)).status,400);assert.equal((await(await fetch(origin+`/api/review-rounds/${old.id}`)).json()).stale,true);
    const dash=await(await fetch(origin+'/api/user/dashboard')).json();assert.ok(dash.tasks[0].controls.includes('workspace_basis_stale'));
  },{workspaceCheckSyntax:async()=>{started=true;if(first){first=false;await blocked;}return {ok:true,output:''};}});}finally{release();rmSync(source,{recursive:true,force:true});}
});

test('artifact HTTP chain exports identical independent-review ZIPs and stales them on result change',async()=>fixture(async({origin,token})=>{
  const post=async(url,body)=>{const r=await fetch(origin+url,{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();};
  const project=await post('/api/import',{raw:JSON.stringify({schemaVersion:'1.0',fields:{projectName:'Synthetic artifact HTTP',secret:'NEVER_EXPORT'},platforms:[],skills:[],models:[{id:'p',platform:'Exec',name:'Model'},{id:'a',platform:'Review',name:'A'},{id:'b',platform:'Review',name:'B'}],stages:[{id:'coding',primary:'p',reviewerA:'a',reviewerB:'b'}]})});
  const t=await post('/api/tasks',{projectId:project.id,title:'Synthetic code outputs',stage:'coding',requirement:'A test module',acceptance:'Return files'}),pkg=await post(`/api/tasks/${t.id}/packages`,{role:'primary',expectedVersion:1});
  await post(`/api/tasks/${t.id}/handoffs`,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'Model',evidence:'Synthetic test submission',confirmed:true});
  const add=files=>post(`/api/tasks/${t.id}/receipts`,{packageId:pkg.id,raw:JSON.stringify({format:'collab-artifacts/v1',files}),actualPlatform:'Exec',actualModel:'Model',sourceEvidence:'Synthetic output'});
  const first=await add([{path:'src/main.js',content:'export const n=1;\n'}]);
  const list=await(await fetch(origin+`/api/tasks/${t.id}/artifacts`)).json();assert.equal(list[0].available,true);assert.equal(list[0].files[0].content,undefined);assert.equal(list[0].sourceContentHash,first.contentHash);
  const download=await fetch(origin+`/api/tasks/${t.id}/receipts/${first.id}/artifacts/download`);assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/zip');assert.equal(Buffer.from(await download.arrayBuffer()).readUInt32LE(),0x04034b50);
  const round=await post(`/api/tasks/${t.id}/review-rounds`,{expectedVersion:1});assert.equal(round.codeArtifacts.bundleHash,list[0].bundleHash);
  const zipA=Buffer.from(await(await fetch(origin+`/api/review-rounds/${round.id}/artifacts/reviewerA`)).arrayBuffer()),zipB=Buffer.from(await(await fetch(origin+`/api/review-rounds/${round.id}/artifacts/reviewerB`)).arrayBuffer());assert.deepEqual(zipA,zipB);assert.equal(zipA.includes(Buffer.from('NEVER_EXPORT')),false);
  for(const slot of ['reviewerA','reviewerB']){const packet=await(await fetch(origin+`/api/review-rounds/${round.id}/packets/${slot}`)).text();assert.ok(packet.includes(list[0].bundleHash));assert.ok(packet.includes('src/main.js'));assert.ok(!packet.includes('NEVER_EXPORT'));}
  const second=await add([{path:'src/main.js',content:'export const n=2;\n'},{path:'readme.md',content:'candidate only\n'}]);
  const denied=await fetch(origin+`/api/tasks/${t.id}/artifacts/compare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({beforeReceiptId:first.id,afterReceiptId:second.id})});assert.equal(denied.status,403);
  const comparison=await post(`/api/tasks/${t.id}/artifacts/compare`,{beforeReceiptId:first.id,afterReceiptId:second.id});assert.equal(comparison.changes.length,2);assert.match(comparison.patch,/-export const n=1/);assert.match(comparison.patch,/\+export const n=2/);
  assert.equal((await fetch(origin+`/api/review-rounds/${round.id}/artifacts/reviewerA`)).status,400);
  await post(`/api/tasks/${t.id}/resolve`,{receiptId:second.id,reason:'Synthetic test selects updated candidate'});
  const next=await post(`/api/tasks/${t.id}/review-rounds`,{expectedVersion:1});assert.notEqual(next.codeArtifacts.bundleHash,round.codeArtifacts.bundleHash);
  assert.equal((await(await fetch(origin+`/api/tasks/${t.id}`)).json()).status,'result_received');
}));

test('managed execution HTTP start is origin guarded and real-shaped output is collected separately from acceptance',async()=>{
  let launches=0;
  await fixture(async({origin,token})=>{
    const post=async(url,body)=>{const r=await fetch(origin+url,{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
    const project=await post('/api/import',{raw:JSON.stringify({schemaVersion:'1.0',fields:{projectName:'Synthetic managed execution HTTP'},platforms:[],skills:[],models:[{id:'m',platform:'Codex',name:'GPT-6.1 Sol'}],stages:[{id:'coding',primary:'m'}]})});
    const task=await post('/api/tasks',{projectId:project.id,title:'Synthetic task',stage:'coding',requirement:'Return checks',acceptance:'A checklist'});
    const pkg=await post(`/api/tasks/${task.id}/packages`,{role:'primary',expectedVersion:1});
    const denied=await fetch(origin+`/api/tasks/${task.id}/executions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packageId:pkg.id,expectedVersion:1})});assert.equal(denied.status,403);assert.equal(launches,0);
    const job=await post(`/api/tasks/${task.id}/executions`,{packageId:pkg.id,expectedVersion:1});
    let done;for(let i=0;i<100;i++){done=await(await fetch(origin+`/api/executions/${job.id}`)).json();if(done.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(done.status,'completed');assert.equal(launches,1);assert.match(done.stdout,/turn.completed/);assert.equal(done.prompt,undefined);
    const dashboard=await(await fetch(origin+'/api/user/dashboard')).json();assert.equal(dashboard.executions[0].status,'completed');assert.equal(dashboard.executions[0].stdout,undefined);
    const result=await(await fetch(origin+`/api/tasks/${task.id}`)).json();assert.equal(result.receipts.length,1);assert.equal(result.status,'result_received');
    const duplicate=await post(`/api/tasks/${task.id}/executions`,{packageId:pkg.id,expectedVersion:1});assert.equal(duplicate.duplicate,true);assert.equal(launches,1);
  },{spawnProcess:()=>{launches++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;child.stdin.on('finish',()=>setTimeout(()=>{child.stdout.end(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic checks'}})+'\n'+JSON.stringify({type:'turn.completed'})+'\n');child.emit('close',0,null);},20));return child;}});
});

test('rejects cross-origin, missing token, DNS rebind host and executable asset paths',async()=>fixture(async({origin,token})=>{
  for(const headers of [{Origin:'https://foreign.invalid','X-Session-Token':token},{Origin:origin},{Origin:origin,'X-Session-Token':token,'Sec-Fetch-Site':'cross-site'}]){
    const response=await fetch(origin+'/api/backups',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,403);
  }
  const denied=await new Promise((resolve,reject)=>{const req=http.get(origin+'/api/session',{headers:{Host:'foreign.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);});assert.equal(denied,403);
  const missing=await fetch(origin+'/server.mjs');assert.equal(missing.status,404);
  const asset=await fetch(origin+'/');assert.equal(asset.status,200);assert.match(asset.headers.get('content-security-policy'),/frame-ancestors 'none'/);
}));

test('HTTP migration, duplicate import, original export and backup restore retain bytes',async()=>fixture(async({origin,token})=>{
  const request=(url,body)=>fetch(origin+url,{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const raw=readFileSync(originalConfigPath,'utf8');
  const response=await request('/api/import',{raw});assert.equal(response.status,200);const project=await response.json();assert.equal(project.skillCount,4);
  const duplicate=await (await request('/api/import',{raw})).json();assert.equal(duplicate.duplicate,true);assert.equal(duplicate.id,project.id);
  const exported=await fetch(origin+`/api/projects/${project.id}/export`);assert.equal(await exported.text(),raw);
  const backup=await (await request('/api/backups',{})).json();
  const verification=await (await request(`/api/backups/${backup.id}/verify`,{})).json();assert.equal(verification.ok,true);assert.equal(verification.projectCount,1);assert.equal(verification.objectCount,4);
  const audit=await (await fetch(origin+'/api/audit')).json();assert.ok(audit.every(e=>e.createdAt));assert.ok(audit.some(e=>e.event==='config_imported'));
}));

test('invalid configuration gives actionable Chinese error and leaves projects unchanged',async()=>fixture(async({origin,token})=>{
  const result=await fetch(origin+'/api/import',{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify({raw:'{ broken'})});assert.equal(result.status,400);assert.match((await result.json()).error,/重新.*导出/);
  assert.deepEqual(await (await fetch(origin+'/api/projects')).json(),[]);
}));

test('task handoff HTTP flow binds package, requires observed submission and preserves conflicts',async()=>fixture(async({origin,token})=>{
  const request=async(url,body)=>{const response=await fetch(origin+url,{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const raw=JSON.stringify({schemaVersion:'1.0',fields:{projectName:'HTTP task project',privateField:'DO_NOT_EXPORT'},platforms:[],skills:[],models:[{id:'m1',platform:'WorkBuddy',name:'Test model'}],stages:[{id:'coding',primary:'m1',support:'m1',reviewerA:'m1'}],attachments:{billing:[{name:'PRIVATE_BILL'}]}});
  const imported=await request('/api/import',{raw});
  const create=await request('/api/tasks',{projectId:imported.body.id,title:'Inspect task',stage:'coding',requirement:'Return a checklist',acceptance:'Three checks',dependencies:[]});assert.equal(create.status,200);const id=create.body.id;
  const pkg=await request(`/api/tasks/${id}/packages`,{role:'primary',expectedVersion:1});assert.equal(pkg.status,200);assert.match(pkg.body.markdown,new RegExp(pkg.body.id));assert.doesNotMatch(pkg.body.markdown,/DO_NOT_EXPORT|PRIVATE_BILL/);
  const download=await fetch(origin+`/api/tasks/${id}/packages/${pkg.body.id}/download`);assert.equal(await download.text(),pkg.body.markdown);
  const result={packageId:pkg.body.id,raw:'First output',actualPlatform:'WorkBuddy',actualModel:'Test model',sourceEvidence:'Observed reply'};
  const before=await request(`/api/tasks/${id}/receipts`,result);assert.equal(before.status,400);assert.match(before.body.error,/提交确认/);
  const handoff=await request(`/api/tasks/${id}/handoffs`,{packageId:pkg.body.id,actualPlatform:'WorkBuddy',actualModel:'Test model',evidence:'Observed submission in test',confirmed:true});assert.equal(handoff.body.status,'submitted');
  const first=await request(`/api/tasks/${id}/receipts`,result);assert.equal(first.status,200);
  const repeat=await request(`/api/tasks/${id}/receipts`,result);assert.equal(repeat.body.duplicate,true);
  await request(`/api/tasks/${id}/receipts`,{...result,raw:'Different output'});
  let task=await (await fetch(origin+`/api/tasks/${id}`)).json();assert.equal(task.status,'needs_resolution');assert.equal(task.receipts.length,2);
  await request(`/api/tasks/${id}/resolve`,{receiptId:first.body.id,reason:'Verified first against the task'});
  task=await (await fetch(origin+`/api/tasks/${id}`)).json();assert.equal(task.status,'result_received');assert.equal(task.receipts.length,2);assert.equal(task.resolutions.length,1);assert.notEqual(task.status,'valid_passed');
  const review=await request(`/api/tasks/${id}/packages`,{role:'reviewerA',expectedVersion:1});assert.equal(review.status,400);assert.match(review.body.error,/独立评审/);
  const pass=await request(`/api/tasks/${id}/pass`,{});assert.equal(pass.status,404);
}));

test('review HTTP views seal single opinion and preserve manual decisions without passing task',async()=>fixture(async({origin,token})=>{
  const request=async(url,body)=>{const response=await fetch(origin+url,{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const config={schemaVersion:'1.0',fields:{projectName:'Review HTTP'},platforms:[],skills:[],models:[{id:'executor',platform:'Executor',name:'Model'},{id:'a',platform:'Review-A',name:'Model-A'},{id:'b',platform:'Review-B',name:'Model-B'}],stages:[{id:'coding',primary:'executor',reviewerA:'a',reviewerB:'b'}]};
  const project=(await request('/api/import',{raw:JSON.stringify(config)})).body;
  const task=(await request('/api/tasks',{projectId:project.id,title:'Review target',stage:'coding',requirement:'Persist data',acceptance:'Restorable',dependencies:[]})).body;
  const pkg=(await request(`/api/tasks/${task.id}/packages`,{role:'primary',expectedVersion:1})).body;
  await request(`/api/tasks/${task.id}/handoffs`,{packageId:pkg.id,actualPlatform:'Executor',actualModel:'Model',evidence:'test source',confirmed:true});
  const receipt={packageId:pkg.id,raw:'Test artifact',actualPlatform:'Executor',actualModel:'Model',sourceEvidence:'test result'};await request(`/api/tasks/${task.id}/receipts`,receipt);
  const round=(await request(`/api/tasks/${task.id}/review-rounds`,{expectedVersion:1})).body;
  const a={slot:'reviewerA',actualPlatform:'Review-A',actualModel:'Model-A',sourceEvidence:'test opinion A',independentConfirmed:true,raw:'SEALED_OPINION_A',conclusion:'Needs changes',items:[{topic:'Storage',position:'change',severity:'major',detail:'Recovery is unclear',suggestion:'Test recovery'}]};
  const ack=await request(`/api/review-rounds/${round.id}/submissions`,a);assert.equal(ack.status,200);assert.equal(ack.body.ready,false);assert.doesNotMatch(JSON.stringify(ack.body),/SEALED_OPINION_A/);
  let view=await (await fetch(origin+`/api/review-rounds/${round.id}`)).json();assert.equal(view.ready,false);assert.equal(view.reviews,undefined);assert.doesNotMatch(JSON.stringify(view),/SEALED_OPINION_A/);
  const packet=await (await fetch(origin+`/api/review-rounds/${round.id}/packets/reviewerB`)).text();assert.doesNotMatch(packet,/SEALED_OPINION_A/);assert.match(packet,/Test artifact/);
  const early=await request(`/api/review-rounds/${round.id}/comments`,{actor:'human',text:'Too early',sourceEvidence:'test'});assert.equal(early.status,400);
  await request(`/api/review-rounds/${round.id}/submissions`,{...a,slot:'reviewerB',actualPlatform:'Review-B',actualModel:'Model-B',raw:'SEALED_OPINION_B',items:[{...a.items[0],position:'agree'}]});
  view=await (await fetch(origin+`/api/review-rounds/${round.id}`)).json();assert.equal(view.ready,true);assert.equal(view.groups[0].classification,'different');assert.match(JSON.stringify(view),/SEALED_OPINION_A/);
  const decision=await request(`/api/review-rounds/${round.id}/decisions`,{groupId:view.groups[0].id,action:'clarify',reason:'Ask both for recovery evidence',evidence:'test reference'});assert.equal(decision.status,200);assert.equal(decision.body.groups[0].history.length,1);
  const current=await (await fetch(origin+`/api/tasks/${task.id}`)).json();assert.equal(current.status,'result_received');
  await request(`/api/tasks/${task.id}/receipts`,{...receipt,raw:'Changed artifact'});
  view=await (await fetch(origin+`/api/review-rounds/${round.id}`)).json();assert.equal(view.stale,true);assert.equal(view.groups[0].history.length,1);
  const stale=await request(`/api/review-rounds/${round.id}/decisions`,{groupId:view.groups[0].id,action:'adopt',reason:'Invalid attempt'});assert.equal(stale.status,400);
}));

async function gateHttpFixture(origin,token,unverified=false){
 const request=async(url,body)=>{const response=await fetch(origin+url,{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()}};
 const post=async(url,body)=>{const response=await request(url,body);assert.equal(response.status,200,JSON.stringify(response.body));return response.body};
 const get=async url=>(await fetch(origin+url)).json();
 const cfg={schemaVersion:'1.0',fields:{projectName:'Synthetic gate HTTP',humanWeight:'50',aWeight:'25',bWeight:'25',passScore:'80',disagreement:'15'},platforms:[],skills:[],models:[{id:'p',platform:'Exec',name:'P'},{id:'a',platform:'Review',name:'A'},{id:'b',platform:'Review',name:'B'}],stages:[{id:'coding',primary:'p',reviewerA:'a',reviewerB:'b'}]};
 const project=await post('/api/import',{raw:JSON.stringify(cfg)}),task=await post('/api/tasks',{projectId:project.id,title:'Synthetic gate task',stage:'coding',requirement:'r',acceptance:'a'}),pkg=await post(`/api/tasks/${task.id}/packages`,{role:'primary',expectedVersion:1});
 await post(`/api/tasks/${task.id}/handoffs`,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'P',evidence:'synthetic',confirmed:true});
 const receipt={packageId:pkg.id,raw:'synthetic output',actualPlatform:'Exec',actualModel:'P',sourceEvidence:'synthetic'};await post(`/api/tasks/${task.id}/receipts`,receipt);
 const round=await post(`/api/tasks/${task.id}/review-rounds`,{expectedVersion:1});
 for(const [slot,model]of [['reviewerA','A'],['reviewerB','B']])await post(`/api/review-rounds/${round.id}/submissions`,{slot,actualPlatform:'Review',actualModel:unverified&&slot==='reviewerB'?'模式（底模未确认）':model,...(unverified&&slot==='reviewerB'?{identityVerified:false}:{}),sourceEvidence:'synthetic',independentConfirmed:true,raw:`synthetic ${slot}`,conclusion:'test',items:[{topic:'scope',position:'change',severity:'blocker',detail:'test',suggestion:'fix'}]});
 const gatePath=`/api/review-rounds/${round.id}/gate`;
 const mutate=async(action,body)=>post(gatePath+'/'+action,{...body,expectedRevision:(await get(gatePath)).revision});
 return {request,post,get,mutate,gatePath,task,pkg,round,receipt,project};
}
test('HTTP gate approves only with selected scores and evidence; review and execution changes invalidate downstream',async()=>fixture(async({origin,token})=>{
 const x=await gateHttpFixture(origin,token);let gate=await x.get(x.gatePath);
 assert.equal((await x.request(x.gatePath+'/decisions',{action:'approve',reason:'test',expectedRevision:gate.revision})).status,400);
 assert.equal((await x.request(x.gatePath+'/scores',{source:'human',value:'80',evidence:'test'})).status,400);
 for(const source of ['human','reviewerA','reviewerB']){const score=await x.mutate('scores',{source,value:'80',evidence:'synthetic only'});await x.mutate('selection',{source,revisionId:score.id});}
 const r=await x.get(`/api/review-rounds/${x.round.id}`),groupId=r.groups[0].id;
 await x.post(`/api/review-rounds/${x.round.id}/decisions`,{groupId,action:'adopt',reason:'synthetic fix'});
 await x.mutate('resolutions',{groupId,evidence:'fixed',reviewerPlatform:'Review',reviewerModel:'A',reviewEvidence:'independently checked',fixActorPlatform:'Exec',fixActorModel:'P',verifierIdentityVerified:true});
 for(const source of ['reviewerA','reviewerB'])await x.mutate('cross',{actor:'human',source,evidence:'synthetic cross'});
 gate=await x.get(x.gatePath);assert.equal(gate.canApprove,true);assert.equal(gate.calculation.weighted,'80.000000');
 await x.mutate('decisions',{action:'approve',reason:'synthetic only approval'});assert.equal((await x.get(`/api/tasks/${x.task.id}`)).status,'valid_passed');
 const child=await x.post('/api/tasks',{projectId:x.project.id,title:'downstream',stage:'coding',requirement:'r',acceptance:'a',dependencies:[x.task.id]});
 await x.post(`/api/review-rounds/${x.round.id}/comments`,{actor:'human',text:'new issue',sourceEvidence:'synthetic'});
 assert.equal((await x.get(`/api/tasks/${x.task.id}`)).status,'result_received');assert.equal((await x.get(x.gatePath)).currentDecision,null);
 assert.equal((await x.request(`/api/tasks/${child.id}/packages`,{role:'primary',expectedVersion:1})).status,400);
 assert.equal((await x.request(x.gatePath+'/decisions',{action:'approve',reason:'premature',expectedRevision:(await x.get(x.gatePath)).revision})).status,400);
 await x.mutate('resolutions',{groupId,evidence:'rechecked after new opinion',reviewerPlatform:'Review',reviewerModel:'A',reviewEvidence:'independently checked',fixActorPlatform:'Exec',fixActorModel:'P',verifierIdentityVerified:true});
 for(const source of ['reviewerA','reviewerB'])await x.mutate('cross',{actor:'human',source,evidence:'renewed synthetic cross'});
 await x.mutate('decisions',{action:'approve',reason:'synthetic renewed approval'});
 await x.post(`/api/tasks/${x.task.id}/receipts`,{...x.receipt,raw:'different output'});
 assert.equal((await x.get(x.gatePath)).canApprove,false);assert.equal((await x.get(x.gatePath)).currentDecision,null);
 const backups=await x.get('/api/backups');assert.ok(backups.some(b=>b.reason==='before-gate-approval'));
}));
test('HTTP unverified opinions can be compared but cannot supply an effective reviewer score',async()=>fixture(async({origin,token})=>{
 const x=await gateHttpFixture(origin,token,true),r=await x.get(`/api/review-rounds/${x.round.id}`);assert.equal(r.ready,true);assert.equal(r.identitiesVerified,false);assert.equal(r.groups.length,1);
 const gate=await x.get(x.gatePath);assert.ok(gate.reasons.includes('reviewer_identity_unverified'));
 const denied=await x.request(x.gatePath+'/scores',{source:'reviewerB',value:'90',evidence:'unverified',expectedRevision:gate.revision});assert.equal(denied.status,400);assert.match(denied.body.error,/实际模型尚未核验/);
}));

test('dual-mode HTTP controls block new dispatch but preserve incoming results; goal changes stale existing reviews',async()=>fixture(async({origin,token})=>{
 const x=await gateHttpFixture(origin,token);
 const initial=await x.get('/api/user/dashboard');assert.equal(initial.dispatchMode,'coordinator-handoff');assert.equal(initial.projects[0].control.paused,false);
 await x.post(`/api/user/projects/${x.project.id}/control`,{action:'pause',expectedRevision:0});
 const packageDenied=await x.request(`/api/tasks/${x.task.id}/packages`,{role:'primary',expectedVersion:1});assert.equal(packageDenied.status,400);assert.match(packageDenied.body.error,/已暂停/);
 const handoffDenied=await x.request(`/api/tasks/${x.task.id}/handoffs`,{packageId:x.pkg.id,actualPlatform:'Exec',actualModel:'P',evidence:'retry',confirmed:true});assert.equal(handoffDenied.status,400);
 // Collecting an already-running result is allowed while dispatch is paused.
 const duplicate=await x.post(`/api/tasks/${x.task.id}/receipts`,x.receipt);assert.equal(duplicate.duplicate,true);
 const pausedGate=await x.get(x.gatePath);assert.ok(pausedGate.reasons.includes('project_paused'));assert.equal(pausedGate.canApprove,false);
 await x.post(`/api/user/projects/${x.project.id}/control`,{action:'resume',expectedRevision:1});
 const correction=await x.post('/api/user/requests',{projectId:x.project.id,kind:'correction',body:'New user direction',requestKey:'http-correction',expectedRevision:2});
 assert.equal((await x.get(`/api/review-rounds/${x.round.id}`)).stale,true);
 assert.equal((await x.request(`/api/user/projects/${x.project.id}/control`,{action:'resume',expectedRevision:3})).status,400);
 await x.post(`/api/user/requests/${correction.id}/ack`,{platform:'Coordinator',model:'Declared actor',evidence:'observed',plan:'Replan into new tasks'});
 await x.post(`/api/user/projects/${x.project.id}/control`,{action:'resume',expectedRevision:3});
 assert.equal((await x.request(`/api/tasks/${x.task.id}/packages`,{role:'primary',expectedVersion:1})).status,400);
 const fresh=await x.post('/api/tasks',{projectId:x.project.id,title:'New epoch task',stage:'coding',requirement:'new',acceptance:'new'});assert.equal((await x.request(`/api/tasks/${fresh.id}/packages`,{role:'primary',expectedVersion:1})).status,200);
 const before=await x.get('/api/user/dashboard');assert.equal(before.requests[0].body,'New user direction');assert.equal(before.requests[0].status,'acknowledged');
 const rejected=await fetch(origin+'/api/user/requests',{method:'POST',headers:{Origin:'https://foreign.invalid','X-Session-Token':token,'Content-Type':'application/json'},body:JSON.stringify({body:'evil',requestKey:'evil'})});assert.equal(rejected.status,403);
}));

test('late in-flight registration preserves results during a direction hold without allowing new dispatch',async()=>fixture(async({origin,token,store})=>{
 const x=await gateHttpFixture(origin,token);store.db.prepare("UPDATE tasks SET status='valid_passed' WHERE id=?").run(x.task.id);
 const task=await x.post('/api/tasks',{projectId:x.project.id,title:'in-flight child',stage:'coding',requirement:'r',acceptance:'a',dependencies:[x.task.id]});
 const pkg=await x.post(`/api/tasks/${task.id}/packages`,{role:'primary',expectedVersion:1});
 await x.post('/api/user/requests',{projectId:x.project.id,kind:'correction',body:'new direction',requestKey:'hold-late',expectedRevision:0});
 const handoff={packageId:pkg.id,actualPlatform:'Exec',actualModel:'P',evidence:'Synthetic submission observed before hold',confirmed:true};
 assert.equal((await x.request(`/api/tasks/${task.id}/handoffs`,handoff)).status,400);
 assert.equal((await x.request(`/api/tasks/${task.id}/handoffs`,{...handoff,inFlight:true,submittedAt:new Date(Date.now()+60000).toISOString()})).status,400);
 await x.post(`/api/tasks/${task.id}/handoffs`,{...handoff,inFlight:true,submittedAt:pkg.createdAt});
 await x.post(`/api/tasks/${task.id}/receipts`,{packageId:pkg.id,actualPlatform:'Exec',actualModel:'P',sourceEvidence:'Synthetic old direction result',raw:'preserved for history'});
 const view=await x.get(`/api/tasks/${task.id}`);assert.equal(view.receipts[0].raw,'preserved for history');assert.match(view.handoffs[0].evidence,/补登记在途提交/);
 assert.equal((await x.request(`/api/tasks/${task.id}/packages`,{role:'primary',expectedVersion:1})).status,400);
 assert.ok((await x.get('/api/user/dashboard')).tasks.find(t=>t.id===task.id).controls.includes('goal_changed'));
}));
test('dashboard verifies shared object health once even with multiple review rounds',async()=>fixture(async({origin,token,store})=>{
 const first=await gateHttpFixture(origin,token);await gateHttpFixture(origin,token);let reads=0;const health=store.health.bind(store);store.health=()=>{reads++;return health()};const dashboard=await first.get('/api/user/dashboard');assert.equal(dashboard.tasks.length,2);assert.equal(reads,1);
}));

test('direct configuration save is origin guarded and old tasks stay bound to old config; pause blocks revision',async()=>fixture(async({origin,token,store})=>{
 const headers={'Content-Type':'application/json',Origin:origin,'X-Session-Token':token};
 const post=async(url,data)=>{const r=await fetch(origin+url,{method:'POST',headers,body:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
 const raw=readFileSync(originalConfigPath,'utf8'),a=(await post('/api/configuration/save',{raw})).data;
 const info=await (await fetch(origin+`/api/projects/${a.id}/configuration`)).json();assert.equal(info.version,1);
 const cfg=JSON.parse(raw);cfg.fields.preferencesText='New preference';
 const denied=await fetch(origin+'/api/configuration/save',{method:'POST',headers:{...headers,Origin:'http://127.0.0.1:8765'},body:JSON.stringify({raw})});assert.equal(denied.status,403);
 await post(`/api/user/projects/${a.id}/control`,{action:'pause',expectedRevision:0});
 const revision={raw:JSON.stringify(cfg),baseProjectId:a.id,expectedHash:info.sourceHash};assert.equal((await post('/api/configuration/save',revision)).status,400);
 await post(`/api/user/projects/${a.id}/control`,{action:'resume',expectedRevision:1});
 const tasksModule=await import('../lib/tasks.mjs');const tasks=new tasksModule.TaskStore(store);const task=await tasks.createTask({projectId:a.id,stage:cfg.stages[0].id,title:'Old task',requirement:'Old basis',acceptance:'Retained',dependencies:[]});
 const b=await post('/api/configuration/save',revision);assert.equal(b.status,200);assert.equal(b.data.version,2);assert.equal(tasks.getTask(task.id).projectId,a.id);assert.equal(store.getProject(a.id).raw,raw);assert.equal((await post('/api/configuration/save',revision)).status,400);
 const next=await (await fetch(origin+`/api/projects/${b.data.id}/configuration`)).json();assert.equal(next.history.length,2);assert.equal(next.config.fields.preferencesText,'New preference');
 assert.equal((await fetch(origin+'/intake')).status,200);assert.equal((await fetch(origin+'/intake?project='+a.id)).status,200);assert.equal((await fetch(origin+'/?project='+a.id)).status,200);assert.equal((await fetch(origin+'/api/projects?project='+a.id)).status,400);assert.equal((await fetch(origin+'/intake?project='+a.id+'&project='+a.id)).status,400);assert.equal((await fetch(origin+'/direct-config.js')).status,200);
}));

test('linked plan HTTP flow keeps approval, preparation and actual result collection distinct',async()=>fixture(async({origin,token})=>{
 const headers={Origin:origin,'Content-Type':'application/json','X-Session-Token':token};const post=async(path,body)=>{const r=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const cfg={schemaVersion:'1.0',fields:{projectName:'Synthetic HTTP plan'},skills:[],platforms:[],models:[{id:'p',platform:'Synthetic executor',name:'P'}],stages:[{id:'coding',primary:'p'}]};
 const project=(await post('/api/import',{raw:JSON.stringify(cfg)})).data,idea=(await post('/api/user/requests',{projectId:project.id,body:'Synthetic booking idea',requestKey:'plan-http'})).data;
 const args={requestId:idea.id,projectId:project.id,expectedEpoch:0,requiresDecision:true,decisionReason:'Synthetic scope decision',summary:'A simple booking',scope:'Booking form',outOfScope:'Payment',acceptance:'Can submit',risks:'Synthetic, no external calls',platform:'Synthetic coordinator',model:'Actor',evidence:'Synthetic HTTP test',steps:[{key:'first',stage:'coding',title:'Build',requirement:'Make form',acceptance:'Visible fields',dependencies:[]}]};
 assert.equal((await fetch(origin+'/api/plans',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body:JSON.stringify(args)})).status,403);
 const published=await post('/api/plans',args);assert.equal(published.status,200);assert.equal((await post('/api/plans',args)).data.id,published.data.id);
 let dashboard=await(await fetch(origin+'/api/user/dashboard')).json();assert.equal(dashboard.tasks.length,0);assert.equal(dashboard.plans.length,1);
 const answer={action:'confirm',reply:'',expectedRevision:0,expectedControlRevision:0};const confirmed=await post(`/api/plans/${published.data.id}/answer`,answer);assert.equal(confirmed.status,200);const task=confirmed.data.tasks[0];assert.equal((await post(`/api/plans/${published.data.id}/answer`,answer)).data.duplicate,true);
 const prepared=await post(`/api/plans/${published.data.id}/prepare`,{taskId:task.taskId,expectedVersion:1});assert.equal(prepared.status,200);assert.equal((await fetch(origin+`/api/tasks/${task.taskId}/packages/${prepared.data.id}/download`)).status,200);dashboard=await(await fetch(origin+'/api/user/dashboard')).json();assert.equal(dashboard.plans[0].tasks[0].handoffs,0);assert.equal(dashboard.tasks[0].status,'ready');
 assert.equal((await post(`/api/tasks/${task.taskId}/handoffs`,{packageId:prepared.data.id,actualPlatform:'Synthetic executor',actualModel:'P',evidence:'Explicit isolated simulation',confirmed:true})).status,200);
 assert.equal((await post(`/api/tasks/${task.taskId}/receipts`,{packageId:prepared.data.id,raw:'Synthetic result, not a real platform run',actualPlatform:'Synthetic executor',actualModel:'P',sourceEvidence:'Explicit isolated simulation'})).status,200);
 dashboard=await(await fetch(origin+'/api/user/dashboard')).json();assert.equal(dashboard.plans[0].tasks[0].receipts,1);assert.equal(dashboard.tasks[0].status,'result_received');assert.equal(dashboard.plans[0].payload.request.body,'Synthetic booking idea');
}));

test('WorkBuddy OAuth HTTP endpoints remain local and session protected without configuration',async()=>{
 await fixture(async({origin,token})=>{
  const status=await fetch(origin+'/api/platforms/workbuddy/status');assert.equal(status.status,200);const s=await status.json();assert.equal(s.automaticExecution,false);assert.equal(s.tokenStorage,'server-memory-until-restart');assert.equal('secret' in s,false);
  const denied=await fetch(origin+'/api/platforms/workbuddy/authorize',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
  const invalid=await fetch(origin+'/api/platforms/workbuddy/callback?state=bad&code=bad');assert.equal(invalid.status,400);
  const disconnect=await fetch(origin+'/api/platforms/workbuddy/disconnect',{method:'POST',headers:{Origin:origin,'X-Session-Token':token,'Content-Type':'application/json'},body:'{}'});assert.equal(disconnect.status,200);assert.equal((await disconnect.json()).authorized,false);
 });
});
