import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const workerCode = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const worker = await import("data:text/javascript;base64," + Buffer.from(workerCode).toString("base64"));

// D1 兼容适配器：本冒烟只复刻 Worker 用到的 prepare/bind/first/all/run 接口。
function makeD1(database) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            first: async () => database.prepare(sql).get(...params) ?? null,
            all: async () => ({ results: database.prepare(sql).all(...params) }),
            run: async () => {
              database.prepare(sql).run(...params);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
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
  assert.equal(result.status, 401, "write Bearer must not read task data");
  result = await call(env, "GET", "/task", read);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.items, []);

  result = await call(env, "POST", "/task", { ...read, body: { project: "alpha", title: "read must fail" } });
  assert.equal(result.status, 401, "read Bearer must not write task data");

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
  assert.equal(first.done_at, "");

  result = await call(env, "POST", "/task", {
    ...write,
    body: {
      project: "beta",
      title: "Blocked follow-up",
      status: "blocked",
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
  assert.equal(result.status, 401, "write Bearer must not use read search route");

  result = await call(env, "DELETE", "/task/" + first.id, { token: env.D1_READ_TOKEN });
  assert.equal(result.status, 401);
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
