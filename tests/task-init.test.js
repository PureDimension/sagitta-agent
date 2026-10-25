import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { beforeEach } from 'node:test';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { openDatabase } from '@sagitta/runtime/database';
import { createToolContext } from './helpers/tool-context.js';
import TaskPlugin from '../plugins/task/dist/index.js';
import { databaseConfig, createPoolConfig } from '../plugins/task/dist/runtime/database-config.js';
import { connectTaskDatabase } from '../plugins/task/dist/runtime/connection.js';
import { TaskRepositories } from '../plugins/task/dist/repository/index.js';
import { TaskOperations } from '../plugins/task/dist/service/operations/task.js';
import { createTransactionRunner } from '../plugins/task/dist/transaction.js';
import { setTimeout } from 'node:timers/promises';

// 初始化现在会主动清理到期数据；每项测试的插件连接都使用隔离 schema。
beforeEach(async (
  t,
) => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const database = await openDatabase(config, assert.fail);
  const schema = `init_isolation_${randomUUID().replaceAll('-', '')}`;
  const previousOptions = process.env.PGOPTIONS;
  t.after(async () => {
    if (previousOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousOptions;
    await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await database.close();
  });
  await database.query(`CREATE SCHEMA ${schema}`);
  for (const table of ['schema_migrations', 'projects', 'tasks', 'task_claims']) {
    await database.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  await database.query(`INSERT INTO ${schema}.schema_migrations(version) VALUES (1)`);
  process.env.PGOPTIONS = `-c search_path=${schema}`;
});

test('插件首次挂载即清理遗留临时任务、回收正式认领，首次清理保持静默', { timeout: 10_000 }, async () => {
  const config = databaseConfig(JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8')));
  const database = await openDatabase(config, assert.fail);
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-initial-cleanup-'));
  const ctx = await createToolContext(directory);
  const notices = [];
  const agent = { id: 'session', session: { id: 'session' }, send: (
    message,
  ) => notices.push(message) };
  let fiber;
  try {
    const repository = new TaskRepositories(database);
    const operations = new TaskOperations(repository, createTransactionRunner(database));
    const project = await repository.projects.createProject('初始化清理', '');
    const owner = { deviceId: 'offline-device', sessionId: agent.id };
    const temp = await operations.createTask({ kind: 'temp', projectId: project.id, title: '遗留临时', owner });
    const normal = await operations.createTask({ kind: 'normal', projectId: project.id, title: '遗留正式', claimImmediately: true, owner });
    await database.query("UPDATE task_claims SET expires_at=clock_timestamp()-interval '1 minute'");
    await ctx.agents.register(agent);
    fiber = ctx.plugin(TaskPlugin, config);
    await fiber.await();

    // 注册首轮异步执行；等待真实数据库事务提交，期间没有主动访问任务业务入口。
    const deadline = Date.now() + 3000;
    while ((await database.query('SELECT count(*)::int AS count FROM task_claims')).rows[0].count > 0 && Date.now() < deadline) {
      await setTimeout(10);
    }
    assert.deepEqual(await repository.tasks.getTask(temp.id), { state: 'missing' });
    assert.equal((await repository.tasks.getTask(normal.id)).value.status, 'open');
    assert.equal((await database.query('SELECT count(*)::int AS count FROM task_claims')).rows[0].count, 0);
    assert.deepEqual(notices, []);
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('DSH 原生配置与生命周期：初始化、配置变更重连、失败记录及恢复', { timeout: 15_000 }, async () => {
  const config = databaseConfig(JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8')));
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-task-init-'));
  const stateFile = join(directory, 'sagitta-task', 'connection-status.json');
  const ctx = await createToolContext(directory);
  const fiber = ctx.plugin(TaskPlugin, config);

  try {
    await fiber.await();
    assert.equal(ctx.tools.schemas().length, 15);
    assert.equal((await ctx.systemPrompt.assemble()).sections.filter((
      section,
    ) => section.name === 'sagitta:projects-and-tasks').length, 1);
    let record = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(record.status, 'connected');
    assert.equal(record.target.port, config.port);
    assert.ok(Number.isFinite(Date.parse(record.checkedAt)));
    assert.equal('password' in record.target, false);
    assert.equal((await readFile(stateFile, 'utf8')).includes(config.password), false);

    // 只改变数据库名称；真实连接失败须覆盖此前的成功记录。
    fiber.update({ ...config, database: 'sagitta_missing_test_database' });
    await fiber.await();
    record = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(record.status, 'failed');
    assert.equal(record.target.database, 'sagitta_missing_test_database');
    assert.equal(ctx.tools.schemas().length, 0);

    fiber.update(config);
    await fiber.await();
    record = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(record.status, 'connected');
    assert.equal(record.target.database, config.database);
    assert.equal(ctx.tools.schemas().length, 15);
    assert.equal((await ctx.systemPrompt.assemble()).sections.filter((
      section,
    ) => section.name === 'sagitta:projects-and-tasks').length, 1);
    await fiber.dispose();
    assert.equal(ctx.tools.schemas().length, 0);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('注册中途失败撤销本批工具，清除冲突后可重新初始化', { timeout: 10_000 }, async () => {
  const config = databaseConfig(JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8')));
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-task-registration-'));
  const ctx = await createToolContext(directory);
  // task_create 前面已有七个工具完成注册，制造同作用域重名检查初始化回滚。
  const removeConflict = ctx.tools.register(defineTool({
    name: 'task_create', description: 'test conflict', parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    execute: async () => null,
  }));
  const fiber = ctx.plugin(TaskPlugin, config);
  try {
    await fiber.await();
    assert.deepEqual(ctx.tools.schemas().map((
      tool
    ) => tool.name), ['task_create']);

    removeConflict();
    fiber.update(config);
    await fiber.await();
    assert.equal(ctx.tools.schemas().length, 15);
  } finally {
    await fiber.dispose();
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('配置验证、TLS 验证策略、连接交付和关闭', { timeout: 10_000 }, async () => {
  const config = databaseConfig(JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8')));
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-task-connect-'));
  try {
    for (const port of [0, 65536, 1.5]) assert.throws(() => databaseConfig({ ...config, port }));
    assert.throws(() => databaseConfig({ ...config, host: ' ' }));
    assert.equal(databaseConfig.dict.password.meta.role, 'secret');
    assert.deepEqual((await createPoolConfig({ ...config, ssl: true })).ssl, { rejectUnauthorized: true });
    await assert.rejects(createPoolConfig({ ...config, ssl: false, caFile: 'unused.crt' }), /须启用 TLS/);

    const database = await connectTaskDatabase(config, directory, assert.fail);
    try {
      assert.equal((await database.query('SELECT 1 AS value')).rows[0].value, 1);
    } finally {
      await database.close();
    }
    await assert.rejects(database.query('SELECT 1'), /pool after calling end/);
    await assert.rejects(connectTaskDatabase({ ...config, ssl: true, caFile: join(directory, 'missing.crt') }, directory, assert.fail), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(directory, 'connection-status.json'), 'utf8')).status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('schema 检查失败不注册工具，关闭连接池；修正版本后配置重载恢复', { timeout: 10_000 }, async () => {
  const config = databaseConfig(JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8')));
  const database = await openDatabase(config, assert.fail);
  const schema = `init_test_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-task-schema-'));
  const ctx = await createToolContext(directory);
  const previousOptions = process.env.PGOPTIONS;
  const previousName = process.env.PGAPPNAME;
  let fiber;
  try {
    await database.query(`CREATE SCHEMA ${schema}`);
    await database.query(`CREATE TABLE ${schema}.schema_migrations (version integer)`);
    await database.query(`INSERT INTO ${schema}.schema_migrations VALUES (999)`);
    // pg 原生环境参数仅用于将本测试的插件连接指向隔离 schema。
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    process.env.PGAPPNAME = schema;
    fiber = ctx.plugin(TaskPlugin, config);
    await fiber.await();
    assert.equal(ctx.tools.schemas().length, 0);
    assert.equal((await database.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1', [schema])).rows[0].count, 0);
    assert.equal(JSON.parse(await readFile(join(directory, 'sagitta-task', 'connection-status.json'), 'utf8')).status, 'connected');

    await database.query(`UPDATE ${schema}.schema_migrations SET version=1`);
    fiber.update(config);
    await fiber.await();
    assert.equal(ctx.tools.schemas().length, 15);
  } finally {
    await fiber?.dispose();
    await ctx.fiber.dispose();
    if (previousOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousOptions;
    if (previousName === undefined) delete process.env.PGAPPNAME;
    else process.env.PGAPPNAME = previousName;
    await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
