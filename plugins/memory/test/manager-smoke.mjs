import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SagittaMemoryClient } from "../lib/client.js";
import { createMockManager, managerBody } from "./mock-manager.mjs";

const requests = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: Buffer.concat(chunks).toString("utf8"),
  });
  const data = req.url === "/mem/search"
    ? { total: 0, page: 1, size: 20, items: [] }
    : { total: 0, page: 1, size: 20, items: [] };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, data }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const workerUrl = `http://127.0.0.1:${port}`;

const manager = createMockManager(workerUrl);

try {
  const client = new SagittaMemoryClient(manager);
  const empty = await client.listEntries("sagitta");
  assert.deepEqual(empty, { total: 0, page: 1, size: 20, items: [] });
  assert.equal(manager.calls.at(-1).path, "/mem/sagitta");
  assert.equal(manager.calls.at(-1).init.method, "GET");

  await client.search({ query: "manager-read", stream: "sagitta", page: 2 });
  assert.equal(manager.calls.at(-1).path, "/mem/search");
  assert.equal(manager.calls.at(-1).init.method, "POST");
  assert.deepEqual(managerBody(manager.calls.at(-1)), { query: "manager-read", stream: "sagitta", page: 2 });
  assert.equal(manager.calls.at(-1).init.headers["content-type"], "application/json");

  await client.createEntry("sagitta", { content: "smoke" });
  assert.equal(manager.calls.at(-1).path, "/mem/sagitta");
  assert.equal(manager.calls.at(-1).init.method, "POST");
  assert.deepEqual(managerBody(manager.calls.at(-1)), { content: "smoke" });

  await client.listTasks({ status: "open", agentId: "agent-smoke" });
  assert.equal(manager.calls.at(-1).path, "/task?status=open");
  assert.equal(manager.calls.at(-1).init.headers["X-Agent-Id"], "agent-smoke");

  assert.throws(() => new SagittaMemoryClient(undefined), /requires sagitta-manager\.request/u);

  console.log("memory manager smoke: PASS (manager.request-only routing, JSON body, query, X-Agent-Id, missing manager fail-fast)");
} finally {
  server.close();
}
