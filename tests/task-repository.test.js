import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { openDatabase } from '@sagitta/runtime/database';
import { TaskRepository } from '../plugins/task/dist/repository.js';
import { createTransactionRunner } from '../plugins/task/dist/transaction.js';
import { checkTaskSchema } from '../plugins/task/dist/schema.js';
import { ProjectOperations } from '../plugins/task/dist/service/operations/project.js';
import { TaskOperations } from '../plugins/task/dist/service/operations/task.js';

test('项目与任务读写、可见性过滤及表结构版本检查', { timeout: 10_000 }, async () => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const database = await openDatabase({ ...config, max: 1 }, (
    error
  ) => assert.fail(error.message));

  try {
    await checkTaskSchema(database);

    const connection = database;
    // 单连接池的临时表跨事务保留，连接关闭时清除。
    await connection.query('CREATE TEMP TABLE projects (LIKE public.projects INCLUDING ALL)');
    const { rows } = await connection.query(`
      INSERT INTO projects (name, description) VALUES ('可见项目', '项目说明')
      RETURNING id, name, description
    `);
    const archived = await connection.query(`
      INSERT INTO projects (name, deleted_at) VALUES ('归档项目', CURRENT_TIMESTAMP) RETURNING id
    `);
    const repository = new TaskRepository(connection);

    assert.deepEqual(await repository.listProjects(), rows);
    assert.deepEqual(await repository.getProject(rows[0].id), { state: 'found', value: rows[0] });
    assert.deepEqual(await repository.getProject(archived.rows[0].id), { state: 'archived' });
    assert.deepEqual(await repository.getProject('00000000-0000-0000-0000-000000000000'), { state: 'missing' });

    const service = new ProjectOperations(repository, createTransactionRunner(database));
    const name = "O'Reilly 项目";
    const project = await service.createProject(name);
    assert.deepEqual(project, { id: project.id, name, description: '' });
    assert.deepEqual(await service.getProject(project.id), project);
    assert.equal((await service.listProjects()).length, 2);
    await assert.rejects(service.createProject('  '), /项目名称不能为空/);

    await connection.query("UPDATE projects SET updated_at = '2000-01-01' WHERE id = $1", [project.id]);
    const description = "说明含引号 ' 和换行\n[资料](./guide.md)";
    const updated = await service.updateProject(project.id, description);
    assert.deepEqual(updated, { ...project, description });
    assert.deepEqual(await service.getProject(project.id), updated);
    assert.deepEqual(await service.updateProject(project.id, ''), project);
    const timestamp = await connection.query('SELECT updated_at FROM projects WHERE id = $1', [project.id]);
    assert.ok(timestamp.rows[0].updated_at.getUTCFullYear() > 2000);

    for (const [id, state, message] of [
      [archived.rows[0].id, 'archived', '项目已归档'],
      ['00000000-0000-0000-0000-000000000000', 'missing', '项目不存在'],
    ]) {
      assert.deepEqual(await repository.updateProject(id, '不能写入'), { state });
      await assert.rejects(service.getProject(id), { message });
      await assert.rejects(service.updateProject(id, '不能写入'), { message });
    }
    const archivedRow = await connection.query('SELECT description FROM projects WHERE id = $1', [archived.rows[0].id]);
    assert.equal(archivedRow.rows[0].description, '');

    await connection.query('CREATE TEMP TABLE tasks (LIKE public.tasks INCLUDING ALL)');
    await connection.query('CREATE TEMP TABLE task_claims (LIKE public.task_claims INCLUDING ALL)');
    const taskOperations = new TaskOperations(repository, createTransactionRunner(database));
    const owner = { deviceId: 'device', sessionId: 'session' };
    const transaction = createTransactionRunner(database);
    const task = await taskOperations.createTask({ kind: 'normal', projectId: project.id, title: "检查 ' 配置", description });
    assert.equal(task.status, 'open');
    assert.equal(task.kind, 'normal');
    assert.equal(task.description, description);
    assert.equal(typeof task.id, 'string');
    assert.deepEqual(await repository.getTask(task.id), { state: 'found', value: task });
    assert.deepEqual(await repository.getTask('0'), { state: 'missing' });
    await assert.rejects(taskOperations.getTask('0'), { message: '任务不存在' });
    assert.deepEqual(await taskOperations.getTask(task.id), task);
    assert.deepEqual(await taskOperations.listTasks(project.id), [task]);
    await connection.query("UPDATE tasks SET updated_at = '2000-01-01' WHERE id = $1", [task.id]);
    const taskDescription = "任务补充 ' 引号\n[文件](./notes.md)";
    assert.deepEqual(await taskOperations.updateTask(task.id, taskDescription, owner), { ...task, description: taskDescription });
    assert.deepEqual(await taskOperations.getTask(task.id), { ...task, description: taskDescription });
    const taskTimestamp = await connection.query('SELECT updated_at FROM tasks WHERE id = $1', [task.id]);
    assert.ok(taskTimestamp.rows[0].updated_at.getUTCFullYear() > 2000);
    assert.deepEqual(await taskOperations.updateTask(task.id, '', owner), { ...task, description: '' });
    await taskOperations.updateTask(task.id, description, owner);
    assert.deepEqual(await transaction((
      repo
    ) => repo.lockTask('0')), { state: 'missing' });
    await assert.rejects(taskOperations.updateTask('0', '缺失', owner), { message: '任务不存在' });
    await assert.rejects(taskOperations.createTask({ kind: 'normal', projectId: project.id, title: '  ' }), /任务标题不能为空/);
    for (const [id, state, message] of [
      [archived.rows[0].id, 'archived', '项目已归档'],
      ['00000000-0000-0000-0000-000000000000', 'missing', '项目不存在'],
    ]) {
      assert.deepEqual(await repository.createTask(id, '无效项目', '', 'normal'), { state });
      await assert.rejects(taskOperations.createTask({ kind: 'normal', projectId: id, title: '无效项目' }), { message });
    }

    const temp = await connection.query(`
      INSERT INTO tasks (project_id, kind, title) VALUES ($1, 'temp', '临时任务') RETURNING id
    `, [project.id]);
    await connection.query(`
      INSERT INTO task_claims VALUES ($1, gen_random_uuid(), 'device', 'session', statement_timestamp() + interval '1 hour')
    `, [temp.rows[0].id]);
    assert.equal((await taskOperations.listTasks(project.id)).length, 2);
    const tempTask = await taskOperations.getTask(temp.rows[0].id);
    await connection.query("UPDATE task_claims SET expires_at = statement_timestamp() - interval '1 second'");
    // 到期后的查询保持存储结果，任务删除由后续回收流程执行。
    assert.deepEqual(await taskOperations.listTasks(project.id), [task, tempTask]);
    assert.deepEqual(await taskOperations.getTask(temp.rows[0].id), tempTask);

    // 模拟回收后的存储结果，验证 temp 删除后统一按不存在处理。
    await connection.query('DELETE FROM task_claims WHERE task_id = $1', [tempTask.id]);
    await connection.query('DELETE FROM tasks WHERE id = $1', [tempTask.id]);
    assert.deepEqual(await repository.getTask(tempTask.id), { state: 'missing' });
    await assert.rejects(taskOperations.getTask(tempTask.id), { message: '任务不存在' });

    await taskOperations.deleteTask(task.id, owner);
    assert.deepEqual(await repository.getTask(task.id), { state: 'archived' });
    assert.deepEqual(await taskOperations.listTasks(project.id), []);
    await assert.rejects(taskOperations.getTask(task.id), { message: '任务已归档' });
    assert.deepEqual(await transaction((
      repo
    ) => repo.lockTask(task.id)), { state: 'archived' });
    await assert.rejects(taskOperations.updateTask(task.id, '禁止覆盖', owner), { message: '任务已归档' });
    await connection.query('UPDATE tasks SET deleted_at = NULL');
    const toDelete = await taskOperations.createTask({ kind: 'temp', projectId: project.id, title: '临时删除', owner });
    await assert.rejects(taskOperations.deleteTask(toDelete.id, { ...owner, sessionId: 'other' }), /仅当前认领设备与会话/);
    await taskOperations.deleteTask(toDelete.id, owner);
    assert.deepEqual(await repository.getTask(toDelete.id), { state: 'missing' });
    assert.equal(await repository.hasClaim(toDelete.id), false);

    await taskOperations.claimTask(task.id, owner);
    await assert.rejects(taskOperations.deleteTask(task.id, { ...owner, deviceId: 'other' }), /仅当前认领设备与会话/);
    await connection.query("UPDATE task_claims SET expires_at = statement_timestamp() - interval '1 second'");
    await assert.rejects(taskOperations.deleteTask(task.id, owner), /认领已过期/);
    await connection.query("UPDATE task_claims SET expires_at = statement_timestamp() + interval '20 minutes'");
    // 认领已删除后让归档失败，确认认领也会恢复。
    await connection.query('ALTER TABLE tasks ADD CONSTRAINT reject_archive CHECK (deleted_at IS NULL)');
    await assert.rejects(taskOperations.deleteTask(task.id, owner), { code: '23514' });
    assert.equal(await repository.hasClaim(task.id), true);
    assert.equal((await repository.getTask(task.id)).state, 'found');
    await connection.query('ALTER TABLE tasks DROP CONSTRAINT reject_archive');
    await taskOperations.deleteTask(task.id, owner);
    assert.equal(await repository.hasClaim(task.id), false);
    await assert.rejects(taskOperations.deleteTask(task.id, owner), { message: '任务已归档' });
    await assert.rejects(taskOperations.deleteTask('0', owner), { message: '任务不存在' });

    const active = await taskOperations.createTask({ kind: 'normal', projectId: project.id, title: '待归档', claimImmediately: true, owner });
    const activeTemp = await taskOperations.createTask({ kind: 'temp', projectId: project.id, title: '待清理', owner });
    const other = await service.createProject('其他项目');
    const otherTask = await taskOperations.createTask({ kind: 'temp', projectId: other.id, title: '应保留', owner });
    // 最后一步归档项目失败时，前面的认领清理、临时删除、正式归档必须一起回滚。
    await connection.query(`ALTER TABLE projects ADD CONSTRAINT reject_archive CHECK (name <> 'O''Reilly 项目' OR deleted_at IS NULL)`);
    await assert.rejects(service.deleteProject(project.id), { code: '23514' });
    assert.equal((await repository.getProject(project.id)).state, 'found');
    assert.equal((await repository.getTask(active.id)).state, 'found');
    assert.equal((await repository.getTask(activeTemp.id)).state, 'found');
    assert.equal(await repository.hasClaim(active.id), true);
    assert.equal(await repository.hasClaim(activeTemp.id), true);
    await connection.query('ALTER TABLE projects DROP CONSTRAINT reject_archive');
    await service.deleteProject(project.id);
    assert.deepEqual(await repository.getProject(project.id), { state: 'archived' });
    assert.deepEqual(await repository.getTask(active.id), { state: 'archived' });
    assert.deepEqual(await repository.getTask(activeTemp.id), { state: 'missing' });
    assert.equal(await repository.hasClaim(active.id), false);
    assert.equal(await repository.hasClaim(activeTemp.id), false);
    assert.equal(await repository.hasClaim(otherTask.id), true);
    assert.ok((await service.listProjects()).every((
      item
    ) => item.id !== project.id));
    await assert.rejects(service.deleteProject(project.id), { message: '项目已归档' });
    await assert.rejects(service.deleteProject('00000000-0000-0000-0000-000000000000'), { message: '项目不存在' });
    assert.deepEqual(await repository.getTask(task.id), { state: 'archived' });
    assert.deepEqual(await transaction((
      repo
    ) => repo.lockTask(task.id)), { state: 'archived' });
    await assert.rejects(taskOperations.updateTask(task.id, '禁止覆盖', owner), { message: '任务已归档' });
    const preservedTask = await connection.query('SELECT description FROM tasks WHERE id = $1', [task.id]);
    assert.equal(preservedTask.rows[0].description, description);
    assert.deepEqual(await taskOperations.listTasks(project.id), []);
    await assert.rejects(taskOperations.getTask(task.id), { message: '任务已归档' });

    await connection.query('CREATE TEMP TABLE schema_migrations (version integer)');
    await assert.rejects(checkTaskSchema(connection), /表结构版本不匹配/);
    await connection.query('INSERT INTO schema_migrations VALUES (1), (2)');
    await assert.rejects(checkTaskSchema(connection), /表结构版本不匹配/);
    await connection.query('DELETE FROM schema_migrations WHERE version = 2');
    await checkTaskSchema(connection);
  } finally {
    await database.close();
  }
});

test('状态动作：正式流转、临时清理、权限拒绝与事务回滚', { timeout: 10_000 }, async () => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const database = await openDatabase({ ...config, max: 1 }, (
    error
  ) => assert.fail(error.message));
  try {
    for (const table of ['projects', 'tasks', 'task_claims']) {
      await database.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await database.query('CREATE TEMP TABLE protected_tasks (task_id bigint REFERENCES tasks(id))');
    const repository = new TaskRepository(database);
    const operations = new TaskOperations(repository, createTransactionRunner(database));
    const project = await repository.createProject('动作验证', '');
    const owner = { deviceId: 'device', sessionId: 'session' };
    for (const [method, target] of [['releaseTask', 'open'], ['completeTask', 'done'], ['blockTask', 'blocked'], ['cancelTask', 'cancelled']]) {
      for (const kind of ['normal', 'temp']) {
        const task = await operations.createTask({ kind, projectId: project.id, title: method, claimImmediately: true, owner });
        for (const other of [{ ...owner, deviceId: 'other' }, { ...owner, sessionId: 'other' }]) {
          await assert.rejects(operations[method](task.id, other), /仅当前认领设备与会话/);
        }
        await database.query("UPDATE task_claims SET expires_at = statement_timestamp() - interval '1 second' WHERE task_id = $1", [task.id]);
        await assert.rejects(operations[method](task.id, owner), /认领已过期/);
        await database.query("UPDATE task_claims SET expires_at = statement_timestamp() + interval '20 minutes' WHERE task_id = $1", [task.id]);
        for (const status of ['done', 'cancelled']) {
          await database.query('UPDATE tasks SET status = $2 WHERE id = $1', [task.id, status]);
          await assert.rejects(operations[method](task.id, owner), /不允许/);
        }
        await database.query("UPDATE tasks SET status = 'in_progress' WHERE id = $1", [task.id]);
        if (kind === 'temp' && method === 'blockTask') {
          await assert.rejects(operations.blockTask(task.id, owner), /临时任务不允许阻塞/);
          assert.equal(await repository.hasClaim(task.id), true);
          assert.deepEqual(await operations.getTask(task.id), task);
          continue;
        }

        // 让撤销认领后的写入失败，验证整个动作恢复原状。
        if (kind === 'normal') {
          await database.query(`ALTER TABLE tasks ADD CONSTRAINT reject_transition CHECK (id <> ${task.id} OR status = 'in_progress')`);
        } else {
          await database.query('INSERT INTO protected_tasks VALUES ($1)', [task.id]);
        }
        await assert.rejects(operations[method](task.id, owner), { code: kind === 'normal' ? '23514' : '23503' });
        assert.equal(await repository.hasClaim(task.id), true);
        assert.deepEqual(await operations.getTask(task.id), task);
        if (kind === 'normal') await database.query('ALTER TABLE tasks DROP CONSTRAINT reject_transition');
        else await database.query('DELETE FROM protected_tasks WHERE task_id = $1', [task.id]);

        assert.equal(await operations[method](task.id, owner), undefined);
        assert.equal(await repository.hasClaim(task.id), false);
        if (kind === 'normal') assert.equal((await operations.getTask(task.id)).status, target);
        else assert.deepEqual(await repository.getTask(task.id), { state: 'missing' });
        if (target === 'blocked' && kind === 'normal') await operations.claimTask(task.id, owner);
      }
    }
    for (const status of ['open', 'blocked']) {
      const task = await operations.createTask({ kind: 'normal', projectId: project.id, title: '未认领' });
      await database.query('UPDATE tasks SET status = $2 WHERE id = $1', [task.id, status]);
      for (const method of ['releaseTask', 'completeTask', 'blockTask']) {
        await assert.rejects(operations[method](task.id, owner), /尚未认领/);
      }
      await operations.cancelTask(task.id, owner);
      assert.equal((await operations.getTask(task.id)).status, 'cancelled');
    }
  } finally {
    await database.close();
  }
});

test('创建并立即认领：20 分钟租约及认领失败整体回滚', { timeout: 10_000 }, async () => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const database = await openDatabase({ ...config, max: 1 }, (
    error
  ) => assert.fail(error.message));

  try {
    await database.query('CREATE TEMP TABLE projects (LIKE public.projects INCLUDING ALL)');
    await database.query('CREATE TEMP TABLE tasks (LIKE public.tasks INCLUDING ALL)');
    await database.query('CREATE TEMP TABLE task_claims (LIKE public.task_claims INCLUDING ALL)');
    const repository = new TaskRepository(database);
    const operations = new TaskOperations(repository, createTransactionRunner(database));
    const project = await repository.createProject('立即认领测试', '');
    const owner = { deviceId: 'device', sessionId: 'session' };

    const unclaimed = await operations.createTask({ kind: 'normal', projectId: project.id, title: '等待领取' });
    assert.equal(unclaimed.status, 'open');
    assert.equal((await database.query('SELECT * FROM task_claims')).rowCount, 0);

    const claimed = await operations.createTask({
      kind: 'normal', projectId: project.id, title: '立即认领',
      claimImmediately: true, owner,
    });
    assert.equal(claimed.status, 'in_progress');
    const claim = await database.query(`
      SELECT *, EXTRACT(EPOCH FROM expires_at - statement_timestamp()) AS remaining
      FROM task_claims WHERE task_id = $1
    `, [claimed.id]);
    assert.equal(claim.rowCount, 1);
    assert.equal(claim.rows[0].owner_device_id, owner.deviceId);
    assert.equal(claim.rows[0].owner_session_id, owner.sessionId);
    assert.ok(claim.rows[0].claim_id);
    assert.ok(Number(claim.rows[0].remaining) > 1190 && Number(claim.rows[0].remaining) <= 1200);

    // 空设备 ID 触发数据库约束，验证认领失败同时回滚刚创建的任务。
    await assert.rejects(operations.createTask({
      kind: 'normal', projectId: project.id, title: '应当回滚',
      claimImmediately: true, owner: { ...owner, deviceId: '' },
    }), { code: '23514' });
    assert.deepEqual(await operations.listTasks(project.id), [unclaimed, claimed]);
    assert.equal((await database.query('SELECT * FROM task_claims')).rowCount, 1);

    await database.query('UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [project.id]);
    await assert.rejects(operations.createTask({
      kind: 'normal', projectId: project.id, title: '归档后认领',
      claimImmediately: true, owner,
    }), { message: '项目已归档' });
    await assert.rejects(operations.createTask({
      kind: 'normal', projectId: '00000000-0000-0000-0000-000000000000', title: '缺失项目',
      claimImmediately: true, owner,
    }), { message: '项目不存在' });
    assert.equal((await database.query('SELECT * FROM tasks')).rowCount, 2);
    assert.equal((await database.query('SELECT * FROM task_claims')).rowCount, 1);
  } finally {
    await database.close();
  }
});

test('临时创建：项目归属、自动认领、固定 20 分钟及失败回滚', { timeout: 10_000 }, async () => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const database = await openDatabase({ ...config, max: 1 }, (
    error
  ) => assert.fail(error.message));
  try {
    await database.query('CREATE TEMP TABLE projects (LIKE public.projects INCLUDING ALL)');
    await database.query('CREATE TEMP TABLE tasks (LIKE public.tasks INCLUDING ALL)');
    await database.query('CREATE TEMP TABLE task_claims (LIKE public.task_claims INCLUDING ALL)');
    const repository = new TaskRepository(database);
    const operations = new TaskOperations(repository, createTransactionRunner(database));
    const project = await repository.createProject('临时工作', '');
    const owner = { deviceId: 'device', sessionId: 'session' };
    const input = { kind: 'temp', projectId: project.id, title: '勘查', owner };
    const task = await operations.createTask(input);
    assert.deepEqual(task, { id: task.id, projectId: project.id, kind: 'temp', title: '勘查', description: '', status: 'in_progress' });
    const { rows } = await database.query(`
      SELECT owner_device_id, owner_session_id,
        EXTRACT(EPOCH FROM expires_at - statement_timestamp()) AS remaining
      FROM task_claims WHERE task_id = $1
    `, [task.id]);
    assert.equal(rows[0].owner_device_id, owner.deviceId);
    assert.equal(rows[0].owner_session_id, owner.sessionId);
    assert.ok(Number(rows[0].remaining) > 1190 && Number(rows[0].remaining) <= 1200);
    await assert.rejects(operations.claimTask(task.id, owner), /任务已有认领/);
    await assert.rejects(operations.createTask({ ...input, owner: { ...owner, deviceId: '' } }), { code: '23514' });
    await assert.rejects(operations.createTask({ ...input, title: ' ' }), /任务标题不能为空/);
    await assert.rejects(operations.createTask({ ...input, projectId: '00000000-0000-0000-0000-000000000000' }), /项目不存在/);
    await database.query('UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [project.id]);
    await assert.rejects(operations.createTask(input), /项目已归档/);
    assert.equal((await database.query('SELECT * FROM tasks')).rowCount, 1);
    assert.equal((await database.query('SELECT * FROM task_claims')).rowCount, 1);
  } finally {
    await database.close();
  }
});

test('独立认领及编辑权限：校验状态、身份与租约，失败时保留原任务', { timeout: 10_000 }, async () => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const database = await openDatabase({ ...config, max: 1 }, (
    error
  ) => assert.fail(error.message));

  try {
    await database.query('CREATE TEMP TABLE projects (LIKE public.projects INCLUDING ALL)');
    await database.query('CREATE TEMP TABLE tasks (LIKE public.tasks INCLUDING ALL)');
    await database.query('CREATE TEMP TABLE task_claims (LIKE public.task_claims INCLUDING ALL)');
    const repository = new TaskRepository(database);
    const operations = new TaskOperations(repository, createTransactionRunner(database));
    const project = await repository.createProject('认领测试', '');
    const owner = { deviceId: 'device', sessionId: 'session' };
    const task = await operations.createTask({ kind: 'normal', projectId: project.id, title: '已有任务' });

    for (const status of ['done', 'cancelled', 'in_progress']) {
      await database.query('UPDATE tasks SET status = $2 WHERE id = $1', [task.id, status]);
      await assert.rejects(operations.claimTask(task.id, owner), /不允许认领/);
    }
    await database.query("UPDATE tasks SET status = 'blocked' WHERE id = $1", [task.id]);
    // 让认领插入成功、状态更新失败，验证两次写入一起回滚。
    await database.query("ALTER TABLE tasks ADD CONSTRAINT reject_in_progress CHECK (status <> 'in_progress')");
    await assert.rejects(operations.claimTask(task.id, owner), { code: '23514' });
    assert.equal((await operations.getTask(task.id)).status, 'blocked');
    assert.equal((await database.query('SELECT * FROM task_claims')).rowCount, 0);
    await database.query('ALTER TABLE tasks DROP CONSTRAINT reject_in_progress');

    assert.equal((await operations.claimTask(task.id, owner)).status, 'in_progress');
    assert.equal((await operations.updateTask(task.id, '本人编辑', owner)).description, '本人编辑');
    for (const other of [
      { ...owner, deviceId: 'other-device' },
      { ...owner, sessionId: 'other-session' },
    ]) {
      await assert.rejects(operations.updateTask(task.id, '禁止覆盖', other), /仅当前认领设备与会话/);
    }
    assert.equal((await operations.getTask(task.id)).description, '本人编辑');
    await assert.rejects(operations.claimTask(task.id, owner), /任务已有认领/);
    await database.query("UPDATE task_claims SET expires_at = statement_timestamp() - interval '1 second'");
    await assert.rejects(operations.updateTask(task.id, '过期后覆盖', owner), /认领已过期/);
    assert.equal((await operations.getTask(task.id)).description, '本人编辑');
    await assert.rejects(operations.claimTask(task.id, owner), /任务已有认领/);
    assert.equal((await database.query('SELECT * FROM task_claims')).rowCount, 1);

    await assert.rejects(operations.claimTask('0', owner), { message: '任务不存在' });
    await database.query('UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [task.id]);
    await assert.rejects(operations.claimTask(task.id, owner), { message: '任务已归档' });
    await database.query("UPDATE tasks SET deleted_at = NULL, kind = 'temp' WHERE id = $1", [task.id]);
    await assert.rejects(operations.claimTask(task.id, owner), /任务已有认领/);
    await database.query('UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [project.id]);
    await assert.rejects(operations.claimTask(task.id, owner), { message: '任务已归档' });
  } finally {
    await database.close();
  }
});

test('项目并发归档拒绝写入；两设备认领竞争仅一方成功', { timeout: 10_000 }, async () => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const schema = `task_test_${randomUUID().replaceAll('-', '')}`;
  const database = await openDatabase({
    ...config, max: 3, application_name: schema, options: `-c search_path=${schema},public`,
  }, (
    error
  ) => assert.fail(error.message));

  try {
    // 独立测试 schema 让多个连接共享测试数据；finally 只清除此随机命名的 schema。
    await database.query(`CREATE SCHEMA ${schema}`);
    await database.query('CREATE TABLE projects (LIKE public.projects INCLUDING ALL)');
    await database.query('CREATE TABLE tasks (LIKE public.tasks INCLUDING ALL)');
    await database.query('CREATE TABLE task_claims (LIKE public.task_claims INCLUDING ALL)');
    const repository = new TaskRepository(database);
    const projects = new ProjectOperations(repository, createTransactionRunner(database));
    const tasks = new TaskOperations(repository, createTransactionRunner(database));

    for (const [operation, expectedMessage] of [
      [(
        id
      ) => projects.updateProject(id, '并发修改'), '项目已归档'],
      [(
        id
      ) => tasks.createTask({
        kind: 'normal', projectId: id, title: '并发创建',
        claimImmediately: true, owner: { deviceId: 'device', sessionId: 'session' },
      }), '项目已归档'],
      [(
        id,
        taskId
      ) => tasks.updateTask(taskId, '并发修改任务', { deviceId: 'device', sessionId: 'session' }), '任务已归档'],
      [(
        id,
        taskId
      ) => tasks.deleteTask(taskId, { deviceId: 'device', sessionId: 'session' }), '任务已归档'],
      [(
        id
      ) => projects.deleteProject(id), '项目已归档'],
    ]) {
      const project = await projects.createProject('并发项目', '原始说明');
      const task = await tasks.createTask({ kind: 'normal', projectId: project.id, title: '已有任务', description: '原始任务说明' });
      let result;
      try {
        await database.transaction(async (
          connection
        ) => {
          await connection.query('UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [project.id]);
          result = operation(project.id, task.id).then((
            value
          ) => ({ value }), (
            error
          ) => ({ error }));

          // 确认第二个操作实际在等待锁，再提交归档；避免依赖固定 sleep 猜测时序。
          let waiting = false;
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            const activity = await database.query(`
              SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'
            `, [schema]);
            if (activity.rowCount > 0) { waiting = true; break; }
            await setTimeout(10);
          }
          assert.ok(waiting, '并发操作应等待项目行锁');
        });
        assert.equal((await result).error?.message, expectedMessage);
      } finally {
        await result;
      }
      const stored = await database.query('SELECT description FROM projects WHERE id = $1', [project.id]);
      assert.equal(stored.rows[0].description, '原始说明');
      const storedTask = await database.query('SELECT description FROM tasks WHERE id = $1', [task.id]);
      assert.equal(storedTask.rows[0].description, '原始任务说明');
    }
    assert.equal((await database.query('SELECT * FROM tasks')).rowCount, 5);
    assert.equal((await database.query('SELECT * FROM task_claims')).rowCount, 0);
    const project = await projects.createProject('认领竞争', '');
    const task = await tasks.createTask({ kind: 'normal', projectId: project.id, title: '同一任务' });
    const results = await Promise.allSettled(['device-a', 'device-b'].map((
      deviceId
    ) =>
      tasks.claimTask(task.id, { deviceId, sessionId: 'session' })));
    assert.equal(results.filter((
      result
    ) => result.status === 'fulfilled').length, 1);
    assert.match(results.find((
      result
    ) => result.status === 'rejected').reason.message, /任务已有认领/);
    assert.equal((await tasks.getTask(task.id)).status, 'in_progress');
    assert.equal((await database.query('SELECT * FROM task_claims WHERE task_id = $1', [task.id])).rowCount, 1);
  } finally {
    try {
      await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await database.close();
    }
  }
});
