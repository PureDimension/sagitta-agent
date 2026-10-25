import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ProjectOperations } from '../../service/operations/project.js';
import { descriptionModeParameter, descriptionParameter, projectIdParameter } from './parameters.js';
import { jsonOutput, messageSchema, projectSchema } from './results.js';

export function* registerProjectTools(
  ctx: Context,
  projects: ProjectOperations,
) {
  yield ctx.tools.register(defineTool({
    name: 'project_list',
    description: '查看所有可用项目的 ID、名称和说明，作为任务归属的选择依据。',
    parameters: {},
    output: jsonOutput({ type: 'array', items: projectSchema }),
    async execute() {
      return projects.listProjects();
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'project_get',
    description: '查看指定项目的名称和说明。',
    parameters: { projectId: projectIdParameter },
    output: jsonOutput(projectSchema),
    async execute(
      args,
    ) {
      return projects.getProject(args.projectId);
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'project_create',
    description: `
创建用于组织长期工作的项目。
正式任务和临时任务都必须归属某个项目。
`,
    parameters: {
      name: { type: 'string', required: true, description: '项目名称。' },
      description: descriptionParameter,
    },
    output: jsonOutput(projectSchema),
    async execute(
      args,
    ) {
      return projects.createProject(args.name, args.description);
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'project_update',
    description: `
更新项目说明。
mode=replace 整体替换；
mode=append 原子追加新增内容，可直接提交新增备注。
`,
    parameters: {
      projectId: projectIdParameter,
      description: { ...descriptionParameter, required: true },
      mode: descriptionModeParameter,
    },
    output: jsonOutput(projectSchema),
    async execute(
      args,
    ) {
      return projects.updateProject(args.projectId, args.description, args.mode);
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'project_delete',
    description: `
归档项目及其正式任务，清除其临时任务，并撤销全部会话对该项目任务的认领。
归档后不可访问或恢复。
`,
    parameters: { projectId: projectIdParameter },
    output: jsonOutput(messageSchema),
    async execute(
      args,
    ) {
      await projects.deleteProject(args.projectId);
      return { message: '项目及正式任务已归档，临时任务已清除，全部认领已撤销' };
    },
  }));
}
