// Isolated synthetic user journey. Never copied to the real data directory.
import {mkdtempSync} from 'node:fs';
import {Store} from '../lib/store.mjs';
import {TaskStore} from '../lib/tasks.mjs';
import {ReviewStore} from '../lib/reviews.mjs';
import {GateStore} from '../lib/gates.mjs';
import {UserConsole} from '../lib/console.mjs';
const root=mkdtempSync('/private/tmp/collab-user-demo-'),store=new Store(root),tasks=new TaskStore(store),reviews=new ReviewStore(store,tasks),gates=new GateStore(store,tasks,reviews),user=new UserConsole(store,tasks,reviews,gates);
try{const p=await store.importConfig(JSON.stringify({schemaVersion:'1.0',fields:{projectName:'烘焙店预订页（隔离演示）'},skills:[],platforms:[],models:[{id:'p',platform:'模拟执行方',name:'示例模型'}],stages:[{id:'coding',primary:'p'}]}));await user.addUpdate({projectId:p.id,headline:'需求方向已整理，等待确认预订方式',body:'这是教学样例。先让顾客提交预订，再由店主确认取货时间；付款方式需要你选择。没有真实外部Agent调用。',platform:'模拟协调方',model:'教学样例',evidence:'测试脚本生成，仅验证用户交互',expectedEpoch:0});await user.addDecision({projectId:p.id,question:'首版如何收款？',options:[{id:'a',label:'到店付款',impact:'先跑通预订，不需要接入支付。'},{id:'b',label:'在线支付',impact:'需要接入支付服务并处理退款。'}],recommended:'a',expectedEpoch:0,platform:'模拟协调方',model:'教学样例',evidence:'教学决策，不是用户真实项目选择'});const task=await tasks.createTask({projectId:p.id,title:'模拟：制作预订表单',stage:'coding',requirement:'教学任务，不执行外部调用',acceptance:'仅演示控制'});user.capture(task);await user.addPreview({projectId:p.id,title:'演示链接（仅验证打开入口）',url:'http://127.0.0.1:8767/#home',summary:'只演示成果链接交互，不是已经开发好的烘焙产品。',platform:'模拟协调方',model:'教学样例',evidence:'模拟链接',expectedEpoch:0});console.log(JSON.stringify({root,projectId:p.id,taskId:task.id}));}finally{store.close()}
