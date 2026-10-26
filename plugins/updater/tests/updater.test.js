import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { boot, initProfile, readProfilePatches, getDshRuntimeVersion, createRuntimeResolution, loadProfileDirectory, PluginPackages } from '@deepseek-ai/dsh-app-boot';
import { dump } from 'js-yaml';

const execute = promisify(execFile);

test('Release 更新：真实 pnpm 安装、同版跳过、升级保留配置，校验失败保持未就绪', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-updater-'));
  const profileDir = join(directory, 'profile');
  initProfile(profileDir, []);
  const root = join(directory, 'root.yml');
  await writeFile(root, '[]\n');
  const profile = { name: 'test', dir: profileDir, cwd: directory,
    patchPath: join(profileDir, 'cordis.patch.yml'), home: directory,
    installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)), overlays: [] };
  await writeFile(profile.patchPath, dump([{ insert: [
    { id: 'updater', name: new URL('../dist/index.js', import.meta.url).href },
    { id: 'config-editor', name: '@deepseek-ai/dsh-config-editor' },
    { id: 'preset-sagitta', name: '@deepseek-ai/dsh-agent-preset', inject: ['sagittaReady'],
      config: { id: 'sagitta', plugins: [] } },
  ] }]));
  const initialPatch = await readFile(profile.patchPath, 'utf8');

  let release;
  let archive;
  const { officialPlugins } = JSON.parse(await readFile(new URL('../../../sagitta.json', import.meta.url), 'utf8'));
  const publishFixture = async (
    version,
  ) => {
    const source = join(directory, version);
    await mkdir(source);
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: '@sagitta/runtime', version, type: 'module', engines: { dsh: getDshRuntimeVersion() },
      exports: { './task': './task.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
      peerDependencies: { '@deepseek-ai/dsh-scope': getDshRuntimeVersion() },
    }));
    await writeFile(join(source, 'cordis.patch.yml'), '[]\n');
    await writeFile(join(source, 'task.js'), 'export default class Task {}');
    await writeFile(join(source, 'prompt.md'), `prompt-${version}`);
    await writeFile(join(source, 'sagitta.json'), JSON.stringify({
      preset: { id: 'sagitta', name: 'Sagitta', prompt: 'prompt.md' },
      officialPlugins: version === '0.0.1' ? [...officialPlugins, 'tool-goal'] : officialPlugins,
      plugins: [{ id: 'sagitta-task', name: '@sagitta/runtime/task', config: { host: 'default', version } }],
    }));
    const { stdout } = await execute('npm', ['pack', '--ignore-scripts', '--json'], { cwd: source });
    const file = JSON.parse(stdout)[0].filename;
    archive = await readFile(join(source, file));
    release = { tag: `v${version}`, dirty: false, dsh: getDshRuntimeVersion(), packages: {
      runtime: { file, sha256: createHash('sha256').update(archive).digest('hex') },
    } };
  };
  const requests = [];
  const originalFetch = globalThis.fetch;
  // 仅替换 GitHub 网络边界；生命周期、校验、包安装和配置保存均执行真实代码。
  globalThis.fetch = async (
    url,
  ) => {
    requests.push(url);
    return url.endsWith('/release.json') ? Response.json(release) : new Response(archive);
  };
  let refreshes = 0;
  const registrations = [];
  const start = async () => {
    const loaded = loadProfileDirectory('test', profileDir, profile.installAnchor);
    const resolution = await createRuntimeResolution({ installAnchor: profile.installAnchor, profile: loaded, home: directory });
    return boot('test', root, readProfilePatches('test', profile), (
      ctx,
    ) => {
      ctx.provide('profileContext', profile);
      const packages = new PluginPackages(ctx, { resolution });
      const refresh = packages.refresh.bind(packages);
      packages.refresh = async () => { await refresh(); refreshes++; };
      ctx.provide('agentPresets', { register: async (
        config,
      ) => {
        registrations.push(structuredClone(config));
        return () => {};
      } });
    }, new URL('../', import.meta.url).href);
  };
  let ctx;
  try {
    await publishFixture('0.0.1');
    ctx = await start();
    assert.equal(ctx.get('sagittaReady'), true);
    assert.equal(refreshes, 1);
    assert.equal(registrations.length, 1);
    const preset = ctx.configEditor.entries().find((
      entry,
    ) => entry.options.id === 'preset-sagitta');
    await ctx.configEditor.edit(preset, (
      config,
    ) => {
      config.plugins.find((
        plugin,
      ) => plugin.id === 'sagitta-task').config.host = 'user-database';
      const web = config.plugins.find((
        plugin,
      ) => plugin.id === 'tool-web');
      web.config = { search: false, fetch: false, searchTimeoutMs: 12345 };
      config.plugins.find((
        plugin,
      ) => plugin.id === 'present').disabled = true;
      config.plugins = config.plugins.filter((
        plugin,
      ) => plugin.id !== 'time-context');
      return config;
    });
    await ctx.fiber.dispose();
    requests.length = 0;
    ctx = await start();
    assert.equal(ctx.get('sagittaReady'), true);
    assert.equal(requests.length, 1);
    assert.equal(refreshes, 1, '同版仅检查清单');
    await ctx.fiber.dispose();

    await publishFixture('0.0.2');
    ctx = await start();
    assert.equal(ctx.get('sagittaReady'), true);
    assert.equal(refreshes, 2);
    assert.equal(registrations.at(-1).plugins.find((
      plugin,
    ) => plugin.id === 'sagitta-task').config.host, 'user-database');
    assert.equal(registrations.at(-1).plugins.find((
      plugin,
    ) => plugin.id === 'persona').config.prefix, 'prompt-0.0.2');
    const configured = registrations.at(-1).plugins;
    assert.deepEqual(configured.find((
      plugin,
    ) => plugin.id === 'tool-web').config, { search: false, fetch: false, searchTimeoutMs: 12345 });
    assert.equal(configured.find((
      plugin,
    ) => plugin.id === 'present').disabled, true, '保留用户禁用状态');
    assert.equal(configured.some((
      plugin,
    ) => plugin.id === 'time-context'), false, '保留用户删除结果');
    assert.ok(configured.find((
      plugin,
    ) => plugin.id === 'tool-goal'), '已有非托管插件即使不在默认白名单也保留');
    const delegation = configured.find((
      plugin,
    ) => plugin.id === 'delegation');
    for (const id of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow']) {
      assert.equal(delegation.config.find((
        plugin,
      ) => plugin.id === id).disabled, undefined, `${id} 沿用官方启用状态`);
    }
    await assert.rejects(readFile(join(profileDir, 'node_modules/@deepseek-ai/dsh-scope/package.json')), { code: 'ENOENT' });
    await ctx.fiber.dispose();

    await publishFixture('0.0.3');
    const successfulRegistrations = registrations.length;
    const expectedHash = release.packages.runtime.sha256;
    for (const failure of ['hash', 'version', 'dirty']) {
      release.packages.runtime.sha256 = failure === 'hash' ? '0'.repeat(64) : expectedHash;
      release.dsh = failure === 'version' ? '0.0.0' : getDshRuntimeVersion();
      release.dirty = failure === 'dirty';
      ctx = await start();
      assert.equal(ctx.get('sagittaReady'), undefined);
      assert.equal(registrations.length, successfulRegistrations);
      assert.equal(refreshes, 2);
      const installed = JSON.parse(await readFile(join(profileDir, 'node_modules/@sagitta/runtime/package.json')));
      assert.equal(installed.version, '0.0.2');
      await ctx.fiber.dispose();
    }
    // 清除用户覆盖，验证首次组装仅选用白名单中的官方插件。
    await writeFile(profile.patchPath, initialPatch);
    await publishFixture('0.0.4');
    ctx = await start();
    assert.equal(ctx.get('sagittaReady'), true);
    const fresh = registrations.at(-1).plugins;
    assert.deepEqual(fresh.map((
      plugin,
    ) => plugin.id), ['sagitta-task', ...officialPlugins]);
    assert.equal(fresh.find((
      plugin,
    ) => plugin.id === 'tool-web').config.fetch, true);
    for (const id of ['command-goal', 'tool-goal', 'tool-todo', 'planning']) {
      assert.equal(fresh.some((
        plugin,
      ) => plugin.id === id), false, `${id} 不加入默认组合`);
    }
  } finally {
    await ctx?.fiber.dispose();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
