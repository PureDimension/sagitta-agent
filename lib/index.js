// ============================================================================
// @sagitta/memory — DSH（DeepSeek Harness）本地插件入口（lib/index.js）
// ============================================================================
// cordis 插件格式（对照 @deepseek-ai/dsh-tool-web / dsh-tool-ask-user）：
//   export { name, inject, Config, apply }
//   在 profile 的 cordis.patch.yml（或插件列表）中声明：
//     - id: memory
//       name: '@sagitta/memory'
//       config: { ...可选... }
// 职责：读取配置（.env 凭据，绝不硬编码/绝不打印明文）→ 构建 API 客户端 →
// 注册四个工具（memory_remember / memory_recall / memory_consolidate /
// memory_verify）→ 注入工具使用纪律与 §4 认可信号轨道引导到系统提示词。
// ============================================================================

import z from "@deepseek-ai/schemastery";
import path from "node:path";
import { resolveConfig, maskTokenSummary } from "./config.js";
import { SagittaMemoryClient } from "./client.js";
import { registerMemoryTools, MEMORY_PROMPT_GUIDANCE } from "./tools.js";

const name = "memory";
const inject = ["tools", "systemPrompt"];

const Config = z.object({
  baseUrl: z
    .string()
     .default("REPLACE_WITH_WORKER_URL")
    .description("Worker API 根地址（默认线上已部署地址；可改，如本地 wrangler dev）。"),
  proxy: z
    .string()
    .default(process.env.DSH_MEMORY_PROXY || "direct")
    .description("HTTP 代理（CONNECT 隧道）；填 'direct' 或空串走直连。"),
  envPath: z
    .string()
    .default(process.env.DSH_MEMORY_ENV_PATH || path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), ".config", "sagitta", "memory.env"))
    .description(".env 文件路径（读取 CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET / AUTH_TOKEN）。"),
  timeoutMs: z.number().default(20000).description("单请求超时（毫秒）。"),
  // 显式凭据注入（CI/容器部署用；正常本地使用保持缺省，走 .env）。绝不写死默认值。
  accessClientId: z.string().default("").description("显式覆盖 CF_ACCESS_CLIENT_ID（缺省走 .env）。"),
  accessClientSecret: z.string().default("").description("显式覆盖 CF_ACCESS_CLIENT_SECRET（缺省走 .env）。"),
  authToken: z.string().default("").description("显式覆盖 AUTH_TOKEN（缺省走 .env；不配置则不发 Bearer）。"),
});

function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {});
  const client = new SagittaMemoryClient(resolved);

  // 启动诊断：只输出“是否配置”与掩码尾巴，绝不输出明文凭据
  const auth = resolved.auth;
  const diag = [
    `sagitta-memory 加载完成`,
    `  baseUrl=${resolved.baseUrl}`,
    `  proxy=${resolved.proxy}`,
    `  async 超时=${resolved.timeoutMs}ms`,
    `  凭据诊断（仅掩码）：Access服务令牌 ${auth.accessPresent ? "已配置 id=" + maskTokenSummary(auth.accessClientId) : "未配置"} / ` +
      `Secret ${auth.accessPresent ? maskTokenSummary(auth.accessClientSecret) : "未配置"}；AUTH_TOKEN ${auth.bearerPresent ? "已配置 " + maskTokenSummary(auth.authToken) : "未配置（不发送 Bearer，完全依赖 Access 服务令牌）"}`,
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
