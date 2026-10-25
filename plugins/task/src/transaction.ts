import type { Database } from '@sagitta/runtime/database';
import { TaskRepositories } from './repository/index.js';

/** 业务声明事务范围；回调中的数据库操作统一使用传入的 Repository。 */
export type TransactionRunner = <T>(
  work: (
    repository: TaskRepositories
  ) => Promise<T>,
) => Promise<T>;

/** 组装事务内的 Repository，提交、回滚和连接释放复用 Database。 */
export function createTransactionRunner(
  database: Database
): TransactionRunner {
  return function transaction<T>(
    work: (
      repository: TaskRepositories
    ) => Promise<T>
  ): Promise<T> {
    return database.transaction((
      connection
    ) => {
      const repository = new TaskRepositories(connection);

      return work(repository);
    });
  };
}
