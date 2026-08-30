import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/**
 * This is intentionally copied from the final prompt in
 * auto-continue-module-design.md. Keep line breaks and punctuation intact:
 * it is part of the model-facing protocol.
 */
const AUTONOMOUS_PROMPT = `当前用户处于离开模式，并且希望你自主推进任务。
请确认是否已经没有任何可以自主推进的任务，即所有任务都卡在必须需要用户来行动，否则无法推进的状态上，并且这个行动无法亲自做出（如在网络上配置东西，或者做视觉验收等能力有限无法做的决定）的阻塞项。
如果面临决策但是可以自主做出（比如技术选型、具体策略的设计），那么应当作出决策并继续推进；如果只是完成了一个小的任务，那么应当继续推进大项目的下一个任务；如果面临一些危险的操作，可以在确保绝对安全的情况下继续推进（要求随时可复原）；如果面临一些重大的技术分支，可以先记录下来-存档确保可以回档（后续开发不退化）-记录选型供之后讨论和复盘，之后继续开发。
如果当前不存在 goal 或者 goal 的描述存在阻碍/不符合当前要求导致阻塞，可以编辑 goal 并恢复运行。
如果未来存在异步调用需要等待回复，并且当前确实没有其他值得推进的事情，那么可以停止并等待被异步唤起。
如果当前确实所有大任务都进入到阻塞状态，无法继续推进，或者需要等待异步唤起，那么请输出【停止自主推进】，并不要附加多余的解释，自主推进进程将会关闭。`;

const STOP_MARKER = "【停止自主推进】";
const PLUGIN_ID = "auto-advance";
const STATUS_EVENT = "sagitta-auto-advance/status";
const DEFAULT_IDLE_TIMEOUT_MS = 300000;
const DEFAULT_TASK_API_TIMEOUT_MS = 3000;
const LEGACY_WORKSPACE_CANDIDATES = [
  "D:\\workspace\\sagitta-experience",
  join(homedir(), ".dsh"),
  join(homedir(), ".sagitta", "workspace"),
  join(homedir(), "sagitta-experience"),
  join(homedir(), "workspace", "sagitta-experience")
];
const ACTIVE_JOB_STATUSES = new Set(["running", "stopping"]);

const REMOTE_INITIALIZERS = [];
for (const method of ["getState", "setMode", "getTasks"]) {
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

function normalizeTaskApiConfig(config = {}) {
  const raw = isRecord(config) ? config : {};
  const nested = isRecord(raw.apiConfig) ? raw.apiConfig : isRecord(raw.taskApiConfig) ? raw.taskApiConfig : {};
  return {
    workerApiUrl: nonEmptyString(nested.workerApiUrl ?? nested.apiUrl ?? raw.workerApiUrl ?? raw.apiUrl),
    d1ReadToken: nonEmptyString(nested.d1ReadToken ?? raw.d1ReadToken),
    accessClientId: nonEmptyString(nested.accessClientId ?? raw.accessClientId),
    accessClientSecret: nonEmptyString(nested.accessClientSecret ?? raw.accessClientSecret)
  };
}

function completeTaskApiConfig(config) {
  const normalized = normalizeTaskApiConfig(config);
  // API 模式就绪条件：workerApiUrl 非空，且具备任一认证形态
  // （Bearer d1ReadToken，或 Cloudflare Access 双 key——网关放行后免 Bearer）。
  const accessComplete = normalized.accessClientId !== undefined && normalized.accessClientSecret !== undefined;
  return normalized.workerApiUrl !== undefined && (normalized.d1ReadToken !== undefined || accessComplete)
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
    // This field is already used by the profile patch during the transition.
    taskFallback: config.taskFallback !== false,
    taskApiTimeoutMs: Number.isFinite(Number(config.taskApiTimeoutMs)) && Number(config.taskApiTimeoutMs) > 0
      ? Number(config.taskApiTimeoutMs)
      : DEFAULT_TASK_API_TIMEOUT_MS,
    proxy: typeof config.proxy === "string" && config.proxy.trim().length > 0 ? config.proxy.trim() : "direct",
    // Explicit API settings are intentionally read without adding fields to the
    // v0.1.7 RPC/typert contract. The manager snapshot is a separate source.
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

function isAutoAdvanceMessage(message, state) {
  return message?.id !== undefined && message.id === state.lastAutoMessageId;
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
  static inject = ["agents", "goals", "sessions"];

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

    ctx.on("agent/created", ({ agent }) => {
      const state = this.stateFor(agent);
      this.maybeArm(state);
    });
    ctx.on("agent/disposed", ({ agent }) => {
      const state = this.states.get(agent);
      if (state === undefined) return;
      state.disposed = true;
      this.clearTimer(state);
      this.states.delete(agent);
      this.broadcast(state);
    });
    ctx.on("agent/session-start", ({ agent }) => {
      const state = this.stateFor(agent);
      state.enabled = this.persistedModes.get(agent.id) === true;
      state.stoppedByProtocol = false;
      state.lastAutoMessageId = undefined;
      this.resetTimer(state, "session-start");
    });
    ctx.on("agent/status", ({ agent, status }) => {
      const state = this.stateFor(agent);
      this.touchOwners(agent, "child-status");
      if (status === "idle") this.maybeArm(state);
      else this.resetTimer(state, "agent-running");
    });
    ctx.on("agent/inbox/inserted", ({ agent, message }) => {
      const state = this.stateFor(agent);
      if (isAutoAdvanceMessage(message, state)) {
        this.clearTimer(state);
        state.idleSince = null;
        this.broadcast(state);
        return;
      }
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
    ctx.on("session/event", (session, event) => {
      const agent = ctx.agents.get(session.id);
      if (agent === undefined || agent.session !== session) return;
      const state = this.stateFor(agent);
      if (event.type === "user/message") {
        if (event.data?.id === state.lastAutoMessageId) {
          state.lastAutoMessageId = undefined;
          this.broadcast(state);
        } else {
          this.resetTimer(state, "user-message");
        }
        return;
      }
      if (event.type === "assistant/message" && isExactStopMessage(event.data?.message)) {
        this.stopByProtocol(state);
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

    ctx.effect(() => () => {
      for (const state of this.states.values()) this.clearTimer(state);
      this.states.clear();
      this.listeners.clear();
    }, "sagitta-auto-advance: timers");

    for (const agent of ctx.agents.list()) this.stateFor(agent);
  }

  /** Register a same-process listener; the web UI uses the typed RPC snapshot. */
  onStatus(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(agent) {
    return this.snapshot(this.stateFor(agent));
  }

  setMode(agent, enabled) {
    const state = this.stateFor(agent);
    state.enabled = enabled === true;
    state.stoppedByProtocol = false;
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

  getTasks() {
    const taskApi = this.resolveTaskApiConfig();
    if (taskApi === undefined) return readTasks(this.config.tasksPath, this.logger());

    return readTasksFromApi(taskApi, this.config, this.logger()).catch((error) => {
      this.logger()?.warn?.(`sagitta-auto-advance: task API unavailable; falling back to tasksPath: ${renderError(error)}`);
      if (this.config.taskFallback) return readTasks(this.config.tasksPath, this.logger());
      return {
        path: this.config.tasksPath,
        updatedAt: null,
        sections: [],
        pendingRequests: [],
        error: "任务 API 暂时不可用，文件 fallback 已关闭"
      };
    });
  }

  /**
   * Task source priority is deliberately explicit:
   * complete plugin API config > manager API config > tasksPath file fallback.
   * The manager is read again for each panel refresh, matching memory's
   * runtime configuration behavior; the apply-time snapshot is only used when
   * the manager object has no callable getter at service construction time.
   */
  resolveTaskApiConfig() {
    const explicit = completeTaskApiConfig(this.config.apiConfig);
    if (explicit !== undefined) return { ...explicit, source: "explicit-api" };

    const manager = this.config.manager ?? this.ctx?.["sagitta-manager"];
    if (typeof manager?.getApiConfig === "function") {
      const currentManager = completeTaskApiConfig(readManagerApiConfig(manager));
      if (currentManager !== undefined) return { ...currentManager, source: "manager-api" };
      return undefined;
    }

    const startupManager = completeTaskApiConfig(this.config.managerApiConfig);
    if (startupManager !== undefined) return { ...startupManager, source: "manager-api" };
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
      disposed: false
    };
    this.states.set(agent, state);
    return state;
  }

  isLive(state) {
    return !state.disposed && this.ctx.fiber.state === 2 && this.ctx.agents.get(state.agent.id) === state.agent;
  }

  hasRunningWork(agent) {
    for (const candidate of this.ctx.agents.list()) {
      if (candidate === agent) continue;
      if (this.ctx.agents.isOwnedBy(candidate.id, agent) && candidate.status === "running") return true;
    }

    // 有界工作注册表（sagitta-codex 插件）：只认"已注册的有界工作"（超时自动回收），
    // 不再用笼统 jobs.list —— 后台 pwsh/ssh 等未注册任务不会永久卡住自主推进（08-30 修复）。
    const codexService = this.ctx?.["sagitta-codex"];
    if (codexService && typeof codexService.listActiveWorks === "function") {
      try {
        return codexService.listActiveWorks(agent.id).length > 0;
      } catch (error) {
        this.logger()?.warn?.(`sagitta-auto-advance: codex work check failed: ${renderError(error)}`);
        return true; // 保守：查询失败视为有工作
      }
    }

    // 无 codex 插件时回退旧逻辑（jobs.list）
    const jobs = this.ctx.get("jobs");
    if (jobs === undefined || typeof jobs.list !== "function") return false;
    const callers = [undefined, ...this.ctx.agents.list()];
    try {
      for (const caller of callers) {
        for (const snapshot of jobs.list(caller)) {
          if (ACTIVE_JOB_STATUSES.has(snapshot?.status)) return true;
        }
      }
    } catch (error) {
      this.logger()?.warn?.(`sagitta-auto-advance: job readiness check failed: ${renderError(error)}`);
      return true;
    }
    return false;
  }

  hasPendingWork(agent) {
    return hasPendingInbox(agent) || this.hasRunningWork(agent);
  }

  readyToDrive(state) {
    return this.isLive(state) && state.enabled && !state.stoppedByProtocol && state.agent.status === "idle" && !this.hasPendingWork(state.agent);
  }

  clearTimer(state) {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
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
    state.idleSince = Date.now();
    state.timer = setTimeout(() => this.onTimer(state, generation), this.config.idleTimeoutMs);
    state.timer.unref?.();
    this.broadcast(state);
  }

  onTimer(state, generation) {
    let queueAttempted = false;
    try {
      if (state.timerGeneration !== generation) return;
      state.timer = undefined;
      if (!this.readyToDrive(state)) {
        state.idleSince = null;
        this.broadcast(state, "timer-not-ready");
        return;
      }

      const message = createUserMessage({
        content: [{ type: "text", text: AUTONOMOUS_PROMPT }],
        source: {
          kind: "plugin",
          plugin: PLUGIN_ID,
          form: "notice",
          summary: "idle timeout autonomous continuation"
        }
      });
      state.lastAutoMessageId = message.id;
      state.injectedAt = Date.now();
      state.idleSince = null;
      queueAttempted = true;
      agentFollowup(state.agent, message);
      this.broadcast(state, "injected");
    } catch (error) {
      try {
        state.lastAutoMessageId = undefined;
        state.idleSince = null;
      } catch {
        // Keep the timer callback contained even for an invalid state object.
      }
      const reason = queueAttempted ? "could not queue continuation" : "timer callback failed";
      safeLog(() => this.logger(), "warn", `sagitta-auto-advance: ${reason} for agent "${state.agent?.id ?? "unknown"}": ${renderError(error)}`);
      try {
        this.broadcast(state, queueAttempted ? "queue-failed" : "timer-failed");
      } catch (broadcastError) {
        safeLog(() => this.logger(), "warn", `sagitta-auto-advance: timer recovery broadcast failed: ${renderError(broadcastError)}`);
      }
      try {
        this.maybeArm(state);
      } catch (recoveryError) {
        safeLog(() => this.logger(), "warn", `sagitta-auto-advance: timer recovery failed: ${renderError(recoveryError)}`);
      }
    } finally {
      try {
        if (state.timerGeneration === generation) state.timer = undefined;
      } catch (error) {
        safeLog(() => this.logger(), "warn", `sagitta-auto-advance: timer cleanup failed: ${renderError(error)}`);
      }
    }
  }

  stopByProtocol(state) {
    state.enabled = false;
    state.stoppedByProtocol = true;
    this.persistedModes.set(state.agent.id, false);
    this.persistModes();
    this.clearTimer(state);
    state.idleSince = null;
    this.broadcast(state, "stop-protocol");
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
      ready: this.readyToDrive(state),
      hasPendingWork: this.hasPendingWork(state.agent),
      stoppedByProtocol: state.stoppedByProtocol
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

function taskApiUrl(workerApiUrl) {
  const baseUrl = workerApiUrl.replace(/\/+$/u, "");
  // 全量拉取（archived 由 worker 默认排除）：pendingRequests 在 mapApiTaskSnapshot
  // 内按 checkbox=1 且未完成过滤；sections 按 project 分组展示全部进行中任务。
  const url = new URL(`${baseUrl}/task`);
  url.searchParams.set("size", "200");
  return url;
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

function mapApiTask(item) {
  const titleValue = item?.title ?? item?.text;
  const title = cleanMarkdown(typeof titleValue === "string" ? titleValue : "") || "未命名需求";
  const project = typeof item?.project === "string" && item.project.trim() ? item.project.trim() : "未分类";
  return {
    text: title,                       // 项目进度区（normalizeTask 用 text + done）
    title,                             // 待处理需求区用
    done: item?.status === "done",     // tasksSchema 硬性要求（boolean）
    status: typeof item?.status === "string" ? item.status : "open",
    updatedAt: taskApiUpdatedAt(item?.updated_at ?? item?.updatedAt),
    project,                           // 分组键
    hasCheckbox: item?.checkbox === 1 || item?.checkbox === "1",
    body: typeof item?.body === "string" ? cleanBody(item.body) : "",
  };
}

function mapApiTaskSnapshot(items, tasksPath) {
  let updatedAt = null;
  const pendingRequests = [];
  const byProject = new Map();
  for (const item of items) {
    const task = mapApiTask(item);
    const itemUpdatedAt = task.updatedAt;
    if (itemUpdatedAt !== null && (updatedAt === null || itemUpdatedAt > updatedAt)) updatedAt = itemUpdatedAt;
    // 待处理需求：checkbox=1 且未完成
    if (task.hasCheckbox && task.status !== "done") pendingRequests.push(task);
    if (!byProject.has(task.project)) byProject.set(task.project, []);
    byProject.get(task.project).push(task);
  }
  const sections = [...byProject.entries()]
    .map(([title, items]) => ({ title, items }))
    .sort((a, b) => b.items.length - a.items.length);
  return { path: tasksPath, updatedAt, sections, pendingRequests };
}

// 复用 @sagitta/memory 的 http.js（CONNECT 隧道 + 传输层重试），读云端 /task。
// 动态 import：memory 插件不可用（未安装/禁用）时回退 Node fetch 直连（旧行为）。
let memoryRequestModulePromise = null;
function memoryHttpRequest() {
  if (memoryRequestModulePromise === null) {
    memoryRequestModulePromise = import("@sagitta/memory/lib/http.js")
      .then((mod) => mod.request ?? null)
      .catch(() => null);
  }
  return memoryRequestModulePromise;
}

async function readTasksFromApi(apiConfig, config, logger) {
  const url = taskApiUrl(apiConfig.workerApiUrl);
  const timeoutMs = config.taskApiTimeoutMs;
  const useProxy = typeof config.proxy === "string" && config.proxy.trim().length > 0 && config.proxy.trim().toLowerCase() !== "direct";
  // 认证：优先 Bearer（d1ReadToken）；否则 Cloudflare Access 双 key（网关放行 → CF-Access-Jwt-Assertion → 免 Bearer）
  const requestHeaders = { Accept: "application/json" };
  if (apiConfig.d1ReadToken) {
    requestHeaders.Authorization = `Bearer ${apiConfig.d1ReadToken}`;
  } else if (apiConfig.accessClientId && apiConfig.accessClientSecret) {
    requestHeaders["CF-Access-Client-Id"] = apiConfig.accessClientId;
    requestHeaders["CF-Access-Client-Secret"] = apiConfig.accessClientSecret;
  }

  let status = 0;
  let bodyText = "";
  if (useProxy) {
    const memoryRequest = await memoryHttpRequest();
    if (typeof memoryRequest !== "function") {
      throw new Error("proxy 已配置但 @sagitta/memory 的 http.js 不可用（memory 插件缺失/版本过旧）");
    }
    let response;
    try {
      response = await memoryRequest({
        method: "GET",
        url: url.toString(),
        headers: requestHeaders,
        timeoutMs,
        proxy: config.proxy,
      });
    } catch (error) {
      throw new Error(`请求失败：${renderError(error)}`);
    }
    status = Number(response?.status);
    bodyText = response?.body ? Buffer.from(response.body).toString("utf8") : "";
  } else {
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    let response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: requestHeaders,
        signal,
      });
    } catch (error) {
      throw new Error(`请求失败：${renderError(error)}`);
    }
    status = Number(response?.status);
    bodyText = typeof response.text === "function" ? await response.text() : "";
  }

  const successful = status >= 200 && status < 300;
  if (!successful) throw new Error(`HTTP ${Number.isInteger(status) ? status : "未知"}`);

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error("响应不是合法 JSON");
  }
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.data) || !Array.isArray(payload.data.items)) {
    throw new Error("响应不符合 {ok:true,data:{items}} 契约");
  }
  logger?.debug?.(`sagitta-auto-advance: task API returned ${payload.data.items.length} open checkbox item(s)`);
  return mapApiTaskSnapshot(payload.data.items, config.tasksPath);
}

function readTasks(path, logger) {
  try {
    const stat = readFileSync(path, { encoding: "utf8" });
    const sections = [];
    const pendingRequests = [];
    let current = { title: "TASKS", items: [] };
    let tableColumns;
    let reportInboxLevel;
    let collectPendingRequests = false;
    let pendingRequestDraft;
    const flushPendingRequest = () => {
      if (pendingRequestDraft === undefined) return;
      pendingRequests.push(parsePendingRequest(pendingRequestDraft.text, pendingRequestDraft.body, pendingRequestDraft.hasCheckbox));
      pendingRequestDraft = undefined;
    };
    sections.push(current);
    for (const line of stat.split(/\r?\n/u)) {
      const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
      if (heading !== null) {
        flushPendingRequest();
        const level = heading[1].length;
        const title = heading[2];
        const isReportHeading = isReportInboxHeading(title);
        const isPendingHeading = reportInboxLevel !== undefined && level > reportInboxLevel && isPendingRequestsHeading(title);
        if (isReportHeading) reportInboxLevel = level;
        else if (reportInboxLevel !== undefined && level <= reportInboxLevel) reportInboxLevel = undefined;
        collectPendingRequests = isPendingHeading;
        current = { title, items: [] };
        tableColumns = undefined;
        sections.push(current);
        continue;
      }
      const task = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/u.exec(line);
      if (task !== null) {
        flushPendingRequest();
        current.items.push({ text: task[2], done: task[1].toLowerCase() === "x" });
        if (collectPendingRequests && task[1] === " ") {
          pendingRequestDraft = { text: task[2], body: [], hasCheckbox: true };
        }
        continue;
      }
      if (collectPendingRequests && pendingRequestDraft !== undefined && /^\s{2,}\S/u.test(line)) {
        pendingRequestDraft.body.push(line.trim());
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
    flushPendingRequest();
    return { path, updatedAt: statMtime(path), sections: sections.filter((section) => section.items.length > 0), pendingRequests };
  } catch (error) {
    logger?.warn?.(`sagitta-auto-advance: cannot read task file: ${renderError(error)}`);
    return { path, updatedAt: null, sections: [], pendingRequests: [], error: "TASKS.md 暂时不可读" };
  }
}

function isReportInboxHeading(title) {
  return /(?:§\s*2\b|汇报箱)/iu.test(title);
}

function isPendingRequestsHeading(title) {
  return /需\s*涟漪\s*确认\s*[\/／]\s*行动/iu.test(title);
}

function parsePendingRequest(text, bodyLines, hasCheckbox) {
  const firstLine = text.trim();
  const titleMatch = /^\*\*(.+?)\*\*/u.exec(firstLine);
  const title = cleanMarkdown(titleMatch?.[1] ?? firstLine) || "未命名需求";
  const inlineBody = titleMatch === null ? "" : cleanMarkdown(firstLine.slice(titleMatch[0].length));
  const body = [inlineBody, ...bodyLines.map(cleanMarkdown)].filter((value) => value.length > 0).join(" ");
  return { title, hasCheckbox: hasCheckbox === true, body };
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
  STOP_MARKER,
  hasPendingInbox,
  isExactStopMessage,
  readTasks,
  readTasksFromApi,
  resolveConfiguredPaths
};
