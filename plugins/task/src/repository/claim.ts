import type { Database } from '@sagitta/runtime/database';
import type { TaskClaim, TaskOwner } from '../contracts.js';

const claimLeaseMinutes = 20;

// SQL 标识符只取自这两套固定的表结构。目标号与任务号可以相同。
const tables = {
  task: { claims: 'task_claims', items: 'tasks', key: 'task_id' },
  goal: { claims: 'goal_claims', items: 'goals', key: 'goal_id' },
} as const;
type ClaimKind = keyof typeof tables;

export class ClaimRepository {
  constructor(
    private readonly database: Pick<Database, 'query'>,
  ) {}

  /** 周期回收只取候选 ID；锁定任务或目标后还需复查有效期。 */
  async listExpiredIds(
    kind: ClaimKind,
  ): Promise<string[]> {
    const sql = kind === 'goal'
      ? 'SELECT goal_id AS id FROM goal_claims WHERE expires_at <= clock_timestamp() ORDER BY goal_id'
      : `SELECT t.id FROM task_claims c
         JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
         WHERE c.expires_at <= clock_timestamp() AND t.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY t.id`;
    const { rows } = await this.database.query<{ id: string }>(sql);
    return rows.map((
      row,
    ) => row.id);
  }

  /** 在事务内先锁任务或目标，再锁认领；取得认领行锁后按数据库时间判断到期。 */
  async lockClaim(
    kind: ClaimKind,
    id: string
  ): Promise<TaskClaim | undefined> {
    const { claims, key } = tables[kind];
    const { rows } = await this.database.query<TaskClaim>(`
      WITH target AS MATERIALIZED (
        SELECT owner_device_id, owner_session_id, expires_at
        FROM ${claims} WHERE ${key} = $1 FOR UPDATE
      )
      SELECT owner_device_id AS "deviceId", owner_session_id AS "sessionId",
        (expires_at <= clock_timestamp()) AS expired
      FROM target
    `, [id]);

    return rows[0];
  }

  /** 与状态修改共用事务连接；唯一约束保证每个任务只有一条认领。 */
  async createClaim(
    kind: ClaimKind,
    id: string,
    owner: TaskOwner
  ): Promise<string> {
    const { claims, key } = tables[kind];
    const { rows } = await this.database.query<{ claimId: string }>(`
      INSERT INTO ${claims} (${key}, owner_device_id, owner_session_id, expires_at)
      VALUES ($1, $2, $3, statement_timestamp() + $4::integer * interval '1 minute')
      RETURNING claim_id AS "claimId"
    `, [id, owner.deviceId, owner.sessionId, claimLeaseMinutes]);

    return rows[0].claimId;
  }

  async renewClaims(
    deviceId: string,
    sessionIds: readonly string[]
  ): Promise<number> {
    let renewed = 0;
    for (const kind of ['task', 'goal'] as const) {
      const { claims, items, key } = tables[kind];
      const renewalFilter = kind === 'task' ? "AND t.kind = 'normal'" : '';
      const { rows } = await this.database.query(`
        WITH candidates AS MATERIALIZED (
          SELECT c.${key}, c.claim_id FROM ${claims} c
          JOIN ${items} t ON t.id = c.${key}
          JOIN projects p ON p.id = t.project_id
          WHERE c.owner_device_id = $1 AND c.owner_session_id = ANY($2::text[])
            ${renewalFilter} AND t.status = 'in_progress'
            AND t.deleted_at IS NULL AND p.deleted_at IS NULL
            AND c.expires_at > clock_timestamp()
          ORDER BY c.${key} FOR UPDATE OF c
        )
        UPDATE ${claims} c
        SET expires_at = clock_timestamp() + $3::integer * interval '1 minute'
        FROM candidates
        WHERE c.${key} = candidates.${key} AND c.claim_id = candidates.claim_id
          AND c.expires_at > clock_timestamp()
        RETURNING c.${key}
      `, [deviceId, sessionIds, claimLeaseMinutes]);
      renewed += rows.length;
    }
    return renewed;
  }

  async deleteClaim(
    kind: ClaimKind,
    id: string
  ): Promise<void> {
    const { claims, key } = tables[kind];
    await this.database.query(`DELETE FROM ${claims} WHERE ${key} = $1`, [id]);
  }

  /** 调用方须在同一事务内先取得项目排他锁。 */
  async deleteGoalTaskClaims(
    goalId: string,
  ): Promise<void> {
    await this.database.query(`
      WITH locked AS MATERIALIZED (
        SELECT c.task_id FROM task_claims c JOIN tasks t ON t.id = c.task_id
        WHERE t.goal_id = $1 ORDER BY c.task_id FOR UPDATE OF c
      )
      DELETE FROM task_claims c USING locked WHERE c.task_id = locked.task_id
    `, [goalId]);
  }

  /** 调用方须在同一事务内先取得项目排他锁。 */
  async deleteProjectClaims(
    projectId: string
  ): Promise<void> {
    for (const { claims, items, key } of Object.values(tables)) {
      await this.database.query(`
        WITH locked AS MATERIALIZED (
          SELECT c.${key} FROM ${claims} c JOIN ${items} t ON t.id = c.${key}
          WHERE t.project_id = $1 ORDER BY c.${key} FOR UPDATE OF c
        )
        DELETE FROM ${claims} c USING locked WHERE c.${key} = locked.${key}
      `, [projectId]);
    }
  }
}
