// 实际独立环境验收：启动 Web，加载发布包，调用工具/真实模型，重启后恢复认领。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { copyFile, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';

const directory = resolve(process.argv[2]);
const releaseDirectory = process.argv[3] === 'online' ? undefined : resolve(process.argv[3]);
const phase = process.argv[4] ?? 'create';
const profile = join(directory, 'home/profiles/web');
const require = createRequire(join(directory, 'runtime/node_modules/@deepseek-ai/dsh/package.json'));
const { load, dump } = require('js-yaml');
const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href);
const standard = load(await readFile(require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8'), { schema: entryListSchema });
const plugins = standard[0].insert[0].config.plugins;
plugins.push({ id: 'sagitta-task', name: '@sagitta/runtime/task', config: { mode: 'local', directory: join(directory, 'database') } });
await copyFile(new URL('./packed-probe.js', import.meta.url), join(profile, 'packed-probe.mjs'));
const patchPath = join(profile, 'cordis.patch.yml');
const testPatches = [
  { id: 'preset-sagitta', config: { plugins } },
  { id: 'credentials', disabled: false },
  { id: 'authorization', disabled: false },
  { id: 'deepseek-account', disabled: false },
  { id: 'session-log-deepseek', disabled: true },
  { insert: [{ id: 'packed-probe', name: pathToFileURL(join(profile, 'packed-probe.mjs')).href }] },
];
const testIds = testPatches.map((
  row,
) => row.id).filter(Boolean);
const currentPatches = load(await readFile(patchPath, 'utf8'), { schema: entryListSchema });
const retained = currentPatches.filter((
  row,
) => !testIds.includes(row.id) && !row.insert?.some((
  entry,
) => entry.id === 'packed-probe'));
await writeFile(patchPath, dump([...retained, ...testPatches], { schema: entryListSchema }));
const resultPath = join(directory, `acceptance-${phase}.json`);
await rm(resultPath, { force: true });
const workDirectory = join(directory, 'workspace');
await mkdir(workDirectory, { recursive: true });
const environment = { ...process.env, DSH_TELEMETRY_DISABLED: '1', SAGITTA_TEST_PHASE: phase,
  SAGITTA_TEST_RESULT: resultPath, SAGITTA_TEST_ENV_FILE: resolve('.env') };
// 本地验包替换 GitHub 下载；正式发布后的 online 模式仍加载测试凭据但访问真实 GitHub。
environment.NODE_OPTIONS = `--import=${new URL('./release-download.js', import.meta.url).href}`;
environment.SAGITTA_TEST_RELEASE = releaseDirectory ?? 'online';
const child = spawn(join(directory, process.platform === 'win32' ? 'sagitta.cmd' : 'sagitta.sh'),
  ['--no-open', '--port', '0'], { cwd: workDirectory, env: environment });
const log = createWriteStream(join(directory, `acceptance-${phase}.log`));
child.stdout.on('data', (
  data,
) => { log.write(data); });
child.stderr.on('data', (
  data,
) => { log.write(data); });
const exited = once(child, 'exit');
try {
  const deadline = Date.now() + 300_000;
  let result;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      result = JSON.parse(await readFile(resultPath, 'utf8'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await setTimeout(250);
  }
  assert.ok(result, `验收未完成，查看 ${directory}/acceptance-${phase}.log`);
  assert.equal(result.error, undefined, result.error);
  const startupLog = await readFile(join(directory, `acceptance-${phase}.log`), 'utf8');
  const address = startupLog.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/)?.[0];
  assert.ok(address, '应输出 Web 服务地址');
  // Web 默认开启认证；验收使用启动时给出的本地登录链接，不输出其中的令牌。
  const login = await fetch(address, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map((
    value,
  ) => value.split(';')[0]).join('; ');
  const page = await fetch(new URL(login.headers.get('location'), address), { headers: { cookie } });
  assert.equal(page.status, 200);
  console.log(JSON.stringify(result, null, 2));
} finally {
  child.kill('SIGINT');
  await exited;
  log.end();
}
