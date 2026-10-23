import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { openDatabase } from '../shared/dist/database.js';

test('真实 PostgreSQL：查询、提交、回滚及连接释放', { timeout: 10_000 }, async () => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const backgroundErrors = [];
  const database = await openDatabase({ ...config, max: 1 }, (
    error
  ) => backgroundErrors.push(error));

  try {
    // 临时表仅属于当前连接，关闭时清除；单连接池同时验证事务归还连接。
    await database.query('CREATE TEMP TABLE database_check (id integer PRIMARY KEY)');
    const result = await database.transaction(async (
      connection
    ) => {
      await connection.query('INSERT INTO database_check VALUES ($1)', [1]);
      return 'committed';
    });
    assert.equal(result, 'committed');

    await assert.rejects(database.transaction(async (
      connection
    ) => {
      await connection.query('INSERT INTO database_check VALUES ($1)', [2]);
      await connection.query('INSERT INTO database_check VALUES ($1)', [1]);
    }), { code: '23505' });

    const failure = new Error('业务拒绝');
    await assert.rejects(database.transaction(async (
      connection
    ) => {
      await connection.query('INSERT INTO database_check VALUES ($1)', [3]);
      throw failure;
    }), (
      error
    ) => error === failure);

    assert.deepEqual((await database.query('SELECT id FROM database_check')).rows, [{ id: 1 }]);
    assert.deepEqual(backgroundErrors, []);
  } finally {
    await database.close();
  }
  await assert.rejects(database.query('SELECT 1'), /Cannot use a pool after calling end/);
});
