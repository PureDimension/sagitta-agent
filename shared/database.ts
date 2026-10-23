import { Pool, type PoolClient, type PoolConfig } from 'pg';

const connectionTimeoutMillis = 5_000;
const statementTimeoutMillis = 30_000;

export interface Database {
  query: Pool['query'];
  transaction<T>(
    work: (
      connection: PoolClient
    ) => Promise<T>
  ): Promise<T>;
  close(): Promise<void>;
}

/** 创建独立连接池；调用方提供日志出口，并在卸载时调用 close。 */
export async function openDatabase(
  config: PoolConfig,
  reportBackgroundError: (
    error: Error
  ) => void,
): Promise<Database> {
  const pool = new Pool({
    connectionTimeoutMillis,
    statement_timeout: statementTimeoutMillis,
    ...config,
  });
  pool.on('error', reportBackgroundError);

  // Pool 按需连接，用实际查询检查可用性；初始化失败时收回资源。
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], '数据库初始化及连接池关闭失败');
    }
    throw error;
  }

  async function transaction<T>(
    work: (
      connection: PoolClient
    ) => Promise<T>
  ): Promise<T> {
    const connection = await pool.connect();
    let discardConnection = false;

    try {
      await connection.query('BEGIN');

      const result = await work(connection);

      await connection.query('COMMIT');
      return result;
    } catch (error) {
      // 保留原始失败，不重放业务；提交断连时回滚不能证明原操作未提交。
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection = true;
        throw new AggregateError([error, rollbackError], '数据库操作及回滚失败');
      }
      throw error;
    } finally {
      connection.release(discardConnection);
    }
  }

  return {
    query: pool.query.bind(pool),
    transaction,
    close: () => pool.end(),
  };
}
