import type { Database } from '@sagitta/runtime/database';
import type { Project, Task, TaskClaim, TaskOwner } from './contracts.js';
import type { RepositoryResult } from './repository-result.js';

const taskColumns = 't.id, t.project_id AS "projectId", t.kind, t.title, t.description, t.status';
// 正式认领与临时任务寿命均固定为 20 分钟；临时任务不续租。
const claimLeaseMinutes = 20;

/** 接收连接池的查询入口或事务连接，统一承载任务模块的 SQL。 */
export class TaskRepository {
  constructor(
    private readonly database: Pick<Database, 'query'>
  ) {}

  async listTasks(
    projectId: string
  ): Promise<Task[]> {
    const { rows } = await this.database.query<Task>(`
      SELECT ${taskColumns} FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY t.id
    `, [projectId]);

    return rows;
  }

  async getTask(
    taskId: string
  ): Promise<RepositoryResult<Task>> {
    const { rows } = await this.database.query<Task & { archived: boolean }>(`
      SELECT ${taskColumns},
        (t.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS archived
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1
    `, [taskId]);
    const row = rows[0];

    if (!row) return { state: 'missing' };

    // 归档内容在 Repository 边界截断，Service 仅收到状态标记。
    const { archived, ...task } = row;
    if (archived) return { state: 'archived' };

    return { state: 'found', value: task };
  }

  async createTask(
    projectId: string,
    title: string,
    description: string,
    kind: Task['kind'],
  ): Promise<RepositoryResult<Task>> {
    // 锁定项目后判断归档；插入与结果分类使用同一个已锁定的项目版本。
    const { rows } = await this.database.query<Task & { archived: boolean }>(`
      WITH target AS (
        SELECT id, deleted_at FROM projects WHERE id = $1 FOR SHARE
      ), inserted AS (
        INSERT INTO tasks (project_id, kind, title, description, status)
        SELECT id, $4, $2, $3, 'open' FROM target WHERE deleted_at IS NULL
        RETURNING *
      )
      SELECT ${taskColumns}, (target.deleted_at IS NOT NULL) AS archived
      FROM target LEFT JOIN inserted t ON t.project_id = target.id
    `, [projectId, title, description, kind]);
    const row = rows[0];

    if (!row) return { state: 'missing' };

    const { archived, ...task } = row;
    if (archived) return { state: 'archived' };

    return { state: 'found', value: task };
  }

  /** 仅在事务内调用：先锁项目，再锁任务；锁保持到调用方事务结束。 */
  async lockTask(
    taskId: string
  ): Promise<RepositoryResult<Task>> {
    const parent = await this.database.query<{ archived: boolean }>(`
      SELECT (p.deleted_at IS NOT NULL) AS archived
      FROM projects p JOIN tasks t ON t.project_id = p.id
      WHERE t.id = $1 FOR SHARE OF p
    `, [taskId]);

    if (!parent.rows[0]) return { state: 'missing' };
    if (parent.rows[0].archived) return { state: 'archived' };

    const { rows } = await this.database.query<Task & { archived: boolean }>(`
      SELECT ${taskColumns}, (t.deleted_at IS NOT NULL) AS archived
      FROM tasks t WHERE t.id = $1 FOR UPDATE
    `, [taskId]);
    const row = rows[0];

    if (!row) return { state: 'missing' };

    const { archived, ...task } = row;
    if (archived) return { state: 'archived' };

    return { state: 'found', value: task };
  }

  /** 调用方须在同一事务内先通过 lockTask 确认任务可用。 */
  async updateTaskDescription(
    taskId: string,
    description: string
  ): Promise<Task> {
    const { rows } = await this.database.query<Task>(`
      UPDATE tasks t SET description = $2, updated_at = CURRENT_TIMESTAMP
      WHERE t.id = $1 RETURNING ${taskColumns}
    `, [taskId, description]);

    return rows[0];
  }

  /** 在事务内先锁任务，再锁认领；返回身份及数据库判定的过期情况。 */
  async lockClaim(
    taskId: string
  ): Promise<TaskClaim | undefined> {
    const { rows } = await this.database.query<TaskClaim>(`
      SELECT owner_device_id AS "deviceId", owner_session_id AS "sessionId",
        (expires_at <= clock_timestamp()) AS expired
      FROM task_claims WHERE task_id = $1 FOR UPDATE
    `, [taskId]);

    return rows[0];
  }

  /** 先锁定任务再查询；过期但尚未回收的认领也算存在。 */
  async hasClaim(
    taskId: string
  ): Promise<boolean> {
    const { rows } = await this.database.query<{ exists: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM task_claims WHERE task_id = $1) AS exists
    `, [taskId]);

    return rows[0].exists;
  }

  /** 调用方在同一事务内锁定任务并校验状态流转。 */
  async updateTaskStatus(
    taskId: string,
    status: Task['status']
  ): Promise<Task> {
    const { rows } = await this.database.query<Task>(`
      UPDATE tasks t SET status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE t.id = $1 RETURNING ${taskColumns}
    `, [taskId, status]);

    return rows[0];
  }

  /** 与状态修改共用事务连接；唯一约束保证每个任务只有一条认领。 */
  async createClaim(
    taskId: string,
    owner: TaskOwner
  ): Promise<void> {
    await this.database.query(`
      INSERT INTO task_claims (task_id, owner_device_id, owner_session_id, expires_at)
      VALUES ($1, $2, $3, statement_timestamp() + $4::integer * interval '1 minute')
    `, [taskId, owner.deviceId, owner.sessionId, claimLeaseMinutes]);
  }

  async listProjects(): Promise<Project[]> {
    const { rows } = await this.database.query<Project>(`
      SELECT id, name, description FROM projects
      WHERE deleted_at IS NULL
      ORDER BY created_at, id
    `);

    return rows;
  }

  /** 项目删除事务先取得排他行锁，阻止并发创建、认领和修改其任务。 */
  async lockProject(
    projectId: string
  ): Promise<RepositoryResult<Project>> {
    const { rows } = await this.database.query<Project & { archived: boolean }>(`
      SELECT id, name, description, (deleted_at IS NOT NULL) AS archived
      FROM projects WHERE id = $1 FOR UPDATE
    `, [projectId]);
    const row = rows[0];

    if (!row) return { state: 'missing' };

    const { archived, ...project } = row;
    if (archived) return { state: 'archived' };

    return { state: 'found', value: project };
  }

  /** 调用方须在同一事务内锁定任务并完成权限检查。 */
  async archiveTask(
    taskId: string
  ): Promise<void> {
    await this.database.query(`
      UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
    `, [taskId]);
  }

  async deleteClaim(
    taskId: string
  ): Promise<void> {
    await this.database.query('DELETE FROM task_claims WHERE task_id = $1', [taskId]);
  }

  /** 临时任务物理删除；调用方在同一事务内先撤销认领。 */
  async deleteTaskRecord(
    taskId: string
  ): Promise<void> {
    await this.database.query('DELETE FROM tasks WHERE id = $1', [taskId]);
  }

  /** 以下项目批量写入均要求调用方已在同一事务内取得项目排他锁。 */
  async deleteProjectClaims(
    projectId: string
  ): Promise<void> {
    await this.database.query(`
      DELETE FROM task_claims c USING tasks t
      WHERE c.task_id = t.id AND t.project_id = $1
    `, [projectId]);
  }

  async deleteProjectTemporaryTasks(
    projectId: string
  ): Promise<void> {
    await this.database.query("DELETE FROM tasks WHERE project_id = $1 AND kind = 'temp'", [projectId]);
  }

  async archiveProjectTasks(
    projectId: string
  ): Promise<void> {
    await this.database.query(`
      UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = $1 AND kind = 'normal' AND deleted_at IS NULL
    `, [projectId]);
  }

  async archiveProject(
    projectId: string
  ): Promise<void> {
    await this.database.query(`
      UPDATE projects SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
    `, [projectId]);
  }

  async getProject(
    projectId: string
  ): Promise<RepositoryResult<Project>> {
    const { rows } = await this.database.query<Project & { archived: boolean }>(`
      SELECT id, name, description, (deleted_at IS NOT NULL) AS archived
      FROM projects WHERE id = $1
    `, [projectId]);
    const row = rows[0];

    if (!row) return { state: 'missing' };

    const { archived, ...project } = row;
    if (archived) return { state: 'archived' };

    return { state: 'found', value: project };
  }

  async createProject(
    name: string,
    description: string
  ): Promise<Project> {
    const { rows } = await this.database.query<Project>(`
      INSERT INTO projects (name, description) VALUES ($1, $2)
      RETURNING id, name, description
    `, [name, description]);

    return rows[0];
  }

  async updateProject(
    projectId: string,
    description: string
  ): Promise<RepositoryResult<Project>> {
    const { rows } = await this.database.query<Project & { archived: boolean }>(`
      WITH target AS (
        SELECT id, deleted_at FROM projects WHERE id = $1 FOR UPDATE
      ), updated AS (
        UPDATE projects p SET description = $2, updated_at = CURRENT_TIMESTAMP
        FROM target WHERE p.id = target.id AND target.deleted_at IS NULL
        RETURNING p.id, p.name, p.description
      )
      SELECT updated.*, (target.deleted_at IS NOT NULL) AS archived
      FROM target LEFT JOIN updated ON updated.id = target.id
    `, [projectId, description]);
    const row = rows[0];

    if (!row) return { state: 'missing' };

    const { archived, ...project } = row;
    if (archived) return { state: 'archived' };

    return { state: 'found', value: project };
  }
}
