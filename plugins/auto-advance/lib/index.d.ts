import type { Context } from "@deepseek-ai/cordis";
import type { AutoAdvanceService } from "./service.js";

export declare const name: "sagitta-auto-advance";
export declare const inject: readonly ["agents", "goals", "sessions"];
export declare const Config: unknown;
export declare const AUTONOMOUS_PROMPT: string;
export declare const STOP_MARKER: string;
export { AutoAdvanceService };
export declare function apply(ctx: Context, config?: unknown): void;
