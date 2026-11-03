import type { PeriodicTasks, UnregisterTask } from '@sagitta/runtime/periodic-task';
import type { ExpiredTask } from '../../contracts.js';
import type { TransactionRunner } from '../../transaction.js';
import { reclaimExpiredTask } from '../reclaim-expired-task.js';

const reclamationIntervalMs = 5 * 60_000;

interface ReclamationCallbacks {
  onSuccess: (
    result: ExpiredTask[]
  ) => void | Promise<void>;
  onFailure: (
    error: unknown
  ) => void | Promise<void>;
  onGoalFailure: (
    error: unknown
  ) => void | Promise<void>;
}

/** 插件级注册一次，回收所有会话遗留的到期任务；通知由接入层按原 owner 分发。 */
export class TaskReclamation {
  constructor(
    private readonly transaction: TransactionRunner,
  ) {}

  register(
    periodicTasks: PeriodicTasks,
    reclaimGoals: () => Promise<void>,
    callbacks: ReclamationCallbacks,
  ): UnregisterTask {
    return periodicTasks.register({
      intervalMs: reclamationIntervalMs,
      retry: { retries: 0 },
      run: () => Promise.allSettled([this.reclaimExpiredTasks(), reclaimGoals()]),
      onSuccess: async (
        [tasks, goals],
      ) => {
        // 即使目标扫描失败，也交付本轮已经清理的临时任务。
        if (tasks.status === 'fulfilled') await callbacks.onSuccess(tasks.value);
        else await callbacks.onFailure(tasks.reason);
        if (goals.status === 'rejected') await callbacks.onGoalFailure(goals.reason);
      },
      onFailure: callbacks.onFailure,
    });
  }

  reclaimExpiredTasks(): Promise<ExpiredTask[]> {
    return this.transaction(async (
      repository
    ) => {
      const taskIds = await repository.claims.listExpiredIds('task');
      const expiredTasks: ExpiredTask[] = [];

      for (const taskId of taskIds) {
        const result = await repository.tasks.lockTask(taskId);
        // 候选扫描后可能已被主动访问清理，或随项目一起归档。
        if (result.state !== 'found') continue;

        const claim = await repository.claims.lockClaim('task', taskId);
        const expired = await reclaimExpiredTask(repository, result.value, claim);
        if (expired) expiredTasks.push(expired);
      }

      return expiredTasks;
    });
  }
}
