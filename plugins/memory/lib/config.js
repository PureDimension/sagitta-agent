// sagitta-memory — 记忆工具的服务端枚举常量。

// ---- 与已部署 Worker 一致的白名单（worker.js / schema.sql 同源） ---------

export const STREAMS = ["sagitta", "ripple", "personal-projects", "company-projects"];
export const TYPES = ["timeline", "delegation", "lesson", "decision", "method", "preference", "project", "judgment"];
export const STATUSES = ["captured", "digested", "corroborated", "validated", "superseded", "archived"];
export const EVIDENCE_STATES = ["verified", "corroborated", "plausible", "unproven"];
// 设计 §4 v1.3 三态信任信号（explicit +2 / unobjected +1 / oppose −3；与 worker ACK_SIGNALS 严格一致）
export const ACK_SIGNALS = ["explicit", "unobjected", "oppose"];
// 设计 §3 v1.3：origin（谁提出的——先天信任判据；ripple 先天 score=2，sagitta 默认 score=0）
export const ORIGINS = ["ripple", "sagitta"];
// v1.3 起 validated 事件化：validate 动作不再要求 validation_source 四选一，
// 改为 write 验证事件（blind_spot 必填）+ status=validated/score=3 固化档。
export const CONSOLIDATE_ACTIONS = ["digest", "corroborate", "validate", "replace", "archive"];
export const DELEGATEES = ["codex", "subagent", "self", "ripple"];
export const VERIFICATION_RESULTS = ["confirmed", "contradicted", "partial", "unverifiable"];
