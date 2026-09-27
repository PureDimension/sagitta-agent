// ============================================================================
// sagitta-codex — codex app-server 常驻会话适配器
// ============================================================================

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { CodexAppServer } from "./app-server.js";

const name = "sagitta-codex";
const inject = ["tools", "agents", "sagitta-async-work", "sagitta-manager"];
const DEFAULT_WORK_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_CONCURRENT = 4;

const Config = z.object({
  workTimeoutMs: z.number().default(DEFAULT_WORK_TIMEOUT_MS).description("codex 工作超时（毫秒）。"),
  maxConcurrent: z.number().min(1).default(MAX_CONCURRENT).description("每 agent 并发 codex 工作上限。"),
  sandbox: z.string().default("danger-full-access").description("codex 沙箱模式。"),
  reasoningEffort: z.string().default("xhigh").description("codex 推理档位。"),
});

const WORK_STATUSES = ["running", "completed", "failed", "cancelled", "expired"];
const CODEX_WORK_FIELDS = {
  work_id: { type: "string", required: true },
  task_id: { type: "string", required: true },
  owner_id: { type: "string", required: true },
  kind: { type: "string", required: true },
  desc: { type: "string", required: true },
  model: { type: "string", required: true },
  cwd: { type: "string", required: true },
  thread_id: { type: "string", required: true },
  turn_id: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  session_status: { type: "string", required: true },
  response: { type: "string", required: true },
  started_at: { type: "string", required: true },
  timeout_ms: { type: "integer", required: true },
  status: { type: "string", required: true, enum: WORK_STATUSES },
  ended_at: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  reason: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
};
const CODEX_WORK_SCHEMA = { type: "object", additionalProperties: false, properties: CODEX_WORK_FIELDS };

function loggerWarn(ctx, message) {
  try { ctx?.logger?.warn?.(message); } catch { /* diagnostics are best effort */ }
}

function asyncWorkFrom(ctx) {
  return ctx?.["sagitta-async-work"];
}

function managerFrom(ctx) {
  return ctx?.["sagitta-manager"];
}

function requireAsyncWork(ctx) {
  const service = asyncWorkFrom(ctx);
  if (!service || typeof service.register !== "function" || typeof service.listActive !== "function" ||
      typeof service.get !== "function" || typeof service.complete !== "function" ||
      typeof service.fail !== "function" || typeof service.cancel !== "function") {
    const error = new Error("sagitta-async-work 服务未加载或接口不完整；codex 派单已拒绝");
    error.code = "ASYNC_WORK_UNAVAILABLE";
    throw error;
  }
  return service;
}

function requireManager(ctx) {
  const service = managerFrom(ctx);
  if (!service || typeof service.apiConfig !== "function") {
    throw new Error("sagitta-manager 服务未加载或接口不完整；无法读取 codexModel");
  }
  return service;
}

function ownerIdOf(exec) {
  const id = exec?.agent?.id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : "unknown";
}

function registeredWorkId(work) {
  if (typeof work?.work_id !== "string" || work.work_id.length === 0) {
    throw new Error("async-work register 未返回 work_id");
  }
  return work.work_id;
}

function sessionView(work, record) {
  if (record === null || record === undefined) throw new Error("codex 会话元数据不存在");
  return {
    ...work,
    model: record.model,
    cwd: record.cwd,
    thread_id: record.threadId,
    turn_id: record.activeTurnId,
    session_status: record.sessionStatus,
    response: record.response,
  };
}

function recordFor(records, workId, ownerId) {
  const record = records.get(workId);
  if (record === undefined || record.ownerId !== ownerId) return null;
  return record;
}

function registerCodexTools(ctx, { resolved, records, disposed, appServer }) {
  ctx.tools.register(defineTool({
    name: "codex_dispatch",
    description: "在常驻 codex app-server 中建立会话并启动第一轮；工作生命周期委托给 sagitta-async-work。",
    parameters: {
      task_id: { type: "string", required: true, description: "绑定的任务 id。" },
      task: { type: "string", required: true, description: "第一轮 codex 指示。" },
      model: { type: "string", description: "模型；省略时读取 sagitta-manager.apiConfig().codexModel。" },
      cwd: { type: "string", description: "会话工作目录；省略时继承当前进程目录。" },
    },
    output: {
      schema: CODEX_WORK_SCHEMA,
      render: (_args, value) => [{
        type: "text",
        text: `## codex 已派发（${value.work_id}）\n\n- task_id：${value.task_id}\n- 模型：${value.model}\n- 状态：${value.status}\n- 会话：${value.thread_id}\n\n可用 codex_status 查询。`,
      }],
      presentationMeta: (_args, value) => ({ work_id: value.work_id, task_id: value.task_id, status: value.status }),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (disposed.value) throw new Error("sagitta-codex 已进入 dispose，拒绝新派单");
      const ownerId = ownerIdOf(exec);
      const asyncWork = requireAsyncWork(ctx);
      const active = asyncWork.listActive(ownerId, {});
      if (!Array.isArray(active)) throw new Error("async-work listActive 未返回数组");
      if (active.filter((work) => work.kind === "codex").length >= resolved.maxConcurrent) {
        throw new Error(`codex 并发上限 ${resolved.maxConcurrent} 已满（agent ${ownerId}）`);
      }

      const manager = requireManager(ctx);
      const apiConfig = await manager.apiConfig();
      const model = typeof args.model === "string" && args.model.trim()
        ? args.model.trim()
        : apiConfig.codexModel;
      if (typeof model !== "string" || model.trim().length === 0) throw new Error("sagitta-manager.apiConfig().codexModel 为空");
      const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : process.cwd();
      const task = String(args.task);
      const work = asyncWork.register({
        ownerId,
        taskId: args.task_id,
        kind: "codex",
        desc: task,
        timeoutMs: resolved.workTimeoutMs,
      });
      const workId = registeredWorkId(work);
      const record = {
        ownerId,
        taskId: args.task_id,
        workId,
        model: model.trim(),
        cwd,
        threadId: null,
        activeTurnId: null,
        sessionStatus: "starting",
        response: "",
      };
      records.set(workId, record);

      try {
        await appServer.connect();
        const started = await appServer.request("thread/start", {
          cwd,
          model: record.model,
          sandbox: resolved.sandbox,
          reasoningEffort: resolved.reasoningEffort,
        });
        record.threadId = started.thread.id;
        record.sessionStatus = "idle";
        const turn = await appServer.request("turn/start", {
          threadId: record.threadId,
          input: [{ type: "text", text: task }],
        });
        record.activeTurnId = turn.turn.id;
        record.sessionStatus = "active";
      } catch (error) {
        asyncWork.fail(ownerId, workId, `codex app-server 启动任务失败：${error.message}`, args.task_id);
        records.delete(workId);
        throw error;
      }
      return sessionView(asyncWork.get(ownerId, workId), record);
    },
    presentCall: (args) => ({
      card: "generic",
      title: `codex_dispatch(task_id=${args.task_id}, task=${JSON.stringify(args.task).slice(0, 60)})`,
      kind: "codex",
      rawInput: JSON.stringify(args),
    }),
  }));

  ctx.tools.register(defineTool({
    name: "codex_status",
    description: "查询 codex 会话与 async-work 综合状态；不传 work_id 时返回当前 owner 的 active codex 工作。",
    parameters: {
      work_id: { type: "string", description: "codex_dispatch 返回的工作 id。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { works: { type: "array", items: CODEX_WORK_SCHEMA, required: true } },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.works.length === 0
          ? "## codex 工作状态\n\n（无匹配工作）"
          : "## codex 工作状态\n\n" + value.works.map((work) => `- **${work.work_id}** [${work.status}] task=${work.task_id} ${work.desc}`).join("\n"),
      }],
      presentationMeta: (_args, value) => ({ count: value.works.length }),
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const asyncWork = requireAsyncWork(ctx);
      const ownerId = ownerIdOf(exec);
      if (args.work_id !== undefined) {
        const work = asyncWork.get(ownerId, args.work_id);
        const record = work?.kind === "codex" ? recordFor(records, args.work_id, ownerId) : null;
        return { works: work !== null && record !== null ? [sessionView(work, record)] : [] };
      }
      const active = asyncWork.listActive(ownerId, {});
      if (!Array.isArray(active)) throw new Error("async-work listActive 未返回数组");
      return {
        works: active
          .filter((work) => work.kind === "codex")
          .map((work) => sessionView(work, recordFor(records, work.work_id, ownerId))),
      };
    },
    presentCall: (args) => ({ card: "generic", title: `codex_status(work_id=${args.work_id ?? "all"})`, kind: "codex", rawInput: JSON.stringify(args) }),
  }));

  ctx.tools.register(defineTool({
    name: "codex_append",
    description: "向指定 codex 会话追加一条指示：该会话正在运行时并入当前轮次（下一步即被读取），已结束时开新一轮。",
    parameters: {
      work_id: { type: "string", required: true, description: "指定 codex 会话的工作 id。" },
      message: { type: "string", required: true, description: "追加给指定会话的指示。" },
    },
    output: {
      schema: CODEX_WORK_SCHEMA,
      render: (_args, value) => [{ type: "text", text: `## codex 指示已追加\n\n- work_id：${value.work_id}\n- 状态：${value.status}\n- 轮次：${value.turn_id}` }],
      presentationMeta: (_args, value) => ({ work_id: value.work_id, status: value.status }),
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const ownerId = ownerIdOf(exec);
      const asyncWork = requireAsyncWork(ctx);
      const work = asyncWork.get(ownerId, args.work_id);
      const record = work?.kind === "codex" ? recordFor(records, args.work_id, ownerId) : null;
      if (work === null || record === null) throw new Error(`找不到 codex 工作 ${args.work_id}`);
      if (record.threadId === null) throw new Error(`codex 工作 ${args.work_id} 没有关联会话`);
      await appServer.request("turn/start", {
        threadId: record.threadId,
        input: [{ type: "text", text: String(args.message) }],
      });
      return sessionView(work, record);
    },
    presentCall: (args) => ({ card: "generic", title: `codex_append(work_id=${args.work_id})`, kind: "codex", rawInput: JSON.stringify(args) }),
  }));
}

function apply(ctx, config) {
  const resolved = {
    workTimeoutMs: config?.workTimeoutMs ?? DEFAULT_WORK_TIMEOUT_MS,
    maxConcurrent: Number.isFinite(Number(config?.maxConcurrent)) && Number(config.maxConcurrent) > 0
      ? Number(config.maxConcurrent) : MAX_CONCURRENT,
    sandbox: config?.sandbox ?? "danger-full-access",
    reasoningEffort: config?.reasoningEffort ?? "xhigh",
  };
  const records = new Map();
  const disposed = { value: false };
  const appServer = new CodexAppServer({ logger: (message) => loggerWarn(ctx, message) });
  const notificationDisposer = appServer.onNotification((method, params) => {
    const threadId = params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId;
    const record = [...records.values()].find((item) => item.threadId === threadId);
    if (record === undefined) return;
    if (method === "thread/status/changed") {
      record.sessionStatus = params.status.type;
      return;
    }
    if (method === "turn/started") {
      record.activeTurnId = params.turn.id;
      record.sessionStatus = "active";
      return;
    }
    if (method === "item/agentMessage/delta") {
      record.response += params.delta;
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.text === "string") {
      record.response = params.item.text;
      return;
    }
    if (method !== "turn/completed") return;
    record.activeTurnId = null;
    record.sessionStatus = "idle";
    const workId = record.workId;
    const asyncWork = requireAsyncWork(ctx);
    const status = params.turn?.status;
    try {
      if (status === undefined || status === "completed") asyncWork.complete(record.ownerId, workId, record.taskId);
      else asyncWork.fail(record.ownerId, workId, `codex turn 状态：${status}`, record.taskId);
    } catch (error) {
      if (error.code !== "ASYNC_WORK_TERMINAL") throw error;
    }
  });

  const settledDisposer = ctx.on("async-work/settled", (payload) => {
    if (disposed.value || !["cancelled", "expired"].includes(payload?.status)) return;
    const record = records.get(payload.workId);
    if (record === undefined || record.activeTurnId === null) return;
    appServer.request("turn/interrupt", { threadId: record.threadId }).catch((error) => {
      loggerWarn(ctx, `sagitta-codex: 无法中断 work ${payload.workId}：${error.message}`);
    });
  });

  let disposePromise;
  const dispose = () => {
    if (disposePromise !== undefined) return disposePromise;
    disposed.value = true;
    const service = asyncWorkFrom(ctx);
    disposePromise = (async () => {
      for (const [workId, record] of records) {
        const work = service?.get?.(record.ownerId, workId);
        if (work?.status === "running") service.cancel(record.ownerId, workId, record.taskId);
      }
      notificationDisposer();
      settledDisposer();
      await appServer.dispose();
      records.clear();
    })();
    return disposePromise;
  };

  registerCodexTools(ctx, { resolved, records, disposed, appServer });
  ctx.effect(() => dispose, "sagitta-codex: app-server cleanup");
}

export {
  CODEX_WORK_FIELDS,
  Config,
  inject,
  name,
  apply,
};
