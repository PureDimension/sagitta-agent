import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
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
const AUTONOMOUS_PROMPT = "涟漪已离开。由于存在 in_progress 任务，请继续尽可能推进所有不需人工的任务，直到无可推进。确实无自主可推进处，能自测的自测、能拆的拆，然后收口：需人工介入才能完成时创建 need-human（type=need）并标 blocked；需人工了解重大决策时发 notify（待确认，不阻塞 done）；达到交付标准就标 done。禁止为逃避收口母任务无限开旁支/temp 新任务。每轮收尾都核对当前 in_progress 是否真无可推进，可推进就继续，不可推进按上述规则收口。终态请使用任务工具更新。";
const IN_PERSON_CHALLENGE = "确认已推进到必须涟漪处理的地步？先核对当前 in_progress：所有不需人工的工作是否已推进到无可推进，能自测的已自测、能拆的已拆？确需人工完成时创建 need-human（type=need）并标 blocked；重大决策待确认时发 notify，不阻塞 done；达到交付标准才标 done。禁止用旁支/temp 新任务逃避收口。";
const AUTONOMOUS_CHALLENGE = "涟漪已离开。先核对当前 in_progress：所有不需人工的工作是否已推进到无可推进？能拆的拆、能自测的自测，禁止开旁支/temp 任务逃避收口。确需人工完成时创建 need-human（type=need）并标 blocked；重大决策待确认时发 notify，不阻塞 done；达到交付标准才标 done。";
const AUTONOMOUS_TURN_END_CHALLENGE = "涟漪已离开。仍有 in_progress 任务未收尾：先继续推进所有不需人工的部分至无可推进，能拆的拆、能自测的自测，禁止开旁支/temp 任务逃避收口；确需人工完成时创建 need-human（type=need）并标 blocked；重大决策发 notify（待确认，不阻塞 done）；达到交付标准就完成、标 done、释放任务。";

const STOP_MARKER = "【停止自主推进】";
const PLUGIN_ID = "auto-advance";
const STATUS_EVENT = "sagitta-auto-advance/status";
const ASYNC_WORK_SETTLED_EVENT = "async-work/settled";
const DEFAULT_IDLE_TIMEOUT_MS = 15000;
const DEFAULT_TASK_API_TIMEOUT_MS = 3000;
const DEFAULT_TASK_PAGE_SIZE = 200;
const TASK_RECHECK_DELAY_MS = 30000;
const PROCESS_SHUTDOWN_TASK_BUDGET_MS = 4500;
const PROCESS_SHUTDOWN_BLOCKED_REASON = "sagitta 进程中断退出";
const CLOUD_RETRY_DELAYS_MS = [30000, 120000, 300000];
const CLOUD_RETRY_JITTER = 0.2;
const LEGACY_WORKSPACE_CANDIDATES = [
  "D:\\workspace\\sagitta-experience",
  join(homedir(), ".dsh"),
  join(homedir(), ".sagitta", "workspace"),
  join(homedir(), "sagitta-experience"),
  join(homedir(), "workspace", "sagitta-experience")
];

const REMOTE_INITIALIZERS = [];
for (const method of ["getState", "setMode", "getTasks", "resolveNeedHuman"]) {
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

function settledWorkInfo(settled) {
  return {
    workId: nonEmptyString(settled?.workId ?? settled?.work_id),
    taskId: nonEmptyString(settled?.taskId ?? settled?.task_id),
    status: nonEmptyString(settled?.status),
    kind: nonEmptyString(settled?.kind),
    reason: nonEmptyString(settled?.reason)
  };
}

function settledWorkKey(settled) {
  const info = settledWorkInfo(settled);
  if (info.workId !== undefined) return `work:${info.workId}`;
  const fallback = [info.taskId, info.status, info.kind, info.reason].filter((value) => value !== undefined);
  return fallback.length > 0 ? `settled:${fallback.join("|")}` : undefined;
}

function settledWorkNotice(settled) {
  const info = settledWorkInfo(settled);
  const details = [
    `task_id=${info.taskId ?? "unknown"}`,
    `status=${info.status ?? "unknown"}`,
    info.workId === undefined ? undefined : `work_id=${info.workId}`,
    info.kind === undefined ? undefined : `kind=${info.kind}`,
    info.reason === undefined ? undefined : `reason=${info.reason}`
  ].filter((value) => value !== undefined);
  return `异步任务已完成：${details.join(" ")}，可继续推进或汇报结果。`;
}

function normalizeTaskApiConfig(config = {}) {
  const raw = isRecord(config) ? config : {};
  const nested = isRecord(raw.apiConfig) ? raw.apiConfig : isRecord(raw.taskApiConfig) ? raw.taskApiConfig : {};
  return {
    workerApiUrl: nonEmptyString(nested.workerApiUrl ?? nested.apiUrl ?? raw.workerApiUrl ?? raw.apiUrl),
    d1ReadToken: nonEmptyString(nested.d1ReadToken ?? nested.authToken ?? raw.d1ReadToken ?? raw.authToken),
    d1WriteToken: nonEmptyString(nested.d1WriteToken ?? raw.d1WriteToken),
    accessClientId: nonEmptyString(nested.accessClientId ?? raw.accessClientId),
    accessClientSecret: nonEmptyString(nested.accessClientSecret ?? nested.accessSecret ?? raw.accessClientSecret ?? raw.accessSecret)
  };
}

function hasConfiguredTaskApiValue(config) {
  return config !== undefined && Object.values(config).some((value) => value !== undefined);
}

function completeTaskApiConfig(config, operation = "read") {
  const normalized = normalizeTaskApiConfig(config);
  // API 模式就绪条件：workerApiUrl 非空，且具备任一认证形态
  // （Bearer d1ReadToken，或 Cloudflare Access 双 key——网关放行后免 Bearer）。
  const accessComplete = normalized.accessClientId !== undefined && normalized.accessClientSecret !== undefined;
  const token = operation === "write" ? normalized.d1WriteToken : normalized.d1ReadToken;
  return normalized.workerApiUrl !== undefined && (token !== undefined || accessComplete)
    ? normalized
    : undefined;
}

function readManagerApiConfig(manager) {
  if (typeof manager?.getApiConfig !== "function") return undefined;
  try {
    return manager.getApiConfig();
  } catch {
    return undefined;
  }
}

function isTaskFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasTasksFile(workspace) {
  return isTaskFile(join(workspace, "TASKS.md"));
}

function resolveWorkspace() {
  const configuredWorkspace = nonEmptyString(process.env.SAGITTA_WORKSPACE);
  if (configuredWorkspace !== undefined && hasTasksFile(configuredWorkspace)) return resolve(configuredWorkspace);

  const seen = new Set();
  for (const candidate of LEGACY_WORKSPACE_CANDIDATES) {
    const workspace = resolve(candidate);
    if (seen.has(workspace)) continue;
    seen.add(workspace);
    if (hasTasksFile(workspace)) return workspace;
  }
  return resolve(process.cwd());
}

function resolveConfiguredPaths(config = {}) {
  const workspace = resolveWorkspace();
  const configuredStatePath = nonEmptyString(config.statePath);
  const configuredTasksPath = nonEmptyString(config.tasksPath);
  return {
    statePath: configuredStatePath === undefined ? join(workspace, ".sagitta-auto-advance.json") : resolve(configuredStatePath),
    tasksPath: configuredTasksPath === undefined ? join(workspace, "TASKS.md") : resolve(configuredTasksPath)
  };
}

function normalizeConfig(config = {}) {
  const idleTimeoutMs = Number(config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  const paths = resolveConfiguredPaths(config);
  return {
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
    statePath: paths.statePath,
    tasksPath: paths.tasksPath,
    taskApiTimeoutMs: Number.isFinite(Number(config.taskApiTimeoutMs)) && Number(config.taskApiTimeoutMs) > 0
      ? Number(config.taskApiTimeoutMs)
      : DEFAULT_TASK_API_TIMEOUT_MS,
    proxy: typeof config.proxy === "string" && config.proxy.trim().length > 0
      ? config.proxy.trim()
      : (nonEmptyString(process.env.DSH_MEMORY_PROXY) ?? "direct"),
    taskPageSize: Number.isInteger(Number(config.taskPageSize)) && Number(config.taskPageSize) > 0
      ? Math.min(MAX_PAGE_SIZE, Number(config.taskPageSize))
      : DEFAULT_TASK_PAGE_SIZE,
    // Explicit API settings are migration fallback values. A configured manager
    // snapshot wins exactly as it does for memory's task client.
    apiConfig: normalizeTaskApiConfig(config),
    manager: config.manager,
    managerApiConfig: normalizeTaskApiConfig(config.managerApiConfig)
  };
}

function taskFileDiagnostics(path) {
  try {
    const stat = statSync(path);
    return { exists: stat.isFile(), mtime: stat.isFile() ? new Date(stat.mtimeMs).toISOString() : null };
  } catch {
    return { exists: false, mtime: null };
  }
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

    this.config = normalizeConfig(config);
    const taskFile = taskFileDiagnostics(this.config.tasksPath);
    const taskSource = this.resolveTaskApiConfig()?.source ?? "tasksPath-fallback";
    safeLog(() => this.logger(), "info", `sagitta-auto-advance: taskSource=${taskSource} tasksPath=${this.config.tasksPath} exists=${taskFile.exists} mtime=${taskFile.mtime ?? "null"}`);
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
      state.settledWorkIds = new Set();
      state.pendingSettlements = new Map();
      state.lastProtocolNotice = null;
      this.resetTimer(state, "session-start");
    });
    ctx.on("agent/status", ({ agent, status }) => {
      const state = this.stateFor(agent);
      this.touchOwners(agent, "child-status");
      if (status === "idle") {
        this.maybeArm(state);
        this.flushPendingAsyncWorkSettled(state);
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
    ctx.on(ASYNC_WORK_SETTLED_EVENT, (settled) => {
      this.handleAsyncWorkSettled(settled);
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
    const taskApi = this.resolveTaskApiConfig();
    // The panel reads the global task list, but it is opened in the current
    // session. Carry that session id so the Worker can project its owned rows
    // as claim_state=mine. Keep a first-agent fallback for older direct RPC
    // callers that still invoke getTasks() without the lookup argument.
    const taskAgentId = nonEmptyString(agent?.id) ?? this.primaryTaskAgentId();
    return readTasksFromApi(taskApi, this.config, this.logger(), taskAgentId).catch((error) => {
      // This is deliberately the UI-only path. No caller used by
      // auto-advance qualification reaches readTasks/readTasksFromApi.
      this.logger()?.warn?.(`sagitta-auto-advance: task API unavailable; using stale tasksPath for UI: ${renderError(error)}`);
      const stale = readTasks(this.config.tasksPath, this.logger());
      return {
        ...stale,
        pendingRequests: [],
        pendingRequestsError: `need-human 列表暂不可用（任务 API 不可用：${renderError(error)}）`,
        source: "file-stale",
        error: `任务 API 暂时不可用（${renderError(error)}）；当前为 file-stale 文件快照${stale.error ? `；${stale.error}` : ""}`
      };
    });
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
    const taskApi = this.resolveTaskApiConfig();
    if (completeTaskApiConfig(taskApi, "write") === undefined) {
      throw taskApiUnavailable("Worker API 写入认证或地址配置不完整");
    }
    const payload = await requestTaskApiJson(
      taskApi,
      this.config,
      needHumanResolveApiUrl(taskApi.workerApiUrl, id),
      undefined,
      {
        method: "POST",
        operation: "write",
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

  /**
   * Resolve the same runtime API source as memory: a configured manager
   * snapshot wins; explicit values are only a migration fallback when the
   * manager is absent or empty. The manager is read for every request.
   */
  resolveTaskApiConfig() {
    const explicit = normalizeTaskApiConfig(this.config.apiConfig);
    const manager = this.config.manager ?? this.ctx?.["sagitta-manager"];
    if (typeof manager?.getApiConfig === "function") {
      const currentManager = normalizeTaskApiConfig(readManagerApiConfig(manager));
      if (hasConfiguredTaskApiValue(currentManager)) return { ...currentManager, source: "manager-api" };
      if (hasConfiguredTaskApiValue(explicit)) return { ...explicit, source: "explicit-api" };
      return undefined;
    }

    const startupManager = normalizeTaskApiConfig(this.config.managerApiConfig);
    if (hasConfiguredTaskApiValue(startupManager)) return { ...startupManager, source: "manager-api" };
    if (hasConfiguredTaskApiValue(explicit)) return { ...explicit, source: "explicit-api" };
    return undefined;
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
      settledWorkIds: new Set(),
      pendingSettlements: new Map(),
      lastProtocolNotice: null
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

  handleAsyncWorkSettled(settled) {
    const ownerId = nonEmptyString(settled?.ownerId ?? settled?.owner_id);
    if (ownerId === undefined) return false;
    const agent = this.ctx.agents.get(ownerId);
    if (agent === undefined) return false;
    const state = this.states.get(agent);
    if (state === undefined || state.disposed === true || state.requestController !== undefined) return false;

    const key = settledWorkKey(settled);
    const settledWorkIds = state.settledWorkIds instanceof Set ? state.settledWorkIds : (state.settledWorkIds = new Set());
    const pendingSettlements = state.pendingSettlements instanceof Map ? state.pendingSettlements : (state.pendingSettlements = new Map());
    if (key !== undefined && settledWorkIds.has(key)) return false;

    if (agent.status !== "idle") {
      if (key !== undefined && !pendingSettlements.has(key)) pendingSettlements.set(key, settled);
      // Do not interrupt a running turn, but make the next idle transition
      // re-check immediately instead of waiting on a stale timer.
      this.resetTimer(state, "async-work-settled");
      return false;
    }

    if (key !== undefined) {
      pendingSettlements.delete(key);
      // Mark before queueing/onTimer so a duplicate event cannot race the
      // synchronous follow-up insertion or the async cloud read.
      settledWorkIds.add(key);
    }

    this.resetTimer(state, "async-work-settled");
    if (state.enabled === true) {
      // Autonomous mode keeps its existing full qualification/injection path;
      // the settlement only makes that check immediate.
      const generation = state.timerGeneration;
      void this.onTimer(state, generation);
      return true;
    }

    const queued = this.queueNotice(
      state,
      settledWorkNotice(settled),
      "async work settled",
      "injected: async-work-settled",
      { autonomous: false, allowDisabled: true }
    );
    if (!queued && key !== undefined) settledWorkIds.delete(key);
    return queued;
  }

  flushPendingAsyncWorkSettled(state) {
    const pendingSettlements = state?.pendingSettlements;
    if (!(pendingSettlements instanceof Map) || pendingSettlements.size === 0) return false;
    let handled = false;
    for (const settled of [...pendingSettlements.values()]) {
      const result = this.handleAsyncWorkSettled(settled);
      handled = result || handled;
      if (state.requestController !== undefined) break;
    }
    return handled;
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

  actionableOwnedTasks(state, snapshot = state.cloudSnapshot) {
    return this.ownedInProgressTasks(state, snapshot).filter((task) =>
      // need 型 open 条目只阻塞 done 申请；need 之外仍可自主推进的工作不应被挡住。
      task?.pending_status === null && !this.hasRunningWork(state.agent, task.task_id ?? task.id)
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
        // A claim token/result is the local ownership signal. A bare request
        // is not enough: it may be a rejected claim against another lease.
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
        if (args.status === "done" || args.status === "blocked") transitions.push({ id, args });
      }
      // Keep old tool clients observable during the transition, but do not
      // require or parse round-close text anymore.
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
    const taskApi = this.resolveTaskApiConfig();
    if (completeTaskApiConfig(taskApi) === undefined) return state.cloudSnapshot;
    try {
      // A terminal request may have landed after the last idle poll. Refresh
      // before challenging so pending_done/pending_blocked is authoritative.
      return await readCloudTaskSnapshotStrict(taskApi, this.config, undefined, this.logger(), state.agent.id);
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

    const unfinished = this.ownedInProgressTasks(state, snapshot).filter((task) =>
      !isTempTask(task) && task?.pending_status === null && !this.hasRunningWork(state.agent, task.task_id ?? task.id)
    );
    if (unfinished.length === 0) return { ok: true };

    const taskLines = unfinished.map((task) => `task_id=${task.task_id ?? task.id}`);
    this.queueNotice(
      state,
      `${AUTONOMOUS_TURN_END_CHALLENGE}\n未收尾任务：${taskLines.join("，")}`,
      "autonomous in-progress task challenge",
      "injected: autonomous-in-progress-challenge",
      { autonomous: true }
    );
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

  scheduleTaskRecheck(state, generation, reason = "defer: task-driven-wait") {
    if (!this.isCurrentRun(state, generation) || state.timer !== undefined) return;
    state.retrying = true;
    state.idleSince = null;
    // Keep pending/running work quiet for longer than the ordinary 15s idle
    // probe; this is a recheck, not another prompt injection cadence.
    state.timer = setTimeout(() => { void this.onTimer(state, generation); }, TASK_RECHECK_DELAY_MS);
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
        const taskApi = this.resolveTaskApiConfig();
        if (completeTaskApiConfig(taskApi) === undefined) {
          throw taskApiUnavailable(taskApi === undefined ? "Worker API 未配置" : "Worker API 认证或地址配置不完整");
        }
        snapshot = await readCloudTaskSnapshotStrict(taskApi, this.config, controller.signal, this.logger(), state.agent.id);
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
      const actionable = this.actionableOwnedTasks(state, snapshot);
      if (actionable.length > 0) {
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
          ? `${prompt}\n\n请逐项核对每个任务的期望目标：确认每一项是否还有可在人工介入之前推进的空间；有就推进，没有才按收口规则处理（need-human+blocked / notify / done）。${accBlocks.join("\n")}`
          : prompt;
        this.queuePrompt(state, generation, fullPrompt, "owned in-progress tasks", "injected: owned-in-progress", { autonomous: true });
        return;
      }

      if (owned.length > 0) {
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
    if (completeTaskApiConfig(taskApi) === undefined) return undefined;
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

    let taskApi;
    try {
      taskApi = this.resolveTaskApiConfig();
    } catch {
      return;
    }
    if (completeTaskApiConfig(taskApi, "write") === undefined) return;

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
            this.config,
            taskPatchApiUrl(taskApi.workerApiUrl, taskId),
            controller.signal,
            {
              method: "PATCH",
              operation: "write",
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

function taskApiUrl(workerApiUrl, page = 1, size = DEFAULT_TASK_PAGE_SIZE) {
  const baseUrl = workerApiUrl.replace(/\/+$/u, "");
  const url = new URL(`${baseUrl}/task`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(size));
  return url;
}

function taskPatchApiUrl(workerApiUrl, taskId) {
  const baseUrl = workerApiUrl.replace(/\/+$/u, "");
  return new URL(`${baseUrl}/task/${encodeURIComponent(taskId)}`);
}

function needHumanApiUrl(workerApiUrl) {
  const baseUrl = workerApiUrl.replace(/\/+$/u, "");
  const url = new URL(`${baseUrl}/need-human`);
  url.searchParams.set("status", "open");
  return url;
}

function needHumanResolveApiUrl(workerApiUrl, needHumanId) {
  const baseUrl = workerApiUrl.replace(/\/+$/u, "");
  return new URL(`${baseUrl}/task/need-human/${encodeURIComponent(needHumanId)}/resolve`);
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
  const task = {
    text: title,                       // 项目进度区（normalizeTask 用 text + done）
    title,                             // 待处理需求区用
    done: item?.status === "done",     // tasksSchema 硬性要求（boolean）
    status: typeof item?.status === "string" ? item.status : "open",
    updatedAt: taskApiUpdatedAt(item?.updated_at ?? item?.updatedAt),
    createdAt: taskApiUpdatedAt(item?.created_at ?? item?.createdAt),
    pendingStatus: item?.pending_status ?? null,
    blockedReason: item?.blocked_reason ?? null,
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

function mapApiTaskSnapshot(items, tasksPath, source = "cloud", pendingRequests = [], pendingRequestsError) {
  let updatedAt = null;
  const byProject = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const task = mapApiTask(item);
    // temp tasks are execution-only and must not appear in the floating UI.
    if (isTempTask(task, item)) continue;
    const itemUpdatedAt = task.updatedAt;
    if (itemUpdatedAt !== null && (updatedAt === null || itemUpdatedAt > updatedAt)) updatedAt = itemUpdatedAt;
    if (!byProject.has(task.project)) byProject.set(task.project, []);
    byProject.get(task.project).push(task);
  }
  const sections = [...byProject.entries()]
    .map(([title, items]) => ({ title, items }))
    .sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title));
  return {
    path: tasksPath,
    updatedAt,
    sections,
    pendingRequests: Array.isArray(pendingRequests) ? pendingRequests : [],
    ...(typeof pendingRequestsError === "string" && pendingRequestsError.length > 0 ? { pendingRequestsError } : {}),
    source
  };
}

// 复用 @sagitta/memory 的 http.js（CONNECT 隧道 + 传输层重试），读云端 /task。
// 动态 import 只用于配置了代理的生产路径；loopback direct 保留 fetch 便于本地桩。
let memoryRequestModulePromise = null;
function memoryHttpRequest() {
  if (memoryRequestModulePromise === null) {
    memoryRequestModulePromise = import("@sagitta/memory/lib/http.js")
      .then((mod) => mod.request ?? null)
      .catch(() => null);
  }
  return memoryRequestModulePromise;
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value === "::1" || /^127\./u.test(value);
}

function isLoopbackUrl(value) {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function assertTaskTransportPolicy(baseUrl, proxy) {
  const configuredProxy = typeof proxy === "string" ? proxy.trim() : "";
  const direct = configuredProxy.length === 0 || configuredProxy.toLowerCase() === "direct";
  if (direct && !isLoopbackUrl(baseUrl)) {
    throw taskApiUnavailable("配置错误：访问非 loopback Worker 禁止使用 direct；请配置 DSH_MEMORY_PROXY 或插件 proxy，未配置代理时已 fail closed");
  }
}

function buildTaskAuthHeaders(apiConfig, operation = "read") {
  const headers = { Accept: "application/json", "Accept-Encoding": "identity" };
  // Keep the exact memory ordering: the operation's Bearer wins over Access.
  const token = operation === "write" ? apiConfig?.d1WriteToken : apiConfig?.d1ReadToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (apiConfig?.accessClientId && apiConfig?.accessClientSecret) {
    headers["CF-Access-Client-Id"] = apiConfig.accessClientId;
    headers["CF-Access-Client-Secret"] = apiConfig.accessClientSecret;
  }
  return headers;
}

function taskApiUnavailableFrom(error) {
  if (error?.code === "task-api-unavailable") return error;
  return taskApiUnavailable(renderError(error), error);
}

function linkedAbortSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}

async function requestTaskApiJson(apiConfig, config, url, signal, options = {}) {
  const method = options.method ?? "GET";
  const operation = options.operation ?? (method === "GET" ? "read" : "write");
  if (completeTaskApiConfig(apiConfig, operation) === undefined) {
    throw taskApiUnavailable(`Worker API ${operation === "write" ? "写入" : "读取"}认证或地址配置不完整`);
  }
  assertTaskTransportPolicy(apiConfig.workerApiUrl, config.proxy);
  const requestHeaders = buildTaskAuthHeaders(apiConfig, operation);
  const taskAgentId = nonEmptyString(options.agentId);
  if (taskAgentId !== undefined) requestHeaders["X-Agent-Id"] = taskAgentId;
  const requestBodyText = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (requestBodyText !== undefined) requestHeaders["Content-Type"] = "application/json";
  const timeoutMs = config.taskApiTimeoutMs;
  const useProxy = typeof config.proxy === "string" && config.proxy.trim().length > 0 && config.proxy.trim().toLowerCase() !== "direct";
  let status = 0;
  let bodyText = "";
  if (useProxy) {
    const memoryRequest = await memoryHttpRequest();
    if (typeof memoryRequest !== "function") {
      throw taskApiUnavailable("proxy 已配置但 @sagitta/memory 的 http.js 不可用（memory 插件缺失/版本过旧）");
    }
    try {
      const response = await memoryRequest({
        method,
        url: url.toString(),
        headers: requestHeaders,
        body: requestBodyText,
        timeoutMs,
        signal,
        proxy: config.proxy,
      });
      status = Number(response?.status);
      bodyText = response?.body ? Buffer.from(response.body).toString("utf8") : "";
    } catch (error) {
      throw taskApiUnavailable(`请求失败：${renderError(error)}`, error);
    }
  } else {
    const linked = linkedAbortSignal(signal, timeoutMs);
    try {
      const response = await fetch(url.toString(), { method, headers: requestHeaders, body: requestBodyText, signal: linked.signal });
      status = Number(response?.status);
      bodyText = typeof response.text === "function" ? await response.text() : "";
    } catch (error) {
      throw taskApiUnavailable(`请求失败：${renderError(error)}`, error);
    } finally {
      linked.dispose();
    }
  }

  if (status < 200 || status >= 300) throw taskApiUnavailable(`HTTP ${Number.isInteger(status) ? status : "未知"}`);
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    throw taskApiUnavailable("响应不是合法 JSON", error);
  }
  return payload;
}

async function requestTaskApiPage(apiConfig, config, page, signal, logger, agentId) {
  if (completeTaskApiConfig(apiConfig) === undefined) {
    throw taskApiUnavailable("Worker API 认证或地址配置不完整");
  }
  const url = taskApiUrl(apiConfig.workerApiUrl, page, config.taskPageSize);
  const payload = await requestTaskApiJson(apiConfig, config, url, signal, { agentId });
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

async function readOpenNeedHumanFromApi(apiConfig, config, agentId) {
  const payload = await requestTaskApiJson(apiConfig, config, needHumanApiUrl(apiConfig.workerApiUrl), undefined, { agentId });
  const data = unwrapTaskApiPayload(payload);
  const rawItems = data?.items ?? data?.need_humans ?? data?.needHuman;
  if (!Array.isArray(rawItems)) throw taskApiUnavailable("/need-human 响应缺少 items 列表");
  return rawItems
    .filter((item) => item?.status === undefined || item.status === "open")
    .map(mapNeedHumanItem)
    .filter((item) => item !== undefined)
    .sort((first, second) => (second.createdAt ?? Number.NEGATIVE_INFINITY) - (first.createdAt ?? Number.NEGATIVE_INFINITY));
}

async function readCloudTaskSnapshotStrict(apiConfig, config, signal, logger, agentId) {
  try {
    const first = await requestTaskApiPage(apiConfig, config, 1, signal, logger, agentId);
    const pageCount = Math.max(1, Math.ceil(first.total / first.size));
    const pages = [first];
    for (let page = 2; page <= pageCount; page++) {
      pages.push(await requestTaskApiPage(apiConfig, config, page, signal, logger, agentId));
    }
    return splitCloudTaskSnapshotStrict({ pages });
  } catch (error) {
    throw taskApiUnavailableFrom(error);
  }
}

async function readTasksFromApi(apiConfig, config, logger, agentId) {
  const snapshot = await readCloudTaskSnapshotStrict(apiConfig, config, undefined, logger, agentId);
  let pendingRequests = [];
  let pendingRequestsError;
  try {
    pendingRequests = await readOpenNeedHumanFromApi(apiConfig, config, agentId);
  } catch (error) {
    pendingRequestsError = renderError(error);
    logger?.warn?.(`sagitta-auto-advance: open need-human unavailable; showing an empty pending list: ${pendingRequestsError}`);
  }
  return mapApiTaskSnapshot(snapshot.items, config.tasksPath, "cloud", pendingRequests, pendingRequestsError);
}

function readTasks(path, logger) {
  try {
    const stat = readFileSync(path, { encoding: "utf8" });
    const sections = [];
    let current = { title: "TASKS", items: [] };
    let tableColumns;
    sections.push(current);
    for (const line of stat.split(/\r?\n/u)) {
      const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
      if (heading !== null) {
        const title = heading[2];
        current = { title, items: [] };
        tableColumns = undefined;
        sections.push(current);
        continue;
      }
      const task = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/u.exec(line);
      if (task !== null) {
        current.items.push({ text: task[2], done: task[1].toLowerCase() === "x" });
        continue;
      }
      const cells = parseTableRow(line);
      if (cells === undefined) continue;
      if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
      if (tableColumns === undefined && cells.some((cell) => cell.includes("任务"))) {
        tableColumns = {
          task: cells.findIndex((cell) => cell.includes("任务")),
          status: cells.findIndex((cell) => cell.includes("状态"))
        };
        continue;
      }
      if (tableColumns === undefined || tableColumns.task < 0 || cells[tableColumns.task] === undefined) continue;
      const text = cleanMarkdown(cells[tableColumns.task]);
      if (text.length === 0 || text === "任务") continue;
      const status = tableColumns.status >= 0 ? cleanMarkdown(cells[tableColumns.status] ?? "") : "";
      current.items.push({ text: status.length > 0 ? `${text}（${status}）` : text, done: /✅|完成/u.test(status) });
    }
    return { path, updatedAt: statMtime(path), sections: sections.filter((section) => section.items.length > 0), pendingRequests: [], source: "file" };
  } catch (error) {
    logger?.warn?.(`sagitta-auto-advance: cannot read task file: ${renderError(error)}`);
    return { path, updatedAt: null, sections: [], pendingRequests: [], source: "file", error: "TASKS.md 暂时不可读" };
  }
}

function parseTableRow(line) {
  if (!/^\s*\|/u.test(line) || !/\|\s*$/u.test(line)) return undefined;
  return line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
}

function cleanMarkdown(value) {
  return value.replace(/\*\*/gu, "").replace(/`/gu, "").trim();
}

function statMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export {
  AutoAdvanceService,
  AUTONOMOUS_PROMPT,
  IN_PERSON_CHALLENGE,
  AUTONOMOUS_CHALLENGE,
  AUTONOMOUS_TURN_END_CHALLENGE,
  STOP_MARKER,
  DEFAULT_IDLE_TIMEOUT_MS,
  TASK_RECHECK_DELAY_MS,
  hasPendingInbox,
  isExactStopMessage,
  readTasks,
  readTasksFromApi,
  readCloudTaskSnapshotStrict,
  mapApiTaskSnapshot,
  hasOpenNeedHuman,
  splitCloudTaskSnapshotStrict,
  parseRoundCloseText,
  parseRoundCloseMessage,
  validateRoundClosePayload,
  buildTaskAuthHeaders,
  isLoopbackUrl,
  resolveConfiguredPaths,
  normalizeConfig
};
