import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope';
import { createToolContext } from './helpers/tool-context.js';
import { registerTaskMaintenance } from '../plugins/task/dist/adapters/maintenance.js';
import { TaskRenewal } from '../plugins/task/dist/service/automation/renewal.js';
import { TaskReclamation } from '../plugins/task/dist/service/automation/reclamation.js';
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';

const flush = () => new Promise(setImmediate);

test('续租接入：已有和新建会话、作用域隔离、卸载及原会话恢复', async (
  t,
) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-renewal-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  const ctx = await createToolContext(directory);
  const preset = {};
  const scope = createScope(ctx, preset);
  const calls = [];
  const notices = [];
  let failing = false;
  const reclamation = new TaskReclamation(async () => []);
  const renewal = new TaskRenewal({ claims: { renewClaims: async (
    device,
    sessions,
  ) => {
    calls.push({ device, sessions });
    if (failing) throw new Error('续租测试断连');
    return 1;
  } } });
  const existing = { id: 'existing', session: { id: 'existing' }, send: (
    message,
    target,
    wakeup,
  ) => notices.push({ message, target, wakeup }) };
  const outside = { id: 'outside', session: { id: 'outside' } };
  const fresh = { id: 'fresh', session: { id: 'fresh' } };
  bindScopeParent(existing, preset);
  bindScopeParent(fresh, preset);

  try {
    const removeExisting = await ctx.agents.register(existing);
    await ctx.agents.register(outside);
    await scope.ctx.inject(['agents', 'timer'], function* (
      context,
    ) { yield* registerTaskMaintenance(context, renewal, reclamation); });
    await flush();
    assert.deepEqual(calls.map((
      call,
    ) => call.sessions), [['existing']]);
    const removeFresh = await ctx.agents.register(fresh);
    await flush();
    assert.deepEqual(calls.at(-1).sessions, ['fresh']);
    assert.equal(calls[0].device, calls[1].device);

    await removeExisting();
    t.mock.timers.tick(5 * 60_000);
    await flush();
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.at(-1).sessions, ['fresh']);
    await ctx.agents.register(existing);
    await flush();
    assert.deepEqual(calls.at(-1).sessions, ['existing']);
    await removeFresh();
    failing = true;
    t.mock.timers.tick(5 * 60_000);
    await flush();
    for (let retry = 0; retry < 2; retry++) {
      t.mock.timers.tick(5_000);
      await flush();
    }
    assert.equal(notices.length, 1);
    assert.equal(notices[0].target, 'next-step');
    assert.equal(notices[0].wakeup, false);
    assert.equal(notices[0].message.source.kind, 'sagitta-task');
    await scope.dispose();
    t.mock.timers.tick(5 * 60_000);
    await flush();
    assert.equal(calls.length, 7);
  } finally {
    await scope.dispose();
    await ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('周期清理通知：首次静默、连续在线满 20 分钟、临时任务归属及重启后重新计时', async (
  t,
) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-expiry-notice-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  const ctx = await createToolContext(directory);
  const preset = {};
  const scope = createScope(ctx, preset);
  const notices = [];
  const agent = { id: 'session', session: { id: 'session' }, send: (
    message,
    target,
    wakeup,
  ) => notices.push({ message, target, wakeup }) };
  bindScopeParent(agent, preset);
  const expired = (
    id,
    kind = 'temp',
  ) => ({ kind: 'expired', task: { id, kind, title: `任务 ${id}`, description: '保留原始勘查内容' },
    owner: { deviceId: getOrCreateAnonymousUserId(), sessionId: agent.id }, message: '已清理' });
  let pending = [expired('startup')];
  let scans = 0;
  const reclamation = new TaskReclamation(async () => {
    scans++;
    const result = pending;
    pending = [];
    return result;
  });
  const renewal = new TaskRenewal({ claims: { renewClaims: async () => 0 } });
  const tick = async () => { t.mock.timers.tick(5 * 60_000); await flush(); };

  try {
    let removeAgent = await ctx.agents.register(agent);
    await scope.ctx.inject(['agents', 'timer'], function* (
      context,
    ) { yield* registerTaskMaintenance(context, renewal, reclamation); });
    await flush();
    assert.equal(scans, 1);
    assert.equal(notices.length, 0);
    pending = [expired('before-20-minutes')];
    await tick();
    assert.equal(notices.length, 0);
    await tick();
    await tick();
    const other = expired('other-session');
    other.owner.sessionId = 'other-session';
    const remote = expired('other-device');
    remote.owner.deviceId = 'other-device';
    pending = [expired('notify'), expired('normal', 'normal'), other, remote];
    await tick();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].target, 'next-step');
    assert.equal(notices[0].wakeup, false);
    const text = notices[0].message.content[0].text;
    assert.match(text, /任务 notify/);
    assert.match(text, /保留原始勘查内容/);
    assert.doesNotMatch(text, /other-session|other-device|任务 normal/);
    await tick();
    assert.equal(notices.length, 1);

    await removeAgent();
    removeAgent = await ctx.agents.register(agent);
    pending = [expired('after-resume')];
    await tick();
    assert.equal(notices.length, 1);
    await removeAgent();
    const scansBefore = scans;
    await tick();
    assert.equal(scans, scansBefore + 1, '无在线会话时仍清理离线认领');
    await scope.dispose();
    await tick();
    assert.equal(scans, scansBefore + 1);
  } finally {
    await scope.dispose();
    await ctx.fiber.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});
