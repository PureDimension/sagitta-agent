import type { PeriodicTasks, UnregisterTask } from '@sagitta/runtime/periodic-task';
import type { ExpiredTask } from '../../contracts.js';
import type { TransactionRunner } from '../../transaction.js';
import { reclaimExpiredTask } from '../reclaim-expired-task.js';

const reclamationIntervalMs = 5 * 60_000;

export interface ReclamationCallbacks {
  onSuccess: (
    expiredTasks: ExpiredTask[]
  ) => void | Promise<void>;
  onFailure: (
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
    callbacks: ReclamationCallbacks,
  ): UnregisterTask {
    return periodicTasks.register({
      intervalMs: reclamationIntervalMs,
      // 回收包含物理删除，提交结果不明时直接报告，避免重试掩盖丢失的回收结果。
      retry: { retries: 0 },
      run: () => this.reclaimExpiredTasks(),
      onSuccess: callbacks.onSuccess,
      onFailure: callbacks.onFailure,
    });
  }

  reclaimExpiredTasks(): Promise<ExpiredTask[]> {
    return this.transaction(async (
      repository
    ) => {
      const taskIds = await repository.claims.listExpiredTaskIds();
      const expiredTasks: ExpiredTask[] = [];

      for (const taskId of taskIds) {
        const result = await repository.tasks.lockTask(taskId);
        // 候选扫描后可能已被主动访问清理，或随项目一起归档。
        if (result.state !== 'found') continue;

        const claim = await repository.claims.lockClaim(taskId);
        const expired = await reclaimExpiredTask(repository, result.value, claim);
        if (expired) expiredTasks.push(expired);
      }

      return expiredTasks;
    });
  }
}
