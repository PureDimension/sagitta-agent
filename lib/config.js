// ============================================================================
// @sagitta/memory — 配置与凭据解析（lib/config.js）
// ============================================================================
// 凭据纪律（设计 §7 L1 硬规则 + security-discipline）：
//   · token 只存在于 .env 文件与进程内存，绝不明文输出/落日志/进记忆条目
//   · 不硬编码任何凭据；插件的任何输出（工具结果、错误信息、诊断日志）
//     只允许出现“是否已配置”布尔值与掩码尾巴（前2后2），绝不出现完整明文
//   · CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET 是**裸 token**（无前缀）——
//     实测教训：带 `CF-Access-Client-Secret:` 前缀会导致 service_token_status:false
// ============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";

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

// ---- 默认值（均为可配置，非硬编码凭据） -----------------------------------

const DEFAULT_BASE_URL = "REPLACE_WITH_WORKER_URL";
const DEFAULT_PROXY = process.env.DSH_MEMORY_PROXY || "direct";
const DEFAULT_ENV_PATH = path.join(
	process.env.HOME || process.env.USERPROFILE || process.cwd(),
	".config",
	"sagitta",
	"memory.env"
);
const DEFAULT_TIMEOUT_MS = 20000;

// ---- 极简 .env 解析（避免引入 dotenv 依赖；只解析，不打印） ----------------
// 支持：KEY=VALUE、`export KEY=VALUE`、`#` 注释、引号值（单/双引号剥壳）、
// 行尾 `\r`（Windows CRLF）。值不做任何插值。

function parseDotEnv(text) {
	const result = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		let key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (key.startsWith("export ")) key = key.slice(7).trim();
		if (key.length === 0) continue;
		if (
			(value.length >= 2 && value.startsWith('"') && value.endsWith('"')) ||
			(value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

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
 * @param {object} [pluginConfig] cordis 插件 config（可空，全部走默认）
 * @returns {object} 归一化配置：{ baseUrl, proxy, timeoutMs, envPath, auth }
 *   auth = { accessClientId, accessClientSecret, authToken }（仅 .env / 显式配置，
 *   无默认值；authPresent 布尔供诊断）
 */
export function resolveConfig(pluginConfig = {}) {
	const envPath = pluginConfig.envPath || process.env.DSH_MEMORY_ENV_PATH || DEFAULT_ENV_PATH;

	// 读 .env（尽力而为：文件缺失/不可读不阻塞加载，后续以“未配置”状态降级）
	let envVars = {};
	try {
		envVars = parseDotEnv(readFileSync(envPath, "utf8"));
	} catch {
		envVars = {};
	}
	const fromEnv = (key) => (envVars[key] !== undefined && envVars[key] !== "" ? envVars[key] : undefined);

	const baseUrl = (
		pluginConfig.baseUrl ||
		fromEnv("DSH_MEMORY_BASE_URL") ||
		process.env.DSH_MEMORY_BASE_URL ||
		DEFAULT_BASE_URL
	).replace(/\/+$/, "");
	// baseUrl/proxy/timeout 优先级：插件配置 > .env 文件 > 进程环境变量 > 默认值
	const proxy = pluginConfig.proxy || fromEnv("DSH_MEMORY_PROXY") || process.env.DSH_MEMORY_PROXY || DEFAULT_PROXY;
	const timeoutFromEnv = fromEnv("DSH_MEMORY_TIMEOUT_MS");
	const timeoutCandidate =
		pluginConfig.timeoutMs !== undefined && pluginConfig.timeoutMs !== ""
			? pluginConfig.timeoutMs
			: timeoutFromEnv || process.env.DSH_MEMORY_TIMEOUT_MS;
	const timeoutMs = Number.isFinite(Number(timeoutCandidate)) ? Number(timeoutCandidate) : DEFAULT_TIMEOUT_MS;

	// 优先级：插件 config 显式值 > .env 文件 > 进程环境变量（CI/部署注入兜底）
	const accessClientId =
		pluginConfig.accessClientId || fromEnv("CF_ACCESS_CLIENT_ID") || process.env.CF_ACCESS_CLIENT_ID || "";
	const accessClientSecret =
		pluginConfig.accessClientSecret || fromEnv("CF_ACCESS_CLIENT_SECRET") || process.env.CF_ACCESS_CLIENT_SECRET || "";
	const authToken = pluginConfig.authToken || fromEnv("AUTH_TOKEN") || process.env.AUTH_TOKEN || "";

	return {
		baseUrl,
		proxy,
		envPath,
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
