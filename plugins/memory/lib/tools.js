// ============================================================================
// sagitta-memory — 四个模型工具（lib/tools.js）
// ============================================================================
// 映射设计 §10 工具定义（v1.3）：
//   remember    → memory_remember   （写入素材；origin 决定初始信任：ripple→score=2 /
//                                     sagitta（缺省）→score=0；初始 status 与 score 同档）
//   recall      → memory_recall     （目录树钻取 / 关键词检索 / 单条复查；条目带信任分级提示；
//                                     默认排除 archived/superseded——除非显式 status 过滤）
//   consolidate → memory_consolidate（治理动作集：digest/corroborate 兜底、validate 事件化
//                                     （盲点必填）、replace 整体更换（分数按新 origin 重置 +
//                                     旧内容审计留痕）、archive 治理归档（pinned 拒绝））
//   verify      → memory_verify     （三态信任信号登记 explicit +2 / unobjected +1 / oppose −3
//                                     + delegation 验证结果复核 + 条目现状复查）
// v1.3 防过拟合纪律落在参数说明与系统提示词里：插件只提交素材与信号，信任分数与状态推进由服务端按 信号→score→状态档 自动联动——插件实现本身不产生任何状态转移决策。
// ============================================================================

import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  STREAMS,
  TYPES,
  STATUSES,
  EVIDENCE_STATES,
  ACK_SIGNALS,
  ORIGINS,
  CONSOLIDATE_ACTIONS,
} from "./config.js";
import { pickNeedHuman, pickTask, taskContractError, validateRoundText, validateTaskUpdate, validateClaimLease } from "./task-contract.js";
import { createTaskGate, installTaskGate } from "./task-gate.js";
import { recallProjectMemory } from "./task-project-memory.js";

const CONTENT_EXCERPT_MAX = 1200;

// ---- 输出 schema 辅助 --------------------------------------------------------
// DSH 的 JSON Schema 子集支持：type/required/properties/additionalProperties/
// items/enum/const/oneOf。条目对象统一用 additionalProperties:false + 显式字段，
// 列表/结果容器用 additionalProperties:true 以容纳服务端可能的扩展字段。

const VALIDATION_EVENT_FIELDS = {
  id: { type: "string", required: true },
  entry_id: { type: "string", required: true },
  event_type: { type: "string", required: true },
  explanation: { type: "string" },
  blind_spot: { type: "string", required: true },
  linked_delegation_id: { type: "string" },
  created: { type: "string", required: true },
};

const ENTRY_FIELDS = {
  id: { type: "string", required: true },
  stream: { type: "string", required: true },
  type: { type: "string", required: true },
  status: { type: "string", required: true },
  domain: { type: "string" },
  tags: { type: "array", items: { type: "string" } },
  evidence: { type: "string", required: true },
  content: { type: "string" },
  condition: { type: "string" },
  origin: { type: "string" },                      // v1.3：谁提出的（ripple | sagitta）
  score: { type: "integer", required: true },      // v1.3：信任分 0~3（服务端派生/钳制）
  ack_count: { type: "integer", required: true },
  explicit_ack_count: { type: "integer", required: true },
  unobjected_ack_count: { type: "integer", required: true },
  oppose_count: { type: "integer", required: true }, // v1.3：反对信号计数
  cross_session_count: { type: "integer", required: true },
  source_task_id: { type: "string" },
  pinned: { type: "boolean", required: true },
  created: { type: "string", required: true },
  updated: { type: "string" },
  supersedes: { type: "array", items: { type: "string" } },
  superseded_by: { type: "array", items: { type: "string" } },
  trust_level: { type: "string" },                 // v1.3：召回信任分级（low | medium | high）
  trust_hint: { type: "string" },                  // v1.3：信任提示文案（medium 无提示）
  validation_events: {                             // v1.3：召回附带的 validated 事件（few-shot 解释）
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: VALIDATION_EVENT_FIELDS,
    },
  },
};

const ENTRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: ENTRY_FIELDS,
};

function pickEntry(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {
    id: String(src.id ?? ""),
    stream: String(src.stream ?? ""),
    type: String(src.type ?? ""),
    status: String(src.status ?? "captured"),
    domain: src.domain ? String(src.domain) : undefined,
    tags: Array.isArray(src.tags) ? src.tags : [],
    evidence: String(src.evidence ?? "plausible"),
    content: src.content ? String(src.content) : undefined,
    condition: src.condition ? String(src.condition) : undefined,
    origin: src.origin ? String(src.origin) : undefined,
    score: Number.isInteger(src.score) ? src.score : (src.origin === "ripple" ? 2 : 0),
    ack_count: Number.isInteger(src.ack_count) ? src.ack_count : 0,
    explicit_ack_count: Number.isInteger(src.explicit_ack_count) ? src.explicit_ack_count : 0,
    unobjected_ack_count: Number.isInteger(src.unobjected_ack_count) ? src.unobjected_ack_count : 0,
    oppose_count: Number.isInteger(src.oppose_count) ? src.oppose_count : 0,
    cross_session_count: Number.isInteger(src.cross_session_count) ? src.cross_session_count : 0,
    source_task_id: src.source_task_id ? String(src.source_task_id) : undefined,
    pinned: src.pinned === true || src.pinned === 1,
    created: String(src.created ?? ""),
    updated: src.updated ? String(src.updated) : undefined,
    supersedes: Array.isArray(src.supersedes) ? src.supersedes : [],
    superseded_by: Array.isArray(src.superseded_by) ? src.superseded_by : [],
    trust_level: src.trust_level ? String(src.trust_level) : undefined,
    trust_hint: src.trust_hint ? String(src.trust_hint) : undefined,
    validation_events: Array.isArray(src.validation_events) ? src.validation_events : undefined,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

function pickStatusBadge(status) {
  switch (status) {
    case "validated": return "✅ validated";
    case "corroborated": return "◉ corroborated";
    case "digested": return "◎ digested";
    case "superseded": return "↩ superseded";
    case "archived": return "🗄 archived";
    default: return "○ captured";
  }
}

function excerpt(text, max = CONTENT_EXCERPT_MAX) {
  const t = String(text ?? "");
  return t.length > max ? t.slice(0, max) + "\n…(截断，完整内容见服务端)" : t;
}

function renderEntry(entry, indent = false) {
  const lead = indent ? "  " : "";
  const lines = [
    `${lead}- **${entry.id}**  ${pickStatusBadge(entry.status)}  [${entry.stream} / ${entry.type}${entry.origin ? " / " + entry.origin : ""}]`,
  ];
  const meta = [];
  if (entry.domain) meta.push(`domain=${entry.domain}`);
  if (entry.tags && entry.tags.length > 0) meta.push(`tags=[${entry.tags.join(", ")}]`);
  meta.push(`evidence=${entry.evidence}`);
  meta.push(`trust=${entry.score}(e${entry.explicit_ack_count}/u${entry.unobjected_ack_count}/o${entry.oppose_count}/x${entry.cross_session_count})`);
  if (entry.condition) meta.push(`condition=${entry.condition}`);
  if (entry.created) meta.push(`created=${entry.created}`);
  lines.push(`${lead}  ${meta.join(" · ")}`);
  if (entry.trust_hint) lines.push(`${lead}  ⚠ 信任提示：${entry.trust_hint}`);
  if (entry.validation_events && entry.validation_events.length > 0) {
    const ev = entry.validation_events[0];
    lines.push(`${lead}  📌 validated 事件（${ev.created}）：${excerpt(String(ev.explanation ?? ""), 300)}${ev.blind_spot ? `\n${lead}  盲点：${excerpt(String(ev.blind_spot), 300)}` : ""}`);
  }
  if (entry.content) lines.push(`${lead}  ${excerpt(entry.content)}`);
  return lines.join("\n");
}

function presentCall(name, args, detail) {
  return {
    card: "generic",
    title: `memory: ${name}${detail ? " — " + detail : ""}`,
    kind: "memory",
    rawInput: JSON.stringify(args),
  };
}

function taskListData(data, expectedKind) {
  const projected = (data?.items || []).map(pickTask);
  const kindItems = expectedKind
    ? projected.filter((task) => task.kind === expectedKind)
    : projected;
  const serverTotal = Number.isInteger(data?.total) && kindItems.length === projected.length
    ? data.total
    : kindItems.length;
  return {
    total: serverTotal,
    items: kindItems,
  };
}

// ---- 工具定义 ---------------------------------------------------------------

export function registerMemoryTools(ctx, client) {
  const timeoutMs = client.config.timeoutMs;
  const toolOpts = { ctx, client, timeoutMs };
  const taskGate = createTaskGate({
    getAgent: (id) => {
      try {
        return ctx?.agents?.get?.(id);
      } catch {
        return undefined;
      }
    },
  });
  const gateInstallation = installTaskGate(ctx, taskGate);

  ctx.tools.register(defineTool({
    name: "memory_remember",
    description:
      "把一条素材写入 Sagitta 记忆库（设计 §10 remember）。v1.3 起信任由 origin 起步：" +
      "origin='ripple'（涟漪提出的，例如涟漪明确说的偏好/原则）→ 服务端给 score=2、初始 status=corroborated（先天带信任）；" +
      "origin='sagitta'（AI 自想的，缺省）→ score=0、初始 status=captured（默认无信任，必须靠认可信号爬升——" +
      "随手记一个想法不会自动变成可信经验）。" +
      "你无权在参数里指定 digested/validated 等状态或直接填 score——状态推进与信任分由服务端按" +
      "ack 信号自动联动（设计 §4 v1.3 分数驱动），插件只提交素材与信号。随口话只提交即可，不要顺手给它加认可信号。",
    parameters: {
      stream: {
        type: "string",
        required: true,
        enum: STREAMS,
        description: "归属流（设计 §7 四流）：sagitta（我的）/ ripple（涟漪的）/ personal-projects / company-projects。",
      },
      type: {
        type: "string",
        required: true,
        enum: TYPES,
        description: "条目类型（设计 §3）：timeline/delegation/lesson/decision/method/preference/project/judgment。",
      },
      content: {
        type: "string",
        required: true,
        description: "自由正文（markdown）。L1 硬规则：密钥/明文永不写入任何条目。",
      },
      origin: {
        type: "string",
        enum: ORIGINS,
        description: "谁提出的（设计 §3 v1.3）：'ripple'=涟漪明确提出的（先天带信任，score=2 起步）；" +
          "'sagitta'=AI 自想的（缺省；默认无信任 score=0，必须靠认可爬升——AI 自想默认不给信任）。",
      },
      domain: {
        type: "string",
        description: "层级域路径（设计 §6 目录树）。指挥链域约定前缀：delegation/*、verification/*、supervision/*、cost-timing/*。",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "检索用标签（v1 不做同义词图，检索时按字面匹配）。",
      },
      condition: {
        type: "string",
        description: "适用边界（一句话语义，设计 §3）。",
      },
      evidence: {
        type: "string",
        enum: EVIDENCE_STATES,
        description: "证据状态（默认 plausible=单次偶然）。verified 由服务端在 validate 事件化时联动；日常通常不必填。",
      },
      source_task_id: {
        type: "string",
        description: "关联 delegation 记录的 task_id（lesson 专用，设计 §3）。",
      },
      supersedes: {
        type: "array",
        items: { type: "string" },
        description: "取代链：本条目取代的旧条目 id（服务端会把旧条目标记 superseded 并挂 superseded_by）。",
      },
      pinned: {
        type: "boolean",
        description: "涟漪要求\"永远记住\"时才设 true（治理永不归档，设计 §5 的 pinned 只允许涟漪设置）。",
      },
      ack_count: {
        type: "integer",
        description:
          "仅供真实历史迁移：把已获认可的经验从另一渠道搬入时按来源真实计数填写。" +
          "日常新记录不要填——随手记默认 0 认可（设计 §4 v1.3：计数是事实，score 由服务端按计数/来源派生）。",
      },
      explicit_ack_count: { type: "integer" },
      unobjected_ack_count: { type: "integer" },
      oppose_count: { type: "integer" },
      cross_session_count: { type: "integer" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...ENTRY_FIELDS,
          message: { type: "string", required: true },
        },
      },
      render: (_args, value) => [
        {
          type: "text",
          text:
            `## 记忆写入成功（${value.status}）\n\n${renderEntry(value)}\n\n` +
            `**信任纪律（设计 §4 v1.3）**：origin=${value.origin ?? "sagitta（缺省）"} → 初始 score=${value.score}、` +
            `status=${value.status}；后续信任爬升只经 ack 信号（explicit +2 / unobjected +1 / oppose −3）自动联动，` +
            `插件/你不能在提交参数里直接改 status 或 score。`,
        },
      ],
      presentationMeta: (_args, value) => ({
        target: `${value.stream}/${value.id}`,
        status: value.status,
        type: value.type,
        score: value.score,
      }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // stream 走 URL 路径（POST /mem/{stream}），body 只带素材字段；管理字段
      // （id/created/status/score）由服务端生成，插件不提交状态。
      const body = {
        type: args.type,
        content: args.content,
        ...(args.origin ? { origin: args.origin } : {}),
        ...(args.domain ? { domain: args.domain } : {}),
        ...(Array.isArray(args.tags) && args.tags.length ? { tags: args.tags } : {}),
        ...(args.condition ? { condition: args.condition } : {}),
        ...(args.evidence ? { evidence: args.evidence } : {}),
        ...(args.source_task_id ? { source_task_id: args.source_task_id } : {}),
        ...(Array.isArray(args.supersedes) && args.supersedes.length ? { supersedes: args.supersedes } : {}),
        ...(args.pinned === true ? { pinned: true } : {}),
        ...(Number.isInteger(args.ack_count) && args.ack_count > 0 ? { ack_count: args.ack_count } : {}),
        ...(Number.isInteger(args.explicit_ack_count) && args.explicit_ack_count > 0 ? { explicit_ack_count: args.explicit_ack_count } : {}),
        ...(Number.isInteger(args.unobjected_ack_count) && args.unobjected_ack_count > 0 ? { unobjected_ack_count: args.unobjected_ack_count } : {}),
        ...(Number.isInteger(args.oppose_count) && args.oppose_count > 0 ? { oppose_count: args.oppose_count } : {}),
        ...(Number.isInteger(args.cross_session_count) && args.cross_session_count > 0 ? { cross_session_count: args.cross_session_count } : {}),
      };
      const created = await client.createEntry(args.stream, body, exec.signal);
      const entry = pickEntry(created);
      return {
        ...entry,
        message: `已写入 ${args.stream} 流：${created.id}（origin=${entry.origin ?? "sagitta（缺省）"} → score=${entry.score}，status=${entry.status}）`,
      };
    },
    presentCall: (args) => presentCall("remember", args, `stream=${args.stream} type=${args.type} origin=${args.origin || "sagitta"}`),
  }));

  ctx.tools.register(defineTool({
    name: "memory_recall",
    description:
      "检索 Sagitta 记忆（设计 §10 recall）：按 stream+domain 目录树钻取、单条复查（id）、或关键词检索（LIKE，v1 禁 embedding）。" +
      "三种模式：给 id → 单条；给 query → 服务端关键词检索（可加 stream/type/domain/status/tags 过滤）；否则 → 按 stream 列表 + 过滤。" +
      "v1.3：recall 默认排除 archived/superseded（终态不作为经验召回）——除非显式传 status 过滤请求它们；" +
      "返回条目带 trust_level/trust_hint（服务端按 score 生成：0~1 低信任提示 / 2 无提示 / 3 已固化建议遵循）" +
      "与 validated 事件（事件 explanation 可作解释性 few-shot）。默认不跨流混注入（设计 §7 L1 规则），跨流检索请显式对每个 stream 分别调用。",
    parameters: {
      id: {
        type: "string",
        description: "单条条目 id（优先级最高；此时必须同时给 stream）。",
      },
      stream: {
        type: "string",
        enum: STREAMS,
        description: "归属流过滤（四流之一）。单条模式必填；列表模式必填；检索模式可选。",
      },
      query: {
        type: "string",
        description: "关键词（检索模式必填；匹配 content/condition/tags/domain/id 五路，LIKE）。",
      },
      type: { type: "string", enum: TYPES, description: "类型过滤（设计 §3 枚举）。" },
      domain: { type: "string", description: "域前缀过滤（层级目录树逐级展开）。" },
      status: { type: "string", enum: STATUSES, description: "状态过滤（设计 §4 枚举）。**默认排除 archived/superseded**——需要查看终态条目时显式传 status=archived 或 status=superseded。" },
      tags: { type: "array", items: { type: "string" }, description: "标签过滤（同时命中全部给定标签）。" },
      page: { type: "integer", description: "页码，从 1 开始（默认 1）。" },
      size: { type: "integer", description: "每页数量，1–100（默认 20）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true, enum: ["list", "search", "entry"] },
          stream: { type: "string" },
          total: { type: "integer" },
          page: { type: "integer" },
          size: { type: "integer" },
          query: { type: "string" },
          entries: { type: "array", items: ENTRY_SCHEMA },
        },
      },
      render: (_args, value) => {
        const head = `## 记忆检索（${value.mode}${value.query ? ` · 关键词「${value.query}」` : ""}）\n`;
        const count = `命中 ${value.total ?? (value.entries ? value.entries.length : 0)} 条` +
          (value.page ? `（第 ${value.page} 页）` : "") + "\n";
        if (!value.entries || value.entries.length === 0) {
          return [{ type: "text", text: head + count + "\n（无结果——可放宽 domain/tags/status 过滤，或换关键词）" }];
        }
        return [{
          type: "text",
          text: head + count + "\n" + value.entries.map((e) => renderEntry(e)).join("\n"),
        }];
      },
      presentationMeta: (_args, value) => ({ mode: value.mode, total: value.total }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.id) {
        if (!args.stream) throw new Error("单条复查需要 stream（GET /mem/{stream}/{id} 归属校验，设计 §3）。");
        const entry = await client.getEntry(args.stream, args.id, exec.signal);
        return { mode: "entry", stream: args.stream, entries: [pickEntry(entry)] };
      }
      if (args.query) {
        const data = await client.search(args, exec.signal);
        return {
          mode: "search",
          ...(args.stream ? { stream: args.stream } : {}),
          query: args.query,
          total: data.total,
          ...(data.page !== undefined ? { page: data.page } : {}),
          ...(data.size !== undefined ? { size: data.size } : {}),
          entries: (data.items || []).map(pickEntry),
        };
      }
      if (!args.stream) {
        throw new Error("缺少检索维度：给 id（+stream）、query（关键词检索）或 stream（列表钻取）三者之一。");
      }
      const data = await client.listEntries(
        args.stream,
        { page: args.page, size: args.size, type: args.type, domain: args.domain, status: args.status },
        exec.signal
      );
      return {
        mode: "list",
        stream: args.stream,
        total: data.total,
        page: data.page,
        size: data.size,
        entries: (data.items || []).map(pickEntry),
      };
    },
    presentCall: (args) => presentCall("recall", args, args.query ? `query=${JSON.stringify(args.query)}` : `stream=${args.stream || ""}`),
  }));

  ctx.tools.register(defineTool({
    name: "memory_consolidate",
    description:
      "治理动作集（设计 §10 consolidate / §5，v1.3 语义：consolidate 不再是状态升级的唯一通道——" +
      "升级已由 ack 提交自动联动（score≥1→digested、score≥2→corroborated）；这里做批量复核与治理）：\n" +
      "- `validate`：事件化验证——写入 validation_events（event_type='validated'）⇒ 条目 validated 事实、" +
      "score=3 固化档；**blind_spot 必填**（该经验未涉及的盲点，missing 即服务端整体 422）；" +
      "explanation 可作召回时的解释性 few-shot；linked_delegation_id 可关联 delegation 验证结果。\n" +
      "- `replace`：整体更换（涟漪拍板：经验过时/被相反经验推翻时，给一个更换指令更新——" +
      "所有描述更换掉，更新后分数按新 origin 重置：ripple→score=2 / sagitta→score=0；" +
      "旧内容写入 replaced 事件仅审计留痕，不参与 recall；可对软归档条目改写为相反经验）。\n" +
      "- `archive`：治理归档（status=archived + archived 事件留痕；pinned 条目拒绝归档——设计 §5）。\n" +
      "- `digest`/`corroborate`：兜底动作（存量数据/复核用；正常已由 ack 自动完成）。\n" +
      "简写形态 {ids, action, blind_spot?, explanation?, linked_delegation_id?, origin?, content?, condition?, tags?} " +
      "或精确形态 {items:[{id, action, ...同上逐条}]}。supersedes 一并处理（被取代旧条目标记 superseded 并挂链）。" +
      "任一校验失败 → 服务端整体 422 不写入（fail-loud）。",
    parameters: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "简写形态：要治理的条目 id 列表（action 对全部生效）。",
      },
      items: {
        type: "array",
        description: "精确形态：逐条指定动作与参数。",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            action: { type: "string", enum: CONSOLIDATE_ACTIONS, required: true },
            blind_spot: { type: "string", description: "action=validate 必填：该经验未涉及的盲点（缺失服务端 422）。" },
            explanation: { type: "string", description: "解释（validate 可作召回 few-shot；replace/archive 为原因说明）。" },
            linked_delegation_id: { type: "string", description: "action=validate 可空：关联 delegation 验证结果。" },
            origin: { type: "string", enum: ORIGINS, description: "action=replace 必填：更换后的提出者（决定分数重置）。" },
            content: { type: "string", description: "action=replace 必填：新的完整描述。" },
            condition: { type: "string", description: "action=replace 可填：新的适用边界。" },
            tags: { type: "array", items: { type: "string" }, description: "action=replace 可填：新的标签列表。" },
          },
        },
      },
      action: {
        type: "string",
        enum: CONSOLIDATE_ACTIONS,
        description: "简写形态的默认动作（digest|corroborate|validate|replace|archive，默认 digest）。",
      },
      blind_spot: { type: "string", description: "简写：action=validate 时必填（缺失服务端 422）。" },
      explanation: { type: "string", description: "简写：validate/replace/archive 的解释。" },
      linked_delegation_id: { type: "string", description: "简写：validate 可空，关联 delegation 验证结果。" },
      origin: { type: "string", enum: ORIGINS, description: "简写：action=replace 时必填。" },
      content: { type: "string", description: "简写：action=replace 时必填。" },
      condition: { type: "string", description: "简写：action=replace 可填。" },
      tags: { type: "array", items: { type: "string" }, description: "简写：action=replace 可填。" },
      supersedes: {
        type: "array",
        items: { type: "string" },
        description: "本批要取代的旧条目 id 列表（服务端对其标记 superseded 并挂 superseded_by）。",
      },
      superseding_id: {
        type: "string",
        description: "取代链目标条目 id（缺省为第一个被推进的条目）。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                action: { type: "string", required: true },
                from: { type: "string", required: true },
                to: { type: "string", required: true },
                changed: { type: "boolean", required: true },
                score: { type: "integer", description: "replace 后的重置分数（v1.3）。" },
                old_content: { type: "string", description: "replace 的旧内容（审计留痕回显，v1.3）。" },
                event_id: { type: "string", description: "写入的验证事件 id（validate/replace/archive）。" },
              },
            },
          },
          superseded: { type: "array", items: { type: "string" } },
          superseding_id: { type: "string" },
        },
      },
      render: (_args, value) => {
        const lines = ["## 记忆治理（consolidate）"];
        for (const r of value.results || []) {
          const state = r.changed ? `**${r.from} → ${r.to}**` : `${r.from} → ${r.to}（${r.changed ? "变更" : "幂等未变"}）`;
          let line = `- ${r.id} [${r.action}] ${state}`;
          if (r.action === "replace") {
            line += `（score 重置为 ${r.score}；旧内容已写入 replaced 事件仅审计）`;
          }
          if (r.action === "validate") {
            line += `（validated 事件已写入，score=3 固化档）`;
          }
          lines.push(line);
        }
        if (value.superseded && value.superseded.length > 0) {
          lines.push(`- 取代链：${value.superseded.join(", ")} → superseded（由 ${value.superseding_id || "?"} 取代）`);
        }
        lines.push("> fail-loud：如任一校验失败，服务端整体 422 且全部未写入，需按门槛补齐再重试。");
        return [{ type: "text", text: lines.join("\n") }];
      },
      presentationMeta: (_args, value) => ({ changed: (value.results || []).filter((r) => r.changed).length }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const optionalList = (arr) => {
        const list = Array.isArray(arr) ? arr : undefined;
        return list && list.length > 0 ? list : undefined;
      };
      const body = {
        supersedes: optionalList(args.supersedes),
        superseding_id: args.superseding_id,
        blind_spot: args.blind_spot,
        explanation: args.explanation,
        linked_delegation_id: args.linked_delegation_id,
        origin: args.origin,
        content: args.content,
        condition: args.condition,
        tags: args.tags,
      };
      for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
      if (Array.isArray(args.items) && args.items.length > 0) {
        // 精确形态：先本地拦下明显缺参的调用给指引（服务端仍会逐条把关，本地拦截只是省一次往返）
        for (const item of args.items) {
          const action = item.action;
          if (action === "validate" && !(typeof item.blind_spot === "string" && item.blind_spot.trim())) {
            throw new Error(
              `memory_consolidate：条目 ${item.id} 的 action=validate 缺 blind_spot——` +
              `validated 事件化必须补充该经验未涉及的盲点（设计 §4 v1.3 §C，缺失服务端直接 422）。`
            );
          }
          if (action === "replace" && !ORIGINS.includes(item.origin)) {
            throw new Error(
              `memory_consolidate：条目 ${item.id} 的 action=replace 缺 origin——` +
              `更换后信任按新 origin 重置（ripple→2 / sagitta→0，设计 §4 v1.3 §A/§D）。`
            );
          }
          if (action === "replace" && !(typeof item.content === "string" && item.content.trim())) {
            throw new Error(`memory_consolidate：条目 ${item.id} 的 action=replace 缺 content（整体更换描述必填，设计 §4 v1.3 §D）。`);
          }
        }
        body.items = args.items;
        return await client.consolidate(body, exec.signal);
      }
      if (!Array.isArray(args.ids) || args.ids.length === 0) {
        throw new Error("memory_consolidate 需要 ids（简写形态）或 items（精确形态），至少一条。");
      }
      const action = args.action || "digest";
      if (action === "validate" && !(typeof args.blind_spot === "string" && args.blind_spot.trim())) {
        throw new Error(
          `memory_consolidate：action=validate 缺 blind_spot——` +
          `validated 事件化必须补充该经验未涉及的盲点（设计 §4 v1.3 §C，缺失服务端直接 422）。`
        );
      }
      if (action === "replace" && !ORIGINS.includes(args.origin)) {
        throw new Error(
          `memory_consolidate：action=replace 缺 origin——更换后信任按新 origin 重置（ripple→2 / sagitta→0）。`
        );
      }
      if (action === "replace" && !(typeof args.content === "string" && args.content.trim())) {
        throw new Error(`memory_consolidate：action=replace 缺 content（整体更换描述必填）。`);
      }
      body.ids = args.ids;
      body.action = action;
      return await client.consolidate(body, exec.signal);
    },
    presentCall: (args) => presentCall("consolidate", args, `n=${(args.ids || args.items || []).length} action=${args.action || (args.items && args.items[0] && args.items[0].action) || ""}`),
  }));

  ctx.tools.register(defineTool({
    name: "memory_verify",
    description:
      "信任信号登记与验证结果复核（设计 §10 verify，v1.3 三态信任轨道）。三种用法：\n" +
      "1) ack 登记：给 entry_id + signal——explicit=涟漪明确开口（+2）；unobjected=我主动陈述后涟漪未反对（+1，" +
      "且必须 statement_source：引用本会话中我陈述过该立场的会话事件；没有陈述记录就不得登记，空缺≠默许）；" +
      "oppose=涟漪明确反对（−3，v1.3 新增——反对把信任分拉低，score<0 自动软归档）。\n" +
      "2) 验证复核：给 task_id 读取 delegation 的 verification_result（validated 已事件化，可经 validate 的 " +
      "linked_delegation_id 关联本记录）。\n" +
      "3) 只给 entry_id + stream 时返回条目现状（status/score/evidence 新鲜度复查）。",
    parameters: {
      entry_id: {
        type: "string",
        description: "目标条目 id（ack 登记或新鲜度复查用）。",
      },
      stream: {
        type: "string",
        enum: STREAMS,
        description: "条目归属流（单条复查必填；ack 登记不依赖 stream）。",
      },
      signal: {
        type: "string",
        enum: ACK_SIGNALS,
        description: "信任信号：explicit（涟漪明确开口，+2）| unobjected（我陈述后涟漪未反对，+1，需 statement_source）| oppose（涟漪明确反对，−3）。",
      },
      statement_source: {
        type: "string",
        description: "signal=unobjected 时必填：本会话中我主动陈述过该立场的会话事件引用（设计 §4 防后门；服务端缺此字段直接 422）。",
      },
      task_id: {
        type: "string",
        description: "delegation 任务 id（验证结果复核用，如 dlg-20260817-gotest）。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string", required: true, enum: ["ack", "entry", "delegation"] },
          id: { type: "string" },
          signal: { type: "string" },
          score: { type: "integer" },
          status: { type: "string" },
          ack_count: { type: "integer" },
          explicit_ack_count: { type: "integer" },
          unobjected_ack_count: { type: "integer" },
          oppose_count: { type: "integer" },
          archived: { type: "boolean" },
          evidence: { type: "string" },
          task_id: { type: "string" },
          delegatee: { type: "string" },
          command: { type: "string" },
          claimed_result: { type: "string" },
          verification_method: { type: "string" },
          verification_result: { type: "string" },
          artifacts: { type: "string" },
          outcome: { type: "string" },
          cost: { type: "string" },
          created: { type: "string" },
          message: { type: "string", required: true },
        },
      },
      render: (_args, value) => {
        switch (value.mode) {
          case "ack":
            return [{
              type: "text",
              text:
                `## 信任信号已登记（${value.signal}）\n\n` +
                `- 条目：${value.id}\n` +
                `- score=${value.score} → status=${value.status}${value.archived ? "（⚠ 已软归档：score 为负触发，涟漪拍板软归档而非硬删）" : ""}\n` +
                `- 计数：explicit ${value.explicit_ack_count} / unobjected ${value.unobjected_ack_count} / oppose ${value.oppose_count}\n` +
                `- 分档（设计 §4 v1.3）：score≥1→digested；score≥2→corroborated；score=3→固化档；` +
                `score<0→软归档；validated 由事件承载（memory_consolidate action=validate）。`,
            }];
          case "entry":
            return [{ type: "text", text: `## 条目现状复查\n\n${renderEntry(value)}` }];
          case "delegation":
            return [{
              type: "text",
              text:
                `## delegation 验证结果复核\n\n` +
                `- task_id：${value.task_id}\n` +
                `- delegatee：${value.delegatee}\n` +
                (value.command ? `- command：${value.command}\n` : "") +
                (value.claimed_result ? `- claimed_result（对方自报）：${excerpt(value.claimed_result, 400)}\n` : "") +
                (value.verification_method ? `- verification_method：${value.verification_method}\n` : "") +
                `- verification_result：**${value.verification_result ?? "（未验证）"}**\n` +
                (value.artifacts ? `- artifacts：${value.artifacts}\n` : "") +
                (value.outcome ? `- outcome：${value.outcome}\n` : "") +
                (value.cost ? `- cost：${value.cost}\n` : "") +
                (value.created ? `- created：${value.created}\n` : "") +
                `\n> 联动（v1.3）：验证事实经 consolidate action=validate 事件化时，可用 linked_delegation_id 关联本任务；` +
                `delegation 记录本身在记忆库独立留存（delegatee=ripple 仅涟漪实际背书触发）。`,
            }];
          default:
            return [{ type: "text", text: JSON.stringify(value) }];
        }
      },
      presentationMeta: (_args, value) => ({ mode: value.mode }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.task_id) {
        const d = await client.getDelegation(args.task_id, exec.signal);
        return {
          mode: "delegation",
          task_id: d.task_id,
          delegatee: d.delegatee,
          command: d.command,
          claimed_result: d.claimed_result,
          verification_method: d.verification_method,
          verification_result: d.verification_result,
          artifacts: d.artifacts,
          outcome: d.outcome,
          cost: d.cost,
          created: d.created,
          message: `delegation ${d.task_id} 验证结果：${d.verification_result ?? "未验证"}`,
        };
      }
      if (!args.entry_id) {
        throw new Error("memory_verify 需要 task_id（验证复核）或 entry_id（信任信号登记/现状复查）。");
      }
      if (args.signal) {
        if (args.signal === "unobjected" && !args.statement_source) {
          throw new Error(
            "memory_verify：signal=unobjected 必须带 statement_source——本会话中我主动陈述过该立场的会话事件引用。" +
            "（设计 §4 认可轨道防后门：AI 无权虚构\"我陈述过\"；空缺≠默许，服务端对此直接 422。）"
          );
        }
        const a = await client.ack(
          {
            id: args.entry_id,
            signal: args.signal,
            ...(args.statement_source ? { statement_source: args.statement_source } : {}),
          },
          exec.signal
        );
        return {
          mode: "ack",
          id: args.entry_id,
          signal: args.signal,
          score: a.score,
          status: a.status,
          archived: a.archived === true,
          ack_count: a.ack_count,
          explicit_ack_count: a.explicit_ack_count,
          unobjected_ack_count: a.unobjected_ack_count,
          oppose_count: a.oppose_count,
          message: `已登记 ${args.signal} 信号（${args.signal === "explicit" ? "+2" : args.signal === "oppose" ? "−3" : "+1"}）→ score=${a.score}，status=${a.status}${a.archived ? "（已软归档）" : ""}。`,
        };
      }
      if (!args.stream) {
        throw new Error("memory_verify：仅给 entry_id 时需同时给 stream 才能复查条目（GET /mem/{stream}/{id}）。");
      }
      const entry = await client.getEntry(args.stream, args.entry_id, exec.signal);
      const e = pickEntry(entry);
      return { ...e, mode: "entry", message: `条目 ${e.id} 现状：${e.status}（evidence=${e.evidence}，score=${e.score}）。` };
    },
    presentCall: (args) => presentCall("verify", args, args.task_id ? `task=${args.task_id}` : `entry=${args.entry_id || ""} signal=${args.signal || ""}`),
  }));

  // ---- task API（docs/task-api-p1.md §1；/task 路由 2026-08-30 部署上线）----
  // 任务管理（个人/公司项目待办）走云端 D1 tasks 表，与 memory 条目独立。
  // 状态机：open | in_progress | blocked | waiting | done；priority 0普通/1高/2紧急；
  // checkbox=1 表示"涟漪待处理"项（auto-advance 悬浮窗"待处理需求"区读 GET /task?checkbox=1&status=open）。
  // archived=1 为软删（列表/搜索默认排除）；done/blocked 通过 pending + confirm 才成为终态。
  // 认领制（task-ownership-p2 §6）：task_list 投影 claim_state（unclaimed|claimed，"mine" 由模型按
  // 已持有 claim_token 本地判断）；task_claim 认领（成功唯一一次下发 claim_token，模型持有）；
  // task_release 释放（需 task_id+claim_token）；owner_agent_id/claim_token 不进 TASK_FIELDS 投影。

  const nullableString = () => ({ oneOf: [{ type: "string" }, { type: "null" }] });
  const nullablePendingStatus = () => ({
    oneOf: [
      { type: "string", enum: ["pending_done", "pending_blocked"] },
      { type: "null" },
    ],
  });
  const TASK_FIELDS = {
    id: { type: "string", required: true },
    task_id: { type: "string" },
    kind: { type: "string", required: true, enum: ["normal", "temp"] },
    project: { type: "string", required: true },
    title: { type: "string", required: true },
    status: { type: "string", required: true },
    priority: { type: "integer", required: true },
    checkbox: { type: "integer", required: true },
    stream: { type: "string", required: true },
    body: { type: "string" },
    created_at: { type: "string", required: true },
    updated_at: nullableString(),
    done_at: nullableString(),
    blocked_reason: nullableString(),
    pending_status: nullablePendingStatus(),
    confirmation_id: nullableString(),
    idempotent: { type: "boolean" },
    archived: { type: "integer", required: true },
    // task-ownership-p2 §6：认领状态（unclaimed=未认领可认领；claimed=他人认领中、租约内）。
    // "mine" 由调用方按已持有 claim_token 本地判断，Worker 不下发、工具不声明；
    // owner_agent_id / claim_token 刻意不进投影（owner 对模型无感知；token 只在 claim 响应下发一次）。
    claim_state: { type: "string", enum: ["unclaimed", "claimed"] },
  };
  const TASK_STATUSES = ["open", "in_progress", "blocked", "waiting", "done"];
  const TASK_CREATE_STATUSES = ["open", "in_progress", "waiting"];
  const TASK_KINDS = ["normal", "temp"];
  const TASK_STREAMS = [...STREAMS, "company"];
  const NEED_HUMAN_STATUSES = ["open", "resolved"];
  const NEED_HUMAN_RESOLVE_KINDS = ["solved", "abandoned"];
  const NEED_HUMAN_TYPES = ["need", "notify"];
  const NEED_HUMAN_FIELDS = {
    nh_id: { type: "string", required: true },
    task_id: { type: "string", required: true },
    type: { type: "string", required: true, enum: NEED_HUMAN_TYPES },
    content: { type: "string", required: true },
    suggestion: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
    status: { type: "string", required: true, enum: NEED_HUMAN_STATUSES },
    resolve_kind: { oneOf: [{ type: "string", enum: NEED_HUMAN_RESOLVE_KINDS }, { type: "null" }], required: true },
    created_at: { type: "string", required: true },
    resolved_at: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
    updated_at: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  };

  ctx.tools.register(defineTool({
    name: "task_list",
    description:
      "任务列表（云端 D1 tasks 表，docs/task-api-p1.md）：按 project/stream/status/checkbox 过滤；" +
      "支持 kind=normal|temp；默认只列 normal，并额外带回当前 agent 自己认领的 temp；显式 kind=temp 才列 temp 任务；" +
      "默认排除 archived（软删）。返回 status/pending_status/blocked_reason/updated_at/done_at；" +
      "done/blocked 只有 pending_done/pending_blocked 申请并经 task_confirm accept 后才是终态，pending 时带 confirmation_id；" +
      "checkbox=1&status=open 等价 auto-advance 悬浮窗的\"待处理需求\"视图。\n" +
      "每条任务带 claim_state（task-ownership-p2）：unclaimed=未认领（可认领）；claimed=他人认领中（租约内），" +
      "未认领才可认领。若你持有某任务的 claim_token（task_claim 成功响应唯一一次下发），该任务即视为你自己认领的（mine），" +
      "可继续推进或 task_release 释放；token 不在此列表中出现，请勿向任何日志/记忆写入 token。",
    parameters: {
      project: { type: "string", description: "项目过滤（如 research/lmy-diffusion-accel、sagitta-agent）。" },
      stream: { type: "string", enum: TASK_STREAMS, description: "流过滤：personal-projects | company-projects | sagitta | ripple | company。" },
      status: { type: "string", enum: TASK_STATUSES, description: "状态过滤。" },
      kind: { type: "string", enum: TASK_KINDS, description: "任务类型；不传=normal + 当前 agent 已认领的 temp。" },
      checkbox: { type: "integer", description: "1=只列涟漪待处理项；0=只列非 checkbox 项。" },
      page: { type: "integer" },
      size: { type: "integer", description: "每页数量（默认 50）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer", required: true },
          items: { type: "array", items: { type: "object", additionalProperties: false, properties: TASK_FIELDS } },
        },
      },
      render: (_args, value) => {
        const head = `## 任务列表（${value.total} 项）\n`;
        if (!value.items || value.items.length === 0) return [{ type: "text", text: head + "（无任务）" }];
        const lines = value.items.map((t) => {
          const cb = t.checkbox === 1 ? "☐" : "·";
          const st = t.status === "done" ? "✅" : t.status === "blocked" ? "🚩" : t.status === "in_progress" ? "🔄" : t.status === "waiting" ? "⏳" : "□";
          const pending = t.pending_status ? ` · ${t.pending_status}待确认` : "";
          const claim = t.claim_state === "claimed" ? " · 🔒他人认领中" : "";
          return `${cb} ${st} **${t.title}**（${t.project} · ${t.id}${t.priority > 0 ? ` · P${t.priority}` : ""}${pending}${claim}）`;
        });
        return [{ type: "text", text: head + lines.join("\n") }];
      },
      presentationMeta: (_args, value) => ({ total: value.total }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filters = {
        project: args.project,
        stream: args.stream,
        status: args.status,
        checkbox: args.checkbox,
        agentId: String(exec?.agent?.id ?? "unknown"),
        page: args.page,
        size: args.size,
      };
      if (args.kind) {
        return taskListData(await client.listTasks({ ...filters, kind: args.kind }, exec.signal), args.kind);
      }
      // Worker 的 include_temp=1 内部按当前 owner 只补回自己仍在租约内的
      // temp；owner_agent_id 不出响应，也不需要插件自行拼接/暴露 owner。
      return taskListData(await client.listTasks({ ...filters, includeTemp: 1 }, exec.signal));
    },
    presentCall: (args) => presentCall("task_list", args, `project=${args.project || ""} kind=${args.kind || "default"} status=${args.status || ""} checkbox=${args.checkbox ?? ""}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_need_human",
    description:
      "给任务记一条 need-human（POST /task/{id}/need-human）。type=need（默认）表示需要涟漪参与才能继续，" +
      "存在 open 条目时会阻塞该任务 done；type=notify 表示仅告知涟漪、不阻塞 done，" +
      "由涟漪前端点击确认关闭。need 条目由涟漪处理后用 task_need_human_resolve 解除。",
    parameters: {
      task_id: { type: "string", required: true, description: "挂载该 need-human 的任务 id。" },
      content: { type: "string", required: true, description: "需要涟漪参与/决定的具体内容。" },
      suggestion: { type: "string", description: "给涟漪的可选建议或候选方案。" },
      type: { type: "string", enum: NEED_HUMAN_TYPES, description: "need（默认：需要涟漪参与，阻塞 done）或 notify（告知涟漪，不阻塞 done，涟漪前端确认关闭）。" },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ...NEED_HUMAN_FIELDS, message: { type: "string", required: true } } },
      render: (_args, value) => [{
        type: "text",
        text: `## need-human 已记录\n\n- nh_id：${value.nh_id}\n- task_id：${value.task_id}\n- type：${value.type}\n- 内容：${value.content}${value.suggestion ? `\n- 建议：${value.suggestion}` : ""}\n\n${value.message}`,
      }],
      presentationMeta: (_args, value) => ({ nh_id: value.nh_id, task_id: value.task_id, type: value.type, status: value.status }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) throw taskContractError("NEED_HUMAN_CONTENT_REQUIRED", "need-human content 必填");
      const suggestion = typeof args.suggestion === "string" ? args.suggestion.trim() : "";
      const type = args.type || "need";
      const created = await client.createNeedHuman(args.task_id, content, suggestion || undefined, type, exec.signal);
      const item = pickNeedHuman(created);
      return {
        ...item,
        message: item.type === "notify"
          ? `已为任务 ${item.task_id || args.task_id} 记录 notify 条目 ${item.nh_id}（status=${item.status}）；该条目不阻塞 done，由涟漪前端确认关闭。`
          : `已为任务 ${item.task_id || args.task_id} 记录 need 条目 ${item.nh_id}（status=${item.status}）；涟漪处理后请调用 task_need_human_resolve。`,
      };
    },
    presentCall: (args) => presentCall("task_need_human", args, `task=${args.task_id} type=${args.type || "need"}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_need_human_resolve",
    description:
      "解除一条 need-human（POST /task/need-human/{nh_id}/resolve）。resolve_kind=solved 表示已解决，" +
      "resolve_kind=abandoned 表示算了不做；缺省按 Worker 默认处理。type 会随条目输出并保留；notify 通常由涟漪前端确认关闭。",
    parameters: {
      nh_id: { type: "string", required: true, description: "need-human id。" },
      resolve_kind: { type: "string", enum: NEED_HUMAN_RESOLVE_KINDS, description: "solved（解决）或 abandoned（放弃）。" },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ...NEED_HUMAN_FIELDS, message: { type: "string", required: true } } },
      render: (_args, value) => [{
        type: "text",
        text: `## need-human 已解除\n\n- nh_id：${value.nh_id}\n- task_id：${value.task_id}\n- type：${value.type}\n- 结果：${value.resolve_kind || "（Worker 默认）"}\n- status：${value.status}\n\n${value.message}`,
      }],
      presentationMeta: (_args, value) => ({ nh_id: value.nh_id, task_id: value.task_id, type: value.type, status: value.status, resolve_kind: value.resolve_kind }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const resolved = await client.resolveNeedHuman(args.nh_id, args.resolve_kind, exec.signal);
      const item = pickNeedHuman(resolved);
      // Current Worker responses do not echo resolve_kind; preserve the
      // caller's explicit choice in the tool projection when that happens.
      if (args.resolve_kind && item.resolve_kind === null) item.resolve_kind = args.resolve_kind;
      return {
        ...item,
        message: `已解除 need-human ${item.nh_id || args.nh_id}（${item.resolve_kind || args.resolve_kind || "Worker 默认"}）；若它是任务最后一条 open need-human，Worker 可据状态机继续处理该任务。`,
      };
    },
    presentCall: (args) => presentCall("task_need_human_resolve", args, `nh=${args.nh_id} kind=${args.resolve_kind || "default"}`),
  }));

  ctx.tools.register(defineTool({
    name: "need_human_list",
    description:
      "跨任务汇聚 need-human（GET /need-human）。默认只列 status=open 的待涟漪处理项；" +
      "每条输出带 type：need 阻塞 done，notify 不阻塞 done；显式传 status=resolved 可查历史已解除条目。",
    parameters: {
      status: { type: "string", enum: NEED_HUMAN_STATUSES, description: "默认 open；可传 resolved 查看已解除条目。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", required: true, enum: NEED_HUMAN_STATUSES },
          total: { type: "integer", required: true },
          items: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: NEED_HUMAN_FIELDS } },
          message: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.items.length === 0
          ? `## need-human 列表（${value.status}）\n\n（无条目）\n\n${value.message}`
          : `## need-human 列表（${value.status}，${value.total} 条）\n\n` +
            value.items.map((item) => `- **${item.nh_id}** · task=${item.task_id} · type=${item.type} · ${item.content}${item.suggestion ? `（建议：${item.suggestion}）` : ""}`).join("\n") +
            `\n\n${value.message}`,
      }],
      presentationMeta: (_args, value) => ({ status: value.status, total: value.total }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const status = args.status || "open";
      const data = await client.listNeedHuman(status, exec.signal);
      const rawItems = data?.items || data?.need_humans || data?.needHuman || [];
      const items = rawItems.map(pickNeedHuman);
      return {
        status,
        total: Number.isInteger(data?.total) ? data.total : items.length,
        items,
        message: status === "open"
          ? "这些条目就是当前待涟漪处理事项；need 由涟漪处理后调用 task_need_human_resolve，notify 由涟漪前端确认关闭。"
          : `已列出 status=${status} 的 need-human 历史条目。`,
      };
    },
    presentCall: (args) => presentCall("need_human_list", args, `status=${args.status || "open"}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_assert_bound",
    description:
      "执行型工具的任务绑定自查。传 task_id 时检查该任务是否是当前 agent 已认领且仍为 in_progress 的 normal/temp；" +
      "不传时检查当前 agent 是否至少有一个这样的认领。无绑定会拒绝并提示先 task_claim。",
    parameters: {
      task_id: { type: "string", description: "可选的明确任务 id；不传则检查当前 agent 的全部本地认领。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          bound: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                task_id: { type: "string", required: true },
                kind: { type: "string", required: true, enum: ["normal", "temp"] },
                status: { type: "string", required: true, const: "in_progress" },
              },
            },
          },
          message: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `## 任务门禁自查通过\n\n${value.message}\n` +
          value.bound.map((item) => `- ${item.task_id}（${item.kind} · ${item.status}）`).join("\n"),
      }],
      presentationMeta: (_args, value) => ({ boundCount: value.bound.length, taskIds: value.bound.map((item) => item.task_id) }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const bound = taskGate.assertBound(args.task_id, exec.agent).map((item) => ({
        task_id: item.taskId,
        kind: item.kind,
        status: item.status,
      }));
      if (bound.length === 0) {
        throw taskContractError(
          "TASK_NOT_BOUND",
          args.task_id
            ? `task_id=${args.task_id} 尚未被当前 agent 认领；请先调用 task_claim`
            : "当前 agent 没有已认领的 in_progress normal/temp 任务；请先调用 task_claim"
        );
      }
      return {
        bound,
        message: args.task_id
          ? `task_id=${args.task_id} 已绑定，可执行重活。`
          : "当前 agent 至少有一个已认领任务，可执行重活。",
      };
    },
    presentCall: (args) => presentCall("task_assert_bound", args, `task=${args.task_id || "current"}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_create",
    description:
      "创建任务（云端 D1 tasks 表）：kind=normal|temp（默认 normal）；normal 任务需 project，temp 可不传 project；title 必填；status 默认 open；priority 默认 0；" +
      "checkbox=1 表示涟漪待处理项（会出现在悬浮窗\"待处理需求\"区）；stream 默认 company。管理字段由服务端生成。",
    parameters: {
      kind: { type: "string", enum: TASK_KINDS, description: "normal（默认，正式任务）或 temp（临时小事；可无 project）。" },
      project: { type: "string", description: "所属项目；normal 必填，temp 可省略。" },
      title: { type: "string", required: true, description: "条目一行描述。" },
      status: { type: "string", enum: TASK_CREATE_STATUSES, description: "默认 open；done/blocked 必须通过 task_update 或 task_round_close 申请后再 task_confirm。" },
      priority: { type: "integer", description: "0 普通 / 1 高 / 2 紧急（默认 0）。" },
      checkbox: { type: "boolean", description: "true=涟漪待处理项（默认 false）。" },
      stream: { type: "string", enum: TASK_STREAMS, description: "默认 company。" },
      body: { type: "string", description: "内嵌描述/notes。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ...TASK_FIELDS, message: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: `## 任务已创建\n\n**${value.title}**（${value.id} · ${value.project} · ${value.status}${value.checkbox === 1 ? " · ☐待处理" : ""}）` }],
      presentationMeta: (_args, value) => ({ id: value.id, project: value.project }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const kind = args.kind || "normal";
      const project = typeof args.project === "string" ? args.project.trim() : "";
      if (kind === "normal" && !project) throw new Error("task_create：normal 任务必须提供 project；temp 任务可省略 project。");
      const body = {
        kind,
        ...(project ? { project } : {}),
        title: args.title.trim(),
        ...(args.status ? { status: args.status } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.checkbox !== undefined ? { checkbox: args.checkbox === true ? 1 : 0 } : {}),
        ...(args.stream ? { stream: args.stream } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
      };
      const created = await client.createTask(body, exec.signal);
      return { ...pickTask(created), message: `已创建任务 ${created.id}` };
    },
    presentCall: (args) => presentCall("task_create", args, `kind=${args.kind || "normal"} project=${args.project || ""} title=${JSON.stringify(args.title).slice(0, 40)}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_update",
    description:
      "更新任务（PATCH /task/{id}）：参数白名单仅为 status/priority/body/title/checkbox/blocked_reason，" +
      "可带 expected_updated_at；不得传 done_at、pending_status 或 confirm。" +
      "status=done/blocked 只是申请 pending_done/pending_blocked，返回 confirmation_id 与 updated_at，" +
      "必须再用 task_confirm accept 才进入终态；status=blocked 时 blocked_reason 必填。task_id 可从 task_list 获取。\n" +
      "认领制（task-ownership-p2）：任务被他人认领（claim_state=claimed，租约内）时，PATCH status=in_progress " +
      "会被服务端 409 TASK_ALREADY_CLAIMED 拒绝——需先 task_claim 认领（或等待租约过期后再更新）。",
    parameters: {
      task_id: { type: "string", required: true, description: "任务 id（tsk-YYYYMMDD-xxxxxx）。" },
      title: { type: "string" },
      status: { type: "string", enum: TASK_STATUSES },
      priority: { type: "integer" },
      body: { type: "string" },
      checkbox: { type: "boolean" },
      blocked_reason: { type: "string", description: "申请 blocked 时必填的非空阻塞原因；done 申请不得设置。" },
      expected_updated_at: { type: "string", description: "可选版本条件；必须等于当前 updated_at。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ...TASK_FIELDS, message: { type: "string", required: true } },
      },
      render: (_args, value) => {
        if (value.pending_status) {
          return [{
            type: "text",
            text: `## 已提交终态申请（待确认）\n\n**${value.title}**（${value.id} · ${value.pending_status}）\n` +
              `当前仍是 ${value.status}，尚未${value.pending_status === "pending_blocked" ? "阻塞" : "完成"}；` +
              `请使用 task_confirm accept（confirmation_id=${value.confirmation_id || "缺失"}，updated_at=${value.updated_at || "缺失"}）。`,
          }];
        }
        return [{ type: "text", text: `## 任务已更新\n\n**${value.title}**（${value.id} · ${value.status}）` }];
      },
      presentationMeta: (_args, value) => ({ id: value.id, status: value.status }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      validateTaskUpdate(args);
      const body = {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.checkbox !== undefined ? { checkbox: args.checkbox === true ? 1 : 0 } : {}),
        ...(args.blocked_reason !== undefined ? { blocked_reason: args.blocked_reason } : {}),
        ...(args.expected_updated_at !== undefined ? { expected_updated_at: args.expected_updated_at } : {}),
      };
      if (Object.keys(body).length === 0) throw new Error("task_update 至少需要更新一个字段。");
      const updated = await client.patchTask(args.task_id, body, exec.signal, String(exec?.agent?.id ?? "unknown"));
      const task = pickTask(updated);
      // Worker 将非终态任务切到 waiting/open 时会同时释放租约；同步本地
      // 非敏感绑定，避免后续执行型工具误把旧认领当作仍然有效。
      if (task.status === "waiting" || task.status === "open") {
        taskGate.forgetClaim(task.id || args.task_id, exec.agent);
      }
      const message = task.pending_status
        ? `已提交 ${task.pending_status} 申请（任务仍为 ${task.status}，未进入终态）；请用 task_confirm accept 确认，confirmation_id=${task.confirmation_id || "缺失"}，updated_at=${task.updated_at || "缺失"}`
        : `已更新任务 ${task.id}`;
      return { ...task, message };
    },
    presentCall: (args) => presentCall("task_update", args, `id=${args.task_id} status=${args.status || ""}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_claim",
    description:
      "原子认领任务（task-ownership-p2 §4.1；POST /task/{id}/claim）：仅当任务未认领（claim_state=unclaimed，" +
      "即 status='open'，或 in_progress 且租约已过期/无 owner）时成功；认领后任务置 in_progress 并进入你的租约，" +
      "他人不可再认领/绕过直接推进。成功响应**唯一一次**下发 claim_token（模型获得 token 的唯一途径）——" +
      "请在本会话内存中保管，后续 task_release 释放需要它；token 绝不出现在任何列表/日志/记忆条目。\n" +
      "失败原样透出：409 TASK_ALREADY_CLAIMED（他人认领中/状态不允许）、409 TASK_PENDING_CONFLICT（已有终态申请在途）、" +
      "422 INVALID_LEASE_SECONDS（lease_seconds 非法）。",
    parameters: {
      task_id: { type: "string", required: true, description: "任务 id（tsk-YYYYMMDD-xxxxxx）。" },
      lease_seconds: { type: "integer", description: "认领租约秒数（1~604800；缺省=全局默认 24h）。租约过期自动释放，进程退出即自然回收。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...TASK_FIELDS,
          // claim_token 只在 claim 响应出现一次：不在 TASK_FIELDS（列表/详情投影），
          // 由本工具从原始响应显式取出并随返回值下发（模型持有）。
          claim_token: { type: "string", required: true },
          message: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text:
          `## 任务已认领\n\n**${value.title}**（${value.id} · ${value.project} · status=${value.status}）\n` +
          `- claim_state=${value.claim_state ?? "claimed"}（租约内，他人不可认领）\n` +
          `- ⚠ 已向你下发 claim_token（不在列表/日志/记忆回显）；本会话内保管，task_release 释放时需要它\n\n` +
          value.message,
      }],
      presentationMeta: (_args, value) => ({ id: value.id, status: value.status, claim_state: value.claim_state ?? "claimed" }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // 本地先拦明显非法的租约（省一次往返；服务端仍把关，错误码一致）
      const leaseSeconds = validateClaimLease(args.lease_seconds);
      const claimed = await client.claimTask(
        args.task_id,
        { leaseSeconds, agentId: String(exec?.agent?.id ?? "unknown") },
        exec.signal
      );
      const task = pickTask(claimed);
      const token = typeof claimed.claim_token === "string" && claimed.claim_token.length > 0 ? claimed.claim_token : null;
      if (!token) {
        throw new Error(
          `task_claim：认领成功但响应缺少 claim_token（任务 ${task.id} 已置 in_progress）——` +
          `请重试 task_claim，或直接用 task_update 推进并依赖服务端租约判定。`
        );
      }
      taskGate.recordClaim(task, exec.agent);
      let memoryNote = "";
      if (task.project) {
        try {
          memoryNote = (await recallProjectMemory(client, task, exec.signal)).note;
        } catch (error) {
          // 认领已由 Worker 成功提交；项目记忆是附加上下文，召回失败不
          // 回滚认领，但必须把缺口显式告诉模型，避免伪装成已注入。
          memoryNote = `项目记忆暂未召回（${error?.message ?? String(error)}）；如需更多项目背景，可调用 memory_recall domain=projects/${task.project} 查询`;
        }
      }
      return {
        ...task,
        claim_token: token,
        message:
          `已认领任务 ${task.id}（claim_state=${task.claim_state ?? "claimed"}）；claim_token 仅本次返回，请在本会话内存中保管（task_release 释放需要它）。` +
          (memoryNote ? `\n\n${memoryNote}` : ""),
      };
    },
    presentCall: (args) => presentCall("claim", args, `id=${args.task_id} lease=${args.lease_seconds ?? "default"}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_release",
    description:
      "释放任务认领（task-ownership-p2 §4.2；POST /task/{id}/release）：仅持有正确 claim_token 的调用方可释放。" +
      "成功：清空认领（claim_state=unclaimed），in_progress 且无 pending 时 status 回 open。\n" +
      "失败原样透出：403 CLAIM_TOKEN_MISMATCH（token 不匹配/该任务未被你认领——认领凭证只在 claim 响应下发一次，" +
      "丢失则失去对该任务的继续操作权，可等租约过期后重新认领）、422 CLAIM_TOKEN_REQUIRED（token 缺失）、" +
      "404 TASK_NOT_FOUND。token 属敏感凭证：只传 task_id+claim_token，绝不写入日志/记忆/任何持久化。",
    parameters: {
      task_id: { type: "string", required: true, description: "任务 id（tsk-YYYYMMDD-xxxxxx）。" },
      claim_token: { type: "string", required: true, description: "认领时唯一一次下发的凭证（task_claim 成功响应返回，只存本会话内存）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ...TASK_FIELDS, message: { type: "string", required: true } },
      },
      render: (_args, value) => [{
        type: "text",
        text:
          `## 认领已释放\n\n**${value.title}**（${value.id} · ${value.project} · status=${value.status}）\n` +
          `- claim_state=${value.claim_state ?? "unclaimed"}（未认领，可被重新认领）`,
      }],
      presentationMeta: (_args, value) => ({ id: value.id, status: value.status, claim_state: value.claim_state ?? "unclaimed" }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const released = await client.releaseTask(args.task_id, args.claim_token, exec.signal);
      const task = pickTask(released);
      taskGate.forgetClaim(task.id || args.task_id, exec.agent);
      return {
        ...task,
        message: `已释放任务 ${task.id} 的认领（claim_state=${task.claim_state ?? "unclaimed"}${task.status === "open" ? "，任务已回到未认领" : `，status=${task.status}`}）。`,
      };
    },
    // 自定义 presentCall：rawInput 刻意不含 claim_token（凭证不进任何输出/展示）
    presentCall: (args) => ({
      card: "generic",
      title: `memory: task_release — id=${args.task_id}`,
      kind: "memory",
      rawInput: JSON.stringify({ task_id: args.task_id }),
    }),
  }));

  ctx.tools.register(defineTool({
    name: "task_confirm",
    description:
      "确认任务终态申请（POST /task/{id}/confirm）：只接受 accept 或 reopen，" +
      "必须同时提供 expected_pending、expected_updated_at、confirmation_id。accept 才会把 pending_done/pending_blocked " +
      "落为 done/blocked；reopen 会回到 in_progress；同一 confirmation_id 的相同重试幂等。",
    parameters: {
      task_id: { type: "string", required: true, description: "任务 id。" },
      decision: { type: "string", required: true, enum: ["accept", "reopen"] },
      expected_pending: { type: "string", required: true, enum: ["pending_done", "pending_blocked"] },
      expected_updated_at: { type: "string", required: true, description: "必须等于 pending 当前 updated_at。" },
      confirmation_id: { type: "string", required: true, description: "pending 返回的 confirmation_id。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          task_id: { type: "string", required: true },
          status: { type: "string", required: true },
          pending_status: nullablePendingStatus(),
          blocked_reason: nullableString(),
          done_at: nullableString(),
          updated_at: nullableString(),
          confirmation_id: { type: "string", required: true },
          idempotent: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.idempotent
          ? `## 任务确认幂等重试\n\n${value.task_id} 当前状态：${value.status}（confirmation_id=${value.confirmation_id}）`
          : `## 任务确认结果\n\n${value.task_id} → ${value.status}${value.pending_status ? `（${value.pending_status}，仍待确认）` : "（已确认）"}`,
      }],
      presentationMeta: (_args, value) => ({ task_id: value.task_id, status: value.status, idempotent: value.idempotent }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await client.confirmTask(args.task_id, {
        decision: args.decision,
        expected_pending: args.expected_pending,
        expected_updated_at: args.expected_updated_at,
        confirmation_id: args.confirmation_id,
      }, exec.signal);
      const task = pickTask(result);
      if (task.status === "done" || task.status === "blocked") taskGate.forgetAll(task.id || args.task_id);
      return {
        task_id: String(result.task_id ?? task.id ?? args.task_id),
        status: task.status,
        pending_status: task.pending_status,
        blocked_reason: task.blocked_reason,
        done_at: task.done_at,
        updated_at: task.updated_at,
        confirmation_id: String(result.confirmation_id ?? args.confirmation_id),
        idempotent: result.idempotent === true,
      };
    },
    presentCall: (args) => presentCall("task_confirm", args, `id=${args.task_id} decision=${args.decision}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_round_close",
    description:
      "关闭一个自主推进 round（POST /task/{id}/round-close）：progress 与 next 必填，" +
      "trim 后各 1–1000 个 Unicode 字符且不得含 NUL/控制字符/CR/LF；action 仅 update/done/blocked。" +
      "done/blocked 只申请 pending_done/pending_blocked，必须再 task_confirm；blocked_reason 仅 action=blocked 时必填。" +
      "同 task_id + 执行 agent + round_id 的相同内容重试幂等，不同内容返回冲突。",
    parameters: {
      task_id: { type: "string", required: true, description: "任务 id。" },
      round_id: { type: "string", required: true, description: "本轮唯一 id；同 task/agent 下用于幂等。" },
      action: { type: "string", required: true, enum: ["update", "done", "blocked"] },
      progress: { type: "string", required: true, description: "本轮进展摘要，trim 后 1–1000 字符，无控制字符或换行。" },
      next: { type: "string", required: true, description: "下一步摘要，trim 后 1–1000 字符，无控制字符或换行。" },
      blocked_reason: { type: "string", description: "action=blocked 时必填；其他 action 禁止设置。" },
      expected_updated_at: { type: "string", description: "done/blocked 必填；update 可选的版本条件。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...TASK_FIELDS,
          event_id: { type: "string", required: true },
          round_id: { type: "string", required: true },
          idempotent: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `## Round 已关闭${value.idempotent ? "（幂等重试）" : ""}\n\n` +
          `round_id=${value.round_id} · event_id=${value.event_id} · task=${value.id} · status=${value.status}` +
          `${value.pending_status ? ` · ${value.pending_status}（待 task_confirm，confirmation_id=${value.confirmation_id || "缺失"}）` : ""}`,
      }],
      presentationMeta: (_args, value) => ({ id: value.id, round_id: value.round_id, event_id: value.event_id, idempotent: value.idempotent }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const progress = validateRoundText(args.progress, "progress");
      const next = validateRoundText(args.next, "next");
      if (args.action === "blocked" && (typeof args.blocked_reason !== "string" || args.blocked_reason.trim().length === 0)) {
        throw taskContractError("BLOCKED_REASON_REQUIRED", "blocked_reason 必须是非空字符串");
      }
      if (args.action !== "blocked" && args.blocked_reason !== undefined) {
        throw taskContractError("INVALID_BLOCKED_REASON", "blocked_reason 只允许用于 action=blocked");
      }
      if (args.action !== "update" && (typeof args.expected_updated_at !== "string" || args.expected_updated_at.trim().length === 0)) {
        throw taskContractError("INVALID_EXPECTED_UPDATED_AT", "done/blocked 的 expected_updated_at 必填且必须是非空字符串");
      }
      const body = {
        agent_id: String(exec?.agent?.id ?? "unknown"),
        round_id: args.round_id,
        action: args.action,
        progress,
        next,
        ...(args.blocked_reason !== undefined ? { blocked_reason: args.blocked_reason.trim() } : {}),
        ...(args.expected_updated_at !== undefined ? { expected_updated_at: args.expected_updated_at } : {}),
      };
      const result = await client.roundCloseTask(args.task_id, body, exec.signal);
      return {
        ...pickTask(result),
        event_id: String(result.event_id ?? ""),
        round_id: String(result.round_id ?? args.round_id),
        idempotent: result.idempotent === true,
      };
    },
    presentCall: (args) => presentCall("task_round_close", args, `id=${args.task_id} round=${args.round_id} action=${args.action}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_archive",
    description:
      "软删除任务（DELETE /task/{id} → archived=1）：列表/搜索默认不再返回，保留事实与审计字段。" +
      "完成的任务须先经 task_update/task_round_close 申请 pending_done，再由 task_confirm accept 进入 done（不软删）；" +
      "只有确实不再需要跟踪的才 archive。",
    parameters: {
      task_id: { type: "string", required: true, description: "任务 id（tsk-YYYYMMDD-xxxxxx）。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ...TASK_FIELDS, message: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: `## 任务已归档\n\n**${value.title}**（${value.id}）已软删（archived=1），可从 D1 直接查回。` }],
      presentationMeta: (_args, value) => ({ id: value.id, archived: true }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const removed = await client.deleteTask(args.task_id, exec.signal);
      return { ...pickTask(removed), message: `已归档任务 ${removed.id}` };
    },
    presentCall: (args) => presentCall("task_archive", args, `id=${args.task_id}`),
  }));

  ctx.tools.register(defineTool({
    name: "task_search",
    description:
      "关键词检索任务（POST /task/search，LIKE 匹配 title/body/project）：默认排除 archived。" +
      "可选 project/stream/status 过滤；返回 pending_status/blocked_reason/updated_at/done_at，" +
      "done/blocked 的 pending 申请须经 task_confirm 才是终态。",
    parameters: {
      query: { type: "string", required: true, description: "关键词（匹配 title/body/project）。" },
      project: { type: "string" },
      stream: { type: "string", enum: TASK_STREAMS },
      status: { type: "string", enum: TASK_STATUSES },
      page: { type: "integer" },
      size: { type: "integer" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer", required: true },
          items: { type: "array", items: { type: "object", additionalProperties: false, properties: TASK_FIELDS } },
        },
      },
      render: (_args, value) => [
        { type: "text", text: `## 任务检索「${_args.query}」命中 ${value.total} 条\n` + (value.items || []).map((t) => `- ${t.checkbox === 1 ? "☐" : "·"} **${t.title}**（${t.project} · ${t.status}${t.pending_status ? ` · ${t.pending_status}待确认` : ""}${t.claim_state === "claimed" ? " · 🔒他人认领中" : ""}）`).join("\n") },
      ],
      presentationMeta: (_args, value) => ({ total: value.total }),
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const data = await client.searchTasks(
        { query: args.query, project: args.project, stream: args.stream, status: args.status, page: args.page, size: args.size },
        exec.signal
      );
      return { total: data.total, items: (data.items || []).map(pickTask) };
    },
    presentCall: (args) => presentCall("task_search", args, `query=${JSON.stringify(args.query)}`),
  }));

  return { taskGate, gateMode: gateInstallation.mode };
}

// ---- 系统提示词引导（工具使用纪律 + §4 v1.3 分数驱动信任轨道） ----------------

export const MEMORY_PROMPT_GUIDANCE = `记忆工具（sagitta-memory）——设计 §10 四个工具落地为 DSH 工具（v1.3 分数驱动）：

- memory_remember：写入素材（stream 四流；type/domain/tags/content/condition；origin=ripple|sagitta）。管理字段（id/created/status/score）由服务端生成：origin='ripple'（涟漪明确提出的）→ score=2、status=corroborated（先天带信任）；'sagitta'（缺省，AI 自想）→ score=0、status=captured（默认无信任，必须靠认可爬升）。你无权在参数里指定更高状态或直接填 score。
- memory_recall：目录树钻取（stream+domain 前缀）或关键词检索（LIKE，v1 禁 embedding）；**默认排除 archived/superseded**（需看终态时显式 status 过滤）；返回条目带 trust_level/trust_hint（0~1 低信任提示、2 无提示、3 已固化建议遵循）与 validated 事件（few-shot 解释）。默认不跨流混注入。
- memory_consolidate：治理动作集（v1.3：升级已由 ack 自动联动，consolidate 不再是升级唯一通道）：validate 事件化（**blind_spot 必填**，缺失整体 422；explanation 可作召回 few-shot；linked_delegation_id 关联验证）；replace 整体更换（**分数按新 origin 重置**：ripple→2/sagitta→0；旧内容写 replaced 事件仅审计，不参与 recall；可改写软归档条目为相反经验）；archive 治理归档（pinned 拒绝）；digest/corroborate 兜底。任一失败整体 422 不写入。
- memory_verify：三态信任信号登记（explicit 涟漪明确开口 +2；unobjected 我陈述后涟漪未反对 +1，**必须带 statement_source**，不得虚构"我陈述过"；oppose 涟漪明确反对 −3，score<0 自动软归档——涟漪拍板软归档而非硬删）与 delegation 验证结果复核。

信任轨道（v1.3 分数驱动，防过拟合）：score 0~3 钳制；score≥1→digested、≥2→corroborated（ack 提交自动联动，无需手动升级）；validated 由验证事件承载（不是认可次数堆出来的）；score=3 固化档（"已固化，若不与当前场景冲突建议遵循"）；score=2 无提示；score 0~1 "尚未经过多次强化，不一定可信"。delegatee=ripple 仅涟漪实际输入背书时记录，AI 无权代填。密钥/明文永不写入任何记忆条目（L1 硬规则）。


任务工具（task API v2）：task_create 的 kind=normal|temp；normal 必须 project，temp 可无根。task_list 不传 kind 时只列 normal 并补当前 agent 已认领 temp；显式 kind=temp 才查 temp。task_need_human/task_need_human_resolve/need_human_list 负责 need（需要涟漪参与、阻塞 done）与 notify（仅告知涟漪、不阻塞 done、由涟漪前端确认关闭）事项的记账、解除和跨任务汇聚。task_update 的参数仅限 status/priority/body/title/checkbox/blocked_reason（可带 expected_updated_at），不得传 done_at/pending_status/confirm。done/blocked 只提交 pending_done/pending_blocked 申请并返回 confirmation_id，必须 task_confirm accept 才进入终态；blocked 必须有 blocked_reason。每轮用 task_round_close 写 progress/next，二者 trim 后各 1–1000 字符且不得有控制字符或换行；同 task/agent/round_id 相同内容重试幂等，不同内容冲突。
认领制与工具门禁（task-ownership-p2 / task-system-v2 §3.1）：任务带 claim_state——unclaimed=未认领（可 task_claim）；claimed=他人认领中（租约内），未认领才可认领。task_claim 成功是模型获得 claim_token 的唯一途径（唯一一次下发，不进列表/日志）；你持有某任务的 token 即视为自己认领的（mine），可继续推进或 task_release 释放；token 丢失=失去对该任务的继续操作权（可等租约过期重新认领）。task_release 需 task_id+claim_token，token 不匹配 403；他人认领中的任务 PATCH in_progress 会 409 拒绝——先 task_claim。claim_token 属敏感凭证，绝不写入任何日志/记忆/持久化。DSH 已注册全局单调 guard：write/edit/pwsh/codex_dispatch/subagent/async_register 等执行型工具必须已有当前 agent 的 in_progress normal/temp 认领；读/搜索/讨论类工具自由。执行重活前可调用 task_assert_bound 自查；无绑定会拒绝。

task_claim 成功且任务有 project 时，会自动召回 domain=projects/{project} 的最新项目记忆并注入返回；无根 temp/无 project 不召回。`;

export { pickNeedHuman, pickTask };
