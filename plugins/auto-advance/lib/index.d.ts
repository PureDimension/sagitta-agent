import type { Context } from "@deepseek-ai/cordis";
import type { AutoAdvanceService } from "./service.js";

export declare const name: "sagitta-auto-advance";
export declare const inject: readonly ["agents", "goals", "sessions", "sagitta-manager", "sagitta-async-work"];
export declare const Config: unknown;
export declare const AUTONOMOUS_PROMPT: string;
export declare const IN_PERSON_CHALLENGE: string;
export declare const AUTONOMOUS_CHALLENGE: string;
export declare const STOP_MARKER: string;
export declare function parseRoundCloseText(text: string): {
  readonly task_id: string;
  readonly action: "update" | "done" | "blocked";
  readonly progress: string;
  readonly next: string;
  readonly round_id: string;
  readonly blocked_reason?: string;
  readonly expected_updated_at?: string;
};
export declare function parseRoundCloseMessage(message: unknown): { kind: "tool" | "text"; payload: ReturnType<typeof parseRoundCloseText> } | { kind: "tool-other" } | null;
export declare function validateRoundClosePayload(value: unknown): ReturnType<typeof parseRoundCloseText>;
export declare function splitCloudTaskSnapshotStrict(value: unknown): {
  readonly source: "cloud";
  readonly total: number;
  readonly page: number;
  readonly size: number;
  readonly items: readonly unknown[];
  readonly runnable: readonly unknown[];
  readonly confirmationQueue: readonly unknown[];
  readonly waiting: readonly unknown[];
  readonly terminal: readonly unknown[];
};
export { AutoAdvanceService };
export declare function apply(ctx: Context, config?: unknown): void;
