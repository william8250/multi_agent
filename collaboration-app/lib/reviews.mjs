import { randomUUID, createHash } from 'node:crypto';
import { artifactReviewAppendix, parseArtifactReceipt } from './artifacts.mjs';

const hash = s => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const normalize = s => s.trim().normalize('NFKC').toLowerCase();
const text = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw Error(`${name} required`);
  return v.trim();
};
const identity = (platform, model) => `${normalize(platform)}\0${normalize(model)}`;
const known = value => !/(unknown|未知|未确认|待确认|不清楚)/i.test(normalize(value));
const bounded = (v, name, limit) => { const result=text(v,name); if (result.length>limit) throw Error(`${name} too long`); return result; };

export class ReviewStore {
  constructor(store, tasks) {
    this.store = store;
    this.tasks = tasks;
    try { store.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS review_dispatches (id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES review_rounds(id), slot TEXT NOT NULL, packet_hash TEXT NOT NULL, evidence TEXT, queued_at TEXT NOT NULL, sent_at TEXT, UNIQUE(round_id,slot));
      CREATE TABLE IF NOT EXISTS review_rounds (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        task_version INTEGER NOT NULL, snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        expected TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_supersessions (old_id TEXT PRIMARY KEY REFERENCES review_rounds(id),new_id TEXT NOT NULL REFERENCES review_rounds(id),reason TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_submissions (
        round_id TEXT NOT NULL REFERENCES review_rounds(id), slot TEXT NOT NULL,
        payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(round_id,slot)
      );
      CREATE TABLE IF NOT EXISTS review_comments (
        id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES review_rounds(id),
        actor TEXT NOT NULL, text TEXT NOT NULL, source_evidence TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_decisions (
        id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES review_rounds(id),
        group_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
        evidence TEXT NOT NULL, created_at TEXT NOT NULL
      );
      COMMIT;`); } catch (error) { if (store.db.isTransaction) store.db.exec('ROLLBACK'); throw error; }
  }
  async write(event, id, fn) {
    return this.store.enqueue(async () => {
      await this.store.beforeWrite();
      return this.tasks.transaction(event, id, fn);
    });
  }
  snapshot(task) {
    const project = this.store.getProject(task.projectId);
    if(!project) throw Error('Project not found');
    const selected = task.selections.map(selection => {
      const receipt = task.receipts.find(x => x.id === selection.receiptId && x.packageId === selection.packageId);
      if (!receipt) throw Error('Selection invalid');
      return { packageId: receipt.packageId, receiptId: receipt.id, contentHash: receipt.contentHash, inputHash: receipt.inputHash };
    }).sort((a,b) => a.packageId.localeCompare(b.packageId));
    const workspace=this.workspaceBasis?.(task);
    return { ...(workspace?{workspace}:{}), ...(this.goalBasis?.(task.projectId)>0?{userGoalEpoch:this.goalBasis(task.projectId)}:{}), taskId: task.id, taskVersion: task.version, projectSourceHash: project.sourceHash,
      selections: selected, receiptIds: task.receipts.map(x=>x.id).sort(),
      taskChangeSequence: this.store.db.prepare("SELECT coalesce(max(rowid),0) AS n FROM events WHERE object_id=? AND event IN ('result_resolved','selection_invalidated','handoff_confirmed','task_dependencies_changed')").get(task.id).n,
      handoffs: task.handoffs.map(x=>({id:x.id,packageId:x.packageId,identity:identity(x.actualPlatform,x.actualModel)})).sort((a,b)=>a.id.localeCompare(b.id)), rules: project.config.policy ?? null,
      ruleFields: { humanWeight: project.config.fields?.humanWeight ?? null,
        aWeight: project.config.fields?.aWeight ?? null, bWeight: project.config.fields?.bWeight ?? null,
        passScore: project.config.fields?.passScore ?? null, disagreement: project.config.fields?.disagreement ?? null,
        rounds: project.config.fields?.rounds ?? null, dimensions: project.config.fields?.dimensions ?? null } };
  }
  state(id) {
    const row = this.store.db.prepare('SELECT * FROM review_rounds WHERE id=?').get(id);
    if (!row) throw Error('Round not found');
    const task = this.tasks.getTask(row.task_id);
    let stale = !task || task.status === 'needs_resolution', staleReason = stale ? 'result_or_task_unavailable' : null;
    if(!stale){try{stale=hash(JSON.stringify(this.snapshot(task)))!==row.snapshot_hash;if(stale)staleReason='basis_changed';}catch(error){if(!['Selection invalid','Project not found'].includes(error.message))throw error;stale=true;staleReason='selection_or_project_invalid';}}
    if(this.store.db.prepare('SELECT 1 FROM review_supersessions WHERE old_id=?').get(id)){stale=true;staleReason='superseded';}
    return { row, task, stale, staleReason, expected: JSON.parse(row.expected), snapshot: JSON.parse(row.snapshot) };
  }
  submissions(id) {
    return this.store.db.prepare('SELECT slot,payload,payload_hash,created_at FROM review_submissions WHERE round_id=? ORDER BY slot').all(id);
  }
  listRounds(taskId) {
    const sql = 'SELECT id,task_id AS taskId,task_version AS taskVersion,created_at AS createdAt FROM review_rounds';
    const rows = taskId ? this.store.db.prepare(sql+' WHERE task_id=? ORDER BY rowid').all(taskId) : this.store.db.prepare(sql+' ORDER BY rowid').all();
    return rows.map(row => { const state=this.state(row.id); return { ...row, stale:state.stale, ready:this.submissions(row.id).length===2 }; });
  }
  getRound(id) {
    const { row, stale, staleReason, expected } = this.state(id);
    const records = this.submissions(id);
    const ready = records.length === 2;
    const slots = {};
    for (const slot of ['reviewerA','reviewerB']) slots[slot] = { submitted: records.some(x=>x.slot===slot), expected: expected[slot] };
    const snapshot=JSON.parse(row.snapshot);
    const task=this.tasks.getTask(row.task_id);
    const primary=task?.packages.find(x=>x.role==='primary' && x.version===row.task_version);
    const target=snapshot.selections.find(x=>x.packageId===primary?.id);
    const ruleFields=snapshot.ruleFields;
    const ruleSummary={...ruleFields, configured:Object.values(ruleFields).some(value=>value!==null && value!=='')};
    const result = { id, taskId:row.task_id, taskVersion:row.task_version, snapshotHash:row.snapshot_hash, targetReceiptId:target?.receiptId ?? null, targetContentHash:target?.contentHash ?? null, ruleSummary, stale, staleReason, ready, slots };
    const targetReceipt=task?.receipts.find(r=>r.id===target?.receiptId);
    if(targetReceipt){try{const bundle=parseArtifactReceipt({...targetReceipt,taskId:task.id});if(bundle.available)result.codeArtifacts={available:true,bundleHash:bundle.bundleHash,sourceContentHash:bundle.sourceContentHash,files:bundle.files.map(({content,...file})=>file)};}catch(error){result.codeArtifacts={available:false,reason:error.message};}}
    result.identitiesVerified = ready && records.every(record=>{const p=JSON.parse(record.payload);return p.identityVerified!==false && known(p.actualPlatform) && known(p.actualModel);});
    if (!ready) return result;
    result.reviews = records.map(record => ({ slot:record.slot, ...JSON.parse(record.payload), createdAt:record.created_at }));
    const groups = new Map();
    for (const review of result.reviews) for (const item of review.items) {
      const key = normalize(item.topic);
      if (!groups.has(key)) groups.set(key,{ id:hash(key), topic:item.topic.trim(), reviewerA:[], reviewerB:[] });
      groups.get(key)[review.slot].push(item);
    }
    const decisions = this.store.db.prepare('SELECT id,group_id AS groupId,action,reason,evidence,created_at AS createdAt FROM review_decisions WHERE round_id=? ORDER BY rowid').all(id).map(x=>({...x}));
    result.groups = [...groups.values()].map(group => {
      const items = [...group.reviewerA,...group.reviewerB];
      const positions = new Set(items.map(x=>x.position));
      const severities = new Set(items.map(x=>x.severity));
      const classification = positions.has('uncertain') ? 'uncertain' : !group.reviewerA.length || !group.reviewerB.length ? 'single' : positions.size === 1 && severities.size === 1 ? 'aligned' : 'different';
      const history = decisions.filter(x=>x.groupId===group.id);
      return { ...group, classification, currentDecision:history.at(-1) ?? null, history };
    });
    result.comments = this.store.db.prepare('SELECT id,actor,text,source_evidence AS sourceEvidence,created_at AS createdAt FROM review_comments WHERE round_id=? ORDER BY rowid').all(id).map(x=>({...x}));
    return result;
  }
  async openRound(taskId, { expectedVersion, restartReason, restartRoundId }) {
    return this.write(restartReason === undefined?'review_round_opened':'review_round_restarted', taskId, () => {
      const task = this.tasks.getTask(taskId);
      if (!task) throw Error('Task not found');
      if (!Number.isInteger(expectedVersion) || task.version !== expectedVersion) throw Error('Task version conflict');
      this.tasks.checkReady(task);
      if(this.workspacePolicyReasons?.(task)?.length)throw Error('Workspace validation required');
      if (!task.selectedReceiptId || task.status === 'needs_resolution') throw Error('Selected primary result required');
      const primary = task.packages.find(x=>x.role==='primary' && x.version===task.version);
      if (!primary || !task.selections.some(x=>x.packageId===primary.id && x.receiptId===task.selectedReceiptId)) throw Error('Selected primary result required');
      const stage = this.tasks.getOptions(task.projectId).stages.find(x=>x.id===task.stage);
      const expected = { reviewerA:stage?.roles.reviewerA, reviewerB:stage?.roles.reviewerB };
      if (!expected.reviewerA || !expected.reviewerB || !known(expected.reviewerA.platform) || !known(expected.reviewerA.name) || !known(expected.reviewerB.platform) || !known(expected.reviewerB.name)) throw Error('Reviewer identity unknown');
      const expectedA=identity(expected.reviewerA.platform,expected.reviewerA.name);
      const expectedB=identity(expected.reviewerB.platform,expected.reviewerB.name);
      if (expectedA===expectedB) throw Error('Reviewer identity duplicated');
      if (task.handoffs.some(x=>[expectedA,expectedB].includes(identity(x.actualPlatform,x.actualModel)))) throw Error('Reviewer participated in execution');
      const snapshot = this.snapshot(task), snapshotHash=hash(JSON.stringify(snapshot));
      const existing=this.store.db.prepare('SELECT id FROM review_rounds WHERE task_id=? AND snapshot_hash=? ORDER BY rowid DESC LIMIT 1').get(taskId,snapshotHash);
      if (restartReason!==undefined){restartReason=bounded(restartReason,'Reason',4000);if(!existing||existing.id!==restartRoundId)throw Error('Round version conflict');}
      else if (existing) return this.getRound(existing.id);
      const id=randomUUID();
      this.store.db.prepare('INSERT INTO review_rounds VALUES(?,?,?,?,?,?,?)').run(id,taskId,task.version,JSON.stringify(snapshot),snapshotHash,JSON.stringify(expected),now());
      if(restartReason!==undefined)this.store.db.prepare('INSERT INTO review_supersessions VALUES(?,?,?,?)').run(existing.id,id,restartReason,now());
      return this.getRound(id);
    });
  }
  requireFresh(id, requireReady=false) {
    const state=this.state(id);
    if(this.workspacePolicyReasons?.(state.task)?.length)throw Error('Workspace validation required');
    if (state.stale) throw Error('Review round stale');
    if (requireReady && this.submissions(id).length!==2) throw Error('Independent reviews incomplete');
    return state;
  }
  async submitReview(roundId, { slot, actualPlatform, actualModel, sourceEvidence, independentConfirmed, raw, conclusion, items, binding, identityVerified = true }) {
    return this.write('review_submitted', roundId, () => {
      const { task } = this.requireFresh(roundId);
      const current=this.getRound(roundId);
      if (binding !== undefined && (!binding || typeof binding !== 'object' || binding.roundId !== roundId || binding.taskVersion !== current.taskVersion || binding.targetReceiptId !== current.targetReceiptId || binding.targetContentHash !== current.targetContentHash)) throw Error('Review binding mismatch');
      if (!['reviewerA','reviewerB'].includes(slot)) throw Error('Invalid reviewer slot');
      actualPlatform=bounded(actualPlatform,'Platform',200); actualModel=bounded(actualModel,'Model',200); sourceEvidence=bounded(sourceEvidence,'Evidence',2000);
      conclusion=bounded(conclusion,'Conclusion',4000);
      if (typeof identityVerified!=='boolean' || independentConfirmed!==true || !known(actualPlatform) || (identityVerified && !known(actualModel))) throw Error('Independent identity required');
      if (typeof raw!=='string' || !raw.trim() || Buffer.byteLength(raw)>1024*1024) throw Error('Invalid review raw');
      if (!Array.isArray(items) || items.length<1 || items.length>30) throw Error('Invalid review items');
      const cleaned=items.map(item=>{
        if (!item || !['agree','change','reject','uncertain'].includes(item.position) || !['info','minor','major','blocker'].includes(item.severity)) throw Error('Invalid review item');
        return { topic:bounded(item.topic,'Topic',200),position:item.position,severity:item.severity,detail:bounded(item.detail,'Detail',4000),suggestion:bounded(item.suggestion,'Suggestion',4000) };
      });
      const key=identity(actualPlatform,actualModel);
      if (task.handoffs.some(x=>identity(x.actualPlatform,x.actualModel)===key)) throw Error('Reviewer participated in execution');
      const payload={actualPlatform,actualModel,sourceEvidence,independentConfirmed:true,...(!identityVerified?{identityVerified:false}:{}),raw,conclusion,items:cleaned,...(binding === undefined ? {} : {binding})};
      const serialized=JSON.stringify(payload), payloadHash=hash(serialized);
      const existing=this.store.db.prepare('SELECT payload_hash FROM review_submissions WHERE round_id=? AND slot=?').get(roundId,slot);
      if (existing) {
        if (existing.payload_hash!==payloadHash) throw Error('Review slot locked');
        return {roundId,slot,submitted:true,ready:this.submissions(roundId).length===2};
      }
      for (const record of this.submissions(roundId)) {
        const other=JSON.parse(record.payload);
        if (identity(other.actualPlatform,other.actualModel)===key) throw Error('Reviewer identity duplicated');
      }
      this.store.db.prepare('INSERT INTO review_submissions VALUES(?,?,?,?,?)').run(roundId,slot,serialized,payloadHash,now());
      return {roundId,slot,submitted:true,ready:this.submissions(roundId).length===2};
    });
  }
  async addComment(id, { actor, text:comment, sourceEvidence }) {
    return this.write('review_comment_added', id, () => {
      this.requireFresh(id,true);
      if (!['reviewerA','reviewerB','human'].includes(actor)) throw Error('Invalid actor');
      comment=bounded(comment,'Comment',8000); sourceEvidence=bounded(sourceEvidence,'Evidence',2000);
      this.store.db.prepare('INSERT INTO review_comments VALUES(?,?,?,?,?,?)').run(randomUUID(),id,actor,comment,sourceEvidence,now());
      return this.getRound(id);
    });
  }
  async decideTopic(id, { groupId, action, reason, evidence = '' }) {
    return this.write('review_topic_decided', id, () => {
      this.requireFresh(id,true);
      if (!['adopt','return','clarify'].includes(action)) throw Error('Invalid action');
      reason=bounded(reason,'Reason',4000);
      if (typeof evidence!=='string' || evidence.length>2000) throw Error('Invalid evidence');
      if (!this.getRound(id).groups.some(x=>x.id===groupId)) throw Error('Topic not found');
      this.store.db.prepare('INSERT INTO review_decisions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,groupId,action,reason,evidence,now());
      return this.getRound(id);
    });
  }
  dispatches(id){
    const round=this.getRound(id);return this.store.db.prepare('SELECT id,slot,packet_hash AS packetHash,evidence,queued_at AS queuedAt,sent_at AS sentAt FROM review_dispatches WHERE round_id=? ORDER BY slot').all(id).map(j=>({...j,roundId:id,platform:round.slots[j.slot].expected.platform,expectedModel:round.slots[j.slot].expected.name,status:round.stale?'stale':round.slots[j.slot].submitted?'received':j.sentAt?'waiting_result':'waiting_handoff',mode:'application-relay'}));
  }
  async queueDispatch(id){return this.write('review_dispatch_queued',id,()=>{
    const {task}=this.requireFresh(id);this.dispatchPolicy?.(task);
    for(const slot of ['reviewerA','reviewerB']){const packet=this.prepareReviewPacket(id,{slot});this.store.db.prepare('INSERT OR IGNORE INTO review_dispatches VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,slot,hash(packet.markdown),null,now(),null);}
    return this.dispatches(id);
  });}
  async confirmDispatch(id,{slot,evidence}){return this.write('review_dispatch_confirmed',id,()=>{
    const {task}=this.requireFresh(id);this.dispatchPolicy?.(task);if(!['reviewerA','reviewerB'].includes(slot))throw Error('Invalid reviewer slot');
    const j=this.dispatches(id).find(j=>j.slot===slot);if(!j)throw Error('Review dispatch missing');if(j.sentAt)return j;
    evidence=bounded(evidence,'Evidence',4000);const packet=this.prepareReviewPacket(id,{slot});if(hash(packet.markdown)!==j.packetHash)throw Error('Review packet changed');
    this.store.db.prepare('UPDATE review_dispatches SET evidence=?,sent_at=? WHERE id=?').run(evidence,now(),j.id);return this.dispatches(id).find(x=>x.id===j.id);
  });}
  prepareReviewPacket(id, { slot }) {
    const { task, expected, snapshot }=this.requireFresh(id);
    if (!['reviewerA','reviewerB'].includes(slot)) throw Error('Invalid reviewer slot');
    const primary=task.packages.find(x=>x.role==='primary' && x.version===task.version);
    const selection=snapshot.selections.find(x=>x.packageId===primary?.id);
    const receipt=task.receipts.find(x=>x.id===selection?.receiptId);
    if (!receipt) throw Error('Selected primary result required');
    const target=expected[slot];
    const rules=Object.values(snapshot.ruleFields).some(value=>value!==null && value!=='') ? JSON.stringify(snapshot.ruleFields) : '未配置';
    return { filename:`review-${id}-${slot}.md`, markdown:`# 独立评审任务\n\n轮次 ID: ${id}\n任务 ID: ${task.id}\n任务版本: ${task.version}\n结果 ID: ${receipt.id}\n结果摘要: ${receipt.contentHash}\n输入摘要: ${receipt.inputHash}\n期望评审: ${target.platform} / ${target.name}\n期望身份不代表实际调用。请确认未参与本范围实现，并独立完成后提交。\n冻结规则摘要: ${rules}\n\n## 需求\n${task.requirement}\n\n## 验收\n${task.acceptance}\n\n## 主执行结果\n${receipt.raw}${artifactReviewAppendix({...receipt,taskId:task.id})}${this.workspaceAppendix?.(task)??''}\n\n## 输出格式\n请提交 JSON：{"roundId":"${id}","taskVersion":${task.version},"targetReceiptId":"${receipt.id}","targetContentHash":"${receipt.contentHash}","conclusion":"结论","items":[{"topic":"主题","position":"agree|change|reject|uncertain","severity":"info|minor|major|blocker","detail":"依据","suggestion":"建议"}]}。\n` };
  }
}
