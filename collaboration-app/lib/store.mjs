import { DatabaseSync, backup } from 'node:sqlite';

import { createHash, randomUUID } from 'node:crypto';

import { mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, readdirSync, statSync, chmodSync, copyFileSync, existsSync, lstatSync, rmSync, statfsSync, unlinkSync } from 'node:fs';

import { join, basename, resolve, parse } from 'node:path';


const hash = b => createHash('sha256').update(b).digest('hex');

const now = () => new Date().toISOString();

const syncDir = p => { noLinks(p);
 const fd = openSync(p, 'r');
 try { fsyncSync(fd);
 } finally { closeSync(fd);
 } };

const noLinks = p => { const absolute=resolve(p);
 let current=parse(absolute).root;
 for(const part of absolute.slice(current.length).split('/').filter(Boolean)){current=join(current,part);
 try { if(lstatSync(current).isSymbolicLink()) throw Error('Symbolic links are not allowed');
 } catch(e) { if(e.code !== 'ENOENT') throw e;
 }} };

const privateDir = p => { noLinks(p);
 mkdirSync(p, { recursive: true, mode: 0o700 });
 noLinks(p);
 chmodSync(p, 0o700);
 };

const safeRead = p => { noLinks(p);
 return readFileSync(p);
 };

const writeDurable = (p, data) => { noLinks(p);
 const fd = openSync(p, 'wx', 0o600);
 try { writeFileSync(fd, data);
 fsyncSync(fd);
 } finally { closeSync(fd);
 } };

const strict64 = s => typeof s === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s) && Buffer.from(s, 'base64').toString('base64') === s;


export class Store {
  constructor(root, options = {}) {
    this.root = root;
 this.options = options;
 this.queue = Promise.resolve();
 this.lockPath=join(root,'.store.lock');
 this.lockOwned=false;

    privateDir(root);
 noLinks(this.lockPath);
 try { const fd=openSync(this.lockPath,'wx',0o600);
 this.lockOwned=true;
 try {writeFileSync(fd,String(process.pid));
fsyncSync(fd);
} finally {closeSync(fd);
} } catch(e) {if(this.lockOwned) {try {unlinkSync(this.lockPath)} catch {} this.lockOwned=false;
} if(e.code==='EEXIST') throw Error('Data directory in use');
 throw e;
}
    try {
    for (const p of [root, join(root,'objects'), join(root,'staging'), join(root,'backups'), join(root,'verify')]) privateDir(p);

    for(const suffix of ['', '-wal', '-shm', '-journal']) noLinks(join(root,'store.sqlite'+suffix));
 this.db = new DatabaseSync(join(root,'store.sqlite'));
 chmodSync(join(root,'store.sqlite'),0o600);

    this.db.exec(`PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,source_hash TEXT UNIQUE NOT NULL,raw TEXT NOT NULL,created_at TEXT NOT NULL,warnings TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS objects(hash TEXT PRIMARY KEY,size INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS project_objects(project_id TEXT NOT NULL REFERENCES projects(id),hash TEXT NOT NULL REFERENCES objects(hash),name TEXT NOT NULL,PRIMARY KEY(project_id,hash,name));

    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,event TEXT NOT NULL,object_id TEXT,hash TEXT,created_at TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY,path TEXT NOT NULL,created_at TEXT NOT NULL,reason TEXT NOT NULL);
    `);


    } catch(e) { if(this.db) this.db.close();
 if(this.lockOwned) {unlinkSync(this.lockPath);
this.lockOwned=false;
} throw e;
 }
  }
  checkSpace(required) { const available=this.options.availableBytes ? this.options.availableBytes() : Number(statfsSync(this.root).bavail)*Number(statfsSync(this.root).bsize);
 if(available < required) throw Error('Disk space insufficient');
 }
  enqueue(fn) { const next = this.queue.then(fn);
 this.queue = next.catch(() => {});
 return next;
 }
  event(event,id,h) { this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(randomUUID(),event,id ?? null,h ?? null,now());
 }
  async beforeWrite() { if (!this.db.prepare('SELECT 1 FROM backups WHERE substr(created_at,1,10)=? LIMIT 1').get(now().slice(0,10))) await this.backupInternal('daily-first-write');
 }
  async importConfig(raw, revision = null) { return this.enqueue(async () => {
    if (typeof raw !== 'string' || Buffer.byteLength(raw)>20_000_000) throw Error('Invalid configuration size');
    let cfg; try { cfg=JSON.parse(raw); } catch { throw Error('Invalid JSON'); }
    if (!cfg || cfg.schemaVersion !== '1.0' || !cfg.fields || !Array.isArray(cfg.skills) || !Array.isArray(cfg.models) || !Array.isArray(cfg.platforms) || !Array.isArray(cfg.stages)) throw Error('Invalid configuration schema');
    let base=null, family=null;
    if(revision){
      if(typeof revision.baseProjectId!=='string'||typeof revision.expectedHash!=='string')throw Error('Configuration revision required');
      base=this.getProject(revision.baseProjectId);if(!base)throw Error('Project not found');this.revisionPolicy?.(base.id);
      family=this.configHistory(base.id);
      if(base.sourceHash!==revision.expectedHash||family.at(-1).id!==base.id)throw Error('Configuration revision conflict');
      if(String(cfg.fields.projectName||'未命名项目')!==base.name)throw Error('Configuration rename refused');
      const stable=c=>{const {generatedAt,...rest}=c;return JSON.stringify(rest)};
      if(stable(cfg)===stable(base.config))return {id:base.id,name:base.name,sourceHash:base.sourceHash,duplicate:true,skillCount:base.skillCount,attachmentWarnings:base.attachmentWarnings,...base.versionInfo};
    }
    const sourceHash=hash(Buffer.from(raw)); const previous=this.db.prepare('SELECT id,name FROM projects WHERE source_hash=?').get(sourceHash);
    if(previous && revision)throw Error('Configuration snapshot conflict');
    if(previous) { const p=this.getProject(previous.id); return {id:p.id,name:p.name,sourceHash,duplicate:true,skillCount:p.skillCount,attachmentWarnings:p.attachmentWarnings}; }
    const name=String(cfg.fields.projectName || '未命名项目'); if(!revision&&this.db.prepare('SELECT 1 FROM projects WHERE name=?').get(name)) throw Error('Project name conflict');
    const files=[]; let total=0;
    for(const s of cfg.skills) { if (!s || typeof s !== 'object') throw Error('Invalid skill'); if(!s.file) continue; const f=s.file;
      if(typeof f.name!=='string' || !f.name || f.name==='.' || f.name==='..' || basename(f.name)!==f.name || /[\\/\0]/.test(f.name)) throw Error('Invalid skill filename');
      let bytes;

    if(f.encoding==='base64') { if(!strict64(f.content)) throw Error('Invalid base64');

    bytes=Buffer.from(f.content,'base64');

    if(!/\.zip$/i.test(f.name) || bytes.length<4 || bytes[0]!==80 || bytes[1]!==75 || ![[3,4],[5,6],[7,8]].some(x=>bytes[2]===x[0]&&bytes[3]===x[1])) throw Error('Invalid ZIP');

    if(bytes.length>10*1024*1024) throw Error('ZIP too large');

    }
      else if(f.encoding==='utf-8' && typeof f.content==='string' && /\.(md|txt|json|ya?ml)$/i.test(f.name)) { bytes=Buffer.from(f.content); if(bytes.length>1024*1024) throw Error('Text too large'); } else throw Error('Invalid skill encoding');
      if(!Number.isSafeInteger(f.size) || f.size!==bytes.length) throw Error('Skill size mismatch'); total+=bytes.length; if(total>10*1024*1024) throw Error('Skills too large'); files.push({name:f.name,bytes,hash:hash(bytes)});
    }
    const warnings=[]; for(const group of ['requirements','billing']) for(const f of (Array.isArray(cfg.attachments?.[group])?cfg.attachments[group]:[])) warnings.push({group,name:typeof f?.name==='string'?f.name:'unknown',reason:'metadata only; content must be relinked'});
    await this.beforeWrite(); await this.backupInternal('before-migration');
    for(const f of files) { const target=join(this.root,'objects',f.hash);

    if(existsSync(target)) { if(hash(safeRead(target))!==f.hash) throw Error('Existing object corrupt');

    continue;

    } const temp=join(this.root,'staging',randomUUID());

    writeDurable(temp,f.bytes);

    this.options.failpoint?.('staged');

    noLinks(target);

    renameSync(temp,target);

    syncDir(join(this.root,'objects'));

    this.options.failpoint?.('published');

    }
    const id=randomUUID(), created=now();
    this.db.exec('BEGIN IMMEDIATE');

    try { if(revision)this.revisionPolicy?.(base.id);this.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)').run(id,name,sourceHash,raw,created,JSON.stringify(warnings));

    for(const f of files) { this.db.prepare('INSERT OR IGNORE INTO objects VALUES(?,?)').run(f.hash,f.bytes.length);

    this.db.prepare('INSERT OR IGNORE INTO project_objects VALUES(?,?,?)').run(id,f.hash,f.name);

    }
    if(revision){
      this.db.exec('CREATE TABLE IF NOT EXISTS config_revisions(snapshot_id TEXT PRIMARY KEY REFERENCES projects(id),root_id TEXT NOT NULL REFERENCES projects(id),parent_id TEXT UNIQUE REFERENCES projects(id),version INTEGER NOT NULL,UNIQUE(root_id,version))');
      const root=family[0].id;
      this.db.prepare('INSERT OR IGNORE INTO config_revisions VALUES(?,?,NULL,1)').run(root,root);
      this.db.prepare('INSERT INTO config_revisions VALUES(?,?,?,?)').run(id,root,base.id,family.length+1);
    }
    this.event(revision?'config_revision_saved':'config_imported',id,sourceHash);

    this.options.failpoint?.('transaction');

    this.db.exec('COMMIT');

    } catch(e) { this.db.exec('ROLLBACK');

    throw e;

    }
    return {id,name,sourceHash,duplicate:false,skillCount:this.getProject(id).skillCount,attachmentWarnings:warnings,...this.getProject(id).versionInfo};
  });
 }
  listProjects() { return this.db.prepare('SELECT p.id,p.name,p.source_hash AS sourceHash,p.created_at AS createdAt,(SELECT count(*) FROM project_objects o WHERE o.project_id=p.id) AS skillCount FROM projects p ORDER BY p.created_at').all().map(x=>({...x,...this.configVersion(x.id)}));
 }
  configVersion(id){const history=this.configHistory(id),entry=history.find(p=>p.id===id);return {rootId:history[0]?.id??id,version:entry?.version??1,latestId:history.at(-1)?.id??id,isLatest:history.at(-1)?.id===id};}
  configHistory(id){
    const exists=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config_revisions'").get();
    const root=exists?this.db.prepare('SELECT root_id FROM config_revisions WHERE snapshot_id=?').get(id)?.root_id:null;
    return root?this.db.prepare('SELECT p.id,p.name,p.source_hash AS sourceHash,p.created_at AS createdAt,r.version FROM config_revisions r JOIN projects p ON p.id=r.snapshot_id WHERE r.root_id=? ORDER BY r.version').all(root).map(p=>({...p})):this.db.prepare('SELECT id,name,source_hash AS sourceHash,created_at AS createdAt,1 AS version FROM projects WHERE id=?').all(id).map(p=>({...p}));
  }
  getProject(id) { const p=this.db.prepare('SELECT id,name,source_hash AS sourceHash,raw,warnings FROM projects WHERE id=?').get(id);
 if(!p) return null;
 return {id:p.id,name:p.name,sourceHash:p.sourceHash,raw:p.raw,config:JSON.parse(p.raw),versionInfo:this.configVersion(id),skillCount:this.db.prepare('SELECT count(*) AS n FROM project_objects WHERE project_id=?').get(id).n,attachmentWarnings:JSON.parse(p.warnings)};
 }
  async createBackup(reason) { return this.enqueue(()=>this.backupInternal(reason));
 }
  async backupInternal(reason) { if(typeof reason!=='string'||!reason.trim()||reason.length>200) throw Error('Invalid backup reason');
 this.options.failpoint?.('backup');
 const estimate=statSync(join(this.root,'store.sqlite')).size + this.db.prepare('SELECT coalesce(sum(size),0) AS n FROM objects').get().n + 1024*1024;
 this.checkSpace(estimate);
 const id=randomUUID(), createdAt=now(), path=join(this.root,'backups',id), objDir=join(path,'objects');
 privateDir(path);
 privateDir(objDir);

    await backup(this.db,join(path,'store.sqlite'));
 chmodSync(join(path,'store.sqlite'),0o600);
 const fd=openSync(join(path,'store.sqlite'),'r');
 try{fsyncSync(fd)}finally{closeSync(fd)}
    const objects=this.db.prepare('SELECT hash,size FROM objects ORDER BY hash').all().map(x=>({...x}));
 for(const o of objects) { const src=join(this.root,'objects',o.hash);
 const bytes=safeRead(src);
 if(bytes.length!==o.size||hash(bytes)!==o.hash) throw Error('Object corrupt');
 writeDurable(join(objDir,o.hash),bytes);
 }
    syncDir(objDir);
 const dbHash=hash(readFileSync(join(path,'store.sqlite')));
 writeDurable(join(path,'manifest.json'),JSON.stringify({version:1,id,createdAt,reason,dbHash,objects}));
 syncDir(path);
 syncDir(join(this.root,'backups'));

    this.db.exec('BEGIN IMMEDIATE');
 try { this.db.prepare('INSERT INTO backups VALUES(?,?,?,?)').run(id,path,createdAt,reason);
 this.event('backup_created',id,dbHash);
 this.db.exec('COMMIT');
 } catch(e){this.db.exec('ROLLBACK');
throw e;
} return {id,path,createdAt,reason};

  }
  backupPath(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid backup ID');
    return join(this.root, 'backups', id);
  }
  listBackups() { return this.db.prepare('SELECT id,created_at AS createdAt,reason FROM backups ORDER BY created_at').all().map(x=>({...x,path:this.backupPath(x.id)}));
 }
  async verifyBackup(id) { return this.enqueue(async()=> { const path=this.backupPath(id); const row=this.db.prepare('SELECT id FROM backups WHERE id=?').get(id);

    if(!row) throw Error('Backup not found');

    noLinks(path);

    const backupObjectDir=join(path,'objects');

    noLinks(backupObjectDir);

    const objectBytes=readdirSync(backupObjectDir).reduce((sum,name)=>{const p=join(backupObjectDir,name);
    noLinks(p);
    return sum+statSync(p).size;

    },0);

    this.checkSpace(statSync(join(path,'store.sqlite')).size + objectBytes + 1024*1024);

    const dest=join(this.root,'verify',randomUUID());

    privateDir(dest);

    try { const m=JSON.parse(safeRead(join(path,'manifest.json')).toString('utf8'));

    if(m.id!==id || m.version!==1 || !Array.isArray(m.objects)) throw Error('Invalid manifest');

    const dbBytes=safeRead(join(path,'store.sqlite'));

    if(hash(dbBytes)!==m.dbHash) throw Error('Database hash mismatch');

    writeDurable(join(dest,'store.sqlite'),dbBytes);

    privateDir(join(dest,'objects'));

    const seen=new Set();

    for(const o of m.objects) { if(!/^[a-f0-9]{64}$/.test(o.hash) || !Number.isSafeInteger(o.size) || o.size<0 || seen.has(o.hash)) throw Error('Invalid manifest object');

    seen.add(o.hash);

    const b=safeRead(join(path,'objects',o.hash));

    if(b.length!==o.size||hash(b)!==o.hash) throw Error('Object hash mismatch');

    writeDurable(join(dest,'objects',o.hash),b);

    } const db=new DatabaseSync(join(dest,'store.sqlite'),{readOnly:true});

    try { if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Database corrupt');

    const refs=db.prepare('SELECT hash,size FROM objects ORDER BY hash').all();

    if(JSON.stringify(refs.map(x=>({...x})))!==JSON.stringify(m.objects)) throw Error('Manifest mismatch');

    const result={ok:true,projectCount:db.prepare('SELECT count(*) AS n FROM projects').get().n,objectCount:refs.length};

    this.verifyEvent(id,'success');

    return result;

    } finally {db.close();

    } } catch(e) { this.verifyEvent(id,'failure');

    return {ok:false,projectCount:0,objectCount:0,error:'Backup verification failed'};

    } finally { rmSync(dest,{recursive:true,force:true});

    } });

 }
  verifyEvent(id,result) { this.db.exec('BEGIN IMMEDIATE');
 try { this.event('backup_verify_'+result,id,null);
 this.db.exec('COMMIT');
 } catch(e){this.db.exec('ROLLBACK');
throw e;
} }
  audit() { return this.db.prepare('SELECT event,object_id AS id,hash,created_at AS createdAt FROM events ORDER BY rowid').all().map(x=>({...x}));
 }
  health() { const known=new Set(this.db.prepare('SELECT hash FROM objects').all().map(x=>x.hash));
 const orphans=readdirSync(join(this.root,'objects')).filter(x=>!known.has(x));
 const staged=readdirSync(join(this.root,'staging'));
 const missing=[],corrupt=[];
 for(const x of known){try{const b=safeRead(join(this.root,'objects',x));
 if(hash(b)!==x) corrupt.push(x);
}catch(e){if(e.code==='ENOENT') missing.push(x);
else corrupt.push(x);
}} return {projectCount:this.listProjects().length,objectCount:known.size,orphans,staged,missing,corrupt};
 }
  close() { if (this.closed) return;
 this.closed=true;
 try { this.db.close();
 } finally { if(this.lockOwned) { unlinkSync(this.lockPath);
 this.lockOwned=false;
 } } }
}
