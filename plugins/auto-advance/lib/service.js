import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { splitCloudTaskSnapshotStrict, validateCloudTaskPage, MAX_PAGE_SIZE } from "./snapshot.js";
// Kept as a compatibility export for older consumers. v2 no longer invokes
// these parsers or injects a round-close requirement.
import { parseRoundCloseMessage, parseRoundCloseText, validateRoundClosePayload } from "./round-close.js";

/**
 * Model-facing v2 prompt. Task state is written by the memory task tools;
 * auto-advance only decides whether there is owned work worth continuing.
 */
const AUTONOMOUS_PROMPT = "涟漪已离开。由于存在 in_progress 任务，请继续尽可能推进所有不需人工的任务，直到无可推进。遇到明确的 bug（含远端/服务端代码错误）直接修复推进到底，不要因选择非常明确的小问题阻塞——顶多发 notify 告知即可；只有方向性取舍、需涟漪个人输入（凭据/激活码/权限）、或不可逆高风险（无备份的破坏性操作/动生产数据）才停下找他。确实无自主可推进处，能自测的自测、能拆的拆，然后收口：只有【除 need-human 之外没有其他可独自推进的事】时才创建 need-human（type=need）并标 blocked（need 之外还有可推进就继续推进，不要因为有 need-human 就 block）；需人工了解重大决策时发 notify（待确认，不阻塞 done）；达到交付标准就标 done。禁止为逃避收口母任务无限开旁支/temp 新任务。每轮收尾都核对当前 in_progress 是否真无可推进，可推进就继续，不可推进按上述规则收口。终态请使用任务工具更新。";
const IN_PERSON_CHALLENGE = "确认已推进到必须涟漪处理的地步？先核对当前 in_progress：所有不需人工的工作是否已推进到无可推进，能自测的已自测、能拆的已拆？明确 bug 应直接修复推进（含远端/服务端），选择明确的小问题不阻塞（顶多 notify）；只有方向性取舍、需涟漪个人输入、不可逆高风险才停下。只有【除 need-human 之外没有其他可独自推进的事】时才创建 need-human（type=need）并标 blocked（need 之外还有可推进就继续推进）；重大决策待确认时发 notify，不阻塞 done；达到交付标准才标 done。禁止用旁支/temp 新任务逃避收口。";
const AUTONOMOUS_CHALLENGE = "涟漪已离开。先核对当前 in_progress：所有不需人工的工作是否已推进到无可推进？能拆的拆、能自测的自测，禁止开旁支/temp 任务逃避收口。明确 bug 直接修复推进（含远端/服务端），选择明确的小问题不阻塞（顶多 notify）。只有【除 need-human 之外没有其他可独自推进的事】时才创建 need-human（type=need）并标 blocked；重大决策待确认时发 notify，不阻塞 done；达到交付标准才标 done。";
const AUTONOMOUS_TURN_END_CHALLENGE = "涟漪已离开。仍有 in_progress 任务未收尾：先继续推进所有不需人工的部分至无可推进，能拆的拆、能自测的自测，禁止开旁支/temp 任务逃避收口；明确 bug 直接修复推进（含远端/服务端），选择明确的小问题不阻塞（顶多 notify）。只有【除 need-human 之外没有其他可独自推进的事】时才创建 need-human（type=need）并标 blocked；重大决策发 notify（待确认，不阻塞 done）；达到交付标准就完成、标 done、释放任务。";

const STOP_MARKER = "【停止自主推进】";
const PLUGIN_ID = "auto-advance";
const STATUS_EVENT = "sagitta-auto-advance/status";
const DEFAULT_IDLE_TIMEOUT_MS = 15000;
const DEFAULT_TASK_PAGE_SIZE = 200;
const DEFAULT_CODEX_MAX_CONCURRENT = 4;
const DEFAULT_ADVANCE_PROMPT_COOLDOWN_MS = 30000;
const DEFAULT_ADVANCE_PROMPT_BACKOFF_FACTOR = 2;
const DEFAULT_ADVANCE_PROMPT_MAX_COOLDOWN_MS = 300000;
const DEFAULT_ADVANCE_PROMPT_MAX_INJECTIONS = 3;
const TASK_RECHECK_DELAY_MS = 30000;
const PROCESS_SHUTDOWN_TASK_BUDGET_MS = 4500;
const PROCESS_SHUTDOWN_BLOCKED_REASON = "sagitta 进程中断退出";
const ASYNC_WORK_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);
const CLOUD_RETRY_DELAYS_MS = [30000, 120000, 300000];
const CLOUD_RETRY_JITTER = 0.2;
const REMOTE_INITIALIZERS = [];
for (const method of ["getState", "setMode", "getTasks", "getAsyncWorks", "resolveNeedHuman"]) {
  Remote(method)(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      REMOTE_INITIALIZERS.push(initializer);
    }
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderError(error) {
  return error instanceof Error ? error.message : String(error);
}

function taskApiUnavailable(message, cause) {
  const error = new Error(`task-api-unavailable: ${message}`);
  error.code = "task-api-unavailable";
  if (cause !== undefined) error.cause = cause;
  return error;
}

function safeLog(loggerOrGetter, level, message) {
  try {
    const logger = typeof loggerOrGetter === "function" ? loggerOrGetter() : loggerOrGetter;
    logger?.[level]?.(message);
  } catch {
    // Diagnostics must never affect plugin startup or timer recovery.
  }
}

function nonEmptyString(value) {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length > 0 ? result : undefined;
}

function asyncWorkView(work, terminal = false) {
  if (work === null || typeof work !== "object") return null;
  const workId = nonEmptyString(work.work_id ?? work.workId);
  const taskId = nonEmptyString(work.task_id ?? work.taskId);
  const kind = nonEmptyString(work.kind);
  const desc = typeof work.desc === "string" ? work.desc : undefined;
  const startedAt = nonEmptyString(work.started_at ?? work.startedAt);
  const timeoutMs = Number.isInteger(work.timeout_ms ?? work.timeoutMs) ? (work.timeout_ms ?? work.timeoutMs) : undefined;
  const status = nonEmptyString(work.status);
  if (workId === undefined || taskId === undefined || kind === undefined || desc === undefined ||
    startedAt === undefined || timeoutMs === undefined || status === undefined) return null;
  if (!terminal && status !== "running") return null;
  if (terminal && !ASYNC_WORK_TERMINAL_STATUSES.has(status)) return null;
  const base = {
    work_id: workId,
    task_id: taskId,
    kind,
    desc,
    started_at: startedAt,
    timeout_ms: timeoutMs,
    status
  };
  if (!terminal) return base;
  const endedAt = nonEmptyString(work.ended_at ?? work.endedAt);
  if (endedAt === undefined) return null;
  return {
    ...base,
    ended_at: endedAt,
    reason: typeof work.reason === "string" && work.reason.trim().length > 0 ? work.reason.trim() : null
  };
}

function resolveConfiguredPaths(config = {}, ctx) {
  const configuredStatePath = nonEmptyString(config.statePath);
  if (configuredStatePath !== undefined) return { statePath: resolve(configuredStatePath) };
  if (typeof ctx?.dshHomePath !== "function") {
    throw new Error("sagitta-auto-advance requires ctx.dshHomePath to derive the default state path");
  }
  const profilePath = ctx.dshHomePath("profiles", "web");
  if (typeof profilePath !== "string" || profilePath.trim().length === 0) {
    throw new Error("sagitta-auto-advance could not derive the web profile path from ctx.dshHomePath");
  }
  return {
    statePath: join(resolve(profilePath), ".sagitta-auto-advance.json")
  };
}

function normalizeConfig(config = {}, ctx) {
  const idleTimeoutMs = Number(config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  const codexMaxConcurrent = Number(config.codexMaxConcurrent ?? process.env.SAGITTA_CODEX_MAX_CONCURRENT ?? DEFAULT_CODEX_MAX_CONCURRENT);
  const advancePromptCooldownMs = Number(config.advancePromptCooldownMs ?? DEFAULT_ADVANCE_PROMPT_COOLDOWN_MS);
  const advancePromptBackoffFactor = Number(config.advancePromptBackoffFactor ?? DEFAULT_ADVANCE_PROMPT_BACKOFF_FACTOR);
  const advancePromptMaxCooldownMs = Number(config.advancePromptMaxCooldownMs ?? DEFAULT_ADVANCE_PROMPT_MAX_COOLDOWN_MS);
  const normalizedAdvancePromptCooldownMs = Number.isFinite(advancePromptCooldownMs) && advancePromptCooldownMs >= 0
    ? advancePromptCooldownMs : DEFAULT_ADVANCE_PROMPT_COOLDOWN_MS;
  const advancePromptMaxInjections = Number(config.advancePromptMaxInjections ?? DEFAULT_ADVANCE_PROMPT_MAX_INJECTIONS);
  const paths = resolveConfiguredPaths(config, ctx);
  return {
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
    codexMaxConcurrent: Number.isInteger(codexMaxConcurrent) && codexMaxConcurrent > 0
      ? codexMaxConcurrent : DEFAULT_CODEX_MAX_CONCURRENT,
    advancePromptCooldownMs: normalizedAdvancePromptCooldownMs,
    advancePromptBackoffFactor: Number.isFinite(advancePromptBackoffFactor) && advancePromptBackoffFactor >= 1
      ? advancePromptBackoffFactor : DEFAULT_ADVANCE_PROMPT_BACKOFF_FACTOR,
    advancePromptMaxCooldownMs: Number.isFinite(advancePromptMaxCooldownMs) && advancePromptMaxCooldownMs >= 0
      ? Math.max(normalizedAdvancePromptCooldownMs, advancePromptMaxCooldownMs) : DEFAULT_ADVANCE_PROMPT_MAX_COOLDOWN_MS,
    advancePromptMaxInjections: Number.isInteger(advancePromptMaxInjections) && advancePromptMaxInjections > 0
      ? advancePromptMaxInjections : DEFAULT_ADVANCE_PROMPT_MAX_INJECTIONS,
    statePath: paths.statePath,
    taskPageSize: Number.isInteger(Number(config.taskPageSize)) && Number(config.taskPageSize) > 0
      ? Math.min(MAX_PAGE_SIZE, Number(config.taskPageSize))
      : DEFAULT_TASK_PAGE_SIZE
  };
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

function isExactStopMessage(message) {
  return message?.role === "assistant" && extractText(message.content).includes(STOP_MARKER);
}

function isTerminalCloudSnapshot(snapshot) {
  return snapshot?.source === "cloud" && Array.isArray(snapshot.items) &&
    snapshot.items.every((task) =>
      (task?.status === "done" || task?.status === "blocked") && task?.pending_status === null
    );
}

function isAutoAdvanceMessage(message, state) {
  return message?.id !== undefined && message.id === state.lastAutoMessageId;
}

function toolCallBlocks(message) {
  const blocks = [];
  if (Array.isArray(message?.content)) {
    blocks.push(...message.content.filter((block) => {
      const type = typeof block?.type === "string" ? block.type.toLowerCase() : "";
      return type === "tool-call" || type === "tool_call" || type === "tool_use" || type === "tool-use" ||
        type === "function-call" || type === "function_call" || type === "function" ||
        (type === "tool" && (block?.arguments !== undefined || block?.input !== undefined || block?.args !== undefined));
    }));
    blocks.push(...message.content.filter((block) => {
      const type = typeof block?.type === "string" ? block.type.toLowerCase() : "";
      return (type === "tool-result" || type === "tool_result" || type === "tool-output" || type === "tool_output") && toolName(block) !== undefined;
    }));
  }
  for (const key of ["tool_calls", "toolCalls", "function_calls", "functionCalls"]) {
    if (Array.isArray(message?.[key])) blocks.push(...message[key]);
  }
  return blocks;
}

function toolName(block) {
  return block?.name ?? block?.tool_name ?? block?.toolName ?? block?.function?.name ?? block?.tool?.name;
}

function toolArguments(block) {
  const value = block?.arguments ?? block?.input ?? block?.args ?? block?.parameters ?? block?.function?.arguments ?? block?.tool?.arguments;
  if (typeof value !== "string") return isRecord(value) ? value : {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolSucceeded(block) {
  const result = block?.result ?? block?.output ?? block?.response ?? block?.return_value;
  return isRecord(result) && (typeof result.claim_token === "string" || result.claim_state === "mine" || result.claimed === true);
}

function taskIdFromArgs(args) {
  const value = args?.task_id ?? args?.taskId ?? args?.id;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function taskType(value) {
  const type = value?.type ?? value?.task_type ?? value?.taskType ?? value?.kind;
  return typeof type === "string" ? type.trim().toLowerCase() : "";
}

function taskNeedsCodex(task) {
  if (!isRecord(task)) return true;
  if (task.requires_codex === false || task.requiresCodex === false || task.codex_required === false || task.codexRequired === false) return false;
  if (task.requires_codex === true || task.requiresCodex === true || task.codex_required === true || task.codexRequired === true) return true;
  const resource = task.execution_resource ?? task.executionResource ?? task.resource;
  if (typeof resource === "string") {
    const normalized = resource.trim().toLowerCase();
    if (["none", "model", "agent", "local", "human", "manual"].includes(normalized)) return false;
    if (["codex", "codex_dispatch", "codex-dispatch"].includes(normalized)) return true;
  }
  // The task API has no execution-resource contract. An owned in_progress task
  // is therefore conservatively treated as codex-capable unless it explicitly
  // opts out; this prevents a full codex pool from triggering blind prompts.
  return true;
}

function isTempTask(task, args = {}) {
  const type = taskType(task) || taskType(args);
  return type === "temp" || type === "temporary";
}

function hasOpenNeedHuman(task) {
  if (!isRecord(task)) return false;
  const entries = openNeedHumanEntries(task);
  if (entries !== undefined) return entries.some(isOpenNeedHumanEntry);
  if (task.open_need_human === true || task.has_open_need_human === true || Number(task.open_need_human_count) > 0) {
    return needHumanType({ type: task.open_need_human_type ?? task.openNeedHumanType }) === "need";
  }
  return false;
}

function needHumanType(value) {
  const raw = value?.type ?? value?.need_human_type ?? value?.needHumanType;
  return typeof raw === "string" && raw.trim().toLowerCase() === "notify" ? "notify" : "need";
}

function isOpenNeedHumanEntry(value) {
  return isRecord(value) && (value.status === undefined || value.status === "open") && needHumanType(value) === "need";
}

function openNeedHumanEntries(task) {
  if (!isRecord(task)) return undefined;
  for (const key of ["need_humans", "needHumans", "open_need_humans", "openNeedHumans", "need_human_items", "needHumanItems"]) {
    if (Array.isArray(task[key])) return task[key];
  }
  for (const key of ["open_need_human", "has_open_need_human"]) {
    if (isRecord(task[key])) return [task[key]];
  }
  for (const key of ["need_human", "needHuman"]) {
    if (isRecord(task[key])) return [task[key]];
    if (task[key] === true) return [{ status: "open", type: task.open_need_human_type ?? task.openNeedHumanType }];
  }
  return undefined;
}

function openNeedHumanCount(task) {
  const entries = openNeedHumanEntries(task);
  if (entries !== undefined) return entries.filter(isOpenNeedHumanEntry).length;
  return hasOpenNeedHuman(task) ? Math.max(1, Number(task.open_need_human_count) || 0) : 0;
}

function taskIsTerminal(task) {
  return (task?.status === "done" || task?.status === "blocked") && task?.pending_status === null;
}

/**
 * The inbox half of goal-round-driver's readyToDrive predicate. It is kept
 * exported so the smoke test can exercise the important queue guard without
 * constructing a complete DSH runtime.
 */
function hasPendingInbox(agent) {
  return (agent?.inbox?.nextStep?.length ?? 0) > 0 || (agent?.inbox?.nextTurn?.length ?? 0) > 0;
}

class AutoAdvanceService extends TypertRemoteService {
  static inject = ["agents", "goals", "sessions", "sagitta-async-work"];

  constructor(ctx, config = {}) {
    super(ctx, "sagittaAutoAdvance");
    for (const initializer of REMOTE_INITIALIZERS) initializer.call(this);

    this.manager = config.manager;
    this.config = normalizeConfig(config, ctx);
    this.states = new Map();
    this.listeners = new Set();
    this.persistedModes = this.loadModes();
    this.processShutdownRequested = false;
    this.processShutdownHandlers = [];
    this.installProcessShutdownHooks();

    ctx.on("agent/created", ({ agent }) => {
      const state = this.stateFor(agent);
      this.maybeArm(state);
    });
    ctx.on("agent/disposed", ({ agent }) => {
      const state = this.states.get(agent);
      if (state === undefined) return;
      state.disposed = true;
      this.clearTimer(state);
      // Keep the state until the process-shutdown disposer has collected its
      // last cloud snapshot. Normal agent disposal still releases it here.
      if (this.processShutdownRequested !== true) this.states.delete(agent);
      this.broadcast(state);
    });
    ctx.on("agent/session-start", ({ agent }) => {
      const state = this.stateFor(agent);
      state.enabled = this.persistedModes.get(agent.id) === true;
      state.stoppedByProtocol = false;
      state.lastAutoMessageId = undefined;
      state.cloudSnapshot = undefined;
      state.retryAttempt = 0;
      state.degraded = false;
      state.degradedReason = null;
      state.ownedTaskIds = new Set();
      state.autonomousMode = false;
      state.pendingAutoMode = undefined;
      state.lastProtocolNotice = null;
      this.resetAdvancePromptBackoff(state);
      this.resetTimer(state, "session-start");
    });
    ctx.on("agent/status", ({ agent, status }) => {
      const state = this.stateFor(agent);
      this.touchOwners(agent, "child-status");
      if (status === "idle") {
        this.maybeArm(state);
      }
      else this.resetTimer(state, "agent-running");
    });
    ctx.on("agent/inbox/inserted", ({ agent, message }) => {
      const state = this.stateFor(agent);
      if (isAutoAdvanceMessage(message, state)) {
        this.clearTimer(state);
        state.idleSince = null;
        state.autonomousMode = state.pendingAutoMode === "away";
        state.pendingAutoMode = undefined;
        this.broadcast(state);
        return;
      }
      state.autonomousMode = false;
      state.pendingAutoMode = undefined;
      this.resetTimer(state, "inbox-message");
      this.touchOwners(agent, "child-inbox-message");
    });
    ctx.on("agent/inbox/claimed", ({ agent }) => {
      this.resetTimer(this.stateFor(agent), "inbox-claimed");
    });
    ctx.on("agent/inbox/discarded", ({ agent }) => {
      this.resetTimer(this.stateFor(agent), "inbox-discarded");
    });
    ctx.on("goal/changed", ({ agent }) => {
      this.resetTimer(this.stateFor(agent), "goal-changed");
    });
    ctx.on("async-work/settled", (settled) => {
      const ownerId = nonEmptyString(settled?.ownerId ?? settled?.owner_id);
      if (ownerId === undefined) return;
      const agent = this.ctx.agents.get(ownerId);
      if (!agent) return;
      const state = this.states.get(agent);
      if (!state || state.disposed) return;
      this.resetTimer(state, "async-work-settled");
    });
    ctx.on("session/event", (session, event) => {
      const agent = ctx.agents.get(session.id);
      if (agent === undefined || agent.session !== session) return;
      const state = this.stateFor(agent);
      if (event.type === "user/message") {
        if (event.data?.id === state.lastAutoMessageId) {
          state.lastAutoMessageId = undefined;
          state.autonomousMode = state.pendingAutoMode === "away";
          state.pendingAutoMode = undefined;
          this.broadcast(state);
        } else {
          state.autonomousMode = false;
          state.pendingAutoMode = undefined;
          this.resetTimer(state, "user-message");
        }
        return;
      }
      if (event.type === "assistant/message") {
        void this.handleAssistantMessage(state, event.data?.message).catch((error) => {
          safeLog(() => this.logger(), "warn", `sagitta-auto-advance: assistant protocol handling failed: ${renderError(error)}`);
        });
        return;
      }
      if (event.type === "turn/end") {
        void this.handleTurnEnd(state, event).catch((error) => {
          safeLog(() => this.logger(), "warn", `sagitta-auto-advance: turn-end protocol handling failed: ${renderError(error)}`);
        });
      }
    });

    ctx.inject(["jobs"], (jobCtx) => {
      const jobs = jobCtx.jobs;
      const disposeDone = jobs.onJobDone((_snapshot, owner) => {
        this.touchJobOwner(owner, "job-done");
      });
      const disposeChanged = jobs.onJobsChanged((owner) => {
        this.touchJobOwner(owner, "jobs-changed");
      });
      jobCtx.effect(() => () => {
        disposeDone?.();
        disposeChanged?.();
      }, "sagitta-auto-advance: job listeners");
    });

    ctx.effect(() => () => this.disposeLifecycle(), "sagitta-auto-advance: timers");

    for (const agent of ctx.agents.list()) this.stateFor(agent);
  }

  /** Register a same-process listener; the web UI uses the typed RPC snapshot. */
  onStatus(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  installProcessShutdownHooks() {
    const markShutdown = () => {
      this.processShutdownRequested = true;
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
      try {
        process.on(signal, markShutdown);
        this.processShutdownHandlers.push([signal, markShutdown]);
      } catch {
        // Some embedded runtimes do not expose every POSIX signal.
      }
    }
  }

  removeProcessShutdownHooks() {
    for (const [signal, handler] of this.processShutdownHandlers ?? []) {
      try {
        process.removeListener(signal, handler);
      } catch {
        // Teardown must remain best effort.
      }
    }
    this.processShutdownHandlers = [];
  }

  async disposeLifecycle() {
    try {
      if (this.processShutdownRequested === true) await this.blockOwnedTasksOnProcessShutdown();
    } catch {
      // Process teardown must never be held up by task API failures.
    } finally {
      for (const state of this.states.values()) this.clearTimer(state);
      this.states.clear();
      this.listeners.clear();
      this.removeProcessShutdownHooks();
    }
  }

  getState(agent) {
    return this.snapshot(this.stateFor(agent));
  }

  setMode(agent, enabled) {
    const state = this.stateFor(agent);
    state.enabled = enabled === true;
    state.stoppedByProtocol = false;
    state.autonomousMode = false;
    state.pendingAutoMode = undefined;
    state.ownedTaskIds = new Set();
    this.resetAdvancePromptBackoff(state);
    this.persistedModes.set(agent.id, state.enabled);
    this.persistModes();
    if (state.enabled) this.maybeArm(state);
    else {
      this.clearTimer(state);
      state.idleSince = null;
      this.broadcast(state);
    }
    return this.snapshot(state);
  }

  getTasks(agent) {
    // The panel reads the global task list, but it is opened in the current
    // session. Carry that session id so the Worker can project its owned rows
    // as claim_state=mine. Keep a first-agent fallback for older direct RPC
    // callers that still invoke getTasks() without the lookup argument.
    const taskAgentId = nonEmptyString(agent?.id) ?? this.primaryTaskAgentId();
    return readTasksFromApi(this.manager, this.config, this.logger(), taskAgentId);
  }

  /**
   * Read the browser-safe async-work snapshot for exactly one agent owner.
   * listActive() also reaps timeout-bound work, so an expired item enters the
   * registry's recent ring before this snapshot is assembled.
   */
  getAsyncWorks(agent) {
    const ownerId = nonEmptyString(agent?.id);
    const empty = { running: [], recent: [] };
    if (ownerId === undefined) return empty;
    const asyncWork = this.getAsyncWorkService();
    if (asyncWork === undefined || typeof asyncWork.listActive !== "function") return empty;
    try {
      const running = asyncWork.listActive(ownerId)
        .map((work) => asyncWorkView(work, false))
        .filter((work) => work !== null)
        .sort((first, second) => Date.parse(first.started_at) - Date.parse(second.started_at));
      const recent = typeof asyncWork.listRecent === "function"
        ? asyncWork.listRecent(ownerId)
          .map((work) => asyncWorkView(work, true))
          .filter((work) => work !== null)
          .sort((first, second) => Date.parse(second.ended_at) - Date.parse(first.ended_at))
        : [];
      return { running, recent };
    } catch (error) {
      safeLog(() => this.logger(), "warn", `sagitta-auto-advance: async-work snapshot unavailable: ${renderError(error)}`);
      return empty;
    }
  }

  primaryTaskAgentId() {
    try {
      const first = this.ctx?.agents?.list?.()[0];
      return nonEmptyString(first?.id);
    } catch {
      return undefined;
    }
  }

  async resolveNeedHuman(needHumanId) {
    const id = nonEmptyString(needHumanId);
    if (id === undefined) throw new Error("need-human id 必填");
    const payload = await requestTaskApiJson(
      this.manager,
      needHumanResolveApiPath(id),
      undefined,
      {
        method: "POST",
        body: { resolve_kind: "solved", resolved_by: "ripple" }
      }
    );
    const data = unwrapTaskApiPayload(payload);
    if (!isRecord(data)) throw taskApiUnavailable("resolve need-human 响应不是对象");
    return {
      needHumanId: typeof data.id === "string" ? data.id : id,
      taskId: typeof data.task_id === "string" ? data.task_id : "",
      type: needHumanType(data),
      status: typeof data.status === "string" ? data.status : "resolved"
    };
  }

  stateFor(agent) {
    let state = this.states.get(agent);
    if (state !== undefined) return state;
    state = {
      agent,
      enabled: this.persistedModes.get(agent.id) === true,
      timer: undefined,
      timerGeneration: 0,
      idleSince: null,
      injectedAt: null,
      lastAutoMessageId: undefined,
      stoppedByProtocol: false,
      disposed: false,
      requestController: undefined,
      retryAttempt: 0,
      retrying: false,
      degraded: false,
      degradedReason: null,
      cloudSnapshot: undefined,
      ownedTaskIds: new Set(),
      autonomousMode: false,
      pendingAutoMode: undefined,
      lastProtocolNotice: null,
      advancePromptFingerprint: undefined,
      advancePromptInjections: 0,
      advancePromptNextAt: 0
    };
    this.states.set(agent, state);
    return state;
  }

  isLive(state) {
    return !state.disposed && this.ctx.fiber.state === 2 && this.ctx.agents.get(state.agent.id) === state.agent;
  }

  getAsyncWorkService() {
    try {
      return typeof this.ctx.get === "function" ? this.ctx.get("sagitta-async-work", false) : undefined;
    } catch {
      return undefined;
    }
  }

  codexResourceStatus(state) {
    const configuredLimit = Number(this.config.codexMaxConcurrent ?? DEFAULT_CODEX_MAX_CONCURRENT);
    const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : DEFAULT_CODEX_MAX_CONCURRENT;
    const asyncWork = this.getAsyncWorkService();
    if (asyncWork === undefined || typeof asyncWork.listActive !== "function") {
      return { known: false, active: null, limit, saturated: true };
    }
    try {
      const works = asyncWork.listActive(state.agent.id, {});
      if (!Array.isArray(works)) throw new Error("listActive did not return an array");
      const active = works.filter((work) =>
        (work?.status === undefined || work.status === "running") &&
        String(work?.kind ?? "").trim().toLowerCase() === "codex"
      ).length;
      return { known: true, active, limit, saturated: active >= limit };
    } catch (error) {
      safeLog(() => this.logger(), "warn", `sagitta-auto-advance: codex resource check failed: ${renderError(error)}`);
      return { known: false, active: null, limit, saturated: true };
    }
  }

  resourceLimitedOwnedTasks(state, snapshot = state.cloudSnapshot, resourceStatus = this.codexResourceStatus(state)) {
    if (resourceStatus.saturated !== true) return [];
    return this.ownedInProgressTasks(state, snapshot).filter((task) =>
      task?.pending_status === null && !this.hasRunningWork(state.agent, task.task_id ?? task.id) && taskNeedsCodex(task)
    );
  }

  advancePromptFingerprint(tasks) {
    return (Array.isArray(tasks) ? tasks : [])
      .map((task) => ({
        id: task?.task_id ?? task?.id ?? "",
        status: task?.status ?? "",
        pending: task?.pending_status ?? null,
        updated: task?.updated_at ?? task?.updatedAt ?? null,
        title: task?.title ?? task?.text ?? "",
        acceptance: task?.acceptance ?? ""
      }))
      .sort((first, second) => String(first.id).localeCompare(String(second.id)))
      .map((task) => JSON.stringify(task))
      .join("|");
  }

  resetAdvancePromptBackoff(state) {
    state.advancePromptFingerprint = undefined;
    state.advancePromptInjections = 0;
    state.advancePromptNextAt = 0;
  }

  advancePromptSettings() {
    const cooldown = Number(this.config.advancePromptCooldownMs ?? DEFAULT_ADVANCE_PROMPT_COOLDOWN_MS);
    const factor = Number(this.config.advancePromptBackoffFactor ?? DEFAULT_ADVANCE_PROMPT_BACKOFF_FACTOR);
    const maxCooldown = Number(this.config.advancePromptMaxCooldownMs ?? DEFAULT_ADVANCE_PROMPT_MAX_COOLDOWN_MS);
    const maxInjections = Number(this.config.advancePromptMaxInjections ?? DEFAULT_ADVANCE_PROMPT_MAX_INJECTIONS);
    const normalizedCooldown = Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : DEFAULT_ADVANCE_PROMPT_COOLDOWN_MS;
    const normalizedFactor = Number.isFinite(factor) && factor >= 1 ? factor : DEFAULT_ADVANCE_PROMPT_BACKOFF_FACTOR;
    const normalizedMaxCooldown = Number.isFinite(maxCooldown) && maxCooldown >= 0
      ? Math.max(normalizedCooldown, maxCooldown) : DEFAULT_ADVANCE_PROMPT_MAX_COOLDOWN_MS;
    const normalizedMaxInjections = Number.isInteger(maxInjections) && maxInjections > 0
      ? maxInjections : DEFAULT_ADVANCE_PROMPT_MAX_INJECTIONS;
    return {
      cooldown: normalizedCooldown,
      factor: normalizedFactor,
      maxCooldown: normalizedMaxCooldown,
      maxInjections: normalizedMaxInjections
    };
  }

  canInjectAdvancePrompt(state, tasks, now = Date.now()) {
    const fingerprint = this.advancePromptFingerprint(tasks);
    if (state.advancePromptFingerprint !== fingerprint) {
      state.advancePromptFingerprint = fingerprint;
      state.advancePromptInjections = 0;
      state.advancePromptNextAt = 0;
    }
    const settings = this.advancePromptSettings();
    return state.advancePromptInjections < settings.maxInjections && now >= (state.advancePromptNextAt ?? 0);
  }

  recordAdvancePrompt(state, tasks, now = Date.now()) {
    const fingerprint = this.advancePromptFingerprint(tasks);
    if (state.advancePromptFingerprint !== fingerprint) {
      state.advancePromptFingerprint = fingerprint;
      state.advancePromptInjections = 0;
    }
    const settings = this.advancePromptSettings();
    state.advancePromptInjections += 1;
    const exponent = Math.max(0, state.advancePromptInjections - 1);
    const delay = Math.min(settings.maxCooldown, settings.cooldown * Math.pow(settings.factor, exponent));
    state.advancePromptNextAt = now + delay;
  }

  advancePromptRetryDelay(state, now = Date.now()) {
    const remaining = Math.max(0, Number(state.advancePromptNextAt ?? 0) - now);
    return remaining > 0 ? remaining : TASK_RECHECK_DELAY_MS;
  }

  hasRunningWork(agent, taskId) {
    for (const candidate of this.ctx.agents.list()) {
      if (candidate === agent) continue;
      if (!this.ctx.agents.isOwnedBy(candidate.id, agent) || candidate.status !== "running") continue;
      const candidateTaskId = candidate.task_id ?? candidate.taskId;
      if (taskId === undefined || candidateTaskId === undefined || candidateTaskId === taskId) return true;
    }

    // Stage 4's generic registry is the only bounded-work source. An absent
    // or malformed service is treated as unavailable and blocks progress;
    // auto-advance must never assume an unobserved async operation is finished.
    const asyncWork = this.getAsyncWorkService();
    if (asyncWork === undefined) return true;
    if (typeof asyncWork.listActive !== "function") {
      this.logger()?.warn?.("sagitta-auto-advance: async-work registry has no listActive method");
      return true;
    }
    try {
      const works = asyncWork.listActive(agent.id, taskId === undefined ? {} : { taskId });
      if (!Array.isArray(works)) throw new Error("listActive did not return an array");
      return works.some((work) => {
        if (work?.status !== undefined && work.status !== "running") return false;
        const workTaskId = work?.task_id ?? work?.taskId;
        return taskId === undefined || workTaskId === taskId;
      });
    } catch (error) {
      this.logger()?.warn?.(`sagitta-auto-advance: async-work check failed: ${renderError(error)}`);
      return true;
    }
  }

  hasPendingWork(agent, taskId) {
    return hasPendingInbox(agent) || this.hasRunningWork(agent, taskId);
  }

  ownedTaskSet(state) {
    if (state.ownedTaskIds instanceof Set) return state.ownedTaskIds;
    state.ownedTaskIds = new Set(Array.isArray(state.ownedTaskIds) ? state.ownedTaskIds : []);
    return state.ownedTaskIds;
  }

  isOwnedTask(state, task) {
    const id = task?.task_id ?? task?.id;
    if (id === undefined) return false;
    if (this.ownedTaskSet(state).has(id)) return true;
    if (task?.claim_state === "mine" || task?.mine === true) return true;
    // Before task-ownership-p2, an in_progress row had no claim_state. Keep
    // that compatibility behavior; an explicit "claimed" always means that
    // another lease owns it unless this process recorded the task locally.
    return task?.status === "in_progress" && task?.claim_state === undefined;
  }

  syncOwnedTasks(state, snapshot) {
    const owned = this.ownedTaskSet(state);
    for (const task of snapshot?.items ?? []) {
      const id = task?.task_id ?? task?.id;
      if (id === undefined) continue;
      if (taskIsTerminal(task)) owned.delete(id);
      if (task?.claim_state === "mine" || task?.mine === true) owned.add(id);
    }
    for (const id of [...owned]) {
      const task = (snapshot?.items ?? []).find((item) => (item?.task_id ?? item?.id) === id);
      if (task === undefined || taskIsTerminal(task) || task.status !== "in_progress") owned.delete(id);
    }
  }

  ownedInProgressTasks(state, snapshot = state.cloudSnapshot) {
    return (snapshot?.items ?? []).filter((task) =>
      task?.status === "in_progress" && this.isOwnedTask(state, task)
    );
  }

  actionableOwnedTasks(state, snapshot = state.cloudSnapshot, resourceStatus = this.codexResourceStatus(state)) {
    return this.ownedInProgressTasks(state, snapshot).filter((task) =>
      // need 型 open 条目只阻塞 done 申请；need 之外仍可自主推进的工作不应被挡住。
      task?.pending_status === null &&
      !this.hasRunningWork(state.agent, task.task_id ?? task.id) &&
      !(resourceStatus.saturated === true && taskNeedsCodex(task))
    );
  }

  openClaimableTasks(state, snapshot = state.cloudSnapshot) {
    if (!snapshot?.runnable) return [];
    return snapshot.runnable.filter((task) =>
      task?.status === "open" && !this.isOwnedTask(state, task) && !hasOpenNeedHuman(task)
    );
  }

  availableRunnableTasks(state, snapshot = state.cloudSnapshot) {
    return this.openClaimableTasks(state, snapshot);
  }

  canAutonomouslyDrive(state, snapshot = state.cloudSnapshot) {
    return this.actionableOwnedTasks(state, snapshot).length > 0;
  }

  readyToDrive(state) {
    if (!this.isLive(state) || !state.enabled || state.stoppedByProtocol || state.agent.status !== "idle") return false;
    if (hasPendingInbox(state.agent)) return false;
    // Before the first cloud read, arm one probe. The probe itself is not an
    // autonomous continuation: after the snapshot, only owned work keeps the
    // poll alive. Open tasks receive one lightweight claim hint in onTimer.
    if (state.cloudSnapshot !== undefined) {
      return this.ownedInProgressTasks(state).length > 0;
    }
    return true;
  }

  clearTimer(state) {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.requestController !== undefined) {
      try {
        state.requestController.abort();
      } catch {
        // Abort is best effort; generation still invalidates the response.
      }
      state.requestController = undefined;
    }
    state.timerGeneration += 1;
  }

  resetTimer(state, reason) {
    this.clearTimer(state);
    state.idleSince = null;
    if (this.readyToDrive(state)) this.armTimer(state);
    else this.broadcast(state, reason);
  }

  maybeArm(state) {
    if (!this.readyToDrive(state)) {
      this.clearTimer(state);
      state.idleSince = null;
      this.broadcast(state);
      return;
    }
    if (state.timer !== undefined) return;
    this.armTimer(state);
  }

  armTimer(state) {
    if (!this.readyToDrive(state)) return;
    const generation = ++state.timerGeneration;
    state.retrying = false;
    state.idleSince = Date.now();
    state.timer = setTimeout(() => { void this.onTimer(state, generation); }, this.config.idleTimeoutMs);
    state.timer.unref?.();
    this.broadcast(state);
  }

  isCurrentRun(state, generation) {
    return state.timerGeneration === generation && this.isLive(state) && state.enabled &&
      !state.stoppedByProtocol && state.agent.status === "idle" && !hasPendingInbox(state.agent);
  }

  queuePrompt(state, generation, text, summary, reason, { autonomous = true } = {}) {
    if (!this.isCurrentRun(state, generation)) return false;
    return this.queueNotice(state, text, summary, reason, { autonomous });
  }

  queueNotice(state, text, summary, reason, { autonomous = false, allowDisabled = false } = {}) {
    if (state === undefined || state.disposed === true || (!allowDisabled && state.enabled !== true) || !this.isLive(state)) return false;
    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "plugin",
        plugin: PLUGIN_ID,
        form: "notice",
        summary,
      }
    });
    state.lastAutoMessageId = message.id;
    state.autonomousMode = autonomous;
    state.pendingAutoMode = autonomous ? "away" : "present";
    state.injectedAt = Date.now();
    state.idleSince = null;
    agentFollowup(state.agent, message);
    this.broadcast(state, reason);
    return true;
  }

  observeTaskTools(state, message) {
    const transitions = [];
    let ownershipChanged = false;
    for (const call of toolCallBlocks(message)) {
      const name = String(toolName(call) ?? "");
      const args = toolArguments(call);
      const id = taskIdFromArgs(args) ?? taskIdFromArgs(call);
      if (id === undefined) continue;
      if (name === "task_claim" || name.endsWith(".task_claim")) {
        // A successful claim projection is the local ownership hint. The
        // cloud claim_state=mine remains authoritative after restart; a bare
        // request is not enough because it may be a rejected claim.
        if (toolSucceeded(call)) {
          this.ownedTaskSet(state).add(id);
          ownershipChanged = true;
        }
      } else if (name === "task_release" || name.endsWith(".task_release")) {
        this.ownedTaskSet(state).delete(id);
        ownershipChanged = true;
      }
      if (name === "task_update" || name.endsWith(".task_update")) {
        if (args.status === "in_progress") {
          this.ownedTaskSet(state).add(id);
          ownershipChanged = true;
        }
      }
      // v3: ordinary task_update done/blocked is a direct terminal write.
      // Autonomous close remains challengeable only through round-close,
      // whose Worker path creates pending_status and requires confirm.
      if (name === "task_round_close" || name.endsWith(".task_round_close")) {
        if (args.action === "done" || args.action === "blocked") transitions.push({ id, args });
      }
    }
    return { transitions, ownershipChanged };
  }

  findTask(state, id) {
    return (state.cloudSnapshot?.items ?? []).find((task) => (task?.task_id ?? task?.id) === id);
  }

  async handleAssistantMessage(state, message) {
    if (state?.disposed === true || state?.enabled !== true) return { ignored: true };
    const observed = this.observeTaskTools(state, message);
    if (observed.ownershipChanged) this.maybeArm(state);

    const terminalRequests = observed.transitions.filter(({ id, args }) => !isTempTask(this.findTask(state, id), args));
    if (terminalRequests.length > 0) {
      const challenge = state.autonomousMode === true ? AUTONOMOUS_CHALLENGE : IN_PERSON_CHALLENGE;
      const taskLines = terminalRequests.map(({ id, args }) => `task_id=${id} → ${args.status ?? args.action}`);
      this.queueNotice(
        state,
        `${challenge}\n涉及任务：${taskLines.join("，")}`,
        state.autonomousMode === true ? "autonomous task challenge" : "in-person task challenge",
        "injected: task-termination-challenge",
        { autonomous: state.autonomousMode === true }
      );
      return { ok: false, challenged: true, taskIds: terminalRequests.map(({ id }) => id) };
    }

    if (isExactStopMessage(message)) return this.stopByProtocol(state);
    return observed.transitions.length > 0 || observed.ownershipChanged ? { ok: true } : { ignored: true };
  }

  async taskSnapshotForTurnEnd(state) {
    if (typeof this.manager?.request !== "function") return undefined;
    try {
      // A terminal request may have landed after the last idle poll. Refresh
      // before challenging so pending_done/pending_blocked is authoritative.
      return await readCloudTaskSnapshotStrict(this.manager, this.config, undefined, this.logger(), state.agent.id);
    } catch {
      // Fail closed: an unavailable cloud snapshot must not manufacture a
      // turn-ending challenge from stale local state.
      return undefined;
    }
  }

  async handleTurnEnd(state, event) {
    if (state?.disposed === true || state?.enabled !== true || state.autonomousMode !== true) return { ignored: true };
    if (event?.data?.reason?.kind === "aborted") return { ignored: true };
    if (hasPendingInbox(state.agent)) return { ignored: true };

    const snapshot = await this.taskSnapshotForTurnEnd(state);
    if (snapshot === undefined || !this.isLive(state) || state.enabled !== true || state.autonomousMode !== true) {
      return { ignored: true };
    }
    state.cloudSnapshot = snapshot;
    this.syncOwnedTasks(state, snapshot);
    if (hasPendingInbox(state.agent)) return { ignored: true };

    const unfinished = this.actionableOwnedTasks(state, snapshot).filter((task) => !isTempTask(task));
    if (unfinished.length === 0) return { ok: true };

    if (!this.canInjectAdvancePrompt(state, unfinished)) {
      return { ok: true, deferred: true, taskIds: unfinished.map((task) => task.task_id ?? task.id) };
    }

    const taskLines = unfinished.map((task) => `task_id=${task.task_id ?? task.id}`);
    const queued = this.queueNotice(
      state,
      `${AUTONOMOUS_TURN_END_CHALLENGE}\n未收尾任务：${taskLines.join("，")}`,
      "autonomous in-progress task challenge",
      "injected: autonomous-in-progress-challenge",
      { autonomous: true }
    );
    if (queued) this.recordAdvancePrompt(state, unfinished);
    return { ok: false, challenged: true, taskIds: unfinished.map((task) => task.task_id ?? task.id) };
  }

  async handleStopMarker(state) {
    return this.stopByProtocol(state);
  }

  scheduleCloudRetry(state, generation, error) {
    if (!this.isCurrentRun(state, generation)) return;
    const attempt = state.retryAttempt;
    const baseDelay = CLOUD_RETRY_DELAYS_MS[Math.min(attempt, CLOUD_RETRY_DELAYS_MS.length - 1)];
    const jitter = 1 + ((Math.random() * 2 - 1) * CLOUD_RETRY_JITTER);
    const delay = Math.min(CLOUD_RETRY_DELAYS_MS[CLOUD_RETRY_DELAYS_MS.length - 1], Math.max(1000, Math.round(baseDelay * jitter)));
    state.retryAttempt = Math.min(attempt + 1, CLOUD_RETRY_DELAYS_MS.length - 1);
    state.retrying = true;
    state.degraded = true;
    state.degradedReason = renderError(error);
    state.idleSince = null;
    state.timer = setTimeout(() => { void this.onTimer(state, generation); }, delay);
    state.timer.unref?.();
    this.broadcast(state, "defer: task-api-unavailable");
  }

  scheduleTaskRecheck(state, generation, reason = "defer: task-driven-wait", delayMs = TASK_RECHECK_DELAY_MS) {
    if (!this.isCurrentRun(state, generation) || state.timer !== undefined) return;
    state.retrying = true;
    state.idleSince = null;
    // Keep pending/running work quiet for longer than the ordinary 15s idle
    // probe; this is a recheck, not another prompt injection cadence.
    const delay = Number.isFinite(Number(delayMs)) && Number(delayMs) >= 0 ? Number(delayMs) : TASK_RECHECK_DELAY_MS;
    state.timer = setTimeout(() => { void this.onTimer(state, generation); }, delay);
    state.timer.unref?.();
    this.broadcast(state, reason);
  }

  autoStopNoInProgressTasks(state) {
    state.enabled = false;
    state.stoppedByProtocol = true;
    state.autonomousMode = false;
    state.pendingAutoMode = undefined;
    this.ownedTaskSet(state).clear();
    this.persistedModes.set(state.agent.id, false);
    this.persistModes();
    this.clearTimer(state);
    state.idleSince = null;
    this.broadcast(state, "autostop: no-in-progress");
  }

  // Compatibility alias for callers from the pre-v2 service.
  autoStopNoRunnableTasks(state) {
    this.autoStopNoInProgressTasks(state);
  }

  async onTimer(state, generation) {
    const retrying = state.retrying === true;
    state.retrying = false;
    try {
      if (!this.isCurrentRun(state, generation)) return;
      state.timer = undefined;
      if (!retrying && !this.readyToDrive(state)) {
        state.idleSince = null;
        this.broadcast(state, "timer-not-ready");
        return;
      }

      const controller = new AbortController();
      state.requestController = controller;
      let snapshot;
      try {
        snapshot = await readCloudTaskSnapshotStrict(this.manager, this.config, controller.signal, this.logger(), state.agent.id);
      } finally {
        if (state.requestController === controller) state.requestController = undefined;
      }

      // A user message, agent status transition, disable, dispose, or timer
      // reset invalidates this generation while the network request awaited.
      if (!this.isCurrentRun(state, generation)) return;
      state.cloudSnapshot = snapshot;
      this.syncOwnedTasks(state, snapshot);
      state.retryAttempt = 0;
      state.degraded = false;
      state.degradedReason = null;

      const owned = this.ownedInProgressTasks(state, snapshot);
      const codexResource = this.codexResourceStatus(state);
      const actionable = this.actionableOwnedTasks(state, snapshot, codexResource);
      if (actionable.length > 0) {
        if (!this.canInjectAdvancePrompt(state, actionable)) {
          this.scheduleTaskRecheck(
            state,
            generation,
            "defer: advance-prompt-backoff",
            this.advancePromptRetryDelay(state)
          );
          return;
        }
        const lines = actionable.map((task) => {
          const title = typeof task.title === "string" ? task.title.trim() : "";
          const project = typeof task.project === "string" && task.project.trim() ? ` project=${JSON.stringify(task.project.trim())}` : "";
          const needCount = openNeedHumanCount(task);
          const needNote = needCount > 0 ? ` ⚠ 有 ${needCount} 条待涟漪处理项，need 之外部分继续推进` : "";
          const accCount = acceptanceLineCount(task.acceptance);
          const accNote = accCount > 0 ? ` acceptance=${accCount}项期望目标(见下)` : "";
          return `- task_id=${task.task_id} status=in_progress${project} title=${JSON.stringify(title)}${accNote}${needNote}`;
        });
        const prompt = [AUTONOMOUS_PROMPT, "", "当前我认领的 in_progress 任务：", ...lines].join("\n");
        // 涟漪语义（09-07）：把每个任务的 acceptance 完整清单附在任务列表后，
        // 提醒逐项核对——每一项是否还有可在人工介入之前推进的空间。
        // 插件无 LLM 判断不了满足与否；注入完整清单让模型自己逐项对照。
        const accBlocks = actionable
          .map((task) => {
            const id = task.task_id ?? task.id;
            const accText = acceptanceBlock(task.acceptance);
            return accText ? `\n[${id}] 期望目标：\n${accText}` : "";
          })
          .filter((block) => block.length > 0);
        const fullPrompt = accBlocks.length > 0
          ? `${prompt}\n\n请逐项核对每个任务的期望目标：确认每一项是否还有可在人工介入之前推进的空间；有就推进，没有才按收口规则处理——需人工且【除 need-human 外已无其他可独自推进项】才 need-human+blocked；重大决策发 notify（不阻塞 done）；期望目标全达则 done。${accBlocks.join("\n")}`
          : prompt;
        const queued = this.queuePrompt(state, generation, fullPrompt, "owned in-progress tasks", "injected: owned-in-progress", { autonomous: true });
        if (queued) this.recordAdvancePrompt(state, actionable);
        return;
      }

      if (owned.length > 0) {
        const resourceLimited = this.resourceLimitedOwnedTasks(state, snapshot, codexResource);
        if (resourceLimited.length > 0) {
          // Resource waiting must not consume the continuation-prompt budget;
          // after a slot is released the unchanged task may receive one normal
          // prompt again, subject to the ordinary backoff from that point.
          this.resetAdvancePromptBackoff(state);
          this.scheduleTaskRecheck(state, generation, "defer: codex-resource-limit");
          return;
        }
        // Need 型 open 条目不阻塞推进；走到这里仅表示所有 owned 任务都在
        // 等 pending 申请确认或绑定的有界工作运行中。不要重复注入，安静轮询。
        this.scheduleTaskRecheck(state, generation, "defer: pending-or-running-work");
        return;
      }

      const openTasks = this.openClaimableTasks(state, snapshot);
      if (openTasks.length > 0) {
        const prompt = `有 ${openTasks.length} 个任务可认领；需要开工时请调用 task_claim。当前没有我已认领的 in_progress 任务，本提示不要求立即自主推进。`;
        this.queuePrompt(state, generation, prompt, "open task claim hint", "injected: open-task-hint", { autonomous: false });
        return;
      }

      this.autoStopNoInProgressTasks(state);
    } catch (error) {
      if (!this.isCurrentRun(state, generation)) return;
      if (error?.code === "task-api-unavailable") {
        safeLog(() => this.logger(), "warn", `sagitta-auto-advance: cloud snapshot unavailable for agent "${state.agent?.id ?? "unknown"}": ${renderError(error)}`);
        this.scheduleCloudRetry(state, generation, error);
      } else {
        state.lastAutoMessageId = undefined;
        state.idleSince = null;
        safeLog(() => this.logger(), "warn", `sagitta-auto-advance: continuation injection failed for agent "${state.agent?.id ?? "unknown"}": ${renderError(error)}`);
        this.broadcast(state, "queue-failed");
        this.maybeArm(state);
      }
    }
  }

  stopByProtocol(state) {
    if (!isTerminalCloudSnapshot(state.cloudSnapshot)) {
      state.lastProtocolNotice = "仍有未完成任务；停止自主推进不合法";
      safeLog(() => this.logger(), "warn", "sagitta-auto-advance: stop marker rejected；仍有未完成任务");
      this.broadcast(state, "stop-protocol-rejected");
      return false;
    }
    state.enabled = false;
    state.stoppedByProtocol = true;
    state.autonomousMode = false;
    state.pendingAutoMode = undefined;
    this.ownedTaskSet(state).clear();
    this.persistedModes.set(state.agent.id, false);
    this.persistModes();
    this.clearTimer(state);
    state.idleSince = null;
    state.retrying = false;
    this.broadcast(state, "stop-protocol");
    return true;
  }

  async shutdownSnapshotFor(state, taskApi, signal) {
    if (state.cloudSnapshot !== undefined) return state.cloudSnapshot;
    if (typeof taskApi?.request !== "function") return undefined;
    try {
      return await readCloudTaskSnapshotStrict(taskApi, this.config, signal, this.logger(), state.agent.id);
    } catch {
      return undefined;
    }
  }

  async blockOwnedTasksOnProcessShutdown() {
    const states = [...this.states.values()];
    for (const state of states) {
      state.disposed = true;
      this.clearTimer(state);
    }
    if (states.length === 0) return;

    const taskApi = this.manager;
    if (typeof taskApi?.request !== "function") return;

    const controller = new AbortController();
    let deadlineTimer;
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => {
        controller.abort();
        resolve();
      }, PROCESS_SHUTDOWN_TASK_BUDGET_MS);
    });
    const work = (async () => {
      const groups = await Promise.all(states.map(async (state) => {
        const snapshot = await this.shutdownSnapshotFor(state, taskApi, controller.signal);
        return snapshot === undefined ? [] : this.ownedInProgressTasks(state, snapshot);
      }));
      const patches = [];
      for (let index = 0; index < states.length; index++) {
        for (const task of groups[index]) {
          const taskId = nonEmptyString(task?.task_id ?? task?.id);
          if (taskId === undefined) continue;
          patches.push(requestTaskApiJson(
            taskApi,
            taskPatchApiPath(taskId),
            controller.signal,
            {
              method: "PATCH",
              agentId: states[index].agent.id,
              body: { status: "blocked", blocked_reason: PROCESS_SHUTDOWN_BLOCKED_REASON }
            }
          ));
        }
      }
      await Promise.allSettled(patches);
    })().catch(() => {
      // Individual API failures are already best effort during shutdown.
    });
    try {
      await Promise.race([work, deadline]);
    } catch {
      // A signal path is best effort; never reject fiber.dispose().
    } finally {
      clearTimeout(deadlineTimer);
      controller.abort();
    }
  }

  touchOwners(agent, reason) {
    for (const state of this.states.values()) {
      if (state.agent === agent || this.ctx.agents.isOwnedBy(agent.id, state.agent)) this.resetTimer(state, reason);
    }
  }

  touchJobOwner(owner, reason) {
    for (const state of this.states.values()) {
      if (owner === undefined || owner === state.agent || this.ctx.agents.isOwnedBy(owner.id, state.agent)) this.resetTimer(state, reason);
    }
  }

  snapshot(state) {
    return {
      enabled: state.enabled,
      mode: state.enabled ? "auto" : "chat",
      idleSince: state.idleSince,
      injectedAt: state.injectedAt,
      ready: this.canAutonomouslyDrive(state),
      hasPendingWork: this.hasPendingWork(state.agent),
      stoppedByProtocol: state.stoppedByProtocol,
      agentStatus: typeof state.agent.status === "string" ? state.agent.status : "unknown",
      degraded: state.degraded === true,
      degradedReason: state.degradedReason ?? null
    };
  }

  broadcast(state, reason) {
    const snapshot = this.snapshot(state);
    for (const listener of [...this.listeners]) {
      try {
        listener({ agent: state.agent, state: snapshot, reason });
      } catch (error) {
        this.logger()?.warn?.(`sagitta-auto-advance: status listener failed: ${renderError(error)}`);
      }
    }
    try {
      this.ctx.emit?.(STATUS_EVENT, { agent: state.agent.id, state: snapshot, reason });
    } catch (error) {
      this.logger()?.debug?.(`sagitta-auto-advance: status event unavailable: ${renderError(error)}`);
    }
  }

  logger() {
    return this.ctx.logger;
  }

  loadModes() {
    if (!existsSync(this.config.statePath)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(this.config.statePath, "utf8"));
      const modes = new Map();
      if (!isRecord(raw?.sessions)) return modes;
      for (const [id, enabled] of Object.entries(raw.sessions)) if (typeof id === "string" && typeof enabled === "boolean") modes.set(id, enabled);
      return modes;
    } catch (error) {
      this.logger()?.warn?.(`sagitta-auto-advance: state file ignored: ${renderError(error)}`);
      return new Map();
    }
  }

  persistModes() {
    try {
      const parent = dirname(this.config.statePath);
      if (parent && parent !== ".") mkdirSync(parent, { recursive: true });
      writeFileSync(this.config.statePath, `${JSON.stringify({ version: 1, sessions: Object.fromEntries(this.persistedModes) }, null, 2)}\n`, "utf8");
    } catch (error) {
      this.logger()?.warn?.(`sagitta-auto-advance: mode persistence failed: ${renderError(error)}`);
    }
  }
}

function agentFollowup(agent, message) {
  agent.followup(message);
}

function taskApiPath(page = 1, size = DEFAULT_TASK_PAGE_SIZE) {
  const query = new URLSearchParams({ page: String(page), size: String(size), include_temp: "1" });
  // The default Worker projection hides temp rows. Include only the current
  // agent's valid temp lease; normal rows are unchanged by this flag.
  return `/task?${query.toString()}`;
}

function taskPatchApiPath(taskId) {
  return `/task/${encodeURIComponent(taskId)}`;
}

function needHumanApiPath() {
  return "/need-human?status=open";
}

function needHumanResolveApiPath(needHumanId) {
  return `/task/need-human/${encodeURIComponent(needHumanId)}/resolve`;
}

function taskApiUpdatedAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cleanBody(value) {
  // 去掉 markdown checkbox/列表前缀与残留标记，只留描述
  return value
    .replace(/^\s*[-*]\s*\[(?: |x|X)\]\s*/u, "")
    .replace(/^\s*[-*]\s+/u, "")
    .replace(/\*\*/gu, "")
    .replace(/`/gu, "")
    .trim();
}

function acceptanceLines(value) {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return value.match(/^\s*-\s+\[[ xX]\]\s+\S.*$/gmu) ?? [];
}

function acceptanceLineCount(value) {
  return acceptanceLines(value).length;
}

function acceptanceBlock(value) {
  // 涟漪语义（09-07）：acceptance 是"期望目标 checklist"，插件无 LLM 判断
  // 不了是否满足；注入的价值是把完整清单带给模型，让它逐项检查每一项
  // 是否还有可在人工介入之前推进的空间。返回 checklist 行（原样保留
  // `- [ ]`/`- [x]` 前缀），空则返回空串。
  const lines = acceptanceLines(value);
  if (lines.length === 0) return "";
  return lines.map((l) => l.trim()).join("\n");
}

function mapApiTask(item) {
  const titleValue = item?.title ?? item?.text;
  const title = cleanMarkdown(typeof titleValue === "string" ? titleValue : "") || "未命名需求";
  const project = typeof item?.project === "string" && item.project.trim() ? item.project.trim() : "未分类";
  const openNeedHumans = openNeedHumanCount(item);
  const temp = isTempTask(item);
  const rawKind = taskType(item);
  const task = {
    text: title,                       // 项目进度区（normalizeTask 用 text + done）
    title,                             // 待处理需求区用
    done: item?.status === "done",     // tasksSchema 硬性要求（boolean）
    status: typeof item?.status === "string" ? item.status : "open",
    acceptance: typeof item?.acceptance === "string" ? item.acceptance : "",
    kind: temp ? "temp" : rawKind || "task",
    claimState: typeof item?.claim_state === "string" ? item.claim_state : undefined,
    updatedAt: taskApiUpdatedAt(item?.updated_at ?? item?.updatedAt),
    createdAt: taskApiUpdatedAt(item?.created_at ?? item?.createdAt),
    pendingStatus: item?.pending_status ?? null,
    blockedReason: item?.blocked_reason ?? null,
    blockedKind: item?.blocked_kind ?? null,
    nextAction: item?.next_action ?? null,
    evidenceJson: Array.isArray(item?.evidence_json) ? item.evidence_json : [],
    doneAt: item?.done_at ?? null,
    confirmationId: item?.confirmation_id ?? null,
    type: item?.type ?? item?.task_type ?? null,
    // A notify is visible in the inbox but does not block task progress.
    open_need_human: openNeedHumans > 0,
    open_need_human_count: openNeedHumans,
    project,                           // 分组键
    hasCheckbox: item?.checkbox === 1 || item?.checkbox === "1",
    body: typeof item?.body === "string" ? cleanBody(item.body) : "",
  };
  const id = typeof item?.task_id === "string" ? item.task_id : typeof item?.id === "string" ? item.id : undefined;
  if (id !== undefined) task.task_id = id;
  return task;
}

function mapApiTaskSnapshot(items, pendingRequests = [], pendingRequestsError) {
  let updatedAt = null;
  const byProject = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const task = mapApiTask(item);
    const itemUpdatedAt = task.updatedAt;
    if (itemUpdatedAt !== null && (updatedAt === null || itemUpdatedAt > updatedAt)) updatedAt = itemUpdatedAt;
    if (!byProject.has(task.project)) byProject.set(task.project, []);
    byProject.get(task.project).push(task);
  }
  const sections = [...byProject.entries()]
    .map(([title, items]) => ({ title, items }))
    .sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title));
  return {
    updatedAt,
    sections,
    pendingRequests: Array.isArray(pendingRequests) ? pendingRequests : [],
    ...(typeof pendingRequestsError === "string" && pendingRequestsError.length > 0 ? { pendingRequestsError } : {}),
  };
}

function taskApiUnavailableFrom(error) {
  if (error?.code === "task-api-unavailable") return error;
  return taskApiUnavailable(renderError(error), error);
}

async function requestTaskApiJson(manager, path, signal, options = {}) {
  const method = options.method ?? "GET";
  if (typeof manager?.request !== "function") throw taskApiUnavailable("sagitta-manager.request 不可用");
  const requestHeaders = { Accept: "application/json", "Accept-Encoding": "identity" };
  const taskAgentId = nonEmptyString(options.agentId);
  if (taskAgentId !== undefined) requestHeaders["X-Agent-Id"] = taskAgentId;
  const init = { method, headers: requestHeaders };
  if (options.body !== undefined) {
    requestHeaders["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  if (signal !== undefined) init.signal = signal;
  let response;
  try {
    response = await manager.request(path, init);
  } catch (error) {
    throw taskApiUnavailable(`请求失败：${renderError(error)}`, error);
  }
  if (!response || typeof response.text !== "function") throw taskApiUnavailable("sagitta-manager.request 返回了无效响应");
  let bodyText;
  try {
    bodyText = await response.text();
  } catch (error) {
    throw taskApiUnavailable(`读取响应失败：${renderError(error)}`, error);
  }
  if (response.ok !== true) throw taskApiUnavailable(`HTTP ${Number.isInteger(Number(response.status)) ? response.status : "未知"}`);
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    throw taskApiUnavailable("响应不是合法 JSON", error);
  }
  return payload;
}

async function requestTaskApiPage(manager, config, page, signal, logger, agentId) {
  const payload = await requestTaskApiJson(manager, taskApiPath(page, config.taskPageSize), signal, { agentId });
  try {
    const pageData = validateCloudTaskPage(payload);
    logger?.debug?.(`sagitta-auto-advance: task API returned page=${pageData.page} items=${pageData.items.length} total=${pageData.total}`);
    return pageData;
  } catch (error) {
    throw taskApiUnavailableFrom(error);
  }
}

function unwrapTaskApiPayload(value) {
  return isRecord(value) && value.ok === true && isRecord(value.data) ? value.data : value;
}

function mapNeedHumanItem(item) {
  if (!isRecord(item)) return undefined;
  const content = cleanMarkdown(typeof item.content === "string" ? item.content : "") || "未命名需求";
  const taskTitle = cleanMarkdown(typeof item.task_title === "string" ? item.task_title : "");
  const taskProject = cleanMarkdown(typeof item.task_project === "string" ? item.task_project : "");
  const taskId = typeof item.task_id === "string" ? item.task_id.trim() : "";
  const taskLabel = taskTitle || taskId || "未命名任务";
  const projectLabel = taskProject.length > 0 ? `（项目：${taskProject}）` : "";
  const suggestion = cleanMarkdown(typeof item.suggestion === "string" ? item.suggestion : "");
  const body = [`所属任务：${taskLabel}${projectLabel}`, suggestion.length > 0 ? `建议：${suggestion}` : ""]
    .filter((value) => value.length > 0)
    .join(" · ");
  return {
    title: content,
    hasCheckbox: false,
    body,
    type: needHumanType(item),
    needHumanId: typeof item.id === "string" ? item.id : typeof item.nh_id === "string" ? item.nh_id : "",
    taskId,
    taskTitle,
    project: taskProject,
    createdAt: taskApiUpdatedAt(item.created_at ?? item.createdAt)
  };
}

async function readOpenNeedHumanFromApi(manager, agentId) {
  const payload = await requestTaskApiJson(manager, needHumanApiPath(), undefined, { agentId });
  const data = unwrapTaskApiPayload(payload);
  const rawItems = data?.items ?? data?.need_humans ?? data?.needHuman;
  if (!Array.isArray(rawItems)) throw taskApiUnavailable("/need-human 响应缺少 items 列表");
  return rawItems
    .filter((item) => item?.status === undefined || item.status === "open")
    .map(mapNeedHumanItem)
    .filter((item) => item !== undefined)
    .sort((first, second) => (second.createdAt ?? Number.NEGATIVE_INFINITY) - (first.createdAt ?? Number.NEGATIVE_INFINITY));
}

async function readCloudTaskSnapshotStrict(manager, config, signal, logger, agentId) {
  try {
    const first = await requestTaskApiPage(manager, config, 1, signal, logger, agentId);
    const pageCount = Math.max(1, Math.ceil(first.total / first.size));
    const pages = [first];
    for (let page = 2; page <= pageCount; page++) {
      pages.push(await requestTaskApiPage(manager, config, page, signal, logger, agentId));
    }
    return splitCloudTaskSnapshotStrict({ pages });
  } catch (error) {
    throw taskApiUnavailableFrom(error);
  }
}

async function readTasksFromApi(manager, config, logger, agentId) {
  const snapshot = await readCloudTaskSnapshotStrict(manager, config, undefined, logger, agentId);
  let pendingRequests = [];
  let pendingRequestsError;
  try {
    pendingRequests = await readOpenNeedHumanFromApi(manager, agentId);
  } catch (error) {
    pendingRequestsError = renderError(error);
    logger?.warn?.(`sagitta-auto-advance: open need-human unavailable; showing an empty pending list: ${pendingRequestsError}`);
  }
  return mapApiTaskSnapshot(snapshot.items, pendingRequests, pendingRequestsError);
}

function cleanMarkdown(value) {
  return value.replace(/\*\*/gu, "").replace(/`/gu, "").trim();
}

export {
  AutoAdvanceService,
  AUTONOMOUS_PROMPT,
  IN_PERSON_CHALLENGE,
  AUTONOMOUS_CHALLENGE,
  AUTONOMOUS_TURN_END_CHALLENGE,
  STOP_MARKER,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_CODEX_MAX_CONCURRENT,
  DEFAULT_ADVANCE_PROMPT_COOLDOWN_MS,
  DEFAULT_ADVANCE_PROMPT_BACKOFF_FACTOR,
  DEFAULT_ADVANCE_PROMPT_MAX_COOLDOWN_MS,
  DEFAULT_ADVANCE_PROMPT_MAX_INJECTIONS,
  TASK_RECHECK_DELAY_MS,
  hasPendingInbox,
  taskNeedsCodex,
  isExactStopMessage,
  readTasksFromApi,
  readCloudTaskSnapshotStrict,
  mapApiTaskSnapshot,
  hasOpenNeedHuman,
  splitCloudTaskSnapshotStrict,
  parseRoundCloseText,
  parseRoundCloseMessage,
  validateRoundClosePayload,
  resolveConfiguredPaths,
  normalizeConfig
};
