import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,lstatSync,unlinkSync,readdirSync} from 'node:fs';
import {join,resolve,relative,parse} from 'node:path';
const hash=b=>createHash('sha256').update(b).digest('hex');
function safe(root,path){const target=resolve(root,path),rel=relative(root,target);if(!rel||rel.startsWith('..')||path.includes('\\')||path.split('/').some(x=>!x||x.startsWith('.')))throw Error('Source application path invalid');let p=parse(target).root;for(const part of target.slice(p.length).split('/')){p=join(p,part);if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('Source application symbolic link');}if(existsSync(target)&&(!lstatSync(target).isFile()||lstatSync(target).nlink!==1))throw Error('Source application target invalid');return target;}
const digestAt=p=>existsSync(p)?hash(readFileSync(p)):null;
export class SourceApplications{
 constructor(directory){this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true,mode:0o700});this.busy=false;}
 list(candidateId){return readdirSync(this.directory).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(n=>JSON.parse(readFileSync(join(this.directory,n)))).filter(x=>!candidateId||x.candidateId===candidateId).map(({files,...x})=>({...x,files:files.map(({before,next,...f})=>f)}));}
 save(record){const dest=join(this.directory,record.id+'.json'),tmp=dest+'.tmp';writeFileSync(tmp,JSON.stringify(record),{mode:0o600});renameSync(tmp,dest);}
 async apply(candidate,{authorize,verify,guard=()=>{}}){
 if(this.busy)throw Error('Source application busy');if(typeof authorize!=='function'||typeof verify!=='function')throw Error('Source application verifier required');this.busy=true;let record;
 try{
  authorize();if(this.list().some(x=>['writing','verifying','recovery_required'].includes(x.status)))throw Error('Source application recovery required');
  const files=candidate.files.map(f=>{const old=candidate.baselineFiles.find(b=>b.path===f.path);if(!old)throw Error('Source application baseline missing');const target=safe(candidate.root,f.path),next=readFileSync(safe(join(candidate.directory,'candidate'),f.path),'utf8');if(hash(next)!==f.contentHash||digestAt(target)!==(old.exists?old.contentHash:null))throw Error('Source application basis changed');return {path:f.path,before:old.exists?readFileSync(target,'utf8'):null,next,beforeHash:old.exists?old.contentHash:null,nextHash:f.contentHash,mode:old.exists?lstatSync(target).mode&0o777:0o600};}).filter(f=>f.before!==f.next);
  if(!files.length)throw Error('Source application has no changes');
  record={id:randomUUID(),candidateId:candidate.id,taskId:candidate.taskId,root:candidate.root,bundleHash:candidate.bundleHash,status:'writing',startedAt:new Date().toISOString(),files};this.save(record);
  for(const f of files){guard();const target=safe(record.root,f.path);if(digestAt(target)!==f.beforeHash)throw Error('Source application concurrent change');mkdirSync(join(target,'..'),{recursive:true});const tmp=target+'.collab-'+record.id;writeFileSync(tmp,f.next,{flag:'wx',mode:f.mode});renameSync(tmp,target);}
  record.status='verifying';this.save(record);const result=await verify();guard();if(!result?.ok)throw Error('Source application post-check failed');
  for(const f of files)if(digestAt(safe(record.root,f.path))!==f.nextHash)throw Error('Source application concurrent change');
  record.status='applied';record.checks=result;record.finishedAt=new Date().toISOString();this.save(record);return this.list(candidate.id).find(x=>x.id===record.id);
 }catch(e){if(record){record.reason=e.message;try{this.restore(record);}catch{record.status='recovery_required';}this.save(record);}throw e;}finally{this.busy=false;}
 }
 restore(record){
 let conflict=false;
 for(const f of record.files){try{const target=safe(record.root,f.path),current=digestAt(target);if(current===f.beforeHash)continue;if(current!==f.nextHash){conflict=true;continue;}if(f.before===null)unlinkSync(target);else{const tmp=target+'.restore-'+record.id;writeFileSync(tmp,f.before,{flag:'wx',mode:f.mode});renameSync(tmp,target);}}catch{conflict=true;}}
 record.status=conflict?'recovery_required':'rolled_back';record.finishedAt=new Date().toISOString();
 }

 rollback(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Source application id invalid');if(this.busy)throw Error('Source application busy');const r=JSON.parse(readFileSync(join(this.directory,id+'.json')));if(r.id!==id||!['applied','writing','verifying','recovery_required'].includes(r.status))throw Error('Source application cannot rollback');this.restore(r);this.save(r);return this.list(r.candidateId).find(x=>x.id===id);}
}
