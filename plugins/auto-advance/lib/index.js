import z from "@deepseek-ai/schemastery";
import { AutoAdvanceService, AUTONOMOUS_PROMPT, STOP_MARKER } from "./service.js";

const name = "sagitta-auto-advance";
const inject = ["agents", "goals", "sessions", "sagitta-manager"];

const Config = z.object({
  idleTimeoutMs: z.number().default(300000).description("Idle duration before an automatic continuation is injected."),
  statePath: z.string().description("JSON file used to persist the per-session mode. Defaults to the resolved Sagitta workspace."),
  tasksPath: z.string().description("Read-only Markdown task file shown by the client panel. Defaults to the resolved Sagitta workspace."),
  proxy: z.string().default("direct").description("HTTP 代理（CONNECT 隧道）用于读云端 /task；本机直连 workers.dev 被墙时填 http://127.0.0.1:7897；'direct' 或空串 = 直连。"),
  taskApiTimeoutMs: z.number().default(3000).description("云端 /task 读取超时（毫秒）；超时/失败自动回落 tasksPath 文件源。")
});

function apply(ctx, config) {
  const manager = ctx?.["sagitta-manager"];
  let managerApiConfig;
  if (typeof manager?.getApiConfig === "function") {
    try {
      managerApiConfig = manager.getApiConfig();
    } catch {
      managerApiConfig = undefined;
    }
  }
  // Keep the manager object for per-request refreshes, and retain the apply
  // snapshot for startup ordering. Neither path emits credentials.
  ctx.plugin(AutoAdvanceService, {
    ...(config ?? {}),
    manager,
    managerApiConfig
  });
}

export {
  AutoAdvanceService,
  AUTONOMOUS_PROMPT,
  Config,
  STOP_MARKER,
  apply,
  inject,
  name
};
