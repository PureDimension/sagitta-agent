import assert from "node:assert/strict";
import {
  AsyncWorkError,
  AsyncWorkRegistry,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "../lib/registry.js";

let now = Date.parse("2026-08-30T00:00:00.000Z");
let sequence = 0;
const settled = [];
const registry = new AsyncWorkRegistry({
  clock: () => now,
  idFactory: () => `work-${++sequence}`,
});
const disposeSettled = registry.onSettled((payload) => settled.push(payload));

const workA = registry.register({
  ownerId: "agent-1",
  taskId: "task-A",
  kind: "install",
  desc: "等待安装完成",
  timeoutMs: MIN_TIMEOUT_MS,
});
assert.deepEqual(workA, {
  work_id: "work-1",
  task_id: "task-A",
  owner_id: "agent-1",
  kind: "install",
  desc: "等待安装完成",
  started_at: "2026-08-30T00:00:00.000Z",
  timeout_ms: MIN_TIMEOUT_MS,
  status: "running",
  ended_at: null,
  reason: null,
});
assert.equal(registry.get("agent-1", workA.work_id).work_id, workA.work_id);
assert.equal(registry.get("agent-2", workA.work_id), null, "owner 隔离不能泄漏工作");

const workB = registry.register({
  ownerId: "agent-1",
  taskId: "task-B",
  kind: "external",
  desc: "等待外部系统",
  timeoutMs: MAX_TIMEOUT_MS,
});
assert.deepEqual(registry.listActive("agent-1", { taskId: "task-A" }).map((work) => work.work_id), [workA.work_id]);
assert.deepEqual(registry.listActive("agent-1", { taskId: "task-B" }).map((work) => work.work_id), [workB.work_id]);
assert.deepEqual(registry.listActive("agent-1").map((work) => work.work_id), [workA.work_id, workB.work_id]);

const completed = registry.complete("agent-1", workA.work_id, "task-A");
assert.equal(completed.status, "completed");
assert.equal(completed.ended_at, "2026-08-30T00:00:00.000Z");
assert.deepEqual(settled.at(-1), {
  ownerId: "agent-1",
  workId: workA.work_id,
  taskId: "task-A",
  status: "completed",
  reason: null,
});
assert.throws(
  () => registry.fail("agent-1", workA.work_id, "late failure", "task-A"),
  (error) => error instanceof AsyncWorkError && error.status === 409 && error.code === "ASYNC_WORK_TERMINAL"
);
assert.throws(
  () => registry.cancel("agent-1", workB.work_id, "task-A"),
  (error) => error instanceof AsyncWorkError && error.status === 409 && error.code === "ASYNC_WORK_TASK_MISMATCH"
);

const workC = registry.register({ ownerId: "agent-1", taskId: "task-C", kind: "model", desc: "超时测试", timeoutMs: MIN_TIMEOUT_MS });
now += MIN_TIMEOUT_MS;
assert.deepEqual(registry.listActive("agent-1", { taskId: "task-C" }), [], "listActive 调用前后自动 reap 超时工作");
assert.equal(registry.get("agent-1", workC.work_id).status, "expired");
assert.equal(registry.get("agent-1", workC.work_id).reason, "timeout");
assert.equal(settled.at(-1).status, "expired");
assert.throws(
  () => registry.complete("agent-1", workC.work_id, "task-C"),
  (error) => error instanceof AsyncWorkError && error.status === 409 && error.code === "ASYNC_WORK_TERMINAL"
);

for (const timeoutMs of [MIN_TIMEOUT_MS - 1, MAX_TIMEOUT_MS + 1, 1.5, Number.NaN]) {
  assert.throws(
    () => registry.register({ ownerId: "agent-1", taskId: "bad-timeout", kind: "test", desc: "bad", timeoutMs }),
    (error) => error instanceof AsyncWorkError && error.status === 422 && error.code === "INVALID_ASYNC_WORK_TIMEOUT"
  );
}
assert.throws(
  () => registry.register({ ownerId: "agent-1", kind: "test", desc: "missing task", timeoutMs: MIN_TIMEOUT_MS }),
  (error) => error instanceof AsyncWorkError && error.status === 422
);

const failed = registry.register({ ownerId: "agent-2", taskId: "task-fail", kind: "test", desc: "失败测试", timeoutMs: MIN_TIMEOUT_MS });
const failedResult = registry.fail("agent-2", failed.work_id, "外部系统返回错误", "task-fail");
assert.equal(failedResult.status, "failed");
assert.equal(failedResult.reason, "外部系统返回错误");
assert.deepEqual(settled.at(-1), {
  ownerId: "agent-2",
  workId: failed.work_id,
  taskId: "task-fail",
  status: "failed",
  reason: "外部系统返回错误",
});
const cancelled = registry.register({ ownerId: "agent-2", taskId: "task-cancel", kind: "test", desc: "取消测试", timeoutMs: MIN_TIMEOUT_MS });
assert.equal(registry.cancel("agent-2", cancelled.work_id, "task-cancel").status, "cancelled");
assert.equal(settled.at(-1).status, "cancelled");

const disposed = registry.dispose();
assert.equal(disposed, 1, "dispose 取消剩余 running 工作");
assert.deepEqual(settled.at(-1), {
  ownerId: "agent-1",
  workId: workB.work_id,
  taskId: "task-B",
  status: "cancelled",
  reason: "plugin-dispose",
});
disposeSettled();
assert.deepEqual(registry.byOwner.size, 0, "dispose 清空进程范围注册表");
assert.equal(registry.reap("agent-1"), 0);
assert.throws(
  () => registry.register({ ownerId: "agent-1", taskId: "after-dispose", kind: "test", desc: "不可登记", timeoutMs: MIN_TIMEOUT_MS }),
  (error) => error instanceof AsyncWorkError && error.status === 410
);

let serviceModule;
try {
  serviceModule = await import("../lib/index.js");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
if (serviceModule) {
  const { Context } = await import("@deepseek-ai/cordis");
  const ctx = new Context();
  const events = [];
  const disposeEvent = ctx.on(serviceModule.ASYNC_WORK_SETTLED_EVENT, (payload) => events.push(payload));
  const service = new serviceModule.AsyncWorkService(ctx, { defaultTimeoutMs: MIN_TIMEOUT_MS });
  const work = service.register({ ownerId: "agent-service", taskId: "task-service", kind: "external", desc: "服务事件", timeoutMs: MIN_TIMEOUT_MS });
  service.complete("agent-service", work.work_id, "task-service");
  assert.deepEqual(events, [{
    ownerId: "agent-service",
    workId: work.work_id,
    taskId: "task-service",
    status: "completed",
    reason: null,
  }]);
  disposeEvent();
  service.dispose();
  console.log("async-work service smoke: PASS (settlement event bridge)");
}

console.log("async-work smoke: PASS (lifecycle, settlement notifications, timeout bounds/reap, owner+task isolation, terminal guard, dispose cleanup)");
