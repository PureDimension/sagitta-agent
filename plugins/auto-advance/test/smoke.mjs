import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutoAdvanceService,
  buildTaskAuthHeaders,
  isLoopbackUrl,
  parseRoundCloseMessage,
  parseRoundCloseText,
  readTasks,
  STOP_MARKER,
  splitCloudTaskSnapshotStrict,
} from "../lib/service.js";

const iso = (minute) => `2026-08-30T00:${String(minute).padStart(2, "0")}:00.000Z`;
function task(id, status, pending_status = null, extra = {}, minute = 20) {
  return {
    id,
    project: "smoke",
    title: id,
    status,
    pending_status,
    blocked_reason: pending_status === "pending_blocked" || status === "blocked" ? "等待外部依赖" : null,
    done_at: status === "done" ? iso(minute) : null,
    confirmation_id: pending_status === null ? null : `cnf-${id}`,
    created_at: iso(minute),
    updated_at: iso(minute),
    archived: 0,
    checkbox: 0,
    ...extra,
  };
}

const cloudItems = [
  task("tsk-open", "open", null, {}, 20),
  task("tsk-running", "in_progress", null, {}, 19),
  task("tsk-pending-done", "in_progress", "pending_done", {}, 18),
  task("tsk-pending-blocked", "in_progress", "pending_blocked", {}, 17),
  task("tsk-waiting", "waiting", null, {}, 16),
  task("tsk-blocked", "blocked", null, {}, 15),
  task("tsk-done", "done", null, {}, 14),
];

const page = (items, pageNumber, total = cloudItems.length, size = items.length || 1) => ({
  total,
  page: pageNumber,
  size,
  has_more: pageNumber * size < total,
  source: "cloud",
  items,
});

// Strict splitter: all four collections, pending invariants, and stable order.
const split = splitCloudTaskSnapshotStrict({ pages: [page(cloudItems.slice(0, 4), 1, 7, 4), page(cloudItems.slice(4), 2, 7, 4)] });
assert.deepEqual(split.runnable.map((item) => item.task_id), ["tsk-open", "tsk-running"]);
assert.deepEqual(split.confirmationQueue.map((item) => item.task_id), ["tsk-pending-done", "tsk-pending-blocked"]);
assert.deepEqual(split.waiting.map((item) => item.task_id), ["tsk-waiting"]);
assert.deepEqual(split.terminal.map((item) => item.task_id), ["tsk-blocked", "tsk-done"]);
assert.equal(split.source, "cloud");
assert.throws(
  () => splitCloudTaskSnapshotStrict({ pages: [page([], 1, 1, 1)] }),
  (error) => error.code === "task-api-unavailable"
);
assert.throws(
  () => splitCloudTaskSnapshotStrict({ pages: [page(cloudItems.slice(0, 4), 1, 7, 4)] }),
  (error) => error.code === "task-api-unavailable"
);
assert.throws(
  () => splitCloudTaskSnapshotStrict({ pages: [page([task("bad", "in_progress", "pending_done", { blocked_reason: "错误" })], 1, 1, 1)] }),
  (error) => error.code === "task-api-unavailable"
);

// Auth and transport policy match memory: Bearer wins; Access-only sends both;
// production direct is rejected while loopback direct is allowed.
assert.deepEqual(buildTaskAuthHeaders({ d1ReadToken: "read", accessClientId: "id", accessClientSecret: "secret" }).Authorization, "Bearer read");
assert.equal(buildTaskAuthHeaders({ accessClientId: "id", accessClientSecret: "secret" }).Authorization, undefined);
assert.equal(buildTaskAuthHeaders({ accessClientId: "id", accessClientSecret: "secret" })["CF-Access-Client-Id"], "id");
assert.equal(isLoopbackUrl("http://127.0.0.1:8787"), true);
assert.equal(isLoopbackUrl("https://worker.example.test"), false);

const received = [];
let responseMode = "runnable";
const server = createServer(async (request, response) => {
  received.push({ url: request.url, authorization: request.headers.authorization, accessId: request.headers["cf-access-client-id"] });
  const requestPage = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("page") || 1);
  const pagedItems = requestPage === 1 ? cloudItems.slice(0, 2) : cloudItems.slice(2, 3);
  const terminalItems = [task("tsk-blocked-final", "blocked", null, { blocked_reason: "等待外部依赖" }, 12), task("tsk-done-final", "done", null, {}, 11)];
  const body = responseMode === "error"
    ? { ok: false, error: { code: "UNAVAILABLE", message: "smoke outage" } }
    : { ok: true, data: responseMode === "paged"
      ? page(pagedItems, requestPage, 3, 2)
      : page(responseMode === "terminal" ? terminalItems : responseMode === "confirmation" ? cloudItems.slice(2, 3) : responseMode === "empty" ? [] : responseMode === "runnable-many" ? cloudItems.slice(0, 2) : cloudItems.slice(0, 1), 1, responseMode === "terminal" ? terminalItems.length : responseMode === "empty" ? 0 : responseMode === "runnable-many" ? 2 : 1, 200) };
  response.writeHead(responseMode === "error" ? 503 : 200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const workerUrl = `http://127.0.0.1:${server.address().port}`;

function makeHarness({ api = true, works = [], pageSize = 200, auth = "bearer" } = {}) {
  const agent = {
    id: "agent-smoke",
    status: "idle",
    inbox: { nextStep: [], nextTurn: [] },
    followups: [],
    followup(message) { this.followups.push(message); },
  };
  const events = [];
  const ctx = {
    fiber: { state: 2 },
    agents: {
      list: () => [agent],
      get: (id) => id === agent.id ? agent : undefined,
      isOwnedBy: () => false,
    },
    get: (name) => name === "sagitta-async-work" ? {
      listActive: (_ownerId, filter = {}) => works.filter((work) => filter.taskId === undefined || (work.task_id ?? work.taskId) === filter.taskId),
    } : undefined,
    logger: { warn() {}, debug() {} },
    emit: (_event, payload) => events.push(payload),
  };
  const service = Object.create(AutoAdvanceService.prototype);
  service.ctx = ctx;
  service.config = {
    tasksPath: join(tmpdir(), "sagitta-auto-advance-smoke-TASKS.md"),
    taskApiTimeoutMs: 1000,
    taskPageSize: pageSize,
    proxy: "direct",
    statePath: join(tmpdir(), "sagitta-auto-advance-smoke-state.json"),
    apiConfig: api ? auth === "access"
      ? { workerApiUrl: workerUrl, accessClientId: "smoke-access-id", accessClientSecret: "smoke-access-secret" }
      : { workerApiUrl: workerUrl, d1ReadToken: "smoke-token" } : {},
    manager: undefined,
    managerApiConfig: {},
  };
  service.persistedModes = new Map();
  service.persistModes = () => {};
  service.broadcast = (_state, reason) => events.push({ reason });
  return { service, state: { agent, enabled: true, stoppedByProtocol: false, disposed: false, timer: undefined, timerGeneration: 1, idleSince: null, injectedAt: null, lastAutoMessageId: undefined, requestController: undefined, retryAttempt: 0, retrying: false, degraded: false, degradedReason: null, cloudSnapshot: undefined }, agent, events };
}

try {
  // Runnable branch injects a prompt containing the cloud task id.
  responseMode = "runnable";
  const runnableHarness = makeHarness();
  await runnableHarness.service.onTimer(runnableHarness.state, 1);
  assert.equal(runnableHarness.agent.followups.length, 1);
  assert.match(runnableHarness.agent.followups[0].content[0].text, /tsk-open/u);
  assert.match(runnableHarness.agent.followups[0].content[0].text, /task_round_close/u);
  assert.match(runnableHarness.agent.followups[0].content[0].text, /task_confirm/u);
  assert.deepEqual(runnableHarness.state.activeRound.taskIds, ["tsk-open"]);
  assert.equal(received.at(-1).authorization, "Bearer smoke-token");

  // Access-only is sent identically to memory's task transport.
  const accessHarness = makeHarness({ auth: "access" });
  await accessHarness.service.onTimer(accessHarness.state, 1);
  assert.equal(accessHarness.agent.followups.length, 1);
  assert.equal(received.at(-1).authorization, undefined);
  assert.equal(received.at(-1).accessId, "smoke-access-id");

  // A valid multi-page response is fetched completely before injection.
  responseMode = "paged";
  const pagedHarness = makeHarness({ pageSize: 2 });
  await pagedHarness.service.onTimer(pagedHarness.state, 1);
  assert.equal(pagedHarness.agent.followups.length, 1);
  assert.equal(received.filter((entry) => entry.url.includes("page=")).length >= 2, true);

  // A bounded work item for task A does not block independent task B.
  responseMode = "runnable-many";
  const isolatedHarness = makeHarness({ works: [{ task_id: "tsk-open", status: "running" }] });
  await isolatedHarness.service.onTimer(isolatedHarness.state, 1);
  assert.equal(isolatedHarness.agent.followups.length, 1);
  assert.doesNotMatch(isolatedHarness.agent.followups[0].content[0].text, /tsk-open/u);
  assert.match(isolatedHarness.agent.followups[0].content[0].text, /tsk-running/u);

  // Confirmation takes priority over runnable work and carries all replay keys.
  responseMode = "confirmation";
  const confirmationHarness = makeHarness();
  await confirmationHarness.service.onTimer(confirmationHarness.state, 1);
  assert.equal(confirmationHarness.agent.followups.length, 1);
  assert.match(confirmationHarness.agent.followups[0].content[0].text, /task_id=tsk-pending-done/u);
  assert.match(confirmationHarness.agent.followups[0].content[0].text, /confirmation_id=cnf-tsk-pending-done/u);
  assert.match(confirmationHarness.agent.followups[0].content[0].text, /expected_updated_at=/u);
  assert.match(confirmationHarness.agent.followups[0].content[0].text, /decision 只能是 accept 或 reopen/u);

  // A valid empty cloud snapshot is the only path that auto-stops.
  responseMode = "empty";
  const emptyHarness = makeHarness();
  await emptyHarness.service.onTimer(emptyHarness.state, 1);
  assert.equal(emptyHarness.agent.followups.length, 0);
  assert.equal(emptyHarness.state.enabled, false);
  assert.ok(emptyHarness.events.some((event) => event.reason === "autostop: no-runnable-tasks"));

  // Cloud error is degraded/deferred, never injected or stopped; retry is armed.
  responseMode = "error";
  const errorHarness = makeHarness();
  await errorHarness.service.onTimer(errorHarness.state, 1);
  assert.equal(errorHarness.agent.followups.length, 0);
  assert.equal(errorHarness.state.enabled, true);
  assert.equal(errorHarness.state.degraded, true);
  assert.ok(errorHarness.state.timer !== undefined);
  assert.ok(errorHarness.events.some((event) => event.reason === "defer: task-api-unavailable"));
  errorHarness.service.clearTimer(errorHarness.state);

  // Strict qualification has no file fallback path, even when TASKS.md exists.
  const strictNoApiHarness = makeHarness({ api: false });
  await strictNoApiHarness.service.onTimer(strictNoApiHarness.state, 1);
  assert.equal(strictNoApiHarness.agent.followups.length, 0);
  assert.equal(strictNoApiHarness.state.enabled, true);
  assert.ok(strictNoApiHarness.events.some((event) => event.reason === "defer: task-api-unavailable"));
  strictNoApiHarness.service.clearTimer(strictNoApiHarness.state);

  // Generation invalidation during fetch prevents a late response from queueing.
  responseMode = "runnable";
  const raceHarness = makeHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return await originalFetch(...args);
  };
  const pendingRead = raceHarness.service.onTimer(raceHarness.state, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  raceHarness.service.clearTimer(raceHarness.state);
  await pendingRead;
  globalThis.fetch = originalFetch;
  assert.equal(raceHarness.agent.followups.length, 0);

  // UI fallback is explicitly stale and is never used by the strict reader.
  const directory = mkdtempSync(join(tmpdir(), "sagitta-auto-advance-smoke-"));
  const tasksPath = join(directory, "TASKS.md");
  writeFileSync(tasksPath, "# Tasks\n- [ ] UI-only stale task\n", "utf8");
  const staleHarness = makeHarness({ api: false });
  staleHarness.service.config.tasksPath = tasksPath;
  const stale = await staleHarness.service.getTasks();
  assert.equal(stale.source, "file-stale");
  assert.match(stale.error, /task-api-unavailable/u);
  rmSync(directory, { recursive: true, force: true });
  assert.ok(received.length >= 5);
  console.log("auto-advance smoke: PASS (strict split/pagination, runnable+confirmation+empty branches, cloud defer/backoff, generation race, stale UI fallback, auth/policy)");
} finally {
  server.close();
}

// Stage 5 protocol parser and stop semantics are pure/local and run after the
// transport server is closed so they cannot accidentally hide network errors.
const validClose = {
  task_id: "tsk-open",
  action: "update",
  progress: "完成一项可验证推进",
  next: "继续下一步实现",
  round_id: "round-smoke-1",
};
assert.deepEqual(parseRoundCloseText(JSON.stringify(validClose)), validClose);
assert.deepEqual(parseRoundCloseText(`\`\`\`json\n${JSON.stringify(validClose)}\n\`\`\``), validClose);
for (const invalid of [
  "完成了，下一步继续",
  `${JSON.stringify(validClose)}${JSON.stringify(validClose)}`,
  JSON.stringify({ ...validClose, next: undefined }),
  JSON.stringify({ ...validClose, action: "unknown" }),
  JSON.stringify({ ...validClose, action: "done" }),
  JSON.stringify({ ...validClose, action: "blocked", blocked_reason: "" }),
  `前言\n${JSON.stringify(validClose)}`,
]) {
  assert.throws(() => parseRoundCloseText(invalid), (error) => error.code === "close-protocol-error");
}
assert.deepEqual(
  parseRoundCloseMessage({
    role: "assistant",
    content: [
      { type: "text", text: "旁边的文本不是协议" },
      { type: "tool-call", name: "task_round_close", arguments: validClose },
    ],
  }),
  { kind: "tool", payload: validClose },
);

function protocolHarness() {
  const agent = {
    id: "agent-protocol",
    status: "idle",
    inbox: { nextStep: [], nextTurn: [] },
    followups: [],
    followup(message) { this.followups.push(message); },
  };
  const events = [];
  const service = Object.create(AutoAdvanceService.prototype);
  service.ctx = {
    fiber: { state: 2 },
    agents: { get: (id) => id === agent.id ? agent : undefined, list: () => [agent], isOwnedBy: () => false },
    logger: { warn() {}, debug() {} },
    emit: (_event, payload) => events.push(payload),
  };
  service.persistedModes = new Map();
  service.persistModes = () => {};
  service.broadcast = (_state, reason) => events.push({ reason });
  return {
    service,
    state: {
      agent,
      enabled: true,
      stoppedByProtocol: false,
      disposed: false,
      timer: undefined,
      timerGeneration: 1,
      idleSince: null,
      injectedAt: null,
      lastAutoMessageId: undefined,
      requestController: undefined,
      retryAttempt: 0,
      retrying: false,
      degraded: false,
      degradedReason: null,
      cloudSnapshot: split,
      activeRound: {
        kind: "runnable",
        taskIds: ["tsk-open"],
        closePayload: undefined,
        protocolFailures: 0,
        repairPromptSent: false,
      },
      lastProtocolNotice: null,
    },
    events,
  };
}

const strictHarness = protocolHarness();
const strictResult = await strictHarness.service.handleAssistantMessage(strictHarness.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_round_close", arguments: validClose }],
});
assert.equal(strictResult.ok, true);
assert.deepEqual(strictHarness.state.activeRound.closePayload, validClose);
await strictHarness.service.handleAssistantMessage(strictHarness.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_round_close", arguments: validClose }],
});
assert.ok(strictHarness.events.some((event) => event.reason === "round-close: idempotent-replay"));
await strictHarness.service.handleAssistantMessage(strictHarness.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_round_close", arguments: { ...validClose, progress: "不同内容" } }],
});
assert.equal(strictHarness.state.activeRound.closePayload.progress, validClose.progress);

const textHarness = protocolHarness();
textHarness.service.submitTextRoundClose = async (_state, payload) => payload;
const textResult = await textHarness.service.handleAssistantMessage(textHarness.state, {
  role: "assistant",
  content: [{ type: "text", text: JSON.stringify(validClose) }],
});
assert.equal(textResult.ok, true);
assert.equal(textHarness.state.activeRound.closeSource, "text");

const malformedHarness = protocolHarness();
await malformedHarness.service.handleAssistantMessage(malformedHarness.state, {
  role: "assistant",
  content: [{ type: "text", text: "这不是唯一 JSON 收尾" }],
});
assert.equal(malformedHarness.state.activeRound.repairPromptSent, true);
assert.equal(malformedHarness.state.activeRound.closePayload, undefined);
assert.equal(malformedHarness.events.filter((event) => event.reason === "close-protocol-error").length, 1);
const followupsAfterRepair = malformedHarness.state.agent.followups.length;
await malformedHarness.service.handleAssistantMessage(malformedHarness.state, {
  role: "assistant",
  content: [{ type: "text", text: "仍然不是 JSON" }],
});
assert.equal(malformedHarness.state.activeRound, undefined);
assert.equal(malformedHarness.state.agent.followups.length, followupsAfterRepair);

const unclosedHarness = protocolHarness();
const unclosedResult = unclosedHarness.service.stopByProtocol(unclosedHarness.state);
assert.equal(unclosedResult, false);
assert.equal(unclosedHarness.state.enabled, true);
assert.equal(unclosedHarness.state.lastProtocolNotice, "未收尾停止");
const markerHarness = protocolHarness();
await markerHarness.service.handleAssistantMessage(markerHarness.state, { role: "assistant", content: [{ type: "text", text: STOP_MARKER }] });
assert.equal(markerHarness.state.enabled, true);
assert.equal(markerHarness.state.lastProtocolNotice, "未收尾停止");

const unfinishedHarness = protocolHarness();
unfinishedHarness.state.activeRound.closePayload = validClose;
assert.equal(unfinishedHarness.service.stopByProtocol(unfinishedHarness.state), false);
assert.equal(unfinishedHarness.state.enabled, true);
assert.equal(unfinishedHarness.state.lastProtocolNotice, "仍有未完成任务；停止自主推进不合法");

const terminalHarness = protocolHarness();
terminalHarness.state.activeRound.requireClose = false;
terminalHarness.state.cloudSnapshot = splitCloudTaskSnapshotStrict({
  pages: [page([task("tsk-blocked-final", "blocked", null, { blocked_reason: "等待外部依赖" }, 12), task("tsk-done-final", "done", null, {}, 11)], 1, 2, 200)],
});
assert.equal(terminalHarness.service.stopByProtocol(terminalHarness.state), true);
assert.equal(terminalHarness.state.enabled, false);
assert.equal(terminalHarness.state.stoppedByProtocol, true);
console.log("auto-advance stage5 protocol smoke: PASS (prompt contract, tool priority, JSON/fenced parser, repair cap, unclosed stop, terminal stop guard)");
