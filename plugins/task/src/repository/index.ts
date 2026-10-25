import type { Database } from '@sagitta/runtime/database';
import { ProjectRepository } from './project.js';
import { TaskRepository } from './task.js';
import { ClaimRepository } from './claim.js';

/** 三类查询共用传入的查询入口；事务内传入同一条连接。 */
export class TaskRepositories {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly claims: ClaimRepository;

  constructor(
    database: Pick<Database, 'query'>
  ) {
    this.projects = new ProjectRepository(database);
    this.tasks = new TaskRepository(database);
    this.claims = new ClaimRepository(database);
  }
}
