import type { Database } from '@sagitta/runtime/database';
import type { DescriptionWriteMode, Task } from '../contracts.js';
import type { RepositoryResult } from './result.js';

const taskColumns = 't.id, t.project_id AS "projectId", t.kind, t.title, t.description, t.status';

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
    description: string,
    mode: DescriptionWriteMode = 'replace',
  ): Promise<Task> {
    const { rows } = await this.database.query<Task>(`
      UPDATE tasks t
      SET description = CASE WHEN $3 THEN t.description || $2 ELSE $2 END,
          updated_at = CURRENT_TIMESTAMP
      WHERE t.id = $1 RETURNING ${taskColumns}
    `, [taskId, description, mode === 'append']);

    return rows[0];
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

  /** 调用方须在同一事务内锁定任务并完成权限检查。 */
  async archiveTask(
    taskId: string
  ): Promise<void> {
    await this.database.query(`
      UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
    `, [taskId]);
  }

  /** 临时任务物理删除；调用方在同一事务内先撤销认领。 */
  async deleteTaskRecord(
    taskId: string
  ): Promise<void> {
    await this.database.query('DELETE FROM tasks WHERE id = $1', [taskId]);
  }

  /** 调用方须在同一事务内先取得项目排他锁，并撤销项目下的认领。 */
  async deleteProjectTemporaryTasks(
    projectId: string
  ): Promise<void> {
    await this.database.query("DELETE FROM tasks WHERE project_id = $1 AND kind = 'temp'", [projectId]);
  }

  /** 调用方须在同一事务内先取得项目排他锁。 */
  async archiveProjectTasks(
    projectId: string
  ): Promise<void> {
    await this.database.query(`
      UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = $1 AND kind = 'normal' AND deleted_at IS NULL
    `, [projectId]);
  }
}
