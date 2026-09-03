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

async function call(workerEnv, method, path, { token, body, headers } = {}) {
  const headersObj = {};
  if (token !== undefined) headersObj.Authorization = "Bearer " + token;
  if (body !== undefined) headersObj["Content-Type"] = "application/json";
  if (headers) Object.assign(headersObj, headers);
  const request = new Request("https://worker.test" + path, {
    method,
    headers: headersObj,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.default.fetch(request, workerEnv);
  return { status: response.status, body: await response.json() };
}

// 认领测试的调用方标识：X-Agent-Id 头（缺省 'unknown'；task-ownership-p2 §4.1）
const agentA = { headers: { "X-Agent-Id": "agent-A" } };
const agentB = { headers: { "X-Agent-Id": "agent-B" } };

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
  assert.equal(first.kind, "normal");
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
  // blocked_reason + pending_status（既有）+ kind（v2）+ owner_agent_id/claimed_at/claim_token/lease_seconds（task-ownership-p2 §3）
  assert.equal(alterCount, 7);
  result = await call(legacy.env, "GET", "/task/" + legacyId, read);
  assert.equal(result.body.data.body, "old body");
  assert.equal(result.body.data.kind, "normal");
  assert.equal(result.body.data.pending_status, null);
  assert.equal(result.body.data.claim_state, "unclaimed", "legacy task without owner must read as unclaimed");
  result = await call(legacy.env, "PATCH", "/task/" + legacyId, { token: legacy.env.D1_WRITE_TOKEN, body: { body: "updated old body" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.body, "updated old body");
  result = await call(legacy.env, "GET", "/task", read);
  assert.equal(result.status, 200);
  assert.equal(alterCount, 7, "second migration must not issue duplicate ALTER TABLE");
  const taskColumns = legacy.database.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
  for (const column of ["blocked_reason", "pending_status", "kind", "owner_agent_id", "claimed_at", "claim_token", "lease_seconds"]) {
    assert.ok(taskColumns.includes(column), "missing tasks column " + column);
  }
  const eventColumns = legacy.database.prepare("PRAGMA table_info(task_events)").all().map((row) => row.name);
  for (const column of ["event_id", "task_id", "agent_id", "event_type", "round_id", "action", "progress", "next", "blocked_reason", "pending_status", "confirmation_id", "expected_updated_at", "payload_json", "created_at"]) {
    assert.ok(eventColumns.includes(column), "missing task_events column " + column);
  }
  const needHumanColumns = legacy.database.prepare("PRAGMA table_info(task_need_human)").all().map((row) => row.name);
  for (const column of ["id", "task_id", "content", "suggestion", "status", "created_at", "resolved_at", "resolved_by"]) {
    assert.ok(needHumanColumns.includes(column), "missing task_need_human column " + column);
  }

  const broken = taskEnv({ failBatch: true });
  result = await call(broken.env, "GET", "/task", { token: broken.env.D1_READ_TOKEN });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "TASK_SCHEMA_UNAVAILABLE");
  assert.ok(result.body.request_id);
});

test("v2 task kind, need-human lifecycle, done gate, and blocked reopening", async () => {
  const { env } = taskEnv();
  const read = { token: env.D1_READ_TOKEN };
  const write = { token: env.D1_WRITE_TOKEN };

  // temp 可无根创建；默认任务列表隐藏，显式 kind=temp 可见。
  let result = await call(env, "POST", "/task", {
    ...write, body: { kind: "temp", title: "temporary unrooted task" },
  });
  assert.equal(result.status, 201);
  const temp = result.body.data;
  assert.equal(temp.kind, "temp");
  assert.equal(temp.project, "");
  result = await call(env, "GET", "/task", read);
  assert.ok(!result.body.data.items.some((item) => item.id === temp.id));
  result = await call(env, "GET", "/task?kind=temp", read);
  assert.deepEqual(result.body.data.items.map((item) => item.id), [temp.id]);
  result = await call(env, "POST", "/task/" + temp.id + "/claim", { ...write, ...agentA, body: {} });
  assert.equal(result.status, 200);
  result = await call(env, "GET", "/task?include_temp=1", { ...read, ...agentA });
  assert.ok(result.body.data.items.some((item) => item.id === temp.id), "own claimed temp must be available to auto-advance");
  result = await call(env, "GET", "/task?kind=temp&owner=me", { ...read, ...agentA });
  assert.deepEqual(result.body.data.items.map((item) => item.id), [temp.id]);
  result = await call(env, "GET", "/task?kind=temp&owner=me", { ...read, ...agentB });
  assert.deepEqual(result.body.data.items, []);

  // open need-human 会阻止 done confirm；resolve（含 abandoned）后可继续确认。
  result = await call(env, "POST", "/task", {
    ...write, body: { project: "v2", title: "done gate", status: "in_progress" },
  });
  const gated = result.body.data;
  result = await call(env, "POST", "/task/" + gated.id + "/need-human", {
    ...write, body: { content: "请确认是否保留旧接口", suggestion: "建议保留兼容层" },
  });
  assert.equal(result.status, 201);
  const needHuman = result.body.data;
  assert.match(needHuman.id, /^nh-\d{8}-[0-9a-f]+$/);
  assert.equal(needHuman.status, "open");
  result = await call(env, "GET", "/need-human?status=open", read);
  assert.ok(result.body.data.items.some((item) => item.id === needHuman.id));
  result = await call(env, "PATCH", "/task/" + gated.id, { ...write, body: { status: "done" } });
  assert.equal(result.status, 200);
  const donePending = result.body.data;
  result = await call(env, "POST", "/task/" + gated.id + "/confirm", {
    ...write,
    body: {
      decision: "accept", expected_pending: "pending_done",
      expected_updated_at: donePending.updated_at,
      confirmation_id: donePending.confirmation_id,
    },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "TASK_NEED_HUMAN_OPEN");
  result = await call(env, "POST", "/task/need-human/" + needHuman.id + "/resolve", {
    ...write, body: { resolve_kind: "abandoned" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "resolved");
  result = await call(env, "POST", "/task/" + gated.id + "/confirm", {
    ...write,
    body: {
      decision: "accept", expected_pending: "pending_done",
      expected_updated_at: donePending.updated_at,
      confirmation_id: donePending.confirmation_id,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "done");
  result = await call(env, "GET", "/need-human?status=open", read);
  assert.ok(!result.body.data.items.some((item) => item.id === needHuman.id));

  // blocked 任务清掉最后一条 need-human 后自动回 open；in_progress 解除则保持原状态。
  result = await call(env, "POST", "/task", {
    ...write, body: { project: "v2", title: "blocked reopen", status: "in_progress" },
  });
  const blocked = result.body.data;
  result = await call(env, "PATCH", "/task/" + blocked.id, {
    ...write, body: { status: "blocked", blocked_reason: "等待涟漪决定" },
  });
  const blockedPending = result.body.data;
  result = await call(env, "POST", "/task/" + blocked.id + "/confirm", {
    ...write,
    body: {
      decision: "accept", expected_pending: "pending_blocked",
      expected_updated_at: blockedPending.updated_at,
      confirmation_id: blockedPending.confirmation_id,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "blocked");
  const nhBodies = ["补充业务背景", "确认是否继续"];
  const nhIds = [];
  for (const content of nhBodies) {
    result = await call(env, "POST", "/task/" + blocked.id + "/need-human", { ...write, body: { content } });
    assert.equal(result.status, 201);
    nhIds.push(result.body.data.id);
  }
  result = await call(env, "POST", "/task/need-human/" + nhIds[0] + "/resolve", { ...write, body: {} });
  assert.equal(result.status, 200);
  result = await call(env, "GET", "/task/" + blocked.id, read);
  assert.equal(result.body.data.status, "blocked");
  result = await call(env, "POST", "/task/need-human/" + nhIds[1] + "/resolve", { ...write, body: { resolved_by: "sagitta" } });
  assert.equal(result.status, 200);
  result = await call(env, "GET", "/task/" + blocked.id, read);
  assert.equal(result.body.data.status, "open");
  assert.equal(result.body.data.blocked_reason, null);

  result = await call(env, "POST", "/task", {
    ...write, body: { project: "v2", title: "in progress need-human", status: "in_progress" },
  });
  const progressing = result.body.data;
  result = await call(env, "POST", "/task/" + progressing.id + "/need-human", { ...write, body: { content: "请补充一个参数" } });
  result = await call(env, "POST", "/task/need-human/" + result.body.data.id + "/resolve", { ...write, body: {} });
  assert.equal(result.status, 200);
  result = await call(env, "GET", "/task/" + progressing.id, read);
  assert.equal(result.body.data.status, "in_progress");
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

test("task claim lifecycle: atomic claim, token privacy, PATCH guard, takeover after expiry, release, terminal release", async () => {
  const { env, database } = taskEnv();
  const read = { token: env.D1_READ_TOKEN };
  const write = { token: env.D1_WRITE_TOKEN };

  // 建一个 open 任务：claim_state=unclaimed，创建响应不下发 claim_token/owner_agent_id
  let result = await call(env, "POST", "/task", { ...write, body: { project: "p", title: "claim me" } });
  assert.equal(result.status, 201);
  const task = result.body.data;
  assert.equal(task.claim_state, "unclaimed");
  assert.ok(!("owner_agent_id" in task), "owner_agent_id must never appear in responses");
  assert.ok(!("claim_token" in task), "claim_token must not appear in create response");

  // A 认领 open 任务 → in_progress + claimed + token 唯一下发一次
  result = await call(env, "POST", "/task/" + task.id + "/claim", { ...write, ...agentA, body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data.status, "in_progress");
  assert.equal(result.body.data.claim_state, "claimed");
  assert.ok(typeof result.body.data.claim_token === "string" && result.body.data.claim_token.length > 0);
  assert.match(result.body.data.claim_token, /^clm-/);
  assert.ok(!("owner_agent_id" in result.body.data), "owner_agent_id must never appear in claim response");
  const tokenA = result.body.data.claim_token;

  // 重复认领（B 或 A 自己）→ 409 TASK_ALREADY_CLAIMED
  for (const who of [agentA, agentB]) {
    result = await call(env, "POST", "/task/" + task.id + "/claim", { ...write, ...who, body: {} });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "TASK_ALREADY_CLAIMED");
  }

  // claim_token 只在 claim 响应：列表/详情不下发；owner_agent_id 永不下发
  result = await call(env, "GET", "/task/" + task.id, read);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.claim_state, "claimed");
  assert.ok(!("claim_token" in result.body.data), "claim_token must not appear in detail response");
  assert.ok(!("owner_agent_id" in result.body.data));
  result = await call(env, "GET", "/task", read);
  const item = result.body.data.items.find((i) => i.id === task.id);
  assert.equal(item.claim_state, "claimed");
  assert.ok(!("claim_token" in item), "claim_token must not appear in list response");
  assert.ok(!("owner_agent_id" in item));

  // PATCH in_progress 防绕过认领：B 直接 PATCH → 409；owner A → 允许
  result = await call(env, "PATCH", "/task/" + task.id, { ...write, ...agentB, body: { status: "in_progress" } });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "TASK_ALREADY_CLAIMED");
  result = await call(env, "PATCH", "/task/" + task.id, { ...write, ...agentA, body: { status: "in_progress", title: "owner patch ok" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.claim_state, "claimed");

  // 错误 token 释放 → 403 CLAIM_TOKEN_MISMATCH
  result = await call(env, "POST", "/task/" + task.id + "/release", { ...write, body: { claim_token: "clm-not-the-token" } });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, "CLAIM_TOKEN_MISMATCH");
  result = await call(env, "POST", "/task/" + task.id + "/release", { ...write, body: {} });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, "CLAIM_TOKEN_REQUIRED");

  // 正确 token 释放 → open + unclaimed + 可被 B 重新认领（token 更换）
  result = await call(env, "POST", "/task/" + task.id + "/release", { ...write, body: { claim_token: tokenA } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "open");
  assert.equal(result.body.data.claim_state, "unclaimed");
  assert.ok(!("claim_token" in result.body.data));
  result = await call(env, "POST", "/task/" + task.id + "/claim", { ...write, ...agentB, body: {} });
  assert.equal(result.status, 200);
  const tokenB = result.body.data.claim_token;
  assert.notEqual(tokenB, tokenA);

  // 租约过期接管：把 claimed_at 拨回 25h 前（> 默认 24h 租约）→ 读取视为 unclaimed，可被 A 接管
  database.prepare("UPDATE tasks SET claimed_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 25 * 3600 * 1000).toISOString(), task.id);
  result = await call(env, "GET", "/task/" + task.id, read);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.claim_state, "unclaimed", "expired lease must read as unclaimed");
  result = await call(env, "POST", "/task/" + task.id + "/claim", { ...write, ...agentA, body: {} });
  assert.equal(result.status, 200, "expired claim can be taken over by another caller");
  assert.equal(result.body.data.claim_state, "claimed");
  const tokenTakeover = result.body.data.claim_token;
  assert.notEqual(tokenTakeover, tokenB, "takeover must issue a fresh token");

  // 终态自动释放：claim → PATCH done（pending 期间 owner 保持 claimed）→ confirm accept → unclaimed 且 done 不可认领
  result = await call(env, "PATCH", "/task/" + task.id, { ...write, ...agentA, body: { status: "done" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.pending_status, "pending_done");
  assert.equal(result.body.data.claim_state, "claimed", "pending 申请不释放 owner（认领持续到终态确认）");
  const confirmationId = result.body.data.confirmation_id;
  const pendingVersion = result.body.data.updated_at;
  result = await call(env, "POST", "/task/" + task.id + "/claim", { ...write, ...agentB, body: {} });
  assert.equal(result.status, 409, "pending 任务不可认领");
  assert.equal(result.body.error.code, "TASK_PENDING_CONFLICT");
  result = await call(env, "POST", "/task/" + task.id + "/confirm", {
    ...write,
    body: { decision: "accept", expected_pending: "pending_done", expected_updated_at: pendingVersion, confirmation_id: confirmationId },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "done");
  assert.equal(result.body.data.claim_state, "unclaimed", "confirm accept 自动释放 owner");
  assert.ok(!("claim_token" in result.body.data));
  result = await call(env, "POST", "/task/" + task.id + "/claim", { ...write, ...agentB, body: {} });
  assert.equal(result.status, 409, "done 终态任务不可认领");

  // 存量 in_progress 无 owner → 视为未认领，可认领（task-ownership-p2 §7 旧数据）
  result = await call(env, "POST", "/task", {
    ...write, body: { project: "p", title: "legacy in_progress", status: "in_progress" },
  });
  assert.equal(result.status, 201);
  const legacyProgress = result.body.data;
  assert.equal(legacyProgress.claim_state, "unclaimed");
  result = await call(env, "POST", "/task/" + legacyProgress.id + "/claim", { ...write, ...agentB, body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.claim_state, "claimed");

  // PATCH 到 waiting 自动释放 owner（waiting/blocked 不占用，设计 §7）；
  // waiting 不在认领条件内（仅 open / in_progress 可认领）→ 409，回 open 后可认领
  result = await call(env, "POST", "/task", { ...write, body: { project: "p", title: "waiting release" } });
  const waitTask = result.body.data;
  result = await call(env, "POST", "/task/" + waitTask.id + "/claim", { ...write, ...agentA, body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.claim_state, "claimed");
  result = await call(env, "PATCH", "/task/" + waitTask.id, { ...write, ...agentA, body: { status: "waiting" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "waiting");
  assert.equal(result.body.data.claim_state, "unclaimed", "PATCH 到 waiting 自动释放 owner");
  assert.ok(!("claim_token" in result.body.data));
  result = await call(env, "POST", "/task/" + waitTask.id + "/claim", { ...write, ...agentB, body: {} });
  assert.equal(result.status, 409, "waiting 状态不在认领条件内");
  result = await call(env, "PATCH", "/task/" + waitTask.id, { ...write, ...agentB, body: { status: "open" } });
  assert.equal(result.status, 200);
  result = await call(env, "POST", "/task/" + waitTask.id + "/claim", { ...write, ...agentB, body: {} });
  assert.equal(result.status, 200, "waiting→open 后可被重新认领");

  // 缺省调用方标识：不带 X-Agent-Id → 'unknown'，仍可认领
  result = await call(env, "POST", "/task", { ...write, body: { project: "p", title: "no header claim" } });
  const noHeaderTask = result.body.data;
  result = await call(env, "POST", "/task/" + noHeaderTask.id + "/claim", { ...write, body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.claim_state, "claimed");
  result = await call(env, "GET", "/task/" + noHeaderTask.id, read);
  assert.ok(!("owner_agent_id" in result.body.data));

  // lease_seconds 校验：非法值 422（非整数 / 0 / 超上限 604800）
  result = await call(env, "POST", "/task", { ...write, body: { project: "p", title: "lease validation" } });
  const leaseTask = result.body.data;
  for (const bad of ["abc", 0, -1, 604801, 1.5]) {
    result = await call(env, "POST", "/task/" + leaseTask.id + "/claim", { ...write, body: { lease_seconds: bad } });
    assert.equal(result.status, 422, "lease_seconds=" + bad + " must be rejected");
    assert.equal(result.body.error.code, "INVALID_LEASE_SECONDS");
  }

  // lease_seconds 持久化：claim 传 3600 → 行内 lease_seconds=3600（租约内），读取 claim_state=claimed
  result = await call(env, "POST", "/task", { ...write, body: { project: "p", title: "lease persist" } });
  const persistTask = result.body.data;
  result = await call(env, "POST", "/task/" + persistTask.id + "/claim", { ...write, ...agentA, body: { lease_seconds: 3600 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.claim_state, "claimed");
  let row = database.prepare("SELECT lease_seconds FROM tasks WHERE id = ?").get(persistTask.id);
  assert.equal(row.lease_seconds, 3600, "claim 的 lease_seconds 必须持久化到行");
  // 释放后 lease_seconds 一并清空
  result = await call(env, "POST", "/task/" + persistTask.id + "/release", {
    ...write, body: { claim_token: result.body.data.claim_token },
  });
  assert.equal(result.status, 200);
  row = database.prepare("SELECT lease_seconds, owner_agent_id, claimed_at, claim_token FROM tasks WHERE id = ?").get(persistTask.id);
  assert.equal(row.lease_seconds, null, "release 必须清空 lease_seconds");
  assert.equal(row.owner_agent_id, null);
  assert.equal(row.claimed_at, null);
  assert.equal(row.claim_token, null);

  // 短租约任务：租约内他人不可认领（409），过期后（拨回 claimed_at 越过租约）可接管
  result = await call(env, "POST", "/task", { ...write, body: { project: "p", title: "short lease takeover" } });
  const shortTask = result.body.data;
  result = await call(env, "POST", "/task/" + shortTask.id + "/claim", { ...write, ...agentA, body: { lease_seconds: 5 } });
  assert.equal(result.status, 200);
  const shortToken = result.body.data.claim_token;
  row = database.prepare("SELECT lease_seconds FROM tasks WHERE id = ?").get(shortTask.id);
  assert.equal(row.lease_seconds, 5);
  // 租约内（5s 未过）：B 认领 → 409；读取仍 claimed
  result = await call(env, "POST", "/task/" + shortTask.id + "/claim", { ...write, ...agentB, body: {} });
  assert.equal(result.status, 409, "租约内（短租约未过期）他人不可认领");
  assert.equal(result.body.error.code, "TASK_ALREADY_CLAIMED");
  result = await call(env, "GET", "/task/" + shortTask.id, read);
  assert.equal(result.body.data.claim_state, "claimed");
  // 过期：claimed_at 拨回 10s 前（> 5s 租约）→ 读取 unclaimed，B 可接管（新 token）
  database.prepare("UPDATE tasks SET claimed_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 1000).toISOString(), shortTask.id);
  result = await call(env, "GET", "/task/" + shortTask.id, read);
  assert.equal(result.body.data.claim_state, "unclaimed", "短租约过期后读取视为未认领");
  result = await call(env, "POST", "/task/" + shortTask.id + "/claim", { ...write, ...agentB, body: { lease_seconds: 3600 } });
  assert.equal(result.status, 200, "短租约过期后可被他人接管");
  assert.equal(result.body.data.claim_state, "claimed");
  assert.notEqual(result.body.data.claim_token, shortToken, "接管必须发放新 token");
  row = database.prepare("SELECT lease_seconds, owner_agent_id FROM tasks WHERE id = ?").get(shortTask.id);
  assert.equal(row.lease_seconds, 3600, "接管后按新调用方租约持久化");
  // 终态确认清空 lease_seconds：接管者提交 done → confirm accept
  result = await call(env, "PATCH", "/task/" + shortTask.id, { ...write, ...agentB, body: { status: "done" } });
  assert.equal(result.status, 200);
  result = await call(env, "POST", "/task/" + shortTask.id + "/confirm", {
    ...write,
    body: {
      decision: "accept",
      expected_pending: "pending_done",
      expected_updated_at: result.body.data.updated_at,
      confirmation_id: result.body.data.confirmation_id,
    },
  });
  assert.equal(result.status, 200);
  row = database.prepare("SELECT lease_seconds, owner_agent_id, claim_token FROM tasks WHERE id = ?").get(shortTask.id);
  assert.equal(row.lease_seconds, null, "终态确认必须清空 lease_seconds");
  assert.equal(row.owner_agent_id, null);
  assert.equal(row.claim_token, null);

  // 未传 lease_seconds → 行内 NULL（用全局默认 24h），读取/接管按默认租约判定
  result = await call(env, "POST", "/task", { ...write, body: { project: "p", title: "default lease null" } });
  const defaultTask = result.body.data;
  result = await call(env, "POST", "/task/" + defaultTask.id + "/claim", { ...write, ...agentA, body: {} });
  assert.equal(result.status, 200);
  row = database.prepare("SELECT lease_seconds FROM tasks WHERE id = ?").get(defaultTask.id);
  assert.equal(row.lease_seconds, null, "未传 lease_seconds 时行内为 NULL（全局默认 24h）");
});
