import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope';
import { openDatabase } from '@sagitta/runtime/database';
import { createToolContext } from './helpers/tool-context.js';
import { registerProjectTools } from '../plugins/task/dist/adapters/tools/project.js';
import { registerGoalTools } from '../plugins/task/dist/adapters/tools/goal.js';
import { WorkContext } from '../plugins/task/dist/service/operations/work-context.js';
import { initializeTaskSchema } from '../plugins/task/dist/schema.js';
import { TaskRenewal } from '../plugins/task/dist/service/automation/renewal.js';
import { GoalOperations } from '../plugins/task/dist/service/operations/goal.js';
import { registerTaskTools } from '../plugins/task/dist/adapters/tools/task.js';
import { registerTaskGuidance } from '../plugins/task/dist/adapters/guidance.js';
import { registerTaskWorkContext } from '../plugins/task/dist/adapters/work-context.js';
import { ProjectOperations } from '../plugins/task/dist/service/operations/project.js';
import { TaskOperations } from '../plugins/task/dist/service/operations/task.js';
import { TaskRepositories } from '../plugins/task/dist/repository/index.js';
import { createTransactionRunner } from '../plugins/task/dist/transaction.js';

async function withTools(
  work,
) {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const schema = `tool_test_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-task-tools-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  const database = await openDatabase({ ...config, options: `-c search_path=${schema}` }, assert.fail);
  const ctx = await createToolContext(directory);
  const preset = {};
  const scope = createScope(ctx, preset);
  // Agent 身份替身仅提供 ID 和作用域关系；注册与执行管线均使用真实 DSH。
  const agent = { id: 'session-a' };
  const other = { id: 'session-b' };
  bindScopeParent(agent, preset);
  bindScopeParent(other, preset);
  try {
    await database.query(`CREATE SCHEMA ${schema}`);
    await initializeTaskSchema(database);
    const repository = new TaskRepositories(database);
    const transaction = createTransactionRunner(database);
    await scope.ctx.inject(['tools', 'systemPrompt'], function* (
      toolContext,
    ) {
      yield* registerGoalTools(toolContext, new GoalOperations(repository, transaction));
      yield* registerProjectTools(toolContext, new ProjectOperations(repository, transaction));
      yield* registerTaskTools(toolContext, new TaskOperations(repository, transaction));
      yield registerTaskGuidance(toolContext);
      yield* registerTaskWorkContext(toolContext, new WorkContext(createTransactionRunner(database, 'snapshot')));
    });

    const call = (
      name,
      args,
      caller = agent,
    ) => ctx.tools.execute({ name, arguments: args, agent: caller, callId: randomUUID(), signal: new AbortController().signal });
    const success = async (
      name,
      args,
      caller = agent,
    ) => {
      const result = await call(name, args, caller);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.content[0].text), result.value);
      return result.value;
    };
    await work({ ctx, scope, agent, other, directory, database, call, success });
  } finally {
    await scope.dispose();
    await ctx.fiber.dispose();
    await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await database.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
}

test('目标可选且限于同项目；完成前列出未结束任务并保留各自认领', async () => {
  await withTools(async (
    { ctx, agent, other, call, success, database },
  ) => {
    const p = await success('project_create', { name: '游戏' });
    const q = await success('project_create', { name: '其他' });
    const goal = await success('goal_create', { projectId: p.id, title: '可以试玩', claimImmediately: true });
    const readContext = async (
      caller,
    ) => {
      const { sections } = await ctx.systemPrompt.assemble({ scope: caller, agent: caller });
      const section = sections.find((
        item,
      ) => item.name === 'sagitta:current-work');
      return JSON.parse(section.text.slice(section.text.indexOf('[')));
    };
    assert.deepEqual((await readContext(agent))[0].goals, [goal]);
    assert.deepEqual(await readContext(other), []);
    assert.equal((await success('goal_list', { projectId: p.id }))[0].claimId, undefined);

    const create = { projectId: p.id, kind: 'normal', title: '试玩关卡', description: '试玩入口' };
    const task = await success('task_create', create);
    assert.equal(task.goalId, null);
    const moved = await success('task_update', { taskId: task.id, goalId: goal.id });
    assert.equal(moved.task.description, '试玩入口');
    assert.deepEqual(await success('task_list', { projectId: p.id, goalId: goal.id }), [moved.task]);
    assert.equal((await call('task_create', { ...create, projectId: q.id, goalId: goal.id })).isError, true);
    assert.deepEqual(await success('task_list', { projectId: q.id }), []);
    assert.equal((await call('goal_delete', { goalId: goal.id }, other)).isError, true);

    const child = await success('task_create', { ...create, goalId: goal.id, claimImmediately: true }, other);
    const temp = await success('task_create', { ...create, kind: 'temp', goalId: goal.id });
    const cancelled = await success('task_create', { ...create, goalId: goal.id });
    await success('task_cancel', { taskId: cancelled.id });
    const theirs = (await readContext(other))[0];
    assert.equal(theirs.goals.length, 1);
    assert.equal(theirs.goals[0].id, goal.id);
    assert.equal(theirs.goals[0].claimId, undefined);
    assert.equal(theirs.tasks[0].claimId, child.claimId);

    const blocked = await success('task_create', { ...create, goalId: goal.id, claimImmediately: true });
    await success('task_block', { taskId: blocked.id });
    const done = await success('task_create', { ...create, goalId: goal.id, claimImmediately: true });
    await success('task_complete', { taskId: done.id });

    const finish = { goalId: goal.id };
    const refusal = await call('goal_complete', finish);
    assert.equal(refusal.isError, true);
    for (const [item, state] of [[task, 'open'], [child, 'in_progress'], [temp, 'in_progress'], [blocked, 'blocked']]) {
      assert.ok(refusal.content[0].text.includes(`#${item.id} ${item.title}（${state}）`));
    }
    for (const item of [done, cancelled]) assert.ok(!refusal.content[0].text.includes(`#${item.id} `));
    assert.equal((await readContext(agent))[0].goals[0].claimId, goal.claimId);
    assert.equal((await readContext(other))[0].tasks[0].claimId, child.claimId);
    assert.equal((await success('task_get', { taskId: task.id })).task.status, 'open');
    assert.equal((await success('goal_get', { goalId: goal.id })).status, 'in_progress');
    await success('task_complete', { taskId: child.id }, other);
    await success('task_complete', { taskId: temp.id });
    await success('task_cancel', { taskId: blocked.id });
    await success('task_claim', { taskId: task.id });
    await success('task_complete', { taskId: task.id });
    const result = await success('goal_complete', finish);
    assert.equal((await success('task_get', { taskId: blocked.id })).task.status, 'cancelled');
    assert.equal(result.status, 'done');
    assert.equal((await success('task_get', { taskId: task.id })).task.status, 'done');
    assert.equal((await success('task_get', { taskId: cancelled.id })).task.status, 'cancelled');
    assert.equal((await call('task_get', { taskId: temp.id })).isError, true);
    assert.equal((await database.query('SELECT * FROM goal_claims')).rowCount, 0);
    assert.deepEqual(await readContext(agent), []);

    assert.equal((await success('task_update', { taskId: child.id, goalId: null })).task.goalId, null);
    await success('goal_delete', { goalId: goal.id });
    assert.deepEqual((await success('task_list', { projectId: p.id })).map((
      item,
    ) => item.id), [child.id]);
    assert.deepEqual(await success('goal_list', { projectId: p.id }), []);
    assert.match((await call('goal_get', { goalId: goal.id })).content[0].text, /已归档/);
  });
});

test('过期目标按当前状态操作，只有原持有者失去必要认领时返回 expired', async () => {
  await withTools(async (
    { database, success, call, other },
  ) => {
    const project = await success('project_create', { name: '到期检查' });
    for (const caller of [undefined, other]) {
      for (const action of ['get', 'update', 'claim', 'release', 'block', 'cancel', 'complete', 'delete']) {
        const goal = await success('goal_create', { projectId: project.id, title: action, claimImmediately: true });
        const args = { goalId: goal.id };
        await database.query("UPDATE goal_claims SET expires_at = now() - interval '1 minute' WHERE goal_id = $1", [goal.id]);
        if (['release', 'block', 'complete'].includes(action)) {
          if (caller === other) {
            const result = await call('goal_' + action, args, caller);
            assert.equal(result.isError, true);
            assert.match(result.content[0].text, /请先认领目标/);
            assert.doesNotMatch(result.content[0].text, /到期/);
          } else {
            const result = await success('goal_' + action, args);
            assert.equal(result.kind, 'expired');
            assert.equal(result.goal.id, goal.id);
          }
          assert.equal((await success('goal_get', args)).status, 'open');
          assert.match((await call('goal_complete', args)).content[0].text, /请先认领目标/);
          continue;
        }
        const result = await success('goal_' + action, action === 'update' ? { ...args, description: '新说明' } : args, caller);
        if (action === 'delete') {
          assert.match((await call('goal_get', args)).content[0].text, /已归档/);
        } else {
          assert.equal(result.status, { claim: 'in_progress', cancel: 'cancelled' }[action] ?? 'open');
          if (action === 'claim') assert.notEqual(result.claimId, goal.claimId);
          if (action === 'update') assert.equal(result.description, '新说明');
        }
      }
    }
  });
});

test('新建和移动任务均拒绝已结束目标，已有任务仍能编辑和移出', async () => {
  await withTools(async (
    { call, success },
  ) => {
    const project = await success('project_create', { name: '目标归属' });
    const base = { projectId: project.id, title: '测试' };
    const task = await success('task_create', { ...base, kind: 'normal' });
    for (const action of ['complete', 'cancel']) {
      const goal = await success('goal_create', { ...base, claimImmediately: true });
      const args = { goalId: goal.id };
      const child = await success('task_create', { ...base, ...args, kind: 'normal' });
      await success('task_cancel', { taskId: child.id });
      await success('goal_' + action, args);
      assert.match((await call('task_create', { ...base, ...args, kind: 'temp' })).content[0].text, /目标已结束/);
      assert.match((await call('task_update', { taskId: task.id, ...args, description: '应回滚' })).content[0].text, /目标已结束/);
      assert.deepEqual((await success('task_get', { taskId: task.id })).task, task);
      assert.equal((await success('task_list', { projectId: project.id, ...args })).length, 1);
      assert.equal((await success('task_update', { taskId: child.id, ...args, description: '交接' })).task.description, '交接');
      assert.equal((await success('task_update', { taskId: child.id, goalId: null })).task.goalId, null);
    }
  });
});

test('目标级联删除仅处理当前下属任务；归档失败时恢复任务和原认领', async () => {
  await withTools(async (
    { database, call, success, other },
  ) => {
    const project = await success('project_create', { name: '项目' });
    const base = { projectId: project.id, title: '阶段', claimImmediately: true };
    const goal = await success('goal_create', base);
    const sibling = await success('goal_create', base, other);
    const normal = await success('task_create', { ...base, goalId: goal.id, kind: 'normal' }, other);
    const temp = await success('task_create', { ...base, goalId: goal.id, kind: 'temp' });
    const outside = await success('task_create', { ...base, goalId: sibling.id, kind: 'temp' }, other);
    const args = { goalId: goal.id };

    // 在最后一步注入数据库错误，检查前面的认领撤销、清理与归档一起回滚。
    await database.query('ALTER TABLE goals ADD CONSTRAINT keep_goal CHECK (deleted_at IS NULL)');
    assert.equal((await call('goal_delete', args)).isError, true);
    assert.equal((await success('task_list', { projectId: project.id, ...args })).length, 2);
    const claimIds = async () => (await database.query(
      'SELECT claim_id FROM task_claims UNION ALL SELECT claim_id FROM goal_claims ORDER BY claim_id',
    )).rows.map((
      row,
    ) => row.claim_id);
    assert.deepEqual(await claimIds(), [goal, sibling, normal, temp, outside].map((
      item,
    ) => item.claimId).sort());

    await database.query('ALTER TABLE goals DROP CONSTRAINT keep_goal');
    await success('goal_delete', args);
    assert.match((await call('task_get', { taskId: normal.id })).content[0].text, /已归档/);
    assert.match((await call('task_get', { taskId: temp.id })).content[0].text, /不存在/);
    assert.deepEqual(await claimIds(), [sibling.claimId, outside.claimId].sort());
    assert.equal((await success('task_get', { taskId: outside.id }, other)).task.status, 'in_progress');
  });
});

test('目标的认领、续租与回收独立于任务；空目标可完成，取消目标保留下属任务', async () => {
  await withTools(async (
    { database, call, success, other },
  ) => {
    const project = await success('project_create', { name: '长期项目' });
    const goal = await success('goal_create', { projectId: project.id, title: '阶段结果' });
    const args = { goalId: goal.id };
    const task = await success('task_create', { ...args, projectId: project.id, title: '工作', kind: 'normal' });
    const { claimId } = await success('goal_claim', args);
    assert.equal((await call('goal_release', args, other)).isError, true);
    assert.equal((await success('goal_update', { ...args, description: '验收条件' })).description, '验收条件');
    const repository = new TaskRepositories(database);
    const lease = (await database.query('SELECT owner_device_id, owner_session_id FROM goal_claims')).rows[0];
    assert.equal(await new TaskRenewal(repository.claims).renewClaims(lease.owner_device_id, [lease.owner_session_id]), 1);
    assert.equal((await database.query('SELECT claim_id FROM goal_claims')).rows[0].claim_id, claimId);
    await database.query("UPDATE goal_claims SET expires_at = now() - interval '1 minute'");
    await new GoalOperations(repository, createTransactionRunner(database)).reclaimExpired();
    assert.equal((await success('goal_get', args)).status, 'open');
    assert.notEqual((await success('goal_claim', args)).claimId, claimId);
    assert.equal((await success('goal_block', args)).status, 'blocked');
    await success('goal_claim', args);
    assert.equal((await success('goal_release', args)).status, 'open');
    await success('goal_claim', args);
    await success('task_update', { taskId: task.id, goalId: null });
    assert.equal((await success('goal_complete', args)).status, 'done');
    assert.equal((await success('task_get', { taskId: task.id })).task.status, 'open');

    const next = await success('goal_create', { projectId: project.id, title: '后续安排' });
    await success('task_update', { taskId: task.id, goalId: next.id });
    assert.equal((await success('goal_cancel', { goalId: next.id })).status, 'cancelled');
    assert.equal((await success('task_get', { taskId: task.id })).task.status, 'open');
    await success('goal_create', { projectId: project.id, title: '正在跟进', claimImmediately: true });
    await success('project_delete', { projectId: project.id });
    assert.deepEqual(await success('goal_list', { projectId: project.id }), []);
    assert.equal((await database.query('SELECT * FROM goal_claims')).rowCount, 0);
  });
});

test('组装上下文期间目标被删除，项目、目标与任务来自同一读快照', async () => {
  await withTools(async (
    { database, success },
  ) => {
    const project = await success('project_create', { name: '快照检查' });
    const goal = await success('goal_create', { projectId: project.id, title: '阶段' });
    const task = await success('task_create', { projectId: project.id, goalId: goal.id,
      title: '正在做', kind: 'normal', claimImmediately: true });
    const snapshot = createTransactionRunner(database, 'snapshot');
    const work = new WorkContext((
      read,
    ) => snapshot(async (
      repository,
    ) => {
      const list = repository.tasks.listContext.bind(repository.tasks);
      repository.tasks.listContext = async (
        owner,
      ) => {
        const rows = await list(owner);
        await success('goal_delete', { goalId: goal.id });
        return rows;
      };
      return read(repository);
    }));
    const { rows } = await database.query('SELECT owner_device_id AS "deviceId", owner_session_id AS "sessionId" FROM task_claims WHERE task_id=$1', [task.id]);
    const [current] = await work.listClaimedProjects(rows[0]);
    assert.deepEqual(current.tasks, [task]);
    assert.deepEqual(current.goals, [goal]);
    assert.deepEqual(await new WorkContext(snapshot).listClaimedProjects(rows[0]), []);
  });
});

test('主动工具：项目 CRUD、任务创建编辑删除、五个独立状态工具', async () => {
  await withTools(async (
    { success, call, database }
  ) => {
    const project = await success('project_create', { name: '工具测试', description: '初始说明' });
    assert.deepEqual(await success('project_get', { projectId: project.id }), project);
    assert.deepEqual(await success('project_list', {}), [project]);
    assert.equal((await success('project_update', { projectId: project.id, description: '更新说明' })).description, '更新说明');
    const normal = await success('task_create', { projectId: project.id, kind: 'normal', title: '正式任务' });
    assert.equal(normal.status, 'open');
    assert.deepEqual(await success('task_list', { projectId: project.id }), [normal]);
    assert.deepEqual((await success('task_get', { taskId: normal.id })).task, normal);
    assert.equal((await success('task_update', { taskId: normal.id, description: '验收要求' })).task.description, '验收要求');

    for (const action of ['claim', 'release', 'claim', 'block', 'claim', 'complete']) {
      assert.equal((await success(`task_${action}`, { taskId: normal.id })).kind, 'success');
    }
    assert.equal((await success('task_get', { taskId: normal.id })).task.status, 'done');
    assert.equal((await call('task_claim', { taskId: normal.id })).isError, true);

    const cancelled = await success('task_create', { projectId: project.id, kind: 'normal', title: '取消任务', claimImmediately: true });
    assert.equal(cancelled.status, 'in_progress');
    await success('task_cancel', { taskId: cancelled.id });
    assert.equal((await success('task_get', { taskId: cancelled.id })).task.status, 'cancelled');
    await success('task_delete', { taskId: cancelled.id });
    assert.match(JSON.stringify(await call('task_get', { taskId: cancelled.id })), /已归档/);

    const temp = await success('task_create', { projectId: project.id, kind: 'temp', title: '临时任务' });
    assert.equal(temp.status, 'in_progress');
    await success('task_delete', { taskId: temp.id });
    assert.match(JSON.stringify(await call('task_get', { taskId: temp.id })), /不存在/);
    await success('task_create', { projectId: project.id, kind: 'temp', title: '随项目清理' });
    await success('project_delete', { projectId: project.id });
    assert.deepEqual(await success('project_list', {}), []);
    assert.deepEqual(await success('task_list', { projectId: project.id }), []);
    assert.match(JSON.stringify(await call('project_get', { projectId: project.id })), /已归档/);
    assert.equal((await database.query('SELECT count(*)::int AS count FROM task_claims')).rows[0].count, 0);
  });
});

test('真实参数校验、身份不可伪造、跨会话权限、结果隐藏内部字段', async () => {
  await withTools(async (
    { ctx, agent, other, success, call, database, directory }
  ) => {
    const project = await success('project_create', { name: '权限测试' });
    const cancelled = await ctx.tools.execute({ name: 'project_create', arguments: { name: '已取消调用' }, agent, callId: randomUUID(), signal: AbortSignal.abort() });
    assert.equal(cancelled.isError, true);
    assert.equal((await success('project_list', {})).length, 1);
    assert.equal((await call('task_get', { taskId: 123 })).isError, true);
    assert.equal((await call('task_create', { projectId: project.id, kind: 'emergency', title: '错误类型' })).isError, true);
    assert.equal((await call('task_create', { projectId: project.id, kind: 'temp', title: '错误参数', claimImmediately: false })).isError, true);
    assert.equal((await success('task_list', { projectId: project.id })).length, 0);
    for (const options of [{}, { claimImmediately: true }]) {
      const temp = await success('task_create', { projectId: project.id, kind: 'temp', title: '立即认领', ...options });
      assert.equal(temp.status, 'in_progress');
      const owner = (await database.query('SELECT owner_session_id FROM task_claims WHERE task_id=$1', [temp.id])).rows[0];
      assert.equal(owner.owner_session_id, agent.id);
    }

    const task = await success('task_create', { projectId: project.id, kind: 'normal', title: '认领测试', claimImmediately: true, owner: { deviceId: 'forged', sessionId: 'forged' } });
    const claim = (await database.query('SELECT * FROM task_claims WHERE task_id=$1', [task.id])).rows[0];
    assert.equal(claim.owner_session_id, agent.id);
    assert.equal(claim.owner_device_id, (await readFile(join(directory, '.anonymous-user-id'), 'utf8')).trim());
    assert.equal((await call('task_update', { taskId: task.id, description: '越权', owner: { deviceId: claim.owner_device_id, sessionId: agent.id } }, other)).isError, true);
    assert.equal((await call('task_complete', { taskId: task.id }, other)).isError, true);
    assert.equal((await call('task_delete', { taskId: task.id }, other)).isError, true);
    const missingAgent = await ctx.tools.execute({ name: 'task_update', arguments: { taskId: task.id, description: '无会话' }, callId: randomUUID(), signal: new AbortController().signal });
    // 该测试的工具为作用域注册，全局调用首先被 DSH 可见性规则拒绝。
    assert.equal(missingAgent.isError, true);
    const tool = ctx.tools.get('task_update', agent);
    await assert.rejects(tool.execute({ taskId: task.id, description: '无会话' }, {}), /Agent 会话/);

    const result = await success('task_get', { taskId: task.id });
    for (const key of ['owner', 'deviceId', 'sessionId', 'expires_at', 'claim_id']) {
      assert.equal(JSON.stringify(result).includes(`"${key}"`), false);
    }
    const invalidAction = await call('task_transition', { taskId: task.id, action: 'reopen' });
    assert.equal(invalidAction.isError, true);
    assert.equal((await success('task_get', { taskId: task.id })).task.status, 'in_progress');
  });
});

test('原会话编辑过期任务：正式任务更新成功，临时任务回显清理前内容', async () => {
  await withTools(async (
    { success, database }
  ) => {
    const project = await success('project_create', { name: '到期测试' });
    for (const kind of ['normal', 'temp']) {
      const args = { projectId: project.id, kind, title: '到期任务', description: '原始交接' };
      if (kind === 'normal') args.claimImmediately = true;
      const { claimId, ...task } = await success('task_create', args);
      await database.query("UPDATE task_claims SET expires_at=clock_timestamp()-interval '1 minute' WHERE task_id=$1", [task.id]);
      const result = await success('task_update', { taskId: task.id, description: '不应写入' });
      assert.equal(result.kind, kind === 'temp' ? 'expired' : 'success');
      if (kind === 'temp') {
        assert.deepEqual(result.task, task);
        assert.match(result.message, /本次操作未执行/);
      }
      assert.equal('owner' in result, false);
      const rows = (await database.query('SELECT status, description FROM tasks WHERE id=$1', [task.id])).rows;
      assert.deepEqual(rows, kind === 'temp' ? [] : [{ status: 'open', description: '不应写入' }]);
    }
  });
});

test('当前工作按会话隔离，返回认领凭据并随修改、续租和重新认领更新', async () => {
  await withTools(async (
    { ctx, scope, agent, other, success, database },
  ) => {
    const project = await success('project_create', { name: '上下文项目', description: '项目概览' });
    const normal = await success('task_create', { projectId: project.id, kind: 'normal', title: '正常', claimImmediately: true });
    const temp = await success('task_create', { projectId: project.id, kind: 'temp', title: '临时' });
    const theirs = await success('task_create', { projectId: project.id, kind: 'normal', title: '其他会话', claimImmediately: true }, other);
    const read = async (
      caller = agent,
    ) => {
      const assembly = await ctx.systemPrompt.assemble({ scope: caller, agent: caller });
      const sections = assembly.sections.filter((
        section,
      ) => section.name === 'sagitta:current-work');
      assert.equal(sections.length, 1);
      return JSON.parse(sections[0].text.trim().split('\n').slice(2).join('\n'));
    };
    assert.equal(normal.claimId, (await database.query('SELECT claim_id FROM task_claims WHERE task_id=$1', [normal.id])).rows[0].claim_id);
    const [mine, others] = await Promise.all([read(), read(other)]);
    assert.deepEqual(mine, [{ ...project, goals: [], tasks: [normal, temp] }]);
    assert.deepEqual(others, [{ ...project, goals: [], tasks: [theirs] }]);
    assert.equal((await success('task_get', { taskId: normal.id }, other)).task.claimId, undefined);
    await success('task_update', { taskId: normal.id, description: '新进展' });
    assert.equal((await read())[0].tasks[0].description, '新进展');

    const repository = new TaskRepositories(database);
    const deviceId = (await database.query('SELECT owner_device_id FROM task_claims WHERE task_id=$1', [normal.id])).rows[0].owner_device_id;
    await repository.claims.renewClaims(deviceId, [agent.id]);
    assert.equal((await read())[0].tasks[0].claimId, normal.claimId);
    await success('task_release', { taskId: normal.id });
    assert.deepEqual((await read())[0].tasks, [temp]);
    const reclaimed = (await success('task_claim', { taskId: normal.id })).task;
    assert.notEqual(reclaimed.claimId, normal.claimId);
    assert.equal((await read())[0].tasks[0].claimId, reclaimed.claimId);
    await database.query("UPDATE task_claims SET expires_at=clock_timestamp()-interval '1 minute' WHERE task_id=$1", [temp.id]);
    assert.deepEqual((await read())[0].tasks, [reclaimed]);
    await success('project_delete', { projectId: project.id });
    assert.deepEqual(await read(), []);
    await scope.dispose();
    assert.equal((await ctx.systemPrompt.assemble({ scope: agent, agent })).sections.some((
      section,
    ) => section.name === 'sagitta:current-work'), false);
  });
});

test('工具与固定说明随请求组装、作用域隔离及卸载，连续组装不累积', async () => {
  await withTools(async (
    { ctx, scope, agent, other, call }
  ) => {
    assert.equal(ctx.tools.schemas(agent).length, 25);
    assert.equal(ctx.tools.schemas(other).length, 25);
    assert.equal(ctx.tools.get('task_transition', agent), undefined);
    assert.equal(ctx.tools.schemas().length, 0);
    const outside = { id: 'unrelated-session' };
    assert.equal(ctx.tools.schemas(outside).length, 0);
    assert.equal((await call('project_list', {}, outside)).isError, true);
    let previous;
    for (let step = 0; step < 3; step++) {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent });
      const guidance = assembly.sections.filter((
        section,
      ) => section.name === 'sagitta:projects-and-tasks');
      assert.equal(guidance.length, 1);
      assert.equal(assembly.tools.length, 25);
      assert.match(guidance[0].text, /项目 project/);
      assert.match(guidance[0].text, /blocked（阻塞中）/);
      assert.equal(assembly.contexts.length, 0);
      if (previous) assert.deepEqual(assembly, previous);
      previous = assembly;
    }
    assert.equal((await ctx.systemPrompt.assemble({ scope: outside })).sections.some((
      section,
    ) => section.name === 'sagitta:projects-and-tasks'), false);
    await scope.dispose();
    assert.equal(ctx.tools.schemas(agent).length, 0);
    assert.equal((await ctx.systemPrompt.assemble({ scope: agent })).sections.some((
      section,
    ) => section.name === 'sagitta:projects-and-tasks'), false);
    assert.equal((await call('project_list', {})).isError, true);
  });
});

test('项目与任务原子追加：并发内容保留、原样拼接、权限及到期规则', async () => {
  await withTools(async (
    { success, call, other, database }
  ) => {
    const project = await success('project_create', { name: '追加测试', description: '原文' });
    const task = await success('task_create', { projectId: project.id, kind: 'normal', title: '追加测试', description: '原文', claimImmediately: true });
    const fragments = Array.from({ length: 8 }, (
      _,
      index,
    ) => `\n片段${index}`);

    for (const [tool, target, getTool] of [
      ['project_update', { projectId: project.id }, 'project_get'],
      ['task_update', { taskId: task.id }, 'task_get'],
    ]) {
      await Promise.all(fragments.map((
        description,
      ) => success(tool, { ...target, mode: 'append', description })));
      const result = await success(getTool, target);
      const description = (result.task ?? result).description;
      assert.equal(description.split('\n')[0], '原文');
      assert.deepEqual(description.split('\n').slice(1).sort(), fragments.map((
        fragment,
      ) => fragment.slice(1)).sort());

      await success(tool, { ...target, description: '' });
      const longText = "中文 ' \n".repeat(10_000);
      const appended = await success(tool, { ...target, mode: 'append', description: longText });
      assert.equal((appended.task ?? appended).description, longText);
      const empty = await success(tool, { ...target, mode: 'append', description: '' });
      assert.equal((empty.task ?? empty).description, longText);
      assert.equal((await call(tool, { ...target, mode: 'unknown', description: '无效' })).isError, true);
    }

    assert.equal((await call('task_update', { taskId: task.id, mode: 'append', description: '越权' }, other)).isError, true);
    const before = (await success('task_get', { taskId: task.id })).task.description;
    await database.query("UPDATE task_claims SET expires_at=clock_timestamp()-interval '1 minute' WHERE task_id=$1", [task.id]);
    const updated = await success('task_update', { taskId: task.id, mode: 'append', description: '过期追加' });
    assert.equal(updated.kind, 'success');
    assert.equal((await success('task_get', { taskId: task.id })).task.description, before + '过期追加');

    await success('project_delete', { projectId: project.id });
    assert.match(JSON.stringify(await call('project_update', { projectId: project.id, mode: 'append', description: '归档追加' })), /已归档/);
    assert.match(JSON.stringify(await call('task_update', { taskId: task.id, mode: 'append', description: '归档追加' })), /已归档/);
  });
});
