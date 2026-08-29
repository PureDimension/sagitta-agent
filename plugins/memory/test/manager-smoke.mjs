import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolveConfig } from "../lib/config.js";
import { SagittaMemoryClient } from "../lib/client.js";

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

let managerState = {
  workerApiUrl: "",
  d1ReadToken: "",
  d1WriteToken: "",
};
const manager = { getApiConfig: () => managerState };

try {
  // Manager 空快照：显式 fallback 仍可用，且不会回退到线上默认地址。
  const fallbackClient = new SagittaMemoryClient(resolveConfig({
    baseUrl: workerUrl,
    authToken: "fallback-token-smoke",
    proxy: "direct",
    timeoutMs: 2000,
  }), manager);
  const fallbackResult = await fallbackClient.listEntries("sagitta");
  assert.deepEqual(fallbackResult, { total: 0, page: 1, size: 20, items: [] });
  assert.equal(requests.at(-1).headers.authorization, "Bearer fallback-token-smoke");
  assert.equal(fallbackClient.getRuntimeConfig("read").source, "fallback");

  // 无 manager、无显式 fallback：工具调用最终会看到可行动的“未配置”错误。
  const missingClient = new SagittaMemoryClient(resolveConfig({ proxy: "direct" }), manager);
  await assert.rejects(
    missingClient.listEntries("sagitta"),
    (error) => error instanceof Error && error.message.includes("Sagitta Manager 未配置") && error.message.includes("未配置")
  );
  const noManagerClient = new SagittaMemoryClient(resolveConfig({ proxy: "direct" }));
  await assert.rejects(
    noManagerClient.listEntries("sagitta"),
    (error) => error instanceof Error && error.message.includes("Sagitta Manager 未配置")
  );

  // Manager 配置 URL + 双 token：每次请求读取当前快照，读写按业务操作分流到 Bearer。
  managerState = {
    workerApiUrl: `${workerUrl}/`,
    d1ReadToken: "manager-read-token-smoke",
    d1WriteToken: "manager-write-token-smoke",
  };
  assert.equal(fallbackClient.getRuntimeConfig("read").baseUrl, workerUrl);
  assert.equal(fallbackClient.getRuntimeConfig("read").auth.authToken, "manager-read-token-smoke");
  assert.equal(fallbackClient.getRuntimeConfig("write").auth.authToken, "manager-write-token-smoke");

  await fallbackClient.search({ query: "manager-read" });
  assert.equal(requests.at(-1).method, "POST");
  assert.equal(requests.at(-1).url, "/mem/search");
  assert.equal(requests.at(-1).headers.authorization, "Bearer manager-read-token-smoke");
  assert.equal(requests.at(-1).headers["cf-access-client-id"], undefined);
  assert.equal(requests.at(-1).headers["cf-access-client-secret"], undefined);

  await fallbackClient.createEntry("sagitta", { content: "smoke" });
  assert.equal(requests.at(-1).method, "POST");
  assert.equal(requests.at(-1).url, "/mem/sagitta");
  assert.equal(requests.at(-1).headers.authorization, "Bearer manager-write-token-smoke");

  console.log("memory manager smoke: PASS (empty/fallback, manager URL, read/write Bearer routing, visible unconfigured error)");
} finally {
  server.close();
}
