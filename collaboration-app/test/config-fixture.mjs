import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const candidates = process.env.COLLAB_CONFIG_FIXTURE
  ? [resolve(process.env.COLLAB_CONFIG_FIXTURE)]
  : [new URL('../../collaboration-kickoff/config/intake.original.json', import.meta.url), new URL('../../kickoff-2026-11-02/config/intake.original.json', import.meta.url)];
export const originalConfigPath = candidates.find(p => existsSync(p));
if (!originalConfigPath) throw new Error('真实配置样本未找到，请用 COLLAB_CONFIG_FIXTURE 指向本地配置 JSON；不要上传私人样本到代码仓库。');
