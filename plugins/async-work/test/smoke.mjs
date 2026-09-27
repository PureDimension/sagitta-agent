import assert from "node:assert/strict";
import {
  AsyncWorkError,
  AsyncWorkRegistry,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "../lib/registry.js";

const SNAPSHOT_FIELDS = [
  "work_id",
  "task_id",
  "owner_id",
  "kind",
  "desc",
  "started_at",
  "timeout_ms",
  "status",
  "ended_at",
  "reason",
];

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
assert.deepEqual(Object.keys(workA), SNAPSHOT_FIELDS, "snapshot fields are explicit and exact");
assert.equal(Object.hasOwn(workA, "startedAtMs"), false, "snapshot hides internal clock data");
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

const completed = registry.settle("agent-1", workA.work_id, "task-A", "complete");
assert.equal(completed.status, "completed");
assert.equal(completed.ended_at, "2026-08-30T00:00:00.000Z");
assert.deepEqual(registry.listRecent("agent-1").map((work) => work.work_id), [workA.work_id]);
assert.deepEqual(registry.listRecent("agent-2"), [], "recent ring must be isolated by owner");
assert.deepEqual(settled.at(-1), {
  ownerId: "agent-1",
  workId: workA.work_id,
  taskId: "task-A",
  kind: "install",
  status: "completed",
  reason: null,
});
assert.throws(
  () => registry.fail("agent-1", workA.work_id, "late failure", "task-A"),
  (error) => error instanceof AsyncWorkError && error.code === "ASYNC_WORK_TERMINAL"
);
assert.throws(
  () => registry.cancel("agent-1", workB.work_id, "task-A"),
  (error) => error instanceof AsyncWorkError && error.code === "ASYNC_WORK_TASK_MISMATCH"
);

const workC = registry.register({ ownerId: "agent-1", taskId: "task-C", kind: "model", desc: "超时测试", timeoutMs: MIN_TIMEOUT_MS });
now += MIN_TIMEOUT_MS;
assert.deepEqual(registry.listActive("agent-1", { taskId: "task-C" }), [], "injected clock drives timeout reap");
assert.equal(registry.get("agent-1", workC.work_id).status, "expired");
assert.equal(registry.get("agent-1", workC.work_id).reason, "timeout");
assert.equal(settled.at(-1).status, "expired");
assert.throws(
  () => registry.complete("agent-1", workC.work_id, "task-C"),
  (error) => error instanceof AsyncWorkError && error.code === "ASYNC_WORK_TERMINAL"
);

for (const timeoutMs of [MIN_TIMEOUT_MS - 1, MAX_TIMEOUT_MS + 1, 1.5, Number.NaN]) {
  assert.throws(
    () => registry.register({ ownerId: "agent-1", taskId: "bad-timeout", kind: "test", desc: "bad", timeoutMs }),
    (error) => error instanceof AsyncWorkError && error.code === "INVALID_ASYNC_WORK_TIMEOUT"
  );
}
assert.throws(
  () => registry.register({ ownerId: "agent-1", kind: "test", desc: "missing task", timeoutMs: MIN_TIMEOUT_MS }),
  (error) => error instanceof AsyncWorkError && error.code === "INVALID_ASYNC_WORK_FIELD"
);

const failed = registry.register({ ownerId: "agent-2", taskId: "task-fail", kind: "test", desc: "失败测试", timeoutMs: MIN_TIMEOUT_MS });
const failedResult = registry.settle("agent-2", failed.work_id, "task-fail", "fail", "外部系统返回错误");
assert.equal(failedResult.status, "failed");
assert.equal(failedResult.reason, "外部系统返回错误");
const cancelled = registry.register({ ownerId: "agent-2", taskId: "task-cancel", kind: "test", desc: "取消测试", timeoutMs: MIN_TIMEOUT_MS });
assert.equal(registry.settle("agent-2", cancelled.work_id, "task-cancel", "cancel").status, "cancelled");
assert.throws(
  () => registry.settle("agent-2", cancelled.work_id, "task-cancel", "cancel", "不应静默丢弃"),
  (error) => error instanceof AsyncWorkError && error.code === "INVALID_ASYNC_WORK_REASON"
);
assert.throws(
  () => registry.settle("agent-2", cancelled.work_id, "task-cancel", "unknown"),
  (error) => error instanceof AsyncWorkError && error.code === "INVALID_ASYNC_WORK_ACTION"
);

const disposed = registry.dispose();
assert.equal(disposed, 1, "dispose 取消剩余 running 工作");
assert.deepEqual(settled.at(-1), {
  ownerId: "agent-1",
  workId: workB.work_id,
  taskId: "task-B",
  kind: "external",
  status: "cancelled",
  reason: "plugin-dispose",
});
disposeSettled();
assert.deepEqual(registry.byOwner.size, 0, "dispose 清空进程范围注册表");
assert.equal(registry.listRecent("agent-1")[0].work_id, workB.work_id, "dispose settlement remains recent");
assert.equal(registry.reap("agent-1"), 0);

// The fixed recent ring is still bounded and expires against the injected clock.
now = Date.parse("2026-08-30T00:00:00.000Z");
let ringSequence = 0;
const ring = new AsyncWorkRegistry({
  clock: () => now,
  idFactory: () => `ring-${++ringSequence}`,
});
for (let i = 0; i < 21; i++) {
  const work = ring.register({ ownerId: "ring-owner", taskId: `ring-${i}`, kind: "test", desc: String(i), timeoutMs: MAX_TIMEOUT_MS });
  ring.settle("ring-owner", work.work_id, `ring-${i}`, "complete");
}
assert.equal(ring.listRecent("ring-owner").length, 20, "recent ring uses the fixed 20-record limit");
assert.equal(ring.listRecent("ring-owner")[0].work_id, "ring-21");
now += 6 * 60 * 60 * 1000;
assert.deepEqual(ring.listRecent("ring-owner"), [], "recent records expire by the fixed six-hour TTL");
ring.dispose();

const listenerErrors = [];
let listenerSequence = 0;
const notifying = new AsyncWorkRegistry({
  clock: () => now,
  idFactory: () => `listener-${++listenerSequence}`,
  onListenerError: (error, listener) => listenerErrors.push({ error, listener }),
});
const syncListener = () => { throw new Error("sync listener failure"); };
const asyncListener = () => Promise.reject(new Error("async listener failure"));
notifying.onSettled(syncListener);
notifying.onSettled(asyncListener);
const notifyingWork = notifying.register({ ownerId: "listener-owner", taskId: "listener-task", timeoutMs: MIN_TIMEOUT_MS });
const notifyingResult = notifying.settle("listener-owner", notifyingWork.work_id, "listener-task", "complete");
assert.equal(notifyingResult.status, "completed", "listener failure does not change settlement result");
assert.equal(listenerErrors.length, 1, "synchronous listener failure is reported");
assert.equal(listenerErrors[0].error.message, "sync listener failure");
await Promise.resolve();
await Promise.resolve();
assert.equal(listenerErrors.length, 2, "async listener rejection is reported");
assert.equal(listenerErrors[1].error.message, "async listener failure");
notifying.dispose();

let serviceModule;
try {
  serviceModule = await import("../lib/index.js");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
if (serviceModule) {
  const { Context } = await import("@deepseek-ai/cordis");
  const ctx = new Context();
  const agentSteers = [];
  const serviceAgent = {
    id: "agent-service",
    steer(message) { agentSteers.push({ method: "steer", message }); },
  };
  const agents = {
    get(ownerId) { return ownerId === serviceAgent.id ? serviceAgent : undefined; },
  };
  const serviceCtx = ctx.extend({ agents });
  const events = [];
  const disposeEvent = serviceCtx.on(serviceModule.ASYNC_WORK_SETTLED_EVENT, (payload) => events.push(payload));
  const service = new serviceModule.AsyncWorkService(serviceCtx, { defaultTimeoutMs: MIN_TIMEOUT_MS });
  const work = service.register({ ownerId: "agent-service", taskId: "task-service", kind: "external", desc: "服务事件", timeoutMs: MIN_TIMEOUT_MS });
  service.complete("agent-service", work.work_id, "task-service");
  assert.deepEqual(events, [{
    ownerId: "agent-service",
    workId: work.work_id,
    taskId: "task-service",
    kind: "external",
    status: "completed",
    reason: null,
  }]);
  assert.equal(agentSteers.length, 1, "settlement steers the owner immediately");
  assert.equal(agentSteers[0].method, "steer");
  assert.equal(agentSteers[0].message.source.plugin, "sagitta-async-work");
  assert.match(agentSteers[0].message.content[0].text, /task_id=task-service/u);
  assert.match(agentSteers[0].message.content[0].text, /status=completed/u);
  assert.ok(agentSteers[0].message.content[0].text.includes(`work_id=${work.work_id}`));
  assert.match(agentSteers[0].message.content[0].text, /kind=external/u);

  const goneWork = service.register({ ownerId: "agent-gone", taskId: "task-gone", kind: "external", desc: "会话已结束", timeoutMs: MIN_TIMEOUT_MS });
  assert.doesNotThrow(() => service.complete("agent-gone", goneWork.work_id, "task-gone"));
  assert.equal(agentSteers.length, 1, "settlement for a missing owner is not delivered");

  const registeredTools = [];
  serviceModule.registerAsyncWorkTools({ tools: { register: (tool) => registeredTools.push(tool) } }, service);
  const settleTool = registeredTools.find((tool) => tool.name === "async_settle");
  assert.ok(settleTool, "async_settle tool is registered");
  for (const [action, expectedStatus] of [["complete", "completed"], ["fail", "failed"], ["cancel", "cancelled"]]) {
    const toolWork = service.register({ ownerId: "tool-owner", taskId: `tool-${action}`, kind: "test", desc: action, timeoutMs: MIN_TIMEOUT_MS });
    const result = await settleTool.execute({
      work_id: toolWork.work_id,
      task_id: `tool-${action}`,
      action,
      ...(action === "fail" ? { reason: "tool failure" } : {}),
    }, { agent: { id: "tool-owner" } });
    assert.equal(result.status, expectedStatus, `async_settle ${action}`);
  }
  assert.equal(service.listRecent("agent-service")[0].work_id, work.work_id, "service exposes recent snapshots");
  disposeEvent();
  service.dispose();
  console.log("async-work service smoke: PASS (settlement event bridge and async_settle tool)");
}

console.log("async-work smoke: PASS (snapshot, lifecycle, async_settle actions, notifications, timeout reap, recent TTL, dispose cleanup)");
