import type { TaskClaim, TaskOwner } from '../contracts.js';

/** 编辑和删除的认领权限检查；无认领时允许，有认领时要求租约有效且身份匹配。 */
export function requireTaskWriteAccess(
  claim: TaskClaim | undefined,
  owner: TaskOwner
): void {
  if (!claim) return;
  if (claim.expired) throw new Error('任务认领已过期，请等待回收');
  if (claim.deviceId !== owner.deviceId || claim.sessionId !== owner.sessionId) {
    throw new Error('仅当前认领设备与会话可以操作此任务');
  }
}
