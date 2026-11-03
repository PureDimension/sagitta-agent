import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { WorkContext } from '../service/operations/work-context.js';
import { getTaskOwner } from './identity.js';

/** 每次组装读取当前认领；查询结果只写入本次组装，避免跨会话共享缓存。 */
export function* registerTaskWorkContext(
  ctx: Context,
  work: WorkContext,
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

    const projects = await work.listClaimedProjects(getTaskOwner(context));
    section.text = `
# 本会话当前工作
按项目列出本会话认领的任务、目标，以及这些任务所属的目标。目标与任务各有自己的认领凭据。
${JSON.stringify(projects, null, 2)}
`;
    return assembly;
  });
}
