import { readFile } from 'node:fs/promises';
import type { Database } from '@sagitta/runtime/database';

const migrations = ['001-initial.sql', '002-goals.sql'];

/** 本地托管按版本顺序执行迁移；每个 SQL 文件保证原子性和可重复执行。 */
export async function initializeTaskSchema(
  database: Pick<Database, 'query'>,
): Promise<void> {
  for (const file of migrations) {
    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    await database.query(sql);
  }
}

/** 检查完整迁移记录；自定义连接仅检查，表结构由管理员维护。 */
export async function checkTaskSchema(
  database: Pick<Database, 'query'>
): Promise<void> {
  const { rows } = await database.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );

  if (rows.length !== migrations.length || rows.some((
    row,
    index,
  ) => row.version !== index + 1)) {
    throw new Error(`任务表结构版本不匹配：需要 ${migrations.length}，实际记录 [${rows.map((
      row
    ) => row.version).join(', ')}]`);
  }
}
