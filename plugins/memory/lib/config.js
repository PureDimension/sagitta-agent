// ============================================================================
// sagitta-memory-plugin — 配置与凭据解析（lib/config.js）
// ============================================================================
// 凭据纪律（设计 §7 L1 硬规则 + security-discipline）：
//   · token 由 sagitta-manager 保管并只在进程内存中流转，绝不明文输出/落日志/进记忆条目
//   · 不硬编码任何凭据；插件的任何输出（工具结果、错误信息、诊断日志）
//     只允许出现“是否已配置”布尔值与掩码尾巴（前2后2），绝不出现完整明文
//   · 兼容 fallback 的旧 Access 字段仍按裸 token 处理，但不再是公开 Config 来源
// ============================================================================

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

// ---- 默认值（API 地址与凭据由 sagitta-manager 提供） ------------------------

const DEFAULT_PROXY = process.env.DSH_MEMORY_PROXY || "direct";
const DEFAULT_TIMEOUT_MS = 20000;

// ---- 凭据掩码（诊断用）：前 2 后 2，中间打码，绝不输出完整明文 --------------

export function maskToken(value) {
	if (typeof value !== "string" || value.length === 0) return "(未配置)";
	if (value.length <= 4) return "****";
	return value.slice(0, 2) + "…" + value.slice(-2) + `(${value.length}字符)`;
}

/** 诊断用短掩码：前2后2，中间星号（绝不输出完整明文）。 */
export function maskTokenSummary(value) {
	if (typeof value !== "string" || value.length === 0) return "(未配置)";
	if (value.length <= 4) return "(已配置)";
	return value.slice(0, 2) + "****" + value.slice(-2);
}

// ---- 配置解析 ---------------------------------------------------------------

/**
 * 解析插件配置。
 *
 * API endpoint 与 token 的公开配置已经迁移到 sagitta-manager。这里仅声明
 * transport 选项。为迁移期间保留直接构造客户端的兼容性，resolveConfig
 * 仍会接收调用方显式传入的旧字段作为 fallback；它们没有默认值，也不再
 * 从 .env、进程环境或线上地址读取。
 *
 * @param {object} [pluginConfig] cordis 插件 config（可空，全部走默认）
 * @returns {object} 归一化配置：{ baseUrl, proxy, timeoutMs, auth }
 */
export function resolveConfig(pluginConfig = {}) {
	const raw = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
	const text = (value) => (typeof value === "string" ? value.trim() : "");
	const baseUrl = text(raw.baseUrl).replace(/\/+$/, "");
	const accessClientId = text(raw.accessClientId);
	const accessClientSecret = text(raw.accessClientSecret ?? raw.accessSecret);
	const authToken = text(raw.authToken);
	const proxy = text(raw.proxy) || process.env.DSH_MEMORY_PROXY || DEFAULT_PROXY;
	const timeoutFromEnv = process.env.DSH_MEMORY_TIMEOUT_MS;
	const timeoutCandidate =
		raw.timeoutMs !== undefined && raw.timeoutMs !== "" ? raw.timeoutMs : timeoutFromEnv;
	const timeoutMs = Number.isFinite(Number(timeoutCandidate)) ? Number(timeoutCandidate) : DEFAULT_TIMEOUT_MS;

	return {
		baseUrl,
		proxy,
		timeoutMs,
		auth: {
			accessClientId,
			accessClientSecret,
			authToken,
			accessPresent: accessClientId.length > 0 && accessClientSecret.length > 0,
			bearerPresent: authToken.length > 0,
		},
	};
}
