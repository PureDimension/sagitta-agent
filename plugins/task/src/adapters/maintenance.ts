import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-timer';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import { PeriodicTasks, type UnregisterTask } from '@sagitta/runtime/periodic-task';
import type { TaskRenewal } from '../service/automation/renewal.js';
import type { TaskReclamation } from '../service/automation/reclamation.js';

const expiryNoticeDelayMs = 20 * 60_000;

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    'sagitta-task': { kind: 'sagitta-task' };
  }
}

/** 统一挂载会话续租与插件级回收；计时和重试沿用各自的 Service 注册策略。 */
export function* registerTaskMaintenance(
  ctx: Context,
  renewal: TaskRenewal,
  reclamation: TaskReclamation,
) {
  const deviceId = getOrCreateAnonymousUserId();
  const registrations = new Map<Agent, { stop: UnregisterTask; startedAt: number }>();
  const periodicTasks = new PeriodicTasks((
    callback,
    delayMs,
  ) => ctx.timeout(callback, delayMs), (
    error,
  ) => ctx.logger.error(error));
  yield () => periodicTasks.dispose();

  let initialScan = true;
  yield reclamation.register(periodicTasks, {
    onSuccess: (
      expiredTasks,
    ) => {
      // 初始化的首次成功清理静默；配置重载也重新开始观察在线时长。
      if (initialScan) {
        initialScan = false;
        return;
      }

      for (const [agent, { startedAt }] of registrations) {
        if (Date.now() - startedAt < expiryNoticeDelayMs) continue;
        const tasks = expiredTasks.filter((
          expired,
        ) => expired.task.kind === 'temp' && expired.owner.deviceId === deviceId
          && expired.owner.sessionId === agent.id).map((
          expired,
        ) => expired.task);
        if (tasks.length === 0) continue;

        agent.send(createUserMessage({
          source: { kind: 'sagitta-task' },
          content: [{ type: 'text', text: `
以下临时任务已到期并被周期清理，原任务记录如下（包含标题、ID 与 description）：
${JSON.stringify(tasks, null, 2)}
` }],
        }), 'next-step', false);
      }
    },
    onFailure: (
      error,
    ) => ctx.logger.error('任务周期回收失败', error),
  });

  function start(
    agent: Agent,
  ): void {
    // 注册表覆盖整个进程；只接管当前插件作用域内的会话。
    const scope = scopeOf(ctx);
    if (scope && !scopeChainOf(agent).includes(scope)) return;
    if (registrations.has(agent)) return;

    const stop = renewal.register(periodicTasks, { deviceId, sessionId: agent.id }, {
      onSuccess: () => {},
      onFailure: (
        error,
      ) => {
        ctx.logger.error(`会话 ${agent.id} 的任务续租失败`, error);
        agent.send(createUserMessage({
          source: { kind: 'sagitta-task' },
          content: [{ type: 'text', text: '正式任务自动续租重试后仍失败，认领可能到期。请检查任务状态；系统将在下一周期继续尝试。' }],
        }), 'next-step', false);
      },
    });
    registrations.set(agent, { stop, startedAt: Date.now() });
  }

  yield ctx.on('agent/created', (
    { agent },
  ): undefined => { start(agent); });
  yield ctx.on('agent/disposed', (
    { agent },
  ) => {
    const registration = registrations.get(agent);
    registrations.delete(agent);
    if (registration) void registration.stop().catch((
      error,
    ) => ctx.logger.error(error));
  });

  // 配置重载时，会话可能已经存在；后续新建和恢复由事件处理。
  for (const agent of ctx.agents.list()) start(agent);
}
