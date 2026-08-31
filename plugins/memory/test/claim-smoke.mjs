// ============================================================================
// sagitta-memory — task-ownership-p2 §6 认领工具契约 smoke
// 本地 mock Worker（不需要真实部署）：
//   · claim 成功 → 完整投影 + claim_token（唯一一次下发）
//   · 重复 claim → 409 TASK_ALREADY_CLAIMED / 409 TASK_PENDING_CONFLICT 透传
//   · release 正确/错误 token → 成功 / 403 CLAIM_TOKEN_MISMATCH / 422 CLAIM_TOKEN_REQUIRED
//   · list 投影含 claim_state；claim_token / owner_agent_id 永不投影（防泄露）
// ============================================================================

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MemoryApiError, SagittaMemoryClient } from "../lib/client.js";
import { pickTask, validateClaimLease, TASK_LEASE_MAX } from "../lib/task-contract.js";

const requests = [];
const CLAIM_TOKEN_FREE = "clm-free-00000000-0000-0000-0000-000000000001";

const baseTask = (id, overrides = {}) => ({
  id,
  task_id: id,
  project: "memory-smoke",
  title: "claim contract smoke",
  status: "in_progress",
  priority: 0,
  checkbox: 0,
  stream: "company",
  body: "",
  created_at: "2026-08-31T00:00:00.000Z",
  updated_at: "2026-08-31T00:00:01.000Z",
  done_at: null,
  blocked_reason: null,
  pending_status: null,
  archived: 0,
  claim_state: "unclaimed",
  ...overrides,
});

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString("utf8");
  const body = bodyText ? JSON.parse(bodyText) : undefined;
  requests.push({ method: req.method, url: req.url, body });

  const path = req.url || "";
  const segments = path.split("/"); // ["", "task", id, action?]
  const taskId = segments[2];
  const action = segments[3];

  // POST /task/{id}/claim —— 模拟 Worker claimTaskHandler
  if (req.method === "POST" && action === "claim") {
    if (taskId === "tsk-busy") {
      return json(res, 409, { ok: false, error: { code: "TASK_ALREADY_CLAIMED", message: "任务当前不可认领：已被其他调用方认领（租约未过期）" } });
    }
    if (taskId === "tsk-pending") {
      return json(res, 409, { ok: false, error: { code: "TASK_PENDING_CONFLICT", message: "pending 任务不可认领（已有终态申请在途）" } });
    }
    if (taskId === "tsk-free") {
      return json(res, 200, { ok: true, data: {
        ...baseTask(taskId, { status: "in_progress", claim_state: "claimed" }),
        owner_agent_id: "agent-mock", // 服务端内部字段——投影必须丢弃
        claim_token: CLAIM_TOKEN_FREE, // 唯一一次下发
      } });
    }
    return json(res, 404, { ok: false, error: { code: "TASK_NOT_FOUND", message: "not found" } });
  }

  // POST /task/{id}/release —— 模拟 Worker releaseTaskHandler
  if (req.method === "POST" && action === "release") {
    if (taskId === "tsk-free") {
      return json(res, 200, { ok: true, data: baseTask(taskId, { status: "open", claim_state: "unclaimed" }) });
    }
    if (taskId === "tsk-wrong") {
      return json(res, 403, { ok: false, error: { code: "CLAIM_TOKEN_MISMATCH", message: "claim_token 不匹配：该任务未被认领，或凭证不属于当前调用方" } });
    }
    if (taskId === "tsk-notoken") {
      return json(res, 422, { ok: false, error: { code: "CLAIM_TOKEN_REQUIRED", message: "release 必须携带 claim_token（认领时的凭证）" } });
    }
    return json(res, 404, { ok: false, error: { code: "TASK_NOT_FOUND", message: "not found" } });
  }

  // GET /task —— 列表投影（含污染任务：服务端万一误下发 owner/claim_token，投影必须丢弃）
  if (req.method === "GET" && path === "/task") {
    return json(res, 200, { ok: true, data: {
      total: 3,
      items: [
        baseTask("tsk-a", { status: "open", claim_state: "unclaimed" }),
        baseTask("tsk-b", { status: "in_progress", claim_state: "claimed", owner_agent_id: "agent-other", claim_token: "clm-secret-b" }),
        baseTask("tsk-c", { status: "in_progress", claim_state: "claimed", owner_agent_id: "agent-me", claim_token: "clm-secret-c" }),
      ],
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
  auth: { authToken: "claim-smoke-token" },
});

try {
  // ---- validateClaimLease（纯函数）：未传 → null；合法 → 原值；非法 → 422 ----
  assert.equal(validateClaimLease(undefined), null);
  assert.equal(validateClaimLease(null), null);
  assert.equal(validateClaimLease(3600), 3600);
  assert.equal(validateClaimLease(TASK_LEASE_MAX), TASK_LEASE_MAX);
  for (const bad of [0, -1, 1.5, "60", TASK_LEASE_MAX + 1, NaN]) {
    assert.throws(
      () => validateClaimLease(bad),
      (error) => error instanceof MemoryApiError && error.status === 422 && error.code === "INVALID_LEASE_SECONDS"
    );
  }

  // ---- claim 成功：返回完整投影 + claim_token（带 lease_seconds）----
  const claimed = await client.claimTask("tsk-free", { leaseSeconds: 3600 });
  assert.equal(claimed.id, "tsk-free");
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.claim_state, "claimed");
  assert.equal(claimed.claim_token, CLAIM_TOKEN_FREE);
  const lastClaim = requests.at(-1);
  assert.equal(lastClaim.method, "POST");
  assert.equal(lastClaim.url, "/task/tsk-free/claim");
  assert.deepEqual(lastClaim.body, { lease_seconds: 3600 });

  // claim 不带 lease → body 不带 lease_seconds（服务端存 NULL = 全局默认 24h）
  await client.claimTask("tsk-free");
  assert.deepEqual(requests.at(-1).body, {});

  // ---- 重复 claim → 409 TASK_ALREADY_CLAIMED 透传 ----
  await assert.rejects(
    client.claimTask("tsk-busy"),
    (error) => error instanceof MemoryApiError && error.status === 409 && error.code === "TASK_ALREADY_CLAIMED"
  );

  // ---- pending 任务 → 409 TASK_PENDING_CONFLICT 透传 ----
  await assert.rejects(
    client.claimTask("tsk-pending"),
    (error) => error instanceof MemoryApiError && error.status === 409 && error.code === "TASK_PENDING_CONFLICT"
  );

  // ---- release 正确 token → 投影 claim_state=unclaimed、status 回 open、无 claim_token ----
  const released = await client.releaseTask("tsk-free", CLAIM_TOKEN_FREE);
  assert.equal(released.status, "open");
  assert.equal(released.claim_state, "unclaimed");
  assert.equal("claim_token" in released, false);
  assert.equal("owner_agent_id" in released, false);
  const lastRelease = requests.at(-1);
  assert.equal(lastRelease.method, "POST");
  assert.equal(lastRelease.url, "/task/tsk-free/release");
  assert.deepEqual(lastRelease.body, { claim_token: CLAIM_TOKEN_FREE });

  // ---- release 错误 token → 403 CLAIM_TOKEN_MISMATCH 透传 ----
  await assert.rejects(
    client.releaseTask("tsk-wrong", "clm-stolen"),
    (error) => error instanceof MemoryApiError && error.status === 403 && error.code === "CLAIM_TOKEN_MISMATCH"
  );

  // ---- release 缺 token → 422 CLAIM_TOKEN_REQUIRED 透传 ----
  await assert.rejects(
    client.releaseTask("tsk-notoken", ""),
    (error) => error instanceof MemoryApiError && error.status === 422 && error.code === "CLAIM_TOKEN_REQUIRED"
  );

  // ---- pickTask 投影：claim_state 保留；claim_token / owner_agent_id 永不出现 ----
  // （即使服务端响应里带了内部字段——模拟误下发，投影必须丢弃）
  const polluted = {
    ...baseTask("tsk-polluted", { claim_state: "claimed" }),
    owner_agent_id: "agent-top-secret",
    claim_token: "clm-top-secret",
  };
  const projected = pickTask(polluted);
  assert.equal(projected.claim_state, "claimed");
  assert.equal("owner_agent_id" in projected, false);
  assert.equal("claim_token" in projected, false);
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("owner_agent_id"), false);
  assert.equal(serialized.includes("claim_token"), false);
  assert.equal(serialized.includes("clm-top-secret"), false);

  // 未认领任务投影：claim_state 保留 unclaimed
  assert.equal(pickTask(baseTask("tsk-a", { status: "open", claim_state: "unclaimed" })).claim_state, "unclaimed");

  // ---- list 投影：每项含 claim_state；token/owner 全部被丢弃 ----
  const list = await client.listTasks();
  assert.equal(list.total, 3);
  const items = list.items.map(pickTask);
  assert.deepEqual(items.map((t) => t.claim_state), ["unclaimed", "claimed", "claimed"]);
  const listSerialized = JSON.stringify(items);
  assert.equal(listSerialized.includes("owner_agent_id"), false);
  assert.equal(listSerialized.includes("claim_token"), false);
  assert.equal(listSerialized.includes("clm-secret-b"), false);
  assert.equal(listSerialized.includes("clm-secret-c"), false);

  // ---- 请求路由与透传核对 ----
  assert.ok(requests.some((r) => r.method === "POST" && r.url === "/task/tsk-busy/claim"));
  assert.ok(requests.some((r) => r.method === "POST" && r.url === "/task/tsk-pending/claim"));
  assert.ok(requests.some((r) => r.method === "POST" && r.url === "/task/tsk-wrong/release"));

  console.log("memory claim smoke: PASS (claim token once, 409/403/422 passthrough, release reopen, claim_state projection, token/owner never leaked)");
} finally {
  server.close();
}
