import type { Task, TaskOwner } from '../contracts.js';
import type { TaskRepository } from '../repository.js';
import type { TransactionRunner } from '../transaction.js';
import { requireFound } from './require-found.js';
import { requireTaskWriteAccess } from './require-task-write-access.js';

/** 共用事务、锁和有效认领检查；具体状态规则由动作回调声明。 */
export function withClaimedTask(
  transaction: TransactionRunner,
  taskId: string,
  owner: TaskOwner,
  work: (
    repository: TaskRepository,
    task: Task
  ) => Promise<void>,
): Promise<void> {
  return transaction(async (
    repository
  ) => {
    const task = requireFound(await repository.lockTask(taskId), '任务');
    const claim = await repository.lockClaim(task.id);
    if (!claim) throw new Error('任务尚未认领');
    requireTaskWriteAccess(claim, owner);

    await work(repository, task);
  });
}
