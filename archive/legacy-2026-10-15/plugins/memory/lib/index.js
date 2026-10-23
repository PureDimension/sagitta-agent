// ============================================================================
// sagitta-memory — DSH（DeepSeek Harness）本地插件入口（lib/index.js）
// ============================================================================
// cordis 插件格式（对照 @deepseek-ai/dsh-tool-web / dsh-tool-ask-user）：
//   export { name, inject, Config, apply }
//   在 profile 的 cordis.patch.yml（或插件列表）中声明：
//     - id: memory
//       name: sagitta-memory
//       config: { ...可选... }
// 职责：通过 sagitta-manager 的统一 request 通道构建 API 客户端 →
// 注册四个工具（memory_remember / memory_recall / memory_consolidate /
// memory_verify）→ 注入工具使用纪律与 §4 认可信号轨道引导到系统提示词。
// ============================================================================

import z from "@deepseek-ai/schemastery";
import { SagittaMemoryClient } from "./client.js";
import { registerMemoryTools, MEMORY_PROMPT_GUIDANCE } from "./tools.js";

const name = "memory";
const inject = ["tools", "systemPrompt", "sagitta-manager"];

const Config = z.object({});

function apply(ctx) {
  const manager = ctx?.["sagitta-manager"];
  if (!manager || typeof manager.request !== "function") {
    throw new Error("sagitta-memory requires sagitta-manager.request");
  }
  const client = new SagittaMemoryClient(manager);

  ctx.systemPrompt.section({
    name: "tool:sagitta-memory",
    order: 120,
    text: MEMORY_PROMPT_GUIDANCE,
  });

  const taskTools = registerMemoryTools(ctx, client);
  try {
    ctx.logger?.info(`sagitta-memory 任务门禁=${taskTools?.gateMode === "global-guard" ? "global-guard" : "prompt+assert（DSH 无 tools.guard）"}`);
  } catch {
    /* logger 不可用时静默 */
  }
}

export { Config, apply, inject, name };
