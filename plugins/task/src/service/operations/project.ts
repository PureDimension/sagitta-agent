import type { Project } from '../../contracts.js';
import type { TaskRepository } from '../../repository.js';
import type { TransactionRunner } from '../../transaction.js';
import { requireFound } from '../require-found.js';

/** 工具与其他插件共用的业务入口；数据库访问集中在 Repository。 */
export class ProjectOperations {
  constructor(
    private readonly repository: TaskRepository,
    private readonly transaction: TransactionRunner,
  ) {}

  listProjects(): Promise<Project[]> {
    return this.repository.listProjects();
  }

  async getProject(
    projectId: string
  ): Promise<Project> {
    const result = await this.repository.getProject(projectId);

    return requireFound(result, '项目');
  }

  async createProject(
    name: string,
    description = ''
  ): Promise<Project> {
    if (name.trim().length === 0) throw new Error('项目名称不能为空');

    return this.repository.createProject(name, description);
  }

  async updateProject(
    projectId: string,
    description: string
  ): Promise<Project> {
    const result = await this.repository.updateProject(projectId, description);

    return requireFound(result, '项目');
  }

  async deleteProject(
    projectId: string
  ): Promise<void> {
    await this.transaction(async (
      repository
    ) => {
      requireFound(await repository.lockProject(projectId), '项目');

      // 项目生命周期操作统一撤销全部认领，包括其他会话持有的认领。
      await repository.deleteProjectClaims(projectId);
      await repository.deleteProjectTemporaryTasks(projectId);
      await repository.archiveProjectTasks(projectId);
      await repository.archiveProject(projectId);
    });
  }
}
