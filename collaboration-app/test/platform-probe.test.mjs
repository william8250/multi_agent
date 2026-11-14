import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { capture, probePlatforms, verifyCodexProbe } from '../lib/platform-probe.mjs';

const completed = {code:0, failure:null, stdout:[{type:'item.completed',item:{type:'agent_message',text:'COLLAB_CONNECTIVITY_OK'}},{type:'turn.completed'}].map(JSON.stringify).join('\n'),stderr:''};
test('process exit and token alone cannot assert a successful model response',()=>{
  assert.equal(verifyCodexProbe(completed),true);
  for(const result of [{...completed,code:1},{...completed,failure:'timeout'},{...completed,stdout:'COLLAB_CONNECTIVITY_OK'},{...completed,stdout:JSON.stringify({type:'turn.completed'})},{...completed,stdout:completed.stdout+'\n'+JSON.stringify({type:'turn.failed'})}]) assert.equal(verifyCodexProbe(result),false);
});
test('default discovery does not run a model or expose raw authentication output',async()=>{
  const calls=[];
  const report=await probePlatforms({exists:async()=>true,run:async(path,args)=>{
    calls.push(args);return {code:0,failure:null,stdout:args.includes('--help')?'--json --ephemeral --sandbox --skip-git-repo-check read-only':'SECRET_AUTH_OUTPUT',stderr:''};
  }});
  assert.equal(calls.length,3);assert.equal(calls.some(args=>args.includes('--json')),false);
  assert.equal(report.projectExecutionEnabled,false);assert.equal(report.platforms[0].modelVerified,false);
  assert.doesNotMatch(JSON.stringify(report),/SECRET_AUTH_OUTPUT/);
});
test('actual probe remains read-only and does not invent a model identity or task execution',async()=>{
  const calls=[];
  const report=await probePlatforms({modelProbe:true,exists:async()=>true,run:async(path,args)=>{
    calls.push(args);if(args.includes('--json'))return completed;
    if(path.includes('WorkBuddy'))return {code:1,stderr:"Cannot find module '../dist/codebuddy'",stdout:''};
    return {code:0,stdout:'--json --ephemeral --sandbox --skip-git-repo-check read-only',stderr:''};
  }});
  assert.equal(report.platforms[0].status,'model_response_verified');assert.equal(report.platforms[0].actualModel,null);
  assert.equal(report.platforms[1].reason,'bundled_cli_missing_module');
  const args=calls.find(args=>args.includes('--json'));assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
  assert.equal(report.projectExecutionEnabled,false);
});
test('failed CLI discovery never starts a model even if requested',async()=>{
  let n=0;const report=await probePlatforms({modelProbe:true,exists:async()=>false,run:async()=>{n++;return {code:null,failure:'spawn_failed',stdout:'',stderr:''};}});
  assert.equal(n,2);assert.equal(report.platforms[0].status,'cli_unavailable');assert.equal(report.platforms[2].status,'app_not_found');
});
test('capture uses no shell, closes stdin, bounds output and handles missing binaries',async()=>{
  let options;
  const result=await capture('/fixed',['--help'],{limit:20,spawnProcess:(p,a,o)=>{
    options=o;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;
    queueMicrotask(()=>child.stdout.emit('data',Buffer.from('x'.repeat(40))));return child;
  }});
  assert.equal(options.shell,false);assert.equal(options.stdio[0],'ignore');assert.equal(result.failure,'output_limit');
  const missing=await capture('/nonexistent/collab-probe',[]);assert.equal(missing.failure,'spawn_failed');
});
