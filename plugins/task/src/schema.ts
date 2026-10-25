import { readFile } from 'node:fs/promises';
import type { Database } from '@sagitta/runtime/database';

const schemaVersion = 1;

/** 本地托管使用与安装脚本相同的 SQL；文件内原子检查并初始化。 */
export async function initializeTaskSchema(
  database: Pick<Database, 'query'>,
): Promise<void> {
  const sql = await readFile(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8');
  await database.query(sql);
}

/** 检查应用表结构版本；已有其他版本时报告错误，迁移另行实现。 */
export async function checkTaskSchema(
  database: Pick<Database, 'query'>
): Promise<void> {
  const { rows } = await database.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );

  if (rows.length !== 1 || rows[0].version !== schemaVersion) {
    throw new Error(`任务表结构版本不匹配：需要 ${schemaVersion}，实际记录 [${rows.map((
      row
    ) => row.version).join(', ')}]`);
  }
}
