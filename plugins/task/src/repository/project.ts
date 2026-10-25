import type { Database } from '@sagitta/runtime/database';
import type { DescriptionWriteMode, Project } from '../contracts.js';
import type { RepositoryResult } from './result.js';

export class ProjectRepository {
  constructor(
    private readonly database: Pick<Database, 'query'>
  ) {}

  async listProjects(): Promise<Project[]> {
    const { rows } = await this.database.query<Project>(`
      SELECT id, name, description FROM projects
      WHERE deleted_at IS NULL
      ORDER BY created_at, id
    `);

    return rows;
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
    description: string,
    mode: DescriptionWriteMode = 'replace',
  ): Promise<RepositoryResult<Project>> {
    const { rows } = await this.database.query<Project & { archived: boolean }>(`
      WITH target AS (
        SELECT id, deleted_at FROM projects WHERE id = $1 FOR UPDATE
      ), updated AS (
        UPDATE projects p
        SET description = CASE WHEN $3 THEN p.description || $2 ELSE $2 END,
            updated_at = CURRENT_TIMESTAMP
        FROM target WHERE p.id = target.id AND target.deleted_at IS NULL
        RETURNING p.id, p.name, p.description
      )
      SELECT updated.*, (target.deleted_at IS NOT NULL) AS archived
      FROM target LEFT JOIN updated ON updated.id = target.id
    `, [projectId, description, mode === 'append']);
    const row = rows[0];

    if (!row) return { state: 'missing' };

    const { archived, ...project } = row;
    if (archived) return { state: 'archived' };

    return { state: 'found', value: project };
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

  /** 调用方须在同一事务内先取得项目排他锁。 */
  async archiveProject(
    projectId: string
  ): Promise<void> {
    await this.database.query(`
      UPDATE projects SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND deleted_at IS NULL
    `, [projectId]);
  }
}
