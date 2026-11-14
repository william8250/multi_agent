// Isolated, explicitly synthetic fixture; never called by the product server.
import { mkdtempSync } from 'node:fs';
import { Store } from '../lib/store.mjs';
import { TaskStore } from '../lib/tasks.mjs';
const root=mkdtempSync('/private/tmp/collab-review-preview-');
const store=new Store(root),tasks=new TaskStore(store);
try {
  const project=await store.importConfig(JSON.stringify({schemaVersion:'1.0',fields:{projectName:'独立评审教学样例（仅隔离预览）'},platforms:[],skills:[],models:[{id:'p',platform:'模拟执行平台',name:'样例执行模型'},{id:'a',platform:'模拟评审甲',name:'样例评审模型A'},{id:'b',platform:'模拟评审乙',name:'样例评审模型B'}],stages:[{id:'testing',primary:'p',reviewerA:'a',reviewerB:'b'}]}));
  const task=await tasks.createTask({projectId:project.id,title:'评审与人工复核教学样例',stage:'testing',requirement:'仅演示本机评审封存和人工复核，不代表真实外部模型调用。',acceptance:'两方齐前隐藏意见；分歧清晰；决定理由保留；不标为验收通过。'});
  const packet=await tasks.preparePackage(task.id,{role:'primary',expectedVersion:1});
  await tasks.confirmHandoff(task.id,{packageId:packet.id,actualPlatform:'模拟执行平台',actualModel:'样例执行模型',evidence:'隔离样例模拟提交，无实际外部调用',confirmed:true});
  await tasks.importResult(task.id,{packageId:packet.id,actualPlatform:'模拟执行平台',actualModel:'样例执行模型',sourceEvidence:'隔离样例模拟原文',raw:'教学样例产物：本地保存已规划，恢复证据需要补充。仅用于测试，不是实际产品验收证据。'});
  console.log(JSON.stringify({root,projectId:project.id,taskId:task.id}));
} finally {store.close();}
