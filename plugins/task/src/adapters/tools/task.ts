import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { TaskOperations } from '../../service/operations/task.js';
import { getTaskOwner } from '../identity.js';
import { descriptionModeParameter, descriptionParameter, projectIdParameter, taskIdParameter } from './parameters.js';
import { formatTaskResult, jsonOutput, taskResultSchema, taskSchema } from './results.js';

export function* registerTaskTools(
  ctx: Context,
  tasks: TaskOperations,
) {
  yield ctx.tools.register(defineTool({
    name: 'task_list',
    description: '查看指定项目的当前任务列表。',
    parameters: { projectId: projectIdParameter },
    output: jsonOutput({ type: 'array', items: taskSchema }),
    async execute(
      args,
    ) {
      return tasks.listTasks(args.projectId);
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_get',
    description: '查看任务详情。',
    parameters: { taskId: taskIdParameter },
    output: jsonOutput(taskResultSchema),
    async execute(
      args,
    ) {
      return formatTaskResult(await tasks.execute({ action: 'get', taskId: args.taskId }), '已取得任务详情');
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_create',
    description: `
在项目下创建任务。
normal 用于长期推进并保留记录的工作，会话存在时有效，会话结束后20分钟内被自动收回；
temp 用于勘查等临时工作，自动由本会话认领，有效期 20 分钟。
立即认领成功时一并返回 claimId；任务管理操作使用返回的 id。
`,
    parameters: {
      projectId: projectIdParameter,
      kind: { type: 'string', enum: ['normal', 'temp'], required: true },
      title: { type: 'string', required: true, description: '简短且明确的任务标题。' },
      description: descriptionParameter,
      claimImmediately: { type: 'boolean', description: `
是否创建后立即认领。
normal：省略为 false。
temp：省略或 true 均立即认领；传入 false 会报错。
` },
    },
    output: jsonOutput(taskSchema),
    async execute(
      args,
      exec,
    ) {
      const content = { projectId: args.projectId, title: args.title, description: args.description };
      if (args.kind === 'temp') {
        if (args.claimImmediately === false) throw new Error('临时任务必须立即认领，claimImmediately 请省略或设为 true');
        return tasks.createTask({ ...content, kind: 'temp', owner: getTaskOwner(exec) });
      }
      if (args.claimImmediately) {
        return tasks.createTask({ ...content, kind: 'normal', claimImmediately: true, owner: getTaskOwner(exec) });
      }

      return tasks.createTask({ ...content, kind: 'normal' });
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_update',
    description: `
更新任务说明。
mode=replace 整体替换；
mode=append 原子追加新增内容。
已有认领时须由认领会话操作。
`,
    parameters: {
      taskId: taskIdParameter,
      description: { ...descriptionParameter, required: true },
      mode: descriptionModeParameter,
    },
    output: jsonOutput(taskResultSchema),
    async execute(
      args,
      exec,
    ) {
      const result = await tasks.execute({ action: 'update', taskId: args.taskId, description: args.description, mode: args.mode, owner: getTaskOwner(exec) });
      return formatTaskResult(result, '任务说明已更新');
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_delete',
    description: `
删除任务：正式任务归档并隐藏，临时任务直接清除。
已有认领时须由认领会话操作。
`,
    parameters: { taskId: taskIdParameter },
    output: jsonOutput(taskResultSchema),
    async execute(
      args,
      exec,
    ) {
      const result = await tasks.execute({ action: 'delete', taskId: args.taskId, owner: getTaskOwner(exec) });
      return formatTaskResult(result, '任务已删除，认领已撤销');
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_claim',
    description: `
认领正式任务：
open（待领取）或 blocked（阻塞中）→ in_progress（进行中），由本设备、本会话负责推进。
任务须无人认领；临时任务创建时已自动认领。
返回任务及本次认领的 claimId，供跨模块资源访问使用。
`,
    parameters: { taskId: taskIdParameter },
    output: jsonOutput(taskResultSchema),
    async execute(
      args,
      exec,
    ) {
      const result = await tasks.execute({ action: 'claim', taskId: args.taskId, owner: getTaskOwner(exec) });
      return formatTaskResult(result, '任务已由本会话认领');
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_release',
    description: `
释放本会话认领的任务。
正式任务：in_progress（进行中）→ open（待领取），交还任务供后续认领；
临时任务：从 in_progress 直接清除任务及认领。
`,
    parameters: { taskId: taskIdParameter },
    output: jsonOutput(taskResultSchema),
    async execute(
      args,
      exec,
    ) {
      const result = await tasks.execute({ action: 'release', taskId: args.taskId, owner: getTaskOwner(exec) });
      return formatTaskResult(result, '认领已释放；正式任务恢复待领取，临时任务已清除');
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_complete',
    description: `
完成本会话认领的任务。
正式任务：in_progress（进行中）→ done（已完成），保留记录并撤销认领；
临时任务：从 in_progress 直接清除任务及认领。
应先核对目标与验收要求并记录结果。
`,
    parameters: { taskId: taskIdParameter },
    output: jsonOutput(taskResultSchema),
    async execute(
      args,
      exec,
    ) {
      const result = await tasks.execute({ action: 'complete', taskId: args.taskId, owner: getTaskOwner(exec) });
      return formatTaskResult(result, '任务已完成并撤销认领；临时任务已清除');
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_block',
    description: `
标记本会话认领的正式任务受阻：
in_progress（进行中）→ blocked（阻塞中），撤销认领。
临时任务不支持此操作。
`,
    parameters: { taskId: taskIdParameter },
    output: jsonOutput(taskResultSchema),
    async execute(
      args,
      exec,
    ) {
      const result = await tasks.execute({ action: 'block', taskId: args.taskId, owner: getTaskOwner(exec) });
      return formatTaskResult(result, '任务已标记阻塞并撤销认领');
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'task_cancel',
    description: `
取消任务。
正式任务：open（待领取）、in_progress（进行中）或 blocked（阻塞中）→ cancelled（已取消），保留记录并撤销已有认领；
临时任务：从 in_progress 直接清除任务及认领。
已有认领时须由认领设备与会话操作。
`,
    parameters: { taskId: taskIdParameter },
    output: jsonOutput(taskResultSchema),
    async execute(
      args,
      exec,
    ) {
      const result = await tasks.execute({ action: 'cancel', taskId: args.taskId, owner: getTaskOwner(exec) });
      return formatTaskResult(result, '任务已取消并撤销认领；临时任务已清除');
    },
  }));
}
