import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutoAdvanceService,
  AUTONOMOUS_PROMPT,
  IN_PERSON_CHALLENGE,
  AUTONOMOUS_CHALLENGE,
  AUTONOMOUS_TURN_END_CHALLENGE,
  TASK_RECHECK_DELAY_MS,
  normalizeConfig,
  buildTaskAuthHeaders,
  isLoopbackUrl,
  hasOpenNeedHuman,
  mapApiTaskSnapshot,
  splitCloudTaskSnapshotStrict,
} from "../lib/service.js";

const iso = (minute) => `2026-08-30T00:${String(minute).padStart(2, "0")}:00.000Z`;
function task(id, status, pending_status = null, extra = {}, minute = 20) {
  return {
    id,
    project: "smoke",
    title: id,
    acceptance: "- [ ] target one\n- [x] target two",
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

// Snapshot qualification remains strict, while v2 driving uses ownership
// separately: an explicit mine task is not confused with an open task to claim.
const split = splitCloudTaskSnapshotStrict({
  pages: [{
    total: 4, page: 1, size: 200, has_more: false, source: "cloud",
    items: [
      task("tsk-open", "open", null, { claim_state: "unclaimed" }, 20),
      task("tsk-mine", "in_progress", null, { claim_state: "mine" }, 19),
      task("tsk-other", "in_progress", null, { claim_state: "claimed" }, 18),
      task("tsk-done", "done", null, {}, 17),
    ],
  }],
});
assert.deepEqual(split.runnable.map((item) => item.task_id), ["tsk-open", "tsk-mine"]);
assert.deepEqual(split.terminal.map((item) => item.task_id), ["tsk-done"]);
assert.equal(split.source, "cloud");
assert.throws(
  () => splitCloudTaskSnapshotStrict({ pages: [{ total: 1, page: 1, size: 200, has_more: false, source: "cloud", items: [] }] }),
  (error) => error.code === "task-api-unavailable"
);
assert.equal(buildTaskAuthHeaders({ d1ReadToken: "read", accessClientId: "id", accessClientSecret: "secret" }).Authorization, "Bearer read");
assert.equal(buildTaskAuthHeaders({ accessClientId: "id", accessClientSecret: "secret" }).Authorization, undefined);
assert.equal(isLoopbackUrl("http://127.0.0.1:8787"), true);
assert.equal(isLoopbackUrl("https://worker.example.test"), false);
assert.doesNotMatch(AUTONOMOUS_PROMPT, /round[_-]?close/iu);
assert.equal(normalizeConfig({
  statePath: join(tmpdir(), "sagitta-auto-advance-default-state.json"),
  tasksPath: join(tmpdir(), "sagitta-auto-advance-default-TASKS.md"),
}).idleTimeoutMs, 15000);
assert.equal(TASK_RECHECK_DELAY_MS, 30000, "pending/running recheck remains quieter than the 15s idle probe");
assert.equal(hasOpenNeedHuman({ need_humans: [{ type: "notify", status: "open" }] }), false);
assert.equal(hasOpenNeedHuman({ need_humans: [{ type: "need", status: "open" }] }), true);
assert.equal(hasOpenNeedHuman({ open_need_human: true, open_need_human_type: "notify" }), false);
const mappedNotifyOnly = mapApiTaskSnapshot([
  task("tsk-notify-only", "in_progress", null, {
    open_need_human: true,
    need_humans: [{ type: "notify", status: "open" }],
  }),
], "smoke-TASKS.md");
assert.equal(mappedNotifyOnly.sections[0].items[0].open_need_human, false);

let responseMode = "owned";
const resolvedRequests = [];
const blockedRequests = [];
const taskReadAgentIds = [];
const pendingNeedHumans = [
  {
    id: "nh-notify",
    type: "notify",
    content: "部署已完成，可开始验证",
    task_id: "tsk-mine",
    task_title: "部署 Sagitta",
    task_project: "smoke",
    suggestion: "请在浏览器打开验收页",
    status: "open",
    created_at: iso(22),
  },
  {
    id: "nh-need",
    type: "need",
    content: "请确认发布窗口",
    task_id: "tsk-mine",
    task_title: "部署 Sagitta",
    task_project: "smoke",
    status: "open",
    created_at: iso(21),
  },
];
const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/task") {
    taskReadAgentIds.push(request.headers["x-agent-id"] ?? null);
  }
  const resolveMatch = /^\/task\/need-human\/([^/]+)\/resolve$/u.exec(requestUrl.pathname);
  if (request.method === "POST" && resolveMatch !== null) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    resolvedRequests.push({ id: decodeURIComponent(resolveMatch[1]), body, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: {
      id: decodeURIComponent(resolveMatch[1]), task_id: "tsk-mine", type: "notify", status: "resolved",
    } }));
    return;
  }
  const patchMatch = /^\/task\/([^/]+)$/u.exec(requestUrl.pathname);
  if (request.method === "PATCH" && patchMatch !== null) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    blockedRequests.push({
      id: decodeURIComponent(patchMatch[1]),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      authorization: request.headers.authorization,
      agentId: request.headers["x-agent-id"] ?? null,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: { ok: true } }));
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/need-human") {
    const items = pendingNeedHumans.filter((item) => !resolvedRequests.some((resolved) => resolved.id === item.id));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: { items, total: items.length, status: "open", source: "cloud" } }));
    return;
  }
  const modes = {
    owned: [task("tsk-mine", "in_progress", null, { claim_state: "mine" }, 20)],
    open: [task("tsk-open", "open", null, { claim_state: "unclaimed" }, 20)],
    empty: [task("tsk-done", "done", null, {}, 20), task("tsk-blocked", "blocked", null, {}, 19)],
    need: [task("tsk-mine", "in_progress", null, {
      claim_state: "mine",
      need_humans: [{ id: "nh-need", type: "need", status: "open" }],
      body: "need 之外仍有可自主推进工作",
    }, 20)],
    pending: [task("tsk-mine", "in_progress", "pending_blocked", { claim_state: "mine" }, 20)],
    error: null,
  };
  const items = modes[responseMode];
  if (items === null) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: { code: "UNAVAILABLE", message: "smoke outage" } }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, data: {
    total: items.length, page: 1, size: 200, has_more: false, source: "cloud", items,
  } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const workerUrl = `http://127.0.0.1:${server.address().port}`;

function makeHarness({ api = true, runningWork = false, enabled = true } = {}) {
  const agent = {
    id: "agent-smoke",
    status: "idle",
    inbox: { nextStep: [], nextTurn: [] },
    followups: [],
    followup(message) { this.followups.push(message); },
  };
  const events = [];
  const asyncWork = { listActive: () => runningWork ? [{ status: "running", task_id: "tsk-work" }] : [] };
  const ctx = {
    fiber: { state: 2 },
    agents: {
      list: () => [agent],
      get: (id) => id === agent.id ? agent : undefined,
      isOwnedBy: () => false,
    },
    get: (name) => name === "sagitta-async-work" ? asyncWork : undefined,
    logger: { warn() {}, debug() {} },
    emit: (_event, payload) => events.push(payload),
  };
  const service = Object.create(AutoAdvanceService.prototype);
  service.ctx = ctx;
  service.config = {
    tasksPath: join(tmpdir(), "sagitta-auto-advance-smoke-TASKS.md"),
    taskApiTimeoutMs: 1000,
    taskPageSize: 200,
    proxy: "direct",
    statePath: join(tmpdir(), "sagitta-auto-advance-smoke-state.json"),
    apiConfig: api ? { workerApiUrl: workerUrl, d1ReadToken: "smoke-token", d1WriteToken: "smoke-write-token" } : {},
    manager: undefined,
    managerApiConfig: {},
    idleTimeoutMs: 1000,
  };
  service.persistedModes = new Map();
  service.listeners = new Set();
  service.persistModes = () => {};
  service.broadcast = (_state, reason) => events.push({ reason });
  const state = {
      agent,
      enabled,
      stoppedByProtocol: false,
      disposed: false,
      timer: undefined,
      timerGeneration: 1,
      idleSince: null,
      injectedAt: null,
      lastAutoMessageId: undefined,
      pendingAutoMode: undefined,
      autonomousMode: false,
      settledWorkIds: new Set(),
      pendingSettlements: new Map(),
      ownedTaskIds: new Set(),
      requestController: undefined,
      retryAttempt: 0,
      retrying: false,
      degraded: false,
      degradedReason: null,
      cloudSnapshot: undefined,
      lastProtocolNotice: null,
  };
  service.states = new Map([[agent, state]]);
  return {
    service,
    state,
    agent,
    ctx,
    events,
  };
}

// Settlement is a basic wake-up even when autonomous mode is disabled. The
// notice carries the settled work identity and is idempotent per work.
const chatSettleHarness = makeHarness({ api: false, enabled: false });
let chatSettleResetCount = 0;
chatSettleHarness.service.resetTimer = (_state, reason) => {
  chatSettleResetCount++;
  assert.equal(reason, "async-work-settled");
};
const completedWork = {
  ownerId: "agent-smoke",
  workId: "work-settled",
  taskId: "task-settled",
  kind: "codex",
  status: "completed",
  reason: null,
};
chatSettleHarness.state.autonomousMode = true;
assert.equal(chatSettleHarness.service.handleAsyncWorkSettled(completedWork), true);
assert.equal(chatSettleHarness.agent.followups.length, 1, "disabled autonomous mode must still receive settlement notice");
assert.match(chatSettleHarness.agent.followups[0].content[0].text, /异步任务已完成/u);
assert.match(chatSettleHarness.agent.followups[0].content[0].text, /work_id=work-settled/u);
assert.match(chatSettleHarness.agent.followups[0].content[0].text, /task_id=task-settled/u);
assert.match(chatSettleHarness.agent.followups[0].content[0].text, /status=completed/u);
assert.match(chatSettleHarness.agent.followups[0].content[0].text, /kind=codex/u);
assert.equal(chatSettleHarness.service.handleAsyncWorkSettled(completedWork), false, "the same work must not notify twice");
assert.equal(chatSettleHarness.agent.followups.length, 1);
assert.equal(chatSettleResetCount, 1);

// An enabled settlement keeps the existing full onTimer path and must not
// produce a second lightweight notice for the same work.
const autoSettleHarness = makeHarness({ api: false, enabled: true });
let autoSettleChecks = 0;
autoSettleHarness.service.resetTimer = (_state, reason) => {
  assert.equal(reason, "async-work-settled");
  autoSettleHarness.state.timerGeneration += 1;
};
autoSettleHarness.service.onTimer = (_state, generation) => {
  autoSettleChecks++;
  assert.equal(generation, autoSettleHarness.state.timerGeneration);
};
assert.equal(autoSettleHarness.service.handleAsyncWorkSettled(completedWork), true);
assert.equal(autoSettleChecks, 1, "enabled settlement must check immediately, without idleTimeout");
assert.equal(autoSettleHarness.agent.followups.length, 0, "enabled settlement must use only the full path");
assert.equal(autoSettleHarness.service.handleAsyncWorkSettled(completedWork), false);
assert.equal(autoSettleChecks, 1, "enabled settlement must be idempotent");

// A settlement racing a running turn is deferred without injecting into that
// turn; the pending work is delivered once the agent becomes idle.
const runningSettleHarness = makeHarness({ api: false, enabled: false });
let runningSettleResetCount = 0;
runningSettleHarness.service.resetTimer = (_state, reason) => {
  runningSettleResetCount++;
  assert.equal(reason, "async-work-settled");
};
const runningWorkSettlement = { ownerId: "agent-smoke", workId: "work-running", taskId: "task-running", status: "completed" };
runningSettleHarness.agent.status = "running";
assert.equal(runningSettleHarness.service.handleAsyncWorkSettled(runningWorkSettlement), false);
assert.equal(runningSettleHarness.agent.followups.length, 0, "running agent must not be interrupted by settlement");
assert.equal(runningSettleResetCount, 1, "running settlement must reset the timer for the next idle check");
runningSettleHarness.agent.status = "idle";
assert.equal(runningSettleHarness.service.flushPendingAsyncWorkSettled(runningSettleHarness.state), true);
assert.equal(runningSettleHarness.agent.followups.length, 1, "deferred settlement must wake the next idle turn");

const inFlightSettleHarness = makeHarness({ api: false, enabled: false });
inFlightSettleHarness.state.requestController = {};
assert.equal(inFlightSettleHarness.service.handleAsyncWorkSettled({
  ownerId: "agent-smoke",
  workId: "work-in-flight",
  taskId: "task-in-flight",
  status: "completed",
}), false);
assert.equal(inFlightSettleHarness.agent.followups.length, 0, "settlement must not inject while a request is in flight");
inFlightSettleHarness.state.disposed = true;
inFlightSettleHarness.state.requestController = undefined;
assert.equal(inFlightSettleHarness.service.handleAsyncWorkSettled({ ownerId: "agent-smoke", workId: "work-disposed", status: "completed" }), false);

try {
  // 有已认领 in_progress 才注入自主推进；提示只带轻量任务清单，取消 round-close 强制。
  responseMode = "owned";
  const ownedHarness = makeHarness();
  const pendingSnapshot = await ownedHarness.service.getTasks();
  assert.equal(taskReadAgentIds.at(-1), "agent-smoke", "UI task read must use the selected session id");
  assert.deepEqual(pendingSnapshot.pendingRequests.map((item) => item.type), ["notify", "need"]);
  assert.equal(pendingSnapshot.pendingRequests[0].needHumanId, "nh-notify");
  const resolvedNotify = await ownedHarness.service.resolveNeedHuman("nh-notify");
  assert.deepEqual(resolvedNotify, { needHumanId: "nh-notify", taskId: "tsk-mine", type: "notify", status: "resolved" });
  assert.deepEqual(resolvedRequests[0], {
    id: "nh-notify",
    body: { resolve_kind: "solved", resolved_by: "ripple" },
    authorization: "Bearer smoke-write-token",
  });
  const refreshedPendingSnapshot = await ownedHarness.service.getTasks();
  assert.deepEqual(refreshedPendingSnapshot.pendingRequests.map((item) => item.type), ["need"]);
  await ownedHarness.service.onTimer(ownedHarness.state, 1);
  assert.equal(taskReadAgentIds.at(-1), "agent-smoke", "auto-advance qualification read must use state.agent.id");
  assert.equal(ownedHarness.agent.followups.length, 1);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /涟漪已离开/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /tsk-mine/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /当前我认领的 in_progress 任务/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /acceptance=2项\/未完成1/u);
  assert.doesNotMatch(ownedHarness.agent.followups[0].content[0].text, /task_round_close|round-close/iu);
  assert.equal(ownedHarness.state.pendingAutoMode, "away");

  // Worker v2 的 mine 投影直接驱动所有权判断；claimed 任务不能混入自己的清单。
  const ownershipHarness = makeHarness({ api: false });
  const mineTask = task("tsk-owned-by-me", "in_progress", null, { claim_state: "mine" });
  const otherTask = task("tsk-owned-by-other", "in_progress", null, { claim_state: "claimed" });
  const ownershipSnapshot = { items: [mineTask, otherTask] };
  assert.equal(ownershipHarness.service.isOwnedTask(ownershipHarness.state, mineTask), true);
  assert.equal(ownershipHarness.service.isOwnedTask(ownershipHarness.state, otherTask), false);
  assert.deepEqual(
    ownershipHarness.service.ownedInProgressTasks(ownershipHarness.state, ownershipSnapshot).map((item) => item.id),
    ["tsk-owned-by-me"]
  );
  ownershipHarness.service.syncOwnedTasks(ownershipHarness.state, ownershipSnapshot);
  assert.deepEqual([...ownershipHarness.state.ownedTaskIds], ["tsk-owned-by-me"]);

  // 没有 in_progress 但有 open：只提示认领，不注入自主大 prompt，也不熄火。
  responseMode = "open";
  const openHarness = makeHarness();
  await openHarness.service.onTimer(openHarness.state, 1);
  assert.equal(openHarness.agent.followups.length, 1);
  assert.match(openHarness.agent.followups[0].content[0].text, /有 1 个任务可认领/u);
  assert.doesNotMatch(openHarness.agent.followups[0].content[0].text, /涟漪已离开/u);
  assert.equal(openHarness.state.enabled, true);

  // 全部终态：自动熄火；没有 in_progress 的云端快照不会继续轮询。
  responseMode = "empty";
  const emptyHarness = makeHarness();
  await emptyHarness.service.onTimer(emptyHarness.state, 1);
  assert.equal(emptyHarness.agent.followups.length, 0);
  assert.equal(emptyHarness.state.enabled, false);
  assert.ok(emptyHarness.events.some((event) => event.reason === "autostop: no-in-progress"));

  // 有 open need-human 但没有 pending/有界工作时，继续注入，让模型推进 need 之外的工作。
  responseMode = "need";
  const needHarness = makeHarness();
  await needHarness.service.onTimer(needHarness.state, 1);
  assert.ok(needHarness.agent.followups.length > 0);
  assert.match(needHarness.agent.followups[0].content[0].text, /涟漪已离开/u);
  assert.match(needHarness.agent.followups[0].content[0].text, /无可推进/u);
  assert.match(needHarness.agent.followups[0].content[0].text, /need 之外部分继续推进/u);
  assert.equal(needHarness.state.enabled, true);
  assert.equal(needHarness.state.pendingAutoMode, "away");

  // 有 pending 申请时仍静默等待确认，不重复注入。
  responseMode = "pending";
  const pendingHarness = makeHarness();
  await pendingHarness.service.onTimer(pendingHarness.state, 1);
  assert.equal(pendingHarness.agent.followups.length, 0);
  pendingHarness.service.clearTimer(pendingHarness.state);

  // 云端不可用时 fail closed：不注入、不误熄火，只降级重试。
  responseMode = "error";
  const errorHarness = makeHarness();
  await errorHarness.service.onTimer(errorHarness.state, 1);
  assert.equal(errorHarness.agent.followups.length, 0);
  assert.equal(errorHarness.state.enabled, true);
  assert.equal(errorHarness.state.degraded, true);
  assert.ok(errorHarness.state.timer !== undefined);
  errorHarness.service.clearTimer(errorHarness.state);

  // 严格资格判断没有 TASKS.md 文件兜底。
  const noApiHarness = makeHarness({ api: false });
  await noApiHarness.service.onTimer(noApiHarness.state, 1);
  assert.equal(noApiHarness.agent.followups.length, 0);
  assert.equal(noApiHarness.state.enabled, true);
  noApiHarness.service.clearTimer(noApiHarness.state);

  // UI 的旧文件只作为 stale 展示来源，不能参与自动推进资格。
  const directory = mkdtempSync(join(tmpdir(), "sagitta-auto-advance-smoke-"));
  const tasksPath = join(directory, "TASKS.md");
  writeFileSync(tasksPath, "# Tasks\n- [ ] UI-only stale task\n", "utf8");
  const staleHarness = makeHarness({ api: false });
  staleHarness.service.config.tasksPath = tasksPath;
  const stale = await staleHarness.service.getTasks();
  assert.equal(stale.source, "file-stale");
  assert.match(stale.error, /task-api-unavailable/u);
  const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(clientSource, /📢 待你确认/u);
  assert.match(clientSource, /remoteApi\.resolveNeedHuman/u);
  assert.match(clientSource, /await refresh\(true\)/u);
  rmSync(directory, { recursive: true, force: true });

  // 模拟 DSH 的 process SIGINT/SIGTERM → fiber.dispose：当前快照中的 owned
  // in_progress 任务并行 PATCH blocked，携带写 token 与 session agent id。
  responseMode = "owned";
  const shutdownHarness = makeHarness();
  shutdownHarness.state.cloudSnapshot = splitCloudTaskSnapshotStrict({
    pages: [{
      total: 3, page: 1, size: 200, has_more: false, source: "cloud",
      items: [
        task("tsk-shutdown-a", "in_progress", null, { claim_state: "mine" }),
        task("tsk-shutdown-b", "in_progress", null, { claim_state: "mine" }, 19),
        task("tsk-shutdown-done", "done", null, {}, 18),
      ],
    }],
  });
  assert.deepEqual(shutdownHarness.service.ownedInProgressTasks(shutdownHarness.state, shutdownHarness.state.cloudSnapshot).map((item) => item.task_id), ["tsk-shutdown-a", "tsk-shutdown-b"]);
  assert.equal(shutdownHarness.service.resolveTaskApiConfig().workerApiUrl, workerUrl);
  assert.equal(shutdownHarness.service.resolveTaskApiConfig().d1WriteToken, "smoke-write-token");
  shutdownHarness.service.processShutdownRequested = true;
  await shutdownHarness.service.blockOwnedTasksOnProcessShutdown();
  assert.deepEqual(blockedRequests.slice(-2).sort((first, second) => first.id.localeCompare(second.id)), [
    {
      id: "tsk-shutdown-a",
      body: { status: "blocked", blocked_reason: "sagitta 进程中断退出" },
      authorization: "Bearer smoke-write-token",
      agentId: "agent-smoke",
    },
    {
      id: "tsk-shutdown-b",
      body: { status: "blocked", blocked_reason: "sagitta 进程中断退出" },
      authorization: "Bearer smoke-write-token",
      agentId: "agent-smoke",
    },
  ]);

  const normalDisposeHarness = makeHarness();
  normalDisposeHarness.state.cloudSnapshot = shutdownHarness.state.cloudSnapshot;
  normalDisposeHarness.service.processShutdownRequested = false;
  await normalDisposeHarness.service.disposeLifecycle();
  assert.equal(blockedRequests.length, 2, "normal plugin disposal must not mark tasks blocked");

  const normalStopHarness = makeHarness({ api: false });
  normalStopHarness.state.cloudSnapshot = splitCloudTaskSnapshotStrict({
    pages: [{
      total: 1, page: 1, size: 200, has_more: false, source: "cloud",
      items: [task("tsk-stop-done", "done", null, {}, 18)],
    }],
  });
  assert.equal(normalStopHarness.service.stopByProtocol(normalStopHarness.state), true);
  assert.equal(blockedRequests.length, 2, "stopByProtocol must not mark tasks blocked");

  console.log("auto-advance smoke: PASS (need/notify mapping, notify resolve POST + refresh, task-driven branches, cloud defer, stale UI fallback)");
} finally {
  server.close();
}

function challengeHarness(autonomousMode, { pendingStatus = null, runningWork = false } = {}) {
  const harness = makeHarness({ api: false, runningWork });
  harness.state.autonomousMode = autonomousMode;
  harness.state.cloudSnapshot = splitCloudTaskSnapshotStrict({
    pages: [{
      total: 2, page: 1, size: 200, has_more: false, source: "cloud",
      items: [
        task("tsk-work", "in_progress", pendingStatus, { claim_state: "mine" }),
        task("tsk-temp", "in_progress", null, { claim_state: "mine", type: "temp" }),
      ],
    }],
  });
  return harness;
}

// 在场/离开两态质询，且 temp 任务直接豁免。
const present = challengeHarness(false);
const presentResult = await present.service.handleAssistantMessage(present.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_update", arguments: { task_id: "tsk-work", status: "done" } }],
});
assert.equal(presentResult.challenged, true);
assert.ok(present.agent.followups[0].content[0].text.includes(IN_PERSON_CHALLENGE));

const away = challengeHarness(true);
const awayResult = await away.service.handleAssistantMessage(away.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_update", arguments: { task_id: "tsk-work", status: "blocked" } }],
});
assert.equal(awayResult.challenged, true);
assert.ok(away.agent.followups[0].content[0].text.includes(AUTONOMOUS_CHALLENGE));

const temp = challengeHarness(false);
const tempResult = await temp.service.handleAssistantMessage(temp.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_update", arguments: { task_id: "tsk-temp", status: "done" } }],
});
assert.equal(tempResult.ok, true);
assert.equal(temp.agent.followups.length, 0);

// autonomous 回合正常结束但仍有可收尾的 owned in_progress 时，注入轻量质询；
// 有绑定运行中的工作或已有 pending 申请时均不拦。
const turnEnd = challengeHarness(true);
const turnEndResult = await turnEnd.service.handleTurnEnd(turnEnd.state, { data: { reason: { kind: "completed" } } });
assert.equal(turnEndResult.challenged, true);
assert.equal(turnEnd.agent.followups.length, 1);
assert.ok(turnEnd.agent.followups[0].content[0].text.includes(AUTONOMOUS_TURN_END_CHALLENGE));
assert.match(turnEnd.agent.followups[0].content[0].text, /tsk-work/u);

const runningTurnEnd = challengeHarness(true, { runningWork: true });
const runningTurnEndResult = await runningTurnEnd.service.handleTurnEnd(runningTurnEnd.state, { data: { reason: { kind: "completed" } } });
assert.equal(runningTurnEndResult.ok, true);
assert.equal(runningTurnEnd.agent.followups.length, 0);

const pendingTurnEnd = challengeHarness(true, { pendingStatus: "pending_blocked" });
const pendingTurnEndResult = await pendingTurnEnd.service.handleTurnEnd(pendingTurnEnd.state, { data: { reason: { kind: "completed" } } });
assert.equal(pendingTurnEndResult.ok, true);
assert.equal(pendingTurnEnd.agent.followups.length, 0);

const presentTurnEnd = challengeHarness(false);
const presentTurnEndResult = await presentTurnEnd.service.handleTurnEnd(presentTurnEnd.state, { data: { reason: { kind: "completed" } } });
assert.equal(presentTurnEndResult.ignored, true);
assert.equal(presentTurnEnd.agent.followups.length, 0);

console.log("auto-advance challenge smoke: PASS (in-person/autonomous wording + temp exemption)");
