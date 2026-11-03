import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { openDatabase } from '@sagitta/runtime/database';
import { checkTaskSchema, initializeTaskSchema } from '../plugins/task/dist/schema.js';

test('从版本 1 升级两次，项目、任务、原认领凭据均保留，数据库拒绝跨项目关联', async () => {
  const config = JSON.parse(await readFile(process.env.SAGITTA_TEST_DB_CONFIG, 'utf8'));
  const schema = 'migration_' + randomUUID().replaceAll('-', '');
  const database = await openDatabase({ ...config, options: `-c search_path=${schema}` }, assert.fail);
  try {
    await database.query(`CREATE SCHEMA ${schema}`);
    await database.query(await readFile(new URL('../plugins/task/migrations/001-initial.sql', import.meta.url), 'utf8'));
    const project = (await database.query("INSERT INTO projects(name) VALUES ('旧项目') RETURNING id")).rows[0].id;
    const task = (await database.query("INSERT INTO tasks(project_id, kind, title, status) VALUES ($1,'normal','旧任务','in_progress') RETURNING *", [project])).rows[0];
    const claim = (await database.query("INSERT INTO task_claims VALUES ($1,DEFAULT,'device','session',now()+interval '20 minutes') RETURNING *", [task.id])).rows[0];
    await initializeTaskSchema(database);
    await initializeTaskSchema(database);
    await checkTaskSchema(database);
    assert.deepEqual((await database.query('SELECT * FROM tasks')).rows, [{ ...task, goal_id: null }]);
    assert.deepEqual((await database.query('SELECT * FROM task_claims')).rows, [claim]);
    const other = (await database.query("INSERT INTO projects(name) VALUES ('另一个项目') RETURNING id")).rows[0].id;
    const goal = (await database.query("INSERT INTO goals(project_id,title) VALUES ($1,'目标') RETURNING id", [other])).rows[0].id;
    await assert.rejects(database.query('UPDATE tasks SET goal_id=$1 WHERE id=$2', [goal, task.id]), { code: '23503' });
  } finally {
    await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await database.close();
  }
});
