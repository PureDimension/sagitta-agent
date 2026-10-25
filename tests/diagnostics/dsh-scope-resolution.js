import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setEnvironmentData } from 'node:worker_threads';

// 单独进程运行：node tests/diagnostics/dsh-scope-resolution.js <dsh/package.json> <local|host|linked|release> [runtime.tgz]
// 使用官方运行时解析器，仅在临时目录模拟 Updater 布局；不修改日常 profile。
const installAnchor = process.argv[2];
const mode = process.argv[3];
assert.ok(['local', 'host', 'linked', 'release'].includes(mode));
const hostRequire = createRequire(installAnchor);
const hostImport = (
  name,
) => import(pathToFileURL(hostRequire.resolve(name)).href);
const { createRuntimeResolution, initProfile, loadProfileDirectory } = await hostImport('@deepseek-ai/dsh-app-boot');
const hostScope = await hostImport('@deepseek-ai/dsh-scope');
const { Context } = await hostImport('@deepseek-ai/cordis');
const directory = await mkdtemp(join(tmpdir(), 'sagitta-scope-resolution-'));
const home = join(directory, 'home');
const profileDir = join(home, 'profiles', 'probe');
const source = mode === 'release' ? join(profileDir, 'node_modules', '@sagitta', 'runtime')
  : mode === 'linked' ? join(directory, 'workspace') : join(profileDir, 'sagitta-source');
const entry = join(source, 'plugins', 'task', 'dist', 'probe.js');
let ctx;
try {
  initProfile(profileDir, []);
  if (mode === 'release') {
    const { runPluginCommand } = await hostImport('@deepseek-ai/dsh-plugin-manager/operations');
    const result = await runPluginCommand({ profile: 'probe', dir: profileDir, installAnchor, cwd: process.cwd(), home },
      ['add', process.argv[4], '--save-exact', '--ignore-scripts', '--config.auto-install-peers=false'],
      { execution: 'service', outputBytes: 65536, idleTimeoutMs: 60000 });
    assert.equal(result.exitCode, 0, result.output);
  }
  await mkdir(dirname(entry), { recursive: true });
  if (mode !== 'release') await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@sagitta/runtime', type: 'module',
    peerDependencies: { '@deepseek-ai/dsh-scope': '0.2.1-rc.2' } }));
  await writeFile(entry, `
export { scopeOf } from '@deepseek-ai/dsh-scope';
export const moduleUrl = import.meta.resolve('@deepseek-ai/dsh-scope');
`);
  if (mode === 'local' || mode === 'linked') {
    const packageDir = dirname(dirname(hostRequire.resolve('@deepseek-ai/dsh-scope')));
    await cp(packageDir, join(source, 'node_modules', '@deepseek-ai', 'dsh-scope'), { recursive: true });
  }
  if (mode === 'linked') {
    await mkdir(join(profileDir, 'node_modules', '@sagitta'), { recursive: true });
    await symlink(source, join(profileDir, 'node_modules', '@sagitta', 'runtime'), 'dir');
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { '@sagitta/runtime': `file:${source}` }, dsh: { profile: { bundles: [] } },
    }));
  }
  const profile = loadProfileDirectory('probe', profileDir, installAnchor);
  const resolution = await createRuntimeResolution({ installAnchor, profile, home });
  // 官方公开的 Worker 入口使用与 Host 相同的 ESM/CommonJS 解析规则。
  setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution', { resolution });
  await hostImport('@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap');
  const plugin = await import(pathToFileURL(entry).href);
  ctx = new Context();
  const key = {};
  const scoped = hostScope.createScope(ctx, key);
  const result = {
    mode,
    hostModule: pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-scope')).href,
    pluginModule: plugin.moduleUrl,
    sameFunction: plugin.scopeOf === hostScope.scopeOf,
    hostReadsScope: hostScope.scopeOf(scoped.ctx) === key,
    pluginReadsScope: plugin.scopeOf(scoped.ctx) === key,
  };
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.hostReadsScope, true);
  assert.equal(result.sameFunction, mode !== 'local');
  assert.equal(result.pluginReadsScope, mode !== 'local');
} finally {
  await ctx?.fiber.dispose();
  await rm(directory, { recursive: true, force: true });
}
