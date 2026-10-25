import { join } from 'node:path';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { openDatabase, type Database } from '@sagitta/runtime/database';
import { createPoolConfig, type TaskDatabaseConfig } from './database-config.js';

/** 每次初始化真实连接；历史检查记录仅作展示，配置变更后的重新初始化由 DSH 驱动。 */
export async function connectTaskDatabase(
  config: TaskDatabaseConfig,
  stateDirectory: string,
  reportBackgroundError: (
    error: Error
  ) => void,
): Promise<Database> {
  let database: Database;
  try {
    database = await openDatabase(await createPoolConfig(config), reportBackgroundError);
  } catch (error) {
    return recordFailure(config, stateDirectory, error);
  }

  // 成功记录保存后才交付连接；记录失败时释放新连接池。
  try {
    await saveStatus(config, stateDirectory, 'connected');
  } catch (error) {
    try {
      await database.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], '连接状态保存及连接池关闭失败');
    }
    throw error;
  }

  return database;
}

async function recordFailure(
  config: TaskDatabaseConfig,
  stateDirectory: string,
  error: unknown,
): Promise<never> {
  try {
    await saveStatus(config, stateDirectory, 'failed');
  } catch (recordError) {
    throw new AggregateError([error, recordError], '数据库连接及失败状态保存失败');
  }
  throw error;
}

async function saveStatus(
  config: TaskDatabaseConfig,
  stateDirectory: string,
  status: 'connected' | 'failed',
): Promise<void> {
  const { host, port, database, user, ssl } = config;
  const record = { status, checkedAt: new Date().toISOString(), target: { host, port, database, user, ssl } };
  const path = join(stateDirectory, 'connection-status.json');
  await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}
