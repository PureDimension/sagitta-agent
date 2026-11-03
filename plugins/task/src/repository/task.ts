import type { Database } from '@sagitta/runtime/database';
import type { ClaimedTask, DescriptionWriteMode, Project, Task, TaskOwner } from '../contracts.js';
import type { RepositoryResult } from './result.js';

const taskColumns = 't.id, t.goal_id AS "goalId", t.project_id AS "projectId", t.kind, t.title, t.description, t.status';

export class TaskRepository {
  constructor(
    private readonly database: Pick<Database, 'query'>,
  ) {}

  /** 一次查询取得当前可用认领及项目；只读展示，不执行到期清理。 */
  async listContext(
    owner: TaskOwner,
  ): Promise<{ project: Project; task: ClaimedTask }[]> {
    const { rows } = await this.database.query<{ project: Project; task: ClaimedTask }>(`
      SELECT json_build_object('id', p.id, 'name', p.name, 'description', p.description) AS project,
        json_build_object('id', t.id::text, 'projectId', t.project_id, 'goalId', t.goal_id::text, 'kind', t.kind,
          'title', t.title, 'description', t.description, 'status', t.status,
          'claimId', c.claim_id) AS task
      FROM task_claims c JOIN tasks t ON t.id = c.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE c.owner_device_id = $1 AND c.owner_session_id = $2
        AND c.expires_at > CURRENT_TIMESTAMP AND t.status = 'in_progress'
        AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY p.id, t.id
    `, [owner.deviceId, owner.sessionId]);

    return rows;
  }

  async listTasks(
    projectId: string,
    goalId?: string,
  ): Promise<Task[]> {
    const { rows } = await this.database.query<Task>(`
      SELECT ${taskColumns} FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.project_id = $1 AND t.deleted_at IS NULL AND p.deleted_at IS NULL
        AND ($2::bigint IS NULL OR t.goal_id = $2)
      ORDER BY t.id
    `, [projectId, goalId]);

    return rows;
  }

  async listUnfinishedForGoal(
    goalId: string,
  ): Promise<Pick<Task, 'id' | 'title' | 'status'>[]> {
    const { rows } = await this.database.query<Pick<Task, 'id' | 'title' | 'status'>>(`
      SELECT id, title, status FROM tasks
      WHERE goal_id = $1 AND deleted_at IS NULL AND status NOT IN ('done', 'cancelled')
      ORDER BY id
    `, [goalId]);
    return rows;
  }

  async setGoal(
    taskId: string,
    goalId: string | null,
  ): Promise<Task> {
    const { rows } = await this.database.query<Task>(`
      UPDATE tasks t SET goal_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 RETURNING ${taskColumns}
    `, [taskId, goalId]);
    return rows[0];
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

  /** 调用方已锁项目并撤销相应认领；指定目标时只清理其下任务。 */
  async deleteProjectTemporaryTasks(
    projectId: string,
    goalId?: string,
  ): Promise<void> {
    await this.database.query(`
      DELETE FROM tasks WHERE project_id = $1 AND kind = 'temp'
        AND ($2::bigint IS NULL OR goal_id = $2)
    `, [projectId, goalId]);
  }

  /** 调用方须在同一事务内先取得项目排他锁。 */
  async archiveProjectTasks(
    projectId: string,
    goalId?: string,
  ): Promise<void> {
    await this.database.query(`
      UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE project_id = $1 AND kind = 'normal' AND deleted_at IS NULL
        AND ($2::bigint IS NULL OR goal_id = $2)
    `, [projectId, goalId]);
  }
}
