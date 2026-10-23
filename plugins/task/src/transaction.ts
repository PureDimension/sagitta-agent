import type { Database } from '@sagitta/runtime/database';
import { TaskRepository } from './repository.js';

/** 业务声明事务范围；回调中的数据库操作统一使用传入的 Repository。 */
export type TransactionRunner = <T>(
  work: (
    repository: TaskRepository
  ) => Promise<T>,
) => Promise<T>;

/** 仅在已有事务回调内使用；组合调用共享 Repository，由外层提交或回滚。 */
export function reuseTransactionRunner(
  repository: TaskRepository
): TransactionRunner {
  return async (
    work
  ) => work(repository);
}

/** 组装事务内的 Repository，提交、回滚和连接释放复用 Database。 */
export function createTransactionRunner(
  database: Database
): TransactionRunner {
  return function transaction<T>(
    work: (
      repository: TaskRepository
    ) => Promise<T>
  ): Promise<T> {
    return database.transaction((
      connection
    ) => {
      const repository = new TaskRepository(connection);

      return work(repository);
    });
  };
}
