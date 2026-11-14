import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../lib/store.mjs';
import {TaskStore} from '../lib/tasks.mjs';
import {ReviewStore} from '../lib/reviews.mjs';
import {GateStore} from '../lib/gates.mjs';
import {UserConsole} from '../lib/console.mjs';
import {CommentJobs} from '../lib/comment-jobs.mjs';
test('saved comments stay idle; explicit submit deduplicates and worker dispatches once with snapshot and replies',async()=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'comment-queue-')),store=new Store(dir),tasks=new TaskStore(store),reviews=new ReviewStore(store,tasks),gates=new GateStore(store,tasks,reviews),user=new UserConsole(store,tasks,reviews,gates);
 try{
 const p=await store.importConfig(JSON.stringify({schemaVersion:'1.0',fields:{projectName:'Synthetic queue'},platforms:[],skills:[],models:[{id:'m',platform:'Codex',name:'GPT-6.1 Sol'}],stages:[{id:'coding',primary:'m'}]}));
 let launches=0;const executions={list:()=>[],start:async()=>{launches++;return {id:'execution-test'}},get:()=>({status:'completed',receiptId:'test-receipt',actualModel:'synthetic'})},jobs=new CommentJobs(store,tasks,user,executions);
 const r=await user.addRequest({projectId:p.id,kind:'feedback',body:'Make heading clearer',reference:JSON.stringify({type:'page-annotation',epoch:0,page:'overview'}),requestKey:'comment'});
 await jobs.tick();assert.equal(launches,0);assert.equal(jobs.list().length,0);
 const j=await jobs.submit(r.id,{expectedEpoch:0});assert.equal((await jobs.submit(r.id,{expectedEpoch:0})).id,j.id);
 await user.replyComment(r.id,{body:'Use fewer words',platform:'用户',model:'人工输入',requestKey:'follow',expectedEpoch:0});
 assert.ok(!jobs.list()[0].input.includes('Use fewer words'));
 await jobs.tick();assert.equal(launches,1);assert.equal(jobs.list()[0].status,'running');await jobs.tick();assert.equal(jobs.list()[0].status,'completed');assert.match(user.requests()[0].replies.at(-1).body,/尚未应用/);await jobs.tick();assert.equal(launches,1);
 const next=await jobs.submit(r.id,{expectedEpoch:0});assert.notEqual(next.id,j.id);
 await user.addRequest({projectId:p.id,kind:'correction',body:'New goal',requestKey:'new-goal',expectedRevision:0});await jobs.tick();assert.equal(jobs.list().at(-1).status,'blocked');await assert.rejects(jobs.submit(r.id,{expectedEpoch:0}),/revision/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('automatic UI pipeline creates patch task, validates, applies and replies changed without human reconfirmation',async()=>{
 const {writeFileSync,readFileSync}=await import('node:fs');const {UIApplier}=await import('../lib/ui-patches.mjs');
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'comment-apply-')),store=new Store(dir),tasks=new TaskStore(store),reviews=new ReviewStore(store,tasks),gates=new GateStore(store,tasks,reviews),user=new UserConsole(store,tasks,reviews,gates);
 try{writeFileSync(join(dir,'index.html'),'<!doctype html><html><head><title>Test</title></head><body><h1 id="home">Old heading</h1></body></html>');writeFileSync(join(dir,'style.css'),'h1 {color:green}');
 const p=await store.importConfig(JSON.stringify({schemaVersion:'1.0',fields:{projectName:'Synthetic apply'},platforms:[],skills:[],models:[{id:'m',platform:'Codex',name:'GPT-6.1 Sol'}],stages:[{id:'coding',primary:'m'}]}));let receipt;
 const executions={list:()=>[],start:async(taskId,{packageId})=>{await tasks.confirmHandoff(taskId,{packageId,actualPlatform:'Codex',actualModel:'Synthetic',evidence:'Test only',confirmed:true});receipt=await tasks.importResult(taskId,{packageId,actualPlatform:'Codex',actualModel:'Synthetic',sourceEvidence:'Test only',raw:JSON.stringify({format:'collab-ui-patch/v1',summary:'Updated heading',edits:[{path:'index.html',oldText:'Old heading',newText:'New heading'}]})});return {id:'synthetic-execution'}},get:()=>({status:'completed',receiptId:receipt.id,actualModel:'Synthetic'})};
 const jobs=new CommentJobs(store,tasks,user,executions,new UIApplier(dir,dir));const request=await user.addRequest({projectId:p.id,kind:'feedback',body:'Update heading',reference:JSON.stringify({type:'page-annotation',epoch:0,page:'home'}),requestKey:'apply'});await jobs.submit(request.id,{expectedEpoch:0});await jobs.tick();assert.equal(jobs.list()[0].status,'running');await jobs.tick();assert.equal(jobs.list()[0].status,'applied');assert.match(readFileSync(join(dir,'index.html'),'utf8'),/New heading/);assert.equal(user.requests()[0].replies.at(-1).status,'changed');assert.ok(jobs.list()[0].result.directory);assert.equal(jobs.publicList()[0].sourceSnapshot,undefined);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});
