// ============================================================================
// sagitta-async-work — 通用有界工作注册表
// ============================================================================
// 该插件是所有“等待期间不应触发自主推进”的进程内工作唯一登记处。
// owner_id 通常是 agent id，task_id 是强制绑定；codex、安装器或其他适配器
// 只负责执行工作，不得各自再维护一份阻塞注册表。

import { Service } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import {
  AsyncWorkError,
  AsyncWorkRegistry,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  WORK_STATUSES,
} from "./registry.js";

const name = "sagitta-async-work";
const ASYNC_WORK_SETTLED_EVENT = "async-work/settled";
const inject = ["tools", "agents"];
const SETTLEMENT_LABELS = Object.freeze({ complete: "完成", fail: "失败", cancel: "取消" });

const Config = z.object({
  defaultTimeoutMs: z.number().default(DEFAULT_TIMEOUT_MS)
    .description(`默认工作超时（${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 毫秒）；每次 register 仍由服务端校验。`),
});

const nullableString = () => ({ oneOf: [{ type: "string" }, { type: "null" }] });
const WORK_FIELDS = {
  work_id: { type: "string", required: true },
  task_id: { type: "string", required: true },
  owner_id: { type: "string", required: true },
  kind: { type: "string", required: true },
  desc: { type: "string", required: true },
  started_at: { type: "string", required: true },
  timeout_ms: { type: "integer", required: true },
  status: { type: "string", required: true, enum: WORK_STATUSES },
  ended_at: { ...nullableString(), required: true },
  reason: { ...nullableString(), required: true },
};
const WORK_SCHEMA = { type: "object", additionalProperties: false, properties: WORK_FIELDS };

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function settledWorkInfo(settled) {
  return {
    workId: nonEmptyString(settled?.workId ?? settled?.work_id),
    taskId: nonEmptyString(settled?.taskId ?? settled?.task_id),
    status: nonEmptyString(settled?.status),
    kind: nonEmptyString(settled?.kind),
    reason: nonEmptyString(settled?.reason),
  };
}

function settledNotice(settled) {
  const info = settledWorkInfo(settled);
  const details = [
    `task_id=${info.taskId ?? "unknown"}`,
    `status=${info.status ?? "unknown"}`,
    info.workId === undefined ? undefined : `work_id=${info.workId}`,
    info.kind === undefined ? undefined : `kind=${info.kind}`,
    info.reason === undefined ? undefined : `reason=${info.reason}`,
  ].filter((value) => value !== undefined);
  return `异步任务已完成：${details.join(" ")}，可继续推进或汇报结果。`;
}

function ownerIdOf(exec) {
  const ownerId = exec?.agent?.id;
  return typeof ownerId === "string" && ownerId.trim().length > 0 ? ownerId.trim() : "unknown";
}

function registerTool(ctx, service, definition) {
  ctx.tools.register(defineTool({
    ...definition,
    timeoutMs: definition.timeoutMs ?? 15000,
    isConcurrencySafe: () => true,
  }));
}

function presentCall(tool, args) {
  return {
    card: "generic",
    title: `${tool}(${JSON.stringify(args).slice(0, 180)})`,
    kind: "async-work",
    rawInput: JSON.stringify(args),
  };
}

function registerAsyncWorkTools(ctx, service) {
  registerTool(ctx, service, {
    name: "async_register",
    description:
      "登记一项有界异步工作。task_id 必填，表示该工作只阻塞这个任务；timeoutMs 必须在 1 秒至 24 小时内，" +
      "超时后自动转为 expired，不能用超长超时永久占用自主推进。",
    parameters: {
      task_id: { type: "string", required: true, description: "绑定的任务 id；必须明确填写，不能用当前任务猜测。" },
      kind: { type: "string", required: true, description: "工作类型，如 install/model/external/codex。" },
      desc: { type: "string", required: true, description: "工作的一行描述。" },
      timeoutMs: { type: "integer", required: true, description: `超时毫秒数（${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS}）。` },
    },
    output: {
      schema: WORK_SCHEMA,
      render: (_args, value) => [{
        type: "text",
        text: `## 异步工作已登记\n\n- work_id：${value.work_id}\n- task_id：${value.task_id}\n- 状态：${value.status}\n- 超时：${value.timeout_ms}ms\n- 描述：${value.desc}`,
      }],
      presentationMeta: (_args, value) => ({ work_id: value.work_id, task_id: value.task_id, status: value.status }),
    },
    async execute(args, exec) {
      return service.register({
        ownerId: ownerIdOf(exec),
        taskId: args.task_id,
        kind: args.kind,
        desc: args.desc,
        timeoutMs: args.timeoutMs,
      });
    },
    presentCall: (args) => presentCall("async_register", args),
  });

  registerTool(ctx, service, {
    name: "async_status",
    description:
      "查询有界异步工作。可按 work_id 查询唯一工作，或按 task_id 查询该任务仍在运行的工作；" +
      "不传过滤条件时返回当前 owner 的 active 工作。列表只包含 running 且未超时记录。",
    parameters: {
      work_id: { type: "string", description: "唯一工作 id；优先用于查询单项。" },
      task_id: { type: "string", description: "按任务 id 过滤。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { works: { type: "array", items: WORK_SCHEMA, required: true } },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.works.length === 0
          ? "## 异步工作状态\n\n（没有 active 工作）"
          : "## 异步工作状态\n\n" + value.works.map((work) =>
            `- **${work.work_id}** [${work.status}] task=${work.task_id} ${work.desc}`
          ).join("\n"),
      }],
      presentationMeta: (_args, value) => ({ count: value.works.length }),
    },
    async execute(args, exec) {
      const ownerId = ownerIdOf(exec);
      if (args.work_id !== undefined) {
        const work = service.get(ownerId, args.work_id);
        if (work === null || (args.task_id !== undefined && work.task_id !== args.task_id)) return { works: [] };
        return { works: [work] };
      }
      return { works: service.listActive(ownerId, args.task_id === undefined ? {} : { taskId: args.task_id }) };
    },
    presentCall: (args) => presentCall("async_status", args),
  });

  registerTool(ctx, service, {
    name: "async_settle",
    description:
      "结算一项有界异步工作。work_id、task_id、action 都必填，action 为 complete、fail 或 cancel；" +
      "reason 仅用于 fail。服务端会核对 task_id 绑定，已进入终态的工作不能再次变更。",
    parameters: {
      work_id: { type: "string", required: true, description: "async_register 返回的 work_id。" },
      task_id: { type: "string", required: true, description: "必须与工作登记时的 task_id 完全一致。" },
      action: { type: "string", required: true, enum: ["complete", "fail", "cancel"], description: "结算动作。" },
      reason: { type: "string", description: "失败原因（仅 action=fail 时使用）。" },
    },
    output: {
      schema: WORK_SCHEMA,
      render: (args, value) => [{
        type: "text",
        text: `## 异步工作${SETTLEMENT_LABELS[args.action]}\n\n- work_id：${value.work_id}\n- task_id：${value.task_id}\n- 状态：${value.status}${value.reason ? `\n- 原因：${value.reason}` : ""}`,
      }],
      presentationMeta: (_args, value) => ({ work_id: value.work_id, task_id: value.task_id, status: value.status }),
    },
    async execute(args, exec) {
      return service.settle(ownerIdOf(exec), args.work_id, args.task_id, args.action, args.reason);
    },
    presentCall: (args) => presentCall("async_settle", args),
  });
}

class AsyncWorkService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, name);
    this.registry = new AsyncWorkRegistry({
      defaultTimeoutMs: config.defaultTimeoutMs,
      onListenerError: (error, listener) => ctx.logger.error(error, listener),
    });
    this.disposeSettled = this.registry.onSettled((payload) => {
      this.ctx.emit?.(ASYNC_WORK_SETTLED_EVENT, payload);
      this.notifyOwner(payload);
    });
  }

  notifyOwner(payload) {
    const agent = this.ctx.agents?.get?.(payload.ownerId);
    if (agent === undefined) return;
    const message = createUserMessage({
      content: [{ type: "text", text: settledNotice(payload) }],
      source: { kind: "plugin", plugin: name, form: "notice", summary: "async work settled" }
    });
    agent.steer(message);
  }

  register(input) {
    return this.registry.register(input);
  }

  listActive(ownerId, filter = {}) {
    return this.registry.listActive(ownerId, filter);
  }

  get(ownerId, workId) {
    return this.registry.get(ownerId, workId);
  }

  listRecent(ownerId) {
    return this.registry.listRecent(ownerId);
  }

  settle(ownerId, workId, taskId, action, reason) {
    return this.registry.settle(ownerId, workId, taskId, action, reason);
  }

  complete(ownerId, workId, taskId) {
    return this.registry.complete(ownerId, workId, taskId);
  }

  fail(ownerId, workId, reason, taskId) {
    return this.registry.fail(ownerId, workId, reason, taskId);
  }

  cancel(ownerId, workId, taskId) {
    return this.registry.cancel(ownerId, workId, taskId);
  }

  reap(ownerId) {
    return this.registry.reap(ownerId);
  }

  dispose() {
    const cancelled = this.registry.dispose();
    this.disposeSettled?.();
    this.disposeSettled = undefined;
    return cancelled;
  }
}

function apply(ctx, config) {
  // 与 DSH 内部 Service 子类插件（@deepseek-ai/dsh-jobs-local 的 LocalJobRegistry 等）
  // 写法对齐：cordis 4.0.1 的 Service 构造函数（lib/index.js ~1781 行）已通过
  // `ctx.reflect.provide(name, this)` 自动注册到当前 fiber，apply 里**不得再手动
  // ctx.provide** —— 重复注册会命中 cordis provide 的重复检查（~812 行
  // `service "..." has been registered`）抛错，只能靠 try/catch 吞掉，属于双注册噪声。
  const service = new AsyncWorkService(ctx, config ?? {});
  registerAsyncWorkTools(ctx, service);

  if (typeof ctx?.effect === "function") {
    ctx.effect(() => () => service.dispose(), "sagitta-async-work: registry cleanup");
  } else {
    ctx?.on?.("dispose", () => service.dispose());
  }
  return service;
}

export {
  AsyncWorkError,
  AsyncWorkRegistry,
  AsyncWorkService,
  ASYNC_WORK_SETTLED_EVENT,
  Config,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  WORK_FIELDS,
  WORK_STATUSES,
  apply,
  inject,
  name,
  registerAsyncWorkTools,
};
