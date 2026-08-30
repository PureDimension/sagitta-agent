const ROUND_CLOSE_ACTIONS = new Set(["update", "done", "blocked"]);
const ROUND_CLOSE_FIELDS = new Set([
  "task_id",
  "action",
  "progress",
  "next",
  "round_id",
  "blocked_reason",
  "expected_updated_at",
]);
const ROUND_TEXT_MAX_LENGTH = 1000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(message, cause) {
  const error = new Error(`close-protocol-error: ${message}`);
  error.code = "close-protocol-error";
  if (cause !== undefined) error.cause = cause;
  return error;
}

function protocolText(value, field, { maxLength = ROUND_TEXT_MAX_LENGTH } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw protocolError(`${field} 必须是非空字符串`);
  }
  const result = value.trim();
  if (Array.from(result).length > maxLength) {
    throw protocolError(`${field} 超过 ${maxLength} 个 Unicode 字符`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(result)) {
    throw protocolError(`${field} 不得包含控制字符或换行`);
  }
  return result;
}

/**
 * Validate the compatibility representation of task_round_close. The tool
 * path remains authoritative; this validator only makes the text fallback
 * safe enough to hand to the same Worker endpoint.
 */
export function validateRoundClosePayload(value) {
  if (!isRecord(value)) throw protocolError("round-close 必须是 JSON 对象");
  for (const key of Object.keys(value)) {
    if (!ROUND_CLOSE_FIELDS.has(key)) throw protocolError(`round-close 包含未知字段 ${key}`);
  }

  const taskId = protocolText(value.task_id, "task_id", { maxLength: 256 });
  const action = protocolText(value.action, "action", { maxLength: 32 });
  if (!ROUND_CLOSE_ACTIONS.has(action)) throw protocolError(`未知 action：${action}`);
  const progress = protocolText(value.progress, "progress");
  const next = protocolText(value.next, "next");
  const roundId = protocolText(value.round_id, "round_id", { maxLength: 256 });

  if (action === "blocked") {
    if (typeof value.blocked_reason !== "string" || value.blocked_reason.trim().length === 0) {
      throw protocolError("action=blocked 必须提供 blocked_reason");
    }
  } else if (Object.prototype.hasOwnProperty.call(value, "blocked_reason")) {
    throw protocolError("blocked_reason 只允许用于 action=blocked");
  }

  if (Object.prototype.hasOwnProperty.call(value, "expected_updated_at")) {
    protocolText(value.expected_updated_at, "expected_updated_at", { maxLength: 128 });
  } else if (action === "done" || action === "blocked") {
    throw protocolError(`action=${action} 必须提供 expected_updated_at`);
  }

  return {
    task_id: taskId,
    action,
    progress,
    next,
    round_id: roundId,
    ...(action === "blocked" ? { blocked_reason: protocolText(value.blocked_reason, "blocked_reason") } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "expected_updated_at")
      ? { expected_updated_at: value.expected_updated_at.trim() }
      : {}),
  };
}

function parseJsonObject(text) {
  const source = typeof text === "string" ? text.trim() : "";
  if (source.length === 0) throw protocolError("文本收尾为空");

  let jsonText = source;
  const fenced = /^```json[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?```$/iu.exec(source);
  if (fenced !== null) {
    jsonText = fenced[1].trim();
  } else if (source.startsWith("```") || !source.startsWith("{") || !source.endsWith("}")) {
    throw protocolError("只接受完整且唯一的 JSON 对象或 fenced JSON");
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw protocolError("文本不是合法 JSON 对象", error);
  }
  if (!isRecord(parsed)) throw protocolError("文本收尾必须是唯一的 JSON 对象");
  return validateRoundClosePayload(parsed);
}

/** Accept exactly one complete plain or fenced JSON object, with no prose. */
export function parseRoundCloseText(text) {
  return parseJsonObject(text);
}

function blockType(block) {
  return typeof block?.type === "string" ? block.type.toLowerCase() : "";
}

function isToolCallBlock(block) {
  const type = blockType(block);
  return type === "tool-call" || type === "tool_call" || type === "tool_use" || type === "tool-use" ||
    type === "function-call" || type === "function_call" ||
    type === "function" ||
    (type === "tool" && (block?.arguments !== undefined || block?.input !== undefined || block?.args !== undefined));
}

function toolName(block) {
  return block?.name ?? block?.tool_name ?? block?.toolName ?? block?.function?.name ?? block?.tool?.name;
}

function toolArguments(block) {
  const value = block?.arguments ?? block?.input ?? block?.args ?? block?.parameters ?? block?.function?.arguments ?? block?.tool?.arguments;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw protocolError("task_round_close 工具参数不是合法 JSON", error);
    }
  }
  return value;
}

function toolCallBlocks(message) {
  const blocks = [];
  if (Array.isArray(message?.content)) blocks.push(...message.content.filter(isToolCallBlock));
  for (const key of ["tool_calls", "toolCalls", "function_calls", "functionCalls"]) {
    if (Array.isArray(message?.[key])) blocks.push(...message[key]);
  }
  return blocks;
}

/**
 * Extract one close from a message. Any tool call wins over text fallback;
 * this prevents a prose/JSON fragment beside a real tool invocation from
 * creating a second close.
 */
export function parseRoundCloseMessage(message) {
  const calls = toolCallBlocks(message);
  if (calls.length > 0) {
    const closeCalls = calls.filter((call) => toolName(call) === "task_round_close");
    if (closeCalls.length === 0) return { kind: "tool-other" };
    if (closeCalls.length !== 1) throw protocolError("同一 assistant 消息包含多个 task_round_close 调用");
    return { kind: "tool", payload: validateRoundClosePayload(toolArguments(closeCalls[0])) };
  }

  const texts = Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text)
    : [];
  if (texts.length === 0) return null;
  const text = texts.join("").trim();
  if (text.length === 0) return null;
  return { kind: "text", payload: parseRoundCloseText(text) };
}

export function containsStopMarker(text, marker) {
  return typeof text === "string" && text.includes(marker);
}

export { ROUND_CLOSE_ACTIONS };
