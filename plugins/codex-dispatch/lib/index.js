// ============================================================================
// sagitta-codex — codex 派单适配器
// ============================================================================
// codex-dispatch 不再拥有工作注册表。它只负责受控子进程、codex 元数据和
// 兼容 facade；所有 work_id/task_id/status 生命周期都委托给
// sagitta-async-work。async-work 缺失或不可用时，派单和状态查询均 fail closed。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

const name = "sagitta-codex";
const inject = ["tools", "agents"];

const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_WORK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_CONCURRENT = 4;

const Config = z.object({
  codexPath: z.string().default("codex").description("codex CLI 可执行文件（或 PATH 名）。"),
  defaultModel: z.string().default(DEFAULT_MODEL).description("默认模型（codex-model-policy.md 当前档位）。"),
  workTimeoutMs: z.number().default(DEFAULT_WORK_TIMEOUT_MS).description("codex 工作超时（毫秒），必须在 1 秒至 24 小时内。"),
  maxConcurrent: z.number().min(1).default(MAX_CONCURRENT).description("每 agent 并发 codex 工作上限。"),
  sandbox: z.string().default("danger-full-access").description("codex 沙箱模式。"),
  reasoningEffort: z.string().default("xhigh").description("codex 推理档位。"),
  legacyDetachedPids: z.array(z.number()).default([])
    .description("历史 detached codex PID（仅清理明确提供的 PID；无法确认时 async-work 保持 degraded）。"),
});

const WORK_STATUSES = ["running", "completed", "failed", "cancelled", "expired"];
const CODEX_WORK_FIELDS = {
  work_id: { type: "string", required: true },
  workId: { type: "string" },
  task_id: { type: "string", required: true },
  owner_id: { type: "string", required: true },
  kind: { type: "string", required: true },
  desc: { type: "string", required: true },
  task: { type: "string" },
  model: { type: "string" },
  pid: { type: "integer" },
  started_at: { type: "string", required: true },
  startedAt: { type: "integer" },
  timeout_ms: { type: "integer", required: true },
  timeoutMs: { type: "integer" },
  status: { type: "string", required: true, enum: WORK_STATUSES },
  ended_at: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  endedAt: { oneOf: [{ type: "integer" }, { type: "null" }] },
  reason: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  exit_code: { oneOf: [{ type: "integer" }, { type: "null" }] },
};
const CODEX_WORK_SCHEMA = { type: "object", additionalProperties: false, properties: CODEX_WORK_FIELDS };

function loggerWarn(ctx, message) {
  try { ctx?.logger?.warn?.(message); } catch { /* diagnostics are best effort */ }
}

function asyncWorkFrom(ctx) {
  try {
    const direct = ctx?.["sagitta-async-work"];
    if (direct !== undefined) return direct;
    return typeof ctx?.get === "function" ? ctx.get("sagitta-async-work", false) : undefined;
  } catch {
    return undefined;
  }
}

function requireAsyncWork(ctx) {
  const service = asyncWorkFrom(ctx);
  if (!service || typeof service.register !== "function" || typeof service.listActive !== "function" ||
      typeof service.get !== "function" || typeof service.complete !== "function" ||
      typeof service.fail !== "function" || typeof service.cancel !== "function" ||
      typeof service.reap !== "function") {
    const error = new Error("sagitta-async-work 服务未加载或接口不完整；为避免未登记工作，codex 派单已保守拒绝");
    error.code = "ASYNC_WORK_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
  return service;
}

function ownerIdOf(exec) {
  const id = exec?.agent?.id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : "unknown";
}

function workIdOf(work) {
  return work?.work_id ?? work?.workId ?? work?.id;
}

function legacyStatus(status) {
  switch (status) {
    case "completed": return "done";
    case "cancelled": return "killed";
    case "expired": return "stale";
    default: return status;
  }
}

function epochFromIso(value) {
  if (typeof value !== "string") return undefined;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : undefined;
}

function toCodexWork(work, metadata = {}) {
  if (!work) return null;
  const workId = workIdOf(work);
  const view = {
    work_id: String(work.work_id ?? workId ?? ""),
    workId: String(workId ?? ""),
    task_id: String(work.task_id ?? metadata.taskId ?? ""),
    owner_id: String(work.owner_id ?? metadata.ownerId ?? ""),
    kind: String(work.kind ?? "codex"),
    desc: String(work.desc ?? metadata.task ?? ""),
    task: String(work.desc ?? metadata.task ?? ""),
    started_at: String(work.started_at ?? ""),
    timeout_ms: Number(work.timeout_ms),
    status: work.status,
    ended_at: work.ended_at ?? null,
    reason: work.reason ?? null,
  };
  if (metadata.model !== undefined) view.model = metadata.model;
  if (metadata.pid !== undefined && metadata.pid !== null) view.pid = metadata.pid;
  const startedAt = epochFromIso(work.started_at);
  if (startedAt !== undefined) view.startedAt = startedAt;
  if (Number.isInteger(work.timeout_ms)) view.timeoutMs = work.timeout_ms;
  if (work.ended_at !== null && work.ended_at !== undefined) {
    const endedAt = epochFromIso(work.ended_at);
    if (endedAt !== undefined) view.endedAt = endedAt;
  } else {
    view.endedAt = null;
  }
  if (metadata.exitCode !== undefined) view.exit_code = metadata.exitCode;
  return view;
}

function toLegacyCodexWork(work, metadata = {}) {
  const view = toCodexWork(work, metadata);
  if (!view) return null;
  return {
    ...view,
    id: view.work_id,
    status: legacyStatus(view.status),
    ...(view.exit_code !== undefined ? { exitCode: view.exit_code } : {}),
  };
}

function runCodex({ codexPath, args, pidRef, cwd }) {
  const { command, args: prefix } = resolveCodexLaunch(codexPath);
  const child = spawn(command, [...prefix, ...args], {
    // v1 is process-scoped: child lifetime is controlled by this adapter and
    // must not survive DSH disposal as a detached orphan.
    detached: false,
    stdio: "ignore",
    windowsHide: true,
    ...(cwd ? { cwd } : {}),
  });
  if (child.pid === undefined) {
    const error = new Error("codex 启动失败（spawn 未产生进程，命令不可执行）");
    error.code = "SPAWN_NO_PID";
    throw error;
  }
  if (pidRef) pidRef.current = child.pid;
  // Intentionally do not call unref(): a running codex child belongs to this
  // DSH process and is terminated by adapter disposal.
  return child;
}

/**
 * Locate and request termination of explicitly identified legacy detached
 * processes. We never scan/kill arbitrary codex processes: old PIDs must come
 * from the migration config or SAGITTA_CODEX_LEGACY_PIDS. A still-live PID is
 * reported as uncertain so async-work can fail closed until the next check.
 */
function cleanupLegacyDetachedCodex(pids, logger) {
  const normalized = [...new Set((Array.isArray(pids) ? pids : [])
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
  let attempted = 0;
  let uncertain = false;
  for (const pid of normalized) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (error) {
      if (error?.code !== "ESRCH") uncertain = true;
    }
    if (!alive) continue;
    attempted++;
    try {
      process.kill(pid, "SIGTERM");
      // A signal being accepted does not prove that the detached process has
      // exited. Keep the registry unavailable until a later verification.
      try { process.kill(pid, 0); uncertain = true; } catch (error) {
        if (error?.code !== "ESRCH") uncertain = true;
      }
    } catch {
      uncertain = true;
      try { logger?.(`sagitta-codex: 无法终止历史 detached PID ${pid}`); } catch { /* noop */ }
    }
  }
  return { ok: !uncertain, attempted, pids: normalized };
}

function legacyPidsFrom(config) {
  if (Array.isArray(config?.legacyDetachedPids)) return config.legacyDetachedPids;
  const raw = process.env.SAGITTA_CODEX_LEGACY_PIDS;
  if (!raw) return [];
  return raw.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value));
}

function terminateChild(child) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return false;
  try {
    if (typeof child.kill === "function") return child.kill("SIGTERM") !== false;
  } catch {
    // The process may have exited between the state check and kill.
  }
  return false;
}

/**
 * Compatibility wrapper for callers that imported CodexWorkRegistry directly.
 * It is an adapter over the generic service, not another Map-backed registry.
 */
class CodexWorkRegistry {
  constructor({ asyncWork, maxConcurrent = MAX_CONCURRENT } = {}) {
    this.asyncWork = asyncWork;
    this.maxConcurrent = maxConcurrent;
  }

  _service() {
    if (!this.asyncWork || typeof this.asyncWork.register !== "function" ||
        typeof this.asyncWork.listActive !== "function" || typeof this.asyncWork.get !== "function" ||
        typeof this.asyncWork.complete !== "function" || typeof this.asyncWork.fail !== "function" ||
        typeof this.asyncWork.cancel !== "function" || typeof this.asyncWork.reap !== "function") {
      const error = new Error("sagitta-async-work 服务不可用；codex registry 已保守拒绝操作");
      error.code = "ASYNC_WORK_UNAVAILABLE";
      throw error;
    }
    return this.asyncWork;
  }

  register(ownerId, { kind = "codex", task, taskId, task_id: taskIdSnake, model, timeoutMs } = {}) {
    const service = this._service();
    const active = service.listActive(ownerId, {});
    if (!Array.isArray(active)) throw new Error("async-work listActive 未返回数组");
    if (active.filter((work) => work.kind === "codex").length >= this.maxConcurrent) {
      throw new Error(`codex 并发上限 ${this.maxConcurrent} 已满（agent ${ownerId}）`);
    }
    return service.register({ ownerId, taskId: taskId ?? taskIdSnake, kind, desc: task, timeoutMs });
  }

  listActive(ownerId, taskId) {
    return this._service().listActive(ownerId, taskId === undefined ? {} : { taskId });
  }

  reap(ownerId) {
    return this._service().reap(ownerId);
  }

  get(ownerId, workId) {
    return this._service().get(ownerId, workId);
  }

  markEnded(ownerId, workId, status, _exitCode, taskId) {
    const service = this._service();
    if (status === "done" || status === "completed") return service.complete(ownerId, workId, taskId);
    if (status === "failed") return service.fail(ownerId, workId, "codex exit failed", taskId);
    if (status === "killed" || status === "cancelled") return service.cancel(ownerId, workId, taskId);
    return service.get(ownerId, workId);
  }

  kill(ownerId, workId, taskId) {
    return { ok: true, work: this._service().cancel(ownerId, workId, taskId) };
  }
}

function registerCodexTools(ctx, options) {
  const { resolved, records, disposed } = options;

  ctx.tools.register(defineTool({
    name: "codex_dispatch",
    description:
      "派发 codex CLI 后台任务并登记为有界异步工作。task_id 必填且会写入通用 async-work 注册表；" +
      "工作结束/失败/超时会自动更新状态，DSH dispose 会取消并终止受控子进程。async-work 缺失时保守拒绝派单。",
    parameters: {
      task_id: { type: "string", required: true, description: "绑定的任务 id；不能省略或用当前任务猜测。" },
      task: { type: "string", required: true, description: "codex 任务描述（完整、自包含，codex 无本会话上下文）。" },
      model: { type: "string", description: `模型（默认 ${DEFAULT_MODEL}；档位见 codex-model-policy.md）。` },
      timeoutMs: { type: "integer", description: "本工作超时（毫秒，1 秒至 24 小时）。" },
      cwd: { type: "string", description: "codex 工作目录（默认继承 DSH 进程 cwd）。" },
    },
    output: { schema: CODEX_WORK_SCHEMA },
    render: (_args, value) => [{
      type: "text",
      text: `## codex 已派发（${value.work_id}）\n\n- task_id：${value.task_id}\n- 模型：${value.model}\n- 状态：${value.status}\n- 任务：${value.task.slice(0, 120)}${value.task.length > 120 ? "…" : ""}\n\n可用 codex_status 查询。`,
    }],
    presentationMeta: (_args, value) => ({ work_id: value.work_id, task_id: value.task_id, status: value.status }),
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (disposed.value) throw new Error("sagitta-codex 已进入 dispose，拒绝新派单");
      const ownerId = ownerIdOf(exec);
      const asyncWork = requireAsyncWork(ctx);
      const active = asyncWork.listActive(ownerId, {});
      if (!Array.isArray(active)) throw new Error("async-work listActive 未返回数组，已保守拒绝派单");
      const codexActive = active.filter((work) => work?.kind === "codex");
      if (codexActive.length >= resolved.maxConcurrent) {
        throw new Error(`codex 并发上限 ${resolved.maxConcurrent} 已满（agent ${ownerId}）`);
      }

      const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : resolved.defaultModel;
      const codexArgs = [
        "exec",
        "--skip-git-repo-check",
        "-s", resolved.sandbox,
        "-m", model,
        "-c", `model_reasoning_effort=${resolved.reasoningEffort}`,
        String(args.task),
      ];
      const timeoutMs = args.timeoutMs === undefined ? resolved.workTimeoutMs : args.timeoutMs;
      let work;
      try {
        work = asyncWork.register({
          ownerId,
          taskId: args.task_id,
          kind: "codex",
          desc: String(args.task),
          timeoutMs,
        });
      } catch (error) {
        throw new Error(`codex 派发被拒：${error.message}`);
      }
      const workId = workIdOf(work);
      if (!workId) throw new Error("async-work register 未返回 work_id，已保守拒绝启动 codex");
      const metadata = {
        ownerId,
        taskId: args.task_id,
        task: String(args.task),
        model,
        child: null,
        pid: null,
        exitCode: undefined,
      };
      records.set(String(workId), metadata);

      const pidRef = { current: null };
      let child;
      try {
        child = runCodex({
          codexPath: resolved.codexPath,
          args: codexArgs,
          pidRef,
          cwd: typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined,
        });
      } catch (error) {
        metadata.exitCode = null;
        try { asyncWork.fail(ownerId, workId, `spawn failed: ${error.message}`, args.task_id); } catch { /* preserve original spawn error */ }
        records.delete(String(workId));
        throw new Error(`codex 启动失败：${error.message}`);
      }
      metadata.child = child;
      metadata.pid = pidRef.current;

      const settle = (kind, code, signal) => {
        metadata.exitCode = code ?? null;
        try {
          if (kind === "completed") asyncWork.complete(ownerId, workId, args.task_id);
          else asyncWork.fail(ownerId, workId, signal ? `codex terminated by ${signal}` : `codex exited with code ${code}`, args.task_id);
        } catch (error) {
          // Timeout, explicit cancel or dispose may win the race. The generic
          // registry's terminal guard is authoritative in that case.
          if (error?.code !== "ASYNC_WORK_TERMINAL") loggerWarn(ctx, `sagitta-codex: work ${workId} settle ignored: ${error?.message ?? error}`);
        }
      };
      child.on("error", (error) => {
        settle("failed", null, error?.message ?? "spawn-error");
        loggerWarn(ctx, `sagitta-codex: work ${workId} spawn error: ${error?.message ?? String(error)}`);
      });
      child.on("exit", (code, signal) => settle(signal === null && code === 0 ? "completed" : "failed", code, signal));

      return toCodexWork({ ...work, work_id: workId, task_id: args.task_id, desc: String(args.task) }, metadata);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `codex_dispatch(task_id=${args.task_id}, model=${args.model ?? "luna"}, task=${JSON.stringify(args.task).slice(0, 60)})`,
      kind: "codex",
      rawInput: JSON.stringify(args),
    }),
  }));

  ctx.tools.register(defineTool({
    name: "codex_status",
    description:
      "查询 codex 派单工作状态（running/completed/failed/cancelled/expired）。可按 work_id、task_id 查询；" +
      "返回 work_id/task_id 及通用 async-work 生命周期字段。async-work 不可用时保守报错。",
    parameters: {
      work_id: { type: "string", description: "工作 id（codex_dispatch 返回）。" },
      task_id: { type: "string", description: "按任务 id 过滤。" },
      // Keep the old camel-case input accepted for existing callers.
      workId: { type: "string", description: "兼容旧调用的 work_id 写法。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { works: { type: "array", items: CODEX_WORK_SCHEMA, required: true } },
      },
    },
    render: (_args, value) => [{
      type: "text",
      text: value.works.length === 0
        ? "## codex 工作状态\n\n（无匹配工作）"
        : "## codex 工作状态\n\n" + value.works.map((work) => `- **${work.work_id}** [${work.status}] task=${work.task_id} ${work.task}`).join("\n"),
    }],
    presentationMeta: (_args, value) => ({ count: value.works.length }),
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const asyncWork = requireAsyncWork(ctx);
      const ownerId = ownerIdOf(exec);
      const requestedId = args.work_id ?? args.workId;
      const result = [];
      if (requestedId !== undefined) {
        const work = asyncWork.get(ownerId, requestedId);
        if (work && (args.task_id === undefined || work.task_id === args.task_id) && work.kind === "codex") {
          result.push(toCodexWork(work, records.get(String(requestedId))));
        }
      } else {
        for (const [workId, metadata] of records.entries()) {
          if (metadata.ownerId !== ownerId || (args.task_id !== undefined && metadata.taskId !== args.task_id)) continue;
          const work = asyncWork.get(ownerId, workId);
          if (work?.kind === "codex") result.push(toCodexWork(work, metadata));
        }
        // After a process restart this adapter has no historical metadata. The
        // process-scoped registry also has no restored records, but active
        // entries from a test/custom service can still be reported safely.
        if (result.length === 0) {
          const active = asyncWork.listActive(ownerId, args.task_id === undefined ? {} : { taskId: args.task_id });
          if (!Array.isArray(active)) throw new Error("async-work listActive 未返回数组");
          for (const work of active.filter((item) => item?.kind === "codex")) result.push(toCodexWork(work, records.get(String(workIdOf(work)))));
        }
      }
      return { works: result.filter(Boolean) };
    },
    presentCall: (args) => ({ card: "generic", title: `codex_status(work_id=${args.work_id ?? args.workId ?? "all"})`, kind: "codex", rawInput: JSON.stringify(args) }),
  }));
}

function apply(ctx, config) {
  const resolved = {
    codexPath: config?.codexPath ?? "codex",
    defaultModel: config?.defaultModel ?? DEFAULT_MODEL,
    workTimeoutMs: config?.workTimeoutMs ?? DEFAULT_WORK_TIMEOUT_MS,
    maxConcurrent: Number.isFinite(Number(config?.maxConcurrent)) && Number(config.maxConcurrent) > 0
      ? Number(config.maxConcurrent) : MAX_CONCURRENT,
    sandbox: config?.sandbox ?? "danger-full-access",
    reasoningEffort: config?.reasoningEffort ?? "xhigh",
  };
  const records = new Map();
  const disposed = { value: false };
  const cleanupTimer = { value: null };
  const asyncWork = asyncWorkFrom(ctx);
  if (!asyncWork) loggerWarn(ctx, "sagitta-codex: sagitta-async-work 缺失；codex 工具将 fail closed，不会启动未登记子进程");

  const legacy = cleanupLegacyDetachedCodex(legacyPidsFrom(config), (message) => loggerWarn(ctx, message));
  if (!legacy.ok && asyncWork?.markUnavailable) {
    const reason = `历史 detached codex 进程清理结果待确认（${legacy.attempted} 个 PID）`;
    asyncWork.markUnavailable(reason);
    cleanupTimer.value = setTimeout(() => {
      let allGone = true;
      for (const pid of legacy.pids) {
        try { process.kill(pid, 0); allGone = false; } catch (error) {
          if (error?.code !== "ESRCH") allGone = false;
        }
      }
      if (allGone) asyncWork.markAvailable?.();
      cleanupTimer.value = null;
    }, 250);
    cleanupTimer.value.unref?.();
  }

  const dispose = () => {
    if (disposed.value) return;
    disposed.value = true;
    if (cleanupTimer.value !== null) clearTimeout(cleanupTimer.value);
    const service = asyncWorkFrom(ctx);
    // Cancel in the generic registry before terminating children, then forget
    // adapter metadata. A missing service still cannot prevent child cleanup.
    for (const [workId, metadata] of records.entries()) {
      try {
        const work = service?.get?.(metadata.ownerId, workId);
        if (work?.status === "running") service.cancel(metadata.ownerId, workId, metadata.taskId);
      } catch (error) {
        loggerWarn(ctx, `sagitta-codex: dispose 无法 cancel work ${workId}：${error?.message ?? error}`);
      }
      terminateChild(metadata.child);
    }
    records.clear();
  };

  const facade = {
    listActiveWorks(agentId, options = {}) {
      const service = requireAsyncWork(ctx);
      const active = service.listActive(agentId, options.taskId === undefined ? {} : { taskId: options.taskId });
      if (!Array.isArray(active)) throw new Error("async-work listActive 未返回数组");
      return active.filter((work) => work?.kind === "codex").map((work) => toLegacyCodexWork(work, records.get(String(workIdOf(work)))));
    },
    reapStale(agentId) {
      return requireAsyncWork(ctx).reap(agentId);
    },
    getWork(agentId, workId) {
      const work = requireAsyncWork(ctx).get(agentId, workId);
      return work?.kind === "codex" ? toLegacyCodexWork(work, records.get(String(workId))) : null;
    },
  };
  try { ctx?.provide?.(name, facade); } catch { /* optional in minimal harnesses */ }
  registerCodexTools(ctx, { resolved, records, disposed });

  if (typeof ctx?.effect === "function") ctx.effect(() => dispose, "sagitta-codex: controlled child cleanup");
  else ctx?.on?.("dispose", dispose);
  return facade;
}

/** Resolve the native Windows binary where available, avoiding a console window. */
function resolveCodexLaunch(codexPath) {
  if (process.platform !== "win32") return { command: codexPath, args: [] };
  const winTriple = "x86_64-pc-windows-msvc";
  const vendorExe = join("node_modules", "@openai", "codex-win32-x64", "vendor", winTriple, "bin", "codex.exe");
  const exeCandidates = [
    process.env.CODEX_EXE_PATH,
    join(process.env.APPDATA ?? "", "npm", vendorExe),
    join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", vendorExe),
  ];
  for (const candidate of exeCandidates) if (candidate && existsSync(candidate)) return { command: candidate, args: [] };
  const jsCandidates = [
    process.env.CODEX_JS_PATH,
    join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
    join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
  ];
  for (const candidate of jsCandidates) if (candidate && existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  return { command: codexPath, args: [] };
}

export {
  CODEX_WORK_FIELDS,
  CodexWorkRegistry,
  Config,
  cleanupLegacyDetachedCodex,
  inject,
  name,
  resolveCodexLaunch,
  runCodex,
  apply,
};
