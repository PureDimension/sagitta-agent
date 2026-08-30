// ============================================================================
// Sagitta 记忆模块 — Cloudflare Worker API（D1 后端）
// ============================================================================
// 对应设计文档：memory-system-design.md v1.3
//   §1 总架构（Workers API + D1 知识层真相源；宪法层仍走 git 文件，二者分工）
//   §3 半结构化协议（条目骨架 + delegation schema，字段定义与 schema.sql 完全一致）
//   §4 分数驱动状态机（v1.3 核心）：
//       · 三态信任信号：explicit +2 / unobjected +1 / oppose −3
//       · score 钳制 0~3；score<0 → 软归档（status=archived、score=0、archived_at=now）
//       · 初始分按来源：origin=ripple → score=2（先天带信任）；sagitta → score=0（必须靠认可爬升）
//       · 状态自动联动（ack 提交时发生，不需要手动 consolidate）：score≥1 → digested；score≥2 → corroborated
//       · validated 事件化：validation_events 表（validated/replaced/archived），
//         写入 validated 事件 = 该条目 validated 的事实；score=3 为固化信任档
//       · consolidate 降级为治理动作：批量复核、写验证事件、执行 replace/归档
//   §7 时间线与 delegation（单表 entries + stream 列 + 索引；delegation 独立表）
// 审查结论：design-review.md（P0：delegation 记录 / 强制复写 / validated 可机检证据）
//          + design-review-v2.md（涟漪权威约束：unobjected 防后门、delegatee=ripple
//          仅涟漪明确背书触发，AI 无权代填）
// v1.2 → v1.3 变更（涟漪拍板，逐条实现）：
//   A. 信任分数：三态信号 + 钳制 + 软归档 + origin 初始分；ack 计数保留为事实，score 是派生信任值
//   B. 分数驱动自动流转：升级在 ack 时自动发生；consolidate 不再是升级唯一通道
//   C. validated 事件化：validation_events（盲点必填，缺 blind_spot 拒绝 422）；召回带事件
//   D. replace 整体更换：描述全换、score 按新 origin 重置、旧内容进事件仅审计；recall/search 默认排除 archived/superseded
//   E. 召回信任提示：recall/search 条目带 trust_level + 提示文案（服务端按 score 生成）
//   F. 一致性：字段与 schema.sql 完全一致；ES Module；SQL 全参数化；unobjected 门禁与
//      delegatee=ripple 保留不破坏
//
// 部署：Dashboard → Edit code 直接粘贴本文件（详见 worker/README.md）。
//   D1 binding 名必须为 DB；/mem 使用 AUTH_TOKEN 兜底，task 可按读写使用
//   D1_READ_TOKEN / D1_WRITE_TOKEN（均未配置时返回 503）。
// 格式说明：本文件使用 **ES Module 格式**（export default { fetch(request, env) }），
//   这是硬要求：Cloudflare 的 D1 binding 只支持 ES Module 格式，经典 Service Worker
//   格式（addEventListener('fetch')）会报 `Binding 'DB' of type 'd1' requires a Worker
//   written in ES module format`。binding（DB）与 secret（AUTH_TOKEN）一律经 env 参数
//   注入（env.DB / env.AUTH_TOKEN）。语法自检：Node ≥ 23 默认开启模块语法检测，
//   直接 `node --check worker.js` 即可通过（实测 Node 24.19 通过）；Node 20.10–22
//   用 `node --experimental-default-type=module --check worker.js`。详见 README.md。
// ============================================================================

'use strict';

const VERSION = '1.3.0';

// ---- 枚举常量（服务端强制；管理字段由服务端填写，AI 无权编造） -------------

// 设计 §7 四流（stream 校验白名单）
const STREAMS = ['sagitta', 'ripple', 'personal-projects', 'company-projects'];

// 设计 §3 type 枚举
const TYPES = ['timeline', 'delegation', 'lesson', 'decision', 'method', 'preference', 'project', 'judgment'];

// 设计 §3 evidence 证据状态（v1.2 遗留字段；v1.3 下仅 validate 事件联动 verified）
const EVIDENCE_STATES = ['verified', 'corroborated', 'plausible', 'unproven'];

// 设计 §4 分数驱动状态机（v1.3）：
//   captured → digested → corroborated 由 ack 提交自动联动（score≥1 / ≥2）
//   validated 由 validation_events 事件承载（事件写入 = validated 事实；score=3 固化档）
//   superseded / archived 为终态；score<0 自动软归档 → archived
const STATUSES = ['captured', 'digested', 'corroborated', 'validated', 'superseded', 'archived'];

// 设计 §3 v1.3 新增：origin（谁提出的——先天信任的判据）
const ORIGINS = ['ripple', 'sagitta'];

// 设计 §4 v1.3 三态信任信号（explicit +2 / unobjected +1 / oppose −3）
const ACK_SIGNALS = ['explicit', 'unobjected', 'oppose'];

// 三态信号的分值（服务端唯一计分源；oppose 为强负信号）
const SIGNAL_DELTAS = Object.freeze({ explicit: 2, unobjected: 1, oppose: -3 });

// 设计 §4 v1.3 事件类型（validation_events.event_type）
const EVENT_TYPES = ['validated', 'replaced', 'archived'];

// 设计 §4 v1.2 遗留：validated 可机检证据四选一 —— v1.3 起 validated 改由事件承载
// （涟漪拍板：validated 不再由 consolidate 门槛驱动；四选一门槛随之移除，由
//   blind_spot + 可选 linked_delegation_id 承担审计语义）

// 设计 §3 delegation.delegatee；ripple 仅用于涟漪明确背书记录，必须涟漪输入触发
// （design-review-v2.md 三、②：AI 无权代填"涟漪已背书"）
const DELEGATEES = ['codex', 'subagent', 'self', 'ripple'];

// 设计 §3 delegation.verification_result 枚举
const VERIFICATION_RESULTS = ['confirmed', 'contradicted', 'partial', 'unverifiable'];

// consolidate 支持的动作（v1.3 治理动作集）
const CONSOLIDATE_ACTIONS = ['digest', 'corroborate', 'validate', 'replace', 'archive'];

const MAX_BODY_BYTES = 1024 * 1024; // 请求体上限 1MB（记忆条目正文远小于此）

const SCORE_MIN = 0;
const SCORE_MAX = 3; // 设计 §4 v1.3 钳制上界；score<0 触发软归档（下界由归档消化）

// task API（docs/task-api-p1.md §1）：任务状态独立于 memory 条目状态。
const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'waiting', 'done'];
// 任务沿用记忆四流；兼容草案 DDL 的默认值 company。
const TASK_STREAMS = [...STREAMS, 'company'];
const TASK_DEFAULT_STREAM = 'company';
const TASK_PRIORITIES = [0, 1, 2];

// ---- 基础工具 ---------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, CF-Access-Jwt-Assertion',
  };
}

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, data, request_id: crypto.randomUUID() }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

function jsonError(status, code, message, details = {}) {
  return new Response(JSON.stringify({
    ok: false,
    error: { code, message, details: details || {} },
    request_id: crypto.randomUUID(),
  }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

// 解析 JSON 请求体；非法 JSON 抛带 httpStatus 的标记错误，由顶层统一转 400
async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > MAX_BODY_BYTES) {
    const err = new Error('请求体超过 1MB 上限');
    err.httpStatus = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('请求体不是合法 JSON');
    err.httpStatus = 400;
    err.code = 'INVALID_JSON';
    throw err;
  }
}

// JSON 数组字段读写（tags / supersedes / superseded_by 以 TEXT JSON 存储）
function parseJsonArray(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function stringifyJsonArray(arr) {
  return JSON.stringify(Array.isArray(arr) ? arr : []);
}

// LIKE 通配符转义：值一律走占位符绑定，禁止字符串拼接 SQL（验收硬标准）
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

function toInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// 归一化 tags：去重 + 只留非空字符串；非法输入 → []
function normTags(tags) {
  return Array.isArray(tags)
    ? [...new Set(tags.filter((t) => typeof t === 'string' && t.trim().length > 0))]
    : [];
}

// ---- 信任分（设计 §4 v1.3） --------------------------------------------------

// 初始信任分：谁提出的决定起点（ripple 先天带信任 score=2；sagitta 默认无信任 score=0，
// 必须靠认可爬升——AI 自想默认不可信，这是"涟漪想法先天带信任"的落点）。
function initialScoreByOrigin(origin) {
  return origin === 'ripple' ? 2 : 0;
}

// 初始状态档：与信任分映射保持一致（score≥2 → corroborated；score≥1 → digested；否则 captured）。
// 使"创建即状态与信任自洽"，与 ack 自动联动的分档规则（设计 §4 v1.3 §B）同一把尺子。
function initialStatusByScore(score) {
  if (score >= 2) return 'corroborated';
  if (score >= 1) return 'digested';
  return 'captured';
}

// 信任分级与提示文案（设计 §4 v1.3 §E，服务端按 score 生成）：
//   score 0~1 → 低信任：该经验尚未经过多次强化，不一定可信
//   score 2   → 中信任：无提示
//   score 3   → 高信任（固化档）：该经验已固化，若不与当前场景冲突，建议遵循
function trustFields(score) {
  const s = toInt(score, 0, SCORE_MIN, SCORE_MAX);
  if (s >= 3) return { trust_level: 'high', trust_hint: '该经验已固化，若不与当前场景冲突，建议遵循' };
  if (s >= 2) return { trust_level: 'medium' };
  return { trust_level: 'low', trust_hint: '该经验尚未经过多次强化，不一定可信' };
}

// 响应中把 JSON 数组字段还原成数组（接口层形态）+ 注入信任分字段（设计 §4 v1.3 §E）
function serializeEntry(row) {
  if (!row) return null;
  return Object.assign({}, row, {
    tags: parseJsonArray(row.tags),
    supersedes: parseJsonArray(row.supersedes),
    superseded_by: parseJsonArray(row.superseded_by),
    ...trustFields(row.score),
  });
}

// 加载一批条目的 validated 事件（设计 §4 v1.3 §C：召回时条目带相应事件信息，
// 事件 explanation 可作解释性 few-shot）。replaced/archived 事件为审计留痕，
// 不参与召回（涟漪拍板：留痕不参与 recall）。
async function loadValidatedEvents(db, ids) {
  if (!ids || ids.length === 0) return {};
  // 占位符数量由数据派生、取值全部走绑定（动态片段选择 ≠ 值拼接，验收硬标准）
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare(
    "SELECT id, entry_id, event_type, explanation, blind_spot, linked_delegation_id, created FROM validation_events " +
    "WHERE entry_id IN (" + placeholders + ") AND event_type = 'validated' ORDER BY created DESC"
  ).bind(...ids).all();
  const byEntry = {};
  for (const r of rows.results || []) {
    (byEntry[r.entry_id] = byEntry[r.entry_id] || []).push(r);
  }
  return byEntry;
}

// list/search 用：序列化 + 附带 validated 事件
async function decorateEntries(db, rows) {
  const items = (rows.results || []).map(serializeEntry);
  const events = await loadValidatedEvents(db, items.map((i) => i.id));
  for (const it of items) it.validation_events = events[it.id] || [];
  return items;
}

// ---- 认证 -------------------------------------------------------------------

// Cloudflare Access 已在网关层校验 JWT（CF-Access-Jwt-Assertion 头存在即放行），
// 代码层仅做 Bearer 兜底；AUTH_TOKEN 未配置时拒绝服务（503，部署验收可发现）。
// task 的 manager Bearer 读写分流复用同一头：若部署环境提供可选的
// D1_READ_TOKEN / D1_WRITE_TOKEN，则按操作分别校验；未提供时回退现有 AUTH_TOKEN，
// 保持当前 /mem 与旧部署的认证行为不变。
function checkAuth(request, env, operation) {
  if (request.headers.get('CF-Access-Jwt-Assertion')) return null;
  const operationToken = operation === 'read'
    ? env.D1_READ_TOKEN
    : operation === 'write'
      ? env.D1_WRITE_TOKEN
      : null;
  const expectedToken = operationToken || env.AUTH_TOKEN;
  if (!expectedToken) {
    const tokenName = operation === 'read' ? 'D1_READ_TOKEN' : operation === 'write' ? 'D1_WRITE_TOKEN' : 'AUTH_TOKEN';
    return jsonError(503, 'NOT_CONFIGURED',
      tokenName + ' 未配置：拒绝启动请求。请在 Dashboard → Settings → Variables and Secrets 设置认证 Secret（生成命令见 README.md）。');
  }
  const auth = request.headers.get('Authorization') || '';
  if (auth === 'Bearer ' + expectedToken) return null;
  const oppositeToken = operation === 'read' ? env.D1_WRITE_TOKEN : operation === 'write' ? env.D1_READ_TOKEN : null;
  if (oppositeToken && auth === 'Bearer ' + oppositeToken) {
    return jsonError(403, 'FORBIDDEN', '凭据有效但没有该 task 路由所需的 ' + operation + ' 权限');
  }
  const tokenHint = operation === 'read' ? 'D1_READ_TOKEN' : operation === 'write' ? 'D1_WRITE_TOKEN' : 'AUTH_TOKEN';
  return jsonError(401, 'UNAUTHORIZED',
    '认证失败：需要 Authorization: Bearer <' + tokenHint + '>（或由 Cloudflare Access 网关放行）。');
}

// ---- 端点处理器 -------------------------------------------------------------

// GET /mem/health —— 不要求认证，用于部署验收
function healthHandler(env) {
  return new Response(JSON.stringify({
    ok: true,
    version: VERSION,
    ts: nowIso(),
    env: { db: !!env.DB, auth_token: !!env.AUTH_TOKEN }, // 布尔诊断，不泄密钥
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

// POST /mem/{stream} —— 创建条目
// 管理字段（id/created/updated/status/score/archived_at）由服务端填写，AI 无权编造。
// v1.3 初始信任规则（设计 §4 v1.3 §A）：
//   · origin='ripple'（涟漪提出的）→ score=2 = 先天带信任 → 初始 status=corroborated
//   · origin='sagitta'（AI 自想的，缺省）→ score=0 = 默认无信任 → 初始 status=captured
//   · 若调用方携带历史认可计数（真实迁移场景），score 按计数派生：2*explicit + unobjected
//     − 3*oppose，钳制 0~3（平时只记数量、score 自动联动——创建时同样派生，不手工填）
async function createEntryHandler(db, stream, body) {
  if (!STREAMS.includes(stream)) {
    return jsonError(400, 'INVALID_STREAM', 'stream 必须是四流之一：' + STREAMS.join(' / ') + '（设计 §7）');
  }
  const type = body.type;
  if (!TYPES.includes(type)) {
    return jsonError(400, 'INVALID_TYPE', 'type 必须是：' + TYPES.join(' / ') + '（设计 §3）');
  }
  if (!isNonEmptyString(body.content)) {
    return jsonError(400, 'CONTENT_REQUIRED', 'content（自由正文）必填');
  }
  const origin = body.origin || 'sagitta'; // 缺省 AI 自想 → 无信任起步（防自抬信任）
  if (!ORIGINS.includes(origin)) {
    return jsonError(400, 'INVALID_ORIGIN', 'origin 仅限 ' + ORIGINS.join(' | ') + '（设计 §3 v1.3：谁提出的）');
  }
  const tags = normTags(body.tags);
  const evidence = body.evidence || 'plausible';
  if (!EVIDENCE_STATES.includes(evidence)) {
    return jsonError(400, 'INVALID_EVIDENCE', 'evidence 必须是：' + EVIDENCE_STATES.join(' / ') + '（设计 §3）');
  }
  // 可选初始 ack 计数（调用方已有真实历史认可时给定；后续以 /mem/ack 累计；
  // 计数是事实，score 由计数派生或按 origin 起点——调用方无权直接填 score）
  const ackProps = ['ack_count', 'explicit_ack_count', 'unobjected_ack_count', 'oppose_count', 'cross_session_count'];
  const ackVals = {};
  for (const p of ackProps) {
    const v = body[p];
    if (v !== undefined && v !== null) {
      if (!Number.isInteger(v) || v < 0) {
        return jsonError(400, 'INVALID_ACK', '字段 ' + p + ' 必须是非负整数');
      }
      ackVals[p] = v;
    } else {
      ackVals[p] = 0;
    }
  }
  // score 派生：有任一历史计数 → 按公式派生；否则按 origin 起点
  const hasCounts = ackVals.ack_count > 0 || ackVals.explicit_ack_count > 0 ||
    ackVals.unobjected_ack_count > 0 || ackVals.oppose_count > 0;
  let score;
  if (hasCounts) {
    score = Math.min(SCORE_MAX, Math.max(SCORE_MIN,
      2 * ackVals.explicit_ack_count + ackVals.unobjected_ack_count - 3 * ackVals.oppose_count));
  } else {
    score = initialScoreByOrigin(origin);
  }
  // 初始状态档与信任分同一把尺子（计数派生同样按分档）——正常由 ack 自动联动，创建期直接落地
  const status = initialStatusByScore(score);
  const domain = typeof body.domain === 'string' ? body.domain : null;
  const condition = typeof body.condition === 'string' ? body.condition : null;
  const source = typeof body.source === 'string' ? body.source : null;
  const sourceTaskId = typeof body.source_task_id === 'string' ? body.source_task_id : null;
  const pinned = body.pinned === true ? 1 : 0;
  const tier = typeof body.tier === 'string' ? body.tier : null;
  const ttl = body.ttl !== undefined && body.ttl !== null ? toInt(body.ttl, null, 1, 2147483647) : null;

  const id = crypto.randomUUID();
  const now = nowIso();

  // 取代链（设计 §4 触发时机②：写入新经验时同 domain 检查 supersede 链）：
  // 请求带 supersedes 时，被取代条目标记 superseded，并在其 superseded_by 中挂上本条目。
  const supersedes = Array.isArray(body.supersedes)
    ? [...new Set(body.supersedes.filter((x) => typeof x === 'string' && x.length > 0))]
    : [];

  const statements = [];
  statements.push(
    db.prepare(
      'INSERT INTO entries (id, stream, type, status, domain, tags, content, supersedes, superseded_by, condition, evidence, origin, score, ack_count, explicit_ack_count, unobjected_ack_count, oppose_count, cross_session_count, source_task_id, pinned, created, updated, tier, ttl, last_access, archived_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      id, stream, type, status, domain, stringifyJsonArray(tags), body.content,
      stringifyJsonArray(supersedes), '[]', condition, evidence,
      origin, score,
      ackVals.ack_count, ackVals.explicit_ack_count, ackVals.unobjected_ack_count, ackVals.oppose_count, ackVals.cross_session_count,
      sourceTaskId, pinned, now, now, tier, ttl, null, null
    )
  );
  for (const oldId of supersedes) {
    const old = await db.prepare('SELECT id, superseded_by FROM entries WHERE id = ?').bind(oldId).first();
    if (!old) {
      return jsonError(400, 'SUPERSEDE_NOT_FOUND', 'supersedes 引用了不存在的条目 id: ' + oldId);
    }
    const list = parseJsonArray(old.superseded_by);
    if (!list.includes(id)) list.push(id);
    statements.push(
      db.prepare('UPDATE entries SET status = ?, superseded_by = ?, updated = ? WHERE id = ?')
        .bind('superseded', stringifyJsonArray(list), now, oldId)
    );
  }

  // INSERT + supersede 回写同一批原子执行
  await db.batch(statements);

  const entry = {
    id, stream, type, status, domain, tags,
    content: body.content, supersedes, superseded_by: [],
    condition, evidence, origin, score,
    ack_count: ackVals.ack_count, explicit_ack_count: ackVals.explicit_ack_count,
    unobjected_ack_count: ackVals.unobjected_ack_count, oppose_count: ackVals.oppose_count,
    cross_session_count: ackVals.cross_session_count,
    source_task_id: sourceTaskId, pinned, created: now, updated: now, tier, ttl,
    last_access: null, archived_at: null,
    ...trustFields(score),
  };
  return jsonOk(entry, 201);
}

// GET /mem/{stream} —— 列表（page/size/type/domain/status 过滤）
// v1.3：默认排除 archived 与 superseded（设计 §4 v1.3 §D：recall 不作为经验召回终态条目），
// 除非显式 status 过滤请求它们（显式查看）。
async function listEntriesHandler(db, stream, url) {
  if (!STREAMS.includes(stream)) {
    return jsonError(400, 'INVALID_STREAM', 'stream 必须是四流之一：' + STREAMS.join(' / ') + '（设计 §7）');
  }
  const page = toInt(url.searchParams.get('page'), 1, 1, 100000);
  const size = toInt(url.searchParams.get('size'), 20, 1, 100);
  const type = url.searchParams.get('type');
  const domain = url.searchParams.get('domain');
  const status = url.searchParams.get('status');
  if (type && !TYPES.includes(type)) return jsonError(400, 'INVALID_TYPE', 'type 过滤值非法（设计 §3）');
  if (status && !STATUSES.includes(status)) return jsonError(400, 'INVALID_STATUS', 'status 过滤值非法（设计 §4）');

  // WHERE 片段按需拼接，但所有取值一律走 ? 占位符（动态片段选择 ≠ 值拼接）
  const where = ['stream = ?'];
  const params = [stream];
  if (type) { where.push('type = ?'); params.push(type); }
  // domain 是层级路径（设计 §6 目录树钻取），用前缀匹配逐级展开
  if (domain) { where.push("domain LIKE ? ESCAPE '\\'"); params.push(escapeLike(domain) + '%'); }
  if (status) { where.push('status = ?'); params.push(status); }
  else { where.push("status NOT IN (?, ?)"); params.push('archived', 'superseded'); }
  const whereSql = where.join(' AND ');

  const countRow = await db.prepare('SELECT COUNT(*) AS total FROM entries WHERE ' + whereSql).bind(...params).first();
  const total = countRow ? countRow.total : 0;

  const rows = await db.prepare(
    'SELECT * FROM entries WHERE ' + whereSql + ' ORDER BY created DESC LIMIT ? OFFSET ?'
  ).bind(...params, size, (page - 1) * size).all();

  return jsonOk({
    stream,
    items: await decorateEntries(db, rows),
    page, size, total,
  });
}

// GET /mem/{stream}/{id} —— 单条
async function getEntryHandler(db, stream, id) {
  if (!STREAMS.includes(stream)) {
    return jsonError(400, 'INVALID_STREAM', 'stream 必须是四流之一：' + STREAMS.join(' / ') + '（设计 §7）');
  }
  const row = await db.prepare('SELECT * FROM entries WHERE id = ? AND stream = ?').bind(id, stream).first();
  if (!row) return jsonError(404, 'ENTRY_NOT_FOUND', '条目不存在：' + id + '（stream=' + stream + '）');
  // 命中即更新 last_access（治理字段）；辅助更新失败不惩罚读取，仅记录
  try {
    await db.prepare('UPDATE entries SET last_access = ? WHERE id = ?').bind(nowIso(), id).run();
  } catch (e) {
    console.error('[sagitta-memory] last_access 更新失败（不影响本次读取）:', e);
  }
  const entry = serializeEntry(row);
  entry.validation_events = (await loadValidatedEvents(db, [row.id]))[row.id] || [];
  return jsonOk(entry);
}

// POST /mem/search —— 检索
// v1 明令禁 embedding（设计 §6 ③ + design-review.md P2："明确禁止上 embedding"）：
// 全文/条件/标签/域 一律用 LIKE 关键词匹配，不做向量化。
// v1.3：默认排除 archived 与 superseded（除非显式 status 过滤请求它们，设计 §4 v1.3 §D）。
async function searchHandler(db, body) {
  if (!isNonEmptyString(body.query)) {
    return jsonError(400, 'QUERY_REQUIRED', 'query 必填（v1 关键词检索，无 embedding，设计 §6 ③）');
  }
  const stream = body.stream;
  const type = body.type;
  const domain = body.domain;
  const status = body.status;
  const tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string' && t.length > 0) : [];
  const page = toInt(body.page, 1, 1, 100000);
  const size = toInt(body.size, 20, 1, 100);
  if (stream && !STREAMS.includes(stream)) return jsonError(400, 'INVALID_STREAM', 'stream 过滤值非法（设计 §7）');
  if (type && !TYPES.includes(type)) return jsonError(400, 'INVALID_TYPE', 'type 过滤值非法（设计 §3）');
  if (status && !STATUSES.includes(status)) return jsonError(400, 'INVALID_STATUS', 'status 过滤值非法（设计 §4）');

  // 关键词命中面：正文 / 适用条件 / 标签 / 域路径 / id（五路 OR）
  const pattern = '%' + escapeLike(body.query) + '%';
  const clause = "(content LIKE ? ESCAPE '\\' OR condition LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
  const where = [clause];
  const params = [pattern, pattern, pattern, pattern, pattern];
  if (stream) { where.push('stream = ?'); params.push(stream); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (domain) { where.push("domain LIKE ? ESCAPE '\\'"); params.push(escapeLike(domain) + '%'); }
  if (status) { where.push('status = ?'); params.push(status); }
  else { where.push("status NOT IN (?, ?)"); params.push('archived', 'superseded'); }
  // tags 过滤：JSON 数组中精确出现（用带引号的完整标签串匹配）
  for (const tag of tags) {
    where.push("tags LIKE ? ESCAPE '\\'");
    params.push('%' + escapeLike(JSON.stringify(tag)) + '%');
  }
  const whereSql = where.join(' AND ');

  const countRow = await db.prepare('SELECT COUNT(*) AS total FROM entries WHERE ' + whereSql).bind(...params).first();
  const total = countRow ? countRow.total : 0;

  const rows = await db.prepare(
    'SELECT * FROM entries WHERE ' + whereSql + ' ORDER BY created DESC LIMIT ? OFFSET ?'
  ).bind(...params, size, (page - 1) * size).all();

  return jsonOk({
    query: body.query,
    stream, type, domain, status, tags,
    items: await decorateEntries(db, rows),
    total,
  });
}

// POST /mem/consolidate —— 治理动作（设计 §4 v1.3）
// v1.2 → v1.3：状态升级不再是 consolidate 的职责——ack 提交时已自动联动（score≥1 →
// digested；score≥2 → corroborated）。consolidate 降级为治理入口：批量复核、
// 写入验证事件、执行 replace/归档。
// 动作：
//   digest      兜底：captured + score≥1 → digested（正常已由 ack 自动完成；供存量数据/复核用）
//   corroborate 兜底：captured/digested + score≥2 → corroborated（v1.3 不再要求 cross_session 声明，
//                 ——corroborated 由 score 驱动；cross_session_count 为 v1.2 历史字段，不再由本动作递增）
//   validate    事件化验证：写 validation_events（event_type='validated'）⇒ 条目 validated 事实；
//                条目 status='validated'、score=3（固化档）、evidence='verified'；
//                blind_spot **必填**（该经验未涉及的盲点；缺失 → 整体 422 BLIND_SPOT_REQUIRED）；
//                explanation 可作召回时的解释性 few-shot；linked_delegation_id 可空关联验证结果
//   replace     整体更换（涟漪拍板："给一个更换的指令更新，更换会把所有描述更换掉，更新后分数按新 origin 重置"）：
//                content/condition/tags 全换；origin='ripple' → score=2（status=corroborated）、
//                'sagitta' → score=0（status=captured）；旧版内容写入 validation_events
//                （event_type='replaced'，old_content 审计留痕——不参与 recall）；
//                可对 archived 条目改写（软归档条目若值得写相反经验 → 用 replace 改写，origin 通常 ripple）
//   archive     治理归档：status='archived'、archived_at=now、写 archived 事件留痕；
//                pinned 条目拒绝归档（设计 §5：治理永不归档——pinned 只允许涟漪设置）
// 失败语义：任一条目校验失败 → 整体 422 拒绝，不写任何状态（fail-loud，全有或全无）。
async function consolidateHandler(db, body) {
  // 支持两种形态：
  //   精确：{ items: [{ id, action, blind_spot?, explanation?, linked_delegation_id?,
  //                    origin?, content?, condition?, tags? }], supersedes?, superseding_id? }
  //   简写：{ ids: [...], action?, blind_spot?, explanation?, linked_delegation_id?,
  //           origin?, content?, condition?, tags?, supersedes?, superseding_id? }
  const items = Array.isArray(body.items)
    ? body.items
    : (Array.isArray(body.ids)
        ? body.ids.map((id) => ({
            id,
            action: body.action,
            blind_spot: body.blind_spot,
            explanation: body.explanation,
            linked_delegation_id: body.linked_delegation_id,
            origin: body.origin,
            content: body.content,
            condition: body.condition,
            tags: body.tags,
          }))
        : null);
  if (!items || items.length === 0) {
    return jsonError(400, 'ITEMS_REQUIRED', 'consolidate 需要 items（或 ids）列表');
  }
  if (items.length > 100) return jsonError(400, 'TOO_MANY_ITEMS', '单次 consolidate 最多 100 条');

  // 去重
  const seen = new Set();
  const uniqueItems = items.filter((it) => {
    if (!it || typeof it.id !== 'string' || seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });

  const supersedes = Array.isArray(body.supersedes)
    ? [...new Set(body.supersedes.filter((x) => typeof x === 'string' && x.length > 0))]
    : [];
  // supersede 链的目标参考：优先显式 superseding_id，否则用首个被推进条目的 id
  const supersedingId = (typeof body.superseding_id === 'string' && body.superseding_id)
    ? body.superseding_id
    : (uniqueItems.length > 0 ? uniqueItems[0].id : null);

  const now = nowIso();
  const results = [];
  const statements = [];
  const errors = [];

  for (const item of uniqueItems) {
    const id = item.id;
    const action = item.action || 'digest';
    if (!CONSOLIDATE_ACTIONS.includes(action)) {
      errors.push({ id, action, reason: 'invalid_action', message: 'action 仅限 ' + CONSOLIDATE_ACTIONS.join('|') + '（v1.3 治理动作集）' });
      continue;
    }
    const row = await db.prepare(
      'SELECT id, status, score, content, pinned, archived_at FROM entries WHERE id = ?'
    ).bind(id).first();
    if (!row) {
      errors.push({ id, action, reason: 'not_found', message: '条目不存在' });
      continue;
    }
    const from = row.status;

    if (action === 'digest') {
      if (from === 'digested' || from === 'corroborated' || from === 'validated') {
        results.push({ id, action, from, to: from, changed: false }); // 幂等：已在目标或更高
        continue;
      }
      if (from === 'superseded' || from === 'archived') {
        errors.push({ id, action, reason: 'terminal_state', message: '条目处于 ' + from + ' 终态，不可再转移' });
        continue;
      }
      // v1.3：digested = 已归纳 + score ≥ 1（分数驱动；由 ack 自动联动，此处为兜底）
      if (from !== 'captured') {
        errors.push({ id, action, reason: 'invalid_transition', message: 'captured→digested 之外的转移不被支持（当前 status=' + from + '）' });
        continue;
      }
      if (toInt(row.score, 0, SCORE_MIN, SCORE_MAX) < 1) {
        errors.push({ id, action, reason: 'score_required', message: 'captured→digested 需 score ≥ 1（设计 §4 v1.3：分数驱动；一句随口话默认停在 captured，需认可爬升）' });
        continue;
      }
      statements.push(
        db.prepare('UPDATE entries SET status = ?, updated = ? WHERE id = ?').bind('digested', now, id)
      );
      results.push({ id, action, from, to: 'digested', changed: true });
    } else if (action === 'corroborate') {
      if (from === 'corroborated' || from === 'validated') {
        results.push({ id, action, from, to: from, changed: false });
        continue;
      }
      if (from === 'superseded' || from === 'archived') {
        errors.push({ id, action, reason: 'terminal_state', message: '条目处于 ' + from + ' 终态，不可再转移' });
        continue;
      }
      if (from !== 'captured' && from !== 'digested') {
        errors.push({ id, action, reason: 'invalid_transition', message: 'corroborate 仅可从 captured/digested 进入（当前 status=' + from + '）' });
        continue;
      }
      // v1.3：→corroborated 需 score ≥ 2（分数驱动；v1.2 的 cross_session 声明门槛随
      // 分数驱动机制移除——score 是信任值，到达 2 即 corroborated）
      if (toInt(row.score, 0, SCORE_MIN, SCORE_MAX) < 2) {
        errors.push({ id, action, reason: 'score_required', message: '→corroborated 需 score ≥ 2（设计 §4 v1.3 分数驱动）' });
        continue;
      }
      statements.push(
        db.prepare('UPDATE entries SET status = ?, updated = ? WHERE id = ?').bind('corroborated', now, id)
      );
      results.push({ id, action, from, to: 'corroborated', changed: true });
    } else if (action === 'validate') {
      if (from === 'validated') {
        results.push({ id, action, from, to: from, changed: false }); // 防事件刷屏：已 validated 幂等
        continue;
      }
      if (from === 'superseded' || from === 'archived') {
        errors.push({ id, action, reason: 'terminal_state', message: '条目处于 ' + from + ' 终态，不可再转移' });
        continue;
      }
      // 设计 §4 v1.3 §C：validated 事件化——blind_spot 必填（必须补充该经验未涉及的盲点）
      if (!isNonEmptyString(item.blind_spot)) {
        errors.push({
          id, action, reason: 'blind_spot_required',
          message: 'validate 必须携带 blind_spot（该经验未涉及的盲点；设计 §4 v1.3 §C：' +
            '缺 blind_spot 拒绝 422——validation 事件必须同时补充盲点，否则不算完整验证）。',
        });
        continue;
      }
      const eventId = crypto.randomUUID();
      statements.push(
        db.prepare(
          'INSERT INTO validation_events (id, entry_id, event_type, explanation, old_content, blind_spot, linked_delegation_id, created) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          eventId, id, 'validated',
          typeof item.explanation === 'string' ? item.explanation : null,
          null,
          item.blind_spot,
          typeof item.linked_delegation_id === 'string' ? item.linked_delegation_id : null,
          now
        ),
        // 写入 validated 事件 = validated 事实；score=3 固化信任档（设计 §4 v1.3 §C）
        db.prepare('UPDATE entries SET status = ?, score = ?, evidence = ?, updated = ? WHERE id = ?')
          .bind('validated', SCORE_MAX, 'verified', now, id)
      );
      results.push({ id, action, from, to: 'validated', changed: true, event_id: eventId });
    } else if (action === 'replace') {
      // 设计 §4 v1.3 §D：整体更换——对任意状态（含 archived/superseded）都允许：
      // 改写即复活（archived_at 清空）。旧内容审计留痕，不参与 recall。
      if (!ORIGINS.includes(item.origin)) {
        errors.push({ id, action, reason: 'origin_required', message: 'replace 必须携带 origin（' + ORIGINS.join('|') + '）：更换后信任按新 origin 重置（设计 §4 v1.3 §A/§D）' });
        continue;
      }
      if (!isNonEmptyString(item.content)) {
        errors.push({ id, action, reason: 'content_required', message: 'replace 必须携带 content（整体替换描述，设计 §4 v1.3 §D）' });
        continue;
      }
      const newScore = initialScoreByOrigin(item.origin);
      const newStatus = initialStatusByScore(newScore);
      const newTags = normTags(item.tags);
      const oldContent = row.content || '';
      const eventId = crypto.randomUUID();
      statements.push(
        db.prepare(
          'INSERT INTO validation_events (id, entry_id, event_type, explanation, old_content, blind_spot, linked_delegation_id, created) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          eventId, id, 'replaced',
          typeof item.explanation === 'string' ? item.explanation : null,
          oldContent,
          null, // replaced 为审计事件：盲点不要求（replace 签名不带 blind_spot，涟漪未拍板强制）
          null,
          now
        ),
        db.prepare(
          'UPDATE entries SET content = ?, condition = ?, tags = ?, origin = ?, score = ?, status = ?, archived_at = ?, updated = ? WHERE id = ?'
        ).bind(
          item.content,
          typeof item.condition === 'string' ? item.condition : null,
          stringifyJsonArray(newTags),
          item.origin, newScore, newStatus,
          null, // 复活：清空归档时间
          now, id
        )
      );
      results.push({ id, action, from, to: newStatus, changed: true, score: newScore, event_id: eventId, old_content: oldContent });
    } else { // archive
      if (from === 'archived') {
        results.push({ id, action, from, to: from, changed: false });
        continue;
      }
      if (from === 'superseded') {
        errors.push({ id, action, reason: 'terminal_state', message: '条目处于 superseded 终态（被取代链接管），请用 replace 改写或归档其取代者' });
        continue;
      }
      // 设计 §5：pinned 治理永不归档（pinned 只允许涟漪设置，自动/治理机制不得推翻）
      if (row.pinned === 1) {
        errors.push({ id, action, reason: 'pinned_archive_forbidden', message: '条目 pinned（涟漪要求"永远记住"），拒绝归档（设计 §5：pinned 治理永不归档）' });
        continue;
      }
      const eventId = crypto.randomUUID();
      statements.push(
        db.prepare(
          'INSERT INTO validation_events (id, entry_id, event_type, explanation, old_content, blind_spot, linked_delegation_id, created) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          eventId, id, 'archived',
          typeof item.explanation === 'string' ? item.explanation : null,
          row.content || '',
          typeof item.blind_spot === 'string' ? item.blind_spot : null, // 审计事件：盲点可选
          null,
          now
        ),
        db.prepare('UPDATE entries SET status = ?, archived_at = ?, updated = ? WHERE id = ?')
          .bind('archived', now, now, id)
      );
      results.push({ id, action, from, to: 'archived', changed: true, event_id: eventId });
    }
  }

  // supersede 处理（请求级字段）：被取代条目 → status=superseded，superseded_by 挂 supersedingId
  for (const oldId of supersedes) {
    const old = await db.prepare('SELECT id, superseded_by FROM entries WHERE id = ?').bind(oldId).first();
    if (!old) {
      errors.push({ id: oldId, action: 'supersede', reason: 'not_found', message: 'supersedes 引用了不存在的条目' });
      continue;
    }
    const list = parseJsonArray(old.superseded_by);
    if (supersedingId && !list.includes(supersedingId)) list.push(supersedingId);
    statements.push(
      db.prepare('UPDATE entries SET status = ?, superseded_by = ?, updated = ? WHERE id = ?')
        .bind('superseded', stringifyJsonArray(list), now, oldId)
    );
  }

  // 全有或全无：任一校验失败即整体拒绝，不写任何状态（fail-loud）
  if (errors.length > 0) {
    return jsonError(422, 'CONSOLIDATE_REJECTED',
      'consolidate 校验失败，整体未写入（设计 §4 v1.3 治理动作门槛）：' +
        errors.map((e) => e.id + '[' + (e.action || 'supersede') + '] ' + (e.message || e.reason)).join('; '),
      );
  }

  if (statements.length > 0) {
    await db.batch(statements); // 原子执行
  }
  return jsonOk({ results, superseded: supersedes, superseding_id: supersedingId });
}

// POST /mem/ack —— 信任信号登记（设计 §4 v1.3 三态信任轨道）
// explicit   涟漪明确开口认可（"对""记住""是原则"）→ 强信号 +2
// unobjected 我主动陈述过该立场、涟漪在场未反对 → 弱信号 +1
//            （防后门门禁保留：必须携带 statement_source——本会话中我主动陈述过该立场的
//              会话事件引用；API 校验存在性，"涟漪在场、空缺≠默许"的事实性由调用方
//              （Sagitta）负责任——AI 无权虚构"我陈述过"，design-review-v2.md 三、②）
// oppose     涟漪明确反对（"不对""这条错了"）→ 强负信号 −3（v1.3 新增）
// 分数联动（服务端唯一计分点）：
//   · score = clamp(score + delta, 0, 3)；score<0 → 软归档（status=archived、score=0、
//     archived_at=now；涟漪拍板：软归档而非硬删，条目不可正常检索、不作为经验）
//   · pinned 条目永不自动归档（反对信号把分数压到 0 为止；设计 §5：pinned 治理永不归档）
//   · 状态自动联动（设计 §4 v1.3 §B）：score≥1 → digested；score≥2 → corroborated；
//     validated 由事件承载，不被反对降级（反对只降分数——信任值，不抹事件事实）
async function ackHandler(db, body) {
  const id = body.id;
  if (!isNonEmptyString(id)) return jsonError(400, 'ID_REQUIRED', 'id 必填');
  const signal = body.signal;
  if (!ACK_SIGNALS.includes(signal)) {
    return jsonError(400, 'INVALID_SIGNAL',
      'signal 仅限 explicit（涟漪明确开口，+2）| unobjected（我陈述后涟漪未反对，+1）| ' +
      'oppose（涟漪明确反对，−3），设计 §4 v1.3 信任轨道');
  }
  if (signal === 'unobjected' && !isNonEmptyString(body.statement_source)) {
    return jsonError(422, 'STATEMENT_SOURCE_REQUIRED',
      'unobjected 必须携带 statement_source：本会话中我主动陈述过该立场的会话事件引用（设计 §4 认可轨道前提：' +
      '必须存在我主动陈述的会话事件，AI 无权虚构"我陈述过"；空缺 ≠ 默许）。');
  }

  const row = await db.prepare(
    'SELECT id, status, score, pinned, archived_at FROM entries WHERE id = ?'
  ).bind(id).first();
  if (!row) return jsonError(404, 'ENTRY_NOT_FOUND', '条目不存在：' + id);
  if (row.status === 'superseded' || row.status === 'archived') {
    return jsonError(409, 'ENTRY_TERMINAL',
      '条目处于 ' + row.status + ' 终态，不再累计信任信号（如需改写请用 consolidate replace 治理动作）。');
  }

  const delta = SIGNAL_DELTAS[signal];
  const current = toInt(row.score, 0, SCORE_MIN, SCORE_MAX);
  const raw = current + delta;

  // 分数钳制：0~3；少于此区间下限（score<0）→ 软归档（涟漪拍板）
  let newScore = Math.min(SCORE_MAX, Math.max(SCORE_MIN, raw));
  let archived = false;
  if (delta < 0 && raw < 0) {
    if (row.pinned === 1) {
      // pinned 永不自动归档：分数压到 0（自动机制不得推翻涟漪的"永远记住"）
      newScore = SCORE_MIN;
    } else {
      newScore = SCORE_MIN;
      archived = true;
    }
  }

  // 状态自动联动（只升不降；validated 事件事实不被反对抹除）
  let newStatus = row.status;
  if (archived) {
    newStatus = 'archived';
  } else if (newScore >= 2 && (newStatus === 'captured' || newStatus === 'digested')) {
    newStatus = 'corroborated';
  } else if (newScore >= 1 && newStatus === 'captured') {
    newStatus = 'digested';
  }

  const inc = { explicit: 0, unobjected: 0, oppose: 0 };
  inc[signal] = 1;

  // 事实计数（v1.3 保留）：ack_count 继续累积正向认可（explicit +2 / unobjected +1，
  // 与 v1.2 一致）；oppose_count 单独计数负信号；score 为派生信任值，由本处自动联动
  await db.prepare(
    'UPDATE entries SET score = ?, status = ?, ack_count = ack_count + ?, explicit_ack_count = explicit_ack_count + ?, unobjected_ack_count = unobjected_ack_count + ?, oppose_count = oppose_count + ?, archived_at = ?, updated = ? WHERE id = ?'
  ).bind(
    newScore, newStatus,
    delta > 0 ? delta : 0,
    inc.explicit, inc.unobjected, inc.oppose,
    archived ? nowIso() : null,
    nowIso(), id
  ).run();

  const updated = await db.prepare(
    'SELECT score, status, ack_count, explicit_ack_count, unobjected_ack_count, oppose_count, archived_at FROM entries WHERE id = ?'
  ).bind(id).first();
  return jsonOk({
    id, signal,
    score: updated.score,
    status: updated.status,
    archived: updated.status === 'archived',
    ack_count: updated.ack_count,
    explicit_ack_count: updated.explicit_ack_count,
    unobjected_ack_count: updated.unobjected_ack_count,
    oppose_count: updated.oppose_count,
    archived_at: updated.archived_at,
  });
}

// POST /mem/delegations —— 写 delegation（设计 §3 type=delegation schema，design-review.md P0-1）
// delegatee=ripple 仅用于"涟漪明确背书"记录：必须由涟漪实际输入触发，AI 无权代填
// （design-review-v2.md 三、②——补上这条，AI 自写"涟漪已背书"就是换皮的自我背书）。
async function createDelegationHandler(db, body) {
  if (!isNonEmptyString(body.task_id)) return jsonError(400, 'TASK_ID_REQUIRED', 'task_id 必填（如 dlg-20260817-gotest）');
  if (!DELEGATEES.includes(body.delegatee)) {
    return jsonError(400, 'INVALID_DELEGATEE', 'delegatee 仅限 ' + DELEGATEES.join(' / ') +
      '；其中 ripple 仅用于涟漪明确背书，必须由涟漪实际输入触发，AI 无权代填（design-review-v2.md 三、②）。');
  }
  if (body.verification_result !== undefined && body.verification_result !== null
      && !VERIFICATION_RESULTS.includes(body.verification_result)) {
    return jsonError(422, 'INVALID_VERIFICATION_RESULT', 'verification_result 仅限 ' +
      VERIFICATION_RESULTS.join(' / ') + '（设计 §3）；它在 v1.2 是 validated 证据四选一的机检来源，' +
      'v1.3 起 validated 事件化（可经 linked_delegation_id 关联本记录）。');
  }
  const str = (v) => (typeof v === 'string' ? v : null);
  const now = nowIso();
  await db.prepare(
    'INSERT INTO delegations (task_id, delegatee, model, command, claimed_result, verification_method, verification_result, artifacts, outcome, cost, created) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    body.task_id, body.delegatee, str(body.model), str(body.command), str(body.claimed_result),
    str(body.verification_method), body.verification_result ?? null, str(body.artifacts),
    str(body.outcome), str(body.cost), now
  ).run();
  return jsonOk({
    task_id: body.task_id, delegatee: body.delegatee, model: str(body.model), command: str(body.command),
    claimed_result: str(body.claimed_result), verification_method: str(body.verification_method),
    verification_result: body.verification_result ?? null, artifacts: str(body.artifacts),
    outcome: str(body.outcome), cost: str(body.cost), created: now,
  }, 201);
}

// GET /mem/delegations/{task_id} —— 读 delegation
async function getDelegationHandler(db, taskId) {
  const row = await db.prepare('SELECT * FROM delegations WHERE task_id = ?').bind(taskId).first();
  if (!row) return jsonError(404, 'DELEGATION_NOT_FOUND', 'delegation 记录不存在：' + taskId);
  return jsonOk(row);
}

// ---- task API（docs/task-api-p1.md） ----------------------------------------

// tasks/task_events 自举：先复核列，再只对缺失列执行可空 ALTER。
// D1 的 batch 是原子批次；失败必须抛出，由 task 路由进入不可用态，不能继续服务旧 schema。
const TASK_SCHEMA_COLUMNS = [
  ['id', 'TEXT'], ['project', 'TEXT'], ['title', 'TEXT'], ['status', 'TEXT'],
  ['priority', 'INTEGER'], ['checkbox', 'INTEGER'], ['stream', 'TEXT'], ['body', 'TEXT'],
  ['created_at', 'TEXT'], ['updated_at', 'TEXT'], ['done_at', 'TEXT'], ['archived', 'INTEGER'],
  ['blocked_reason', 'TEXT'], ['pending_status', 'TEXT'],
];
const TASK_EVENT_SCHEMA_COLUMNS = [
  ['event_id', 'TEXT'], ['task_id', 'TEXT'], ['agent_id', 'TEXT'], ['event_type', 'TEXT'],
  ['round_id', 'TEXT'], ['action', 'TEXT'], ['progress', 'TEXT'], ['next', 'TEXT'],
  ['blocked_reason', 'TEXT'], ['pending_status', 'TEXT'], ['confirmation_id', 'TEXT'],
  ['expected_updated_at', 'TEXT'], ['payload_json', 'TEXT'], ['created_at', 'TEXT'],
];
const TASK_SYSTEM_AGENT = 'worker';
const TASK_PENDING_STATUSES = ['pending_done', 'pending_blocked'];
const TASK_TERMINAL_STATUSES = ['done', 'blocked'];
const TASK_PATCH_FIELDS = ['status', 'priority', 'body', 'title', 'checkbox', 'blocked_reason'];
const TASK_CONFIRM_DECISIONS = ['accept', 'reopen'];
const TASK_ROUND_ACTIONS = ['update', 'done', 'blocked'];
const MAX_TASK_EVENT_TEXT = 1000;
const tasksSchemaReady = new WeakMap();

const TASKS_CREATE_DDL = `CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  priority      INTEGER NOT NULL DEFAULT 0,
  checkbox      INTEGER NOT NULL DEFAULT 0,
  stream        TEXT NOT NULL DEFAULT 'company',
  body          TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT '',
  done_at       TEXT DEFAULT '',
  archived      INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT DEFAULT NULL,
  pending_status TEXT DEFAULT NULL,
  CHECK (pending_status IS NULL OR pending_status IN ('pending_done', 'pending_blocked'))
)`;

const TASK_EVENTS_CREATE_DDL = `CREATE TABLE IF NOT EXISTS task_events (
  event_id           TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  round_id          TEXT DEFAULT NULL,
  action            TEXT DEFAULT NULL,
  progress          TEXT DEFAULT NULL,
  next              TEXT DEFAULT NULL,
  blocked_reason    TEXT DEFAULT NULL,
  pending_status    TEXT DEFAULT NULL,
  confirmation_id   TEXT DEFAULT NULL,
  expected_updated_at TEXT DEFAULT NULL,
  payload_json      TEXT NOT NULL,
  created_at        TEXT NOT NULL
)`;

async function d1Batch(db, statements) {
  if (statements.length > 0) await db.batch(statements);
}

async function tableColumns(db, table) {
  const statement = db.prepare('PRAGMA table_info(' + table + ')');
  const result = statement.all ? await statement.all() : await statement.bind().all();
  return new Set((result.results || []).map((row) => row.name));
}

async function ensureColumns(db, table, definitions) {
  const columns = await tableColumns(db, table);
  const missing = definitions
    .filter(([name]) => !columns.has(name))
    // SQLite 不允许 ALTER TABLE ADD COLUMN 加 NOT NULL 无默认值；迁移列统一可空。
    .map(([name, type]) => db.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + type));
  await d1Batch(db, missing);
  const verified = await tableColumns(db, table);
  const stillMissing = definitions.filter(([name]) => !verified.has(name)).map(([name]) => name);
  if (stillMissing.length > 0) {
    throw new Error(table + ' schema migration incomplete; missing columns: ' + stillMissing.join(', '));
  }
}

async function ensureTasksSchema(db) {
  if (tasksSchemaReady.has(db)) return tasksSchemaReady.get(db);
  const ready = (async () => {
    await d1Batch(db, [db.prepare(TASKS_CREATE_DDL)]);
    await ensureColumns(db, 'tasks', TASK_SCHEMA_COLUMNS);
    await d1Batch(db, [
      db.prepare('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_tasks_stream ON tasks(stream)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)'),
      db.prepare(TASK_EVENTS_CREATE_DDL),
    ]);
    await ensureColumns(db, 'task_events', TASK_EVENT_SCHEMA_COLUMNS);
    await d1Batch(db, [
      db.prepare('CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id)'),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_task_events_round_close ON task_events(task_id, agent_id, round_id) WHERE event_type = 'round_close'"),
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS uq_task_events_confirmation ON task_events(confirmation_id) WHERE confirmation_id IS NOT NULL'),
    ]);
    return true;
  })().catch((err) => {
    console.error('[sagitta-memory] tasks schema migration failed:', err && err.message ? err.message : String(err));
    tasksSchemaReady.delete(db);
    throw err;
  });
  tasksSchemaReady.set(db, ready);
  return ready;
}

function isTaskBody(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

function serializeTask(row, extra = {}) {
  if (!row) return null;
  const result = Object.assign({}, row, {
    priority: Number(row.priority),
    checkbox: Number(row.checkbox),
    archived: Number(row.archived),
    blocked_reason: row.blocked_reason === undefined ? null : row.blocked_reason,
    pending_status: row.pending_status === undefined ? null : row.pending_status,
  }, extra);
  return result;
}

function taskId() {
  const day = nowIso().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
  return 'tsk-' + day + '-' + suffix;
}

function taskString(value, field, required = false) {
  if (typeof value !== 'string' || (required && value.trim().length === 0)) {
    return { error: jsonError(400, required ? field.toUpperCase() + '_REQUIRED' : 'INVALID_' + field.toUpperCase(),
      required ? field + ' 必填' : field + ' 必须是字符串') };
  }
  return { value: required ? value.trim() : value };
}

function taskStatus(value) {
  if (!TASK_STATUSES.includes(value)) {
    return jsonError(400, 'INVALID_TASK_STATUS', 'status 必须是：' + TASK_STATUSES.join(' / '));
  }
  return null;
}

function taskExpectedUpdatedAt(value, required = false) {
  if (value === undefined && !required) return null;
  if (!isNonEmptyString(value)) {
    return jsonError(422, 'INVALID_EXPECTED_UPDATED_AT', 'expected_updated_at 必须是非空字符串');
  }
  return value;
}

function taskEventText(value, field, required = true) {
  if (typeof value !== 'string') {
    return jsonError(422, field.toUpperCase() + '_REQUIRED', field + ' 必须是字符串');
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    return jsonError(422, field.toUpperCase() + '_REQUIRED', field + ' 必填');
  }
  if (Array.from(trimmed).length > MAX_TASK_EVENT_TEXT) {
    return jsonError(422, field.toUpperCase() + '_TOO_LONG', field + ' 最多 1000 个 Unicode 字符');
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    return jsonError(422, 'INVALID_' + field.toUpperCase(), field + ' 不得包含控制字符或换行');
  }
  return trimmed;
}

function taskBlockedReason(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return jsonError(422, 'BLOCKED_REASON_REQUIRED', 'blocked_reason 必须是非空字符串');
  }
  return value.trim();
}

function taskStateError(row) {
  if (!row) return null;
  if (row.pending_status !== null && !TASK_PENDING_STATUSES.includes(row.pending_status)) {
    return jsonError(409, 'TASK_STATE_INVALID', '任务 pending_status 不合法', { task: serializeTask(row) });
  }
  if (row.pending_status === 'pending_done' &&
      (row.status !== 'in_progress' || isNonEmptyString(row.done_at) || isNonEmptyString(row.blocked_reason))) {
    return jsonError(409, 'TASK_STATE_INVALID', 'pending_done 任务不满足状态不变量', { task: serializeTask(row) });
  }
  if (row.pending_status === 'pending_blocked' &&
      (row.status !== 'in_progress' || isNonEmptyString(row.done_at) || !isNonEmptyString(row.blocked_reason))) {
    return jsonError(409, 'TASK_STATE_INVALID', 'pending_blocked 任务不满足状态不变量', { task: serializeTask(row) });
  }
  if (row.status === 'in_progress' && isNonEmptyString(row.done_at)) {
    return jsonError(409, 'TASK_STATE_INVALID', 'in_progress 任务不得已有 done_at', { task: serializeTask(row) });
  }
  if (row.status === 'done' && (row.pending_status !== null || !isNonEmptyString(row.done_at))) {
    return jsonError(409, 'TASK_STATE_INVALID', 'done 任务必须有 done_at 且不能 pending', { task: serializeTask(row) });
  }
  if (row.status === 'blocked' && (row.pending_status !== null || !isNonEmptyString(row.blocked_reason))) {
    return jsonError(409, 'TASK_LEGACY_INVALID', '历史 blocked 任务缺少 blocked_reason，需先补数', { task: serializeTask(row) });
  }
  return null;
}

function taskPriority(value) {
  if (!Number.isInteger(value) || !TASK_PRIORITIES.includes(value)) {
    return jsonError(400, 'INVALID_PRIORITY', 'priority 必须是 0（普通）/ 1（高）/ 2（紧急）');
  }
  return null;
}

function taskCheckbox(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return jsonError(400, 'INVALID_CHECKBOX', 'checkbox 必须是布尔值或 0/1');
}

function taskStream(value) {
  if (!TASK_STREAMS.includes(value)) {
    return jsonError(400, 'INVALID_TASK_STREAM', 'stream 必须是：' + TASK_STREAMS.join(' / '));
  }
  return null;
}

function taskQueryFlag(value, name) {
  if (value === '1' || value === 'true') return 1;
  if (value === '0' || value === 'false') return 0;
  return jsonError(400, 'INVALID_' + name.toUpperCase(), name + ' 过滤值必须是 0/1');
}

async function getTaskRow(db, id) {
  const rows = await db.prepare(`SELECT t.*,
    (SELECT e.confirmation_id FROM task_events e
      WHERE e.task_id = t.id AND e.confirmation_id IS NOT NULL
        AND e.pending_status = t.pending_status
      ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS confirmation_id,
    (SELECT e.progress FROM task_events e
      WHERE e.task_id = t.id AND e.event_type = 'round_close'
      ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS last_progress,
    (SELECT e.next FROM task_events e
      WHERE e.task_id = t.id AND e.event_type = 'round_close'
      ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS last_next
    FROM tasks t WHERE t.id = ?`).bind(id).first();
  return rows;
}

const TASK_SELECT_LIST = `SELECT t.*,
  (SELECT e.confirmation_id FROM task_events e
    WHERE e.task_id = t.id AND e.confirmation_id IS NOT NULL
      AND e.pending_status = t.pending_status
    ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS confirmation_id,
  (SELECT e.progress FROM task_events e WHERE e.task_id = t.id AND e.event_type = 'round_close'
    ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS last_progress,
  (SELECT e.next FROM task_events e WHERE e.task_id = t.id AND e.event_type = 'round_close'
    ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS last_next
  FROM tasks t WHERE `;

async function taskResponse(db, id, extra = {}) {
  const row = await getTaskRow(db, id);
  return jsonOk(serializeTask(row, { task_id: id, ...extra }));
}

function taskConflict(message, row) {
  return jsonError(409, 'TASK_VERSION_CONFLICT', message, row ? { task: serializeTask(row) } : {});
}

function taskPendingConflict(message, row) {
  return jsonError(409, 'TASK_PENDING_CONFLICT', message, row ? { task: serializeTask(row) } : {});
}

async function findRoundEvent(db, taskIdValue, agentId, roundId) {
  return await db.prepare(
    "SELECT * FROM task_events WHERE task_id = ? AND agent_id = ? AND round_id = ? AND event_type = 'round_close'"
  ).bind(taskIdValue, agentId, roundId).first();
}

async function findTerminalEvent(db, taskIdValue, confirmationId) {
  return await db.prepare(
    'SELECT * FROM task_events WHERE task_id = ? AND confirmation_id = ?'
  ).bind(taskIdValue, confirmationId).first();
}

async function findConfirmationOutcome(db, taskIdValue, confirmationId) {
  const rows = await db.prepare(
    "SELECT * FROM task_events WHERE task_id = ? AND event_type IN ('confirmed', 'reopened') ORDER BY created_at DESC, event_id DESC"
  ).bind(taskIdValue).all();
  for (const event of rows.results || []) {
    try {
      const payload = JSON.parse(event.payload_json);
      if (payload && payload.request && payload.request.confirmation_id === confirmationId) return { event, payload };
    } catch (err) {
      // 历史坏 payload 不影响其他事件；当前请求仍会按不匹配处理。
    }
  }
  return null;
}

function eventPayloadMatches(event, expectedPayload) {
  return !!event && event.payload_json === JSON.stringify(expectedPayload);
}

// GET /task —— 列表，默认排除 archived；checkbox 过滤供 auto-advance API 使用。
async function listTasksHandler(db, url) {
  const project = url.searchParams.get('project');
  const stream = url.searchParams.get('stream');
  const status = url.searchParams.get('status');
  const checkbox = url.searchParams.get('checkbox');
  if (stream && taskStream(stream)) return taskStream(stream);
  if (status && taskStatus(status)) return taskStatus(status);

  const where = ['archived = 0'];
  const params = [];
  if (project) { where.push('project = ?'); params.push(project); }
  if (stream) { where.push('stream = ?'); params.push(stream); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (checkbox !== null) {
    const flagError = taskQueryFlag(checkbox, 'checkbox');
    if (flagError instanceof Response) return flagError;
    where.push('checkbox = ?');
    params.push(flagError);
  }
  const whereSql = where.join(' AND ');
  const count = await db.prepare('SELECT COUNT(*) AS total FROM tasks WHERE ' + whereSql).bind(...params).first();
  const rawPage = url.searchParams.get('page');
  const rawSize = url.searchParams.get('size');
  const page = rawPage === null ? 1 : toInt(rawPage, null, 1, 1000000);
  const size = rawSize === null ? 1000 : toInt(rawSize, null, 1, 1000);
  if (page === null || size === null) return jsonError(422, 'INVALID_PAGINATION', 'page/size 必须是正整数，size 最大 1000');
  const total = Number(count && count.total ? count.total : 0);
  const rows = await db.prepare(
    TASK_SELECT_LIST + whereSql + ' ORDER BY t.updated_at DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?'
  ).bind(...params, size, (page - 1) * size).all();
  const items = (rows.results || []).map(serializeTask);
  return jsonOk({
    items,
    total,
    page,
    size,
    has_more: page * size < total,
    source: 'cloud',
    project: project || undefined,
    stream: stream || undefined,
    status: status || undefined,
    checkbox: checkbox === null ? undefined : Number(checkbox === 'true' || checkbox === '1'),
  });
}

// GET /task/{id} —— 单条；软归档任务可按 id 读取，列表/搜索默认不返回。
async function getTaskHandler(db, id) {
  const row = await getTaskRow(db, id);
  if (!row) return jsonError(404, 'TASK_NOT_FOUND', '任务不存在：' + id);
  return jsonOk(serializeTask(row));
}

// POST /task —— 创建任务；管理字段由服务端填写。
async function createTaskHandler(db, body) {
  if (!isTaskBody(body)) return jsonError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');

  const has = (field) => Object.prototype.hasOwnProperty.call(body, field);
  if (has('pending_status') || has('done_at') || has('created_at') || has('updated_at') || has('archived')) {
    return jsonError(422, 'TASK_CREATE_TERMINAL_FORBIDDEN',
      'create 不得传入 pending_status、done_at 或其他服务端管理字段');
  }

  const project = taskString(body.project, 'project', true);
  if (project.error) return project.error;
  const title = taskString(body.title, 'title', true);
  if (title.error) return title.error;

  const status = body.status === undefined ? 'open' : body.status;
  if (TASK_TERMINAL_STATUSES.includes(status)) {
    return jsonError(422, 'TASK_CREATE_TERMINAL_FORBIDDEN', 'create 不得直接创建 done 或 blocked 任务');
  }
  if (!['open', 'in_progress', 'waiting'].includes(status)) {
    const statusError = taskStatus(status);
    if (statusError) return statusError;
  }
  const priority = body.priority === undefined ? 0 : body.priority;
  const priorityError = taskPriority(priority);
  if (priorityError) return priorityError;
  const checkbox = body.checkbox === undefined ? 0 : taskCheckbox(body.checkbox);
  if (checkbox instanceof Response) return checkbox;
  const stream = body.stream === undefined ? TASK_DEFAULT_STREAM : body.stream;
  const streamError = taskStream(stream);
  if (streamError) return streamError;
  const taskBody = body.body === undefined ? '' : body.body;
  if (typeof taskBody !== 'string') return jsonError(400, 'INVALID_BODY_TEXT', 'body 必须是字符串');
  if (has('blocked_reason') && body.blocked_reason !== null && body.blocked_reason !== undefined) {
    if (!isNonEmptyString(body.blocked_reason)) {
      return jsonError(422, 'INVALID_BLOCKED_REASON', 'blocked_reason 必须是非空字符串或 null');
    }
    return jsonError(422, 'TASK_CREATE_BLOCKED_REASON_FORBIDDEN', 'create 的非终态任务不得设置 blocked_reason');
  }

  const id = taskId();
  const now = nowIso();
  await db.prepare(
    'INSERT INTO tasks (id, project, title, status, priority, checkbox, stream, body, created_at, updated_at, done_at, archived) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    id, project.value, title.value, status, priority, checkbox, stream, taskBody, now, now, '', 0
  ).run();

  const row = await getTaskRow(db, id);
  return jsonOk(serializeTask(row), 201);
}

// PATCH /task/{id} —— 业务字段更新；终态只能生成 pending 申请。
async function patchTaskHandler(db, id, body) {
  if (!isTaskBody(body)) return jsonError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
  const has = (field) => Object.prototype.hasOwnProperty.call(body, field);
  const forbidden = Object.keys(body).filter((field) => !TASK_PATCH_FIELDS.includes(field) && field !== 'expected_updated_at');
  if (forbidden.length > 0) {
    return jsonError(422, 'TASK_PATCH_FIELD_FORBIDDEN', 'PATCH 字段不在白名单中：' + forbidden.join(', '), { fields: forbidden });
  }
  const present = TASK_PATCH_FIELDS.filter(has);
  if (present.length === 0) return jsonError(400, 'PATCH_FIELDS_REQUIRED', 'PATCH 至少需要 status/priority/body/title/checkbox 之一');

  const row = await getTaskRow(db, id);
  if (!row) return jsonError(404, 'TASK_NOT_FOUND', '任务不存在：' + id);

  const expected = taskExpectedUpdatedAt(body.expected_updated_at, false);
  if (expected instanceof Response) return expected;
  if (has('status') && row.pending_status !== null) {
    return taskPendingConflict('pending 任务不得通过 PATCH status 改变状态，请使用 confirm', row);
  }

  const nextStatus = has('status') ? body.status : row.status;
  const statusIsTerminal = TASK_TERMINAL_STATUSES.includes(nextStatus);
  if (has('status')) {
    const statusError = taskStatus(body.status);
    if (statusError) return statusError;
    if (TASK_TERMINAL_STATUSES.includes(body.status)) {
      if (row.status !== 'in_progress' || row.pending_status !== null) {
        return jsonError(422, 'TASK_TERMINAL_REQUIRES_IN_PROGRESS',
          '只有无 pending 的 in_progress 任务可以申请 done/blocked', { task: serializeTask(row) });
      }
      if (body.status === 'blocked' && !isNonEmptyString(body.blocked_reason)) {
        return jsonError(422, 'TASK_BLOCKED_REASON_REQUIRED', '申请 blocked 必须提供非空 blocked_reason');
      }
      if (body.status === 'done' && has('blocked_reason') && isNonEmptyString(body.blocked_reason)) {
        return jsonError(422, 'INVALID_BLOCKED_REASON', 'done 申请不得设置 blocked_reason');
      }
    }
    if (row.status === 'done' || row.status === 'blocked') {
      return jsonError(409, 'TASK_TERMINAL_IMMUTABLE', '终态任务只能通过既有 pending 的 confirm 流程变更', { task: serializeTask(row) });
    }
  }

  let blockedReason = row.blocked_reason === undefined ? null : row.blocked_reason;
  if (has('blocked_reason')) {
    if (body.blocked_reason !== null && body.blocked_reason !== undefined && !isNonEmptyString(body.blocked_reason)) {
      return jsonError(422, 'INVALID_BLOCKED_REASON', 'blocked_reason 必须是非空字符串或 null');
    }
    if (body.blocked_reason !== null && body.blocked_reason !== undefined) {
      const validReason = taskBlockedReason(body.blocked_reason);
      if (validReason instanceof Response) return validReason;
      blockedReason = validReason;
    } else {
      blockedReason = null;
    }
  }
  if (statusIsTerminal && nextStatus === 'blocked' && !isNonEmptyString(blockedReason)) {
    return jsonError(422, 'TASK_BLOCKED_REASON_REQUIRED', '申请 blocked 必须提供非空 blocked_reason');
  }
  if (!statusIsTerminal && isNonEmptyString(blockedReason) && row.pending_status !== 'pending_blocked' && row.status !== 'blocked') {
    return jsonError(422, 'INVALID_BLOCKED_REASON', '只有 blocked 或 pending_blocked 任务可以设置 blocked_reason');
  }
  if (row.status === 'blocked' && !isNonEmptyString(blockedReason)) {
    return jsonError(422, 'TASK_BLOCKED_REASON_REQUIRED', 'blocked 任务必须保留非空 blocked_reason');
  }
  if (row.pending_status === 'pending_blocked' && has('blocked_reason') && !isNonEmptyString(blockedReason)) {
    return jsonError(422, 'TASK_BLOCKED_REASON_REQUIRED', 'pending_blocked 必须保留非空 blocked_reason');
  }

  const sets = [];
  const params = [];
  for (const field of present) {
    if (field === 'status') {
      // 终态在下面作为 pending 申请处理。
      if (!statusIsTerminal) {
        sets.push('status = ?');
        params.push(body.status);
      }
    } else if (field === 'priority') {
      const error = taskPriority(body.priority);
      if (error) return error;
      sets.push('priority = ?');
      params.push(body.priority);
    } else if (field === 'checkbox') {
      const value = taskCheckbox(body.checkbox);
      if (value instanceof Response) return value;
      sets.push('checkbox = ?');
      params.push(value);
    } else if (field === 'title') {
      const value = taskString(body.title, 'title', true);
      if (value.error) return value.error;
      sets.push('title = ?');
      params.push(value.value);
    } else if (field === 'body') {
      if (typeof body.body !== 'string') return jsonError(400, 'INVALID_BODY_TEXT', 'body 必须是字符串');
      sets.push('body = ?');
      params.push(body.body);
    }
  }

  const now = nowIso();
  if (has('status') && !statusIsTerminal && row.status === 'blocked') {
    blockedReason = null;
  }
  if (!statusIsTerminal && (has('blocked_reason') || (has('status') && row.status === 'blocked'))) {
    sets.push('blocked_reason = ?');
    params.push(blockedReason);
  }

  if (statusIsTerminal) {
    const stateError = taskStateError(row);
    if (stateError) return stateError;
    const pendingStatus = nextStatus === 'done' ? 'pending_done' : 'pending_blocked';
    const confirmationId = 'cnf-' + crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const eventPayload = {
      kind: 'terminal_requested',
      task_id: id,
      confirmation_id: confirmationId,
      requested_status: nextStatus,
      blocked_reason: nextStatus === 'blocked' ? blockedReason : null,
      expected_updated_at: expected,
    };
    const update = db.prepare(
      'UPDATE tasks SET ' +
      (sets.length ? sets.join(', ') + ', ' : '') +
      'status = ?, pending_status = ?, blocked_reason = ?, updated_at = ? ' +
      'WHERE id = ? AND status = \'in_progress\' AND pending_status IS NULL' +
      (expected === null ? '' : ' AND updated_at = ?')
    ).bind(
      ...params, 'in_progress', pendingStatus, nextStatus === 'blocked' ? blockedReason : null, now, id,
      ...(expected === null ? [] : [expected])
    );
    const event = db.prepare(
      'INSERT INTO task_events (event_id, task_id, agent_id, event_type, round_id, action, progress, next, blocked_reason, pending_status, confirmation_id, expected_updated_at, payload_json, created_at) ' +
      'SELECT ?, ?, ?, \'terminal_requested\', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ? WHERE changes() = 1'
    ).bind(
      eventId, id, TASK_SYSTEM_AGENT, nextStatus === 'blocked' ? blockedReason : null, pendingStatus,
      confirmationId, expected, JSON.stringify(eventPayload), now
    );
    await db.batch([update, event]);
    const savedEvent = await findTerminalEvent(db, id, confirmationId);
    if (!savedEvent) {
      const current = await getTaskRow(db, id);
      return taskConflict('任务版本已变化，终态申请未提交', current);
    }
    return await taskResponse(db, id, { confirmation_id: confirmationId, idempotent: false });
  }

  sets.push('updated_at = ?');
  params.push(now, id);
  let updateSql = 'UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?';
  if (expected !== null) {
    updateSql += ' AND updated_at = ?';
    params.push(expected);
  }
  const updateResult = await db.prepare(updateSql).bind(...params).run();
  if (updateResult && updateResult.meta && Number(updateResult.meta.changes) === 0) {
    return taskConflict('任务版本已变化，请重新读取后重试', await getTaskRow(db, id));
  }
  return await taskResponse(db, id);
}

// POST /task/{id}/confirm —— pending 的唯一确认入口；更新与审计事件同一 batch 原子提交。
async function confirmTaskHandler(db, id, body) {
  if (!isTaskBody(body)) return jsonError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
  if (!TASK_CONFIRM_DECISIONS.includes(body.decision)) {
    return jsonError(422, 'INVALID_CONFIRM_DECISION', 'decision 必须是 accept 或 reopen');
  }
  if (!TASK_PENDING_STATUSES.includes(body.expected_pending)) {
    return jsonError(422, 'INVALID_EXPECTED_PENDING', 'expected_pending 必须是 pending_done 或 pending_blocked');
  }
  const expected = taskExpectedUpdatedAt(body.expected_updated_at, true);
  if (expected instanceof Response) return expected;
  if (!isNonEmptyString(body.confirmation_id)) {
    return jsonError(422, 'CONFIRMATION_ID_REQUIRED', 'confirmation_id 必填');
  }
  const confirmationId = body.confirmation_id.trim();
  const requestPayload = {
    decision: body.decision,
    expected_pending: body.expected_pending,
    expected_updated_at: expected,
    confirmation_id: confirmationId,
  };

  const row = await getTaskRow(db, id);
  if (!row) return jsonError(404, 'TASK_NOT_FOUND', '任务不存在：' + id);

  // 已完成确认先按持久化请求内容做幂等判断；这也允许终态任务安全重试。
  const prior = await findConfirmationOutcome(db, id, confirmationId);
  if (prior) {
    const priorRequest = prior.payload && prior.payload.request;
    if (JSON.stringify(priorRequest) !== JSON.stringify(requestPayload)) {
      return taskConflict('confirmation_id 已用于不同内容的确认请求', row);
    }
    return await taskResponse(db, id, { confirmation_id: confirmationId, idempotent: true });
  }

  const terminalEvent = await findTerminalEvent(db, id, confirmationId);
  if (!terminalEvent || terminalEvent.pending_status !== body.expected_pending) {
    return taskConflict('confirmation_id 或 expected_pending 与当前申请不匹配', row);
  }
  if (row.pending_status !== body.expected_pending || row.updated_at !== expected || row.confirmation_id !== confirmationId) {
    return taskConflict('任务 pending 或版本已变化，请重新读取确认队列', row);
  }
  const stateError = taskStateError(row);
  if (stateError) return stateError;

  const now = nowIso();
  const nextStatus = body.decision === 'accept'
    ? (body.expected_pending === 'pending_done' ? 'done' : 'blocked')
    : 'in_progress';
  const nextReason = body.decision === 'accept' && body.expected_pending === 'pending_blocked'
    ? row.blocked_reason : null;
  const eventId = crypto.randomUUID();
  const eventPayload = {
    request: requestPayload,
    result: { status: nextStatus, pending_status: null, updated_at: now },
  };
  const doneAtSql = nextStatus === 'done' ? ', done_at = ?' : '';
  const update = db.prepare(
    'UPDATE tasks SET status = ?, pending_status = NULL, blocked_reason = ?' + doneAtSql + ', updated_at = ? ' +
    'WHERE id = ? AND pending_status = ? AND updated_at = ? AND EXISTS (' +
      'SELECT 1 FROM task_events WHERE task_id = ? AND confirmation_id = ? AND pending_status = ?' +
    ')'
  ).bind(
    nextStatus, nextReason, ...(nextStatus === 'done' ? [now] : []), now, id, body.expected_pending, expected,
    id, confirmationId, body.expected_pending
  );
  // confirmed/reopened 事件的 confirmation_id 列留空：申请事件持有唯一 confirmation_id，
  // 确认事件通过 payload.request.confirmation_id 关联，避免违反非空唯一约束。
  const event = db.prepare(
    'INSERT INTO task_events (event_id, task_id, agent_id, event_type, round_id, action, progress, next, blocked_reason, pending_status, confirmation_id, expected_updated_at, payload_json, created_at) ' +
    'SELECT ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, ?, ?, ? WHERE changes() = 1'
  ).bind(
    eventId, id, TASK_SYSTEM_AGENT, body.decision === 'accept' ? 'confirmed' : 'reopened', body.decision,
    nextReason, expected, JSON.stringify(eventPayload), now
  );
  try {
    await db.batch([update, event]);
  } catch (err) {
    const retry = await findConfirmationOutcome(db, id, confirmationId);
    if (retry && JSON.stringify(retry.payload && retry.payload.request) === JSON.stringify(requestPayload)) {
      return await taskResponse(db, id, { confirmation_id: confirmationId, idempotent: true });
    }
    throw err;
  }
  const savedEvent = await db.prepare('SELECT event_id FROM task_events WHERE event_id = ?').bind(eventId).first();
  if (!savedEvent) return taskConflict('任务版本已变化，确认未提交', await getTaskRow(db, id));
  return await taskResponse(db, id, { confirmation_id: confirmationId, idempotent: false });
}

// POST /task/{id}/round-close —— 每个 agent/round 最多一条不可变收尾事件。
async function roundCloseTaskHandler(db, id, body) {
  if (!isTaskBody(body)) return jsonError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
  if (!isNonEmptyString(body.agent_id)) return jsonError(422, 'AGENT_ID_REQUIRED', 'agent_id 必填');
  if (!isNonEmptyString(body.round_id)) return jsonError(422, 'ROUND_ID_REQUIRED', 'round_id 必填');
  if (!TASK_ROUND_ACTIONS.includes(body.action)) {
    return jsonError(422, 'INVALID_ROUND_ACTION', 'action 必须是 update、done 或 blocked');
  }
  const agentId = body.agent_id.trim();
  const roundId = body.round_id.trim();
  const progress = taskEventText(body.progress, 'progress', true);
  if (progress instanceof Response) return progress;
  const next = taskEventText(body.next, 'next', true);
  if (next instanceof Response) return next;
  let blockedReason = null;
  if (body.action === 'blocked') {
    blockedReason = taskBlockedReason(body.blocked_reason);
    if (blockedReason instanceof Response) return blockedReason;
  } else if (body.blocked_reason !== undefined && body.blocked_reason !== null) {
    return jsonError(422, 'INVALID_BLOCKED_REASON', 'blocked_reason 只允许用于 action=blocked');
  }
  const expected = taskExpectedUpdatedAt(body.expected_updated_at, body.action !== 'update');
  if (expected instanceof Response) return expected;
  const payload = {
    agent_id: agentId,
    round_id: roundId,
    action: body.action,
    progress,
    next,
    blocked_reason: blockedReason,
    expected_updated_at: expected,
  };

  const row = await getTaskRow(db, id);
  if (!row) return jsonError(404, 'TASK_NOT_FOUND', '任务不存在：' + id);
  const existing = await findRoundEvent(db, id, agentId, roundId);
  if (existing) {
    if (eventPayloadMatches(existing, payload)) {
      return await taskResponse(db, id, { event_id: existing.event_id, round_id: roundId, idempotent: true });
    }
    return taskConflict('相同 round_id 已提交不同内容', row);
  }
  if (row.pending_status !== null) {
    return taskPendingConflict('pending 任务不能再次 round-close，请先 confirm 或 reopen', row);
  }
  if (row.status !== 'in_progress') {
    return jsonError(422, 'TASK_ROUND_REQUIRES_IN_PROGRESS', 'round-close 只允许 in_progress 任务', { task: serializeTask(row) });
  }
  const stateError = taskStateError(row);
  if (stateError) return stateError;

  const now = nowIso();
  const eventId = crypto.randomUUID();
  const pendingStatus = body.action === 'done' ? 'pending_done' : body.action === 'blocked' ? 'pending_blocked' : null;
  const confirmationId = pendingStatus ? 'cnf-' + crypto.randomUUID() : null;
  const update = body.action === 'update'
    ? db.prepare(
      'UPDATE tasks SET updated_at = ? WHERE id = ? AND status = \'in_progress\' AND pending_status IS NULL' +
      (expected === null ? '' : ' AND updated_at = ?')
    ).bind(now, id, ...(expected === null ? [] : [expected]))
    : db.prepare(
      'UPDATE tasks SET status = \'in_progress\', pending_status = ?, blocked_reason = ?, updated_at = ? ' +
      'WHERE id = ? AND status = \'in_progress\' AND pending_status IS NULL AND updated_at = ?'
    ).bind(pendingStatus, blockedReason, now, id, expected);
  const event = db.prepare(
    'INSERT INTO task_events (event_id, task_id, agent_id, event_type, round_id, action, progress, next, blocked_reason, pending_status, confirmation_id, expected_updated_at, payload_json, created_at) ' +
    'SELECT ?, ?, ?, \'round_close\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1'
  ).bind(
    eventId, id, agentId, roundId, body.action, progress, next, blockedReason, pendingStatus,
    confirmationId, expected, JSON.stringify(payload), now
  );
  try {
    await db.batch([update, event]);
  } catch (err) {
    const retry = await findRoundEvent(db, id, agentId, roundId);
    if (retry && eventPayloadMatches(retry, payload)) {
      return await taskResponse(db, id, { event_id: retry.event_id, round_id: roundId, idempotent: true });
    }
    throw err;
  }
  const savedEvent = await findRoundEvent(db, id, agentId, roundId);
  if (!savedEvent) return taskConflict('任务版本已变化，round-close 未提交', await getTaskRow(db, id));
  return await taskResponse(db, id, {
    event_id: eventId,
    round_id: roundId,
    confirmation_id: confirmationId,
    idempotent: false,
  });
}

// DELETE /task/{id} —— 软删，保留任务事实与审计字段。
async function deleteTaskHandler(db, id) {
  const row = await getTaskRow(db, id);
  if (!row) return jsonError(404, 'TASK_NOT_FOUND', '任务不存在：' + id);
  if (Number(row.archived) === 0) {
    await db.prepare('UPDATE tasks SET archived = ?, updated_at = ? WHERE id = ?')
      .bind(1, nowIso(), id).run();
  }
  const updated = await getTaskRow(db, id);
  return jsonOk(serializeTask(updated));
}

// POST /task/search —— 关键词 LIKE；默认排除 archived。
async function searchTasksHandler(db, body) {
  if (!isTaskBody(body)) return jsonError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
  if (!isNonEmptyString(body.query)) return jsonError(400, 'QUERY_REQUIRED', 'query 必填（关键词 LIKE 检索）');

  const stream = body.stream;
  const status = body.status;
  if (stream && taskStream(stream)) return taskStream(stream);
  if (status && taskStatus(status)) return taskStatus(status);

  const pattern = '%' + escapeLike(body.query) + '%';
  const where = [
    'archived = 0',
    "(project LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')",
  ];
  const params = [pattern, pattern, pattern, pattern];
  if (stream) { where.push('stream = ?'); params.push(stream); }
  if (status) { where.push('status = ?'); params.push(status); }
  const rows = await db.prepare(
    TASK_SELECT_LIST + where.join(' AND ') + ' ORDER BY t.updated_at DESC, t.created_at DESC, t.id DESC'
  ).bind(...params).all();
  const items = (rows.results || []).map(serializeTask);
  return jsonOk({ query: body.query, items, total: items.length, stream, status });
}

// ---- 路由入口 ---------------------------------------------------------------

// ES Module 格式下 env 由运行时直接注入（env.DB = D1 binding，env.AUTH_TOKEN = secret），
// 无需（也不存在）经典格式的全局变量收集步骤。
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const segments = path.split('/').filter(Boolean); // ['mem'|'task', resource, ...]

  // CORS 预检（工具调用多为服务端到服务端，保留以方便调试）
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // GET /mem/health 不要求认证（部署验收用）；其余端点全部过认证
  if (method === 'GET' && path === '/mem/health') {
    return healthHandler(env);
  }
  const taskOperation = segments[0] === 'task'
    ? ((method === 'GET' || (method === 'POST' && segments[1] === 'search')) ? 'read' : 'write')
    : undefined;
  const authErr = checkAuth(request, env, taskOperation);
  if (authErr) return authErr;

  if (!env.DB) {
    return jsonError(503, 'DB_NOT_CONFIGURED',
      'D1 binding 未配置：请在 Dashboard 创建 D1 数据库并绑定到本 Worker，binding 变量名必须为 DB（见 README.md）。');
  }
  const db = env.DB;

  if (segments[0] === 'task') {
    // migration 失败时 fail closed：绝不继续用旧 schema 服务 task。
    try {
      await ensureTasksSchema(db);
    } catch (err) {
      return jsonError(503, 'TASK_SCHEMA_UNAVAILABLE', '任务 schema migration 失败，task 路由暂不可用');
    }
    try {
      if (segments.length === 2 && segments[1] === 'search') {
        if (method === 'POST') return await searchTasksHandler(db, await readJson(request));
      } else if (segments.length === 1) {
        if (method === 'GET') return await listTasksHandler(db, url);
        if (method === 'POST') return await createTaskHandler(db, await readJson(request));
      } else if (segments.length === 2) {
        const id = decodeURIComponent(segments[1]);
        if (method === 'GET') return await getTaskHandler(db, id);
        if (method === 'PATCH') return await patchTaskHandler(db, id, await readJson(request));
        if (method === 'DELETE') return await deleteTaskHandler(db, id);
      } else if (segments.length === 3) {
        const id = decodeURIComponent(segments[1]);
        if (method === 'POST' && segments[2] === 'confirm') {
          return await confirmTaskHandler(db, id, await readJson(request));
        }
        if (method === 'POST' && segments[2] === 'round-close') {
          return await roundCloseTaskHandler(db, id, await readJson(request));
        }
      }
      return jsonError(405, 'METHOD_NOT_ALLOWED', '路径 ' + path + ' 不支持 ' + method);
    } catch (err) {
      if (err && err.httpStatus) {
        return jsonError(err.httpStatus, err.code, err.message);
      }
      console.error('[sagitta-memory] unhandled task error:', err);
      return jsonError(500, 'INTERNAL', '服务端内部错误：' + (err && err.message ? err.message : String(err)));
    }
  }

  if (segments[0] !== 'mem' || segments.length < 2) {
    return jsonError(404, 'NOT_FOUND', '未知路径：' + path);
  }
  const resource = segments[1];

  try {
    switch (resource) {
      case 'search':
        if (method === 'POST' && segments.length === 2) return await searchHandler(db, await readJson(request));
        break;
      case 'consolidate':
        if (method === 'POST' && segments.length === 2) return await consolidateHandler(db, await readJson(request));
        break;
      case 'ack':
        if (method === 'POST' && segments.length === 2) return await ackHandler(db, await readJson(request));
        break;
      case 'delegations':
        if (method === 'POST' && segments.length === 2) return await createDelegationHandler(db, await readJson(request));
        if (method === 'GET' && segments.length === 3) return await getDelegationHandler(db, segments[2]);
        break;
      default:
        // /mem/{stream}（POST 创建 / GET 列表）与 /mem/{stream}/{id}（GET 单条）
        if (segments.length === 2) {
          if (method === 'POST') return await createEntryHandler(db, segments[1], await readJson(request));
          if (method === 'GET') return await listEntriesHandler(db, segments[1], url);
        } else if (segments.length === 3) {
          if (method === 'GET') return await getEntryHandler(db, segments[1], segments[2]);
        }
    }
    return jsonError(405, 'METHOD_NOT_ALLOWED', '路径 ' + path + ' 不支持 ' + method);
  } catch (err) {
    // fail-loud：业务校验错误（带 httpStatus）按其状态码返回；
    // 其余（D1 超时/查询失败/未知异常）一律 500 带 code/message，不静默吞掉。
    if (err && err.httpStatus) {
      return jsonError(err.httpStatus, err.code, err.message);
    }
    console.error('[sagitta-memory] unhandled error:', err);
    return jsonError(500, 'INTERNAL', '服务端内部错误：' + (err && err.message ? err.message : String(err)));
  }
}

// ES Module 入口（Cloudflare Workers 模块格式，D1 binding 的硬前提）。
// ctx 保留在签名中以兼容三参形态（当前未使用；未来 waitUntil/超时类扩展从这接入）。
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
};
