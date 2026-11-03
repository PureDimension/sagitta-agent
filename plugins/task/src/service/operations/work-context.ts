import type { ClaimedProject, Project, TaskOwner } from '../../contracts.js';
import type { TransactionRunner } from '../../transaction.js';

/** 按项目整理本会话正在跟进的工作；同一目标可被多项任务引用。 */
export class WorkContext {
  constructor(
    private readonly readSnapshot: TransactionRunner,
  ) {}

  async listClaimedProjects(
    owner: TaskOwner,
  ): Promise<ClaimedProject[]> {
    const { rows, goals } = await this.readSnapshot(async (
      repository,
    ) => {
      const rows = await repository.tasks.listContext(owner);
      const goalIds = new Set<string>();
      for (const { task } of rows) {
        if (task.goalId !== null) goalIds.add(task.goalId);
      }
      const goals = await repository.goals.listContext(owner, [...goalIds]);
      return { rows, goals };
    });
    const projects = new Map<string, ClaimedProject>();

    function groupFor(
      project: Project,
    ) {
      let group = projects.get(project.id);
      if (!group) {
        group = { ...project, tasks: [], goals: [] };
        projects.set(project.id, group);
      }
      return group;
    }

    for (const { project, task } of rows) {
      groupFor(project).tasks.push(task);
    }
    for (const { project, goal } of goals) {
      groupFor(project).goals.push(goal);
    }

    return [...projects.values()];
  }
}
