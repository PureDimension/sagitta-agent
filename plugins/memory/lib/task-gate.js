// sagitta-memory — 任务执行门禁（task-system-v2 §3.1）
//
// 认领凭证只在 task_claim 的结果中出现一次，不能把它持久化到日志或输出。
// 因此本模块只在当前 DSH 进程内保存“哪个 agent 已成功认领哪个任务”的非敏感
// 投影，并把这份状态接到 dsh-tools 的全局单调 guard。Worker 仍是任务认领的
// 权威方；本地状态丢失时，模型重新 task_claim 即可恢复。

const EXECUTION_TOOL_NAMES = new Set([
  "write",
  "edit",
  "pwsh",
  "tool:write",
  "tool:edit",
  "tool:pwsh",
  "str_replace_editor",
  "codex_dispatch",
  "subagent",
  "subagent:delegation",
  "subagent_codex",
  "async_register",
]);

const TASK_SCOPED_EXECUTION_TOOL_NAMES = new Set([
  "codex_dispatch",
  "async_register",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function agentIdOf(agent) {
  return text(agent?.id) || "unknown";
}

function parentSessionOf(agent) {
  return text(agent?.session?.header?.parentSession);
}

function taskIdFromArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const taskId = text(args.task_id ?? args.taskId);
  return taskId || undefined;
}

function agentLineageIds(agent, getAgent) {
  const ids = [];
  const seen = new Set();
  let current = agent;
  while (current && ids.length < 32) {
    const id = agentIdOf(current);
    if (seen.has(id)) break;
    seen.add(id);
    ids.push(id);
    const parentId = parentSessionOf(current);
    if (!parentId) break;
    current = typeof getAgent === "function" ? getAgent(parentId) : undefined;
    if (!current) {
      // A direct child still carries the parent session id even when the
      // optional agents service is not mounted. This is enough to preserve
      // the task binding for the common one-level delegation case.
      ids.push(parentId);
      break;
    }
  }
  return ids.length > 0 ? ids : ["unknown"];
}

function isRunnableKind(kind) {
  return kind === "normal" || kind === "temp";
}

function normalizeClaim(claim) {
  const taskId = text(claim?.taskId ?? claim?.task_id ?? claim?.id);
  if (!taskId) throw new TypeError("task gate claim requires task_id");
  const status = text(claim?.status) || "in_progress";
  if (status !== "in_progress") return null;
  return {
    taskId,
    kind: isRunnableKind(claim?.kind) ? claim.kind : "normal",
    status,
  };
}

function sameAgent(record, agent, getAgent) {
  const ids = agentLineageIds(agent, getAgent);
  return ids.includes(record.ownerAgentId);
}

/**
 * Process-local task binding ledger. It intentionally exposes no claim token.
 */
export function createTaskGate({ getAgent } = {}) {
  const claims = [];

  const matchingClaims = (agent, taskId) => claims.filter((claim) =>
    (taskId === undefined || claim.taskId === taskId) && sameAgent(claim, agent, getAgent)
  );

  return {
    recordClaim(claim, agent) {
      const normalized = normalizeClaim(claim);
      if (!normalized) return null;
      const ownerAgentId = agentIdOf(agent);
      const existingIndex = claims.findIndex((item) =>
        item.taskId === normalized.taskId && item.ownerAgentId === ownerAgentId
      );
      const record = { ...normalized, ownerAgentId };
      if (existingIndex >= 0) claims[existingIndex] = record;
      else claims.push(record);
      return { ...record };
    },

    forgetClaim(taskId, agent) {
      const id = text(taskId);
      if (!id) return 0;
      let removed = 0;
      for (let index = claims.length - 1; index >= 0; index--) {
        if (claims[index].taskId === id && sameAgent(claims[index], agent, getAgent)) {
          claims.splice(index, 1);
          removed++;
        }
      }
      return removed;
    },

    forgetAll(taskId) {
      const id = text(taskId);
      if (!id) return 0;
      let removed = 0;
      for (let index = claims.length - 1; index >= 0; index--) {
        if (claims[index].taskId === id) {
          claims.splice(index, 1);
          removed++;
        }
      }
      return removed;
    },

    hasBound(taskId, agent) {
      const id = text(taskId);
      return id.length > 0 && matchingClaims(agent, id).length > 0;
    },

    listBound(agent) {
      return matchingClaims(agent).map(({ taskId, kind, status }) => ({ taskId, kind, status }));
    },

    assertBound(taskId, agent) {
      const id = text(taskId);
      const bound = id ? matchingClaims(agent, id) : matchingClaims(agent);
      return bound.length > 0
        ? bound.map(({ taskId: boundTaskId, kind, status }) => ({ taskId: boundTaskId, kind, status }))
        : [];
    },

    guard(exec) {
      const name = text(exec?.name);
      if (!EXECUTION_TOOL_NAMES.has(name)) return undefined;
      const taskId = taskIdFromArguments(exec?.arguments);
      if (taskId !== undefined && this.hasBound(taskId, exec?.agent)) return undefined;
      if (taskId === undefined
          && !TASK_SCOPED_EXECUTION_TOOL_NAMES.has(name)
          && this.listBound(exec?.agent).length > 0) return undefined;

      const target = taskId ? `task_id=${taskId}` : "未提供 task_id";
      return `任务门禁拒绝执行型工具「${name}」（${target}）：必须先 task_claim 一个当前 in_progress 的 normal 或 temp 任务；` +
        "认领后再重试该工具。可先调用 task_assert_bound 检查当前绑定。";
    },

    // 仅供测试/诊断；返回的结构不含凭证。
    snapshot(agent) {
      return this.listBound(agent);
    },
  };
}

/**
 * Install the global, monotonic dsh-tools guard when the current DSH exposes it.
 * Older/minimal harnesses receive the prompt + task_assert_bound fallback and
 * do not crash merely because the optional global hook is absent.
 */
export function installTaskGate(ctx, gate) {
  if (typeof ctx?.tools?.guard !== "function") return { mode: "prompt+assert", dispose: null };
  try {
    const dispose = ctx.tools.guard((exec) => gate.guard(exec));
    return { mode: "global-guard", dispose };
  } catch {
    return { mode: "prompt+assert", dispose: null };
  }
}

export { EXECUTION_TOOL_NAMES, TASK_SCOPED_EXECUTION_TOOL_NAMES, taskIdFromArguments };
