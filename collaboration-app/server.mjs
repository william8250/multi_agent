import {SourceApplications} from './lib/source-applications.mjs';
import {runFunctionalTests} from './lib/functional-runner.mjs';
import {requirementTrace} from './lib/requirement-trace.mjs';
import {WorkBuddyOAuth} from './lib/workbuddy-oauth.mjs';
import {platformCapabilities} from './lib/platform-adapters.mjs';
import {ReviewExecutor} from './lib/review-executor.mjs';
import {Scheduler} from './lib/scheduler.mjs';
import {UIApplier} from './lib/ui-patches.mjs';
import {CommentJobs} from './lib/comment-jobs.mjs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TaskStore } from './lib/tasks.mjs';
import { ReviewStore } from './lib/reviews.mjs';
import { GateStore } from './lib/gates.mjs';
import { PlanStore } from './lib/plans.mjs';
import { UserConsole } from './lib/console.mjs';
import { ExecutionStore } from './lib/executions.mjs';
import { artifactForTask, artifactZip, diffArtifacts } from './lib/artifacts.mjs';
import { WorkspaceStore } from './lib/workspaces.mjs';
import { CandidateTests } from './lib/candidate-tests.mjs';

const developmentComments=process.env.NODE_ENV!=='production'&&process.env.COLLAB_DEV_COMMENTS!=='0';
const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([['/prototype-review',['prototype-review.html','text/html; charset=utf-8']],['/prototype-review.js',['prototype-review.js','text/javascript; charset=utf-8']],['/prototype-review.css',['prototype-review.css','text/css; charset=utf-8']],['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/tasks.js', ['tasks.js', 'text/javascript; charset=utf-8']], ['/artifacts.js', ['artifacts.js', 'text/javascript; charset=utf-8']], ['/workspaces.js', ['workspaces.js', 'text/javascript; charset=utf-8']], ['/reviews.js', ['reviews.js', 'text/javascript; charset=utf-8']], ['/gates.js', ['gates.js', 'text/javascript; charset=utf-8']], ['/user.js', ['user.js', 'text/javascript; charset=utf-8']], ['/plans.js',['plans.js','text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const MAX_BODY = 16 * 1024 * 1024;
const failure = (status, message) => Object.assign(new Error(message), { status });
const storeErrors = {
  'Test runner busy or interruption unresolved':'已有测试在运行，或上次进程状态尚未核实。请等待，或在测试记录中登记进程已停止的实际依据。',
  'Test inspection basis required':'代码检查声明未确认，或摘要与当前候选不一致。请重新核对全部候选代码和测试后填写。',
  'Test inspection inspector required':'请登记实际检查代码的 Agent 或人员。',
  'Test inspection evidence required':'请填写实际检查范围、结论和来源依据，不能将未发生的检查记为完成。',
  'Test inspection process-stop evidence required':'请填写核实旧测试进程已停止的依据；不会自动终止未核实的旧 PID。',
  'Test syntax validation required':'请先对当前候选执行并通过 JavaScript 语法检查，再运行功能测试。',
  'No supported candidate tests':'当前候选没有支持的 JavaScript 测试文件。请补充测试产物；不会安装依赖或运行自定义命令。',
  'Test run not found':'测试记录不存在，请刷新任务。',
  'Test run is not running':'本次测试已结束，请刷新后查看结果。',
  'Test interruption not resolvable':'本次测试不属于待核实的历史中断，请刷新记录。',
  'Test runner stopping':'测试执行器正在停止，请稍后重试。',
  'Workspace local root required':'开发配置的共同项目根目录需为完整本地路径；远程 URL 暂不自动拉取。请到开发前配置台保存新版本。',
  'Workspace concrete root required':'共同项目根目录必须是具体项目文件夹，不能是个人主目录或其上级。',
  'Workspace root unavailable':'配置的本地项目目录不存在或不可读取，请核对完整路径。',
  'Workspace data overlaps source':'项目源目录与协作台资料目录重叠。请把资料目录放在源项目之外，再生成独立候选工作区。',
  'Workspace protected path':'候选涉及受保护目录、凭据文件或暂不支持的文本类型。不会读取这些源文件，请拆分任务。',
  'Workspace unsafe path':'源文件或独立目录含链接、非普通文件或不安全路径。已停止复制，原项目未改动。',
  'Workspace source changed':'捕获期间源文件发生变化，请核对当前修改后重新生成基线。',
  'Workspace source too large':'候选涉及的源文本超过限制：每个 256KB、总计 512KB，请拆分任务。',
  'Workspace source not text':'源文件不是可安全读取的 UTF-8 文本，未建立候选工作区。',
  'Workspace selected primary required':'请先选用一份有效的主执行代码文件包；未解决的冲突不能建立工作区。',
  'Workspace candidate not found':'候选工作区不存在，请刷新任务记录。',
  'Workspace basis stale':'源文件、候选副本或任务方向已变化。请核对差异并重新生成候选基线。',
  'Workspace validation required':'候选工作区尚未完成有效语法核查，或文件基线已变化。请到任务页工作区处理后，再发起或提交评审。',
  'Workspace validation stopping':'工作区校验器正在停止，请稍后再试。',
  'Artifact receipt not found':'未找到属于本任务的原始回执，请刷新记录。',
  'Artifact source corrupt':'代码产物的来源摘要不一致，已停止导出；请保留原资料核查。',
  'Artifact path invalid':'候选文件路径无效。请使用普通相对路径，不能包含 ..、反斜杠、系统保留名或 .git。原始回执仍保留。',
  'Artifact path duplicated':'候选文件路径重复、大小写冲突或文件与目录冲突。请协调方重新生成明确的文件清单。',
  'Artifact files invalid':'候选文件包需包含 1–30 个带 path 和文本 content 的文件。原始回复保留，可继续按文本评审。',
  'Artifact too large':'候选文件超过限制：每个 256KB、总计 512KB。请拆成更小的任务。',
  'Artifact unavailable':'此回复不是规范的代码文件包。可查看原文；生成代码候选文件后再下载。',
  'Artifact comparison invalid':'请选择同一任务的两份有效代码文件包进行比较。',
  'Execution output format invalid':'输出格式无效，请选择普通分析或代码候选文件。',
  'Execution format conflict':'这个任务包已按另一种格式启动。为避免重复消耗额度，不会重跑；需要代码文件包时请建立新的明确任务。',
  'Execution not found':'运行记录不存在，请刷新重试。',
  'Execution stopping':'本机执行器正在停止或任务已被取消。',
  'Execution busy':'已有本机任务正在运行；为控制额度，请等待结束后再分发。',
  'Execution orphan unresolved':'有重启中断任务尚未核对进程。请先核查其 PID 和工作目录，确认停止并登记证据，再启动本机任务。',
  'Execution recovery invalid':'恢复处置需要终止状态、原因或停止核查证据；不会静默重新运行旧任务包。',
  'Execution already handed off':'这个任务包已有提交或结果，请继续原交接，避免重复执行。',
  'Execution platform unsupported':'这个角色未配置为 Codex，请使用对应平台的应用操作接力。',
  'Execution model unmapped':'配置中的型号暂不能转换为 Codex CLI 型号；请核实配置，不会自动换模型。',
  'Execution result unavailable':'没有可完整回收的成功结果。请核对运行日志，不要重复启动原任务包。',
  'Plan fields invalid':'请完整填写计划目标、范围、验收、风险及真实来源。',
  'Plan not found':'计划不存在，请刷新后重试。',
  'Plan source invalid':'计划需要绑定原始想法及同一项目，请检查来源。',
  'Plan source superseded':'这条输入早于最新方向调整，请使用新方向输入重新整理。',
  'Plan already launched':'该输入已有已确认计划，请通过新反馈或方向调整提出变更。',
  'Plan steps invalid':'拆解需为 1–12 项，key 必须唯一且只含字母、数字、下划线或横线。',
  'Plan dependencies invalid':'任务依赖必须引用本计划前面已定义的 key，不能重复或循环。',
  'Plan response invalid':'请选择确认或提出修改，并检查说明长度。',
  'Plan change reason required':'请说明希望怎样调整计划。',
  'Plan already answered':'计划已被处理，请刷新；改方向请使用方向调整。',
  'Plan stale':'计划依据已变更或已有新版，请让协调方重新整理后再确认。',
  'Plan task invalid':'只有已确认计划中的任务才能准备交接包。',
  'Configuration revision required':'缺少配置版本依据，请重新加载已有配置。',
  'Configuration revision conflict':'已有更新版本或依据不一致。请保留当前草稿，加载最新版后合并修改。',
  'Configuration rename refused':'修改配置版本时请保留项目名；如需新项目，请选择新建。',
  'Configuration snapshot conflict':'该配置原文已属于其他历史版本，请加载最新版后修改。',
  'Configuration controls migration required':'检测到预发布版本的旧控制记录。为保留暂停及在途证据，已停止启动；请先迁移记录，勿删除或覆盖原库。',
  'Historical configuration':'不能在历史配置上新建任务，请选择最新配置版本；旧任务仍保留原依据。',
  'Configuration held':'项目有暂停或待决策事项，请先在用户态处理，再保存新配置版本。',
  'Invalid JSON': 'JSON 格式损坏，请重新从原配置入口导出。',
  'Invalid configuration size': '配置大小不正确，请减少附件后重新导出。',
  'Invalid configuration schema': '配置结构不完整，需要原入口导出的 1.0 版 JSON。',
  'Invalid skill': 'skill 记录损坏，请在原入口重新添加后导出。',
  'Invalid skill filename': 'skill 文件名不能含目录或路径，请重新选择文件。',
  'Invalid base64': 'ZIP 原包编码损坏，请在原入口重新添加 ZIP 后导出。',
  'Invalid ZIP': 'ZIP 原包格式不正确，请重新添加有效 ZIP。',
  'ZIP too large': 'ZIP 超过 10MB，请缩小后重新导出。',
  'Text too large': 'skill 文本超过 1MB，请缩小后重新导出。',
  'Invalid skill encoding': 'skill 文件格式不支持，请重新添加文本文件或 ZIP。',
  'Skill size mismatch': 'skill 原包大小与记录不一致，请重新添加该文件后导出。',
  'Skills too large': 'skill 原包总计超过 10MB，请减少附件后导出。',
  'Backup not found': '未找到此备份，请刷新备份列表。',
  'Object corrupt': '本地文件校验失败，已停止操作。请保留当前数据并检查可用备份。',
  'Existing object corrupt': '本地已有文件校验失败，已停止导入。请保留原配置并检查备份。',
  'Symbolic links are not allowed': '数据目录或文件含符号链接，请使用实际本地目录后重试。',
  'Disk space insufficient': '磁盘空间不足，已停止操作并保留原数据。请先释放空间，再重试；正式备份不会自动删除。',
  'Data directory in use': '此资料目录正由另一协作台使用，请关闭该实例后重试。异常退出遗留锁时需先确认原进程已结束。',
  'Project name conflict': '已有同名项目，但配置内容不同。当前不会覆盖；如需另建项目，请在原入口明确更改项目名后重新导出，或取消导入。',
  'Project not found': '未找到项目，请先导入开发配置。',
  'Task not found': '未找到任务，请刷新任务列表。',
  'Stage not found': '此阶段不在项目配置中，请重新选择。',
  'Task version conflict': '任务版本已变化，请刷新后重新操作。',
  'Invalid dependencies': '上游任务列表不正确或重复，请重新选择。',
  'Invalid dependency': '上游任务必须属于同一项目，且不能选择任务自身。',
  'Dependency cycle': '这些任务形成循环依赖，请移除一条上游关系。',
  'Upstream not passed': '上游任务尚未有效验收通过，当前不能交接。结果已回收不等于通过；请先完成上游人工验收裁决。',
  'Task already started': '已准备任务包后不能更改依赖，请保留原任务并另建任务。',
  'Invalid task state': '当前任务状态不支持此操作，请刷新任务详情。',
  'Invalid role': '请选择主执行或配合执行。',
  'Role identity unknown': '此阶段的执行模型未配置，不能生成任务包。请先核对项目分工。',
  'Package version conflict': '任务包不属于当前任务版本，请重新准备当前版本的任务包。',
  'Confirmation required': '请确认已经在目标应用提交；下载任务包不能当作已提交。',
  'Identity unknown': '实际平台和模型仍未知，请查看目标应用后如实填写。',
  'Review module not available': '此处只交接执行结果。请到“独立评审与复核”页生成专用评审包。',
  'Result too large': '结果正文超过1MB，请精简后导入；保留完整原件。',
  'Matching handoff required': '尚无匹配的提交确认。请先登记此任务包的实际平台与模型，结果身份须与确认一致。',
  'Receipt version conflict': '此结果与当前任务包版本不匹配，不能选用。',
  'Round version conflict': '评审记录已变化，请刷新并核对当前轮后再重新收集。',
  'Round not found': '未找到评审轮，请刷新列表。',
  'Selected primary result required': '请先回收并选定主执行结果，解决所有内容冲突后再发起评审。',
  'Selection invalid': '当前选用结果无法匹配原文，请返回任务页核对。',
  'Reviewer identity unknown': '两方评审模型尚未完整配置，请先核对本阶段的评审分工。',
  'Review round stale': '评审依据已变化，本轮已过期。请在任务页选定当前结果，再发起新评审；历史原文和决定保留。',
  'Independent reviews incomplete': '两方独立意见尚未齐全。请分别提交后再交叉讨论或人工复核。',
  'Invalid reviewer slot': '请选择评审 A 或评审 B。',
  'Independent identity required': '请填写已核实的实际身份并确认未参与实现；未核实时可取消模型已核对勾选，仅归档参考，不能评分通过。',
  'Reviewer participated in execution': '该平台与模型已登记参与本任务执行，不能独立评审自己的产物。请换独立评审方。',
  'Reviewer identity duplicated': '两方评审不能使用同一个实际平台与模型，请安排另一独立评审方。',
  'Review binding mismatch': '这份意见的轮次、任务版本或目标结果不匹配，请重新核对评审任务包。',
  'Review slot locked': '这份独立意见已提交锁定，不能覆盖。双方齐全后可追加交叉补充，原文保留。',
  'Invalid review raw': '请提供非空、最多1MB的评审原文。',
  'Invalid review items': '请提供1至30条结构化意见，或读取任务包要求的JSON回复。',
  'Invalid review item': '意见的判断或严重程度不正确，请检查结构化内容。',
  'Invalid actor': '请选择评审 A、评审 B 或人工负责人。',
  'Review round incomplete or stale': '本轮缺少意见或依据已过期，请先收齐当前版意见。',
  'Invalid decimal': '请填写0至100的十进制数字，最多两位小数，不接受空值或科学计数法。',
  'Invalid score source': '请选择人工、评审A或评审B。',
  'Reviewer identity unverified': '该方实际模型尚未核验，只能作为参考意见，不能录入有效评分。请核实后在新轮回收。',
  'Gate revision conflict': '评分或裁决依据已更新，请刷新并核对当前版本后重试。',
  'Score revision not found': '未找到本来源的评分修订，请重新选择。',
  'Score revision is not latest': '只能选用此来源最新的评分，旧分保留为历史。',
  'Invalid cross actor': '请填写交叉确认来自哪一方或人工负责人。',
  'Invalid cross source': '请明确确认的是A方还是B方的交叉，不能冒充另一方。',
  'Topic adoption required': '请先在主题比较中由人工采纳建议，再提交落实和独立复核证据。',
  'Reviewer platform required': '请填写独立复核者的平台。',
  'Reviewer model required': '请填写独立复核者已核对的模型。',
  'Review evidence required': '请填写独立复核的实际来源及结论依据。',
  'Verifier identity confirmation required': '请先核对独立复核者的实际身份并勾选确认。',
  'Fix actor platform required': '请填写实际修复或落实责任方的平台。',
  'Fix actor model required': '请填写实际修复或落实责任方的模型或人员。',
  'Fix actor identity unknown': '落实责任方仍未知，请核查后填写，不得猜测。',
  'Verifier matches fix actor': '修复责任方不能独立复核自己的修复，请换未参与修复的核查方。',
  'User revision conflict': '项目或决策已更新，请刷新后核对当前状态再操作。',
  'User request required': '请先用一句话描述你的想法或需要调整的方向。',
  'Request key required': '提交标识缺失，请刷新后重试。',
  'Invalid reference': '参考信息过长，请精简到2000字以内。',
  'Invalid user request kind': '请选择想法、纠偏或体验反馈。',
  'User request conflict': '这次提交的内容已改变，请重新提交；原记录会保留。',
  'Project required': '请先选择需要调整方向的项目。',
  'User request not found': '未找到这条请求，请刷新后重试。',
  'User request already acknowledged': '该请求已处理，原处理记录保留；请追加新反馈。',
  'Plan required': '请写明协调方更新后的计划。',
  'Invalid control action': '请选择暂停或继续。',
  'Replan not acknowledged': '新方向尚未由协调方确认并更新计划，暂不能恢复分发。原文回收仍可继续。',
  'Invalid decision options': '决策需有2至4个不同选项，说明影响，并指定其中一个为推荐。',
  'Invalid decision task': '关联任务必须属于同一项目。',
  'Question required': '请填写需要用户决定的问题。',
  'Option id required': '选项标识不能为空。',
  'Option label required': '请填写选项名称。',
  'Option impact required': '请说明该选项的影响。',
  'Invalid in-flight time': '请填写任务包准备之后、暂停之前已经发生的提交时间，不能填未来时间。',
  'In-flight hold evidence missing': '没有匹配的暂停或待决策记录，不能按在途提交补登记。新分发仍须先解除暂停。',
  'In-flight policy unavailable': '当前未接入在途登记检查，请先恢复本地协作台。',
  'User decision stale': '这个问题属于旧方向，请查看当前方向的决策卡。',
  'Decision not found': '未找到决策事项，请刷新。',
  'User reply required': '补充说明过长，请精简到8000字以内。',
  'Invalid decision choice': '请选择本问题中的一个选项，也可以先在下方补充说明。',
  'Invalid preview URL': '成果地址仅支持不含用户名和密码的HTTP/HTTPS链接，不会自动执行或抓取。',
  'Headline required': '请填写进度摘要标题。',
  'Progress required': '请说明实际进展、当前阻塞和下一步。',
  'Preview title required': '请填写成果名称。',
  'Preview summary required': '请说明本次成果可以体验什么及已知问题。',
  'Invalid decision': '请选择人工批准或退回，并填写理由。',
  'Invalid action': '请选择采纳建议、退回修改或要求澄清。',
  'Invalid evidence': '证据应为文字引用，不应为对象或可执行内容。',
  'Topic not found': '这个主题不属于当前评审，请刷新对照页。',
  ...Object.fromEntries([['Conclusion','评审结论'],['Topic','意见主题'],['Detail','具体依据'],['Suggestion','处理建议'],['Comment','交叉补充']].map(([key,label])=>[`${key} required`, `请填写${label}。`])),
  ...Object.fromEntries([['Platform','平台'],['Model','模型'],['Evidence','来源依据'],['Conclusion','结论摘要'],['Topic','主题'],['Detail','依据'],['Suggestion','建议'],['Comment','交叉补充'],['Reason','理由']].map(([key,label])=>[`${key} too long`, `${label}过长，请精简后重试，并保留完整原件。`])),
  ...Object.fromEntries([['Title','任务标题'],['Stage','开发阶段'],['Requirement','任务需求'],['Acceptance','验收要求'],['Platform','实际平台'],['Model','实际模型'],['Evidence','来源证据'],['Result','结果正文'],['Reason','选用理由']].map(([key,label])=>[`${key} required`, `请填写${label}。`])),
};

export function createAppServer(store, executionOptions = {}) {
  const tasks = new TaskStore(store);
  const reviews = new ReviewStore(store, tasks);
  const gates = new GateStore(store, tasks, reviews);
  const userConsole=new UserConsole(store,tasks,reviews,gates);reviews.dispatchPolicy=task=>userConsole.assertExecution(task);
  const plans=new PlanStore(store,tasks,userConsole);
  const executions=new ExecutionStore(store,tasks,userConsole,executionOptions);
  const reviewExecutor=new ReviewExecutor(store,reviews,userConsole,executions,{runner:executionOptions.reviewRunner});reviewExecutor.start();executions.externalBusy=()=>reviewExecutor.busy||reviewExecutor.list().some(j=>j.status==='interrupted'&&!j.interruptionResolution);
  const scheduler=new Scheduler(store,tasks,userConsole,executions);scheduler.start();
  const commentJobs=new CommentJobs(store,tasks,userConsole,executions,developmentComments?new UIApplier(publicRoot,store.root,{projectId:store.listProjects().find(p=>p.isLatest&&p.name.includes('vibecoding'))?.id||'unconfigured-development-project',probe:async()=>{const base=`http://127.0.0.1:${server.address().port}`;for(const name of ['/','/style.css']){const r=await fetch(base+name,{signal:AbortSignal.timeout(5000)});if(!r.ok||!(await r.text()).trim())return {ok:false};}return {ok:true,scope:'首页与样式 HTTP 可访问；不代表交互或视觉验收'};}}):null);if(developmentComments)commentJobs.start();
  const workspaces=new WorkspaceStore(store,tasks,userConsole,{checkSyntax:executionOptions.workspaceCheckSyntax});
  const sourceApplications=new SourceApplications(path.join(store.root,'source-applications'));
  const candidateTests=new CandidateTests(store,tasks,userConsole,workspaces,{runner:executionOptions.functionalTestRunner});workspaces.tests=candidateTests;
  store.revisionPolicy=id=>{const state=userConsole.state(id);if(state.paused||userConsole.decisions(id).some(d=>d.current&&d.blocking&&!d.answers.length))throw Error('Configuration held');};
  reviews.goalBasis=projectId=>userConsole.state(projectId).epoch;
  gates.policyReasons=task=>[...userConsole.taskReasons(task),...workspaces.policyReasons(task)];
  reviews.workspaceBasis=task=>workspaces.reviewBasis(task);
  reviews.workspacePolicyReasons=task=>workspaces.policyReasons(task);
  reviews.workspaceAppendix=task=>workspaces.reviewAppendix(task);
  tasks.readinessPolicy=task=>workspaces.policyReasons(task);
  tasks.handoffPolicy=(task,pkg,args)=>userConsole.handoffPolicy(task,pkg,args);
  const transact = tasks.transaction.bind(tasks);
  tasks.transaction = (event, id, fn) => transact(event,id,()=>{
    if(['package_prepared'].includes(event))userConsole.assertExecution(tasks.mustTask(id));
    const result=fn();
    if(event==='task_created')userConsole.capture(tasks.mustTask(id));
    if (['handoff_confirmed','result_received','result_resolved','task_dependencies_changed','review_round_restarted','workspace_candidate_prepared'].includes(event)&&!(event==='workspace_candidate_prepared'&&result?.duplicate)) gates.invalidateTaskWithinTransaction(id);
    if(['workspace_validation_started','workspace_validation_finished'].includes(event))gates.invalidateTaskWithinTransaction(workspaces.get(id).taskId);
    if(['functional_test_started','functional_test_finished','functional_test_interrupted'].includes(event))gates.invalidateTaskWithinTransaction(workspaces.get(id).taskId);
    if (['review_topic_decided','review_comment_added'].includes(event)) gates.reviewChangedWithinTransaction(id);
    return result;
  });
  const token = randomBytes(32).toString('hex');
  const workbuddyOAuth=new WorkBuddyOAuth();
  let mutating = false;
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'Referrer-Policy': 'no-referrer', ...extra,
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== new URL(origin).host) throw failure(403, '只允许通过本机 127.0.0.1 地址访问。');
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, '请从本机协作台页面操作。');
      const url = new URL(req.url, origin);
      if(url.pathname==='/api/platforms/workbuddy/callback'&&req.method==='GET'){await workbuddyOAuth.callback(url.searchParams);return send(200,'WorkBuddy 授权已接收。自动任务仍未启用，可关闭本页。','text/plain; charset=utf-8');}
      if(url.search){const pairs=[...url.searchParams];const allowed=req.method==='GET'&&pairs.length===1&&((url.pathname==='/'&&pairs[0][0]==='project')||(url.pathname==='/intake'&&['project','handoff'].includes(pairs[0][0])))&&/^[a-zA-Z0-9-]{1,100}$/.test(pairs[0][1]);if(!allowed)throw failure(400,'此接口不接受查询参数。');}
      const method = req.method;
      let body;
      if (!['GET', 'POST'].includes(method)) throw failure(405, '不支持此操作。');
      if (method === 'POST') {
        if (req.headers['x-session-token'] !== token || req.headers.origin !== origin) throw failure(403, '会话已失效，请刷新页面后重试。');
        if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw failure(415, '请使用 JSON 文件或页面表单。');
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) throw failure(413, '配置文件超过 16MB，请减少附件后重试。');
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure(400, 'JSON 格式损坏，请重新从配置入口导出。'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure(400, '请求应为 JSON 对象。');
      }
      if (method === 'GET' && assets.has(url.pathname)) {
        const [filename, type] = assets.get(url.pathname);
        if(!developmentComments&&url.pathname.startsWith('/prototype-review'))throw failure(404,'开发评论入口已关闭');
        if(filename==='prototype-review.html')return send(200,await readFile(path.join(publicRoot,filename)),type,{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:8774; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
        return send(200, await readFile(path.join(publicRoot, filename)), type);
      }
      if (method === 'GET' && url.pathname === '/favicon.ico') return send(204, '', 'text/plain');
      if(method==='GET'&&url.pathname==='/direct-config.js')return send(200,await readFile(new URL('../dev-intake/direct-config.js',import.meta.url)),'text/javascript; charset=utf-8');
      if (method === 'GET' && url.pathname === '/intake') {
        return send(200, await readFile(new URL('../dev-intake/index.html', import.meta.url)), 'text/html; charset=utf-8', {
          // The legacy page uses inline scripts/styles. It remains an independent, unchanged export tool.
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        });
      }
      if (method === 'GET' && url.pathname === '/api/session') return send(200, { token });
      if (method === 'GET' && url.pathname === '/api/health') return send(200, { ...store.health(), stage: 'dual-mode-console', dataPersistence: 'sqlite-and-files' });
      const configuration=url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/configuration$/);
      if(method==='GET'&&configuration){const p=store.getProject(configuration[1]);if(!p)throw failure(404,'项目不存在');return send(200,{id:p.id,name:p.name,sourceHash:p.sourceHash,config:p.config,...p.versionInfo,history:store.configHistory(p.id)});}
      if (method === 'GET' && url.pathname === '/api/projects') return send(200, store.listProjects());
      if (method === 'GET' && url.pathname === '/api/backups') return send(200, store.listBackups());
      if (method === 'GET' && url.pathname === '/api/audit') return send(200, store.audit());
      if (method === 'GET' && url.pathname === '/api/user/dashboard') {const dashboard=userConsole.dashboard(),workspaceViews=workspaces.list().map(c=>workspaces.view(c));dashboard.tasks=dashboard.tasks.map(task=>{const reasons=workspaces.policyReasons(tasks.mustTask(task.id));return {...task,...(task.status==='valid_passed'&&reasons.length?{status:'needs_revalidation'}:{}),controls:[...task.controls,...reasons]};});return send(200,{...dashboard,reviewDispatches:reviews.listRounds().flatMap(r=>{const task=tasks.getTask(r.taskId);return reviews.dispatches(r.id).map(j=>({...j,projectId:task.projectId,taskId:task.id}));}),requirementTrace:requirementTrace({...dashboard,plans:plans.list(),commentJobs:commentJobs.publicList()}),developmentComments,reviewRuns:reviewExecutor.publicList(),schedulerJobs:scheduler.list(),commentJobs:commentJobs.publicList(),plans:plans.list(),executions:executions.publicList(),workspaces:workspaceViews.map(({baselineFiles,files,validations,functionalTests,...c})=>({...c,lastFunctionalTest:functionalTests.at(-1)?{status:functionalTests.at(-1).status,finishedAt:functionalTests.at(-1).finishedAt}:null,lastValidation:validations.at(-1)?{status:validations.at(-1).status,scope:validations.at(-1).scope}:null}))});}
      if(method==='GET'&&url.pathname==='/api/scheduler')return send(200,scheduler.list());
      if(method==='GET'&&url.pathname==='/api/platforms/workbuddy/status')return send(200,workbuddyOAuth.status());
      if(method==='POST'&&url.pathname==='/api/platforms/workbuddy/authorize')return send(200,workbuddyOAuth.begin(origin));
      if(method==='POST'&&url.pathname==='/api/platforms/workbuddy/inspect-task')return send(200,await workbuddyOAuth.inspectTask(body.taskId));
      if(method==='POST'&&url.pathname==='/api/platforms/workbuddy/disconnect')return send(200,workbuddyOAuth.disconnect());
      if(method==='GET'&&url.pathname==='/api/platforms/capabilities')return send(200,platformCapabilities());
      if (method === 'GET' && url.pathname === '/api/executions') return send(200,executions.publicList());
      const workspaceList=url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/workspaces$/);
      if(method==='GET'&&workspaceList){tasks.mustTask(workspaceList[1]);return send(200,workspaces.list(workspaceList[1]).map(c=>workspaces.view(c)));}
      const workspaceDetail=url.pathname.match(/^\/api\/workspaces\/([a-zA-Z0-9-]+)$/);
      if(method==='GET'&&workspaceDetail)return send(200,workspaces.detail(workspaceDetail[1]));
      const applicationList=url.pathname.match(/^\/api\/workspaces\/([a-zA-Z0-9-]+)\/applications$/);
      if(method==='GET'&&applicationList){workspaces.get(applicationList[1]);return send(200,sourceApplications.list(applicationList[1]));}
      if(method==='POST'&&applicationList){const c=workspaces.get(applicationList[1]),task=tasks.mustTask(c.taskId),round=reviews.getRound(body.roundId);if(round.taskId!==task.id)throw failure(400,'评审不属于此任务');const guard=()=>userConsole.assertExecution(tasks.mustTask(task.id));const result=await sourceApplications.apply(c,{authorize:()=>{guard();if(gates.getGate(round.id).currentDecision?.action!=='approve'||!workspaces.freshness(c).fresh||workspaces.policyReasons(task).length)throw failure(400,'候选须完成有效人工批准、测试且基线未变化');},guard,verify:async()=>{const run=candidateTests.list(c.id).at(-1);if(run?.status!=='command_passed')return {ok:false};return runFunctionalTests(path.join(c.directory,'candidate'),run.entries,{profile:run.profile??'offline-v1',shouldStop:()=>{try{guard();return false;}catch{return true;}}});}});store.event('source_candidate_applied',task.id,result.id);return send(200,result);}
      const rollbackApplication=url.pathname.match(/^\/api\/source-applications\/([a-f0-9-]{36})\/rollback$/);
      if(method==='POST'&&rollbackApplication){const result=sourceApplications.rollback(rollbackApplication[1]);store.event('source_candidate_rollback',result.taskId,result.id);return send(200,result);}
      const artifactList=url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/artifacts$/);
      if(method==='GET'&&artifactList){const task=tasks.mustTask(artifactList[1]);return send(200,task.receipts.map(receipt=>{try{const bundle=artifactForTask(tasks,task.id,receipt.id);return {...bundle,files:bundle.files?.map(({content,...file})=>file),receiptId:receipt.id};}catch(error){return {receiptId:receipt.id,available:false,reason:error.message};}}));}
      const artifactFile=url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/receipts\/([a-zA-Z0-9-]+)\/artifacts(?:\/(download))?$/);
      if(method==='GET'&&artifactFile){const bundle=artifactForTask(tasks,artifactFile[1],artifactFile[2]);if(!bundle.available)throw Error('Artifact unavailable');if(artifactFile[3])return send(200,artifactZip(bundle),'application/zip',{'Content-Disposition':`attachment; filename="code-${artifactFile[2]}.zip"`});return send(200,bundle);}
      const reviewRuns=url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/runs$/);
      if(method==='GET'&&reviewRuns)return send(200,reviewExecutor.publicList().filter(j=>j.roundId===reviewRuns[1]));
      const reviewDispatch=url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/dispatch$/);
      if(method==='GET'&&reviewDispatch)return send(200,reviews.dispatches(reviewDispatch[1]));
      const reviewArtifacts=url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/artifacts\/(reviewerA|reviewerB)$/);
      if(method==='GET'&&reviewArtifacts){const round=reviews.requireFresh(reviewArtifacts[1]);const packet=reviews.prepareReviewPacket(reviewArtifacts[1],{slot:reviewArtifacts[2]});const primary=round.task.packages.find(p=>p.role==='primary'&&p.version===round.task.version),selection=round.snapshot.selections.find(s=>s.packageId===primary?.id);const bundle=artifactForTask(tasks,round.task.id,selection?.receiptId);return send(200,artifactZip(bundle),'application/zip',{'Content-Disposition':`attachment; filename="review-${reviewArtifacts[1]}-code.zip"`});}
      const executionDetail=url.pathname.match(/^\/api\/executions\/([a-zA-Z0-9-]+)$/);
      if(method==='GET'&&executionDetail){const {prompt,...job}=executions.get(executionDetail[1]);return send(200,job);}
      if (method === 'GET' && url.pathname === '/api/tasks') return send(200, tasks.listTasks());
      if (method === 'GET' && url.pathname === '/api/review-rounds') return send(200, reviews.listRounds());
      const gateDetail = url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/gate$/);
      if (method === 'GET' && gateDetail) return send(200, gates.getGate(gateDetail[1]));
      const roundDetail = url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)$/);
      if (method === 'GET' && roundDetail) return send(200, reviews.getRound(roundDetail[1]));
      const reviewPacket = url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/packets\/(reviewerA|reviewerB)$/);
      if (method === 'GET' && reviewPacket) {
        const packet = reviews.prepareReviewPacket(reviewPacket[1], {slot:reviewPacket[2]});
        return send(200, packet.markdown, 'text/markdown; charset=utf-8', {'Content-Disposition':`attachment; filename="${packet.filename}"`});
      }
      const taskOptions = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/task-options$/);
      if (method === 'GET' && taskOptions) return send(200, tasks.getOptions(taskOptions[1]));
      const taskDetail = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)$/);
      if (method === 'GET' && taskDetail) {
        const item = tasks.getTask(taskDetail[1]);
        if (!item) throw failure(404, storeErrors['Task not found']);
        return send(200, item);
      }
      const packageDownload = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/packages\/([a-zA-Z0-9-]+)\/download$/);
      if (method === 'GET' && packageDownload) {
        const task = tasks.getTask(packageDownload[1]);
        const pkg = task?.packages.find(item => item.id === packageDownload[2]);
        if (!pkg) throw failure(404, '任务包不存在，请刷新任务详情。');
        return send(200, pkg.markdown, 'text/markdown; charset=utf-8', { 'Content-Disposition': 'attachment; filename="task-package.md"' });
      }
      const project = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/export$/);
      if (method === 'GET' && project) {
        const item = store.getProject(project[1]);
        if (!item) throw failure(404, '未找到项目，请返回项目列表。');
        return send(200, item.raw, 'application/octet-stream', { 'Content-Disposition': 'attachment; filename="project-config.json"' });
      }
      if (method === 'POST') {
        if (mutating) throw failure(409, '正在保存或备份，请稍后重试。');
        mutating = true;
        try {
          if(url.pathname==='/api/configuration/save'){
            const revision=body.baseProjectId?{baseProjectId:body.baseProjectId,expectedHash:body.expectedHash}:null;
            return send(200,await store.importConfig(body.raw,revision));
          }
          if (url.pathname === '/api/import') {
            if (typeof body.raw !== 'string') throw failure(400, '请选择从原配置入口导出的 JSON 文件。');
            return send(200, await store.importConfig(body.raw));
          }
          if(url.pathname==='/api/plans')return send(200,await plans.publish(body));
          const workspacePrepare=url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/workspaces$/);
          if(workspacePrepare)return send(200,await workspaces.prepare(workspacePrepare[1],body));
          const workspaceValidate=url.pathname.match(/^\/api\/workspaces\/([a-zA-Z0-9-]+)\/validate$/);
          if(workspaceValidate)return send(200,await workspaces.startValidation(workspaceValidate[1]));
          const functionalStart=url.pathname.match(/^\/api\/workspaces\/([a-zA-Z0-9-]+)\/tests$/);
          if(functionalStart)return send(200,await candidateTests.start(functionalStart[1],body));
          const functionalAction=url.pathname.match(/^\/api\/functional-tests\/([a-zA-Z0-9-]+)\/(cancel|resolveInterruption)$/);
          if(functionalAction)return send(200,await candidateTests[functionalAction[2]](functionalAction[1],body));
          const artifactCompare=url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/artifacts\/compare$/);
          if(artifactCompare)return send(200,diffArtifacts(artifactForTask(tasks,artifactCompare[1],body.beforeReceiptId),artifactForTask(tasks,artifactCompare[1],body.afterReceiptId)));
          const scheduledStart=url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/schedule$/);
          if(scheduledStart)return send(200,await scheduler.enqueue(scheduledStart[1],body));
          const scheduledCancel=url.pathname.match(/^\/api\/scheduler\/([a-zA-Z0-9-]+)\/cancel$/);
          if(scheduledCancel)return send(200,await scheduler.cancel(scheduledCancel[1]));
          const executionStart=url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/executions$/);
          if(executionStart)return send(200,await executions.start(executionStart[1],body));
          const executionAction=url.pathname.match(/^\/api\/executions\/([a-zA-Z0-9-]+)\/(cancel|collect|resolveInterruption|replace)$/);
          if(executionAction){await executions[executionAction[2]](executionAction[1],body);const {prompt,stdout,stderr,...job}=executions.get(executionAction[1]);return send(200,job);}
          const planAction=url.pathname.match(/^\/api\/plans\/([a-zA-Z0-9-]+)\/(answer|prepare|start)$/);
          if(planAction)return send(200,await plans[planAction[2]==='answer'?'respond':planAction[2]](planAction[1],body));
          const commentSubmit=url.pathname.match(/^\/api\/user\/requests\/([a-zA-Z0-9-]+)\/submit$/);
          if(commentSubmit){if(!developmentComments)throw failure(403,'开发评论已关闭');return send(200,await commentJobs.submit(commentSubmit[1],body));}
          const commentReply=url.pathname.match(/^\/api\/user\/requests\/([a-zA-Z0-9-]+)\/replies$/);
          if(commentReply)return send(200,await userConsole.replyComment(commentReply[1],body));
          if(url.pathname==='/api/user/requests')return send(200,await userConsole.addRequest(body));
          if(url.pathname==='/api/user/decisions')return send(200,await userConsole.addDecision(body));
          if(url.pathname==='/api/user/updates')return send(200,await userConsole.addUpdate(body));
          if(url.pathname==='/api/user/previews')return send(200,await userConsole.addPreview(body));
          const userProject=url.pathname.match(/^\/api\/user\/projects\/([a-zA-Z0-9-]+)\/control$/);
          if(userProject)return send(200,await userConsole.control(userProject[1],body));
          const userRequest=url.pathname.match(/^\/api\/user\/requests\/([a-zA-Z0-9-]+)\/ack$/);
          if(userRequest)return send(200,await userConsole.acknowledge(userRequest[1],body));
          const userAnswer=url.pathname.match(/^\/api\/user\/decisions\/([a-zA-Z0-9-]+)\/answer$/);
          if(userAnswer)return send(200,await userConsole.answerDecision(userAnswer[1],body));
          if (url.pathname === '/api/backups') return send(200, await store.createBackup('manual'));
          if (url.pathname === '/api/tasks') return send(200, await tasks.createTask(body));
          const openReview = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/review-rounds$/);
          if (openReview) return send(200, await reviews.openRound(openReview[1], body));
          const gateAction=url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/gate\/(scores|selection|cross|resolutions|escalation|decisions)$/);
          if(gateAction){
            if(!Number.isInteger(body.expectedRevision)) throw Error('Gate revision conflict');
            const methods={scores:'addScore',selection:'selectScore',cross:'confirmCross',resolutions:'resolveTopic',escalation:'resolveEscalation',decisions:'decide'};
            const result=await gates[methods[gateAction[2]]](gateAction[1],body);
            return send(200,result ?? {ok:true});
          }
          const startReview=url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/runs$/);
          if(startReview)return send(200,await reviewExecutor.enqueue(startReview[1],body));
          const reviewRunAction=url.pathname.match(/^\/api\/review-runs\/([a-zA-Z0-9-]+)\/(cancel|resolve)$/);
          if(reviewRunAction){await reviewExecutor[reviewRunAction[2]](reviewRunAction[1],body);return send(200,reviewExecutor.publicList().find(j=>j.id===reviewRunAction[1]));}
          const dispatchAction=url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/(dispatch|confirm-dispatch)$/);
          if(dispatchAction)return send(200,await reviews[dispatchAction[2]==='dispatch'?'queueDispatch':'confirmDispatch'](dispatchAction[1],body));
          const reviewAction = url.pathname.match(/^\/api\/review-rounds\/([a-zA-Z0-9-]+)\/(submissions|comments|decisions)$/);
          if (reviewAction) {
            const handlers = {submissions:'submitReview',comments:'addComment',decisions:'decideTopic'};
            return send(200, await reviews[handlers[reviewAction[2]]](reviewAction[1], body));
          }
          const taskAction = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/(dependencies|packages|handoffs|receipts|resolve)$/);
          if (taskAction) {
            const handlers = {dependencies:'setDependencies', packages:'preparePackage', handoffs:'confirmHandoff', receipts:'importResult', resolve:'resolveResult'};
            return send(200, await tasks[handlers[taskAction[2]]](taskAction[1], body));
          }
          const verify = url.pathname.match(/^\/api\/backups\/([a-zA-Z0-9-]+)\/verify$/);
          if (verify) return send(200, await store.verifyBackup(verify[1]));
        } finally { mutating = false; }
      }
      throw failure(404, '找不到此页面或操作，请返回首页。');
    } catch (error) {
      // Validation messages must be safe: never serialize stack traces, filesystem paths or raw config.
      const gateBlocked = error.message.startsWith('Gate blocked:');
      const userBlocked=error.message.startsWith('User control blocked:');
      const status = (gateBlocked||userBlocked) ? 400 : Number.isInteger(error.status) ? error.status : (storeErrors[error.message] ? 400 : 500);
      const message = userBlocked?'本项目已暂停、方向已变更或有待决策事项。请到用户态查看原因；暂停不影响原文回收。':gateBlocked ? '仍有未满足条件，请查看评分裁决区的红色阻塞清单并逐项处理。' : error.status ? error.message : (storeErrors[error.message] || '本地保存或备份未完成，请检查磁盘空间和目录权限，保留原文件后重试。');
      if (!res.headersSent) send(status, { error: message, code: error.message === 'Project name conflict' ? 'PROJECT_CONFLICT' : undefined, errorKey: Object.hasOwn(storeErrors,error.message)?error.message:undefined });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  if(developmentComments)commentJobs.upgradePlans().catch(error=>console.error('旧评论自动实施排队失败：'+error.message));
  server.shutdownExecutions=async()=>{await reviewExecutor.shutdown();await scheduler.shutdown();await commentJobs.shutdown();return Promise.all([executions.shutdown(),workspaces.shutdown(),candidateTests.shutdown()]);};
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.version !== 'v26.3.0') throw new Error('本验证版本需要 Node v26.3.0，请使用已验证的运行时。');
  const port = Number(process.env.COLLAB_PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COLLAB_PORT 必须为有效端口。');
  const { Store } = await import('./lib/store.mjs');
  const dataRoot = path.resolve(process.env.COLLAB_DATA_DIR || fileURLToPath(new URL('./local-data/', import.meta.url)));
  let store;
  try { store = new Store(dataRoot); }
  catch (error) {
    console.error(storeErrors[error.message] || '数据目录无法打开，请检查目录权限和磁盘空间；原文件不会被覆盖。');
    process.exit(1);
  }
  try {
    if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()) {
      await store.createBackup('before-task-schema');
    } else if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_rounds'").get()) {
      await store.createBackup('before-review-schema');
    }
    if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_dispatches'").get())await store.createBackup('before-review-dispatch-schema');
    if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_runs'").get())await store.createBackup('before-review-run-schema');
    const hasGates=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gates'").get();
    const hasSequence=hasGates&&store.db.prepare('PRAGMA table_info(gates)').all().some(c=>c.name==='review_seq');
    const hasRecollections=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_supersessions'").get();
    if(!hasGates||!hasSequence||!hasRecollections)await store.createBackup('before-gate-schema');
    const userSchema=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_controls'").get();
    const decisionEpoch=store.db.prepare('PRAGMA table_info(user_decisions)').all().some(c=>c.name==='epoch');
    const holdSchema=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_holds'").get();
    if(!userSchema||!decisionEpoch||!holdSchema)await store.createBackup('before-user-console-schema');
    const planTables=store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('development_plans','plan_answers','plan_tasks')").get().n;
    if(planTables!==3)await store.createBackup('before-plan-schema');
    const executionTable=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_jobs'").get();
    const activeExecutions=executionTable&&store.db.prepare("SELECT 1 FROM execution_jobs WHERE json_extract(state,'$.status') IN ('queued','starting','running') LIMIT 1").get();
    if(!executionTable||activeExecutions)await store.createBackup('before-execution-schema-or-recovery');
    const workspaceTables=store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('workspace_candidates','workspace_validations')").get().n;
    const pendingWorkspace=workspaceTables===2&&store.db.prepare("SELECT 1 FROM workspace_validations WHERE json_extract(payload,'$.status')='running' LIMIT 1").get();
    if(workspaceTables!==2||pendingWorkspace)await store.createBackup('before-workspace-schema-or-recovery');
    if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_jobs'").get())await store.createBackup('before-scheduler-schema');
    const testTable=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='functional_test_runs'").get();
    const pendingTests=testTable&&store.db.prepare("SELECT 1 FROM functional_test_runs WHERE json_extract(payload,'$.status')='running' LIMIT 1").get();
    if(!testTable||pendingTests)await store.createBackup('before-functional-tests-schema-or-recovery');
  } catch (error) {
    store.close();
    console.error(storeErrors[error.message] || '任务模块升级前备份未完成，已停止启动；旧数据保留。');
    process.exit(1);
  }
  let server;try{server=createAppServer(store);}catch(error){store.close();console.error(storeErrors[error.message]||'初始化未完成，原数据保留。');process.exit(1);}
  server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? '端口已占用，请设置 COLLAB_PORT 后重试。' : '服务启动失败。'); store.close(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`本地协作台：http://127.0.0.1:${port} （仅本机，双态协作版）`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {server.shutdownExecutions().then(()=>server.close(() => { store.close(); process.exit(0); }));});
}
