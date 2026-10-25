import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { TaskOperations } from '../service/operations/task.js';
import { getTaskOwner } from './identity.js';

/** 每次组装读取当前认领；查询结果只写入本次组装，避免跨会话共享缓存。 */
export function* registerTaskWorkContext(
  ctx: Context,
  tasks: TaskOperations,
) {
  const name = 'sagitta:current-work';
  yield ctx.systemPrompt.section({
    name,
    order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW') + 1,
    text: '',
    interpolate: false,
  });
  yield ctx.on('system-prompt/assemble', async (
    _assembly,
    context,
    next,
  ) => {
    const assembly = await next();
    const section = assembly.sections.find((
      item,
    ) => item.name === name);
    if (!context.agent || !section) return assembly;

    const projects = await tasks.listClaimedProjects(getTaskOwner(context));
    section.text = `
# 本会话当前工作
以下为当前认领的项目与任务数据。
${JSON.stringify(projects, null, 2)}
`;
    return assembly;
  });
}
