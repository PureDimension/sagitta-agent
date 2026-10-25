import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { openDatabase } from '@sagitta/runtime/database';
import { TaskRepositories } from '../plugins/task/dist/repository/index.js';
import { createTransactionRunner } from '../plugins/task/dist/transaction.js';
import { TaskOperations } from '../plugins/task/dist/service/operations/task.js';
import { TaskReclamation } from '../plugins/task/dist/service/automation/reclamation.js';

async function withTasks(
  work,
) {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const schema = `expiry_test_${randomUUID().replaceAll('-', '')}`;
  const database = await openDatabase({
    ...config, max: 3, application_name: schema, options: `-c search_path=${schema},public`,
  }, (
    error
  ) => assert.fail(error.message));

  try {
    await database.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['projects', 'tasks', 'task_claims']) {
      await database.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await database.query('ALTER TABLE task_claims ADD FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE');
    const repository = new TaskRepositories(database);
    const operations = new TaskOperations(repository, createTransactionRunner(database));
    const project = await repository.projects.createProject('到期检查', '');
    const owner = { deviceId: 'device', sessionId: 'session' };
    await work({ database, repository, operations, projectId: project.id, owner, schema });
  } finally {
    try {
      await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await database.close();
    }
  }
}

test('周期回收跨会话清理到期任务、带回内容，有效认领保持原样', { timeout: 10_000 }, async () => {
  await withTasks(async (
    { database, repository, operations, projectId, owner }
  ) => {
    const reclamation = new TaskReclamation(createTransactionRunner(database));
    const { claimId: temporaryClaimId, ...temporary } = await operations.createTask({ kind: 'temp', projectId, title: '临时勘查', description: '保留成果', owner });
    const offlineOwner = { deviceId: 'offline-device', sessionId: 'closed-session' };
    const { claimId: normalClaimId, ...normal } = await operations.createTask({ kind: 'normal', projectId, title: '离线任务', claimImmediately: true, owner: offlineOwner });
    await database.query("UPDATE task_claims SET expires_at = clock_timestamp() - interval '1 minute'");
    const active = await operations.createTask({ kind: 'normal', projectId, title: '有效正式任务', claimImmediately: true, owner });
    const activeTemp = await operations.createTask({ kind: 'temp', projectId, title: '有效临时任务', owner });
    const validBefore = (await database.query('SELECT * FROM task_claims WHERE task_id = ANY($1::bigint[]) ORDER BY task_id', [[active.id, activeTemp.id]])).rows;

    const results = await reclamation.reclaimExpiredTasks();
    assert.deepEqual(results.map((
      result
    ) => [result.task, result.owner]), [[temporary, owner], [normal, offlineOwner]]);
    assert.equal(results[0].message, '临时任务已到期并清理');
    assert.deepEqual(await repository.tasks.getTask(temporary.id), { state: 'missing' });
    assert.deepEqual(await repository.tasks.getTask(normal.id), { state: 'found', value: { ...normal, status: 'open' } });
    assert.deepEqual((await database.query('SELECT * FROM task_claims ORDER BY task_id')).rows, validBefore);
    assert.deepEqual(await reclamation.reclaimExpiredTasks(), []);
  });
});

test('批量回收中途失败整体回滚，成功后一次返回全部内容', { timeout: 10_000 }, async () => {
  await withTasks(async (
    { database, repository, operations, projectId, owner }
  ) => {
    const reclamation = new TaskReclamation(createTransactionRunner(database));
    const { claimId: temporaryClaimId, ...temporary } = await operations.createTask({ kind: 'temp', projectId, title: '先清理', owner });
    const { claimId: normalClaimId, ...normal } = await operations.createTask({ kind: 'normal', projectId, title: '后失败', claimImmediately: true, owner });
    await database.query("UPDATE task_claims SET expires_at = clock_timestamp() - interval '1 minute'");
    const before = (await database.query('SELECT * FROM task_claims ORDER BY task_id')).rows;
    await database.query("ALTER TABLE tasks ADD CONSTRAINT reject_open CHECK (status <> 'open')");

    await assert.rejects(reclamation.reclaimExpiredTasks(), { code: '23514' });
    assert.deepEqual(await repository.tasks.getTask(temporary.id), { state: 'found', value: temporary });
    assert.deepEqual(await repository.tasks.getTask(normal.id), { state: 'found', value: normal });
    assert.deepEqual((await database.query('SELECT * FROM task_claims ORDER BY task_id')).rows, before);
    await database.query('ALTER TABLE tasks DROP CONSTRAINT reject_open');
    assert.equal((await reclamation.reclaimExpiredTasks()).length, 2);
  });
});

test('周期回收与主动访问竞争，同一临时任务只返回一份回收内容', { timeout: 10_000 }, async () => {
  await withTasks(async (
    { database, operations, projectId, owner }
  ) => {
    const reclamation = new TaskReclamation(createTransactionRunner(database));
    const { claimId, ...task } = await operations.createTask({ kind: 'temp', projectId, title: '竞争清理', owner });
    await database.query("UPDATE task_claims SET expires_at = clock_timestamp() - interval '1 minute'");
    const [first, second, accessed] = await Promise.allSettled([
      reclamation.reclaimExpiredTasks(), reclamation.reclaimExpiredTasks(),
      operations.execute({ action: 'get', taskId: task.id }),
    ]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'fulfilled');
    const results = [...first.value, ...second.value];
    if (accessed.status === 'fulfilled') results.push(accessed.value);
    else assert.equal(accessed.reason.message, '任务不存在');
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, 'expired');
    assert.deepEqual(results[0].task, task);
  });
});

test('全部单任务动作先回收到期任务，返回原内容；列表和其他任务保持原样', { timeout: 10_000 }, async () => {
  await withTasks(async (
    { database, repository, operations, projectId, owner }
  ) => {
    const { claimId: untouchedClaimId, ...untouched } = await operations.createTask({ kind: 'temp', projectId, title: '其他到期任务', owner });
    await database.query("UPDATE task_claims SET expires_at = clock_timestamp() - interval '1 minute'");

    for (const action of ['get', 'update', 'delete', 'claim', 'release', 'complete', 'block', 'cancel']) {
      for (const kind of ['normal', 'temp']) {
        const { claimId, ...task } = await operations.createTask({ kind, projectId, title: action, description: '必须带回的内容', claimImmediately: true, owner });
        await database.query("UPDATE task_claims SET expires_at = clock_timestamp() - interval '1 minute' WHERE task_id = $1", [task.id]);
        assert.ok((await operations.listTasks(projectId)).some((
          item
        ) => item.id === task.id));

        const result = await operations.execute({ action, taskId: task.id, owner, description: '不应写入' });
        assert.equal(result.kind, 'expired');
        assert.deepEqual(result.task, task);
        assert.deepEqual(result.owner, owner);
        assert.match(result.message, /到期.*本次操作未执行/);
        assert.equal(await repository.claims.hasClaim(task.id), false);
        if (kind === 'temp') {
          assert.deepEqual(await repository.tasks.getTask(task.id), { state: 'missing' });
          await assert.rejects(operations.execute({ action: 'get', taskId: task.id }), /任务不存在/);
        } else {
          assert.deepEqual(await operations.execute({ action: 'get', taskId: task.id }), {
            kind: 'success', value: { ...task, status: 'open' },
          });
        }
      }
    }
    assert.equal(await repository.claims.hasClaim(untouched.id), true);
    assert.deepEqual(await repository.tasks.getTask(untouched.id), { state: 'found', value: untouched });
  });
});

test('回收失败整体回滚：正式状态更新和临时删除失败均恢复认领', { timeout: 10_000 }, async () => {
  await withTasks(async (
    { database, repository, operations, projectId, owner }
  ) => {
    await database.query('CREATE TABLE protected_tasks (task_id bigint REFERENCES tasks(id))');
    for (const kind of ['normal', 'temp']) {
      const { claimId, ...task } = await operations.createTask({ kind, projectId, title: '回收回滚', claimImmediately: true, owner });
      await database.query("UPDATE task_claims SET expires_at = clock_timestamp() - interval '1 minute' WHERE task_id = $1", [task.id]);
      const before = (await database.query('SELECT * FROM task_claims WHERE task_id = $1', [task.id])).rows;
      if (kind === 'temp') await database.query('INSERT INTO protected_tasks VALUES ($1)', [task.id]);
      else await database.query("ALTER TABLE tasks ADD CONSTRAINT reject_open CHECK (status <> 'open')");

      await assert.rejects(operations.execute({ action: 'get', taskId: task.id }), { code: kind === 'temp' ? '23503' : '23514' });
      assert.deepEqual((await database.query('SELECT * FROM task_claims WHERE task_id = $1', [task.id])).rows, before);
      assert.deepEqual(await repository.tasks.getTask(task.id), { state: 'found', value: task });

      if (kind === 'temp') await database.query('DELETE FROM protected_tasks');
      else await database.query('ALTER TABLE tasks DROP CONSTRAINT reject_open');
      assert.equal((await operations.execute({ action: 'get', taskId: task.id })).kind, 'expired');
    }
  });
});

test('两个并发访问仅一个取得临时任务的到期回收结果', { timeout: 10_000 }, async () => {
  await withTasks(async (
    { database, operations, projectId, owner }
  ) => {
    const task = await operations.createTask({ kind: 'temp', projectId, title: '并发清理', owner });
    await database.query("UPDATE task_claims SET expires_at = clock_timestamp() - interval '1 minute' WHERE task_id = $1", [task.id]);
    const results = await Promise.allSettled([
      operations.execute({ action: 'get', taskId: task.id }),
      operations.execute({ action: 'complete', taskId: task.id, owner }),
    ]);
    assert.equal(results.filter((
      result
    ) => result.status === 'fulfilled' && result.value.kind === 'expired').length, 1);
    const rejected = results.find((
      result
    ) => result.status === 'rejected');
    assert.equal(rejected.reason.message, '任务不存在');
  });
});

test('等待认领行锁期间到期，取得锁后回收而非继续执行', { timeout: 10_000 }, async () => {
  await withTasks(async (
    { database, operations, projectId, owner, schema }
  ) => {
    const { claimId, ...task } = await operations.createTask({ kind: 'temp', projectId, title: '等待锁', owner });
    await database.query("UPDATE task_claims SET expires_at = clock_timestamp() + interval '1 second' WHERE task_id = $1", [task.id]);
    let pending;
    try {
      await database.transaction(async (
        connection
      ) => {
        await connection.query('SELECT task_id FROM task_claims WHERE task_id = $1 FOR UPDATE', [task.id]);
        pending = operations.execute({ action: 'get', taskId: task.id }).then((
          value
        ) => ({ value }), (
          error
        ) => ({ error }));
        let waiting = false;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const activity = await database.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [schema]);
          if (activity.rowCount > 0) { waiting = true; break; }
          await setTimeout(10);
        }
        assert.ok(waiting, '访问应等待认领行锁');
        await connection.query('SELECT pg_sleep(GREATEST(0, extract(epoch FROM expires_at - clock_timestamp())) + 0.05) FROM task_claims WHERE task_id = $1', [task.id]);
      });
      const result = await pending;
      assert.equal(result.error, undefined);
      assert.equal(result.value.kind, 'expired');
      assert.deepEqual(result.value.task, task);
    } finally {
      await pending;
    }
  });
});
