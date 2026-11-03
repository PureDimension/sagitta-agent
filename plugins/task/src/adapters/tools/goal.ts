import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { GoalOperations } from '../../service/operations/goal.js';
import { getTaskOwner } from '../identity.js';
import { descriptionModeParameter, projectIdParameter } from './parameters.js';
import { expiredGoalSchema, goalSchema, jsonOutput, messageSchema } from './results.js';

const goalId = { type: 'string', required: true, description: '目标号，从 goal_list 或 goal_create 取得。' } as const;
const description = { type: 'string', description: '说明想达到的结果，以及怎样判断已经达到。' } as const;
const goalOutput = jsonOutput({ oneOf: [goalSchema, expiredGoalSchema] });

export function* registerGoalTools(
  ctx: Context,
  goals: GoalOperations,
) {
  yield ctx.tools.register(defineTool({
    name: 'goal_list', description: '查看项目下的目标。',
    parameters: { projectId: projectIdParameter },
    output: jsonOutput({ type: 'array', items: goalSchema }),
    execute(
      args,
    ) {
      return goals.list(args.projectId);
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'goal_get', description: '查看目标详情。下属任务可通过 task_list 查看。',
    parameters: { goalId }, output: goalOutput,
    execute(
      args,
    ) {
      return goals.get(args.goalId);
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'goal_create', description: '在项目下建立目标。已经开始负责这个目标时，可以一并认领。',
    parameters: {
      projectId: projectIdParameter, title: { type: 'string', required: true },
      description, claimImmediately: { type: 'boolean' },
    },
    output: jsonOutput(goalSchema),
    execute(
      args,
      exec,
    ) {
      const options = args.claimImmediately ? { claimImmediately: true as const, owner: getTaskOwner(exec) } : {};
      return goals.create(args.projectId, args.title, args.description ?? '', options);
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'goal_update', description: '修改目标说明。已认领的目标由认领会话修改。',
    parameters: { goalId, description: { ...description, required: true }, mode: descriptionModeParameter },
    output: goalOutput,
    execute(
      args,
      exec,
    ) {
      return goals.change(args.goalId, getTaskOwner(exec), { action: 'update', description: args.description, mode: args.mode });
    },
  }));

  yield ctx.tools.register(defineTool({
    name: 'goal_delete', description: `
归档目标及其全部正式任务，清除下属临时任务，同时撤销相关认领，包括其他会话持有的下属任务认领。
目标已被认领时，须由认领会话操作。
`,
    parameters: { goalId }, output: jsonOutput({ oneOf: [messageSchema, expiredGoalSchema] }),
    async execute(
      args,
      exec,
    ) {
      const expired = await goals.delete(args.goalId, getTaskOwner(exec));
      return expired ?? { message: '目标及下属正式任务已归档，临时任务已清除，相关认领已撤销' };
    },
  }));

  const actions = {
    claim: '认领待领取或受阻的目标，由本会话跟进。下属任务各自认领。',
    release: '释放本会话认领的目标，交还为待领取。',
    block: '将本会话认领的目标标记为受阻，并释放认领。',
    complete: '下属任务都已完成或取消后，核对目标的验收条件，再完成本会话认领的目标。',
    cancel: '取消尚未结束的目标，保留下属任务原有状态。',
  } as const;
  for (const action of ['claim', 'release', 'block', 'complete', 'cancel'] as const) {
    yield ctx.tools.register(defineTool({
      name: `goal_${action}`, description: actions[action],
      parameters: { goalId }, output: goalOutput,
      execute(
        args,
        exec,
      ) {
        return goals.change(args.goalId, getTaskOwner(exec), { action });
      },
    }));
  }
}
