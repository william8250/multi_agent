// Synthetic fixture only; never imported by the product server or copied to production.
import { mkdtempSync } from 'node:fs';
import { Store } from '../lib/store.mjs';
import { TaskStore } from '../lib/tasks.mjs';
import { ReviewStore } from '../lib/reviews.mjs';
import { GateStore } from '../lib/gates.mjs';
const root=mkdtempSync('/private/tmp/collab-gate-demo-');
const store=new Store(root),tasks=new TaskStore(store),reviews=new ReviewStore(store,tasks),gates=new GateStore(store,tasks,reviews);
try {
 const project=await store.importConfig(JSON.stringify({schemaVersion:'1.0',fields:{projectName:'评分教学模拟（不是正式验收）',humanWeight:'50',aWeight:'25',bWeight:'25',passScore:'80',disagreement:'15'},platforms:[],skills:[],models:[{id:'p',platform:'模拟执行',name:'示例模型P'},{id:'a',platform:'模拟评审',name:'示例模型A'},{id:'b',platform:'模拟评审',name:'示例模型B'}],stages:[{id:'testing',primary:'p',reviewerA:'a',reviewerB:'b'}]}));
 const task=await tasks.createTask({projectId:project.id,title:'隔离模拟：80分仍须核查分差',stage:'testing',requirement:'只测试评分与门禁，不是真实模型调用。',acceptance:'缺分为空；差15升级；不得自动批准。'});
 const pkg=await tasks.preparePackage(task.id,{role:'primary',expectedVersion:1});
 await tasks.confirmHandoff(task.id,{packageId:pkg.id,actualPlatform:'模拟执行',actualModel:'示例模型P',evidence:'仅模拟，无外部调用',confirmed:true});
 await tasks.importResult(task.id,{packageId:pkg.id,actualPlatform:'模拟执行',actualModel:'示例模型P',sourceEvidence:'模拟产物',raw:'仅测试门禁，不是真实交付。'});
 const round=await reviews.openRound(task.id,{expectedVersion:1});
 for(const [slot,model,value]of [['reviewerA','示例模型A','72.50'],['reviewerB','示例模型B','87.50']]){
  await reviews.submitReview(round.id,{slot,actualPlatform:'模拟评审',actualModel:model,sourceEvidence:'测试脚本模拟，无真实模型调用',independentConfirmed:true,raw:'模拟独立意见：仅用于门禁验证。',conclusion:'模拟意见',items:[{topic:'评分边界',position:'change',severity:'major',detail:'演示总分80仍需分差升级。',suggestion:'人工核查分差依据。'}]});
 }
 for(const [slot,value]of [['reviewerA','72.50'],['reviewerB','87.50']]){
  const score=await gates.addScore(round.id,{source:slot,value,evidence:'模拟分数，无真实评分'});await gates.selectScore(round.id,{source:slot,revisionId:score.id});
 }
 const group=reviews.getRound(round.id).groups[0];await reviews.decideTopic(round.id,{groupId:group.id,action:'adopt',reason:'模拟采纳，不属于用户真实决定'});
 await gates.resolveTopic(round.id,{groupId:group.id,evidence:'模拟落实证据',reviewerPlatform:'模拟评审',reviewerModel:'示例模型A',reviewEvidence:'模拟独立核查，未实际外部调用',fixActorPlatform:'模拟执行',fixActorModel:'示例模型P',verifierIdentityVerified:true});
 for(const source of ['reviewerA','reviewerB'])await gates.confirmCross(round.id,{actor:'human',source,evidence:'模拟代登记，不是用户真实裁决'});
 console.log(JSON.stringify({root,taskId:task.id,roundId:round.id}));
} finally {store.close();}
