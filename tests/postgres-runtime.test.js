import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { preparePostgresRuntime } from '../plugins/task/dist/database-management/runtime.js';
import { prepareLocalDatabase } from '../plugins/task/dist/database-management/local.js';
import TaskPlugin from '../plugins/task/dist/index.js';
import { taskConfig } from '../plugins/task/dist/config.js';
import { createToolContext } from './helpers/tool-context.js';

test('数据库配置按模式校验，本地必须提供目录', () => {
  assert.equal(taskConfig({}).mode, 'custom');
  assert.equal(taskConfig({ mode: 'local', directory: '/tmp/test' }).directory, '/tmp/test');
  assert.throws(() => taskConfig({ mode: 'local' }));
  assert.throws(() => taskConfig({ mode: 'other' }));
  assert.throws(() => taskConfig({ mode: 'custom', port: 0 }));
});

test('目录内安装、程序复用及真实 PostgreSQL 停机后数据保留', {
  skip: !process.env.SAGITTA_TEST_MANAGED_POSTGRES,
  timeout: 660_000,
}, async (
  t,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-postgres-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = (
    message,
  ) => console.log(message);
  const runtime = await preparePostgresRuntime(directory, report);
  assert.equal((await preparePostgresRuntime(directory, report)).moduleUrl, runtime.moduleUrl);

  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((
    resolve,
  ) => server.close(resolve));
  const { default: EmbeddedPostgres } = await import(runtime.moduleUrl);
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'), user: 'sagitta', password: 'isolated-test-password',
    port, persistent: true, authMethod: 'scram-sha-256',
    postgresFlags: ['-h', '127.0.0.1', '-k', ''],
    onLog: () => {}, onError: report,
  });
  await postgres.initialise();
  await postgres.start();
  try {
    const client = postgres.getPgClient('postgres', '127.0.0.1');
    await client.connect();
    try {
      await client.query('CREATE TABLE persistence_check (value integer)');
      await client.query('INSERT INTO persistence_check VALUES (742)');
    } finally {
      await client.end();
    }
  } finally {
    await postgres.stop();
  }

  await postgres.start();
  try {
    const client = postgres.getPgClient('postgres', '127.0.0.1');
    await client.connect();
    try {
      assert.deepEqual((await client.query('SELECT value FROM persistence_check')).rows, [{ value: 742 }]);
    } finally {
      await client.end();
    }
  } finally {
    await postgres.stop();
  }
});

test('本地数据库生成配置、并发复用已运行实例、停机后按原配置启动', {
  skip: !process.env.SAGITTA_TEST_MANAGED_POSTGRES,
  timeout: 660_000,
}, async (
  t,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-local-database-'));
  let runtime;
  const stop = () => promisify(execFile)(runtime.pg_ctl, ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
  t.after(async () => {
    try {
      if (existsSync(join(directory, 'data', 'postmaster.pid'))) await stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  runtime = await preparePostgresRuntime(directory, console.log);
  const config = await prepareLocalDatabase(directory, console.log);
  const client = new Client(config);
  await client.connect();
  try {
    const reused = await Promise.all([
      prepareLocalDatabase(directory, console.log), prepareLocalDatabase(directory, console.log),
    ]);
    assert.deepEqual(reused, [config, config]);
    await client.query('CREATE TABLE persistence_check (value integer)');
    await client.query('INSERT INTO persistence_check VALUES (742)');
  } finally {
    await client.end();
  }
  await stop();
  const reopened = new Client(await prepareLocalDatabase(directory, console.log));
  await reopened.connect();
  try {
    assert.deepEqual((await reopened.query('SELECT value FROM persistence_check')).rows, [{ value: 742 }]);
  } finally {
    await reopened.end();
  }
});

test('任务插件本地初始化建表，重复挂载保留数据，切换自定义连接沿用工具', {
  skip: !process.env.SAGITTA_TEST_MANAGED_POSTGRES,
  timeout: 660_000,
}, async (
  t,
) => {
  const directory = await mkdtemp(join(tmpdir(), 'sagitta-local-plugin-'));
  const databaseDirectory = join(directory, 'database');
  let runtime;
  let ctx;
  t.after(async () => {
    try {
      await ctx?.fiber.dispose();
    } finally {
      if (existsSync(join(databaseDirectory, 'data', 'postmaster.pid'))) {
        await promisify(execFile)(runtime.pg_ctl, ['-D', join(databaseDirectory, 'data'), '-m', 'fast', '-w', 'stop']);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  runtime = await preparePostgresRuntime(databaseDirectory, console.log);
  ctx = await createToolContext(directory);
  const config = { mode: 'local', directory: databaseDirectory };
  const fiber = ctx.plugin(TaskPlugin, config);
  await fiber.await();
  assert.equal(ctx.tools.schemas().length, 15);
  const call = (
    name,
    args,
  ) => ctx.tools.execute({ name, arguments: args, agent: { id: 'local-test' }, callId: name, signal: new AbortController().signal });
  const created = await call('project_create', { name: '本地接入验收' });
  assert.notEqual(created.isError, true);
  fiber.update(config);
  await fiber.await();
  assert.deepEqual((await call('project_list', {})).value, [created.value]);
  const connection = JSON.parse(await readFile(join(databaseDirectory, 'connection.json'), 'utf8'));
  fiber.update({ mode: 'custom', ...connection });
  await fiber.await();
  assert.equal(ctx.tools.schemas().length, 15);
  assert.deepEqual((await call('project_list', {})).value, [created.value]);
});
