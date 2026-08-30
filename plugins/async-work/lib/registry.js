import { randomUUID } from "node:crypto";

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const WORK_STATUSES = Object.freeze([
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
const TERMINAL_STATUSES = new Set(WORK_STATUSES.filter((status) => status !== "running"));

/**
 * Errors from the in-memory registry carry HTTP-like status information so
 * model tools and adapters can present a stable, fail-loud contract without
 * coupling the registry to a transport implementation.
 */
class AsyncWorkError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AsyncWorkError";
    this.status = status;
    this.code = code;
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AsyncWorkError(422, "INVALID_ASYNC_WORK_FIELD", `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function validateTimeout(value, field = "timeoutMs") {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new AsyncWorkError(
      422,
      "INVALID_ASYNC_WORK_TIMEOUT",
      `${field} 必须是 ${MIN_TIMEOUT_MS} 至 ${MAX_TIMEOUT_MS} 毫秒的整数`
    );
  }
  return value;
}

function normalizeDefaultTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return validateTimeout(value, "defaultTimeoutMs");
}

function isoTime(epochMs) {
  return new Date(epochMs).toISOString();
}

function cloneWork(work) {
  return { ...work };
}

/**
 * Process-scoped bounded-work registry.
 *
 * The registry deliberately owns no persistence and no child-process handles.
 * An adapter may keep its own execution metadata, while this class remains the
 * sole owner of work identity, task binding and lifecycle state.
 */
class AsyncWorkRegistry {
  constructor({ defaultTimeoutMs, clock = () => Date.now(), idFactory = () => randomUUID() } = {}) {
    this.defaultTimeoutMs = normalizeDefaultTimeout(defaultTimeoutMs);
    this.clock = clock;
    this.idFactory = idFactory;
    this.byOwner = new Map();
    this.closed = false;
  }

  _ensureOpen() {
    if (this.closed) {
      throw new AsyncWorkError(410, "ASYNC_WORK_REGISTRY_CLOSED", "async-work 注册表已关闭（进程生命周期已结束）");
    }
  }

  _owner(ownerId) {
    const normalized = requiredString(ownerId, "ownerId");
    let works = this.byOwner.get(normalized);
    if (works === undefined) {
      works = new Map();
      this.byOwner.set(normalized, works);
    }
    return { ownerId: normalized, works };
  }

  _existing(ownerId, workId) {
    const normalizedOwner = requiredString(ownerId, "ownerId");
    const normalizedWork = requiredString(workId, "workId");
    return {
      ownerId: normalizedOwner,
      workId: normalizedWork,
      work: this.byOwner.get(normalizedOwner)?.get(normalizedWork) ?? null,
    };
  }

  _assertTask(work, taskId) {
    if (taskId === undefined) return;
    const normalizedTask = requiredString(taskId, "taskId");
    if (work.task_id !== normalizedTask) {
      throw new AsyncWorkError(
        409,
        "ASYNC_WORK_TASK_MISMATCH",
        `工作 ${work.work_id} 绑定的是 task_id=${work.task_id}，不是 task_id=${normalizedTask}`
      );
    }
  }

  _isExpired(work, now = this.clock()) {
    return work.status === "running" && now - work._startedAtMs >= work.timeout_ms;
  }

  _end(work, status, reason, endedAt = this.clock()) {
    work.status = status;
    work.ended_at = isoTime(endedAt);
    work.reason = reason ?? null;
    return work;
  }

  register({ ownerId, taskId, kind = "generic", desc = "", timeoutMs } = {}) {
    this._ensureOpen();
    const owner = requiredString(ownerId, "ownerId");
    const task = requiredString(taskId, "taskId");
    const normalizedKind = requiredString(kind, "kind");
    if (typeof desc !== "string") {
      throw new AsyncWorkError(422, "INVALID_ASYNC_WORK_FIELD", "desc 必须是字符串");
    }
    const timeout = validateTimeout(timeoutMs === undefined ? this.defaultTimeoutMs : timeoutMs);
    const startedAt = this.clock();
    const works = this._owner(owner).works;
    let workId = String(this.idFactory());
    let attempts = 0;
    while (works.has(workId)) {
      if (++attempts >= 100) {
        throw new AsyncWorkError(500, "ASYNC_WORK_ID_COLLISION", "无法生成唯一 work_id");
      }
      workId = String(this.idFactory());
    }
    const work = {
      work_id: workId,
      task_id: task,
      owner_id: owner,
      kind: normalizedKind,
      desc,
      started_at: isoTime(startedAt),
      timeout_ms: timeout,
      status: "running",
      ended_at: null,
      reason: null,
    };
    // Keep clock data private to the registry; it is never returned to callers.
    Object.defineProperty(work, "_startedAtMs", { value: startedAt, writable: true, enumerable: false });
    works.set(workId, work);
    return cloneWork(work);
  }

  /** Mark timed-out work expired. Returns the number of records transitioned. */
  reap(ownerId) {
    if (this.closed) return 0;
    const { works } = this._owner(ownerId);
    const now = this.clock();
    let count = 0;
    for (const work of works.values()) {
      if (this._isExpired(work, now)) {
        this._end(work, "expired", "timeout", now);
        count++;
      }
    }
    return count;
  }

  /** Return only non-expired running work, optionally isolated by task_id. */
  listActive(ownerId, { taskId, task_id: taskIdSnake } = {}) {
    this._ensureOpen();
    const rawFilterTask = taskId ?? taskIdSnake;
    const filterTask = rawFilterTask === undefined ? undefined : requiredString(rawFilterTask, "taskId");
    this.reap(ownerId);
    const { works } = this._owner(ownerId);
    const active = () => [...works.values()]
      .filter((work) => work.status === "running")
      .filter((work) => filterTask === undefined || work.task_id === filterTask)
      .map(cloneWork);
    // A clock boundary may be crossed while the list is being built. Reap once
    // more so the returned contract is never stale-running.
    this.reap(ownerId);
    return active();
  }

  get(ownerId, workId) {
    this._ensureOpen();
    this.reap(ownerId);
    const work = this._existing(ownerId, workId).work;
    return work === null ? null : cloneWork(work);
  }

  _transition(ownerId, workId, status, reason, taskId) {
    this._ensureOpen();
    this.reap(ownerId);
    const found = this._existing(ownerId, workId);
    if (found.work === null) {
      throw new AsyncWorkError(404, "ASYNC_WORK_NOT_FOUND", `找不到工作 ${found.workId}`);
    }
    this._assertTask(found.work, taskId);
    if (found.work.status !== "running") {
      throw new AsyncWorkError(
        409,
        "ASYNC_WORK_TERMINAL",
        `工作 ${found.work.work_id} 已处于终态 ${found.work.status}，不能再次变更`
      );
    }
    return cloneWork(this._end(found.work, status, reason));
  }

  complete(ownerId, workId, taskId) {
    return this._transition(ownerId, workId, "completed", null, taskId);
  }

  fail(ownerId, workId, reason, taskId) {
    if (reason !== undefined && reason !== null && typeof reason !== "string") {
      throw new AsyncWorkError(422, "INVALID_ASYNC_WORK_REASON", "reason 必须是字符串");
    }
    const normalizedReason = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null;
    return this._transition(ownerId, workId, "failed", normalizedReason, taskId);
  }

  cancel(ownerId, workId, taskId) {
    return this._transition(ownerId, workId, "cancelled", null, taskId);
  }

  /** Cancel running records and forget every record for process-scoped dispose. */
  dispose() {
    if (this.closed) return 0;
    let cancelled = 0;
    const now = this.clock();
    for (const works of this.byOwner.values()) {
      for (const work of works.values()) {
        if (work.status === "running") {
          this._end(work, "cancelled", "plugin-dispose", now);
          cancelled++;
        }
      }
    }
    this.byOwner.clear();
    this.closed = true;
    return cancelled;
  }
}

export {
  AsyncWorkError,
  AsyncWorkRegistry,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  TERMINAL_STATUSES,
  WORK_STATUSES,
  cloneWork,
  normalizeDefaultTimeout,
  validateTimeout,
};
