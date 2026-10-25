import type { ExpiredTask, Task, TaskClaim } from '../contracts.js';
import type { TaskRepositories } from '../repository/index.js';

/** 调用方在同一事务内先锁任务、再锁认领；回收结果正常返回，使清理得以提交。 */
export async function reclaimExpiredTask(
  repository: TaskRepositories,
  task: Task,
  claim: TaskClaim | undefined,
): Promise<ExpiredTask | undefined> {
  if (!claim?.expired) return undefined;

  await repository.claims.deleteClaim(task.id);
  if (task.kind === 'temp') await repository.tasks.deleteTaskRecord(task.id);
  else await repository.tasks.updateTaskStatus(task.id, 'open');

  return {
    kind: 'expired',
    task,
    owner: { deviceId: claim.deviceId, sessionId: claim.sessionId },
    message: task.kind === 'temp'
      ? '临时任务已到期并清理'
      : '任务认领已到期并回收，任务恢复待领取',
  };
}
