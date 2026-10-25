import assert from 'node:assert/strict';
import test from 'node:test';
import { PeriodicTasks } from '@sagitta/runtime/periodic-task';
import { TaskRenewal } from '../plugins/task/dist/service/automation/renewal.js';
import { TaskReclamation } from '../plugins/task/dist/service/automation/reclamation.js';

const flush = () => new Promise(setImmediate);

test('注册按本会话续租、失败重试、间隔等待及注销', async (
  t
) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = new Map();
  const manager = new PeriodicTasks((
    callback,
    delay
  ) => { timers.set(callback, delay); return () => timers.delete(callback); }, assert.fail);
  const failure = new Error('数据库断连');
  const results = [];
  let attempts = 0;
  const renewal = new TaskRenewal({
    claims: {
      renewClaims: async (
        deviceId,
        sessions
      ) => {
        assert.equal(deviceId, 'device');
        assert.deepEqual(sessions, ['session']);
        if (++attempts <= 3) throw failure;
        return 2;
      },
    },
  });
  const unregister = renewal.register(manager, { deviceId: 'device', sessionId: 'session' }, {
    onSuccess: (
      count
    ) => results.push(count),
    onFailure: (
      error
    ) => results.push(error),
  });
  await flush();
  for (let retry = 0; retry < 2; retry++) {
    t.mock.timers.tick(5000);
    await flush();
  }
  assert.deepEqual(results, [failure]);
  assert.equal(attempts, 3);
  const [[next, delay]] = timers;
  assert.equal(delay, 300_000);
  timers.delete(next);
  next();
  await flush();
  assert.deepEqual(results, [failure, 2]);
  await unregister();
  assert.equal(timers.size, 0);
  await manager.dispose();
});

test('回收注册立即执行、失败直接报告、下一周期继续，结果经成功回调交付', async () => {
  const timers = new Map();
  const manager = new PeriodicTasks((
    callback,
    delay
  ) => { timers.set(callback, delay); return () => timers.delete(callback); }, assert.fail);
  const failure = new Error('回收提交结果未确认');
  const results = [];
  let attempts = 0;
  const reclamation = new TaskReclamation(async () => {
    if (++attempts === 1) throw failure;
    return [];
  });
  const unregister = reclamation.register(manager, {
    onSuccess: (
      expired
    ) => results.push(expired),
    onFailure: (
      error
    ) => results.push(error),
  });
  await flush();
  assert.deepEqual(results, [failure]);
  assert.equal(attempts, 1);
  const [[next, delay]] = timers;
  assert.equal(delay, 300_000);
  timers.delete(next);
  next();
  await flush();
  assert.deepEqual(results, [failure, []]);
  await unregister();
  assert.equal(timers.size, 0);
  await manager.dispose();
});

test('统一注销等待在途业务，抑制结果回调并拒绝关闭后注册', async () => {
  const manager = new PeriodicTasks(assert.fail, assert.fail);
  const pending = Promise.withResolvers();
  const options = {
    run: () => pending.promise, intervalMs: 1, retry: { retries: 0 },
    onSuccess: assert.fail, onFailure: assert.fail,
  };
  manager.register(options);
  manager.register(options);
  let closed = false;
  const closing = manager.dispose().then(() => { closed = true; });
  await flush();
  assert.equal(closed, false);
  pending.resolve();
  await closing;
  assert.throws(() => manager.register(options), /已关闭/);
  await manager.dispose();
});

test('单项注销与回调异常互相隔离，其他注册仍可继续', async () => {
  const timers = new Set();
  const errors = [];
  const manager = new PeriodicTasks((
    callback
  ) => {
    timers.add(callback);
    return () => timers.delete(callback);
  }, (
    error
  ) => errors.push(error));
  const options = {
    run: async () => 1, intervalMs: 1, retry: { retries: 0 },
    onSuccess: () => {}, onFailure: assert.fail,
  };
  const stopFirst = manager.register(options);
  manager.register(options);
  await flush();
  assert.equal(timers.size, 2);

  await stopFirst();
  assert.equal(timers.size, 1);
  const failure = new Error('结果回调异常');
  manager.register({ ...options, onSuccess: () => { throw failure; } });
  await flush();
  assert.deepEqual(errors, [failure]);
  assert.equal(timers.size, 1);

  const [next] = timers;
  timers.delete(next);
  next();
  await flush();
  assert.equal(timers.size, 1);
  await manager.dispose();
  assert.equal(timers.size, 0);
});
