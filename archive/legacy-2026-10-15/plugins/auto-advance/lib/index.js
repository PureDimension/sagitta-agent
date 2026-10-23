import z from "@deepseek-ai/schemastery";
import {
  AutoAdvanceService,
  AUTONOMOUS_PROMPT,
  IN_PERSON_CHALLENGE,
  AUTONOMOUS_CHALLENGE,
  AUTONOMOUS_TURN_END_CHALLENGE,
  STOP_MARKER,
  splitCloudTaskSnapshotStrict,
  parseRoundCloseText,
  parseRoundCloseMessage,
  validateRoundClosePayload,
} from "./service.js";

const name = "sagitta-auto-advance";
const inject = ["agents", "goals", "sessions", "sagitta-manager", "sagitta-async-work"];

const Config = z.object({
  idleTimeoutMs: z.number().default(15000).description("Task-driven polling delay; idle time alone never starts autonomous work."),
  codexMaxConcurrent: z.number().min(1).default(4).description("Per-agent codex execution-slot limit used to suppress prompts while codex resources are full."),
  advancePromptCooldownMs: z.number().min(0).default(30000).description("Initial cooldown between repeated owned-task continuation prompts (milliseconds)."),
  advancePromptBackoffFactor: z.number().min(1).default(2).description("Exponential backoff factor for repeated owned-task continuation prompts."),
  advancePromptMaxCooldownMs: z.number().min(0).default(300000).description("Maximum cooldown between repeated owned-task continuation prompts (milliseconds)."),
  advancePromptMaxInjections: z.number().min(1).default(3).description("Maximum continuation prompt injections for one unchanged task snapshot."),
  statePath: z.string().description("JSON file used to persist the per-session mode. Defaults to <DSH_HOME>/profiles/web."),
  taskPageSize: z.number().default(200).description("云端 /task 分页大小（服务端上限 1000）。")
});

function apply(ctx, config) {
  const manager = ctx?.["sagitta-manager"];
  ctx.plugin(AutoAdvanceService, {
    ...(config ?? {}),
    manager
  });
}

export {
  AutoAdvanceService,
  AUTONOMOUS_PROMPT,
  IN_PERSON_CHALLENGE,
  AUTONOMOUS_CHALLENGE,
  AUTONOMOUS_TURN_END_CHALLENGE,
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
