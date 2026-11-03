import type { ClaimedTask, CreateTaskInput, Task, TaskClaim, TaskOperation, TaskOperationResult, TaskOwner } from '../../contracts.js';
import type { TaskRepositories } from '../../repository/index.js';
import type { TransactionRunner } from '../../transaction.js';
import { reclaimExpiredTask } from '../reclaim-expired-task.js';
import { isClaimOwner, recoveredClaim, requiresActiveClaim, withClaimRecovery } from '../claim-recovery.js';
import { requireFound } from '../require-found.js';
import { requireTaskWriteAccess } from '../require-task-write-access.js';

interface TaskContext {
  repository: TaskRepositories;
  task: Task;
  claim: TaskClaim | undefined;
}

/** 单任务操作统一经 execute；动作处理函数仅在当前事务内使用。 */
export class TaskOperations {
  constructor(
    private readonly repository: TaskRepositories,
    private readonly transaction: TransactionRunner,
  ) {}

  listTasks(
    projectId: string,
    goalId?: string,
  ): Promise<Task[]> {
    return this.repository.tasks.listTasks(projectId, goalId);
  }

  execute(
    input: TaskOperation,
  ): Promise<TaskOperationResult> {
    return withClaimRecovery<TaskOperationResult>(this.transaction, async (
      repository
    ) => {
      const task = requireFound(await repository.tasks.lockTask(input.taskId), '任务');
      const claim = await repository.claims.lockClaim('task', task.id);
      const expired = await reclaimExpiredTask(repository, task, claim);
      if (expired) {
        if (task.kind === 'temp' && input.action === 'delete') return { kind: 'success', value: undefined };
        if (isClaimOwner(input.owner, expired.owner) && (task.kind === 'temp' || requiresActiveClaim(input.action))) {
          return { ...expired, message: `${expired.message}，本次操作未执行` };
        }
        return recoveredClaim;
      }

      const value = await this.dispatch(input, { repository, task, claim });
      return { kind: 'success', value };
    });
  }

  async createTask(
    input: CreateTaskInput,
  ): Promise<Task | ClaimedTask> {
    if (input.title.trim().length === 0) throw new Error('任务标题不能为空');

    return this.transaction(async (
      repository
    ) => {
      const result = await repository.tasks.createTask(input.projectId, input.title, input.description ?? '', input.kind);
      let task = requireFound(result, '项目');
      if (input.goalId !== undefined) task = await this.setGoal(repository, task, input.goalId);

      if (input.kind === 'temp' || input.claimImmediately) {
        return this.claimTask({ repository, task, claim: undefined }, input.owner);
      }

      return task;
    });
  }

  private async dispatch(
    input: TaskOperation,
    context: TaskContext,
  ): Promise<Task | ClaimedTask | void> {
    if (input.action === 'get') return context.task;
    if (input.action === 'claim') return this.claimTask(context, input.owner);

    // 写入权限与需要有效认领的动作在分发处统一检查。
    requireTaskWriteAccess(context.claim, input.owner);
    if (requiresActiveClaim(input.action) && !context.claim) {
      throw new Error('任务尚未认领');
    }

    switch (input.action) {
      case 'update': return this.updateTask(context, input);
      case 'delete': return this.deleteTask(context);
      case 'release': return this.releaseTask(context);
      case 'complete': return this.completeTask(context);
      case 'block': return this.blockTask(context);
      case 'cancel': return this.cancelTask(context);
    }
  }

  private async updateTask(
    { repository, task }: TaskContext,
    input: Extract<TaskOperation, { action: 'update' }>,
  ): Promise<Task> {
    if (input.goalId === undefined && input.description === undefined) {
      throw new Error('请提供任务说明或目标');
    }
    if (input.goalId !== undefined) task = await this.setGoal(repository, task, input.goalId);
    if (input.description === undefined) return task;
    return repository.tasks.updateTaskDescription(task.id, input.description, input.mode);
  }

  private async setGoal(
    repository: TaskRepositories,
    task: Task,
    goalId: string | null,
  ): Promise<Task> {
    if (goalId !== null) {
      const goal = requireFound(await repository.goals.get(goalId), '目标');
      if (goal.projectId !== task.projectId) throw new Error('任务与目标须属于同一个项目');
      if (goal.id !== task.goalId && (goal.status === 'done' || goal.status === 'cancelled')) {
        throw new Error('目标已结束，无法挂入任务');
      }
    }
    return repository.tasks.setGoal(task.id, goalId);
  }

  private async deleteTask(
    { repository, task }: TaskContext,
  ): Promise<void> {
    await repository.claims.deleteClaim('task', task.id);
    if (task.kind === 'temp') await repository.tasks.deleteTaskRecord(task.id);
    else await repository.tasks.archiveTask(task.id);
  }

  private async releaseTask(
    { repository, task }: TaskContext,
  ): Promise<void> {
    if (task.status !== 'in_progress') throw new Error(`当前状态 ${task.status} 不允许释放`);

    await repository.claims.deleteClaim('task', task.id);
    if (task.kind === 'temp') await repository.tasks.deleteTaskRecord(task.id);
    else await repository.tasks.updateTaskStatus(task.id, 'open');
  }

  private async completeTask(
    { repository, task }: TaskContext,
  ): Promise<void> {
    if (task.status !== 'in_progress') throw new Error(`当前状态 ${task.status} 不允许完成`);

    await repository.claims.deleteClaim('task', task.id);
    if (task.kind === 'temp') await repository.tasks.deleteTaskRecord(task.id);
    else await repository.tasks.updateTaskStatus(task.id, 'done');
  }

  private async blockTask(
    { repository, task }: TaskContext,
  ): Promise<void> {
    if (task.kind === 'temp') throw new Error('临时任务不允许阻塞');
    if (task.status !== 'in_progress') throw new Error(`当前状态 ${task.status} 不允许阻塞`);

    await repository.claims.deleteClaim('task', task.id);
    await repository.tasks.updateTaskStatus(task.id, 'blocked');
  }

  private async cancelTask(
    { repository, task }: TaskContext,
  ): Promise<void> {
    const canCancel = task.status === 'in_progress'
      || (task.kind === 'normal' && (task.status === 'open' || task.status === 'blocked'));
    if (!canCancel) throw new Error(`当前状态 ${task.status} 不允许取消`);

    await repository.claims.deleteClaim('task', task.id);
    if (task.kind === 'temp') await repository.tasks.deleteTaskRecord(task.id);
    else await repository.tasks.updateTaskStatus(task.id, 'cancelled');
  }

  /** 创建后认领与独立认领共用业务；事务和已有认领由调用方提供。 */
  private async claimTask(
    { repository, task, claim }: TaskContext,
    owner: TaskOwner,
  ): Promise<ClaimedTask> {
    if (claim) throw new Error('任务已有认领，请先释放或等待回收');
    const canClaim = task.status === 'open' || (task.kind === 'normal' && task.status === 'blocked');
    if (!canClaim) throw new Error(`当前状态 ${task.status} 不允许认领`);

    const claimId = await repository.claims.createClaim('task', task.id, owner);
    const claimed = await repository.tasks.updateTaskStatus(task.id, 'in_progress');
    return { ...claimed, claimId };
  }
}
