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
  ctx.plugin(AutoAdvanceService, config ?? {});
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
