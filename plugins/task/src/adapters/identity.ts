import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { TaskOwner } from '../contracts.js';

/** 身份只从运行环境取得；设备标识沿用 DSH_HOME 范围的持久 UUID。 */
export function getTaskOwner(
  exec: Pick<ToolRunContext, 'agent'>,
): TaskOwner {
  if (!exec.agent) throw new Error('任务写入需要所属的 Agent 会话');

  return { deviceId: getOrCreateAnonymousUserId(), sessionId: exec.agent.id };
}
