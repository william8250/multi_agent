import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve,parse} from 'node:path';
import {artifactForTask} from './artifacts.mjs';
import {testReadiness} from './test-readiness.mjs';
import {runFunctionalTests} from './functional-runner.mjs';
const now=()=>new Date().toISOString();
function text(value,label){if(typeof value!=='string'||!value.trim()||value.length>2000)throw Error('Test inspection '+label+' required');return value.trim();}
function noLinks(path){let p=parse(path).root;for(const part of path.slice(p.length).split('/').filter(Boolean)){p=join(p,part);try{if(lstatSync(p).isSymbolicLink())throw Error('Test input unsafe path');}catch(e){if(e.code!=='ENOENT')throw e;}}}
function inputUnchanged(run){try{noLinks(run.directory);const found=[];function walk(folder,prefix=''){for(const name of readdirSync(folder)){const full=join(folder,name),path=prefix+name,stat=lstatSync(full);if(stat.isSymbolicLink())return false;if(stat.isDirectory()){if(!walk(full,path+'/'))return false;}else{const expected=run.files.find(f=>f.path===path);if(!stat.isFile()||stat.nlink!==1||!expected||stat.size!==expected.bytes||createHash('sha256').update(readFileSync(full)).digest('hex')!==expected.contentHash)return false;found.push(path);}}return true;}return walk(run.directory)&&found.length===run.files.length;}catch{return false;}}

export class CandidateTests{
  constructor(store,tasks,user,workspaces,{runner=runFunctionalTests}={}){
    Object.assign(this,{store,tasks,user,workspaces,runner});this.running=new Map();this.failures=new Map();this.cancellations=new Set();this.closing=false;
    store.db.exec('CREATE TABLE IF NOT EXISTS functional_test_runs(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES workspace_candidates(id),task_id TEXT NOT NULL REFERENCES tasks(id),payload TEXT NOT NULL)');
    const pending=this.list().filter(r=>r.status==='running');if(pending.length)tasks.transaction('functional_tests_interrupted',null,()=>{for(const r of pending)this.save({...r,status:'interrupted',reason:'server_restart_process_not_verified',finishedAt:now()});});
  }
  list(candidateId){return this.store.db.prepare('SELECT payload FROM functional_test_runs ORDER BY rowid').all().map(r=>JSON.parse(r.payload)).filter(r=>!candidateId||r.candidateId===candidateId).map(r=>this.failures.get(r.id)??r);}
  get(id){const r=this.list().find(r=>r.id===id);if(!r)throw Error('Test run not found');return r;}
  save(r){this.store.db.prepare('UPDATE functional_test_runs SET payload=? WHERE id=?').run(JSON.stringify(r),r.id);return r;}
  check(c){if(this.closing)throw Error('Test runner stopping');const task=this.tasks.mustTask(c.taskId,c.taskVersion);this.user.assertExecution(task);this.tasks.checkReady(task);if(!this.workspaces.freshness(c).fresh)throw Error('Workspace basis stale');return task;}
  async start(candidateId,args){
    let run,c;
    await this.tasks.write('functional_test_started',candidateId,()=>{
      c=this.workspaces.get(candidateId);this.check(c);
      if(this.running.size||this.list().some(r=>r.status==='running'||(r.status==='interrupted'&&!r.resolution)))throw Error('Test runner busy or interruption unresolved');
      if(this.workspaces.validations(candidateId).at(-1)?.status!=='syntax_passed')throw Error('Test syntax validation required');
      if(args.inspected!==true||args.bundleHash!==c.bundleHash||args.baselineHash!==c.baselineHash)throw Error('Test inspection basis required');
      const profile=args.profile??'offline-v1';if(!['offline-v1','loopback-http-v1'].includes(profile))throw Error('Test profile invalid');
      const inspection={inspector:text(args.inspector,'inspector'),evidence:text(args.evidence,'evidence'),declaredAt:now(),scope:'operator-declaration-not-independent-attestation'};
      const entries=testReadiness(c).testFiles.filter(p=>/\.(mjs|cjs|js)$/.test(p));if(!entries.length)throw Error('No supported candidate tests');
      const bundle=artifactForTask(this.tasks,c.taskId,c.receiptId),id=randomUUID(),directory=resolve(this.store.root,'functional-test-inputs',id);noLinks(directory);mkdirSync(directory,{recursive:true,mode:0o700});
      for(const file of bundle.files){const path=join(directory,file.path);noLinks(path);mkdirSync(join(path,'..'),{recursive:true,mode:0o700});writeFileSync(path,file.content,{flag:'wx',mode:0o600});}
      this.check(c);
      run={id,candidateId,taskId:c.taskId,taskVersion:c.taskVersion,receiptId:c.receiptId,bundleHash:c.bundleHash,baselineHash:c.baselineHash,epoch:c.epoch,inspection,entries,files:c.files,directory,pid:null,status:'running',profile,scope:'inspected-candidate-node-tests-not-acceptance',startedAt:now(),finishedAt:null,result:null};
      this.store.db.prepare('INSERT INTO functional_test_runs VALUES(?,?,?,?)').run(id,candidateId,c.taskId,JSON.stringify(run));
    });
    const pending=this.perform(c,run);this.running.set(run.id,pending);pending.then(()=>this.running.delete(run.id),()=>this.running.delete(run.id));return this.get(run.id);
  }
  async perform(c,run){
    try{
      let result;
      try{if(!inputUnchanged(run))throw Error('Test input changed');result=await this.runner(run.directory,run.entries,{profile:run.profile??'offline-v1',shouldStop:()=>{if(this.cancellations.has(run.id)||this.closing||!inputUnchanged(run))return true;this.check(c);return false;},onSpawn:pid=>this.tasks.write('functional_test_process_started',c.id,()=>{run.pid=pid;this.save(run);})});
        this.check(c);run.status=this.cancellations.has(run.id)?'cancelled':result.ok?'command_passed':'command_failed';
      }catch(e){run.status='blocked';run.reason=e.message;}
      if(this.cancellations.has(run.id))run.status='cancelled';run.result=result??null;run.finishedAt=now();
      await this.tasks.write('functional_test_finished',c.id,()=>{try{this.check(c);if(!inputUnchanged(run))throw Error('Test input changed');}catch(e){run.status='blocked';run.reason=e.message;}if(this.cancellations.has(run.id))run.status='cancelled';const saved=this.get(run.id);if(saved.cancelRequestedAt)run.cancelRequestedAt=saved.cancelRequestedAt;return this.save(run);});return run;
    }catch(e){
      const failed={...run,status:'interrupted',reason:'test_result_not_persisted',finishedAt:now(),persistence:'memory-only-until-storage-recovers'};this.failures.set(run.id,failed);
      try{await this.tasks.write('functional_test_interrupted',c.id,()=>this.save({...failed,persistence:'saved'}));this.failures.delete(run.id);}catch{console.error('功能测试记录未能保存；本次结果不计为通过。');}
      return this.get(run.id);
    }finally{this.cancellations.delete(run.id);}
  }
  async cancel(id){return this.tasks.write('functional_test_cancel_requested',this.get(id).candidateId,()=>{const run=this.get(id);if(run.status!=='running')throw Error('Test run is not running');this.cancellations.add(id);return this.save({...run,cancelRequestedAt:now()});});}
  async resolveInterruption(id,args){const result=await this.tasks.write('functional_test_interruption_resolved',this.get(id).candidateId,()=>{const r=this.get(id);if(r.status!=='interrupted'||this.running.has(id))throw Error('Test interruption not resolvable');return this.save({...r,resolution:{evidence:text(args.evidence,'process-stop evidence'),recordedAt:now(),scope:'operator-stop-declaration-no-automatic-pid-kill'}});});this.failures.delete(id);return result;}
  basis(c){const r=this.list(c.id).at(-1);return r?{id:r.id,status:r.status,bundleHash:r.bundleHash,baselineHash:r.baselineHash,finishedAt:r.finishedAt,scope:r.scope,profile:r.profile??'offline-v1'}:null;}
  reasons(c){const r=this.basis(c);if(!r)return testReadiness(c).testFiles.some(p=>/\.(mjs|cjs|js)$/.test(p))?['workspace_functional_tests_missing']:[];return r.status!=='command_passed'?['workspace_functional_tests_incomplete']:[];}
  async shutdown(){this.closing=true;await Promise.allSettled([...this.running.values()]);}
}
