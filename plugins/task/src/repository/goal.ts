import type { Database } from '@sagitta/runtime/database';
import type { DescriptionWriteMode, Goal, Project, TaskOwner } from '../contracts.js';
import type { RepositoryResult } from './result.js';

const columns = 'id, project_id AS "projectId", title, description, status';

export class GoalRepository {
  constructor(
    private readonly database: Pick<Database, 'query'>,
  ) {}

  async list(
    projectId: string,
  ): Promise<Goal[]> {
    const { rows } = await this.database.query<Goal>(`
      SELECT ${columns} FROM goals WHERE project_id = $1 AND deleted_at IS NULL ORDER BY id
    `, [projectId]);
    return rows;
  }

  async get(
    id: string,
  ): Promise<RepositoryResult<Goal>> {
    const { rows } = await this.database.query<Goal & { archived: boolean }>(`
      SELECT ${columns}, deleted_at IS NOT NULL AS archived FROM goals WHERE id = $1
    `, [id]);
    if (!rows.length) return { state: 'missing' };
    const { archived, ...goal } = rows[0];
    return archived ? { state: 'archived' } : { state: 'found', value: goal };
  }

  /** 目标变更先锁项目，再读取目标；与任务归属变更及项目归档互斥。 */
  async lockProjectForGoal(
    goalId: string,
  ): Promise<void> {
    await this.database.query(`
      SELECT p.id FROM projects p JOIN goals g ON g.project_id = p.id
      WHERE g.id = $1 FOR UPDATE OF p
    `, [goalId]);
  }

  async create(
    projectId: string,
    title: string,
    description: string,
  ): Promise<Goal> {
    const { rows } = await this.database.query<Goal>(`
      INSERT INTO goals (project_id, title, description) VALUES ($1, $2, $3) RETURNING ${columns}
    `, [projectId, title, description]);
    return rows[0];
  }

  async updateDescription(
    id: string,
    description: string,
    mode: DescriptionWriteMode = 'replace',
  ): Promise<Goal> {
    const { rows } = await this.database.query<Goal>(`
      UPDATE goals SET description = CASE WHEN $3 THEN description || $2 ELSE $2 END
      WHERE id = $1 RETURNING ${columns}
    `, [id, description, mode === 'append']);
    return rows[0];
  }

  async setStatus(
    id: string,
    status: Goal['status'],
  ): Promise<Goal> {
    const { rows } = await this.database.query<Goal>(`
      UPDATE goals SET status = $2 WHERE id = $1 RETURNING ${columns}
    `, [id, status]);
    return rows[0];
  }

  async archive(
    id: string,
  ): Promise<void> {
    await this.database.query('UPDATE goals SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  }

  async archiveProjectGoals(
    projectId: string,
  ): Promise<void> {
    await this.database.query(`
      UPDATE goals SET deleted_at = CURRENT_TIMESTAMP WHERE project_id = $1 AND deleted_at IS NULL
    `, [projectId]);
  }

  async listContext(
    owner: TaskOwner,
    linkedIds: string[],
  ): Promise<{ project: Project; goal: Goal & { claimId?: string } }[]> {
    const { rows } = await this.database.query<{ project: Project; goal: Goal & { claimId?: string } }>(`
      SELECT json_build_object('id', p.id, 'name', p.name, 'description', p.description) AS project,
        json_strip_nulls(json_build_object('id', g.id::text, 'projectId', p.id, 'title', g.title,
          'description', g.description, 'status', g.status, 'claimId', c.claim_id)) AS goal
      FROM goals g JOIN projects p ON p.id = g.project_id
      LEFT JOIN goal_claims c ON c.goal_id = g.id AND c.owner_device_id = $1
        AND c.owner_session_id = $2 AND c.expires_at > CURRENT_TIMESTAMP
      WHERE g.deleted_at IS NULL AND p.deleted_at IS NULL AND (c.goal_id IS NOT NULL OR g.id = ANY($3::bigint[]))
      ORDER BY p.id, g.id
    `, [owner.deviceId, owner.sessionId, linkedIds]);
    return rows;
  }
}
