import type { TaskOwner } from '../contracts.js';
import type { TaskRepositories } from '../repository/index.js';
import type { TransactionRunner } from '../transaction.js';

export const recoveredClaim = Symbol('认领已回收，按当前状态执行请求');

/** 仅当本轮只做了回收才重新取锁；事务错误直接传播，业务操作不重放。 */
export async function withClaimRecovery<T>(
  transaction: TransactionRunner,
  work: (
    repository: TaskRepositories,
  ) => Promise<T | typeof recoveredClaim>,
): Promise<T> {
  let result = await transaction(work);
  while (result === recoveredClaim) result = await transaction(work);
  return result;
}

export function isClaimOwner(
  owner: TaskOwner | undefined,
  claim: TaskOwner,
): boolean {
  return owner?.deviceId === claim.deviceId && owner.sessionId === claim.sessionId;
}

export function requiresActiveClaim(
  action: string,
): boolean {
  return action === 'complete' || action === 'release' || action === 'block';
}
