import type { DescriptionWriteMode, Project } from '../../contracts.js';
import type { TaskRepositories } from '../../repository/index.js';
import type { TransactionRunner } from '../../transaction.js';
import { requireFound } from '../require-found.js';

/** 工具与其他插件共用的业务入口；数据库访问集中在 Repository。 */
export class ProjectOperations {
  constructor(
    private readonly repository: TaskRepositories,
    private readonly transaction: TransactionRunner,
  ) {}

  listProjects(): Promise<Project[]> {
    return this.repository.projects.listProjects();
  }

  async getProject(
    projectId: string
  ): Promise<Project> {
    const result = await this.repository.projects.getProject(projectId);

    return requireFound(result, '项目');
  }

  async createProject(
    name: string,
    description = ''
  ): Promise<Project> {
    if (name.trim().length === 0) throw new Error('项目名称不能为空');

    return this.repository.projects.createProject(name, description);
  }

  async updateProject(
    projectId: string,
    description: string,
    mode?: DescriptionWriteMode,
  ): Promise<Project> {
    const result = await this.repository.projects.updateProject(projectId, description, mode);

    return requireFound(result, '项目');
  }

  async deleteProject(
    projectId: string
  ): Promise<void> {
    await this.transaction(async (
      repository
    ) => {
      requireFound(await repository.projects.lockProject(projectId), '项目');

      // 项目生命周期操作统一撤销全部认领，包括其他会话持有的认领。
      await repository.claims.deleteProjectClaims(projectId);
      await repository.tasks.deleteProjectTemporaryTasks(projectId);
      await repository.tasks.archiveProjectTasks(projectId);
      await repository.projects.archiveProject(projectId);
    });
  }
}
