// ============================================================================
// sagitta-memory — 验收冒烟脚本（test/smoke.mjs）— v1.3
// ============================================================================
// 用途：不依赖 DSH 运行环境，用真实 lib/client.js 客户端走全链路，逐条断言。
// 目标选择（环境变量 DSH_MEMORY_SMOKE_TARGET）：
//   local（缺省）→ 本地冒烟：node:sqlite 内存库按 schema.sql 建表，构造 D1 兼容
//                 桩绑定，以**真实 worker.js** 的 fetch 处理器（ES Module default
//                 export）跑全部端点，经本机 http 桥 + 真实插件客户端走完整链路。
//                 —— 与线上同一份代码、同一套断言；离线可复现（v1.2 时代也走
//                 本地桩复刻逻辑的先例，v1.3 直接把桩换成真 worker + D1 适配器，
//                 不再复刻逻辑）。
//   online       → 真实线上链路（需已部署 v1.3；线上若仍是 v1.2，v1.3 新断言会
//                 失败——先由涟漪在 Dashboard 重新粘贴部署，再以
//                 DSH_MEMORY_SMOKE_TARGET=online 重跑真链路冒烟）。
// 覆盖断言（v1.3 机制逐条）：
//   A. health 200 + env.db/auth_token 全 true
//   B. 创建 sagitta（缺省 origin）→ captured / score=0 / ack=0（无虚构认可）
//   C. 创建 origin=ripple → score=2 / status=corroborated（先天信任，设计 §4 v1.3 §A）
//   D. 单条读回一致 + 带信任分级字段与提示（score 0~1 → low+hint）
//   E. 检索命中 + 条目带 trust_level
//   F. unobjected 缺 statement_source → 422（v1.2 门禁保留不破坏）
//   G. explicit +2：score 0→2、status captured→corroborated（ack 自动联动，设计 §4 v1.3 §B）
//   H. 分数钳制：连续 explicit 后 score 恒 3（status 保持 corroborated——validated 只由事件承载）
//   I. score=3 → trust_level=high + “已固化”提示（设计 §4 v1.3 §E）
//   J. unobjected +1（带 statement_source）→ 计数与分数联动
//   K. oppose −3：score<0 → 软归档（status=archived / score=0 / archived_at=now，涟漪拍板软归档不硬删）
//   L. 检索默认排除 archived / superseded；显式 status=archived 才可召回（设计 §4 v1.3 §D）
//   M. 终态条目 ack → 409（不再累计信任信号）
//   N. validate 缺 blind_spot → 整体 422（设计 §4 v1.3 §C）
//   O. validate 带 blind_spot → validated 事件写入 + status=validated / score=3；
//      召回条目带 validation_events（explanation 可作 few-shot）
//   P. replace：content/condition/tags 整体更换 + score 按新 origin 重置（ripple→2 /
//      sagitta→0）+ 旧内容审计留痕（响应 old_content 回显；local 模式另查事件表）
//   Q. 信任分级三档齐全：score=2 → medium 无提示；score=3 → high 有提示
//   R. supersedes 链：被取代条目标记 superseded 且默认不可召回，显式 status 可查
//   S. 错误令牌负例 → 可读中文错误（401/302 归一化，v1.2 保留）
// 安全：全程只打印掩码态（是否配置 + 前2后2），绝不输出明文凭据。
// 副作用：local 模式为纯内存库无副作用；online 模式会写入几条
//   tags=[plugin-acceptance] 的冒烟条目（可归档清理）。
// ============================================================================

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, maskTokenSummary } from "../lib/config.js";
import { SagittaMemoryClient, MemoryApiError } from "../lib/client.js";

const TARGET = process.env.DSH_MEMORY_SMOKE_TARGET === "online" ? "online" : "local";
const WORKER_DIR = fileURLToPath(new URL("../../../worker", import.meta.url));
const LOCAL_TOKEN = "smoke-local-token-2026"; // 仅本地桩使用的测试令牌，非真实凭据

let failures = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

// ---- 本地目标：node:sqlite 内存库 + D1 兼容适配器 + 真实 worker ---------------

// D1 兼容适配器（Worker 只用 prepare/bind/first/all/run/batch，全部映射到 node:sqlite）
function makeD1(database) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const runNow = () => database.prepare(sql).run(...params);
          return {
            first: async () => {
              const r = database.prepare(sql).get(...params);
              return r === undefined ? null : r;
            },
            all: async () => ({ results: database.prepare(sql).all(...params) }),
            run: async () => {
              runNow();
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        for (const s of statements) {
          if (typeof s === "object" && s && typeof s.run === "function") await s.run();
          else throw new Error("batch 收到非已绑定语句");
        }
        database.exec("COMMIT");
      } catch (e) {
        database.exec("ROLLBACK");
        throw e;
      }
      return [];
    },
  };
}

// 本机 http 桥：把 node http 请求转成 worker.js 的 fetch(Request, {DB, AUTH_TOKEN})
async function startBridge(workerModule, d1) {
  const bridgeEnv = { DB: d1, AUTH_TOKEN: LOCAL_TOKEN };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      const hasBody = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      const request = new Request("http://127.0.0.1" + (req.url || "/"), {
        method: req.method,
        headers,
        body: hasBody ? body : undefined,
      });
      const workerRes = await workerModule.default.fetch(request, bridgeEnv);
      const text = await workerRes.text();
      res.writeHead(workerRes.status, {
        "Content-Type": workerRes.headers.get("Content-Type") || "application/json; charset=utf-8",
      });
      res.end(text);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: { code: "BRIDGE_INTERNAL", message: String((e && e.message) || e) } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

// ---- 客户端构建 ---------------------------------------------------------------

let client;
let targetNote = "";
if (TARGET === "local") {
  // 真实 worker.js（含 export default { fetch }，ES Module；无 import，可安全经 data: URL 载入）
  const workerCode = readFileSync(path.join(WORKER_DIR, "worker.js"), "utf8");
  const workerModule = await import("data:text/javascript;base64," + Buffer.from(workerCode).toString("base64"));
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(path.join(WORKER_DIR, "schema.sql"), "utf8"));

  const server = await startBridge(workerModule, makeD1(database));
  globalThis.__SMOKE_SERVER__ = server; // 末尾统一关闭
  const port = server.address().port;
  client = new SagittaMemoryClient({
    baseUrl: `http://127.0.0.1:${port}`,
    proxy: "direct",
    envPath: "unused",
    timeoutMs: 10000,
    auth: {
      accessClientId: "",
      accessClientSecret: "",
      authToken: LOCAL_TOKEN,
      accessPresent: false,
      bearerPresent: true,
    },
  });
  targetNote = `local 桩（真实 worker.js + node:sqlite D1 适配器，http://127.0.0.1:${port}，schema.sql 建表）`;
  globalThis.__SMOKE_DATABASE__ = database; // local 模式审计断言直接查事件表用；online 模式不提供
} else {
  const config = resolveConfig({});
  const auth = config.auth;
  console.log("凭据状态（仅掩码）：");
  console.log(`  Access ID: ${auth.accessPresent ? maskTokenSummary(auth.accessClientId) : "未配置"}`);
  console.log(`  Access Secret: ${auth.accessPresent ? maskTokenSummary(auth.accessClientSecret) : "未配置"}`);
  console.log(`  AUTH_TOKEN: ${auth.bearerPresent ? maskTokenSummary(auth.authToken) : "未配置（不发送 Bearer，依赖 Access 服务令牌）"}`);
  console.log(`  代理: ${config.proxy}  超时: ${config.timeoutMs}ms`);
  client = new SagittaMemoryClient(config);
  targetNote = `线上链路（${config.baseUrl}）`;
}
console.log(`冒烟目标：${targetNote}\n`);

// ---- 通用断言工具 -------------------------------------------------------------

const dbRows = (sql, ...params) => {
  const database = globalThis.__SMOKE_DATABASE__;
  if (!database) return null; // online 模式无审计表访问
  return database.prepare(sql).all(...params);
};

async function expectError(promise, kind) {
  try {
    await promise;
    return { error: null };
  } catch (err) {
    return { error: err };
  }
}

// ---- 断言执行 ----------------------------------------------------------------

// A. health
{
  const h = await client.health();
  check("A1 GET /mem/health → 200 ok:true", h.ok === true, JSON.stringify(h.ok));
  check("A2 health.env.db=true（D1 binding 已注入）", h.env && h.env.db === true, JSON.stringify(h.env));
  check("A3 health.env.auth_token=true（Secret 已注入）", h.env && h.env.auth_token === true, JSON.stringify(h.env));
  const version = h.version || "?";
  console.log(`  （服务端版本 ${version}${TARGET === "online" && version !== "1.3.0" ? " —— ⚠ 线上仍是 v1.2，以下 v1.3 新断言预期失败；需涟漪 Dashboard 重新粘贴部署 v1.3 后以 online 重跑" : ""}）`);
}

// B. 创建 sagitta（缺省 origin）→ captured / score=0
let baseId = null;
{
  const stamp = new Date().toISOString();
  const created = await client.createEntry("sagitta", {
    type: "lesson",
    domain: "test/plugin-acceptance",
    tags: ["plugin-acceptance"],
    condition: "仅插件冒烟验收用，可归档",
    content: `冒烟验收条目 v1.3 基础（${stamp}）：验证写入通道与初始信任。V13-BASE`,
  });
  baseId = created.id;
  check("B1 POST /mem/sagitta → 201 有 id", typeof baseId === "string" && baseId.length > 0, JSON.stringify(created.id));
  check("B2 缺省 origin → origin=sagitta", created.origin === "sagitta", JSON.stringify(created.origin));
  check("B3 初始 score=0（AI 自想默认无信任）", created.score === 0, JSON.stringify(created.score));
  check("B4 初始 status=captured（与 score 同档）", created.status === "captured", JSON.stringify(created.status));
  check("B5 ack/oppose 计数初始为 0（无虚构信号）", created.ack_count === 0 && created.oppose_count === 0, JSON.stringify({ ack: created.ack_count, oppose: created.oppose_count }));
}

// C. 创建 origin=ripple → score=2 / corroborated（先天信任）
let rippleId = null;
{
  const created = await client.createEntry("sagitta", {
    type: "lesson",
    domain: "test/plugin-acceptance",
    tags: ["plugin-acceptance"],
    origin: "ripple",
    condition: "仅冒烟验收用，可归档",
    content: `冒烟验收条目 v1.3 先天信任（涟漪提出）：ripple 的明确主张先天带信任。V13-RIPPLE`,
  });
  rippleId = created.id;
  check("C1 origin=ripple 创建成功", typeof rippleId === "string" && rippleId.length > 0, JSON.stringify(rippleId));
  check("C2 ripple → score=2（先天带信任，设计 §4 v1.3 §A）", created.score === 2, JSON.stringify(created.score));
  check("C3 ripple → 初始 status=corroborated（score≥2 分档）", created.status === "corroborated", JSON.stringify(created.status));
}

// D. 单条读回 + 信任分级字段（score 0 → low + hint）
{
  const got = await client.getEntry("sagitta", baseId);
  check("D1 GET /mem/sagitta/{id} 读回一致", got.id === baseId && got.status === "captured" && got.score === 0, JSON.stringify(got.id));
  check("D2 单条带 trust_level=low（score 0~1）", got.trust_level === "low", JSON.stringify(got.trust_level));
  check("D3 单条带 trust_hint（低信任提示文案）", typeof got.trust_hint === "string" && got.trust_hint.includes("尚未经过多次强化"), got.trust_hint);
}

// E. 检索命中 + 条目带信任分级
{
  const s = await client.search({ query: "V13-BASE", stream: "sagitta" });
  const hit = Array.isArray(s.items) && s.items.some((it) => it.id === baseId);
  check("E1 POST /mem/search 关键词命中", hit, JSON.stringify({ total: s.total, hit }));
  const first = (s.items || [])[0];
  check("E2 检索条目带 trust_level", first && typeof first.trust_level === "string", first && first.trust_level);
}

// F. unobjected 缺 statement_source → 422（v1.2 门禁保留）
{
  const { error } = await expectError(client.ack({ id: baseId, signal: "unobjected" }), "unobjected-gate");
  const is422 = error instanceof MemoryApiError && error.status === 422 && error.code === "STATEMENT_SOURCE_REQUIRED";
  check("F1 unobjected 缺 statement_source → 422", is422, error ? `${error.constructor.name} ${error.status}/${error.code}: ${error.message.slice(0, 120)}` : "意外成功");
}

// G. explicit +2：score 0→2、status captured→corroborated（ack 自动联动）
{
  const a = await client.ack({ id: baseId, signal: "explicit" });
  check("G1 explicit +2 → score=2", a.score === 2, JSON.stringify(a.score));
  check("G2 score=2 → status 自动 corroborated（设计 §4 v1.3 §B，无需手动 consolidate）", a.status === "corroborated", JSON.stringify(a.status));
  check("G3 ack 响应含 oppose_count（计数事实）", typeof a.oppose_count === "number", JSON.stringify(a.oppose_count));
}

// H. 分数钳制：连续 explicit 后恒 3
{
  const a1 = await client.ack({ id: baseId, signal: "explicit" });
  check("H1 explicit(2+2)→ score 钳到 3", a1.score === 3, JSON.stringify(a1.score));
  const a2 = await client.ack({ id: baseId, signal: "explicit" });
  check("H2 再 explicit → 仍 3（超过 3 保持 3）", a2.score === 3, JSON.stringify(a2.score));
  check("H3 score=3 时 status 仍为 corroborated（validated 只由事件承载，不被认可次数堆出）", a2.status === "corroborated", JSON.stringify(a2.status));
}

// I. score=3 → trust_level=high + “已固化”提示
{
  const got = await client.getEntry("sagitta", baseId);
  check("I1 score=3 → trust_level=high", got.trust_level === "high", JSON.stringify(got.trust_level));
  check("I2 high → trust_hint 含「已固化」", typeof got.trust_hint === "string" && got.trust_hint.includes("已固化"), got.trust_hint);
}

// J. unobjected +1（带 statement_source）联动
{
  const a = await client.ack({ id: baseId, signal: "unobjected", statement_source: "session-smoke-v13:assistant-stated-立场" });
  check("J1 unobjected(带 statement_source) → 计数 unobjected=1", a.unobjected_ack_count === 1, JSON.stringify(a.unobjected_ack_count));
  check("J2 score 保持 3（钳制上界）", a.score === 3, JSON.stringify(a.score));
}

// K. oppose −3：score<0 → 软归档（涟漪拍板：软归档而非硬删）
let opposeId = null;
{
  const created = await client.createEntry("sagitta", {
    type: "lesson",
    domain: "test/plugin-acceptance",
    tags: ["plugin-acceptance"],
    content: `冒烟验收条目 v1.3 反对归档（score=0 起步，一次反对即越界）。V13-ARCHIVE-DEMO`,
  });
  opposeId = created.id;
  const a = await client.ack({ id: opposeId, signal: "oppose" });
  check("K1 oppose(0−3) → archived=true（score<0 → 软归档）", a.archived === true, JSON.stringify(a));
  check("K2 软归档 → status=archived", a.status === "archived", JSON.stringify(a.status));
  check("K3 软归档 → score 归 0", a.score === 0, JSON.stringify(a.score));
  check("K4 archived_at 已打时间戳", typeof a.archived_at === "string" && a.archived_at.length > 0, JSON.stringify(a.archived_at));
  check("K5 oppose_count 计数为 1（反对是事实计数）", a.oppose_count === 1, JSON.stringify(a.oppose_count));
  const got = await client.getEntry("sagitta", opposeId); // 显式 id 单条仍可读（审计/治理需要）
  check("K6 显式单条仍可读（终态不丢，留痕可追溯）", got && got.status === "archived", got && got.status);
}

// L. 检索默认排除 archived；显式 status=archived 才召回（设计 §4 v1.3 §D）
{
  const s1 = await client.search({ query: "V13-ARCHIVE-DEMO", stream: "sagitta" });
  const excluded = !(Array.isArray(s1.items) && s1.items.some((it) => it.id === opposeId));
  check("L1 默认检索不含 archived（不可正常召回）", excluded, JSON.stringify({ total: s1.total, items: (s1.items || []).map((i) => i.id) }));
  check("L2 默认检索 total 为 0（该关键词专属此归档条目）", s1.total === 0, JSON.stringify(s1.total));
  const s2 = await client.search({ query: "V13-ARCHIVE-DEMO", stream: "sagitta", status: "archived" });
  const found = Array.isArray(s2.items) && s2.items.some((it) => it.id === opposeId);
  check("L3 显式 status=archived → 终态可召回（审计/治理查看）", found, JSON.stringify({ total: s2.total }));
}

// M. 终态条目 ack → 409
{
  const { error } = await expectError(client.ack({ id: opposeId, signal: "explicit" }), "terminal-ack");
  check("M1 archived 条目 ack → 409（终态不再累计信任信号）", error instanceof MemoryApiError && error.status === 409, error ? `${error.status}/${error.code}` : "意外成功");
}

// N. validate 缺 blind_spot → 整体 422（设计 §4 v1.3 §C）
{
  const { error } = await expectError(
    client.consolidate({ items: [{ id: rippleId, action: "validate" }] }),
    "validate-no-blindspot"
  );
  const is422 = error instanceof MemoryApiError && error.status === 422 && /blind_spot/i.test(error.message || "");
  check("N1 validate 缺 blind_spot → 422", is422, error ? `${error.status}/${error.code}: ${String(error.message).slice(0, 140)}` : "意外成功");
}

// O. validate 带 blind_spot → 事件写入 + validated / score=3；召回带事件
{
  const explanation = "该经验已由 delegation dlg-smoke-v13 的验证结果 confirmed 印证（few-shot 示例用）。";
  const blindSpot = "本经验未覆盖：子 agent 声称环境自校验通过但本机工具链缺失的情形。";
  const r = await client.consolidate({
    items: [{
      id: rippleId,
      action: "validate",
      explanation,
      blind_spot: blindSpot,
      linked_delegation_id: "dlg-smoke-v13",
    }],
  });
  const res = (r.results || [])[0];
  check("O1 validate(带 blind_spot) → 200 changed", res && res.changed === true && res.to === "validated", JSON.stringify(res));
  const got = await client.getEntry("sagitta", rippleId);
  check("O2 事件化后条目 status=validated", got.status === "validated", JSON.stringify(got.status));
  check("O3 事件化后 score=3（固化档）", got.score === 3, JSON.stringify(got.score));
  const ev = (got.validation_events || [])[0];
  check("O4 召回条目带 validation_events", Array.isArray(got.validation_events) && got.validation_events.length >= 1, JSON.stringify(got.validation_events));
  check("O5 事件 explanation 随召回返回（可作解释性 few-shot）", ev && ev.explanation === explanation, ev && ev.explanation);
  check("O6 事件 blind_spot 随召回返回", ev && ev.blind_spot === blindSpot, ev && ev.blind_spot);
  check("O7 linked_delegation_id 关联验证结果", ev && ev.linked_delegation_id === "dlg-smoke-v13", ev && ev.linked_delegation_id);
  // local 模式：直接查事件表核对落库（online 无表访问，跳过）
  if (globalThis.__SMOKE_DATABASE__) {
    const rows = dbRows("SELECT event_type, explanation, blind_spot, entry_id FROM validation_events WHERE entry_id = ?", rippleId);
    const validatedRow = (rows || []).find((r2) => r2.event_type === "validated");
    check("O8(local) validation_events 表落库 validated 行", !!validatedRow && validatedRow.blind_spot === blindSpot, JSON.stringify(rows));
  }
}

// P. replace：整体更换 + score 按新 origin 重置 + 旧内容审计留痕
{
  const oldContent = "冒烟验收条目 v1.3 反对归档（score=0 起步，一次反对即越界）。V13-ARCHIVE-DEMO";
  const r = await client.consolidate({
    items: [{
      id: opposeId,
      action: "replace",
      origin: "ripple",
      content: "冒烟验收条目 v1.3 相反经验（反对后重写为涟漪主张）：反对只说明原经验过时，不代表结论为伪——重写为相反经验。V13-REPLACED",
      condition: "仅冒烟验收用，可归档",
      tags: ["plugin-acceptance", "replaced"],
      explanation: "相反经验场景：原经验被涟漪反对后重写（设计 §4 v1.3 §D）。",
    }],
  });
  const res = (r.results || [])[0];
  check("P1 replace → 200 changed", res && res.changed === true, JSON.stringify(res));
  check("P2 replace(origin=ripple) → score 重置为 2", res && res.score === 2, JSON.stringify(res && res.score));
  check("P3 replace → status 回到对应档位（score=2 → corroborated）", res && res.to === "corroborated", JSON.stringify(res && res.to));
  check("P4 旧内容不可丢：响应 old_content 回显原内容", res && res.old_content === oldContent, res && res.old_content);
  const got = await client.getEntry("sagitta", opposeId);
  check("P5 读回：content 已整体更换", got.content.includes("V13-REPLACED") && !got.content.includes("V13-ARCHIVE-DEMO"), got.content);
  check("P6 读回：condition/tags 已更换", got.condition === "仅冒烟验收用，可归档" && (got.tags || []).includes("replaced"), JSON.stringify({ condition: got.condition, tags: got.tags }));
  check("P7 读回：origin 更新为 ripple / score=2 / status=corroborated", got.origin === "ripple" && got.score === 2 && got.status === "corroborated", JSON.stringify({ origin: got.origin, score: got.score, status: got.status }));
  check("P8 读回：archived_at 已清空（改写即复活，不再终态）", got.archived_at === null || got.archived_at === undefined, JSON.stringify(got.archived_at));
  if (globalThis.__SMOKE_DATABASE__) {
    const rows = dbRows("SELECT event_type, old_content, explanation FROM validation_events WHERE entry_id = ? AND event_type = 'replaced'", opposeId);
    const replacedRow = (rows || [])[0];
    check("P9(local) replaced 审计事件落库（旧内容进 old_content，仅审计）", !!replacedRow && replacedRow.old_content === oldContent, JSON.stringify(rows));
  }
  // replace → origin=sagitta：分数清零路径（重置到 0 / captured）
  const r2 = await client.consolidate({
    items: [{
      id: rippleId,
      action: "replace",
      origin: "sagitta",
      content: "冒烟验收条目 v1.3 重置信任（AI 自想重写默认无信任）。V13-RESET",
    }],
  });
  const res2 = (r2.results || [])[0];
  check("P10 replace(origin=sagitta) → score 重置为 0", res2 && res2.score === 0, JSON.stringify(res2 && res2.score));
  const got2 = await client.getEntry("sagitta", rippleId);
  check("P11 replace(origin=sagitta) → status=captured（分数清零档位）", got2.status === "captured" && got2.score === 0, JSON.stringify({ status: got2.status, score: got2.score }));
}

// Q. 信任分级三档齐全：score=2 → medium 无提示；score=3 → high 有提示（前者已由 C/I 覆盖，此处补 medium 无提示）
{
  const created = await client.createEntry("sagitta", {
    type: "preference",
    domain: "test/plugin-acceptance",
    tags: ["plugin-acceptance"],
    origin: "ripple",
    content: `冒烟验收条目 v1.3 中信任档。V13-MEDIUM`,
  });
  const r2 = created.id;
  const got = await client.getEntry("sagitta", r2);
  check("Q1 score=2 → trust_level=medium", got.trust_level === "medium", JSON.stringify(got.trust_level));
  check("Q2 score=2 → 无 trust_hint（未固化也未低信任，不给提示）", got.trust_hint === undefined || got.trust_hint === null, JSON.stringify(got.trust_hint));
}

// R. supersedes 链：被取代条目标记 superseded 且默认不可召回，显式 status 可查
{
  const t1 = await client.createEntry("sagitta", {
    type: "method",
    domain: "test/plugin-acceptance",
    tags: ["plugin-acceptance"],
    content: `冒烟验收条目 v1.3 将被取代的旧方法。V13-SUPERSEDED-OLD`,
  });
  const t2 = await client.createEntry("sagitta", {
    type: "method",
    domain: "test/plugin-acceptance",
    tags: ["plugin-acceptance"],
    content: `冒烟验收条目 v1.3 新方法（取代旧方法）。V13-SUPERSEDED-NEW`,
    supersedes: [t1.id],
  });
  const got1 = await client.getEntry("sagitta", t1.id);
  check("R1 被取代条目 status=superseded 且挂 superseded_by", got1.status === "superseded" && (got1.superseded_by || []).includes(t2.id), JSON.stringify({ status: got1.status, superseded_by: got1.superseded_by }));
  const s1 = await client.search({ query: "V13-SUPERSEDED-OLD", stream: "sagitta" });
  check("R2 默认检索不含 superseded", !(Array.isArray(s1.items) && s1.items.some((it) => it.id === t1.id)), JSON.stringify({ total: s1.total }));
  const s2 = await client.search({ query: "V13-SUPERSEDED-OLD", stream: "sagitta", status: "superseded" });
  check("R3 显式 status=superseded → 可召回", Array.isArray(s2.items) && s2.items.some((it) => it.id === t1.id), JSON.stringify({ total: s2.total }));
}

// S. 错误令牌负例 → 可读中文错误（401/302 归一化，v1.2 保留）
{
  let bad;
  if (TARGET === "local") {
    bad = new SagittaMemoryClient({
      baseUrl: client.baseUrl,
      proxy: "direct",
      envPath: "unused",
      timeoutMs: 10000,
      auth: { accessClientId: "", accessClientSecret: "", authToken: "wrong-token-for-smoke", accessPresent: false, bearerPresent: true },
    });
  } else {
    bad = new SagittaMemoryClient(resolveConfig({
      accessClientId: "bogus-smoke-id",
      accessClientSecret: "bogus-smoke-secret",
      authToken: "",
    }));
  }
  const { error } = await expectError(bad.listEntries("sagitta"), "bad-token");
  const readable = /Access|认证|拦截|令牌|401|302|403/.test(error ? error.message : "");
  check("S1 错误令牌 → 可读中文错误", readable, error ? error.message.slice(0, 160) : "意外成功");
}

console.log("");
if (TARGET === "local") {
  console.log("（local 桩为纯内存库，无线上副作用；审计断言已直接查 validation_events 表核对）");
} else {
  const createdIds = [baseId, rippleId, opposeId].filter(Boolean);
  console.log(`冒烟条目 id：${createdIds.join(", ")}（tags=[plugin-acceptance]，可归档）`);
  console.log("⚠ 线上为 v1.2 时，v1.3 新断言会失败属预期——请涟漪在 Dashboard 重新粘贴部署 v1.3 后重跑真链路冒烟。");
}

// local 模式下关闭桥服务（释放端口；纯内存库无需清理）
if (TARGET === "local" && globalThis.__SMOKE_SERVER__) {
  globalThis.__SMOKE_SERVER__.close();
}

console.log(failures === 0 ? `\n✅ 全部通过（${passed} 项）` : `\n❌ ${failures} 项失败 / ${passed} 项通过`);
process.exit(failures === 0 ? 0 : 1);
