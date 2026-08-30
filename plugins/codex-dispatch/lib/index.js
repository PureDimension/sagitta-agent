// ============================================================================
// sagitta-codex — codex 派单插件（lib/index.js）
// ============================================================================
// 职责：
//   1) 提供 codex_dispatch 工具：后台 spawn codex CLI 执行任务（模型/沙箱/推理档位可配），
//      返回 workId；进程与 DSH 生命周期解耦（detached）。
//   2) 工作注册表（按 agentId 记账）：dispatch 时注册"有界工作"（kind=codex，
//      带 startedAt/timeoutMs）；进程退出自动回收；超时由 auto-advance 查询时判 stale。
//   3) 提供 codex_status 工具查询工作状态（running/done/failed/stale）。
//   4) 暴露服务 sagitta-codex（listActiveWorks/reapStale），供 auto-advance 的
//      hasRunningWork 判定——只认"注册的有界工作"，不再被其他后台 job 卡死。
// 安全：任务描述/模型等参数由调用方给出；不输出密钥；spawn 用参数数组避免引号问题。
// ============================================================================

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

const name = "sagitta-codex";
const inject = ["tools", "agents"];

const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_WORK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h：超过视为 stale，auto-advance 自动释放
const MAX_CONCURRENT = 4;

const Config = z.object({
  codexPath: z.string().default("codex").description("codex CLI 可执行文件（或 PATH 名）。"),
  defaultModel: z.string().default(DEFAULT_MODEL).description("默认模型（codex-model-policy.md 当前档位）。"),
  workTimeoutMs: z.number().default(DEFAULT_WORK_TIMEOUT_MS).description("工作超时（毫秒）；超时视为 stale 自动回收。"),
  maxConcurrent: z.number().default(MAX_CONCURRENT).description("每 agent 并发 codex 工作上限。"),
  sandbox: z.string().default("danger-full-access").description("codex 沙箱模式。"),
  reasoningEffort: z.string().default("xhigh").description("codex 推理档位。")
});

const WORK_STATUS = Object.freeze({
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  KILLED: "killed",
  STALE: "stale"
});

class CodexWorkRegistry {
  constructor({ workTimeoutMs, maxConcurrent }) {
    this.workTimeoutMs = workTimeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.byAgent = new Map(); // agentId -> Map<workId, work>
  }

  _works(agentId) {
    if (!this.byAgent.has(agentId)) this.byAgent.set(agentId, new Map());
    return this.byAgent.get(agentId);
  }

  register(agentId, { kind = "codex", task, model, pid, timeoutMs }) {
    const works = this._works(agentId);
    const active = [...works.values()].filter((w) => w.status === WORK_STATUS.RUNNING && !this.isStale(w));
    if (active.length >= this.maxConcurrent) {
      throw new Error(`codex 并发上限 ${this.maxConcurrent} 已满（agent ${agentId}）；请先等现有工作结束或 codex_status 查看。`);
    }
    const work = {
      id: randomUUID().slice(0, 8),
      kind,
      task: String(task ?? "").slice(0, 200),
      model,
      pid,
      startedAt: Date.now(),
      timeoutMs: timeoutMs ?? this.workTimeoutMs,
      status: WORK_STATUS.RUNNING,
      exitCode: null,
      endedAt: null,
    };
    works.set(work.id, work);
    return work;
  }

  isStale(work) {
    return work.status === WORK_STATUS.RUNNING && Date.now() - work.startedAt > work.timeoutMs;
  }

  markEnded(agentId, workId, status, exitCode) {
    const work = this.byAgent.get(agentId)?.get(workId);
    if (!work || work.status !== WORK_STATUS.RUNNING) return work;
    work.status = status;
    work.exitCode = exitCode ?? null;
    work.endedAt = Date.now();
    return work;
  }

  /** 活跃（running 且未超时）工作列表——auto-advance 用它判断"有工作" */
  listActive(agentId) {
    const works = this.byAgent.get(agentId);
    if (!works) return [];
    const result = [];
    for (const work of works.values()) {
      if (work.status === WORK_STATUS.RUNNING && !this.isStale(work)) result.push({ ...work });
    }
    return result;
  }

  /** 回收：超时 stale 工作标记 + 清理 ended 历史（保留最近 20 条供 status 查询） */
  reap(agentId) {
    const works = this.byAgent.get(agentId);
    if (!works) return 0;
    let reaped = 0;
    for (const work of works.values()) {
      if (work.status === WORK_STATUS.RUNNING && this.isStale(work)) {
        work.status = WORK_STATUS.STALE;
        work.endedAt = Date.now();
        reaped++;
      }
    }
    // 清理 ended 历史（保留 20 条）
    const ended = [...works.values()].filter((w) => w.status !== WORK_STATUS.RUNNING);
    if (ended.length > 20) {
      const toDrop = ended.slice(0, ended.length - 20);
      for (const work of toDrop) works.delete(work.id);
    }
    return reaped;
  }

  get(agentId, workId) {
    return this.byAgent.get(agentId)?.get(workId) ?? null;
  }

  kill(agentId, workId) {
    const work = this.get(agentId, workId);
    if (!work) return { ok: false, reason: "work-not-found" };
    if (work.status !== WORK_STATUS.RUNNING) return { ok: false, reason: `not-running(${work.status})` };
    if (work.pid) {
      try { process.kill(-work.pid, "SIGTERM"); } catch { try { process.kill(work.pid, "SIGTERM"); } catch { /* already gone */ } }
    }
    work.status = WORK_STATUS.KILLED;
    work.endedAt = Date.now();
    return { ok: true };
  }
}

/**
 * 解析 codex 启动方式。Windows 下 codex 是 npm 全局 shim（codex.cmd），
 * spawn("codex") 会 ENOENT、spawn("codex.cmd") 会 EINVAL——直接用 node 跑
 * codex.js（npm 全局安装路径）。非 Windows 直接 spawn codexPath。
 */
function resolveCodexLaunch(codexPath) {
  if (process.platform !== "win32") {
    return { command: codexPath, args: [] };
  }
  const candidates = [
    process.env.CODEX_JS_PATH,
    join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
    join(process.env.USERPROFILE ?? "", "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return { command: process.execPath, args: [candidate] };
    }
  }
  // fallback：尝试 codexPath（如用户显式给了 .exe 路径）
  return { command: codexPath, args: [] };
}

function runCodex({ codexPath, args, pidRef }) {
  const { command, args: prefix } = resolveCodexLaunch(codexPath);
  const child = spawn(command, [...prefix, ...args], {
    detached: true,          // 与 DSH 生命周期解耦（DSH 重启不杀 codex）
    stdio: "ignore",
    windowsHide: true,
  });
  pidRef.current = child.pid ?? null;
  child.unref();
  return child;
}

export function apply(ctx, config) {
  const resolved = config ?? {};
  const registry = new CodexWorkRegistry({
    workTimeoutMs: Number.isFinite(Number(resolved.workTimeoutMs)) && Number(resolved.workTimeoutMs) > 0
      ? Number(resolved.workTimeoutMs) : DEFAULT_WORK_TIMEOUT_MS,
    maxConcurrent: Number.isFinite(Number(resolved.maxConcurrent)) && Number(resolved.maxConcurrent) > 0
      ? Number(resolved.maxConcurrent) : MAX_CONCURRENT,
  });

  // ---- 服务（供 auto-advance 注入）----
  const service = {
    listActiveWorks(agentId) {
      return registry.listActive(agentId);
    },
    reapStale(agentId) {
      return registry.reap(agentId);
    },
    getWork(agentId, workId) {
      return registry.get(agentId, workId);
    },
  };
  ctx.provide?.("sagitta-codex", service);
  ctx.on?.("dispose", () => {
    // 插件卸载不杀 codex（detached 独立）；只清理注册表
    registry.byAgent.clear();
  });

  // ---- 工具：codex_dispatch ----
  ctx.tools.register(defineTool({
    name: "codex_dispatch",
    description:
      "派发 codex CLI 后台任务（公司报销配额）：自动在自主推进系统注册'有界工作'（超时自动回收，不永久卡住 auto-advance）。" +
      "任务结束（done/failed）自动回收；可后续 codex_status 查询。模型默认按 codex-model-policy.md 档位（luna）。" +
      "并发上限每 agent 4 个。",
    parameters: {
      task: { type: "string", required: true, description: "codex 任务描述（完整、自包含，codex 无本会话上下文）。" },
      model: { type: "string", description: `模型（默认 ${DEFAULT_MODEL}；档位见 codex-model-policy.md）。` },
      timeoutMs: { type: "integer", description: `本工作超时（毫秒，默认 ${DEFAULT_WORK_TIMEOUT_MS}）。` },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workId: { type: "string", required: true },
          pid: { type: "integer" },
          status: { type: "string", required: true },
          task: { type: "string" },
          model: { type: "string" },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `## codex 已派发（${value.workId}）\n\n- 模型：${value.model}\n- 状态：${value.status}\n- 任务：${value.task.slice(0, 120)}${value.task.length > 120 ? "…" : ""}\n\n完成后自动回收；可用 codex_status 查询。` },
      ],
      presentationMeta: (_args, value) => ({ workId: value.workId, status: value.status }),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agentId = exec?.agent?.id ?? "unknown";
      const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : resolved.defaultModel ?? DEFAULT_MODEL;
      const timeoutMs = Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : undefined;

      // 组装 codex exec 参数（数组形式，避免引号问题）
      const codexArgs = [
        "exec",
        "--skip-git-repo-check",
        "-s", resolved.sandbox ?? "danger-full-access",
        "-m", model,
        "-c", `model_reasoning_effort=${resolved.reasoningEffort ?? "xhigh"}`,
        String(args.task),
      ];

      let work;
      try {
        work = registry.register(agentId, { kind: "codex", task: args.task, model, timeoutMs, pid: null });
      } catch (error) {
        throw new Error(`codex 派发被拒：${error.message}`);
      }

      const pidRef = { current: null };
      let child;
      try {
        child = runCodex({ codexPath: resolved.codexPath ?? "codex", args: codexArgs, pidRef });
      } catch (error) {
        registry.markEnded(agentId, work.id, WORK_STATUS.FAILED, null);
        throw new Error(`codex 启动失败：${error.message}`);
      }
      work.pid = pidRef.current;

      child.on("error", (err) => {
        registry.markEnded(agentId, work.id, WORK_STATUS.FAILED, null);
        try { ctx.logger?.warn?.(`sagitta-codex: work ${work.id} spawn error: ${err?.message ?? String(err)}`); } catch { /* noop */ }
      });
      child.on("exit", (code, signal) => {
        registry.markEnded(
          agentId,
          work.id,
          signal ? WORK_STATUS.KILLED : code === 0 ? WORK_STATUS.DONE : WORK_STATUS.FAILED,
          code
        );
      });

      const result = {
        workId: work.id,
        status: WORK_STATUS.RUNNING,
        task: String(args.task).slice(0, 200),
        model,
      };
      if (work.pid !== null && work.pid !== undefined) result.pid = work.pid; // 条件添加（lossless）
      return result;
    },
    presentCall: (args) => `codex_dispatch(model=${args.model ?? "luna"}, task=${JSON.stringify(args.task).slice(0, 60)})`,
  }));

  // ---- 工具：codex_status ----
  ctx.tools.register(defineTool({
    name: "codex_status",
    description:
      "查询 codex 派单工作状态：running（活跃，未超时）/ done / failed / killed / stale（超时自动回收）。" +
      "不给 workId 时列出该会话所有工作（含历史）。",
    parameters: {
      workId: { type: "string", description: "工作 id（codex_dispatch 返回）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          works: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                kind: { type: "string" },
                task: { type: "string" },
                model: { type: "string" },
                status: { type: "string", required: true },
                startedAt: { type: "integer" },
                endedAt: { type: "integer" },
                exitCode: { type: "integer" },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: "text", text: "## codex 工作状态\n\n" + value.works.map((w) => `- **${w.id}** [${w.status}] ${w.task.slice(0, 60)}`).join("\n") },
      ],
      presentationMeta: (_args, value) => ({ count: value.works.length }),
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agentId = exec?.agent?.id ?? "unknown";
      registry.reap(agentId);
      let works;
      if (args.workId) {
        const work = registry.get(agentId, args.workId);
        works = work ? [work] : [];
      } else {
        works = [...(registry.byAgent.get(agentId)?.values() ?? [])];
      }
      return {
        works: works.map((w) => {
          // 条件添加：undefined 属性会被 snapshot 判 lossless 失败
          const item = {
            id: w.id,
            kind: w.kind,
            task: w.task,
            model: w.model,
            status: w.status,
            startedAt: w.startedAt,
          };
          if (w.endedAt !== null && w.endedAt !== undefined) item.endedAt = w.endedAt;
          if (w.exitCode !== null && w.exitCode !== undefined) item.exitCode = w.exitCode;
          return item;
        }),
      };
    },
    presentCall: (args) => `codex_status(workId=${args.workId ?? "all"})`,
  }));
}

export { CodexWorkRegistry, Config, inject, name };
