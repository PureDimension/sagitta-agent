import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProfile } from '@deepseek-ai/dsh-app-boot';
import { dump } from 'js-yaml';
import { TaskSettingsService } from '../plugins/task/dist/settings/service.js';

test('任务设置不回显密码，保存时保留未提交的密码及其他插件配置', async (
  t,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  initProfile(directory, []);
  const profile = {
    dir: directory, patchPath: join(directory, 'cordis.patch.yml'), home: directory,
    installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)), overlays: [],
  };
  const task = { id: 'sagitta-task', config: { mode: 'custom', host: 'old-host', password: 'test-secret' } };
  const other = { id: 'another-plugin', config: { keep: true } };
  const entry = { options: { id: 'preset-sagitta', config: { id: 'sagitta', plugins: [task, other] } } };
  const persist = () => writeFile(profile.patchPath, dump([{ insert: [entry.options] }]));
  await persist();
  const editor = {
    entries: () => [entry],
    edit: async (
      target,
      change,
    ) => { target.options.config = change(structuredClone(target.options.config)); await persist(); },
  };
  const service = new TaskSettingsService(editor, profile);
  const initial = service.read();
  assert.equal(initial.passwordConfigured, true);
  assert.equal('password' in initial.config, false);

  await service.save({ ...initial.config, host: 'new-host' });
  const stored = () => entry.options.config.plugins[0].config;
  assert.equal(stored().host, 'new-host');
  assert.equal(stored().password, 'test-secret');
  assert.deepEqual(entry.options.config.plugins[1], other);

  await service.save({ ...service.read().config, password: '' });
  assert.equal(service.read().passwordConfigured, false);
  await service.save({ ...service.read().config, password: 'replacement' });
  assert.equal(stored().password, 'replacement');
  assert.equal(JSON.stringify(service.read()).includes('replacement'), false);

  const before = structuredClone(entry.options.config);
  await assert.rejects(service.save({ ...service.read().config, port: -1 }));
  assert.deepEqual(entry.options.config, before);
  await service.save({ mode: 'local', directory: '/tmp/sagitta-settings-test' });
  assert.deepEqual(service.read(), {
    config: { mode: 'local', directory: '/tmp/sagitta-settings-test' }, passwordConfigured: false,
  });
  assert.equal('password' in stored(), false);

  entry.options.config.plugins = [other];
  await persist();
  assert.throws(() => service.read(), /未配置任务插件/);
  editor.entries = () => [];
  assert.throws(() => service.read(), /尚未就绪/);
});
