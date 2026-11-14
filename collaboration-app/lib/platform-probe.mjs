import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export const platformPaths = Object.freeze({
  codex: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  workbuddy: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
  doubao: '/Applications/Doubao.app',
});

// Fixed executable/arguments only. This capability check never accepts project prompts,
// shell commands, credentials, model substitutions or writable agent permissions.
export function capture(executable, args, { cwd, timeoutMs = 15000, limit = 256 * 1024, spawnProcess = spawn } = {}) {
  return new Promise(resolve => {
    let child, timer, ended = false, stdout = '', stderr = '', failure = null;
    const finish = (code = null, signal = null) => {
      if (ended) return;
      ended = true; clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, failure });
    };
    const stop = reason => {
      if (ended || failure) return;
      failure = reason;
      child?.kill('SIGKILL');
      finish();
    };
    try {
      child = spawnProcess(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
        if (ended) return;
        if (channel === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > limit) {
          stdout = stdout.slice(0, limit / 2); stderr = stderr.slice(0, limit / 2);
          stop('output_limit');
        }
      });
      child.once('error', () => { failure = 'spawn_failed'; finish(); });
      child.once('close', finish);
    } catch { failure = 'spawn_failed'; finish(); }
  });
}

export function verifyCodexProbe(result) {
  const events = [];
  for (const line of result.stdout.split('\n').filter(x => x.trim())) {
    try { events.push(JSON.parse(line)); } catch { return false; }
  }
  return !result.failure && result.code === 0 &&
    events.some(e => e.type === 'turn.completed') &&
    !events.some(e => e.type === 'turn.failed' || e.type === 'error') &&
    events.some(e => e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text?.trim() === 'COLLAB_CONNECTIVITY_OK');
}

export async function probePlatforms({ modelProbe = false, cwd = '/private/tmp', run = capture, exists = p => access(p, constants.F_OK).then(() => true, () => false) } = {}) {
  const checkedAt = new Date().toISOString();
  const codexHelp = await run(platformPaths.codex, ['exec', '--help'], { cwd });
  const codexReady = !codexHelp.failure && codexHelp.code === 0 && ['--json', '--ephemeral', '--sandbox', '--skip-git-repo-check'].every(flag => codexHelp.stdout.includes(flag)) && codexHelp.stdout.includes('read-only');
  const auth = codexReady ? await run(platformPaths.codex, ['login', 'status'], { cwd }) : null;
  const workbuddy = await run(platformPaths.workbuddy, ['--help'], { cwd });
  const doubaoInstalled = await exists(platformPaths.doubao);
  const report = {
    checkedAt, scope: 'capability-probe-only', projectExecutionEnabled: false,
    platforms: [
      { platform: 'Codex', status: codexReady ? 'cli_available' : 'cli_unavailable', authenticated: auth ? !auth.failure && auth.code === 0 : null, modelVerified: false, actualModel: null, next: '接通任务包、独立工作目录、执行日志和成果回写后，才能分发项目任务。' },
      { platform: 'WorkBuddy', status: !workbuddy.failure && workbuddy.code === 0 ? 'cli_available' : 'cli_unavailable', modelVerified: false, actualModel: null, reason: workbuddy.stderr.includes("Cannot find module") ? 'bundled_cli_missing_module' : workbuddy.failure || (workbuddy.code === 0 ? null : 'cli_start_failed'), next: '使用应用操作接力；CLI 可用性和登录需另行核验，暂不自动安装替代工具。' },
      { platform: '豆包', status: doubaoInstalled ? 'app_present' : 'app_not_found', modelVerified: false, actualModel: null, next: '使用应用操作接力；尚未核实程序化调用入口。' },
    ],
  };
  if (modelProbe && codexReady && report.platforms[0].authenticated) {
    const result = await run(platformPaths.codex, ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '这是协作台连通性探测。不要调用工具，不要读写文件，只回复 COLLAB_CONNECTIVITY_OK。'], { cwd, timeoutMs: 90000 });
    const verified = verifyCodexProbe(result);
    Object.assign(report.platforms[0], { status: verified ? 'model_response_verified' : 'model_probe_failed', modelVerified: verified, reason: verified ? null : result.failure || 'completion_not_verified' });
    // A successful reply verifies connectivity, not the provider's underlying model identity.
  }
  return report;
}
