import assert from "node:assert/strict";
import { SagittaMemoryClient } from "../lib/client.js";

const calls = [];
const manager = {
  async request(path, init) {
    calls.push({ path, init });
    return new Response(JSON.stringify({ ok: true, data: { total: 0, items: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
};

const client = new SagittaMemoryClient(manager);
await client.listTasks({ project: "smoke" });
assert.equal(calls.length, 1);
assert.equal(calls[0].path, "/task?project=smoke");
assert.equal(calls[0].init.method, "GET");
assert.equal("timeoutMs" in calls[0].init, false);
console.log("memory manager channel smoke: PASS (memory does not own CONNECT or timeout)");
