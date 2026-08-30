import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MemoryApiError, SagittaMemoryClient } from "../lib/client.js";
import { pickTask, validateRoundText, validateTaskUpdate } from "../lib/task-contract.js";

const requests = [];
const baseTask = (id) => ({
  id,
  task_id: id,
  project: "memory-smoke",
  title: "task contract smoke",
  status: "in_progress",
  priority: 1,
  checkbox: 0,
  stream: "company",
  body: "",
  created_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:01.000Z",
  done_at: "",
  blocked_reason: null,
  pending_status: null,
  archived: 0,
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
  const taskId = path.split("/")[2];
  if (req.method === "PATCH" && path === "/task/tsk-pending") {
    return json(res, 200, { ok: true, data: {
      ...baseTask(taskId),
      pending_status: "pending_done",
      confirmation_id: "cnf-task-smoke-done",
      idempotent: false,
    } });
  }
  if (req.method === "POST" && path.endsWith("/confirm")) {
    const accepted = body.decision === "accept";
    return json(res, 200, { ok: true, data: {
      ...baseTask(taskId),
      status: accepted ? "done" : "in_progress",
      pending_status: null,
      done_at: accepted ? "2026-08-30T00:00:03.000Z" : "",
      confirmation_id: body.confirmation_id,
      idempotent: false,
    } });
  }
  if (req.method === "POST" && path.endsWith("/round-close")) {
    if (body.progress.includes("\n") || body.next.includes("\r")) {
      return json(res, 422, { ok: false, error: { code: "INVALID_PROGRESS", message: "progress 不得包含控制字符或换行" } });
    }
    return json(res, 200, { ok: true, data: {
      ...baseTask(taskId),
      pending_status: body.action === "done" ? "pending_done" : null,
      confirmation_id: body.action === "done" ? "cnf-round-smoke" : undefined,
      event_id: "evt-round-smoke",
      round_id: body.round_id,
      idempotent: false,
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
  auth: { authToken: "task-contract-smoke-token" },
});

try {
  const projected = pickTask({
    ...baseTask("tsk-projection"),
    pending_status: "pending_blocked",
    blocked_reason: "等待用户决定",
    confirmation_id: "cnf-projection",
  });
  assert.equal(projected.id, "tsk-projection");
  assert.equal(projected.pending_status, "pending_blocked");
  assert.equal(projected.blocked_reason, "等待用户决定");
  assert.equal(projected.done_at, "");
  assert.equal(projected.updated_at, "2026-08-30T00:00:01.000Z");
  assert.equal(projected.confirmation_id, "cnf-projection");
  assert.equal(validateRoundText("  一轮进展  ", "progress"), "一轮进展");
  for (const [value, code] of [["", "PROGRESS_REQUIRED"], ["x\ny", "INVALID_PROGRESS"], ["\0", "INVALID_PROGRESS"], ["x".repeat(1001), "PROGRESS_TOO_LONG"]]) {
    assert.throws(
      () => validateRoundText(value, "progress"),
      (error) => error instanceof MemoryApiError && error.status === 422 && error.code === code
    );
  }
  assert.throws(
    () => validateTaskUpdate({ status: "blocked" }),
    (error) => error instanceof MemoryApiError && error.status === 422 && error.code === "TASK_BLOCKED_REASON_REQUIRED"
  );
  assert.throws(
    () => validateTaskUpdate({ status: "done", blocked_reason: "not allowed" }),
    (error) => error instanceof MemoryApiError && error.status === 422 && error.code === "INVALID_BLOCKED_REASON"
  );

  const pending = await client.patchTask("tsk-pending", { status: "done" });
  assert.equal(pending.pending_status, "pending_done");
  assert.equal(pending.confirmation_id, "cnf-task-smoke-done");
  assert.equal(pending.done_at, "");

  const accepted = await client.confirmTask("tsk-accept", {
    decision: "accept",
    expected_pending: "pending_done",
    expected_updated_at: "2026-08-30T00:00:01.000Z",
    confirmation_id: "cnf-task-smoke-done",
  });
  assert.equal(accepted.status, "done");
  assert.equal(accepted.pending_status, null);
  assert.notEqual(accepted.done_at, "");

  const reopened = await client.confirmTask("tsk-reopen", {
    decision: "reopen",
    expected_pending: "pending_done",
    expected_updated_at: "2026-08-30T00:00:01.000Z",
    confirmation_id: "cnf-task-smoke-done",
  });
  assert.equal(reopened.status, "in_progress");
  assert.equal(reopened.pending_status, null);
  assert.equal(reopened.done_at, "");

  const closed = await client.roundCloseTask("tsk-round", {
    agent_id: "agent-main",
    round_id: "round-smoke-1",
    action: "done",
    progress: "已完成契约接线",
    next: "等待确认",
    expected_updated_at: "2026-08-30T00:00:01.000Z",
  });
  assert.equal(closed.event_id, "evt-round-smoke");
  assert.equal(closed.round_id, "round-smoke-1");
  assert.equal(closed.pending_status, "pending_done");
  assert.equal(closed.confirmation_id, "cnf-round-smoke");

  await assert.rejects(
    client.roundCloseTask("tsk-round", {
      agent_id: "agent-main",
      round_id: "round-invalid",
      action: "update",
      progress: "非法\n换行",
      next: "下一步",
    }),
    (error) => error instanceof MemoryApiError && error.status === 422 && error.code === "INVALID_PROGRESS"
  );

  assert.deepEqual(requests[0], {
    method: "PATCH",
    url: "/task/tsk-pending",
    body: { status: "done" },
  });
  assert.equal(requests.find((request) => request.url === "/task/tsk-round/round-close").body.agent_id, "agent-main");
  console.log("memory task contract smoke: PASS (projection, confirm accept/reopen, round-close, 422 validation)");
} finally {
  server.close();
}
