const TASK_STATUSES = new Set(["open", "in_progress", "blocked", "waiting", "done"]);
const PENDING_STATUSES = new Set(["pending_done", "pending_blocked"]);
const MAX_PAGE_SIZE = 1000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(message) {
  const error = new Error(`task-api-unavailable: ${message}`);
  error.code = "task-api-unavailable";
  return error;
}

function nonEmpty(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) throw unavailable(`${field} 缺失或不是非空字符串`);
  return value.trim();
}

function timestamp(value, field) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) throw unavailable(`${field} 缺失或格式非法`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw unavailable(`${field} 不是合法时间`);
  return parsed;
}

function taskId(item) {
  const id = nonEmpty(item.task_id ?? item.id, "task_id");
  if (item.task_id !== undefined && item.task_id !== null && item.task_id !== id) {
    throw unavailable("task_id 与 id 不一致");
  }
  return id;
}

function validateTask(item) {
  if (!isRecord(item)) throw unavailable("items 中包含非法任务项");
  const id = taskId(item);
  const status = item.status;
  if (typeof status !== "string" || !TASK_STATUSES.has(status)) throw unavailable(`任务 ${id} 的 status 非法`);
  if (!Object.prototype.hasOwnProperty.call(item, "pending_status")) throw unavailable(`任务 ${id} 缺少 pending_status`);
  const pendingStatus = item.pending_status;
  if (pendingStatus !== null && !PENDING_STATUSES.has(pendingStatus)) throw unavailable(`任务 ${id} 的 pending_status 非法`);
  const blockedReason = item.blocked_reason === undefined ? null : item.blocked_reason;
  if (blockedReason !== null && (typeof blockedReason !== "string" || blockedReason.trim().length === 0)) {
    throw unavailable(`任务 ${id} 的 blocked_reason 非法`);
  }
  const doneAt = item.done_at === undefined ? null : item.done_at;
  if (doneAt !== null && (typeof doneAt !== "string" || doneAt.trim().length === 0)) {
    throw unavailable(`任务 ${id} 的 done_at 非法`);
  }
  const updatedAt = timestamp(item.updated_at ?? item.updatedAt, "updated_at");
  const createdAt = timestamp(item.created_at ?? item.createdAt, "created_at");
  const confirmationId = item.confirmation_id === undefined ? null : item.confirmation_id;
  if (confirmationId !== null && (typeof confirmationId !== "string" || confirmationId.trim().length === 0)) {
    throw unavailable(`任务 ${id} 的 confirmation_id 非法`);
  }

  // §3.2 pending/status/done_at/blocked_reason invariants.
  if (pendingStatus === "pending_done" && (status !== "in_progress" || doneAt !== null || blockedReason !== null)) {
    throw unavailable(`任务 ${id} 不满足 pending_done 不变量`);
  }
  if (pendingStatus === "pending_blocked" && (status !== "in_progress" || doneAt !== null || blockedReason === null)) {
    throw unavailable(`任务 ${id} 不满足 pending_blocked 不变量`);
  }
  if (pendingStatus !== null && confirmationId === null) throw unavailable(`任务 ${id} 的 pending 缺少 confirmation_id`);
  if (pendingStatus === null && confirmationId !== null) throw unavailable(`任务 ${id} 的非 pending 状态带 confirmation_id`);
  if (status === "done" && (pendingStatus !== null || doneAt === null)) throw unavailable(`任务 ${id} 不满足 done 不变量`);
  if (status === "blocked" && (pendingStatus !== null || blockedReason === null || doneAt !== null)) {
    throw unavailable(`任务 ${id} 不满足 blocked 不变量`);
  }
  if (status !== "done" && doneAt !== null) throw unavailable(`任务 ${id} 的非 done 状态带 done_at`);
  if (status !== "blocked" && pendingStatus !== "pending_blocked" && blockedReason !== null) {
    throw unavailable(`任务 ${id} 的 blocked_reason 与状态不一致`);
  }
  if (item.archived !== undefined && Number(item.archived) !== 0) throw unavailable(`任务 ${id} 为 archived，不应出现在列表快照`);
  if (item.checkbox !== undefined && item.checkbox !== 0 && item.checkbox !== 1 && item.checkbox !== false && item.checkbox !== true) {
    throw unavailable(`任务 ${id} 的 checkbox 非法`);
  }

  return {
    ...item,
    id,
    task_id: id,
    status,
    pending_status: pendingStatus,
    blocked_reason: blockedReason,
    done_at: doneAt,
    updated_at: item.updated_at ?? item.updatedAt,
    created_at: item.created_at ?? item.createdAt,
    confirmation_id: confirmationId,
    _updatedAtMs: updatedAt,
    _createdAtMs: createdAt,
  };
}

function unwrap(value) {
  if (isRecord(value) && value.ok === true && isRecord(value.data)) return value.data;
  return value;
}

export function validateCloudTaskPage(value) {
  const page = unwrap(value);
  if (!isRecord(page)) throw unavailable("响应 data 不是对象");
  if (!Number.isInteger(page.total) || page.total < 0) throw unavailable("total 必须是非负整数");
  if (!Number.isInteger(page.page) || page.page < 1) throw unavailable("page 必须是从 1 开始的整数");
  if (!Number.isInteger(page.size) || page.size < 1 || page.size > MAX_PAGE_SIZE) throw unavailable("size 超出合法范围");
  if (typeof page.has_more !== "boolean") throw unavailable("has_more 必须是 boolean");
  if (page.source !== "cloud") throw unavailable("响应 source 必须为 cloud");
  if (!Array.isArray(page.items)) throw unavailable("items 必须是数组");
  if (page.items.length > page.size) throw unavailable("当前页 items 超过 size");
  const expectedHasMore = page.page * page.size < page.total;
  if (page.has_more !== expectedHasMore) throw unavailable("has_more 与 total/page/size 不一致");
  return { ...page, items: page.items.map(validateTask) };
}

function compareTask(first, second) {
  return second._updatedAtMs - first._updatedAtMs ||
    second._createdAtMs - first._createdAtMs ||
    second.id.localeCompare(first.id);
}

function validatePages(value) {
  const unwrapped = unwrap(value);
  const pages = isRecord(unwrapped) && Array.isArray(unwrapped.pages) ? unwrapped.pages : [unwrapped];
  if (pages.length === 0) throw unavailable("分页响应为空");
  const checked = pages.map(validateCloudTaskPage);
  const first = checked[0];
  const expectedPageCount = Math.max(1, Math.ceil(first.total / first.size));
  if (checked.length !== expectedPageCount) throw unavailable("云端分页不完整");
  const items = [];
  const ids = new Set();
  for (let index = 0; index < checked.length; index++) {
    const page = checked[index];
    if (page.total !== first.total || page.size !== first.size || page.page !== index + 1 || page.source !== "cloud") {
      throw unavailable("云端分页元数据不连续");
    }
    for (const item of page.items) {
      if (ids.has(item.id)) throw unavailable(`云端分页存在重复任务 ${item.id}`);
      ids.add(item.id);
      items.push(item);
    }
  }
  if (items.length !== first.total) throw unavailable("云端分页 items 数量与 total 不一致");
  for (let index = 1; index < items.length; index++) {
    if (compareTask(items[index - 1], items[index]) > 0) throw unavailable("云端任务排序不稳定");
  }
  return { first, items };
}

/**
 * Qualification-grade task snapshot splitter. It deliberately accepts only a
 * complete cloud response; malformed, partial, or invariant-breaking data is
 * an unavailable error and can never become an empty task set.
 */
export function splitCloudTaskSnapshotStrict(value) {
  const { first, items } = validatePages(value);
  const publicItems = items.map(({ _updatedAtMs, _createdAtMs, ...item }) => item);
  const runnable = [];
  const confirmationQueue = [];
  const waiting = [];
  const terminal = [];
  for (const item of publicItems) {
    // Stage 3 claim integration: a task claimed by another worker's lease is
    // never runnable. claim_state is optional (older Worker omits it) and
    // only "claimed" is excluded; unclaimed/missing stay runnable.
    if ((item.status === "open" || item.status === "in_progress") && item.pending_status === null && item.claim_state !== "claimed") runnable.push(item);
    else if ((item.status === "open" || item.status === "in_progress") && item.pending_status === null) continue; // claimed：他人租约内，不进任何推进集合
    else if (item.pending_status === "pending_done" || item.pending_status === "pending_blocked") confirmationQueue.push(item);
    else if (item.status === "waiting") waiting.push(item);
    else if (item.status === "blocked" || item.status === "done") terminal.push(item);
    else throw unavailable(`任务 ${item.id} 无法归类`);
  }
  return {
    source: "cloud",
    total: first.total,
    page: first.page,
    size: first.size,
    items: publicItems,
    runnable,
    confirmationQueue,
    waiting,
    terminal,
  };
}

export { MAX_PAGE_SIZE };
