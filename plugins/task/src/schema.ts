import type { Database } from '@sagitta/runtime/database';

const schemaVersion = 1;

/** 只检查应用表结构版本；初始化与迁移由独立脚本完成。 */
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
