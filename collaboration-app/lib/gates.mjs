import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw Error(`${label} required`);
  return value.trim();
};
const normalize = value => value.trim().normalize('NFKC').toLowerCase();
const cents = value => {
  if (typeof value !== 'string' || !/^(?:\d{1,2}|100)(?:\.\d{1,2})?$/.test(value)) throw Error('Invalid decimal');
  const [whole, fraction=''] = value.split('.');
  const result = Number(whole)*100 + Number(fraction.padEnd(2,'0'));
  if (result>10000) throw Error('Invalid decimal');
  return result;
};
const decimal = (integer, digits) => {
  const scale=10**digits;
  return `${Math.floor(integer/scale)}.${String(integer%scale).padStart(digits,'0')}`;
};

export class GateStore {
  constructor(store,tasks,reviews) {
    this.store=store; this.tasks=tasks; this.reviews=reviews;
    try { store.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS gates(round_id TEXT PRIMARY KEY REFERENCES review_rounds(id), revision INTEGER NOT NULL DEFAULT 0, review_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS gate_scores(id TEXT PRIMARY KEY,round_id TEXT NOT NULL REFERENCES review_rounds(id),source TEXT NOT NULL,value TEXT NOT NULL,evidence TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_score_selections(round_id TEXT NOT NULL REFERENCES review_rounds(id),source TEXT NOT NULL,score_id TEXT NOT NULL REFERENCES gate_scores(id),PRIMARY KEY(round_id,source));
      CREATE TABLE IF NOT EXISTS gate_events(id TEXT PRIMARY KEY,round_id TEXT NOT NULL REFERENCES review_rounds(id),kind TEXT NOT NULL,group_id TEXT,payload TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_decisions(id TEXT PRIMARY KEY,round_id TEXT NOT NULL REFERENCES review_rounds(id),action TEXT NOT NULL,reason TEXT NOT NULL,revision INTEGER NOT NULL,snapshot_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      `);
      const columns=store.db.prepare('PRAGMA table_info(gates)').all();
      if (!columns.some(x=>x.name==='review_seq')) {
        store.db.exec('ALTER TABLE gates ADD COLUMN review_seq INTEGER NOT NULL DEFAULT 0');
        for(const row of store.db.prepare('SELECT DISTINCT r.task_id FROM gates g JOIN review_rounds r ON r.id=g.round_id').all())this.invalidateSync(row.task_id);
      }
      store.db.exec('COMMIT');
    } catch(e) { if(store.db.isTransaction) store.db.exec('ROLLBACK'); throw e; }
  }
  ensure(roundId) { this.store.db.prepare('INSERT OR IGNORE INTO gates(round_id,revision) VALUES(?,0)').run(roundId); }
  current(roundId) {
    const round=this.reviews.getRound(roundId);
    if (!round.ready || round.stale) throw Error('Review round incomplete or stale');
    return round;
  }
  rule(round) {
    const fields=round.ruleSummary;
    try {
      const human=cents(fields.humanWeight), a=cents(fields.aWeight), b=cents(fields.bWeight);
      const pass=cents(fields.passScore), disagreement=cents(fields.disagreement);
      if(human+a+b!==10000) throw Error('Invalid weights');
      return {humanWeight:fields.humanWeight,aWeight:fields.aWeight,bWeight:fields.bWeight,passScore:fields.passScore,disagreement:fields.disagreement,human,a,b,pass,difference:disagreement};
    } catch { return null; }
  }
  getGate(roundId,{healthSnapshot}={}) {
    const db=this.store.db, round=this.reviews.getRound(roundId), task=this.tasks.getTask(round.taskId);
    const gateRow=db.prepare('SELECT revision,review_seq FROM gates WHERE round_id=?').get(roundId);
    const revision=gateRow?.revision ?? 0, reviewSeq=gateRow?.review_seq ?? 0;
    const scores=db.prepare('SELECT id,source,value,evidence,created_at AS createdAt FROM gate_scores WHERE round_id=? ORDER BY rowid').all(roundId).map(x=>({...x}));
    const selections=db.prepare('SELECT source,score_id AS revisionId FROM gate_score_selections WHERE round_id=?').all(roundId).map(x=>({...x}));
    const events=db.prepare('SELECT id,kind,group_id AS groupId,payload,revision,created_at AS createdAt FROM gate_events WHERE round_id=? ORDER BY rowid').all(roundId).map(x=>({...x,...JSON.parse(x.payload),payload:undefined}));
    const decisions=db.prepare('SELECT id,action,reason,revision,snapshot_hash AS snapshotHash,created_at AS createdAt FROM gate_decisions WHERE round_id=? ORDER BY rowid').all(roundId).map(x=>({...x}));
    const rule=this.rule(round), reasons=[...(this.policyReasons?.(task)??[])];
    if (!round.ready) reasons.push('independent_reviews_incomplete');
    if (round.ready && (round.identitiesVerified === false || round.reviews.some(x=>x.identityVerified === false))) reasons.push('reviewer_identity_unverified');
    if (round.stale) reasons.push('review_round_stale');
    try { this.tasks.checkReady(task); } catch { reasons.push('upstream_not_passed'); }
    const health=healthSnapshot??this.store.health();
    if (health.missing.length || health.corrupt.length) reasons.push('storage_invalid');
    if (!rule) reasons.push('rules_invalid_or_missing');
    const selected={};
    for(const s of selections) selected[s.source]=scores.find(x=>x.id===s.revisionId && x.source===s.source);
    let calculation=null;
    if (!['human','reviewerA','reviewerB'].every(x=>selected[x])) reasons.push('scores_incomplete');
    else if (rule) {
      const h=cents(selected.human.value), a=cents(selected.reviewerA.value), b=cents(selected.reviewerB.value);
      const weighted=h*rule.human+a*rule.a+b*rule.b;
      const difference=Math.abs(a-b);
      calculation={weighted:decimal(weighted,6),difference:decimal(difference,2),meetsThreshold:weighted>=rule.pass*10000,escalated:difference>=rule.difference};
      if (!calculation.meetsThreshold) reasons.push('score_below_threshold');
      if (calculation.escalated && !events.some(x=>x.kind==='escalation' && x.revision===revision)) reasons.push('escalation_unresolved');
    }
    const topicResolutionHistory=events.filter(x=>x.kind==='topic_resolution');
    for(const group of round.groups ?? []) {
      const decision=group.currentDecision;
      if(!decision) { reasons.push(`topic_undecided:${group.id}`); continue; }
      if(decision.action!=='adopt') { reasons.push(`topic_not_adopted:${group.id}`); continue; }
      if(!topicResolutionHistory.some(x=>x.groupId===group.id && x.decisionId===decision.id && x.reviewSeq===reviewSeq)) reasons.push(`topic_unresolved:${group.id}`);
    }
    const crossConfirmations=events.filter(x=>x.kind==='cross');
    if(!['reviewerA','reviewerB'].every(actor=>crossConfirmations.some(x=>x.source===actor && x.reviewSeq===reviewSeq))) reasons.push('cross_incomplete');
    const last=decisions.at(-1);
    const currentDecision=last && last.revision===revision && last.snapshotHash===round.snapshotHash && !round.stale && (last.action === 'return' || (!reasons.length && task.status==='valid_passed')) ? last : null;
    return {roundId,revision,reviewSeq,rule:rule && {humanWeight:rule.humanWeight,aWeight:rule.aWeight,bWeight:rule.bWeight,passScore:rule.passScore,disagreement:rule.disagreement},scoreRevisions:scores,selections,calculation,topicResolutionHistory,crossConfirmations,escalationHistory:events.filter(x=>x.kind==='escalation'),reasons,decisionHistory:decisions,currentDecision,canApprove:reasons.length===0};
  }
  invalidateSync(taskId) {
    const db=this.store.db;
    const affected=db.prepare(`WITH RECURSIVE downstream(id) AS (SELECT ? UNION SELECT d.task_id FROM task_dependencies d JOIN downstream x ON d.upstream_id=x.id) SELECT id FROM downstream`).all(taskId);
    for(const {id} of affected) {
      const task=this.tasks.getTask(id);
      if(task?.status==='valid_passed') { db.prepare("UPDATE tasks SET status=? WHERE id=?").run(id===taskId?'result_received':'needs_revalidation',id); this.store.event('gate_invalidated',id,null); }
    }
  }
  invalidateTaskWithinTransaction(taskId) { this.invalidateSync(taskId); }
  reviewChangedWithinTransaction(roundId) {
    const round=this.reviews.getRound(roundId);
    this.ensure(roundId);
    this.store.db.prepare('UPDATE gates SET revision=revision+1,review_seq=review_seq+1 WHERE round_id=?').run(roundId);
    this.invalidateSync(round.taskId);
  }
  async invalidateTask(taskId) { return this.store.enqueue(async()=>{ await this.store.beforeWrite(); return this.tasks.transaction('gate_invalidation_checked',taskId,()=>this.invalidateSync(taskId)); }); }
  async mutate(roundId,kind,fn,expectedRevision) {
    return this.store.enqueue(async()=>{ await this.store.beforeWrite(); return this.tasks.transaction(kind,roundId,()=>{
      const round=this.current(roundId); this.ensure(roundId);
      const revision=this.store.db.prepare('SELECT revision FROM gates WHERE round_id=?').get(roundId).revision;
      if(expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision!==revision)) throw Error('Gate revision conflict');
      const value=fn(round);
      this.store.db.prepare('UPDATE gates SET revision=revision+1 WHERE round_id=?').run(roundId);
      this.invalidateSync(round.taskId);
      return value;
    }); });
  }
  async addScore(roundId,{source,value,evidence,expectedRevision}) {
    return this.mutate(roundId,'gate_score_added',round=>{
      if(!['human','reviewerA','reviewerB'].includes(source)) throw Error('Invalid score source');
      if(source !== 'human' && round.reviews.find(x=>x.slot===source)?.identityVerified === false) throw Error('Reviewer identity unverified');
      cents(value); evidence=required(evidence,'Evidence');
      const id=randomUUID(); this.store.db.prepare('INSERT INTO gate_scores VALUES(?,?,?,?,?,?)').run(id,roundId,source,value,evidence,now());
      this.store.db.prepare('DELETE FROM gate_score_selections WHERE round_id=? AND source=?').run(roundId,source);
      return {id,source,value};
    },expectedRevision);
  }
  async selectScore(roundId,{source,revisionId,expectedRevision}) {
    return this.mutate(roundId,'gate_score_selected',()=>{
      const score=this.store.db.prepare('SELECT id FROM gate_scores WHERE id=? AND round_id=? AND source=?').get(revisionId,roundId,source);
      if(!score) throw Error('Score revision not found');
      const latest=this.store.db.prepare('SELECT id FROM gate_scores WHERE round_id=? AND source=? ORDER BY rowid DESC LIMIT 1').get(roundId,source);
      if(latest?.id!==revisionId) throw Error('Score revision is not latest');
      this.store.db.prepare('INSERT INTO gate_score_selections VALUES(?,?,?) ON CONFLICT(round_id,source) DO UPDATE SET score_id=excluded.score_id').run(roundId,source,revisionId);
      return {source,revisionId};
    },expectedRevision);
  }
  event(roundId,kind,payload,groupId=null) {
    const gate=this.store.db.prepare('SELECT revision,review_seq FROM gates WHERE round_id=?').get(roundId);
    const revision=gate.revision+1;
    this.store.db.prepare('INSERT INTO gate_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),roundId,kind,groupId,JSON.stringify({...payload,reviewSeq:gate.review_seq}),revision,now());
  }
  async confirmCross(roundId,{actor,source,evidence,expectedRevision}) {
    return this.mutate(roundId,'gate_cross_confirmed',()=>{
      if (!['reviewerA','reviewerB','human'].includes(actor)) throw Error('Invalid cross actor');
      source=source ?? actor;
      if (!['reviewerA','reviewerB'].includes(source) || (actor !== 'human' && actor !== source)) throw Error('Invalid cross source');
      this.event(roundId,'cross',{actor,source,evidence:required(evidence,'Evidence')});
    },expectedRevision);
  }
  async resolveTopic(roundId,{groupId,evidence,reviewerPlatform,reviewerModel,reviewEvidence,fixActorPlatform,fixActorModel,verifierIdentityVerified,expectedRevision}) {
    return this.mutate(roundId,'gate_topic_resolved',round=>{
      const group=round.groups.find(x=>x.id===groupId); if(!group || group.currentDecision?.action!=='adopt') throw Error('Topic adoption required');
      evidence=required(evidence,'Evidence'); reviewerPlatform=required(reviewerPlatform,'Reviewer platform'); reviewerModel=required(reviewerModel,'Reviewer model'); reviewEvidence=required(reviewEvidence,'Review evidence');
      if(verifierIdentityVerified!==true) throw Error('Verifier identity confirmation required');
      fixActorPlatform=required(fixActorPlatform,'Fix actor platform'); fixActorModel=required(fixActorModel,'Fix actor model');
      if(/unknown|未知|未确认|待确认|不清楚/i.test(fixActorPlatform+' '+fixActorModel)) throw Error('Fix actor identity unknown');
      if(/unknown|未知|未确认|待确认|不清楚/i.test(reviewerPlatform+' '+reviewerModel)) throw Error('Reviewer identity unknown');
      const task=this.tasks.getTask(round.taskId), identity=normalize(reviewerPlatform)+'\0'+normalize(reviewerModel);
      if(identity===normalize(fixActorPlatform)+'\0'+normalize(fixActorModel)) throw Error('Verifier matches fix actor');
      if(task.handoffs.some(x=>normalize(x.actualPlatform)+'\0'+normalize(x.actualModel)===identity)) throw Error('Reviewer participated in execution');
      if(round.reviews.some(x=>normalize(x.actualPlatform)+'\0'+normalize(x.actualModel)===identity && x.identityVerified===false)) throw Error('Reviewer identity unverified');
      this.event(roundId,'topic_resolution',{decisionId:group.currentDecision.id,evidence,reviewerPlatform,reviewerModel,reviewEvidence,fixActorPlatform,fixActorModel,verifierIdentityVerified:true},groupId);
    },expectedRevision);
  }
  async resolveEscalation(roundId,{reason,evidence,expectedRevision}) { return this.mutate(roundId,'gate_escalation_resolved',()=>this.event(roundId,'escalation',{reason:required(reason,'Reason'),evidence:required(evidence,'Evidence')}),expectedRevision); }
  async decide(roundId,{action,reason,expectedRevision}) {
    if(!['approve','return'].includes(action)) throw Error('Invalid decision'); reason=required(reason,'Reason');
    return this.store.enqueue(async()=>{
      if(action==='approve') {
        this.current(roundId);
        const preflight=this.getGate(roundId);
        if(expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision!==preflight.revision)) throw Error('Gate revision conflict');
        if(preflight.currentDecision?.action==='approve') return {id:preflight.currentDecision.id,action:'approve',revision:preflight.revision,duplicate:true};
        if(!preflight.canApprove) throw Error('Gate blocked: '+preflight.reasons.join(','));
      }
      await this.store.beforeWrite();
      if(action==='approve') await this.store.backupInternal('before-gate-approval');
      return this.tasks.transaction('gate_decided',roundId,()=>{
        const round=this.current(roundId); this.ensure(roundId); const gate=this.getGate(roundId);
        if(expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision!==gate.revision)) throw Error('Gate revision conflict');
        if(action==='approve'&&!gate.canApprove) throw Error('Gate blocked: '+gate.reasons.join(','));
        const id=randomUUID(); this.store.db.prepare('INSERT INTO gate_decisions VALUES(?,?,?,?,?,?,?)').run(id,roundId,action,reason,gate.revision,round.snapshotHash,now());
        if(action==='approve') this.store.db.prepare("UPDATE tasks SET status='valid_passed' WHERE id=?").run(round.taskId);
        else this.invalidateSync(round.taskId);
        return {id,action,revision:gate.revision};
      });
    });
  }
}
