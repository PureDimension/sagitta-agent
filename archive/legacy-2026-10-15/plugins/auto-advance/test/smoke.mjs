import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  AutoAdvanceService,
  AUTONOMOUS_PROMPT,
  IN_PERSON_CHALLENGE,
  AUTONOMOUS_CHALLENGE,
  AUTONOMOUS_TURN_END_CHALLENGE,
  DEFAULT_CODEX_MAX_CONCURRENT,
  TASK_RECHECK_DELAY_MS,
  normalizeConfig,
  taskNeedsCodex,
  hasOpenNeedHuman,
  mapApiTaskSnapshot,
  splitCloudTaskSnapshotStrict,
} from "../lib/service.js";
import { validateRoundClosePayload } from "../lib/round-close.js";

const iso = (minute) => `2026-08-30T00:${String(minute).padStart(2, "0")}:00.000Z`;

const implicitClose = validateRoundClosePayload({
  task_id: "tsk-round",
  round_id: "round-implicit",
  action: "done",
  progress: "完成",
  next: "等待确认",
  evidence_json: [{ type: "test", path: "test/smoke.mjs", summary: "smoke", at: "2026-09-20T00:00:00.000Z" }],
});
assert.equal(Object.hasOwn(implicitClose, "expected_updated_at"), false);
const blockedClose = validateRoundClosePayload({
  task_id: "tsk-round",
  round_id: "round-blocked",
  action: "blocked",
  progress: "阻塞",
  next: "等待外部",
  blocked_reason: "外部依赖",
  blocked_kind: "external",
});
assert.equal(blockedClose.blocked_kind, "external");
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
assert.doesNotMatch(AUTONOMOUS_PROMPT, /round[_-]?close/iu);
assert.equal(normalizeConfig({
  statePath: join(tmpdir(), "sagitta-auto-advance-default-state.json"),
}).idleTimeoutMs, 15000);
assert.equal(normalizeConfig({
  statePath: join(tmpdir(), "sagitta-auto-advance-resource-state.json"),
  codexMaxConcurrent: 2,
  advancePromptCooldownMs: 250,
  advancePromptBackoffFactor: 3,
  advancePromptMaxCooldownMs: 1000,
  advancePromptMaxInjections: 2,
}).codexMaxConcurrent, 2);
const profileHome = join(tmpdir(), "sagitta-auto-advance-profile-home");
assert.equal(normalizeConfig({}, { dshHomePath: (...segments) => join(profileHome, ...segments) }).statePath,
  join(profileHome, "profiles", "web", ".sagitta-auto-advance.json"));
assert.throws(() => normalizeConfig({}), /dshHomePath/u);
assert.equal(DEFAULT_CODEX_MAX_CONCURRENT, 4);
assert.equal(taskNeedsCodex({ requires_codex: false }), false);
assert.equal(taskNeedsCodex({ execution_resource: "local" }), false);
assert.equal(taskNeedsCodex({ execution_resource: "codex" }), true);
assert.equal(taskNeedsCodex({}), true, "missing resource metadata is conservatively codex-capable");
const serviceSource = readFileSync(new URL("../lib/service.js", import.meta.url), "utf8");
assert.doesNotMatch(serviceSource, /(?:from|import)\s+["'][^"']*codex-dispatch/u, "resource sensing must not import the codex plugin");
assert.doesNotMatch(serviceSource, /@sagitta\/memory\/lib\/http\.js|\bfetch\s*\(/u, "task networking must use manager.request");
assert.match(serviceSource, /asyncWork\.listActive\(state\.agent\.id, \{\}\)/u, "resource sensing must use the generic registry");
assert.equal(TASK_RECHECK_DELAY_MS, 30000, "pending/running recheck remains quieter than the 15s idle probe");
assert.equal(hasOpenNeedHuman({ need_humans: [{ type: "notify", status: "open" }] }), false);
assert.equal(hasOpenNeedHuman({ need_humans: [{ type: "need", status: "open" }] }), true);
assert.equal(hasOpenNeedHuman({ open_need_human: true, open_need_human_type: "notify" }), false);
const mappedNotifyOnly = mapApiTaskSnapshot([
  task("tsk-notify-only", "in_progress", null, {
    open_need_human: true,
    need_humans: [{ type: "notify", status: "open" }],
  }),
]);
assert.equal(mappedNotifyOnly.sections[0].items[0].open_need_human, false);
const mappedStatusSnapshot = mapApiTaskSnapshot([
  task("tsk-ui-progress", "in_progress", null, { claim_state: "mine" }, 23),
  task("tsk-ui-blocked", "blocked", null, {}, 22),
  task("tsk-ui-open", "open", null, {}, 21),
  task("tsk-ui-temp", "in_progress", null, { claim_state: "mine", type: "temp" }, 20),
]);
const mappedStatusItems = mappedStatusSnapshot.sections.flatMap((section) => section.items);
assert.deepEqual(mappedStatusItems.map((item) => item.status), ["in_progress", "blocked", "open", "in_progress"]);
assert.equal(mappedStatusItems.find((item) => item.task_id === "tsk-ui-progress").acceptance, "- [ ] target one\n- [x] target two");
assert.equal(mappedStatusItems.find((item) => item.task_id === "tsk-ui-temp").kind, "temp");
assert.equal(mappedStatusItems.find((item) => item.task_id === "tsk-ui-progress").claimState, "mine");

let responseMode = "owned";
const resolvedRequests = [];
const blockedRequests = [];
const taskReadAgentIds = [];
const taskReadUrls = [];
const managerRequestCalls = [];
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
    taskReadUrls.push(requestUrl);
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
    owned: [
      task("tsk-mine", "in_progress", null, { claim_state: "mine" }, 20),
      task("tsk-temp", "in_progress", null, { claim_state: "mine", type: "temp" }, 19),
    ],
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

const manager = {
  async request(path, init = {}) {
    managerRequestCalls.push({
      path,
      method: init.method,
      headers: { ...init.headers },
      body: init.body
    });
    return fetch(new URL(path, workerUrl), init);
  }
};

function makeHarness({ api = true, runningWork = false, activeWorks, codexActiveCount = 0, recentWorks = [], enabled = true, subscribeToEvents = false } = {}) {
  const agent = {
    id: "agent-smoke",
    status: "idle",
    inbox: { nextStep: [], nextTurn: [] },
    followups: [],
    followup(message) {
      this.followups.push(message);
      this.inbox.nextTurn.push(message);
    },
  };
  const events = [];
  let currentActiveWorks = Array.isArray(activeWorks) ? [...activeWorks] : (runningWork ? [{
      work_id: "work-running",
      task_id: "tsk-work",
      kind: "codex",
      desc: "派单工作",
      started_at: "2026-09-07T00:00:00.000Z",
      timeout_ms: 60000,
      status: "running"
    }] : []);
  for (let index = 0; index < codexActiveCount; index++) currentActiveWorks.push({
    work_id: `work-slot-${index + 1}`,
    task_id: `tsk-other-${index + 1}`,
    kind: "codex",
    desc: "占用 codex 槽位",
    started_at: "2026-09-07T00:00:00.000Z",
    timeout_ms: 60000,
    status: "running"
  });
  const asyncWork = {
    listActive: (ownerId, filter = {}) => {
      if (ownerId !== agent.id) return [];
      const taskId = filter?.taskId ?? filter?.task_id;
      return taskId === undefined ? currentActiveWorks : currentActiveWorks.filter((work) => work.task_id === taskId);
    },
    listRecent: (ownerId) => ownerId === agent.id ? recentWorks : []
  };
  const subscriptions = new Map();
  const ctx = {
    reflect: { provide() {} },
    fiber: { state: 2 },
    agents: {
      list: () => [agent],
      get: (id) => id === agent.id ? agent : undefined,
      isOwnedBy: () => false,
    },
    get: (name) => name === "sagitta-async-work" ? asyncWork : undefined,
    logger: { warn() {}, debug() {} },
    inject() {},
    effect() {},
    on(event, listener) {
      if (!subscriptions.has(event)) subscriptions.set(event, new Set());
      subscriptions.get(event).add(listener);
      return () => subscriptions.get(event)?.delete(listener);
    },
    emit(event, ...args) {
      events.push(args.at(-1));
      for (const listener of subscriptions.get(event) ?? []) listener(...args);
    },
  };
  const service = subscribeToEvents
    ? new AutoAdvanceService(ctx, {
      statePath: join(tmpdir(), "sagitta-auto-advance-settled-subscription-smoke-state.json"),
    })
    : Object.create(AutoAdvanceService.prototype);
  service.ctx = ctx;
  service.manager = api ? manager : undefined;
  service.config = {
    taskPageSize: 200,
    statePath: join(tmpdir(), "sagitta-auto-advance-smoke-state.json"),
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
    emit(event, ...args) { ctx.emit(event, ...args); },
    events,
    setActiveWorks(next) { currentActiveWorks = Array.isArray(next) ? [...next] : []; },
  };
}

// Settlement only resets auto-advance's own probe timer. The async-work
// service owns the settlement notice and delivery path.
const chatSettleHarness = makeHarness({ api: false, enabled: false, subscribeToEvents: true });
const resetReasons = [];
const resetTimer = chatSettleHarness.service.resetTimer.bind(chatSettleHarness.service);
chatSettleHarness.service.resetTimer = (state, reason) => {
  resetReasons.push({ state, reason });
  return resetTimer(state, reason);
};
chatSettleHarness.emit("async-work/settled", {
  ownerId: "agent-smoke",
  workId: "work-settled",
  taskId: "task-settled",
  kind: "codex",
  status: "completed",
  reason: null,
});
assert.deepEqual(resetReasons, [{ state: chatSettleHarness.state, reason: "async-work-settled" }],
  "settlement must reset auto-advance's timer");
assert.equal(chatSettleHarness.agent.followups.length, 0, "auto-advance must not create a settlement notice");
assert.equal(chatSettleHarness.agent.inbox.nextTurn.length, 0, "settlement must not enter auto-advance's next-turn inbox");
assert.equal(chatSettleHarness.agent.inbox.nextStep.length, 0, "settlement must not enter auto-advance's next-step inbox");
chatSettleHarness.service.removeProcessShutdownHooks();

// Header remote snapshot is owner-scoped and keeps running/recent terminal
// records in separate, browser-safe shapes.
const asyncSnapshotHarness = makeHarness({
  runningWork: true,
  recentWorks: [{
    work_id: "work-recent",
    task_id: "task-recent",
    owner_id: "agent-smoke",
    kind: "external",
    desc: "外部系统同步",
    started_at: "2026-09-06T23:59:00.000Z",
    timeout_ms: 60000,
    status: "failed",
    ended_at: "2026-09-07T00:00:02.000Z",
    reason: "连接失败",
    child_metadata: { secret: "must-not-leak" }
  }]
});
assert.deepEqual(asyncSnapshotHarness.service.getAsyncWorks(asyncSnapshotHarness.agent), {
  running: [{
    work_id: "work-running",
    task_id: "tsk-work",
    kind: "codex",
    desc: "派单工作",
    started_at: "2026-09-07T00:00:00.000Z",
    timeout_ms: 60000,
    status: "running"
  }],
  recent: [{
    work_id: "work-recent",
    task_id: "task-recent",
    kind: "external",
    desc: "外部系统同步",
    started_at: "2026-09-06T23:59:00.000Z",
    ended_at: "2026-09-07T00:00:02.000Z",
    timeout_ms: 60000,
    status: "failed",
    reason: "连接失败"
  }]
});
assert.deepEqual(asyncSnapshotHarness.service.getAsyncWorks({ id: "other-agent" }), { running: [], recent: [] }, "async-work remote must not leak another owner");

try {
  // 有已认领 in_progress 才注入自主推进；提示只带轻量任务清单，取消 round-close 强制。
  responseMode = "owned";
  const ownedHarness = makeHarness();
  const pendingSnapshot = await ownedHarness.service.getTasks();
  assert.equal(taskReadAgentIds.at(-1), "agent-smoke", "UI task read must use the selected session id");
  assert.equal(taskReadUrls.at(-1).searchParams.get("include_temp"), "1", "UI task read must include the selected agent's temp lease");
  const uiTaskRequest = managerRequestCalls.findLast((call) => call.path.startsWith("/task?"));
  assert.equal(uiTaskRequest.method, "GET", "UI task read must use manager.request GET");
  assert.match(uiTaskRequest.path, /\/task\?page=1&size=200&include_temp=1/u);
  assert.equal(uiTaskRequest.headers["X-Agent-Id"], "agent-smoke", "manager.request must receive the selected session id");
  const uiNeedHumanRequest = managerRequestCalls.findLast((call) => call.path === "/need-human?status=open");
  assert.equal(uiNeedHumanRequest.method, "GET", "need-human read must use manager.request GET");
  const pendingItems = pendingSnapshot.sections.flatMap((section) => section.items);
  assert.equal(pendingItems.find((item) => item.task_id === "tsk-mine").status, "in_progress");
  assert.equal(pendingItems.find((item) => item.task_id === "tsk-mine").acceptance, "- [ ] target one\n- [x] target two");
  assert.equal(pendingItems.find((item) => item.task_id === "tsk-temp").kind, "temp");
  assert.deepEqual(pendingSnapshot.pendingRequests.map((item) => item.type), ["notify", "need"]);
  assert.equal(pendingSnapshot.pendingRequests[0].needHumanId, "nh-notify");
  const resolvedNotify = await ownedHarness.service.resolveNeedHuman("nh-notify");
  assert.deepEqual(resolvedNotify, { needHumanId: "nh-notify", taskId: "tsk-mine", type: "notify", status: "resolved" });
  assert.deepEqual(resolvedRequests[0], {
    id: "nh-notify",
    body: { resolve_kind: "solved", resolved_by: "ripple" },
    authorization: undefined,
  });
  const resolveRequest = managerRequestCalls.findLast((call) => call.path === "/task/need-human/nh-notify/resolve");
  assert.equal(resolveRequest.method, "POST");
  assert.deepEqual(JSON.parse(resolveRequest.body), { resolve_kind: "solved", resolved_by: "ripple" });
  const refreshedPendingSnapshot = await ownedHarness.service.getTasks();
  assert.deepEqual(refreshedPendingSnapshot.pendingRequests.map((item) => item.type), ["need"]);
  await ownedHarness.service.onTimer(ownedHarness.state, 1);
  assert.equal(taskReadAgentIds.at(-1), "agent-smoke", "auto-advance qualification read must use state.agent.id");
  const qualificationRequest = managerRequestCalls.findLast((call) => call.path.startsWith("/task?"));
  assert.equal(qualificationRequest.method, "GET");
  assert.equal(qualificationRequest.headers["X-Agent-Id"], "agent-smoke");
  assert.equal(ownedHarness.agent.followups.length, 1);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /涟漪已离开/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /tsk-mine/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /当前我认领的 in_progress 任务/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /acceptance=2项期望目标\(见下\)/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /\[tsk-mine\] 期望目标/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /- \[ \] target one/u);
  assert.match(ownedHarness.agent.followups[0].content[0].text, /逐项核对每个任务的期望目标/u);
  assert.doesNotMatch(ownedHarness.agent.followups[0].content[0].text, /task_round_close|round-close/iu);
  assert.equal(ownedHarness.state.pendingAutoMode, "away");

  // Codex slots are a real resource boundary: a full registry is silent, and
  // the same task resumes normal prompting as soon as a slot is released.
  responseMode = "owned";
  const resourceHarness = makeHarness({ codexActiveCount: 2 });
  resourceHarness.service.config.codexMaxConcurrent = 2;
  await resourceHarness.service.onTimer(resourceHarness.state, 1);
  assert.equal(resourceHarness.agent.followups.length, 0, "full codex pool must not inject an owned-task prompt");
  assert.deepEqual(resourceHarness.service.actionableOwnedTasks(resourceHarness.state, resourceHarness.state.cloudSnapshot).map((item) => item.task_id), []);
  assert.ok(resourceHarness.events.some((event) => event.reason === "defer: codex-resource-limit"));
  resourceHarness.service.clearTimer(resourceHarness.state);
  resourceHarness.setActiveWorks([]);
  await resourceHarness.service.onTimer(resourceHarness.state, resourceHarness.state.timerGeneration);
  assert.equal(resourceHarness.agent.followups.length, 1, "prompt must resume after a codex slot is released");
  assert.match(resourceHarness.agent.followups[0].content[0].text, /涟漪已离开/u);

  // Continuation prompts use exponential cooldown and stop at the configured
  // maximum for an unchanged task snapshot.
  const backoffHarness = makeHarness();
  backoffHarness.service.config.advancePromptCooldownMs = 100;
  backoffHarness.service.config.advancePromptBackoffFactor = 2;
  backoffHarness.service.config.advancePromptMaxCooldownMs = 1000;
  backoffHarness.service.config.advancePromptMaxInjections = 2;
  const backoffTask = task("tsk-backoff", "in_progress", null, { claim_state: "mine" });
  backoffHarness.service.recordAdvancePrompt(backoffHarness.state, [backoffTask], 1000);
  assert.equal(backoffHarness.state.advancePromptNextAt, 1100);
  backoffHarness.service.recordAdvancePrompt(backoffHarness.state, [backoffTask], 1200);
  assert.equal(backoffHarness.state.advancePromptNextAt, 1400, "the second identical prompt must use the exponential delay");

  const cappedHarness = makeHarness();
  cappedHarness.service.config.advancePromptCooldownMs = 0;
  cappedHarness.service.config.advancePromptMaxInjections = 2;
  await cappedHarness.service.onTimer(cappedHarness.state, 1);
  cappedHarness.agent.inbox.nextTurn = [];
  await cappedHarness.service.onTimer(cappedHarness.state, 1);
  cappedHarness.agent.inbox.nextTurn = [];
  await cappedHarness.service.onTimer(cappedHarness.state, 1);
  assert.equal(cappedHarness.agent.followups.length, 2, "unchanged actionable tasks must stop after the configured injection cap");
  assert.ok(cappedHarness.events.some((event) => event.reason === "defer: advance-prompt-backoff"));

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

  // 云端通道不可用时严格失败，不读取本地任务文件。
  const noApiHarness = makeHarness({ api: false });
  await noApiHarness.service.onTimer(noApiHarness.state, 1);
  assert.equal(noApiHarness.agent.followups.length, 0);
  assert.equal(noApiHarness.state.enabled, true);
  noApiHarness.service.clearTimer(noApiHarness.state);
  await assert.rejects(() => noApiHarness.service.getTasks(), /sagitta-manager\.request 不可用/u);
  const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(clientSource, /📢 待你确认/u);
  assert.match(clientSource, /remoteApi\.resolveNeedHuman/u);
  assert.match(clientSource, /await refresh\(true\)/u);
  assert.match(clientSource, /filter\(isClaimableOpenTask\)/u);
  assert.match(clientSource, /const tempTasks = allTasks\.filter\(\(task\) => isTempTask\(task\) && task\.status !== "done"/u);
  assert.doesNotMatch(clientSource, /if \(total === 0\) return null/u, "async-work header entry remains visible with an empty registry");
  let clientPlugin;
  runInNewContext(clientSource, {
    window: {
      __ModuleLoader__: {
        load(bundle) {
          clientPlugin = bundle.factory((id) => {
            if (id === "react") return { createElement: (...args) => args };
            throw new Error(`unexpected client bundle require: ${id}`);
          });
        }
      }
    }
  });
  const mountedRemotes = [];
  const headerRegistrations = [];
  await clientPlugin.apply({
    remote: { $mount: async (remote) => { mountedRemotes.push(remote); return async () => {}; } },
    get: () => ({}),
    effect: () => {},
    slots: {
      inject(name, callback) {
        assert.equal(name, "conversation.session.header.actions");
        return callback();
      },
      register(options, component) {
        headerRegistrations.push({ options, component });
        return () => {};
      }
    }
  });
  assert.equal(headerRegistrations[0].options.id, "sagitta-async-work");
  assert.equal(headerRegistrations[0].options.name, "conversation.session.header.actions");
  const getTasksDescriptor = mountedRemotes[0].descriptors.find((descriptor) => descriptor.method === "getTasks");
  const parsedClientSnapshot = getTasksDescriptor.result.schema.parse({
    updatedAt: 1,
    sections: [{ title: "smoke", items: [{
      text: "进行中任务",
      done: false,
      status: "in_progress",
      acceptance: "- [ ] target one",
      kind: "temp",
      claimState: "mine",
      project: "smoke"
    }] }]
  });
  assert.equal(parsedClientSnapshot.sections[0].items[0].acceptance, "- [ ] target one");
  assert.equal(parsedClientSnapshot.sections[0].items[0].kind, "temp");
  assert.equal(parsedClientSnapshot.sections[0].items[0].claimState, "mine");
  const getAsyncWorksDescriptor = mountedRemotes[0].descriptors.find((descriptor) => descriptor.method === "getAsyncWorks");
  const parsedAsyncWorks = getAsyncWorksDescriptor.result.schema.parse({
    running: [{
      work_id: "work-running",
      task_id: "task-running",
      kind: "codex",
      desc: "派单",
      started_at: "2026-09-07T00:00:00.000Z",
      timeout_ms: 60000,
      status: "running"
    }],
    recent: [{
      work_id: "work-failed",
      task_id: "task-failed",
      kind: "external",
      desc: "外部同步",
      started_at: "2026-09-06T23:59:00.000Z",
      ended_at: "2026-09-07T00:00:03.000Z",
      timeout_ms: 60000,
      status: "failed",
      reason: "连接失败"
    }]
  });
  assert.equal(parsedAsyncWorks.running[0].status, "running");
  assert.equal(parsedAsyncWorks.recent[0].status, "failed");
  assert.match(clientSource, /ctx\.slots\.inject\("conversation\.session\.header\.actions"/u);

  // 模拟 DSH 的 process SIGINT/SIGTERM → fiber.dispose：当前快照中的 owned
  // in_progress 任务经 manager.request 并行 PATCH blocked，携带 session agent id。
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
  assert.equal(shutdownHarness.service.manager, manager);
  shutdownHarness.service.processShutdownRequested = true;
  await shutdownHarness.service.blockOwnedTasksOnProcessShutdown();
  assert.deepEqual(blockedRequests.slice(-2).sort((first, second) => first.id.localeCompare(second.id)), [
    {
      id: "tsk-shutdown-a",
      body: { status: "blocked", blocked_reason: "sagitta 进程中断退出" },
      authorization: undefined,
      agentId: "agent-smoke",
    },
    {
      id: "tsk-shutdown-b",
      body: { status: "blocked", blocked_reason: "sagitta 进程中断退出" },
      authorization: undefined,
      agentId: "agent-smoke",
    },
  ]);
  const shutdownCalls = managerRequestCalls.filter((call) => /^\/task\/tsk-shutdown-(?:a|b)$/u.test(call.path));
  assert.deepEqual(shutdownCalls.map((call) => call.method).sort(), ["PATCH", "PATCH"]);
  assert.deepEqual(shutdownCalls.map((call) => JSON.parse(call.body)), [
    { status: "blocked", blocked_reason: "sagitta 进程中断退出" },
    { status: "blocked", blocked_reason: "sagitta 进程中断退出" }
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

  console.log("auto-advance smoke: PASS (need/notify mapping, notify resolve POST + refresh, task-driven branches, cloud defer, manager channel)");
} finally {
  server.close();
}

function challengeHarness(autonomousMode, { pendingStatus = null, runningWork = false } = {}) {
  const harness = makeHarness({ api: false, runningWork });
  const taskPage = {
    total: 2,
    page: 1,
    size: 200,
    has_more: false,
    source: "cloud",
    items: [
      task("tsk-work", "in_progress", pendingStatus, { claim_state: "mine" }),
      task("tsk-temp", "in_progress", null, { claim_state: "mine", type: "temp" }),
    ]
  };
  harness.service.manager = {
    request: async (path) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, data: path.startsWith("/task?") ? taskPage : { items: [] } })
    })
  };
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

// v3：普通 task_update 的 done/blocked 已直落；只有自主 task_round_close 的
// done/blocked 仍触发在场/离开两态质询，且 temp 任务直接豁免。
const present = challengeHarness(false);
const presentResult = await present.service.handleAssistantMessage(present.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_round_close", arguments: { task_id: "tsk-work", action: "done", round_id: "round-present" } }],
});
assert.equal(presentResult.challenged, true);
assert.ok(present.agent.followups[0].content[0].text.includes(IN_PERSON_CHALLENGE));

const away = challengeHarness(true);
const awayResult = await away.service.handleAssistantMessage(away.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_round_close", arguments: { task_id: "tsk-work", action: "blocked", round_id: "round-away" } }],
});
assert.equal(awayResult.challenged, true);
assert.ok(away.agent.followups[0].content[0].text.includes(AUTONOMOUS_CHALLENGE));

const temp = challengeHarness(false);
const tempResult = await temp.service.handleAssistantMessage(temp.state, {
  role: "assistant",
  content: [{ type: "tool-call", name: "task_round_close", arguments: { task_id: "tsk-temp", action: "done", round_id: "round-temp" } }],
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
