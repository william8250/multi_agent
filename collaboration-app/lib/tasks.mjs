import { randomUUID, createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const timestamp = () => new Date().toISOString();
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${label} required`);
  return value.trim();
};

export class TaskStore {
  constructor(store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, stage TEXT NOT NULL, requirement TEXT NOT NULL,
        acceptance TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
        selected_receipt_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id), upstream_id TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY(task_id, upstream_id)
      );
      CREATE TABLE IF NOT EXISTS task_packages (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL,
        version INTEGER NOT NULL, input_hash TEXT NOT NULL, markdown TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_handoffs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        package_id TEXT NOT NULL REFERENCES task_packages(id), actual_platform TEXT NOT NULL,
        actual_model TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_receipts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        package_id TEXT NOT NULL REFERENCES task_packages(id), version INTEGER NOT NULL,
        input_hash TEXT NOT NULL, raw TEXT NOT NULL, content_hash TEXT NOT NULL,
        actual_platform TEXT NOT NULL, actual_model TEXT NOT NULL, source_evidence TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(package_id, content_hash)
      );
      CREATE TABLE IF NOT EXISTS task_selections (
        package_id TEXT PRIMARY KEY REFERENCES task_packages(id),
        receipt_id TEXT NOT NULL REFERENCES task_receipts(id)
      );
      CREATE TABLE IF NOT EXISTS task_selection_invalidations (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        package_id TEXT NOT NULL REFERENCES task_packages(id),
        previous_receipt_id TEXT NOT NULL REFERENCES task_receipts(id),
        reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_resolutions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        receipt_id TEXT NOT NULL REFERENCES task_receipts(id), reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }
  transaction(event, id, fn) {
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.store.event(event, id, null);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  async write(event, id, fn) {
    return this.store.enqueue(async () => {
      await this.store.beforeWrite();
      return this.transaction(event, id, fn);
    });
  }
  getOptions(projectId) {
    const project = this.store.getProject(projectId);
    if (!project) throw Error('Project not found');
    const models = project.config.models || [];
    return { stages: (project.config.stages || []).map(stage => {
      const roles = {};
      for (const role of ['primary', 'support', 'reviewerA', 'reviewerB']) {
        const model = models.find(item => item.id === stage[role]);
        roles[role] = model && model.id && model.platform && model.name
          ? { id: model.id, platform: model.platform, name: model.name } : null;
      }
      return { id: stage.id, roles };
    }) };
  }
  listTasks(projectId) {
    const sql = 'SELECT id,project_id AS projectId,title,stage,version,status,selected_receipt_id AS selectedReceiptId,created_at AS createdAt FROM tasks';
    const rows = projectId
      ? this.store.db.prepare(sql + ' WHERE project_id=? ORDER BY created_at').all(projectId)
      : this.store.db.prepare(sql + ' ORDER BY created_at').all();
    return rows.map(row => ({ ...row }));
  }
  getTask(id) {
    const db = this.store.db;
    const row = db.prepare('SELECT id,project_id AS projectId,title,stage,requirement,acceptance,version,status,selected_receipt_id AS selectedReceiptId,created_at AS createdAt FROM tasks WHERE id=?').get(id);
    if (!row) return null;
    return { ...row,
      dependencies: db.prepare('SELECT upstream_id FROM task_dependencies WHERE task_id=? ORDER BY upstream_id').all(id).map(x => x.upstream_id),
      packages: db.prepare('SELECT id,task_id AS taskId,role,version,input_hash AS inputHash,markdown,created_at AS createdAt FROM task_packages WHERE task_id=? ORDER BY rowid').all(id).map(x => ({ ...x, round: 1 })),
      handoffs: db.prepare('SELECT id,package_id AS packageId,actual_platform AS actualPlatform,actual_model AS actualModel,evidence,created_at AS createdAt FROM task_handoffs WHERE task_id=? ORDER BY rowid').all(id).map(x => ({ ...x })),
      receipts: db.prepare('SELECT id,package_id AS packageId,version,input_hash AS inputHash,raw,content_hash AS contentHash,actual_platform AS actualPlatform,actual_model AS actualModel,source_evidence AS sourceEvidence,created_at AS createdAt FROM task_receipts WHERE task_id=? ORDER BY rowid').all(id).map(x => ({ ...x })),
      selections: db.prepare('SELECT s.package_id AS packageId,s.receipt_id AS receiptId FROM task_selections s JOIN task_packages p ON p.id=s.package_id WHERE p.task_id=? ORDER BY p.rowid').all(id).map(x=>({...x})),
      resolutions: db.prepare('SELECT id,receipt_id AS receiptId,reason,created_at AS createdAt FROM task_resolutions WHERE task_id=? ORDER BY rowid').all(id).map(x=>({...x})),
      invalidations: db.prepare('SELECT id,package_id AS packageId,previous_receipt_id AS previousReceiptId,reason,created_at AS createdAt FROM task_selection_invalidations WHERE task_id=? ORDER BY rowid').all(id).map(x=>({...x}))
    };
  }
  mustTask(id, version) {
    const task = this.getTask(id);
    if (!task) throw Error('Task not found');
    if (version !== undefined && version !== task.version) throw Error('Task version conflict');
    return task;
  }
  requireVersion(task, version) {
    if (!Number.isInteger(version) || version !== task.version) throw Error('Task version conflict');
  }
  checkDependencies(taskId, projectId, dependencies) {
    if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length) throw Error('Invalid dependencies');
    const db = this.store.db;
    for (const upstream of dependencies) {
      const row = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(upstream);
      if (!row || row.project_id !== projectId || upstream === taskId) throw Error('Invalid dependency');
      const cycle = db.prepare(`WITH RECURSIVE ancestors(id) AS (
        SELECT upstream_id FROM task_dependencies WHERE task_id=?
        UNION SELECT d.upstream_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id
      ) SELECT 1 FROM ancestors WHERE id=?`).get(upstream, taskId);
      if (cycle) throw Error('Dependency cycle');
    }
  }
  checkReady(task) {
    for (const id of task.dependencies) {
      const upstream = this.mustTask(id);
      if(this.readinessPolicy?.(upstream)?.length)throw Error('Upstream not passed');
      if (upstream.status !== 'valid_passed') throw Error('Upstream not passed');
    }
  }
  async createTask(args) {
    const id=randomUUID();
    return this.write('task_created',id,()=>this.createTaskWithinTransaction(args,id));
  }
  createTaskWithinTransaction({projectId,title,stage,requirement,acceptance,dependencies=[]},id=randomUUID()) {
    if(!this.store.db.isTransaction)throw Error('Task transaction required');
    if(!this.store.getProject(projectId))throw Error('Project not found');
    if(!this.store.configVersion(projectId).isLatest)throw Error('Historical configuration');
    required(title,'Title');required(stage,'Stage');required(requirement,'Requirement');required(acceptance,'Acceptance');
    if(!this.getOptions(projectId).stages.some(x=>x.id===stage))throw Error('Stage not found');
    this.checkDependencies(id,projectId,dependencies);
    this.store.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,1,?,?,?)').run(id,projectId,title,stage,requirement,acceptance,'draft',null,timestamp());
    for(const upstream of dependencies)this.store.db.prepare('INSERT INTO task_dependencies VALUES(?,?)').run(id,upstream);
    return this.getTask(id);
  }
  async setDependencies(id, { dependencies, expectedVersion }) {
    return this.write('task_dependencies_changed', id, () => {
      const task = this.mustTask(id); this.requireVersion(task, expectedVersion);
      if (task.packages.length || task.status !== 'draft') throw Error('Task already started');
      this.checkDependencies(id, task.projectId, dependencies);
      this.store.db.prepare('DELETE FROM task_dependencies WHERE task_id=?').run(id);
      for (const upstream of dependencies) this.store.db.prepare('INSERT INTO task_dependencies VALUES(?,?)').run(id, upstream);
      this.store.db.prepare('UPDATE tasks SET version=version+1 WHERE id=?').run(id);
      return this.getTask(id);
    });
  }
  async preparePackage(id, { role, expectedVersion }) {
    return this.write('package_prepared', id, () => {
      const task = this.mustTask(id);this.executionPolicy?.(task); this.requireVersion(task, expectedVersion); this.checkReady(task);
      if (['reviewerA', 'reviewerB'].includes(role)) throw Error('Review module not available');
      if (!['primary', 'support'].includes(role)) throw Error('Invalid role');
      const stage = this.getOptions(task.projectId).stages.find(x => x.id === task.stage);
      const identity = stage?.roles[role]; if (!identity) throw Error('Role identity unknown');
      const project = this.store.getProject(task.projectId);
      const frozen = { taskId: id, version: task.version, projectSourceHash: project.sourceHash, stage: task.stage, dependencies: [...task.dependencies].sort(), role, title: task.title, requirement: task.requirement, acceptance: task.acceptance, identity };
      const inputHash = digest(JSON.stringify(frozen));
      const existing = task.packages.find(x => x.role === role && x.version === task.version && x.inputHash === inputHash);
      if (existing) return existing;
      const packageId = randomUUID();
      const markdown = `# ${task.title}\n\n任务包 ID: ${packageId}\n任务 ID: ${id}\n轮次: 1\n版本: ${task.version}\n输入摘要: ${inputHash}\n角色: ${role}\n期望平台: ${identity.platform}\n期望模型: ${identity.name}\n期望模型 ID: ${identity.id}\n上述身份是期望配置，不代表已调用。\n\n## 需求\n${task.requirement}\n\n## 验收\n${task.acceptance}\n`;
      const pkg = { id: packageId, taskId: id, role, round: 1, version: task.version, inputHash, markdown, createdAt: timestamp() };
      this.store.db.prepare('INSERT INTO task_packages VALUES(?,?,?,?,?,?,?)').run(pkg.id,id,role,task.version,inputHash,markdown,pkg.createdAt);
      this.refreshStatus(id);
      return pkg;
    });
  }
  packageFor(task, packageId) {
    const pkg = task.packages.find(x => x.id === packageId);
    if (!pkg || pkg.version !== task.version) throw Error('Package version conflict');
    return pkg;
  }
  async confirmHandoff(taskId, { packageId, actualPlatform, actualModel, evidence, confirmed, inFlight = false, submittedAt }) {
    return this.write('handoff_confirmed', taskId, () => {
      const task = this.mustTask(taskId); const pkg = this.packageFor(task, packageId);
      let hold; if(this.handoffPolicy)hold=this.handoffPolicy(task,pkg,{inFlight,submittedAt});else {if(inFlight)throw Error('In-flight policy unavailable');this.checkReady(task);}
      if (!['primary','support'].includes(pkg.role)) throw Error('Review module not available');
      if (confirmed !== true) throw Error('Confirmation required');
      actualPlatform = required(actualPlatform, 'Platform'); actualModel = required(actualModel, 'Model'); evidence = required(evidence, 'Evidence');
      if(inFlight)evidence=`补登记在途提交；声明实际提交时间 ${submittedAt}；对应暂停 ${hold.id}@${hold.held_at}；${evidence}`;
      if (/^(unknown|未知|待确认)$/i.test(actualPlatform.trim()) || /^(unknown|未知|待确认)$/i.test(actualModel.trim())) throw Error('Identity unknown');
      this.store.db.prepare('INSERT INTO task_handoffs VALUES(?,?,?,?,?,?,?)').run(randomUUID(),taskId,pkg.id,actualPlatform,actualModel,evidence,timestamp());
      this.refreshStatus(taskId);
      return this.getTask(taskId);
    });
  }
  async importResult(taskId, { packageId, raw, actualPlatform, actualModel, sourceEvidence }) {
    return this.write('result_received', taskId, () => {
      const task = this.mustTask(taskId); const pkg = this.packageFor(task, packageId);
      if (!['primary','support'].includes(pkg.role)) throw Error('Review module not available');
      required(raw, 'Result'); actualPlatform = required(actualPlatform, 'Platform'); actualModel = required(actualModel, 'Model'); sourceEvidence = required(sourceEvidence, 'Evidence');
      if (Buffer.byteLength(raw) > 1024*1024) throw Error('Result too large');
      if (/^(unknown|未知|待确认)$/i.test(actualPlatform.trim()) || /^(unknown|未知|待确认)$/i.test(actualModel.trim())) throw Error('Identity unknown');
      const handoff = task.handoffs.find(x => x.packageId === packageId && x.actualPlatform === actualPlatform && x.actualModel === actualModel);
      if (!handoff) throw Error('Matching handoff required');
      const contentHash = digest(raw);
      const duplicate = task.receipts.find(x => x.packageId === packageId && x.contentHash === contentHash);
      if (duplicate) return { ...duplicate, duplicate: true };
      const id = randomUUID();
      this.store.db.prepare('INSERT INTO task_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,taskId,packageId,pkg.version,pkg.inputHash,raw,contentHash,actualPlatform,actualModel,sourceEvidence,timestamp());
      const count = this.store.db.prepare('SELECT count(*) AS n FROM task_receipts WHERE package_id=?').get(packageId).n;
      if (count === 1) {
        this.store.db.prepare('INSERT INTO task_selections VALUES(?,?)').run(packageId,id);
      } else {
        const previous = task.selections.find(x => x.packageId === packageId);
        if (previous) {
          this.store.db.prepare('INSERT INTO task_selection_invalidations VALUES(?,?,?,?,?,?)').run(randomUUID(),taskId,packageId,previous.receiptId,'new conflicting result',timestamp());
          this.store.event('selection_invalidated', taskId, null);
        }
        this.store.db.prepare('DELETE FROM task_selections WHERE package_id=?').run(packageId);
      }
      this.refreshStatus(taskId);
      return { ...this.getTask(taskId).receipts.find(x => x.id === id), duplicate: false };
    });
  }
  refreshStatus(taskId) {
    const task = this.getTask(taskId);
    const unresolved = task.packages.some(pkg =>
      task.receipts.filter(x => x.packageId === pkg.id).length > 1 &&
      !task.selections.some(x => x.packageId === pkg.id));
    const primary = task.packages.find(x => x.role === 'primary' && x.version === task.version);
    const selected = task.selections.find(x => x.packageId === primary?.id)?.receiptId ?? null;
    const primaryHandoff = primary && task.handoffs.some(x => x.packageId === primary.id);
    const supportResult = task.receipts.some(x => task.packages.some(p => p.id === x.packageId && p.role === 'support'));
    const status = unresolved ? 'needs_resolution' : selected ? 'result_received' : primaryHandoff ? 'submitted' : supportResult ? 'awaiting_primary' : primary ? 'ready' : 'draft';
    this.store.db.prepare('UPDATE tasks SET status=?,selected_receipt_id=? WHERE id=?').run(status, selected, taskId);
  }
  async resolveResult(taskId, { receiptId, reason }) {
    return this.write('result_resolved', taskId, () => {
      const task = this.mustTask(taskId); required(reason, 'Reason');
      const receipt = task.receipts.find(x => x.id === receiptId && x.version === task.version);
      if (!receipt || !task.packages.some(x => x.id === receipt.packageId && x.inputHash === receipt.inputHash && x.version === task.version)) throw Error('Receipt version conflict');
      this.store.db.prepare('INSERT INTO task_resolutions VALUES(?,?,?,?,?)').run(randomUUID(),taskId,receiptId,reason,timestamp());
      this.store.db.prepare('INSERT INTO task_selections VALUES(?,?) ON CONFLICT(package_id) DO UPDATE SET receipt_id=excluded.receipt_id').run(receipt.packageId,receiptId);
      this.refreshStatus(taskId);
      return this.getTask(taskId);
    });
  }
}
