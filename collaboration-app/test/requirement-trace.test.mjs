import test from 'node:test';import assert from 'node:assert/strict';import {requirementTrace} from '../lib/requirement-trace.mjs';
const request={id:'r',projectId:'p',body:'想法',replies:[]};
test('unlinked requests and historical plans never imply execution',()=>{const [r]=requirementTrace({requests:[request],plans:[{id:'old',requestId:'r',projectId:'p',current:false,tasks:[{taskId:'t'}]}],tasks:[{id:'t',projectId:'p',status:'valid_passed'}]});assert.equal(r.state,'unlinked');assert.equal(r.historicalPlanCount,1);});
test('explicit links are deduplicated, project scoped, and acceptance needs a current gate',()=>{
 const base={requests:[{...request,replies:[{taskId:'t'},{taskId:'other'}]}],plans:[{id:'plan',requestId:'r',projectId:'p',current:true,tasks:[{taskId:'t'}]}],tasks:[{id:'t',projectId:'p',status:'result_received',controls:[]},{id:'other',projectId:'q',status:'valid_passed'}]};
 assert.equal(requirementTrace(base)[0].linkedTasks,1);assert.equal(requirementTrace(base)[0].state,'review');base.tasks[0]={...base.tasks[0],status:'valid_passed',gate:{approved:true},review:{stale:false}};assert.equal(requirementTrace(base)[0].state,'accepted');base.tasks[0].review.stale=true;assert.equal(requirementTrace(base)[0].acceptedTasks,0);
});
test('applied comments count as basic checks, never formal acceptance',()=>{const [r]=requirementTrace({requests:[request],commentJobs:[{requestId:'r',status:'applied'}]});assert.equal(r.state,'basic_checked');assert.equal(r.acceptedTasks,0);});
