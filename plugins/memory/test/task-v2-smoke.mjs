// task-system-v2 P2 本地 mock smoke。
// 不依赖 DSH runtime：用真实 SagittaMemoryClient 访问本地 HTTP mock，
// 并用无凭证的 task gate 验证执行工具绑定策略。

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SagittaMemoryClient } from "../lib/client.js";
import { createTaskGate, installTaskGate } from "../lib/task-gate.js";
import { recallProjectMemory } from "../lib/task-project-memory.js";
import { pickTask } from "../lib/task-contract.js";

const requests = [];
const agent = { id: "agent-task-v2-smoke" };
const claimToken = "clm-task-v2-smoke";

function task(id, overrides = {}) {
  return {
    id,
    task_id: id,
    kind: "normal",
    project: "sagitta-agent",
    title: id,
    status: "in_progress",
    priority: 0,
    checkbox: 0,
    stream: "company",
    body: "",
    created_at: "2026-09-03T00:00:00.000Z",
    updated_at: "2026-09-03T00:00:01.000Z",
    done_at: null,
    blocked_reason: null,
    pending_status: null,
    archived: 0,
    claim_state: "unclaimed",
    ...overrides,
  };
}

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString("utf8");
  const body = bodyText ? JSON.parse(bodyText) : undefined;
  const url = new URL(req.url || "/", "http://127.0.0.1");
  requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, agentId: req.headers["x-agent-id"] });

  if (req.method === "POST" && url.pathname === "/task/tsk-need/need-human") {
    assert.deepEqual(body, { content: "请确认是否保留旧接口", suggestion: "建议保留兼容层" });
    return json(res, 201, { ok: true, data: {
      nh_id: "nh-1",
      task_id: "tsk-need",
      content: body.content,
      suggestion: body.suggestion,
      status: "open",
      resolve_kind: null,
      created_at: "2026-09-03T00:00:02.000Z",
      resolved_at: null,
      updated_at: null,
    } });
  }
  if (req.method === "POST" && url.pathname === "/task/need-human/nh-1/resolve") {
    assert.deepEqual(body, { resolve_kind: "abandoned" });
    return json(res, 200, { ok: true, data: {
      nh_id: "nh-1",
      task_id: "tsk-need",
      content: "请确认是否保留旧接口",
      suggestion: "建议保留兼容层",
      status: "resolved",
      resolve_kind: "abandoned",
      created_at: "2026-09-03T00:00:02.000Z",
      resolved_at: "2026-09-03T00:00:03.000Z",
      updated_at: "2026-09-03T00:00:03.000Z",
    } });
  }
  if (req.method === "GET" && url.pathname === "/need-human") {
    assert.equal(url.searchParams.get("status"), "open");
    return json(res, 200, { ok: true, data: {
      total: 1,
      items: [{
        id: "nh-open",
        task_id: "tsk-project",
        content: "需要涟漪选方案 A/B",
        suggestion: null,
        status: "open",
        resolve_kind: null,
        created_at: "2026-09-03T00:00:04.000Z",
        resolved_at: null,
        updated_at: null,
      }],
    } });
  }

  if (req.method === "POST" && url.pathname === "/task") {
    assert.equal(body.kind, "temp");
    assert.equal(Object.hasOwn(body, "project"), false);
    return json(res, 201, { ok: true, data: task("tsk-temp-new", {
      kind: "temp", project: "", title: body.title, status: "open",
    }) });
  }
  if (req.method === "GET" && url.pathname === "/task") {
    const kind = url.searchParams.get("kind");
    if (url.searchParams.get("include_temp") === "1") return json(res, 200, { ok: true, data: {
      total: 2,
      items: [task("tsk-normal", { status: "open" }), task("tsk-temp-owned", { kind: "temp", project: "", title: "owned temp" })],
    } });
    if (kind === "normal") return json(res, 200, { ok: true, data: {
      total: 1, items: [task("tsk-normal", { status: "open" })],
    } });
    if (kind === "temp" && url.searchParams.get("owner") === "me") return json(res, 200, { ok: true, data: {
      total: 1, items: [task("tsk-temp-owned", { kind: "temp", project: "", title: "owned temp" })],
    } });
    return json(res, 200, { ok: true, data: { total: 0, items: [] } });
  }
  if (req.method === "POST" && url.pathname === "/task/tsk-project/claim") {
    assert.equal(req.headers["x-agent-id"], agent.id);
    return json(res, 200, { ok: true, data: {
      ...task("tsk-project", { status: "in_progress", claim_state: "claimed" }),
      claim_token: claimToken,
    } });
  }
  if (req.method === "GET" && url.pathname === "/mem/company-projects") {
    assert.equal(url.searchParams.get("domain"), "projects/sagitta-agent");
    assert.equal(url.searchParams.get("size"), "5");
    return json(res, 200, { ok: true, data: {
      total: 1,
      page: 1,
      size: 5,
      items: [{
        id: "mem-project-1",
        stream: "company-projects",
        type: "project",
        status: "corroborated",
        evidence: "corroborated",
        score: 2,
        ack_count: 0,
        explicit_ack_count: 0,
        unobjected_ack_count: 0,
        oppose_count: 0,
        cross_session_count: 0,
        pinned: false,
        domain: "projects/sagitta-agent",
        content: "项目记忆命中",
        created: "2026-09-02T00:00:00.000Z",
      }],
    } });
  }
  return json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "not found" } });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const client = new SagittaMemoryClient({
  baseUrl: `http://127.0.0.1:${port}`,
  proxy: "direct",
  timeoutMs: 2000,
  auth: { authToken: "task-v2-smoke-token" },
});

try {
  // need-human：记 / 解 / 跨任务列。
  const createdNeedHuman = await client.createNeedHuman("tsk-need", "请确认是否保留旧接口", "建议保留兼容层");
  assert.equal(createdNeedHuman.nh_id, "nh-1");
  const resolvedNeedHuman = await client.resolveNeedHuman("nh-1", "abandoned");
  assert.equal(resolvedNeedHuman.status, "resolved");
  const openNeedHumans = await client.listNeedHuman("open");
  assert.equal(openNeedHumans.total, 1);
  assert.equal(openNeedHumans.items[0].task_id, "tsk-project");

  // temp：创建不带 project；kind 过滤与 owner=me 视图。
  const createdTemp = await client.createTask({ kind: "temp", title: "临时两调用任务" });
  assert.equal(createdTemp.kind, "temp");
  assert.equal(createdTemp.project, "");
  const normalTasks = await client.listTasks({ kind: "normal", agentId: agent.id });
  const ownedTempTasks = await client.listTasks({ kind: "temp", owner: "me", agentId: agent.id });
  const defaultTasks = await client.listTasks({ includeTemp: 1, agentId: agent.id });
  assert.deepEqual(normalTasks.items.map((item) => item.kind), ["normal"]);
  assert.deepEqual(ownedTempTasks.items.map((item) => item.kind), ["temp"]);
  assert.deepEqual(defaultTasks.items.map((item) => item.kind), ["normal", "temp"]);
  assert.equal(requests.some((request) => request.path === "/task" && request.query.include_temp === "1" && request.agentId === agent.id), true);
  assert.equal(requests.some((request) => request.path === "/task" && request.query.kind === "temp" && request.query.owner === "me" && request.agentId === agent.id), true);

  // 认领后项目记忆召回：模拟 task_claim 成功 + recall 的固定 domain/size。
  const claimed = await client.claimTask("tsk-project", { agentId: agent.id });
  assert.equal(claimed.claim_token, claimToken);
  const recalled = await recallProjectMemory(client, task("tsk-project"));
  assert.equal(recalled.entries[0].content, "项目记忆命中");
  assert.match(recalled.note, /^已召回项目记忆：\n- /u);
  assert.match(recalled.note, /如需更多项目背景，可调用 memory_recall domain=projects\/sagitta-agent 查询/u);

  // task_assert_bound / 全局 guard 的同一份进程内绑定账本：normal/temp 均可，
  // 未认领或 task_id 不匹配的执行型调用均拒绝；没有凭证进入任何投影。
  const gate = createTaskGate();
  const deniedBeforeClaim = gate.guard({ name: "write", arguments: { file_path: "x" }, agent });
  assert.match(deniedBeforeClaim, /必须先 task_claim/);
  const registeredGuards = [];
  const installation = installTaskGate({ tools: { guard: (guard) => { registeredGuards.push(guard); return () => {}; } } }, gate);
  assert.equal(installation.mode, "global-guard");
  assert.equal(registeredGuards.length, 1);
  assert.match(registeredGuards[0]({ name: "write", arguments: { file_path: "x" }, agent }), /必须先 task_claim/);
  assert.equal(installTaskGate({ tools: {} }, gate).mode, "prompt+assert");
  gate.recordClaim({ id: "tsk-temp-owned", kind: "temp", status: "in_progress" }, agent);
  assert.equal(gate.assertBound("tsk-temp-owned", agent)[0].kind, "temp");
  assert.equal(gate.guard({ name: "write", arguments: { file_path: "x" }, agent }), undefined);
  assert.match(gate.guard({ name: "codex_dispatch", arguments: { task_id: "tsk-other" }, agent }), /必须先 task_claim/);
  gate.forgetClaim("tsk-temp-owned", agent);
  assert.equal(gate.assertBound(undefined, agent).length, 0);
  assert.equal("claim_token" in pickTask(claimed), false);

  console.log("memory task v2 smoke: PASS (need-human create/resolve/list, temp create/filter, claim recall mock, task_assert_bound gate)");
} finally {
  server.close();
}
