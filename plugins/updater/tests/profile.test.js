import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { dump, load } from 'js-yaml';

test('原生预设按白名单更新，保留非托管插件、配置、顺序及删除结果', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-profile-'));
  initProfile(directory, []);
  const root = join(directory, 'root.yml');
  await writeFile(root, '[]\n');
  const profile = {
    dir: directory, patchPath: join(directory, 'cordis.patch.yml'), home: directory,
    installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)), overlays: [],
  };
  const rows = [
    { id: 'test-updater', name: new URL('./fixtures/profile-updater.js', import.meta.url).href },
    { id: 'config-editor', name: '@deepseek-ai/dsh-config-editor' },
    { id: 'preset-sagitta', name: '@deepseek-ai/dsh-agent-preset', inject: ['sagittaReady'],
      config: { id: 'sagitta', plugins: [] } },
  ];
  await writeFile(profile.patchPath, '# 用户注释需要保留\n' + dump([{ insert: rows }], { schema: entryListSchema }));
  const registrations = [];
  const definition = { id: 'sagitta', name: 'Sagitta', plugins: [
    { id: 'persona', name: 'persona', config: { prefix: '新版提示词' } },
    { id: 'sagitta-task', name: 'task', config: { mode: 'custom', host: 'A', port: 5432 } },
    { id: 'conditional', name: 'conditional', disabled: { __jsExpr: "process.platform === 'win32'" } },
    { id: 'official-group', name: 'cordis:group', group: true,
      config: [{ id: 'official-tool', name: 'tool', config: { limit: 10 } }] },
    { id: 'removed', name: 'removed' },
  ] };
  const start = async () => boot('test', root, readProfilePatches('test', profile), (
    ctx,
  ) => {
    ctx.provide('profileContext', profile);
    ctx.provide('testDefinition', definition);
    ctx.provide('agentPresets', { register: async (
      config,
    ) => {
      registrations.push(structuredClone(config));
      return () => {};
    } });
  }, new URL('../', import.meta.url).href);
  let ctx;
  let unmanaged;
  try {
    ctx = await start();
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].plugins[1].config.host, 'A');
    const entry = ctx.configEditor.entries().find((
      row,
    ) => row.options.id === 'preset-sagitta');
    assert.ok(entry, 'Sagitta 必须是官方编辑器可编辑的 profile 根条目');
    await ctx.configEditor.edit(entry, (
      current,
    ) => {
      current.plugins[1].config.host = 'B';
      current.plugins[0].config.suffix = '用户补充';
      current.plugins[3].disabled = true;
      current.plugins[3].config[0].config.limit = 50;
      current.plugins = current.plugins.filter((
        plugin,
      ) => plugin.id !== 'removed');
      current.plugins.splice(1, 0, { id: 'user-tool', name: 'user-tool', disabled: true, config: { custom: '保留' } });
      unmanaged = structuredClone(current.plugins.filter((
        plugin,
      ) => !['persona', 'sagitta-task'].includes(plugin.id)));
      return current;
    });
    await ctx.fiber.dispose();
    definition.plugins[1].config.newOption = 20;
    definition.plugins[0].config.prefix = '更新后的提示词';
    definition.plugins[3].config[0].config.limit = 999;
    definition.plugins.push({ id: 'new-official', name: 'new-official' });
    definition.plugins.push({ id: 'sagitta-memory', name: 'memory', config: {} });
    ctx = await start();
    const latest = registrations.at(-1);
    assert.deepEqual(latest.plugins.find((
      plugin,
    ) => plugin.id === 'sagitta-task').config, { mode: 'custom', host: 'B', port: 5432, newOption: 20 });
    assert.equal(latest.plugins[0].config.prefix, '更新后的提示词');
    assert.equal(latest.plugins[0].config.suffix, '用户补充');
    assert.deepEqual(latest.plugins.filter((
      plugin,
    ) => !['persona', 'sagitta-task', 'sagitta-memory'].includes(plugin.id)), unmanaged);
    assert.deepEqual(latest.plugins.map((
      plugin,
    ) => plugin.id), ['persona', 'user-tool', 'sagitta-task', 'conditional', 'official-group', 'sagitta-memory']);
    const source = await readFile(profile.patchPath, 'utf8');
    assert.ok(source.includes('# 用户注释需要保留'));
    const saved = load(source, { schema: entryListSchema }).find((
      patch,
    ) => patch.id === 'preset-sagitta');
    assert.deepEqual(saved.config.plugins.find((
      plugin,
    ) => plugin.id === 'conditional').disabled, definition.plugins[2].disabled);
    await ctx.fiber.dispose();
    ctx = await start();
    assert.equal(await readFile(profile.patchPath, 'utf8'), source, '相同配置不重写文件');
    const restored = ctx.configEditor.entries().find((
      row,
    ) => row.options.id === 'preset-sagitta');
    await ctx.configEditor.edit(restored, (
      current,
    ) => ({ ...current, plugins: [] }));
    await ctx.fiber.dispose();
    ctx = await start();
    assert.deepEqual(registrations.at(-1).plugins.map((
      plugin,
    ) => plugin.id), ['persona', 'sagitta-task', 'sagitta-memory'], '清空已有清单后仅恢复白名单');
  } finally {
    await ctx?.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
