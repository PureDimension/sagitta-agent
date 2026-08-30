import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = await readFile(join(fileURLToPath(new URL(".", import.meta.url)), "../lib/index.js"), "utf8");
assert.match(source, /task_id:\s*\{\s*type:\s*"string",\s*required:\s*true/u);
assert.match(source, /asyncWork\.register\(\{[\s\S]*?taskId:\s*args\.task_id/u);
assert.match(source, /detached:\s*false/u);
assert.doesNotMatch(source, /child\.unref\(\)/u);
assert.match(source, /service\.cancel\(metadata\.ownerId, workId, metadata\.taskId\)/u);
assert.match(source, /ASYNC_WORK_UNAVAILABLE/u);

// The repository intentionally does not vendor DSH peer dependencies. When
// this smoke runs in the installed profile, exercise the adapter facade with a
// real generic registry; in the source-only checkout, retain the static safety
// assertions above and report the missing optional host runtime explicitly.
let adapter;
try {
  adapter = await import("../lib/index.js");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

if (adapter) {
  const { AsyncWorkRegistry } = await import("../../async-work/lib/registry.js");
  const generic = new AsyncWorkRegistry({ idFactory: (() => { let n = 0; return () => `codex-${++n}`; })() });
  const facade = new adapter.CodexWorkRegistry({ asyncWork: generic, maxConcurrent: 2 });
  const work = facade.register("agent-1", {
    taskId: "task-A",
    task: "run smoke",
    model: "smoke-model",
    timeoutMs: 1000,
  });
  assert.equal(work.task_id, "task-A");
  assert.equal(facade.listActive("agent-1").length, 1);
  assert.equal(facade.listActive("agent-1", "task-B").length, 0, "task_id must isolate facade queries");
  assert.equal(facade.markEnded("agent-1", work.work_id, "completed", 0, "task-A").status, "completed");
  assert.throws(
    () => new adapter.CodexWorkRegistry().listActive("agent-1"),
    (error) => error.code === "ASYNC_WORK_UNAVAILABLE"
  );
  assert.deepEqual(adapter.cleanupLegacyDetachedCodex([]).ok, true);
  console.log("codex-dispatch smoke: PASS (task_id adapter binding, isolation, terminal delegation, fail-closed, controlled child assertions)");
} else {
  console.log("codex-dispatch smoke: PASS (source-only safety assertions; DSH peer runtime not installed)");
}
