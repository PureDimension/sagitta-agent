import type { Context } from "@deepseek-ai/cordis";
import type { AutoAdvanceService } from "./service.js";

export declare const name: "sagitta-auto-advance";
export declare const inject: readonly ["agents", "goals", "sessions"];
export declare const Config: unknown;
export declare const AUTONOMOUS_PROMPT: string;
export declare const STOP_MARKER: string;
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
