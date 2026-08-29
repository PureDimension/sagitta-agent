// ============================================================================
// sagitta-memory — DSH（DeepSeek Harness）本地插件入口（lib/index.js）
// ============================================================================
// cordis 插件格式（对照 @deepseek-ai/dsh-tool-web / dsh-tool-ask-user）：
//   export { name, inject, Config, apply }
//   在 profile 的 cordis.patch.yml（或插件列表）中声明：
//     - id: memory
//       name: sagitta-memory
//       config: { ...可选... }
// 职责：读取本地 transport 配置与 manager API 快照（绝不硬编码/绝不打印明文）→ 构建 API 客户端 →
// 注册四个工具（memory_remember / memory_recall / memory_consolidate /
// memory_verify）→ 注入工具使用纪律与 §4 认可信号轨道引导到系统提示词。
// ============================================================================

import z from "@deepseek-ai/schemastery";
import { resolveConfig, maskTokenSummary } from "./config.js";
import { SagittaMemoryClient } from "./client.js";
import { registerMemoryTools, MEMORY_PROMPT_GUIDANCE } from "./tools.js";

const name = "memory";
// manager is intentionally optional: if it is absent, the client degrades to
// explicit migration fallback values and exposes a visible "未配置" error.
const inject = ["tools", "systemPrompt"];

const Config = z.object({
  proxy: z
    .string()
    .default(process.env.DSH_MEMORY_PROXY || "direct")
    .description("HTTP 代理（CONNECT 隧道）；填 'direct' 或空串走直连。"),
  timeoutMs: z.number().default(20000).description("单请求超时（毫秒）。"),
});

function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {});
  // The manager service is the only normal source of endpoint/credentials.
  // Read it through the real bracket service name exposed by manager/lib/index.js.
  const manager = ctx?.["sagitta-manager"];
  const client = new SagittaMemoryClient(resolved, manager);

  // 启动诊断：只输出来源、是否配置与掩码尾巴，绝不输出明文凭据。
  const readRuntime = client.getRuntimeConfig("read");
  const writeRuntime = client.getRuntimeConfig("write");
  const managerConfig = typeof manager?.getApiConfig === "function" ? (() => {
    try {
      return manager.getApiConfig() || {};
    } catch {
      return {};
    }
  })() : {};
  const managerConfigured = [managerConfig.workerApiUrl, managerConfig.d1ReadToken, managerConfig.d1WriteToken]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  const source = managerConfigured
    ? "manager"
    : manager
      ? "manager 未配置，使用显式 fallback"
      : "manager 服务缺失，使用显式 fallback";
  const authSummary = (runtime) => {
    if (runtime.auth.accessPresent) {
      return `Access id=${maskTokenSummary(runtime.auth.accessClientId)} / secret=${maskTokenSummary(runtime.auth.accessClientSecret)}`;
    }
    if (runtime.auth.bearerPresent) return `Bearer=${maskTokenSummary(runtime.auth.authToken)}`;
    return "未配置";
  };
  const diag = [
    `sagitta-memory 加载完成`,
    `  API 配置来源=${source}`,
    `  baseUrl=${readRuntime.baseUrl || "(未配置)"}`,
    `  proxy=${resolved.proxy}`,
    `  async 超时=${resolved.timeoutMs}ms`,
    `  读认证诊断（仅掩码）：${authSummary(readRuntime)}`,
    `  写认证诊断（仅掩码）：${authSummary(writeRuntime)}`,
  ];
  try {
    ctx.logger?.info(diag.join("\n"));
  } catch {
    /* logger 不可用时静默 */
  }

  ctx.systemPrompt.section({
    name: "tool:sagitta-memory",
    order: 120,
    text: MEMORY_PROMPT_GUIDANCE,
  });

  registerMemoryTools(ctx, client);
}

export { Config, apply, inject, name };
