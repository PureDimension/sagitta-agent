import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolveConfig } from "../lib/config.js";
import { SagittaMemoryClient, isLoopbackUrl } from "../lib/client.js";

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

  // Access-only manager 配置必须直接供 task/memory client 使用；不回退到旧 fallback，
  // 且行为与 auto-advance 的 Access-only 分支一致（只发成对 Access headers）。
  managerState = {
    workerApiUrl: workerUrl,
    d1ReadToken: "",
    d1WriteToken: "",
    accessClientId: "access-id-smoke",
    accessClientSecret: "access-secret-smoke",
  };
  assert.equal(fallbackClient.getRuntimeConfig("read").source, "manager");
  assert.equal(fallbackClient.getRuntimeConfig("read").auth.accessPresent, true);
  await fallbackClient.listTasks({ status: "open" });
  assert.equal(requests.at(-1).headers.authorization, undefined);
  assert.equal(requests.at(-1).headers["cf-access-client-id"], "access-id-smoke");
  assert.equal(requests.at(-1).headers["cf-access-client-secret"], "access-secret-smoke");
  await fallbackClient.createTask({ project: "smoke", title: "access-only write" });
  assert.equal(requests.at(-1).headers.authorization, undefined);
  assert.equal(requests.at(-1).headers["cf-access-client-id"], "access-id-smoke");
  assert.equal(requests.at(-1).headers["cf-access-client-secret"], "access-secret-smoke");

  // 同时存在两种凭据时，Bearer 优先级与 auto-advance 一致。
  managerState = {
    workerApiUrl: workerUrl,
    d1ReadToken: "manager-read-token-smoke-2",
    d1WriteToken: "manager-write-token-smoke-2",
    accessClientId: "access-id-smoke-2",
    accessClientSecret: "access-secret-smoke-2",
  };
  await fallbackClient.listTasks();
  assert.equal(requests.at(-1).headers.authorization, "Bearer manager-read-token-smoke-2");
  assert.equal(requests.at(-1).headers["cf-access-client-id"], undefined);
  assert.equal(requests.at(-1).headers["cf-access-client-secret"], undefined);

  // 线上非 loopback Worker 不允许 silent direct；loopback 仍保留本地 smoke 用法。
  assert.equal(isLoopbackUrl(workerUrl), true);
  assert.equal(isLoopbackUrl("https://worker.example.test"), false);
  const directProductionClient = new SagittaMemoryClient(resolveConfig({
    baseUrl: "https://worker.example.test",
    authToken: "production-token-smoke",
    proxy: "direct",
  }));
  await assert.rejects(
    directProductionClient.listTasks(),
    (error) => error instanceof Error && /配置错误.*非 loopback Worker.*direct.*fail closed/u.test(error.message)
  );

  console.log("memory manager smoke: PASS (fallback, Bearer/Access-only routing, Bearer precedence, loopback direct policy)");
} finally {
  server.close();
}
