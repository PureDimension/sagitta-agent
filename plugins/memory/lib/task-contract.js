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

export function pickTask(task) {
  if (!task) return null;
  const result = {
    id: String(task.id ?? task.task_id ?? ""),
    project: String(task.project ?? ""),
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
  if (task.task_id !== undefined && task.task_id !== null) result.task_id = String(task.task_id);
  if (task.confirmation_id !== undefined && task.confirmation_id !== null) result.confirmation_id = String(task.confirmation_id);
  if (task.idempotent !== undefined) result.idempotent = task.idempotent === true;
  return result;
}
