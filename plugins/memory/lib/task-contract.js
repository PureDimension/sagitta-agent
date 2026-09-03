// sagitta-memory — task API v2 的纯契约辅助（不依赖 DSH runtime）。

import { MemoryApiError } from "./client.js";

export function taskContractError(code, message) {
  return new MemoryApiError(422, code, message);
}

export function validateRoundText(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw taskContractError(`${field.toUpperCase()}_REQUIRED`, `${field} 必填`);
  }
  const trimmed = value.trim();
  if (Array.from(trimmed).length > 1000) {
    throw taskContractError(`${field.toUpperCase()}_TOO_LONG`, `${field} 最多 1000 个 Unicode 字符`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw taskContractError(`INVALID_${field.toUpperCase()}`, `${field} 不得包含控制字符或换行`);
  }
  return trimmed;
}

export function validateTaskUpdate(args = {}) {
  if (args.status === "blocked" && (typeof args.blocked_reason !== "string" || args.blocked_reason.trim().length === 0)) {
    throw taskContractError("TASK_BLOCKED_REASON_REQUIRED", "申请 blocked 必须提供非空 blocked_reason");
  }
  if (args.status === "done" && typeof args.blocked_reason === "string" && args.blocked_reason.trim().length > 0) {
    throw taskContractError("INVALID_BLOCKED_REASON", "done 申请不得设置 blocked_reason");
  }
}

// task-ownership-p2 §3/§4.1：认领租约秒数（与 Worker TASK_MAX_LEASE_SECONDS 对齐）
export const TASK_LEASE_MAX = 604800;

/**
 * 校验认领租约秒数（task_claim 的 lease_seconds）。
 * 未传/传 null → 返回 null（服务端存 NULL = 全局默认 24h）。
 * 非法 → 抛 422 INVALID_LEASE_SECONDS（错误码与服务端一致）。
 * @returns {number|null}
 */
export function validateClaimLease(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > TASK_LEASE_MAX) {
    throw taskContractError(
      "INVALID_LEASE_SECONDS",
      `lease_seconds 必须是 1~${TASK_LEASE_MAX} 之间的整数秒（缺省=全局默认 24h）`
    );
  }
  return value;
}

/**
 * 投影 task_need_human 响应，兼容 Worker 的 id/nh_id 及旧响应别名。
 * type 缺省按旧数据语义归一为 need；notify 原样保留。
 */
export function pickNeedHuman(raw) {
  const src = raw?.need_human ?? raw?.needHuman ?? raw?.item ?? raw ?? {};
  const resolved = src.status === "resolved" || src.resolved === true || src.resolved_at;
  return {
    nh_id: String(src.nh_id ?? src.need_human_id ?? src.id ?? ""),
    task_id: String(src.task_id ?? src.taskId ?? ""),
    type: src.type === "notify" ? "notify" : "need",
    content: String(src.content ?? ""),
    suggestion: src.suggestion === undefined || src.suggestion === null ? null : String(src.suggestion),
    status: resolved ? "resolved" : "open",
    resolve_kind: src.resolve_kind === undefined || src.resolve_kind === null ? null : String(src.resolve_kind),
    created_at: String(src.created_at ?? src.created ?? ""),
    resolved_at: src.resolved_at === undefined || src.resolved_at === null ? null : String(src.resolved_at),
    updated_at: src.updated_at === undefined || src.updated_at === null ? null : String(src.updated_at),
  };
}

export function pickTask(task) {
  if (!task) return null;
  const result = {
    id: String(task.id ?? task.task_id ?? ""),
    project: String(task.project ?? ""),
    // P2 task-system-v2：normal 是兼容旧 Worker/旧数据的默认值；Worker
    // 新版本会显式返回 normal|temp。
    kind: task.kind === "temp" ? "temp" : "normal",
    title: String(task.title ?? ""),
    status: String(task.status ?? ""),
    priority: Number(task.priority ?? 0),
    checkbox: Number(task.checkbox ?? 0),
    stream: String(task.stream ?? ""),
    body: typeof task.body === "string" ? task.body : "",
    created_at: String(task.created_at ?? ""),
    updated_at: task.updated_at ?? null,
    done_at: task.done_at ?? null,
    blocked_reason: task.blocked_reason ?? null,
    pending_status: task.pending_status ?? null,
    archived: Number(task.archived ?? 0),
  };
  // task-ownership-p2 §6：claim_state 派生（unclaimed | claimed）投影进列表/详情；
  // "mine" 由调用方按已持有 claim_token 本地判断（Worker 不下发 mine）。
  // owner_agent_id / claim_token 永不投影（owner 对模型无感知；token 只在 claim 响应下发一次）。
  if (task.claim_state !== undefined && task.claim_state !== null) result.claim_state = String(task.claim_state);
  if (task.task_id !== undefined && task.task_id !== null) result.task_id = String(task.task_id);
  if (task.confirmation_id !== undefined && task.confirmation_id !== null) result.confirmation_id = String(task.confirmation_id);
  if (task.idempotent !== undefined) result.idempotent = task.idempotent === true;
  return result;
}
