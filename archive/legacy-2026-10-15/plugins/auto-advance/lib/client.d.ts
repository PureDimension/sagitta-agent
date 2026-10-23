import type { Context } from "@deepseek-ai/cordis";

export declare const inject: readonly ["remote", "sessions", "slots"];
export declare function apply(ctx: Context): Promise<void>;
