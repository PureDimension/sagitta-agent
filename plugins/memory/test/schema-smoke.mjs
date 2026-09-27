import assert from "node:assert/strict";
import { registerMemoryTools } from "../lib/tools.js";

// Use the real DSH defineTool validator, not a permissive schema mock.
// Registering the tools must work before any model request or Worker call.
const names = new Set();
registerMemoryTools({
  tools: {
    register(tool) {
      assert.equal(names.has(tool.name), false);
      names.add(tool.name);
    },
    guard: () => () => {},
  },
  on: () => () => {},
}, {});
for (const name of ["task_create", "task_update", "task_round_close", "task_need_human_resolve"]) {
  assert.ok(names.has(name), `${name} must pass the real DSH schema validator`);
}
console.log(`memory tool schemas: PASS (${names.size} tools)`);
