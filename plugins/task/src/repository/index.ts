import type { Database } from '@sagitta/runtime/database';
import { ProjectRepository } from './project.js';
import { TaskRepository } from './task.js';
import { GoalRepository } from './goal.js';
import { ClaimRepository } from './claim.js';

/** 各 Repository 共用传入的查询入口；事务内传入同一条连接。 */
export class TaskRepositories {
  readonly goals: GoalRepository;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly claims: ClaimRepository;

  constructor(
    database: Pick<Database, 'query'>
  ) {
    this.goals = new GoalRepository(database);
    this.projects = new ProjectRepository(database);
    this.tasks = new TaskRepository(database);
    this.claims = new ClaimRepository(database);
  }
}
