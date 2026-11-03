import type { CreateTaskOptions, DescriptionWriteMode, ExpiredGoal, Goal, TaskOwner } from '../../contracts.js';
import type { TaskRepositories } from '../../repository/index.js';
import type { TransactionRunner } from '../../transaction.js';
import { requireFound } from '../require-found.js';
import { requireTaskWriteAccess } from '../require-task-write-access.js';
import { isClaimOwner, recoveredClaim, requiresActiveClaim, withClaimRecovery } from '../claim-recovery.js';

type GoalChange =
  | { action: 'claim' | 'release' | 'block' | 'complete' | 'cancel' }
  | { action: 'update'; description: string; mode?: DescriptionWriteMode };

export class GoalOperations {
  constructor(
    private readonly repository: TaskRepositories,
    private readonly transaction: TransactionRunner,
  ) {}

  list(
    projectId: string,
  ) {
    return this.repository.goals.list(projectId);
  }

  async get(
    goalId: string,
  ) {
    return this.withGoal(goalId, 'get', undefined, (
      _repository,
      goal,
    ) => goal);
  }

  create(
    projectId: string,
    title: string,
    description: string,
    options: CreateTaskOptions,
  ) {
    if (!title.trim()) throw new Error('目标标题不能为空');
    return this.transaction(async (
      repository,
    ) => {
      requireFound(await repository.projects.lockProject(projectId), '项目');
      const goal = await repository.goals.create(projectId, title, description);
      return options.claimImmediately ? this.claim(repository, goal, options.owner) : goal;
    });
  }

  change(
    goalId: string,
    owner: TaskOwner,
    change: GoalChange,
  ) {
    return this.withGoal(goalId, change.action, owner, async (
      repository,
      goal,
    ) => {
      const { goals } = repository;

      switch (change.action) {
        case 'update':
          return goals.updateDescription(goalId, change.description, change.mode);
        case 'claim':
          return this.claim(repository, goal, owner);
        case 'release':
          if (goal.status !== 'in_progress') throw new Error('请先认领目标');
          return this.releaseGoal(repository, goalId);
        case 'cancel':
          if (goal.status === 'done' || goal.status === 'cancelled') {
            throw new Error(`当前状态 ${goal.status} 不允许取消`);
          }
          break;
        default:
          if (goal.status !== 'in_progress') throw new Error('请先认领目标');
      }

      const status = { complete: 'done', cancel: 'cancelled', block: 'blocked' } as const;
      if (change.action === 'complete') await this.requireTasksClosed(repository, goalId);
      await repository.claims.deleteClaim('goal', goalId);
      return goals.setStatus(goalId, status[change.action]);
    });
  }

  async delete(
    goalId: string,
    owner: TaskOwner,
  ): Promise<void | ExpiredGoal> {
    return this.withGoal(goalId, 'delete', owner, async (
      repository,
      goal,
    ) => {
      await repository.claims.deleteClaim('goal', goalId);
      await repository.claims.deleteGoalTaskClaims(goalId);
      await repository.tasks.deleteProjectTemporaryTasks(goal.projectId, goalId);
      await repository.tasks.archiveProjectTasks(goal.projectId, goalId);
      await repository.goals.archive(goalId);
    });
  }

  /** 仅原持有者执行需要有效认领的动作时，告知本次访问发现的到期原因。 */
  private withGoal<T>(
    id: string,
    action: GoalChange['action'] | 'get' | 'delete',
    owner: TaskOwner | undefined,
    run: (
      repository: TaskRepositories,
      goal: Goal,
    ) => T | Promise<T>,
  ): Promise<T | ExpiredGoal> {
    return withClaimRecovery<T | ExpiredGoal>(this.transaction, async (
      repository,
    ) => {
      await repository.goals.lockProjectForGoal(id);
      const goal = requireFound(await repository.goals.get(id), '目标');
      const lease = await repository.claims.lockClaim('goal', id);
      if (lease?.expired) {
        await this.releaseGoal(repository, id);
        if (isClaimOwner(owner, lease) && requiresActiveClaim(action)) {
          return { kind: 'expired', goal, message: '本会话的目标认领已到期，目标恢复待领取，本次操作未执行' };
        }
        return recoveredClaim;
      }

      if (owner) requireTaskWriteAccess(lease, owner, '目标');
      return run(repository, goal);
    });
  }

  private async releaseGoal(
    repository: TaskRepositories,
    id: string,
  ): Promise<Goal> {
    await repository.claims.deleteClaim('goal', id);
    return repository.goals.setStatus(id, 'open');
  }

  async reclaimExpired(): Promise<void> {
    const ids = await this.repository.claims.listExpiredIds('goal');
    for (const id of ids) {
      await this.transaction(async (
        repository,
      ) => {
        const { goals } = repository;
        await goals.lockProjectForGoal(id);
        const lease = await repository.claims.lockClaim('goal', id);
        if (lease?.expired) await this.releaseGoal(repository, id);
      });
    }
  }

  private async claim(
    repository: TaskRepositories,
    goal: Goal,
    owner: TaskOwner,
  ) {
    if (goal.status !== 'open' && goal.status !== 'blocked') {
      throw new Error(`当前状态 ${goal.status} 不允许认领目标`);
    }
    const claimId = await repository.claims.createClaim('goal', goal.id, owner);
    const claimed = await repository.goals.setStatus(goal.id, 'in_progress');
    return { ...claimed, claimId };
  }

  /** 项目锁使检查与目标完成之间的任务归属、状态保持一致。 */
  private async requireTasksClosed(
    repository: TaskRepositories,
    goalId: string,
  ): Promise<void> {
    const tasks = await repository.tasks.listUnfinishedForGoal(goalId);
    if (tasks.length === 0) return;

    const lines = tasks.map((
      task,
    ) => `#${task.id} ${task.title}（${task.status}）`);
    throw new Error(`目标下还有未结束的任务：\n${lines.join('\n')}`);
  }
}
