import z from "@deepseek-ai/schemastery";
import { AutoAdvanceService, AUTONOMOUS_PROMPT, STOP_MARKER } from "./service.js";

const name = "sagitta-auto-advance";
const inject = ["agents", "goals", "sessions"];

const Config = z.object({
  idleTimeoutMs: z.number().default(300000).description("Idle duration before an automatic continuation is injected."),
  statePath: z.string().description("JSON file used to persist the per-session mode. Defaults to the resolved Sagitta workspace."),
  tasksPath: z.string().description("Read-only Markdown task file shown by the client panel. Defaults to the resolved Sagitta workspace.")
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
