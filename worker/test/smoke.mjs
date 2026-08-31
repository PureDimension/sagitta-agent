import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const workerCode = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const worker = await import("data:text/javascript;base64," + Buffer.from(workerCode).toString("base64"));

// D1 兼容适配器：包含 prepare/bind/first/all/run/batch；batch 用 SQLite 事务复刻 D1 原子批处理。
function makeD1(database, { onPrepare, failBatch = false } = {}) {
  function statement(sql, params = []) {
    const execute = (method) => database.prepare(sql)[method](...params);
    return {
      bind(...bound) { return statement(sql, bound); },
      first: async () => execute("get") ?? null,
      all: async () => ({ results: execute("all") }),
      run: async () => {
        const result = execute("run");
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare(sql) {
      onPrepare?.(sql);
      return statement(sql);
    },
    async batch(statements) {
      if (failBatch) throw new Error("synthetic batch failure");
      database.exec("BEGIN");
      try {
        const results = [];
        for (const prepared of statements) results.push(await prepared.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function call(workerEnv, method, path, { token, body } = {}) {
  const headers = {};
  if (token !== undefined) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request("https://worker.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.default.fetch(request, workerEnv);
  return { status: response.status, body: await response.json() };
}

test("/task CRUD, filters, LIKE search, soft delete, and read/write Bearer split", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  const env = {
    DB: makeD1(database),
    AUTH_TOKEN: "legacy-auth-smoke-token",
    D1_READ_TOKEN: "smoke-read-token",
    D1_WRITE_TOKEN: "smoke-write-token",
  };
  const read = { token: env.D1_READ_TOKEN };
  const write = { token: env.D1_WRITE_TOKEN };

  let result = await call(env, "GET", "/task");
  assert.equal(result.status, 401);
  assert.equal(result.body.ok, false);

  result = await call(env, "GET", "/task", write);
  assert.equal(result.status, 403, "write Bearer must not read task data");
  result = await call(env, "GET", "/task", read);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.items, []);

  result = await call(env, "POST", "/task", { ...read, body: { project: "alpha", title: "read must fail" } });
  assert.equal(result.status, 403, "read Bearer must not write task data");

  result = await call(env, "POST", "/task", {
    ...write,
    body: {
      project: "alpha",
      title: "Ship task API",
      status: "open",
      priority: 1,
      checkbox: true,
      stream: "company-projects",
      body: "unique-task-search-keyword",
    },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.ok, true);
  const first = result.body.data;
  assert.match(first.id, /^tsk-\d{8}-[0-9a-f]{6}$/);
  assert.equal(first.project, "alpha");
  assert.equal(first.status, "open");
  assert.equal(first.priority, 1);
  assert.equal(first.checkbox, 1);
  assert.equal(first.archived, 0);
  assert.equal(first.done_at, null);

  result = await call(env, "POST", "/task", {
    ...write,
    body: {
      project: "beta",
      title: "Blocked follow-up",
      status: "open",
      stream: "sagitta",
      body: "another task",
    },
  });
  assert.equal(result.status, 201);
  const second = result.body.data;

  result = await call(env, "GET", "/task/" + first.id, read);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.id, first.id);

  result = await call(env, "GET", "/task?project=alpha&stream=company-projects&status=open&checkbox=1", read);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.items.map((item) => item.id), [first.id]);

  result = await call(env, "PATCH", "/task/" + first.id, {
    ...write,
    body: { status: "in_progress", priority: 2, title: "Ship task API now", checkbox: false, body: "patched body" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "in_progress");
  assert.equal(result.body.data.priority, 2);
  assert.equal(result.body.data.title, "Ship task API now");
  assert.equal(result.body.data.checkbox, 0);
  assert.equal(result.body.data.body, "patched body");

  result = await call(env, "POST", "/task/search", { ...read, body: { query: "patched body" } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.items.map((item) => item.id), [first.id]);

  result = await call(env, "POST", "/task/search", { ...write, body: { query: "patched body" } });
  assert.equal(result.status, 403, "write Bearer must not use read search route");

  result = await call(env, "DELETE", "/task/" + first.id, { token: env.D1_READ_TOKEN });
  assert.equal(result.status, 403);
  result = await call(env, "DELETE", "/task/" + first.id, write);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.archived, 1);

  result = await call(env, "GET", "/task", read);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.items.map((item) => item.id), [second.id]);
  result = await call(env, "POST", "/task/search", { ...read, body: { query: "patched body" } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.items, []);

  result = await call(env, "GET", "/task/" + first.id, read);
  assert.equal(result.status, 200, "soft-deleted task remains addressable by id");
  assert.equal(result.body.data.archived, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS total FROM tasks WHERE id = ?").get(first.id).total, 1);
});

function taskEnv({ database = new DatabaseSync(":memory:"), legacy = false, failBatch = false, onPrepare } = {}) {
  if (legacy) {
    database.exec(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', priority INTEGER NOT NULL DEFAULT 0,
      checkbox INTEGER NOT NULL DEFAULT 0, stream TEXT NOT NULL DEFAULT 'company',
      body TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '',
      done_at TEXT DEFAULT '', archived INTEGER NOT NULL DEFAULT 0
    )`);
  } else {
    database.exec(schema);
  }
  return {
    database,
    env: {
      DB: makeD1(database, { failBatch, onPrepare }),
      AUTH_TOKEN: "legacy-auth-smoke-token",
      D1_READ_TOKEN: "smoke-read-token",
      D1_WRITE_TOKEN: "smoke-write-token",
    },
  };
}

test("task migration is re-entrant and fails closed when D1 batch fails", async () => {
  let alterCount = 0;
  const legacy = taskEnv({ legacy: true, onPrepare(sql) {
    if (/^ALTER TABLE tasks ADD COLUMN/.test(sql)) alterCount += 1;
  }});
  const read = { token: legacy.env.D1_READ_TOKEN };
  const legacyId = "tsk-20260830-legacy";
  legacy.database.prepare(
    "INSERT INTO tasks (id, project, title, status, priority, checkbox, stream, body, created_at, updated_at, done_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(legacyId, "legacy", "legacy task", "open", 0, 0, "company", "old body", "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z", "", 0);
  let result = await call(legacy.env, "GET", "/task", read);
  assert.equal(result.status, 200);
  assert.equal(alterCount, 2);
  result = await call(legacy.env, "GET", "/task/" + legacyId, read);
  assert.equal(result.body.data.body, "old body");
  assert.equal(result.body.data.pending_status, null);
  result = await call(legacy.env, "PATCH", "/task/" + legacyId, { token: legacy.env.D1_WRITE_TOKEN, body: { body: "updated old body" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.body, "updated old body");
  result = await call(legacy.env, "GET", "/task", read);
  assert.equal(result.status, 200);
  assert.equal(alterCount, 2, "second migration must not issue duplicate ALTER TABLE");
  const taskColumns = legacy.database.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
  assert.ok(taskColumns.includes("blocked_reason"));
  assert.ok(taskColumns.includes("pending_status"));
  const eventColumns = legacy.database.prepare("PRAGMA table_info(task_events)").all().map((row) => row.name);
  for (const column of ["event_id", "task_id", "agent_id", "event_type", "round_id", "action", "progress", "next", "blocked_reason", "pending_status", "confirmation_id", "expected_updated_at", "payload_json", "created_at"]) {
    assert.ok(eventColumns.includes(column), "missing task_events column " + column);
  }

  const broken = taskEnv({ failBatch: true });
  result = await call(broken.env, "GET", "/task", { token: broken.env.D1_READ_TOKEN });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "TASK_SCHEMA_UNAVAILABLE");
  assert.ok(result.body.request_id);
});

test("pending invariants, terminal create rejection, PATCH whitelist, and confirm idempotency", async () => {
  const { env } = taskEnv();
  const read = { token: env.D1_READ_TOKEN };
  const write = { token: env.D1_WRITE_TOKEN };

  for (const body of [
    { project: "p", title: "bad", status: "done" },
    { project: "p", title: "bad", status: "blocked" },
    { project: "p", title: "bad", pending_status: "pending_done" },
    { project: "p", title: "bad", done_at: "client" },
  ]) {
    const result = await call(env, "POST", "/task", { ...write, body });
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, "TASK_CREATE_TERMINAL_FORBIDDEN");
    assert.ok(result.body.request_id);
  }

  let result = await call(env, "POST", "/task", {
    ...write, body: { project: "p", title: "confirm me", status: "in_progress" },
  });
  const task = result.body.data;
  assert.equal(result.status, 201);

  result = await call(env, "PATCH", "/task/" + task.id, { ...write, body: { status: "done" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "in_progress");
  assert.equal(result.body.data.pending_status, "pending_done");
  assert.equal(result.body.data.done_at, null);
  const confirmationId = result.body.data.confirmation_id;
  const pendingVersion = result.body.data.updated_at;
  assert.match(confirmationId, /^cnf-/);

  result = await call(env, "PATCH", "/task/" + task.id, { ...write, body: { status: "open" } });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "TASK_PENDING_CONFLICT");
  result = await call(env, "PATCH", "/task/" + task.id, { ...write, body: { pending_status: null } });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "TASK_PATCH_FIELD_FORBIDDEN");

  result = await call(env, "PATCH", "/task/" + task.id, { ...write, body: { title: "still pending" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.pending_status, "pending_done");
  assert.equal(result.body.data.confirmation_id, confirmationId);

  result = await call(env, "POST", "/task/" + task.id + "/confirm", {
    ...write,
    body: { decision: "accept", expected_pending: "pending_done", expected_updated_at: "stale", confirmation_id: confirmationId },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "TASK_VERSION_CONFLICT");

  result = await call(env, "POST", "/task/" + task.id + "/confirm", {
    ...write,
    body: { decision: "accept", expected_pending: "pending_blocked", expected_updated_at: pendingVersion, confirmation_id: confirmationId },
  });
  assert.equal(result.status, 409);

  const current = await call(env, "GET", "/task/" + task.id, read);
  const confirmExpected = current.body.data.updated_at;
  result = await call(env, "POST", "/task/" + task.id + "/confirm", {
    ...write,
    body: { decision: "accept", expected_pending: "pending_done", expected_updated_at: confirmExpected, confirmation_id: confirmationId },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "done");
  assert.equal(result.body.data.pending_status, null);
  assert.match(result.body.data.done_at, /^20/);

  const acceptedVersion = result.body.data.updated_at;
  result = await call(env, "POST", "/task/" + task.id + "/confirm", {
    ...write,
    body: { decision: "accept", expected_pending: "pending_done", expected_updated_at: confirmExpected, confirmation_id: confirmationId },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.idempotent, true);
  result = await call(env, "POST", "/task/" + task.id + "/confirm", {
    ...write,
    body: { decision: "reopen", expected_pending: "pending_done", expected_updated_at: acceptedVersion, confirmation_id: confirmationId },
  });
  assert.equal(result.status, 409, "same confirmation with different content must conflict");
});

test("blocked pending, reopen, round-close atomic audit and idempotency", async () => {
  const { env, database } = taskEnv();
  const write = { token: env.D1_WRITE_TOKEN };
  let result = await call(env, "POST", "/task", {
    ...write, body: { project: "p", title: "blocked me", status: "in_progress" },
  });
  const task = result.body.data;

  result = await call(env, "PATCH", "/task/" + task.id, { ...write, body: { status: "blocked" } });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "TASK_BLOCKED_REASON_REQUIRED");
  result = await call(env, "PATCH", "/task/" + task.id, {
    ...write, body: { status: "blocked", blocked_reason: "等待外部系统" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.pending_status, "pending_blocked");
  assert.equal(result.body.data.status, "in_progress");
  const blockedConfirmation = result.body.data.confirmation_id;
  const blockedVersion = result.body.data.updated_at;
  result = await call(env, "POST", "/task/" + task.id + "/confirm", {
    ...write,
    body: { decision: "reopen", expected_pending: "pending_blocked", expected_updated_at: blockedVersion, confirmation_id: blockedConfirmation },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "in_progress");
  assert.equal(result.body.data.pending_status, null);
  assert.equal(result.body.data.blocked_reason, null);

  const finalBlocked = await call(env, "POST", "/task", {
    ...write, body: { project: "p", title: "accept blocked", status: "in_progress" },
  });
  result = await call(env, "PATCH", "/task/" + finalBlocked.body.data.id, {
    ...write, body: { status: "blocked", blocked_reason: "等待涟漪确认" },
  });
  const finalBlockedPending = result.body.data;
  result = await call(env, "POST", "/task/" + finalBlocked.body.data.id + "/confirm", {
    ...write,
    body: { decision: "accept", expected_pending: "pending_blocked", expected_updated_at: finalBlockedPending.updated_at, confirmation_id: finalBlockedPending.confirmation_id },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "blocked");
  assert.equal(result.body.data.pending_status, null);
  assert.equal(result.body.data.blocked_reason, "等待涟漪确认");

  result = await call(env, "POST", "/task/" + task.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-1", action: "update", progress: "完成第一轮", next: "继续实现" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.idempotent, false);
  const firstRoundVersion = result.body.data.updated_at;
  assert.equal(result.body.data.body, "", "round-close must not overwrite tasks.body");
  assert.equal(result.body.data.last_progress, "完成第一轮");
  assert.equal(result.body.data.last_next, "继续实现");
  const eventCount = () => database.prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id = ? AND event_type = 'round_close'").get(task.id).total;
  assert.equal(eventCount(), 1);

  result = await call(env, "POST", "/task/" + task.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-1", action: "update", progress: "完成第一轮", next: "继续实现" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.idempotent, true);
  assert.equal(eventCount(), 1);
  result = await call(env, "POST", "/task/" + task.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-1", action: "update", progress: "不同内容", next: "继续实现" },
  });
  assert.equal(result.status, 409);

  result = await call(env, "POST", "/task/" + task.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-2", action: "done", progress: "完成", next: "等待确认", expected_updated_at: "stale" },
  });
  assert.equal(result.status, 409);
  result = await call(env, "POST", "/task/" + task.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-2", action: "done", progress: "完成", next: "等待确认", expected_updated_at: firstRoundVersion },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.pending_status, "pending_done");
  const doneRound = result.body.data;
  result = await call(env, "POST", "/task/" + task.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-2", action: "done", progress: "完成", next: "等待确认", expected_updated_at: firstRoundVersion },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.idempotent, true);
  result = await call(env, "POST", "/task/" + task.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-3", action: "update", progress: "不应写入", next: "先确认" },
  });
  assert.equal(result.status, 409);
  result = await call(env, "POST", "/task/" + task.id + "/confirm", {
    ...write,
    body: { decision: "accept", expected_pending: "pending_done", expected_updated_at: doneRound.updated_at, confirmation_id: doneRound.confirmation_id },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "done");

  const open = await call(env, "POST", "/task", {
    ...write, body: { project: "p", title: "bad close", status: "open" },
  });
  result = await call(env, "POST", "/task/" + open.body.data.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-open", action: "update", progress: "x", next: "y" },
  });
  assert.equal(result.status, 422);
  result = await call(env, "POST", "/task/" + open.body.data.id + "/round-close", {
    ...write,
    body: { agent_id: "agent-main", round_id: "round-open", action: "blocked", progress: "x", next: "y" },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "BLOCKED_REASON_REQUIRED");
});
