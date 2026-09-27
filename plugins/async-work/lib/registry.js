import { randomUUID } from "node:crypto";

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const RECENT_LIMIT = 20;
const RECENT_TTL_MS = 6 * 60 * 60 * 1000;

const WORK_STATUSES = Object.freeze([
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
const TERMINAL_STATUSES = new Set(WORK_STATUSES.filter((status) => status !== "running"));

class AsyncWorkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AsyncWorkError";
    this.code = code;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AsyncWorkError("INVALID_ASYNC_WORK_FIELD", `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireTimeout(value, field = "timeoutMs") {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new AsyncWorkError(
      "INVALID_ASYNC_WORK_TIMEOUT",
      `${field} 必须是 ${MIN_TIMEOUT_MS} 至 ${MAX_TIMEOUT_MS} 毫秒的整数`
    );
  }
  return value;
}

function isoTime(epochMs) {
  return new Date(epochMs).toISOString();
}

/**
 * 对外传递的是快照，不是副本；这个函数明确定义模块对外暴露的字段集合。
 */
function snapshot(work) {
  return {
    work_id: work.work_id,
    task_id: work.task_id,
    owner_id: work.owner_id,
    kind: work.kind,
    desc: work.desc,
    started_at: work.started_at,
    timeout_ms: work.timeout_ms,
    status: work.status,
    ended_at: work.ended_at,
    reason: work.reason,
  };
}

function settledPayload(work) {
  return {
    ownerId: work.owner_id,
    workId: work.work_id,
    taskId: work.task_id,
    kind: work.kind,
    status: work.status,
    reason: work.reason,
  };
}

/**
 * Process-scoped bounded-work registry.
 *
 * The registry deliberately owns no persistence and no child-process handles.
 * An adapter may keep its own execution metadata, while this class remains the
 * sole owner of work identity, task binding and lifecycle state.
 */
class AsyncWorkRegistry {
  constructor({
    defaultTimeoutMs,
    clock = () => Date.now(),
    idFactory = () => randomUUID(),
    onListenerError = console.error,
  } = {}) {
    this.defaultTimeoutMs = defaultTimeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : requireTimeout(defaultTimeoutMs, "defaultTimeoutMs");
    this.clock = clock;
    this.idFactory = idFactory;
    this.onListenerError = onListenerError;
    this.byOwner = new Map();
    // Terminal records are retained separately from byOwner so a bounded
    // history survives the normal owner-map cleanup and plugin-dispose
    // settlement. Each entry carries its timestamp privately for TTL pruning.
    this.recentByOwner = new Map();
    this.settledListeners = new Set();
  }

  _owner(ownerId) {
    const normalized = requireString(ownerId, "ownerId");
    let works = this.byOwner.get(normalized);
    if (works === undefined) {
      works = new Map();
      this.byOwner.set(normalized, works);
    }
    return { ownerId: normalized, works };
  }

  _existing(ownerId, workId) {
    const normalizedOwner = requireString(ownerId, "ownerId");
    const normalizedWork = requireString(workId, "workId");
    return {
      ownerId: normalizedOwner,
      workId: normalizedWork,
      work: this.byOwner.get(normalizedOwner)?.get(normalizedWork) ?? null,
    };
  }

  _assertTask(work, taskId) {
    if (taskId === undefined) return;
    const normalizedTask = requireString(taskId, "taskId");
    if (work.task_id !== normalizedTask) {
      throw new AsyncWorkError(
        "ASYNC_WORK_TASK_MISMATCH",
        `工作 ${work.work_id} 绑定的是 task_id=${work.task_id}，不是 task_id=${normalizedTask}`
      );
    }
  }

  _isExpired(work, now = this.clock()) {
    return work.status === "running" && now - work.startedAtMs >= work.timeout_ms;
  }

  _pruneRecent(ownerId, now = this.clock()) {
    const records = this.recentByOwner.get(ownerId);
    if (records === undefined) return [];
    const retained = records
      .filter((record) => now < record.endedAtMs + RECENT_TTL_MS)
      .slice(0, RECENT_LIMIT);
    if (retained.length === 0) this.recentByOwner.delete(ownerId);
    else this.recentByOwner.set(ownerId, retained);
    return retained;
  }

  _rememberRecent(work, endedAtMs = this.clock()) {
    const ownerId = work.owner_id;
    const records = this.recentByOwner.get(ownerId) ?? [];
    const record = { work: snapshot(work), endedAtMs };
    records.unshift(record);
    this.recentByOwner.set(ownerId, records);
    this._pruneRecent(ownerId, record.endedAtMs);
  }

  _end(work, status, reason, endedAt = this.clock()) {
    work.status = status;
    work.ended_at = isoTime(endedAt);
    work.reason = reason ?? null;
    this._rememberRecent(work, endedAt);
    const payload = settledPayload(work);
    for (const listener of [...this.settledListeners]) {
      try {
        const result = listener({ ...payload });
        if (result !== undefined && result !== null && typeof result.then === "function") {
          Promise.resolve(result).catch((error) => this.onListenerError(error, listener));
        }
      } catch (error) {
        this.onListenerError(error, listener);
      }
    }
    return work;
  }

  /** Register a listener for every transition into a terminal status. */
  onSettled(listener) {
    if (typeof listener !== "function") throw new TypeError("onSettled listener 必须是函数");
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  register({ ownerId, taskId, kind = "generic", desc = "", timeoutMs } = {}) {
    const owner = requireString(ownerId, "ownerId");
    const task = requireString(taskId, "taskId");
    const normalizedKind = requireString(kind, "kind");
    if (typeof desc !== "string") {
      throw new AsyncWorkError("INVALID_ASYNC_WORK_FIELD", "desc 必须是字符串");
    }
    const timeout = requireTimeout(timeoutMs === undefined ? this.defaultTimeoutMs : timeoutMs);
    const startedAt = this.clock();
    const works = this._owner(owner).works;
    const workId = String(this.idFactory());
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
      startedAtMs: startedAt,
    };
    works.set(workId, work);
    return snapshot(work);
  }

  /** Mark timed-out work expired. Returns the number of records transitioned. */
  reap(ownerId) {
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
    const rawFilterTask = taskId ?? taskIdSnake;
    const filterTask = rawFilterTask === undefined ? undefined : requireString(rawFilterTask, "taskId");
    this.reap(ownerId);
    const { works } = this._owner(ownerId);
    return [...works.values()]
      .filter((work) => work.status === "running")
      .filter((work) => filterTask === undefined || work.task_id === filterTask)
      .map(snapshot);
  }

  get(ownerId, workId) {
    this.reap(ownerId);
    const work = this._existing(ownerId, workId).work;
    return work === null ? null : snapshot(work);
  }

  /** Return newest terminal records for one owner, bounded by the fixed count and TTL. */
  listRecent(ownerId) {
    const normalizedOwner = requireString(ownerId, "ownerId");
    const records = this._pruneRecent(normalizedOwner);
    return records.map((record) => snapshot(record.work));
  }

  _transition(ownerId, workId, status, reason, taskId) {
    this.reap(ownerId);
    const found = this._existing(ownerId, workId);
    if (found.work === null) {
      throw new AsyncWorkError("ASYNC_WORK_NOT_FOUND", `找不到工作 ${found.workId}`);
    }
    this._assertTask(found.work, taskId);
    if (found.work.status !== "running") {
      throw new AsyncWorkError(
        "ASYNC_WORK_TERMINAL",
        `工作 ${found.work.work_id} 已处于终态 ${found.work.status}，不能再次变更`
      );
    }
    return snapshot(this._end(found.work, status, reason));
  }

  settle(ownerId, workId, taskId, action, reason) {
    const statuses = { complete: "completed", fail: "failed", cancel: "cancelled" };
    const status = statuses[action];
    if (status === undefined) {
      throw new AsyncWorkError("INVALID_ASYNC_WORK_ACTION", "action 必须是 complete、fail 或 cancel");
    }
    if (action !== "fail" && reason !== undefined && reason !== null) {
      throw new AsyncWorkError("INVALID_ASYNC_WORK_REASON", "只有 fail action 可以传 reason");
    }
    let normalizedReason = null;
    if (action === "fail") {
      if (reason !== undefined && reason !== null && typeof reason !== "string") {
        throw new AsyncWorkError("INVALID_ASYNC_WORK_REASON", "reason 必须是字符串");
      }
      normalizedReason = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : null;
    }
    return this._transition(ownerId, workId, status, normalizedReason, taskId);
  }

  complete(ownerId, workId, taskId) {
    return this.settle(ownerId, workId, taskId, "complete");
  }

  fail(ownerId, workId, reason, taskId) {
    return this.settle(ownerId, workId, taskId, "fail", reason);
  }

  cancel(ownerId, workId, taskId) {
    return this.settle(ownerId, workId, taskId, "cancel");
  }

  /** Cancel running records and forget every record for process-scoped dispose. */
  dispose() {
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
    this.settledListeners.clear();
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
  requireString,
  requireTimeout,
  snapshot,
};
