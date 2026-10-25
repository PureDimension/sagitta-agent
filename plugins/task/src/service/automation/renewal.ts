import type { PeriodicTasks, UnregisterTask } from '@sagitta/runtime/periodic-task';
import type { TaskOwner } from '../../contracts.js';
import type { TaskRepositories } from '../../repository/index.js';

const renewalIntervalMs = 5 * 60_000;
const renewalRetry = { retries: 2, minTimeout: 5_000, factor: 1, maxRetryTime: 60_000 };

export interface RenewalCallbacks {
  onSuccess: (
    renewedCount: number
  ) => void | Promise<void>;
  onFailure: (
    error: unknown
  ) => void | Promise<void>;
}

/** 声明续租策略并提供单轮业务；身份与通知渠道由接入层传入。 */
export class TaskRenewal {
  constructor(
    private readonly repository: TaskRepositories
  ) {}

  register(
    periodicTasks: PeriodicTasks,
    owner: TaskOwner,
    callbacks: RenewalCallbacks,
  ): UnregisterTask {
    const { deviceId, sessionId } = owner;

    return periodicTasks.register({
      intervalMs: renewalIntervalMs,
      retry: renewalRetry,
      run: () => this.renewClaims(deviceId, [sessionId]),
      onSuccess: callbacks.onSuccess,
      onFailure: callbacks.onFailure,
    });
  }

  async renewClaims(
    deviceId: string,
    sessionIds: readonly string[]
  ): Promise<number> {
    if (sessionIds.length === 0) return 0;

    return this.repository.claims.renewClaims(deviceId, sessionIds);
  }
}
