import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const source = await readFile(join(root, "lib/index.js"), "utf8");
const clientSource = await readFile(join(root, "lib/app-server.js"), "utf8");

assert.match(source, /name:\s*"codex_dispatch"/u);
assert.match(source, /name:\s*"codex_status"/u);
assert.match(source, /name:\s*"codex_append"/u);
assert.match(source, /task_id:\s*\{\s*type:\s*"string",\s*required:\s*true/u);
assert.match(source, /asyncWork\.register\(\{[\s\S]*?taskId:\s*args\.task_id/u);
// codex_append 与 codex_dispatch 共用 turn/start（有活跃轮次则并入该轮次、否则开新一轮），
// 因此不再需要 turn/steer —— 断言它彻底退场，而不是断言某个方法被调用。
assert.doesNotMatch(source, /turn\/steer/u);
assert.doesNotMatch(source, /args\.workId/u);
assert.doesNotMatch(source, /CodexWorkRegistry|toLegacyCodexWork|legacyStatus|epochFromIso|cleanupLegacyDetachedCodex|legacyPidsFrom|listActiveWorks|reapStale|getWork|processTracker|markUnavailable|markAvailable/u);
assert.doesNotMatch(clientSource, /jsonrpc/u);
assert.match(clientSource, /initialize/u);
assert.match(clientSource, /healthz/u);
assert.match(clientSource, /taskkill\.exe/u);
// persona 是静态的，它的动态尾部由这段 section 提供：text 必须是函数，
// 否则 DSH 只在装配时读一次，改设置就不会生效。
assert.match(source, /const inject = \["tools", "agents", "systemPrompt", "sagitta-async-work", "sagitta-manager"\];/u);
assert.match(source, /systemPrompt\.section\(\{[\s\S]*?text:\s*\(\)\s*=>/u);

console.log("codex-dispatch smoke: PASS (three tools, snake_case work_id only, manager model source, unified turn/start append with no turn/steer, dynamic runtime section, no legacy/process-tree/jsonrpc)");
