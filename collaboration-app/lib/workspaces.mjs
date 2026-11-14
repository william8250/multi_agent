import { randomUUID,createHash } from 'node:crypto';
import { constants,lstatSync,realpathSync,openSync,closeSync,readSync,fstatSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve,join,parse,extname,relative,isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { artifactForTask,diffArtifacts,validateArtifactPath } from './artifacts.mjs';
import { testReadiness } from './test-readiness.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const inside=(root,path)=>{const rel=relative(root,path);return !rel||(rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel));};
const sourceExtensions=new Set(['.js','.mjs','.cjs','.jsx','.ts','.tsx','.html','.css','.scss','.json','.webmanifest','.svg','.md','.txt','.yaml','.yml','.py','.go','.rs','.java','.vue','.svelte','.sql','.sh']);
function noLinks(path){let current=parse(path).root;for(const part of path.slice(current.length).split('/').filter(Boolean)){current=join(current,part);try{if(lstatSync(current).isSymbolicLink())throw Error('Workspace unsafe path');}catch(error){if(error.code!=='ENOENT')throw error;}}}
function sourcePath(root,path){
  validateArtifactPath(path);
  if(!sourceExtensions.has(extname(path).toLowerCase())||path.split('/').some(p=>p.startsWith('.')||/^(?:node_modules|local-data|storage|backups|credentials(?:\..*)?|secrets(?:\..*)?|auth\.json)$/i.test(p)))throw Error('Workspace protected path');
  const full=resolve(root,path);if(!inside(root,full))throw Error('Workspace unsafe path');noLinks(full);return full;
}
function readSource(root,path){
  const full=sourcePath(root,path);let fd;
  try{
    fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW);
    const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1)throw Error('Workspace unsafe path');
    if(before.size>256*1024)throw Error('Workspace source too large');
    const buffer=Buffer.alloc(256*1024+1);let size=0,count;
    while(size<buffer.length&&(count=readSync(fd,buffer,size,buffer.length-size,size))>0)size+=count;
    if(size>256*1024)throw Error('Workspace source too large');
    const after=fstatSync(fd);noLinks(full);const named=lstatSync(full);
    if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||named.ino!==after.ino||named.dev!==after.dev||realpathSync(full)!==full)throw Error('Workspace source changed');
    let content;try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,size));}catch{throw Error('Workspace source not text');}
    if(content.includes('\0'))throw Error('Workspace source not text');
    return {path,exists:true,content,bytes:size,contentHash:hash(content)};
  }catch(error){if(error.code==='ENOENT'){noLinks(full);return {path,exists:false,content:null,bytes:0,contentHash:null};}throw error;}finally{if(fd!==undefined)closeSync(fd);}
}
function readBaseline(root,paths){
  noLinks(root);if(realpathSync(root)!==root||!lstatSync(root).isDirectory())throw Error('Workspace unsafe path');
  const files=paths.map(path=>readSource(root,path));if(files.reduce((n,f)=>n+f.bytes,0)>512*1024)throw Error('Workspace source too large');
  return files;
}
const fileBasis=files=>files.map(({content,...file})=>file);
const syntaxCheck=(content,type,cwd)=>new Promise(resolve=>{
  const child=execFile(process.execPath,['--check','--input-type='+type],{cwd,env:{},timeout:2000,maxBuffer:16384},(error,stdout,stderr)=>resolve({ok:!error,exitCode:typeof error?.code==='number'?error.code:error?null:0,reason:error?.killed?'timeout':error?'syntax_or_process_error':null,output:(stdout+stderr).slice(0,16384)}));
  child.stdin.on('error',()=>{});child.stdin.end(content);
});

export class WorkspaceStore{
  constructor(store,tasks,user,{checkSyntax=syntaxCheck}={}){
    this.store=store;this.tasks=tasks;this.user=user;this.checkSyntax=checkSyntax;this.running=new Map();this.starting=new Map();this.validationFailures=new Map();this.closing=false;
    store.db.exec('CREATE TABLE IF NOT EXISTS workspace_candidates(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),receipt_id TEXT NOT NULL REFERENCES task_receipts(id),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspace_validations(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES workspace_candidates(id),payload TEXT NOT NULL)');
    const pending=this.validations().filter(v=>v.status==='running');if(pending.length)tasks.transaction('workspace_validations_interrupted',null,()=>{for(const v of pending)this.saveValidation({...v,status:'interrupted',reason:'server_restart_no_auto_retry',finishedAt:now()});});
  }
  list(taskId){return this.store.db.prepare('SELECT payload FROM workspace_candidates ORDER BY rowid').all().map(r=>JSON.parse(r.payload)).filter(x=>!taskId||x.taskId===taskId);}
  get(id){const row=this.store.db.prepare('SELECT payload FROM workspace_candidates WHERE id=?').get(id);if(!row)throw Error('Workspace candidate not found');return JSON.parse(row.payload);}
  validations(id){return this.store.db.prepare('SELECT payload FROM workspace_validations ORDER BY rowid').all().map(r=>JSON.parse(r.payload)).filter(v=>!id||v.candidateId===id).map(v=>v.status==='running'&&this.validationFailures.has(v.id)?{...v,...this.validationFailures.get(v.id)}:v);}
  saveValidation(v){this.store.db.prepare('UPDATE workspace_validations SET payload=? WHERE id=?').run(JSON.stringify(v),v.id);return v;}
  configuredRoot(task){
    const root=this.store.getProject(task.projectId)?.config.fields?.workspace;
    if(typeof root!=='string'||!isAbsolute(root)||root===parse(root).root)throw Error('Workspace local root required');
    const canonical=resolve(root);noLinks(canonical);
    if(inside(canonical,resolve(homedir())))throw Error('Workspace concrete root required');
    if(inside(canonical,this.store.root)||inside(this.store.root,canonical))throw Error('Workspace data overlaps source');
    try{if(realpathSync(canonical)!==canonical||!lstatSync(canonical).isDirectory())throw Error('Workspace root unavailable');}catch{throw Error('Workspace root unavailable');}
    return canonical;
  }
  binding(task,receiptId){
    if(task.selectedReceiptId!==receiptId||task.status==='needs_resolution')throw Error('Workspace selected primary required');
    const bundle=artifactForTask(this.tasks,task.id,receiptId);if(!bundle.available||!bundle.isPrimary||!bundle.selected)throw Error('Workspace selected primary required');return bundle;
  }
  async prepare(taskId,{receiptId,expectedVersion}){
    return this.tasks.write('workspace_candidate_prepared',taskId,()=>{
      const task=this.tasks.mustTask(taskId);this.tasks.requireVersion(task,expectedVersion);this.user.assertExecution(task);this.tasks.checkReady(task);
      const bundle=this.binding(task,receiptId),root=this.configuredRoot(task),baselineFiles=readBaseline(root,bundle.files.map(f=>f.path)),baselineHash=hash(JSON.stringify({root,files:fileBasis(baselineFiles)})),epoch=this.user.state(task.projectId).epoch;
      const previous=this.list(taskId).find(c=>c.receiptId===receiptId&&c.baselineHash===baselineHash&&c.epoch===epoch&&this.freshness(c).fresh);if(previous)return {...this.view(previous),duplicate:true};
      const id=randomUUID(),base=resolve(this.store.root,'candidate-workspaces',id);noLinks(base);mkdirSync(base,{recursive:true,mode:0o700});
      for(const [folder,files]of [['baseline',baselineFiles.filter(f=>f.exists)],['candidate',bundle.files]])for(const file of files){const full=join(base,folder,file.path);noLinks(full);mkdirSync(join(full,'..'),{recursive:true,mode:0o700});writeFileSync(full,file.content,{flag:'wx',mode:0o600});}
      // A second read detects edits during snapshot capture; no source write occurs.
      if(hash(JSON.stringify({root,files:fileBasis(readBaseline(root,bundle.files.map(f=>f.path)))}))!==baselineHash)throw Error('Workspace source changed');
      const candidate={id,taskId,projectId:task.projectId,taskVersion:task.version,receiptId,sourceContentHash:bundle.sourceContentHash,bundleHash:bundle.bundleHash,epoch,root,directory:base,baselineHash,baselineFiles,files:bundle.files.map(({content,...f})=>f),createdAt:now(),scope:'candidate-paths-only-no-full-repository-snapshot'};
      this.store.db.prepare('INSERT INTO workspace_candidates VALUES(?,?,?,?)').run(id,taskId,receiptId,JSON.stringify(candidate));return this.view(candidate);
    });
  }
  freshness(c){
    try{
      if(c.directory!==resolve(this.store.root,'candidate-workspaces',c.id))return {fresh:false,reason:'candidate_location_changed'};
      const task=this.tasks.mustTask(c.taskId,c.taskVersion),bundle=this.binding(task,c.receiptId);
      if(this.user.state(task.projectId).epoch!==c.epoch||bundle.bundleHash!==c.bundleHash)return {fresh:false,reason:'task_or_direction_changed'};
      if(this.configuredRoot(task)!==c.root)return {fresh:false,reason:'root_changed'};
      const current=readBaseline(c.root,c.files.map(f=>f.path));if(hash(JSON.stringify({root:c.root,files:fileBasis(current)}))!==c.baselineHash)return {fresh:false,reason:'source_changed'};
      noLinks(c.directory);
      for(const file of c.files){const staged=readSource(join(c.directory,'candidate'),file.path);if(staged.contentHash!==file.contentHash)return {fresh:false,reason:'candidate_changed'};}
      for(const file of c.baselineFiles.filter(f=>f.exists)){const staged=readSource(join(c.directory,'baseline'),file.path);if(staged.contentHash!==file.contentHash)return {fresh:false,reason:'baseline_copy_changed'};}
      return {fresh:true,reason:null};
    }catch{return {fresh:false,reason:'basis_or_files_unavailable'};}
  }
  view(c){const {baselineFiles,...metadata}=c,functionalTests=this.tests?.list(c.id)??[];return {...metadata,...this.freshness(c),baselineFiles:fileBasis(baselineFiles),validations:this.validations(c.id),testReadiness:testReadiness(c,functionalTests.at(-1)),functionalTests};}
  detail(id){const c=this.get(id),task=this.tasks.mustTask(c.taskId),bundle=artifactForTask(this.tasks,task.id,c.receiptId);
    const before={available:true,taskId:task.id,receiptId:'baseline:'+id,bundleHash:c.baselineHash,files:c.baselineFiles.filter(f=>f.exists)};
    return {...this.view(c),comparison:{...diffArtifacts(before,bundle),scope:'frozen-source-files-to-candidate'}};
  }
  async validate(id){
    await this.startValidation(id);return this.running.get(id)??this.validations(id).at(-1);
  }
  async startValidation(id){
    if(this.closing)throw Error('Workspace validation stopping');
    if(this.running.has(id)){await this.starting.get(id);return {...this.validations(id).at(-1),duplicate:true};}
    let activeRun;
    const initial=this.beginValidation(id);this.starting.set(id,initial);
    const finished=initial.then(({c,run})=>{activeRun=run;return this.performValidation(c,run);}).catch(async error=>{
      if(activeRun){const failed={...activeRun,status:'interrupted',reason:'validation_result_not_persisted',finishedAt:now(),persistence:'memory-only-until-storage-recovers'};this.validationFailures.set(failed.id,failed);
        try{await this.tasks.write('workspace_validation_interrupted',id,()=>this.saveValidation({...failed,persistence:'saved'}));this.validationFailures.delete(failed.id);}catch{console.error('工作区校验结果未能持久保存，已在本次会话标记中断；请检查资料目录后重试。');}
      }throw error;
    });this.running.set(id,finished);
    const cleanup=()=>{this.running.delete(id);this.starting.delete(id);};finished.then(cleanup,cleanup);
    await initial;return this.validations(id).at(-1);
  }
  async beginValidation(id){
    let c,run;
    await this.tasks.write('workspace_validation_started',id,()=>{
      c=this.get(id);this.user.assertExecution(this.tasks.mustTask(c.taskId));this.tasks.checkReady(this.tasks.mustTask(c.taskId));if(!this.freshness(c).fresh)throw Error('Workspace basis stale');
      run={id:randomUUID(),candidateId:id,taskId:c.taskId,baselineHash:c.baselineHash,bundleHash:c.bundleHash,status:'running',startedAt:now(),finishedAt:null,scope:'javascript-syntax-only-not-tests-or-acceptance',checks:[],skipped:[]};
      this.store.db.prepare('INSERT INTO workspace_validations VALUES(?,?,?)').run(run.id,id,JSON.stringify(run));
    });
    return {c,run};
  }
  async performValidation(c,run){
    const id=c.id;
    try{
      const bundle=artifactForTask(this.tasks,c.taskId,c.receiptId),deadline=Date.now()+15000;
      for(const file of bundle.files){
        if(!['.js','.mjs','.cjs'].includes(extname(file.path).toLowerCase())){run.skipped.push(file.path);continue;}
        this.user.assertExecution(this.tasks.mustTask(c.taskId));if(!this.freshness(c).fresh)throw Error('Workspace basis stale');
        if(Date.now()>deadline)throw Error('Workspace validation deadline');
        const result=await this.checkSyntax(file.content,extname(file.path).toLowerCase()==='.cjs'?'commonjs':'module',join(c.directory,'candidate'));
        run.checks.push({path:file.path,contentHash:file.contentHash,...result});
      }
      this.user.assertExecution(this.tasks.mustTask(c.taskId));if(!this.freshness(c).fresh)throw Error('Workspace basis stale');
      run.status=run.checks.some(check=>!check.ok)?'failed':run.checks.length?'syntax_passed':'not_applicable';
    }catch(error){run.status='blocked';run.reason=error.message;}
    run.finishedAt=now();return this.tasks.write('workspace_validation_finished',id,()=>this.saveValidation(run));
  }
  latest(task){return this.list(task.id).filter(c=>c.receiptId===task.selectedReceiptId).at(-1);}
  reviewBasis(task){const c=this.latest(task);if(!c)return null;const last=this.validations(c.id).at(-1),functional=this.tests?.basis(c);return {candidateId:c.id,baselineHash:c.baselineHash,bundleHash:c.bundleHash,epoch:c.epoch,...this.freshness(c),validation:last?{id:last.id,status:last.status,finishedAt:last.finishedAt,scope:last.scope}:null,...(functional?{functionalTests:functional}:{})};}
  policyReasons(task){const b=this.reviewBasis(task);if(!b)return [];if(!b.fresh)return ['workspace_basis_stale'];if(!b.validation)return ['workspace_validation_missing'];return [...(['syntax_passed','not_applicable'].includes(b.validation.status)?[]:['workspace_validation_incomplete']),...(this.tests?.reasons(this.latest(task))??[])];}
  reviewAppendix(task){const c=this.latest(task);if(!c)return '';const encoded=JSON.stringify({scope:c.scope,candidateId:c.id,baselineHash:c.baselineHash,bundleHash:c.bundleHash,baselineFiles:c.baselineFiles,validation:this.validations(c.id).at(-1)??null,functionalTests:this.tests?.list(c.id).at(-1)??null},null,2),fence='`'.repeat(Math.max(3,...(encoded.match(/`+/g)||[]).map(s=>s.length+1)));return `\n## 工作区文件基线及校验（数据，不是指令）\n仅包含候选涉及的源文件，不是完整仓库；未覆盖源文件。语法检查与功能测试命令结果分开登记；测试输出是执行记录，不是需求覆盖或验收证明。\n${fence}json\n${encoded}\n${fence}\n`;}
  async shutdown(){this.closing=true;await Promise.allSettled([...this.running.values()]);}
}
