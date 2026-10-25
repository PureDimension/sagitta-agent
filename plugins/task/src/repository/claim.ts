import type { Database } from '@sagitta/runtime/database';
import type { ClaimedTask, Project, TaskClaim, TaskOwner } from '../contracts.js';

// 正式认领与临时任务寿命均固定为 20 分钟；临时任务不续租。
const claimLeaseMinutes = 20;

export class ClaimRepository {
  constructor(
    private readonly database: Pick<Database, 'query'>
  ) {}

  /** 在事务内先锁任务，再锁认领；取得认领行锁后按数据库时间判断到期。 */
  async lockClaim(
    taskId: string
  ): Promise<TaskClaim | undefined> {
    const { rows } = await this.database.query<TaskClaim>(`
      WITH target AS MATERIALIZED (
        SELECT owner_device_id, owner_session_id, expires_at
        FROM task_claims WHERE task_id = $1 FOR UPDATE
      )
      SELECT owner_device_id AS "deviceId", owner_session_id AS "sessionId",
        (expires_at <= clock_timestamp()) AS expired
      FROM target
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

  /** 与状态修改共用事务连接；唯一约束保证每个任务只有一条认领。 */
  async createClaim(
    taskId: string,
    owner: TaskOwner
  ): Promise<string> {
    const { rows } = await this.database.query<{ claimId: string }>(`
      INSERT INTO task_claims (task_id, owner_device_id, owner_session_id, expires_at)
      VALUES ($1, $2, $3, statement_timestamp() + $4::integer * interval '1 minute')
      RETURNING claim_id AS "claimId"
    `, [taskId, owner.deviceId, owner.sessionId, claimLeaseMinutes]);

    return rows[0].claimId;
  }

  /** 一次查询取得当前可用认领及项目；只读展示，不执行到期清理。 */
  async listClaimedTasks(
    owner: TaskOwner,
  ): Promise<{ project: Project; task: ClaimedTask }[]> {
    const { rows } = await this.database.query<{ project: Project; task: ClaimedTask }>(`
      SELECT json_build_object('id', p.id, 'name', p.name, 'description', p.description) AS project,
        json_build_object('id', t.id::text, 'projectId', t.project_id, 'kind', t.kind,
          'title', t.title, 'description', t.description, 'status', t.status,
          'claimId', c.claim_id) AS task
      FROM task_claims c JOIN tasks t ON t.id = c.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE c.owner_device_id = $1 AND c.owner_session_id = $2
        AND c.expires_at > statement_timestamp() AND t.status = 'in_progress'
        AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY p.id, t.id
    `, [owner.deviceId, owner.sessionId]);

    return rows;
  }

  /** 全库扫描仅用于周期回收；候选可能变化，调用方须锁定任务和认领后复查。 */
  async listExpiredTaskIds(): Promise<string[]> {
    const { rows } = await this.database.query<{ id: string }>(`
      SELECT t.id FROM task_claims c
      JOIN tasks t ON t.id = c.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE c.expires_at <= clock_timestamp()
        AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY t.id
    `);

    return rows.map((
      row
    ) => row.id);
  }

  /** 单条语句完成批量续租；锁定候选认领后再次检查有效期。 */
  async renewClaims(
    deviceId: string,
    sessionIds: readonly string[]
  ): Promise<number> {
    const { rows } = await this.database.query<{ task_id: string }>(`
      WITH candidates AS MATERIALIZED (
        SELECT c.task_id, c.claim_id FROM task_claims c
        JOIN tasks t ON t.id = c.task_id
        JOIN projects p ON p.id = t.project_id
        WHERE c.owner_device_id = $1 AND c.owner_session_id = ANY($2::text[])
          AND t.kind = 'normal' AND t.status = 'in_progress'
          AND t.deleted_at IS NULL AND p.deleted_at IS NULL
          AND c.expires_at > clock_timestamp()
        ORDER BY c.task_id FOR UPDATE OF c
      )
      UPDATE task_claims c
      SET expires_at = clock_timestamp() + $3::integer * interval '1 minute'
      FROM candidates
      WHERE c.task_id = candidates.task_id AND c.claim_id = candidates.claim_id
        AND c.expires_at > clock_timestamp()
      RETURNING c.task_id
    `, [deviceId, sessionIds, claimLeaseMinutes]);

    return rows.length;
  }

  async deleteClaim(
    taskId: string
  ): Promise<void> {
    await this.database.query('DELETE FROM task_claims WHERE task_id = $1', [taskId]);
  }

  /** 调用方须在同一事务内先取得项目排他锁。 */
  async deleteProjectClaims(
    projectId: string
  ): Promise<void> {
    await this.database.query(`
      DELETE FROM task_claims c USING tasks t
      WHERE c.task_id = t.id AND t.project_id = $1
    `, [projectId]);
  }
}
