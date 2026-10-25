// 仅用于本地验包：替换发布资产下载，其他请求（含真实模型调用）仍走原始 fetch。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const directory = process.env.SAGITTA_TEST_RELEASE;
if (!directory) throw new Error('必须显式设置 SAGITTA_TEST_RELEASE');
const release = directory === 'online' ? undefined : JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (
  input,
  options,
) => {
  const url = String(input);
  const base = 'https://github.com/PureDimension/sagitta-agent/releases';
  if (release && url === `${base}/latest/download/release.json`) return Response.json({ ...release, dirty: false });
  if (release && url === `${base}/download/${release.tag}/${release.packages.runtime.file}`) {
    return new Response(await readFile(join(directory, release.packages.runtime.file)));
  }
  return originalFetch(input, options);
};
if (process.env.SAGITTA_TEST_ENV_FILE) {
  const env = parseEnv(await readFile(process.env.SAGITTA_TEST_ENV_FILE, 'utf8'));
  process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API;
}
