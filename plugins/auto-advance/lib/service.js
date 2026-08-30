import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { splitCloudTaskSnapshotStrict, validateCloudTaskPage, MAX_PAGE_SIZE } from "./snapshot.js";

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
**与 codex 应用的协作（2026-08-30 约定）**：自主推进只感知 codex_dispatch 注册的有界工作——
如果当前存在活跃的 codex 工作（可用 codex_status 查询），说明任务正由 codex 应用执行，且结束/超时会自动回收：
- 若有其他独立可推进任务，继续推进；若没有，等待 codex 完成（结束会被唤起，或主动 codex_status 检查）；
- 不要重复派发相同任务、不要打断正在运行的 codex 工作；所有 codex 派发一律走 codex_dispatch 工具。
如果当前确实所有大任务都进入到阻塞状态，无法继续推进，或者需要等待异步唤起，那么请输出【停止自主推进】，并不要附加多余的解释，自主推进进程将会关闭。`;

const STOP_MARKER = "【停止自主推进】";
const PLUGIN_ID = "auto-advance";
const STATUS_EVENT = "sagitta-auto-advance/status";
const DEFAULT_IDLE_TIMEOUT_MS = 300000;
const DEFAULT_TASK_API_TIMEOUT_MS = 3000;
const DEFAULT_TASK_PAGE_SIZE = 200;
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

function normalizeTaskApiConfig(config = {}) {
  const raw = isRecord(config) ? config : {};
  const nested = isRecord(raw.apiConfig) ? raw.apiConfig : isRecord(raw.taskApiConfig) ? raw.taskApiConfig : {};
  return {
    workerApiUrl: nonEmptyString(nested.workerApiUrl ?? nested.apiUrl ?? raw.workerApiUrl ?? raw.apiUrl),
    d1ReadToken: nonEmptyString(nested.d1ReadToken ?? nested.authToken ?? raw.d1ReadToken ?? raw.authToken),
    accessClientId: nonEmptyString(nested.accessClientId ?? raw.accessClientId),
    accessClientSecret: nonEmptyString(nested.accessClientSecret ?? nested.accessSecret ?? raw.accessClientSecret ?? raw.accessSecret)
  };
}

function hasConfiguredTaskApiValue(config) {
  return config !== undefined && Object.values(config).some((value) => value !== undefined);
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
      state.cloudSnapshot = undefined;
      state.retryAttempt = 0;
      state.degraded = false;
      state.degradedReason = null;
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
    return readTasksFromApi(taskApi, this.config, this.logger()).catch((error) => {
      // This is deliberately the UI-only path. No caller used by
      // auto-advance qualification reaches readTasks/readTasksFromApi.
      this.logger()?.warn?.(`sagitta-auto-advance: task API unavailable; using stale tasksPath for UI: ${renderError(error)}`);
      const stale = readTasks(this.config.tasksPath, this.logger());
      return {
        ...stale,
        source: "file-stale",
        error: `任务 API 暂时不可用（${renderError(error)}）；当前为 file-stale 文件快照${stale.error ? `；${stale.error}` : ""}`
      };
    });
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
      cloudSnapshot: undefined
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

  availableRunnableTasks(state, snapshot = state.cloudSnapshot) {
    if (!snapshot?.runnable) return [];
    return snapshot.runnable.filter((task) => !this.hasRunningWork(state.agent, task.task_id ?? task.id));
  }

  readyToDrive(state) {
    if (!this.isLive(state) || !state.enabled || state.stoppedByProtocol || state.agent.status !== "idle") return false;
    if (hasPendingInbox(state.agent)) return false;
    // Before the first cloud read, arm a probe. Once a valid snapshot exists,
    // keep only task-id-isolated runnable work eligible; confirmations do not
    // need an async-work binding.
    if (state.cloudSnapshot !== undefined) {
      if (state.cloudSnapshot.confirmationQueue.length > 0) return true;
      return this.availableRunnableTasks(state).length > 0;
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

  queuePrompt(state, generation, text, summary, reason) {
    if (!this.isCurrentRun(state, generation)) return false;
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
    state.injectedAt = Date.now();
    state.idleSince = null;
    agentFollowup(state.agent, message);
    this.broadcast(state, reason);
    return true;
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

  scheduleBoundedWorkRecheck(state, generation) {
    if (!this.isCurrentRun(state, generation) || state.timer !== undefined) return;
    state.retrying = true;
    state.idleSince = null;
    state.timer = setTimeout(() => { void this.onTimer(state, generation); }, Math.min(30000, this.config.idleTimeoutMs));
    state.timer.unref?.();
    this.broadcast(state, "defer: bounded-work");
  }

  autoStopNoRunnableTasks(state) {
    state.enabled = false;
    state.stoppedByProtocol = true;
    this.persistedModes.set(state.agent.id, false);
    this.persistModes();
    this.clearTimer(state);
    state.idleSince = null;
    this.broadcast(state, "autostop: no-runnable-tasks");
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
        snapshot = await readCloudTaskSnapshotStrict(taskApi, this.config, controller.signal, this.logger());
      } finally {
        if (state.requestController === controller) state.requestController = undefined;
      }

      // A user message, agent status transition, disable, dispose, or timer
      // reset invalidates this generation while the network request awaited.
      if (!this.isCurrentRun(state, generation)) return;
      state.cloudSnapshot = snapshot;
      state.retryAttempt = 0;
      state.degraded = false;
      state.degradedReason = null;

      if (snapshot.confirmationQueue.length > 0) {
        const lines = snapshot.confirmationQueue.map((task) =>
          `- task_id=${task.task_id} pending_status=${task.pending_status} confirmation_id=${task.confirmation_id} expected_updated_at=${task.updated_at}`
        );
        const prompt = [
          "当前云端任务快照包含待确认的终态申请。请只使用 task_confirm 逐项处理，不要把 pending 当成已完成或已阻塞。",
          "确认清单（必须原样使用 task_id、confirmation_id、expected_updated_at）：",
          ...lines,
          "除非确认队列已处理完毕，本轮不要推进普通任务。",
        ].join("\n");
        this.queuePrompt(state, generation, prompt, "cloud task confirmation queue", "injected: confirmation-queue");
        return;
      }

      const runnable = this.availableRunnableTasks(state, snapshot);
      if (runnable.length > 0) {
        const lines = runnable.map((task) => {
          const project = typeof task.project === "string" && task.project.trim() ? ` project=${JSON.stringify(task.project.trim())}` : "";
          const title = typeof task.title === "string" ? task.title.trim() : "";
          return `- task_id=${task.task_id} status=${task.status} pending_status=null updated_at=${task.updated_at}${project} title=${JSON.stringify(title)}`;
        });
        const prompt = [
          AUTONOMOUS_PROMPT,
          "",
          "本轮严格使用下面这份完整云端 runnable 清单：",
          ...lines,
          "清单外任务本轮不得推进；若要新增工作，先 task_create，并等待下一次完整云端快照。终态只能先申请 pending，再用 task_confirm 完成确认。",
        ].join("\n");
        this.queuePrompt(state, generation, prompt, "cloud runnable task snapshot", "injected: runnable-tasks");
        return;
      }

      if (snapshot.runnable.length > 0) {
        // Runnable tasks exist but every one is isolated behind its own
        // bounded work. They are not an objective empty snapshot.
        this.scheduleBoundedWorkRecheck(state, generation);
        return;
      }

      this.autoStopNoRunnableTasks(state);
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
    state.enabled = false;
    state.stoppedByProtocol = true;
    this.persistedModes.set(state.agent.id, false);
    this.persistModes();
    this.clearTimer(state);
    state.idleSince = null;
    state.retrying = false;
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
    project,                           // 分组键
    hasCheckbox: item?.checkbox === 1 || item?.checkbox === "1",
    body: typeof item?.body === "string" ? cleanBody(item.body) : "",
  };
  const id = typeof item?.task_id === "string" ? item.task_id : typeof item?.id === "string" ? item.id : undefined;
  if (id !== undefined) task.task_id = id;
  return task;
}

function mapApiTaskSnapshot(items, tasksPath, source = "cloud") {
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
    .sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title));
  return { path: tasksPath, updatedAt, sections, pendingRequests, source };
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

function buildTaskAuthHeaders(apiConfig) {
  const headers = { Accept: "application/json", "Accept-Encoding": "identity" };
  // Keep the exact memory ordering: a read Bearer wins over Access headers.
  if (apiConfig?.d1ReadToken) headers.Authorization = `Bearer ${apiConfig.d1ReadToken}`;
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

async function requestTaskApiPage(apiConfig, config, page, signal, logger) {
  if (completeTaskApiConfig(apiConfig) === undefined) {
    throw taskApiUnavailable("Worker API 认证或地址配置不完整");
  }
  const url = taskApiUrl(apiConfig.workerApiUrl, page, config.taskPageSize);
  assertTaskTransportPolicy(apiConfig.workerApiUrl, config.proxy);
  const requestHeaders = buildTaskAuthHeaders(apiConfig);
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
        method: "GET",
        url: url.toString(),
        headers: requestHeaders,
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
      const response = await fetch(url.toString(), { method: "GET", headers: requestHeaders, signal: linked.signal });
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
  try {
    const pageData = validateCloudTaskPage(payload);
    logger?.debug?.(`sagitta-auto-advance: task API returned page=${pageData.page} items=${pageData.items.length} total=${pageData.total}`);
    return pageData;
  } catch (error) {
    throw taskApiUnavailableFrom(error);
  }
}

async function readCloudTaskSnapshotStrict(apiConfig, config, signal, logger) {
  try {
    const first = await requestTaskApiPage(apiConfig, config, 1, signal, logger);
    const pageCount = Math.max(1, Math.ceil(first.total / first.size));
    const pages = [first];
    for (let page = 2; page <= pageCount; page++) {
      pages.push(await requestTaskApiPage(apiConfig, config, page, signal, logger));
    }
    return splitCloudTaskSnapshotStrict({ pages });
  } catch (error) {
    throw taskApiUnavailableFrom(error);
  }
}

async function readTasksFromApi(apiConfig, config, logger) {
  const snapshot = await readCloudTaskSnapshotStrict(apiConfig, config, undefined, logger);
  return mapApiTaskSnapshot(snapshot.items, config.tasksPath, "cloud");
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
    return { path, updatedAt: statMtime(path), sections: sections.filter((section) => section.items.length > 0), pendingRequests, source: "file" };
  } catch (error) {
    logger?.warn?.(`sagitta-auto-advance: cannot read task file: ${renderError(error)}`);
    return { path, updatedAt: null, sections: [], pendingRequests: [], source: "file", error: "TASKS.md 暂时不可读" };
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
  readCloudTaskSnapshotStrict,
  splitCloudTaskSnapshotStrict,
  buildTaskAuthHeaders,
  isLoopbackUrl,
  resolveConfiguredPaths
};
