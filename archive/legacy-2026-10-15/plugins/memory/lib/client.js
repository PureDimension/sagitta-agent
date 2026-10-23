// ============================================================================
// sagitta-memory — Worker API 客户端（lib/client.js）
// ============================================================================
// 端点契约对齐 cloudflare-worker/README.md + worker.js（v1.3.0）：
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
// 凭据纪律：凭据和传输请求头由 sagitta-manager 统一处理；本客户端只组装
// 端点参数和 task 所需的调用方 header。
// ============================================================================

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

function isAccessLoginBody(status, bodyText) {
  // Cloudflare Access 未匹配时返回 302（登录跳转）或 200 + HTML 登录页
  const normalized = bodyText.trimStart();
  if (status === 302 || status === 307 || status === 303) return true;
  if (/<!DOCTYPE html/i.test(normalized) && /(?:Cloudflare Access|Sign in|Log in to)/i.test(normalized)) return true;
  return false;
}

/**
 * 把 manager 返回的 HTTP 业务错误归一化为可读中文错误。
 * @returns {Error} 抛出用（MemoryApiError 或 MemoryNetworkError）
 */
function translateFailure(err) {
  if (err?.status !== undefined) {
    const bodyText = err.bodyText || "";
    if (isAccessLoginBody(err.status, bodyText)) {
      return new Error(
        `请求被 Cloudflare Access 拦截（HTTP ${err.status}，返回了登录页而非 API）。` +
          `指引：确认 Sagitta Manager 中对应 D1 token 已配置为裸 token，` +
          `且 Access 策略对该域名启用了 Service Auth（服务身份验证），而不是仅 Allow。`
      );
    }
    if (err.status === 401) {
      return new Error(
        `认证失败（HTTP 401）：Sagitta Manager 中当前操作对应的 D1 token 未匹配。` +
          `请确认 Settings > Plugins > Sagitta Manager 中的读/写 token 与 Worker 策略一致。`
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
        `服务暂不可用（HTTP 503）：D1 binding 未配置或 Worker 认证 secret 缺失（部署侧问题，见 README 部署检查）。`
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

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 内存 API 客户端。它只负责组装 memory/task 端点参数；所有网络、凭据、
 * CONNECT 隧道和超时都由 sagitta-manager.request 负责。
 */
export class SagittaMemoryClient {
  constructor(manager) {
    if (!manager || typeof manager.request !== "function") {
      throw new Error("sagitta-memory requires sagitta-manager.request");
    }
    this.manager = manager;
  }

  async request(path, { method = "GET", query, body, signal, agentId } = {}) {
    const headers = {};
    const callerAgentId = textValue(agentId);
    if (callerAgentId) headers["X-Agent-Id"] = callerAgentId;
    const init = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (signal !== undefined) init.signal = signal;

    let response;
    try {
      response = await this.manager.request(path + (query ? buildQuery(query) : ""), init);
    } catch (error) {
      throw translateFailure(error);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
      error.status = response.status;
      error.statusText = response.statusText || "";
      error.bodyText = bodyText;
      throw translateFailure(error);
    }
    if (bodyText.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(bodyText);
      if (isPlainObject(parsed) && parsed.ok === true && "data" in parsed) return parsed.data;
      if (isPlainObject(parsed) && "ok" in parsed) return parsed;
      return parsed;
    } catch {
      return { raw: bodyText };
    }
  }

  // ---- 端点方法 -------------------------------------------------------------

  async health(signal) {
    return await this.request("/mem/health", { method: "GET", operation: "read", signal });
  }

  async createEntry(stream, payload, signal) {
    return await this.request(`/mem/${encodeURIComponent(stream)}`, { method: "POST", operation: "write", body: payload, signal });
  }

  async listEntries(stream, filters = {}, signal) {
    const { page, size, type, domain, status } = filters;
    const query = {};
    if (page !== undefined) query.page = page;
    if (size !== undefined) query.size = size;
    if (type) query.type = type;
    if (domain) query.domain = domain;
    if (status) query.status = status;
    return await this.request(`/mem/${encodeURIComponent(stream)}`, { method: "GET", operation: "read", query, signal });
  }

  async getEntry(stream, id, signal) {
    return await this.request(`/mem/${encodeURIComponent(stream)}/${encodeURIComponent(id)}`, { method: "GET", operation: "read", signal });
  }

  async search(params = {}, signal) {
    const { query, stream, type, domain, status, tags, page, size } = params;
    return await this.request("/mem/search", {
      method: "POST",
      operation: "read",
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
    return await this.request("/mem/consolidate", { method: "POST", operation: "write", body: payload, signal });
  }

  async ack(payload, signal) {
    return await this.request("/mem/ack", { method: "POST", operation: "write", body: payload, signal });
  }

  async createDelegation(payload, signal) {
    return await this.request("/mem/delegations", { method: "POST", operation: "write", body: payload, signal });
  }

  async getDelegation(taskId, signal) {
    return await this.request(`/mem/delegations/${encodeURIComponent(taskId)}`, { method: "GET", operation: "read", signal });
  }

  // ---- task API（docs/task-api-p1.md；/task 路由 08-30 部署上线）----

  async listTasks(filters = {}, signal) {
    const { project, stream, status, checkbox, kind, owner, includeTemp, include_temp: includeTempSnake, agentId, page, size } = filters;
    const query = {};
    if (project) query.project = project;
    if (stream) query.stream = stream;
    if (status) query.status = status;
    if (checkbox !== undefined && checkbox !== null && checkbox !== "") query.checkbox = String(checkbox);
    if (kind) query.kind = kind;
    // owner is a server-side view selector (normally "me"); the owner id is
    // intentionally never sent by the plugin or exposed to the model.
    if (owner) query.owner = owner;
    const includeTempValue = includeTemp ?? includeTempSnake;
    if (includeTempValue !== undefined && includeTempValue !== null) {
      query.include_temp = includeTempValue === true ? "1" : includeTempValue === false ? "0" : String(includeTempValue);
    }
    if (page !== undefined) query.page = page;
    if (size !== undefined) query.size = size;
    return await this.request("/task", { method: "GET", operation: "read", query, signal, agentId });
  }

  async getTask(id, signal) {
    return await this.request(`/task/${encodeURIComponent(id)}`, { method: "GET", operation: "read", signal });
  }

  async createTask(payload, signal) {
    return await this.request("/task", { method: "POST", operation: "write", body: payload, signal });
  }

  async patchTask(id, payload, signal, agentId) {
    return await this.request(`/task/${encodeURIComponent(id)}`, { method: "PATCH", operation: "write", body: payload, signal, agentId });
  }

  /**
   * 原子认领任务（task-system-v3；POST /task/{id}/claim）。
   * 条件（服务端单条 UPDATE）：status='open'，或 in_progress 且 owner 租约过期/为空。
   * 同 owner 的有效租约会续租恢复；claim_token 仅为旧客户端兼容字段，云端 owner_agent_id
   * 才是会话权威。
   * @param {string} id 任务 id
   * @param {{leaseSeconds?: number}} [opts] lease_seconds（1~604800 秒，缺省=全局默认 24h）
   */
  async claimTask(id, { leaseSeconds, agentId } = {}, signal) {
    const body = {};
    if (leaseSeconds !== undefined && leaseSeconds !== null) body.lease_seconds = leaseSeconds;
    return await this.request(`/task/${encodeURIComponent(id)}/claim`, { method: "POST", operation: "write", body, signal, agentId });
  }

  /**
   * 释放任务认领（task-system-v3；POST /task/{id}/release）。
   * 当前 X-Agent-Id 对应的有效云端 owner 可无 token 释放；in_progress 且无 pending 时
   * status 回 open。非 owner（或已过期租约）→ 403 TASK_CLAIM_OWNER_MISMATCH。
   * 成功响应：完整任务投影（claim_state=unclaimed，不含 claim_token）。
   * @param {string} id 任务 id
   * @param {string|{claimToken?: string, agentId?: string}} claimTokenOrOptions 兼容旧 token
   *   调用；v3 优先传 agentId，token 不授予权限
   */
  async releaseTask(id, claimTokenOrOptions, signal) {
    const options = claimTokenOrOptions && typeof claimTokenOrOptions === "object"
      ? claimTokenOrOptions
      : { claimToken: claimTokenOrOptions };
    const body = options.claimToken === undefined || options.claimToken === null || options.claimToken === ""
      ? {}
      : { claim_token: options.claimToken };
    return await this.request(`/task/${encodeURIComponent(id)}/release`, {
      method: "POST",
      operation: "write",
      body,
      signal,
      agentId: options.agentId,
    });
  }

  /**
   * 记录任务需要涟漪参与/决定（task-system-v3 §2）。
   * type=need 阻塞 done；type=notify 仅告知涟漪，不阻塞 done。
   */
  async createNeedHuman(taskId, content, suggestion, type = "need", signal) {
    // 兼容旧的 positional 调用 createNeedHuman(taskId, content, suggestion, signal)。
    if (type !== undefined && type !== null && typeof type !== "string") {
      signal = type;
      type = "need";
    }
    const body = {
      content,
      type: type ?? "need",
      ...(suggestion !== undefined && suggestion !== null ? { suggestion } : {}),
    };
    return await this.request(`/task/${encodeURIComponent(taskId)}/need-human`, {
      method: "POST",
      operation: "write",
      body,
      signal,
    });
  }

  /** 解决/放弃一条 need-human，并按 target 原子流转所属任务（v3）。 */
  async resolveNeedHuman(needHumanId, resolveKind, target, signal, options = {}) {
    // 兼容旧的 positional 调用 resolveNeedHuman(id, kind, signal)。
    if (target !== undefined && target !== null && typeof target !== "string") {
      signal = target;
      target = undefined;
    }
    const body = resolveKind === undefined || resolveKind === null
      ? {}
      : { resolve_kind: resolveKind };
    if (target !== undefined && target !== null) body.target = target;
    if (options.blockedKind !== undefined && options.blockedKind !== null) body.blocked_kind = options.blockedKind;
    if (options.evidenceJson !== undefined && options.evidenceJson !== null) body.evidence_json = options.evidenceJson;
    return await this.request(`/task/need-human/${encodeURIComponent(needHumanId)}/resolve`, {
      method: "POST",
      operation: "write",
      body,
      signal,
    });
  }

  /** 跨任务汇聚 need-human（默认由调用方传 status=open）。 */
  async listNeedHuman(status, signal) {
    return await this.request("/need-human", {
      method: "GET",
      operation: "read",
      ...(status ? { query: { status } } : {}),
      signal,
    });
  }

  async confirmTask(id, payload, signal) {
    return await this.request(`/task/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      operation: "write",
      body: payload,
      signal,
    });
  }

  async roundCloseTask(id, payload, signal) {
    return await this.request(`/task/${encodeURIComponent(id)}/round-close`, {
      method: "POST",
      operation: "write",
      body: payload,
      signal,
    });
  }

  async deleteTask(id, signal) {
    return await this.request(`/task/${encodeURIComponent(id)}`, { method: "DELETE", operation: "write", signal });
  }

  async searchTasks(params = {}, signal) {
    const { query, project, stream, status, page, size } = params;
    return await this.request("/task/search", {
      method: "POST",
      operation: "read",
      body: {
        query,
        ...(project ? { project } : {}),
        ...(stream ? { stream } : {}),
        ...(status ? { status } : {}),
        ...(page !== undefined ? { page } : {}),
        ...(size !== undefined ? { size } : {}),
      },
      signal,
    });
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
