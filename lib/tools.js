// ============================================================================
// @sagitta/memory — 四个模型工具（lib/tools.js）
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

// ---- 工具定义 ---------------------------------------------------------------

export function registerMemoryTools(ctx, client) {
  const timeoutMs = client.config.timeoutMs;
  const toolOpts = { ctx, client, timeoutMs };

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
          stream: args.stream,
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
}

// ---- 系统提示词引导（工具使用纪律 + §4 v1.3 分数驱动信任轨道） ----------------

export const MEMORY_PROMPT_GUIDANCE = `记忆工具（sagitta-memory）——设计 §10 四个工具落地为 DSH 工具（v1.3 分数驱动）：

- memory_remember：写入素材（stream 四流；type/domain/tags/content/condition；origin=ripple|sagitta）。管理字段（id/created/status/score）由服务端生成：origin='ripple'（涟漪明确提出的）→ score=2、status=corroborated（先天带信任）；'sagitta'（缺省，AI 自想）→ score=0、status=captured（默认无信任，必须靠认可爬升）。你无权在参数里指定更高状态或直接填 score。
- memory_recall：目录树钻取（stream+domain 前缀）或关键词检索（LIKE，v1 禁 embedding）；**默认排除 archived/superseded**（需看终态时显式 status 过滤）；返回条目带 trust_level/trust_hint（0~1 低信任提示、2 无提示、3 已固化建议遵循）与 validated 事件（few-shot 解释）。默认不跨流混注入。
- memory_consolidate：治理动作集（v1.3：升级已由 ack 自动联动，consolidate 不再是升级唯一通道）：validate 事件化（**blind_spot 必填**，缺失整体 422；explanation 可作召回 few-shot；linked_delegation_id 关联验证）；replace 整体更换（**分数按新 origin 重置**：ripple→2/sagitta→0；旧内容写 replaced 事件仅审计，不参与 recall；可改写软归档条目为相反经验）；archive 治理归档（pinned 拒绝）；digest/corroborate 兜底。任一失败整体 422 不写入。
- memory_verify：三态信任信号登记（explicit 涟漪明确开口 +2；unobjected 我陈述后涟漪未反对 +1，**必须带 statement_source**，不得虚构"我陈述过"；oppose 涟漪明确反对 −3，score<0 自动软归档——涟漪拍板软归档而非硬删）与 delegation 验证结果复核。

信任轨道（v1.3 分数驱动，防过拟合）：score 0~3 钳制；score≥1→digested、≥2→corroborated（ack 提交自动联动，无需手动升级）；validated 由验证事件承载（不是认可次数堆出来的）；score=3 固化档（"已固化，若不与当前场景冲突建议遵循"）；score=2 无提示；score 0~1 "尚未经过多次强化，不一定可信"。delegatee=ripple 仅涟漪实际输入背书时记录，AI 无权代填。密钥/明文永不写入任何记忆条目（L1 硬规则）。`;
