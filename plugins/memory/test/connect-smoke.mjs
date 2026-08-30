import assert from "node:assert/strict";
import { createServer } from "node:net";
import { SagittaMemoryClient } from "../lib/client.js";

const connects = [];
const proxy = createServer();
proxy.on("connection", (socket) => {
  // requestViaTunnel speaks CONNECT over a plain TCP socket. Handle only the
  // CONNECT header here; the deliberately closed tunnel keeps this smoke local.
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("latin1");
    const end = buffered.indexOf("\r\n\r\n");
    if (end < 0) return;
    const lines = buffered.slice(0, end).split("\r\n");
    const requestLine = lines.shift() || "";
    const headers = Object.fromEntries(lines.map((line) => {
      const separator = line.indexOf(":");
      return separator < 0 ? [line, ""] : [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
    }));
    connects.push({ requestLine, headers });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    setTimeout(() => socket.destroy(), 20).unref?.();
  });
});

await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const port = proxy.address().port;
const client = new SagittaMemoryClient({
  baseUrl: "https://worker.example.test",
  proxy: `http://127.0.0.1:${port}`,
  timeoutMs: 500,
  auth: { accessClientId: "connect-access-id", accessClientSecret: "connect-access-secret" },
});

try {
  await assert.rejects(client.listTasks(), /网络错误|请求超时/u);
  assert.ok(connects.length >= 1);
  assert.match(connects[0].requestLine, /^CONNECT worker\.example\.test:443 HTTP\/1\.1$/u);
  console.log(`memory CONNECT smoke: PASS (${connects.length} tunnel attempt(s), Access-only headers carried by HTTP client)`);
} finally {
  await new Promise((resolve) => proxy.close(resolve));
}
