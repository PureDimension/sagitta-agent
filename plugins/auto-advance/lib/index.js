import z from "@deepseek-ai/schemastery";
import {
  AutoAdvanceService,
  AUTONOMOUS_PROMPT,
  STOP_MARKER,
  splitCloudTaskSnapshotStrict,
  parseRoundCloseText,
  parseRoundCloseMessage,
  validateRoundClosePayload,
} from "./service.js";

const name = "sagitta-auto-advance";
const inject = ["agents", "goals", "sessions", "sagitta-manager"];

const Config = z.object({
  idleTimeoutMs: z.number().default(300000).description("Idle duration before an automatic continuation is injected."),
  statePath: z.string().description("JSON file used to persist the per-session mode. Defaults to the resolved Sagitta workspace."),
  tasksPath: z.string().description("Read-only Markdown task file shown by the client panel. Defaults to the resolved Sagitta workspace."),
  proxy: z.string().default(process.env.DSH_MEMORY_PROXY || "direct").description("HTTP 代理（CONNECT 隧道）用于读云端 /task；与 memory 共用 DSH_MEMORY_PROXY；'direct' 或空串仅允许 loopback。"),
  taskApiTimeoutMs: z.number().default(3000).description("云端 /task 单页读取超时（毫秒）；云端失败时资格判断 fail closed。"),
  taskPageSize: z.number().default(200).description("云端 /task 分页大小（服务端上限 1000）。")
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
  splitCloudTaskSnapshotStrict,
  parseRoundCloseText,
  parseRoundCloseMessage,
  validateRoundClosePayload,
  apply,
  inject,
  name
};
