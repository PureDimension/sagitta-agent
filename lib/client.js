// ============================================================================
// @sagitta/memory — Worker API 客户端（lib/client.js）
// ============================================================================
// 端点契约对齐 worker/README.md + worker.js（v1.3.0）：
//   GET  /mem/health                        部署验收（无需认证）
//   POST /mem/{stream}                      创建条目（origin 决定初始 score：ripple=2 / sagitta=0；
//                                            初始 status 与 score 同档：ripple→corroborated / sagitta→captured）
//   GET  /mem/{stream}                      列表（page/size/type/domain/status 过滤；
//                                            默认排除 archived/superseded，除非显式 status 过滤）
//   GET  /mem/{stream}/{id}                 单条
//   POST /mem/search                        关键词检索（LIKE，v1 禁 embedding；默认排除终态）
//   POST /mem/consolidate                   治理动作（digest/corroborate 兜底；validate 事件化盲点必填；
//                                            replace 整体更换留审计；archive 治理归档）
//   POST /mem/ack                           信任信号三态（explicit +2 / unobjected +1 带 statement_source /
//                                            oppose −3；score 钳制 0~3，score<0 软归档）
//   POST /mem/delegations                   写 delegation（ripple 仅涟漪背书触发）
//   GET  /mem/delegations/{task_id}         读 delegation
//   · 召回条目带 trust_level/trust_hint（服务端按 score 生成）与 validation_events（validated 事件）
// ============================================================================
// 凭据纪律：所有请求头在此组装，token 只存于进程内存，绝不进入任何输出文
// 本（工具结果、错误消息、日志）。错误消息只给“是否配置 + 掩码尾巴 + 指引”。
// ============================================================================

import { request, HttpStatusError, HttpNetworkError, HttpTimeoutError } from "./http.js";

/** 服务端返回的业务错误（{ok:false, error:{code,message}} 已解包）。 */
export class MemoryApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = "MemoryApiError";
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAccessLoginBody(status, statusText, headers, bodyText) {
  // Cloudflare Access 未匹配时返回 302（登录跳转）或 200 + HTML 登录页
  const normalized = bodyText.trimStart();
  if (status === 302 || status === 307 || status === 303) return true;
  if (/<!DOCTYPE html/i.test(normalized) && /(?:Cloudflare Access|Sign in|Log in to)/i.test(normalized)) return true;
  return false;
}

/**
 * 把三类失败（网络/超时/HTTP 状态）归一化为可读中文错误。
 * @returns {Error} 抛出用（MemoryApiError 或 MemoryNetworkError）
 */
function translateFailure(err, { proxy, timeoutMs }) {
  if (err instanceof HttpTimeoutError) {
    return new Error(
       `请求超时（${err.timeoutMs}ms）：云端无响应。若本机网络无法直连 REPLACE_WITH_WORKER_URL，` +
        `请确认 clash 代理（默认 ${proxy}）在运行且插件 proxy 配置正确；` +
        `也可在插件 config 中把 timeoutMs 调大。`
    );
  }
  if (err instanceof HttpNetworkError) {
    const causeMsg = err.cause && err.cause.message ? String(err.cause.message) : "";
    const isAbort = /abort/i.test(causeMsg) && /aborted/i.test(causeMsg);
    if (isAbort) return new Error("请求已中止（被调用方取消）。");
    return new Error(
      `网络错误：${causeMsg || "无法连接"}。检查点：① clash 代理 ${proxy} 是否运行；` +
       `② 插件 proxy 配置（直连模式需本机网络能直达 ${"REPLACE_WITH_WORKER_URL"}）；③ 目标地址 baseUrl 是否正确。`
    );
  }
  if (err instanceof HttpStatusError) {
    const bodyText = err.bodyText || "";
    if (isAccessLoginBody(err.status, err.statusText, err.headers, bodyText)) {
      return new Error(
        `请求被 Cloudflare Access 拦截（HTTP ${err.status}，返回了登录页而非 API）。` +
          `指引：确认 .env 中 CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET 已配置为裸 token` +
          `（无 "CF-Access-Client-Secret:" 前缀——实测前缀会导致 service_token_status:false），` +
          `且 Access 策略对该域名启用了 Service Auth（服务身份验证），而不是仅 Allow。`
      );
    }
    if (err.status === 401) {
      return new Error(
        `认证失败（HTTP 401）：Bearer AUTH_TOKEN 未匹配。指引：AUTH_TOKEN 仅存在于 Worker Secret 与 .env；` +
          `若未配置该键，本插件不发送 Bearer（此时完全依赖 Access 服务令牌放行），` +
          `请确认 .env 的 CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET 与网关策略一致。`
      );
    }
    // 服务端业务错误：{ok:false, error:{code,message}} —— 直接透传服务端的中文指引
    try {
      const parsed = JSON.parse(bodyText);
      if (isPlainObject(parsed) && parsed.ok === false && isPlainObject(parsed.error)) {
        const { code, message } = parsed.error;
        return new MemoryApiError(err.status, code || String(err.status), message || `服务端拒绝（${err.status}）`);
      }
    } catch {
      /* 非 JSON 响应（如 HTML 登录页兜底已处理） */
    }
    if (err.status === 403) {
      return new Error(`拒绝访问（HTTP 403）：Access 策略未放行该服务令牌，或目标域名与策略不匹配。`);
    }
    if (err.status === 404) {
      return new Error(`资源不存在（HTTP 404）：条目/任务 id 可能写错，或 stream 与 id 不匹配（设计 §3 归属校验）。`);
    }
    if (err.status === 405) {
      return new Error(`方法不允许（HTTP 405）：该路径不支持此方法——请按 README 端点表核对用法。`);
    }
    if (err.status === 409) {
      return new Error(`状态冲突（HTTP 409）：条目处于终态（superseded/archived），无法继续推进/累计认可（设计 §4）。`);
    }
    if (err.status === 503) {
      return new Error(
        `服务暂不可用（HTTP 503）：D1 binding 未配置或 AUTH_TOKEN secret 缺失（部署侧问题，见 README 部署检查）。`
      );
    }
    if (err.status >= 500) {
      return new Error(`服务端错误（HTTP ${err.status}）：${err.statusText || "INTERNAL"}。` +
        (bodyText && !/<!DOCTYPE/i.test(bodyText.trimStart()) ? ` 响应：${truncateForError(bodyText)}` : ""));
    }
    return new Error(`请求失败（HTTP ${err.status} ${err.statusText || ""}）：${truncateForError(bodyText) || "（无响应正文）"}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function truncateForError(text) {
  const t = String(text).trim();
  return t.length > 300 ? t.slice(0, 300) + "…" : t;
}

/**
 * 组装认证头。access 服务令牌始终发送（Access 网关放行的主通道）；Bearer 仅当
 * AUTH_TOKEN 已配置时发送（Worker 代码层兜底）。任何情况下都不打印明文。
 */
export function buildAuthHeaders(auth) {
  const headers = {};
  if (auth.accessPresent) {
    headers["CF-Access-Client-Id"] = auth.accessClientId;
    headers["CF-Access-Client-Secret"] = auth.accessClientSecret;
  }
  if (auth.bearerPresent) {
    headers["Authorization"] = `Bearer ${auth.authToken}`;
  }
  return headers;
}

/**
 * 内存 API 客户端。每个方法返回服务端 {data:…} 解包后的对象；错误抛
 * MemoryApiError / 中文指引 Error。
 */
export class SagittaMemoryClient {
  constructor(config) {
    this.config = config;
    this.baseUrl = String(config.baseUrl).replace(/\/+$/, "");
  }

  async request(path, { method = "GET", query, body, signal } = {}) {
    const url = this.baseUrl + path + (query ? buildQuery(query) : "");
    let response;
    try {
      response = await request({
        method,
        url,
        headers: buildAuthHeaders(this.config.auth),
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: this.config.timeoutMs,
        signal,
        proxy: this.config.proxy,
      });
    } catch (err) {
      throw translateFailure(err, { proxy: this.config.proxy, timeoutMs: this.config.timeoutMs });
    }

    const bodyText = response.body.toString("utf8");
    if (response.status >= 200 && response.status < 300) {
      if (bodyText.trim().length === 0) return {};
      try {
        const parsed = JSON.parse(bodyText);
        if (isPlainObject(parsed) && parsed.ok === true && "data" in parsed) return parsed.data;
        if (isPlainObject(parsed) && "ok" in parsed) return parsed; // health 等无 data 包装
        return parsed;
      } catch {
        return { raw: bodyText };
      }
    }
    throw translateFailure(new HttpStatusError(response.status, response.statusText, response.headers, bodyText), {
      proxy: this.config.proxy,
      timeoutMs: this.config.timeoutMs,
    });
  }

  // ---- 端点方法 -------------------------------------------------------------

  async health(signal) {
    return await this.request("/mem/health", { method: "GET", signal });
  }

  async createEntry(stream, payload, signal) {
    return await this.request(`/mem/${encodeURIComponent(stream)}`, { method: "POST", body: payload, signal });
  }

  async listEntries(stream, filters = {}, signal) {
    const { page, size, type, domain, status } = filters;
    const query = {};
    if (page !== undefined) query.page = page;
    if (size !== undefined) query.size = size;
    if (type) query.type = type;
    if (domain) query.domain = domain;
    if (status) query.status = status;
    return await this.request(`/mem/${encodeURIComponent(stream)}`, { method: "GET", query, signal });
  }

  async getEntry(stream, id, signal) {
    return await this.request(`/mem/${encodeURIComponent(stream)}/${encodeURIComponent(id)}`, { method: "GET", signal });
  }

  async search(params = {}, signal) {
    const { query, stream, type, domain, status, tags, page, size } = params;
    return await this.request("/mem/search", {
      method: "POST",
      body: {
        query,
        ...(stream ? { stream } : {}),
        ...(type ? { type } : {}),
        ...(domain ? { domain } : {}),
        ...(status ? { status } : {}),
        ...(Array.isArray(tags) && tags.length > 0 ? { tags } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(size !== undefined ? { size } : {}),
      },
      signal,
    });
  }

  async consolidate(payload, signal) {
    return await this.request("/mem/consolidate", { method: "POST", body: payload, signal });
  }

  async ack(payload, signal) {
    return await this.request("/mem/ack", { method: "POST", body: payload, signal });
  }

  async createDelegation(payload, signal) {
    return await this.request("/mem/delegations", { method: "POST", body: payload, signal });
  }

  async getDelegation(taskId, signal) {
    return await this.request(`/mem/delegations/${encodeURIComponent(taskId)}`, { method: "GET", signal });
  }
}

function buildQuery(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
