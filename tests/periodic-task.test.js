import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { runPeriodicTask } from '@sagitta/runtime/periodic-task';

test('重试耗尽后继续下轮；业务与结果回调结束后才等待', async () => {
  const controller = new AbortController();
  const calls = [];
  const failure = new Error('数据库暂时不可用');
  let attempts = 0;
  await runPeriodicTask({
    signal: controller.signal, intervalMs: 300_000,
    retry: { retries: 1, minTimeout: 0 },
    run: async () => {
      calls.push('run');
      if (++attempts <= 2) throw failure;
      return 3;
    },
    onSuccess: async (
      count
    ) => {
      assert.equal(count, 3);
      await Promise.resolve();
      calls.push('success');
      controller.abort();
    },
    onFailure: (
      error
    ) => { assert.equal(error, failure); calls.push('failure'); },
    wait: async (
      delay
    ) => { assert.equal(delay, 300_000); calls.push('wait'); },
  });
  assert.deepEqual(calls, ['run', 'run', 'failure', 'wait', 'run', 'success']);
});

test('停止覆盖执行、重试等待、周期间隔及启动前，停止后无回调或新一轮', { timeout: 2000 }, async () => {
  for (const phase of ['before', 'running', 'retry', 'waiting']) {
    const controller = new AbortController();
    let attempts = 0;
    if (phase === 'before') controller.abort();
    await runPeriodicTask({
      signal: controller.signal, intervalMs: 300_000,
      retry: { retries: 2, minTimeout: 1000 },
      run: async () => {
        attempts++;
        if (phase === 'running') controller.abort();
        if (phase === 'retry') {
          setImmediate(() => controller.abort());
          throw new Error('连接失败');
        }
      },
      onSuccess: () => assert.equal(phase, 'waiting'),
      onFailure: () => assert.fail('停止不应报告业务失败'),
      wait: async (
        delay
      ) => {
        setImmediate(() => controller.abort());
        await setTimeout(delay, undefined, { signal: controller.signal });
      },
    });
    assert.equal(attempts, phase === 'before' ? 0 : 1);
  }
});

test('结果报告或调度失败向上传播，均不重放业务', async () => {
  for (const stage of ['onSuccess', 'onFailure', 'wait']) {
    const error = new Error(stage);
    let attempts = 0;
    const options = {
      signal: new AbortController().signal, intervalMs: 1, retry: { retries: 0 },
      run: async () => { attempts++; if (stage === 'onFailure') throw new Error('业务失败'); },
      onSuccess: () => {}, onFailure: () => {}, wait: async () => {},
    };
    options[stage] = async () => { throw error; };
    await assert.rejects(runPeriodicTask(options), (
      actual
    ) => actual === error);
    assert.equal(attempts, 1);
  }
});
