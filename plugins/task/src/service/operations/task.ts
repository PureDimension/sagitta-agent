import type { CreateTaskInput, Task, TaskOwner } from '../../contracts.js';
import type { TaskRepository } from '../../repository.js';
import { reuseTransactionRunner, type TransactionRunner } from '../../transaction.js';
import { requireFound } from '../require-found.js';
import { requireTaskWriteAccess } from '../require-task-write-access.js';
import { withClaimedTask } from '../with-claimed-task.js';

/** 查询使用注入的 Repository；写入操作通过事务执行器共享连接。 */
export class TaskOperations {
  constructor(
    private readonly repository: TaskRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  listTasks(
    projectId: string
  ): Promise<Task[]> {
    return this.repository.listTasks(projectId);
  }

  async getTask(
    taskId: string
  ): Promise<Task> {
    const result = await this.repository.getTask(taskId);

    return requireFound(result, '任务');
  }

  async updateTask(
    taskId: string,
    description: string,
    owner: TaskOwner
  ): Promise<Task> {
    return this.transaction(async (
      repository
    ) => {
      const result = await repository.lockTask(taskId);
      const task = requireFound(result, '任务');
      const claim = await repository.lockClaim(task.id);
      requireTaskWriteAccess(claim, owner);

      return repository.updateTaskDescription(task.id, description);
    });
  }

  async deleteTask(
    taskId: string,
    owner: TaskOwner
  ): Promise<void> {
    await this.transaction(async (
      repository
    ) => {
      const task = requireFound(await repository.lockTask(taskId), '任务');
      const claim = await repository.lockClaim(task.id);
      requireTaskWriteAccess(claim, owner);

      await repository.deleteClaim(task.id);
      if (task.kind === 'temp') {
        await repository.deleteTaskRecord(task.id);
      } else {
        await repository.archiveTask(task.id);
      }
    });
  }

  async createTask(
    input: CreateTaskInput,
  ): Promise<Task> {
    if (input.title.trim().length === 0) throw new Error('任务标题不能为空');

    return this.transaction(async (
      repository
    ) => {
      const result = await repository.createTask(input.projectId, input.title, input.description ?? '', input.kind);
      const task = requireFound(result, '项目');

      if (input.kind === 'temp' || input.claimImmediately) {
        return this.claimTask(task.id, input.owner, reuseTransactionRunner(repository));
      }

      return task;
    });
  }

  releaseTask(
    taskId: string,
    owner: TaskOwner
  ): Promise<void> {
    return withClaimedTask(this.transaction, taskId, owner, async (
      repository,
      task
    ) => {
      if (task.status !== 'in_progress') throw new Error(`当前状态 ${task.status} 不允许释放`);

      await repository.deleteClaim(task.id);
      if (task.kind === 'temp') await repository.deleteTaskRecord(task.id);
      else await repository.updateTaskStatus(task.id, 'open');
    });
  }

  completeTask(
    taskId: string,
    owner: TaskOwner
  ): Promise<void> {
    return withClaimedTask(this.transaction, taskId, owner, async (
      repository,
      task
    ) => {
      if (task.status !== 'in_progress') throw new Error(`当前状态 ${task.status} 不允许完成`);

      await repository.deleteClaim(task.id);
      if (task.kind === 'temp') await repository.deleteTaskRecord(task.id);
      else await repository.updateTaskStatus(task.id, 'done');
    });
  }

  blockTask(
    taskId: string,
    owner: TaskOwner
  ): Promise<void> {
    return withClaimedTask(this.transaction, taskId, owner, async (
      repository,
      task
    ) => {
      if (task.kind === 'temp') throw new Error('临时任务不允许阻塞');
      if (task.status !== 'in_progress') throw new Error(`当前状态 ${task.status} 不允许阻塞`);

      await repository.deleteClaim(task.id);
      await repository.updateTaskStatus(task.id, 'blocked');
    });
  }

  async cancelTask(
    taskId: string,
    owner: TaskOwner
  ): Promise<void> {
    await this.transaction(async (
      repository
    ) => {
      const task = requireFound(await repository.lockTask(taskId), '任务');
      const claim = await repository.lockClaim(task.id);
      requireTaskWriteAccess(claim, owner);
      const canCancel = task.status === 'in_progress'
        || (task.kind === 'normal' && (task.status === 'open' || task.status === 'blocked'));
      if (!canCancel) throw new Error(`当前状态 ${task.status} 不允许取消`);

      await repository.deleteClaim(task.id);
      if (task.kind === 'temp') await repository.deleteTaskRecord(task.id);
      else await repository.updateTaskStatus(task.id, 'cancelled');
    });
  }

  /** 独立调用开启事务；创建后认领时由调用方显式传入已有事务。 */
  async claimTask(
    taskId: string,
    owner: TaskOwner,
    transaction: TransactionRunner = this.transaction,
  ): Promise<Task> {
    return transaction(async (
      repository
    ) => {
      const task = requireFound(await repository.lockTask(taskId), '任务');
      if (await repository.hasClaim(task.id)) {
        throw new Error('任务已有认领，请先释放或等待回收');
      }
      const canClaim = task.status === 'open' || (task.kind === 'normal' && task.status === 'blocked');
      if (!canClaim) {
        throw new Error(`当前状态 ${task.status} 不允许认领`);
      }

      await repository.createClaim(task.id, owner);
      return repository.updateTaskStatus(task.id, 'in_progress');
    });
  }
}
