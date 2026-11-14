import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkBuddyOAuth} from '../lib/workbuddy-oauth.mjs';
const env={WORKBUDDY_CLIENT_ID:'example-app',WORKBUDDY_CLIENT_SECRET:'private-test-secret',WORKBUDDY_REDIRECT_URI:'http://127.0.0.1:8766/api/platforms/workbuddy/callback'};
const params=o=>{const u=new URL(o.begin('http://127.0.0.1:8766').authorizationUrl);return new URLSearchParams({state:u.searchParams.get('state'),code:'test-code'});};
test('unconfigured OAuth stays disabled and rejects arbitrary callback origins',()=>{
 const o=new WorkBuddyOAuth({env:{}});assert.equal(o.status().configured,false);assert.throws(()=>o.begin('http://127.0.0.1:8766'));
 for(const uri of ['https://attacker.example/api/platforms/workbuddy/callback','http://127.0.0.1:8766/api/platforms/workbuddy/callback?x=1'])assert.equal(new WorkBuddyOAuth({env:{...env,WORKBUDDY_REDIRECT_URI:uri}}).status().configured,false);
 assert.throws(()=>new WorkBuddyOAuth({env}).begin('http://127.0.0.1:9999'));
});
test('valid exchange consumes state once, keeps secrets private and never enables execution',async()=>{
 let calls=0;const o=new WorkBuddyOAuth({env,fetchImpl:async(url,opts)=>{calls++;assert.equal(url,'https://www.workbuddy.cn/openapi/v2/token');assert.equal(opts.redirect,'error');return new Response(JSON.stringify({token_type:'Bearer',access_token:'private-access-token',expires_in:3600,scope:'user.task.readable user.task.invokable'}));}});
 const p=params(o);const s=await o.callback(p);assert.equal(s.authorized,true);assert.equal(s.automaticExecution,false);assert.doesNotMatch(JSON.stringify(s),/private-/);await assert.rejects(o.callback(p));assert.equal(calls,1);assert.equal(o.disconnect().authorized,false);
});
test('expired, forged and duplicate state cannot exchange tokens',async()=>{
 let now=0,calls=0;const o=new WorkBuddyOAuth({env,now:()=>now,fetchImpl:async()=>{calls++;throw Error('secret');}});const p=params(o);now=600001;await assert.rejects(o.callback(p));p.set('state','a'.repeat(64));await assert.rejects(o.callback(p));p.append('state','a'.repeat(64));await assert.rejects(o.callback(p));assert.equal(calls,0);
});
test('provider failures and insufficient scopes do not authorize or leak response',async()=>{
 for(const response of [new Response('secret-provider-error',{status:400}),new Response(JSON.stringify({token_type:'Bearer',access_token:'secret',expires_in:300,scope:'user.task.readable'}))]){
 const o=new WorkBuddyOAuth({env,fetchImpl:async()=>response});await assert.rejects(o.callback(params(o)),e=>!e.message.includes('secret'));assert.equal(o.status().authorized,false);
 }
});
test('task inspection requires authorization, pins endpoint and strips vendor tickets and links',async()=>{
 let queries=0;const o=new WorkBuddyOAuth({env,fetchImpl:async(url,opts)=>{
 if(url.endsWith('/token'))return new Response(JSON.stringify({token_type:'Bearer',access_token:'private-token',expires_in:3600,scope:'user.task.readable user.task.invokable'}));
 queries++;assert.equal(url,'https://www.workbuddy.cn/openapi/v2/tasks/task_123');assert.equal(opts.redirect,'error');return new Response(JSON.stringify({task_id:'task_123',status:'completed',token:'private-ticket',link:'https://attacker.example',sandboxLink:'secret-url'}));
 }});
 await assert.rejects(o.inspectTask('task_123'));await o.callback(params(o));await assert.rejects(o.inspectTask('../token'));const result=await o.inspectTask('task_123');assert.equal(result.status,'completed');assert.equal(result.resultCollected,false);assert.doesNotMatch(JSON.stringify(result),/private|attacker|secret-url/);assert.equal(queries,1);
});
