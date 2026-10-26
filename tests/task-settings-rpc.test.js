import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import { dump } from 'js-yaml';

test('原生 Gateway 调用设置服务，ConfigEditor 持久保存并在重启后恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-settings-rpc-'));
  initProfile(directory, []);
  const root = join(directory, 'root.yml');
  await writeFile(root, '[]\n');
  const profile = {
    dir: directory, patchPath: join(directory, 'cordis.patch.yml'), home: directory,
    installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)), overlays: [],
  };
  const other = { id: 'another-plugin', name: 'another-plugin', config: { keep: true } };
  const rows = [
    { id: 'config-editor', name: '@deepseek-ai/dsh-config-editor' },
    { id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
    { id: 'remote-access', name: '@deepseek-ai/dsh-api-remote-access' },
    { id: 'gateway', name: '@deepseek-ai/dsh-api-gateway' },
    { id: 'sagitta-settings', name: '@sagitta/runtime' },
    { id: 'preset-sagitta', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'sagitta', name: 'Sagitta', plugins: [
        { id: 'sagitta-task', name: '@sagitta/runtime/task', config: {
          mode: 'custom', host: 'original', password: 'rpc-test-secret',
        } }, other,
      ],
    } },
  ];
  await writeFile(profile.patchPath, dump([{ insert: rows }]));
  const registrations = [];
  const start = () => boot('test', root, readProfilePatches('test', profile), (
    ctx,
  ) => {
    ctx.provide('profileContext', profile);
    // 保留原生预设注册与重载路径，测试不启动会话和数据库。
    ctx.provide('agentPresets', { register: async (
      config,
    ) => { registrations.push(config); return () => {}; } });
  }, new URL('../', import.meta.url).href);
  let ctx;
  try {
    ctx = await start();
    const peer = {
      id: 'settings-test', ctx, principal: { kind: 'owner' },
      signal: new AbortController().signal, interactions: 'none', dispose: async () => {},
    };
    const invoke = (
      method,
      args = {},
      caller = peer,
    ) => ctx.typertGateway.invoke({ namespace: 'sagittaSettings', method, args, peer: caller });
    const initial = await invoke('readTask');
    assert.equal(initial.config.host, 'original');
    assert.equal(initial.passwordConfigured, true);
    assert.equal('password' in initial.config, false);

    const saved = await invoke('saveTask', { input: { ...initial.config, host: 'updated' } });
    assert.equal(saved.config.host, 'updated');
    assert.equal(JSON.stringify(saved).includes('rpc-test-secret'), false);
    await invoke('saveTask', { input: { ...saved.config, password: 'new-rpc-secret' } });
    await invoke('saveTask', { input: { ...(await invoke('readTask')).config, port: 5440 } });
    const source = await readFile(profile.patchPath, 'utf8');
    assert.equal(source.includes('new-rpc-secret'), true);
    assert.equal(JSON.stringify(await invoke('readTask')).includes('new-rpc-secret'), false);
    await assert.rejects(invoke('saveTask', { input: { ...saved.config, port: -1 } }));
    assert.equal(await readFile(profile.patchPath, 'utf8'), source);
    await assert.rejects(invoke('readTask', {}, {
      ...peer, principal: { kind: 'untrusted-test' },
    }), { code: 'remote-access/denied' });
    await ctx.fiber.dispose();

    ctx = await start();
    assert.equal((await invoke('readTask')).config.host, 'updated');
    assert.equal((await invoke('readTask')).config.port, 5440);
    const latest = registrations.at(-1).plugins;
    assert.equal(latest[0].config.password, 'new-rpc-secret');
    assert.deepEqual(latest[1], other);
  } finally {
    await ctx?.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
