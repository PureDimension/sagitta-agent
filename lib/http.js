// ============================================================================
// @sagitta/memory — 极简 HTTP(S) 客户端（lib/http.js）
// ============================================================================
// 为什么自研而不直接 fetch / 依赖 undici：
 //   · 目标 REPLACE_WITH_WORKER_URL 在国内网络需走本机 clash 代理（实测：直连超时，
//     `-x http://host:port` 通道可用）。Node 内置 fetch 不读代理配置，
//     undici ProxyAgent 也未随 DSH 依赖树提供，故用 node: 核心模块实现
//     HTTP CONNECT 隧道 + TLS，自包含、零外部依赖。
 //   · https 目标（REPLACE_WITH_WORKER_URL）：CONNECT 隧道 + https.request（生产路径）。
//   · http 目标（本地 wrangler dev / 本地冒烟桩）：node:http 直连，
//     不走代理——这是 README 已声明的用法（baseUrl 可指向本地 wrangler dev），
//     v1.3 起补齐实现。
//   · 安全：TLS 默认校验证书（rejectUnauthorized: true），无 --ssl-no-revoke
//     类绕过（那是 Windows schannel/curl 特有坑，Node/OpenSSL 无此问题）。
// ============================================================================

import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import http from "node:http";

// ---- 错误类型 ---------------------------------------------------------------

export class HttpStatusError extends Error {
  constructor(status, statusText, headers, bodyText) {
    super(`HTTP ${status} ${statusText}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.statusText = statusText;
    this.headers = headers;
    this.bodyText = bodyText;
  }
}

export class HttpNetworkError extends Error {
  constructor(cause) {
    super(cause && cause.message ? cause.message : String(cause));
    this.name = "HttpNetworkError";
    this.cause = cause;
  }
}

export class HttpTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`请求超时（${timeoutMs}ms）`);
    this.name = "HttpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ---- 响应解析（仅代理隧道返回的原始字节需要手写解析） -----------------------

/**
 * 解析 HTTP/1.1 响应缓冲：状态行 + header + body（content-length 或 chunked 或
 * Connection: close 的剩余全部）。header 名转小写存 Map。
 * 无 content-length 且非 chunked 时按“读到 EOF 即正文”处理（worker 返回均带
 * Connection: close）。
 */
export function parseHttpResponse(buf) {
  const headEnd = buf.indexOf("\r\n\r\n");
  if (headEnd === -1) {
    return { status: 0, statusText: "(不完整响应头)", headers: new Map(), body: buf };
  }
  const head = buf.subarray(0, headEnd).toString("latin1");
  const lines = head.split("\r\n");
  const statusLine = lines[0] || "";
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  const status = m ? Number(m[1]) : 0;
  const statusText = m && m[2] ? m[2] : "";
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const k = line.slice(0, ci).trim().toLowerCase();
    headers.set(k, headers.has(k) ? `${headers.get(k)}, ${line.slice(ci + 1).trim()}` : line.slice(ci + 1).trim());
  }
  let body = buf.subarray(headEnd + 4);
  const transferEncoding = headers.get("transfer-encoding") || "";
  if (/chunked/i.test(transferEncoding)) {
    body = decodeChunked(body);
  } else {
    const contentLength = headers.get("content-length");
    if (contentLength !== undefined && /^\d+$/.test(contentLength.trim())) {
      body = body.subarray(0, Number(contentLength.trim()));
    }
    // 无长度则按 EOF 截断（Connection: close 语义），保持全部
  }
  return { status, statusText, headers, body };
}

function decodeChunked(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const lineEnd = buf.indexOf("\r\n", i);
    if (lineEnd === -1) break;
    const sizeHex = buf.subarray(i, lineEnd).toString("ascii").split(";")[0].trim();
    const size = parseInt(sizeHex, 16);
    if (!Number.isInteger(size) || size < 0) break;
    if (size === 0) break;
    const start = lineEnd + 2;
    const end = start + size;
    if (end + 2 > buf.length) break; // 不完整块：按已读处理
    out.push(buf.subarray(start, end));
    i = end + 2;
  }
  return Buffer.concat(out.length > 0 ? out : [buf.subarray(i)]);
}

// ---- 请求执行 ---------------------------------------------------------------
// proxy 形如 "http://host:port"（clash 混合端口）。proxy 为空串/“direct”时直连。

/**
 * 发送一个 HTTPS 请求（通过可选的 HTTP CONNECT 代理隧道）。
 * @param {object} opts { method, url, headers(对象), body(string|Buffer), timeoutMs, signal, proxy }
 * @returns {Promise<{status,statusText,headers:Map,body:Buffer}>}
 */
export async function request(opts) {
  const { method = "GET", url, headers = {}, body, timeoutMs = 20000, signal, proxy } = opts;
  const u = new URL(url);
   // https：生产路径（REPLACE_WITH_WORKER_URL，可走 CONNECT 代理隧道）；
  // http：本地路径（wrangler dev / 本地冒烟桩），直连不走代理。
  if (u.protocol !== "https:" && u.protocol !== "http:") {
     throw new Error("仅支持 https / http 目标（https=REPLACE_WITH_WORKER_URL 生产；http=本地 wrangler dev / 本地测试桩）");
  }
  const targetHost = u.hostname;
  const targetPort = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;

  const reqHeaders = {
    "User-Agent": "@sagitta/memory/1.1.0",
    "Accept-Encoding": "identity", // 避免边缘 gzip，隧道模式无需解压缩
    ...headers,
  };
  const bodyBuf = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  if (bodyBuf) {
    reqHeaders["Content-Length"] = String(bodyBuf.length);
    if (!reqHeaders["Content-Type"]) reqHeaders["Content-Type"] = "application/json";
  } else {
    delete reqHeaders["Content-Length"];
  }

  const useProxy = typeof proxy === "string" && proxy.trim().length > 0 && proxy.trim().toLowerCase() !== "direct";
  if (useProxy) {
    if (u.protocol !== "https:") {
      // 本地 http 目标不套代理（CONNECT 隧道仅对 https 有意义）；代理配置仅作用生产路径
      return requestDirectHttp({ method, u, reqHeaders, bodyBuf, timeoutMs, signal });
    }
    return requestViaTunnel({ method, u, targetHost, targetPort, reqHeaders, bodyBuf, timeoutMs, signal, proxy });
  }
  if (u.protocol === "http:") {
    return requestDirectHttp({ method, u, reqHeaders, bodyBuf, timeoutMs, signal });
  }
  return requestDirect({ method, u, reqHeaders, bodyBuf, timeoutMs, signal });
}

// 本地 http 直连（wrangler dev / 本地测试桩）：node:http，无 TLS
async function requestDirectHttp({ method, u, reqHeaders, bodyBuf, timeoutMs, signal }) {
  return await new Promise((resolve, reject) => {
    const req = http.request(u, { method, headers: reqHeaders, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          statusText: res.statusMessage || "",
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", (err) => reject(new HttpNetworkError(err)));
    });
    req.on("timeout", () => req.destroy(new HttpTimeoutError(timeoutMs)));
    req.on("error", (err) => {
      if (err instanceof HttpTimeoutError) return reject(err);
      reject(new HttpNetworkError(err));
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error("aborted"));
        reject(new Error("请求已中止"));
        return;
      }
      signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// 直连：直接复用 node:https（自带 header/chunked 解析与 TLS 校验）
async function requestDirect({ method, u, reqHeaders, bodyBuf, timeoutMs, signal }) {
  return await new Promise((resolve, reject) => {
    const req = https.request(u, { method, headers: reqHeaders, rejectUnauthorized: true, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          statusText: res.statusMessage || "",
          headers: res.headers,
          body,
        });
      });
      res.on("error", (err) => reject(new HttpNetworkError(err)));
    });
    req.on("timeout", () => req.destroy(new HttpTimeoutError(timeoutMs)));
    req.on("error", (err) => {
      if (err instanceof HttpTimeoutError) return reject(err);
      reject(new HttpNetworkError(err));
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error("aborted"));
        reject(new Error("请求已中止"));
        return;
      }
      signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// 代理隧道：TCP → CONNECT → TLS → 手写 HTTP/1.1
async function requestViaTunnel({ method, u, targetHost, targetPort, reqHeaders, bodyBuf, timeoutMs, signal, proxy }) {
  let proxyUrl;
  try {
    proxyUrl = new URL(proxy);
  } catch {
    throw new Error(`代理地址非法：${proxy}（应为 http://host:port）`);
  }
  const proxyHost = proxyUrl.hostname;
  const proxyPort = Number(proxyUrl.port || 80);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const onAbort = () => fail(new Error("aborted"));

    let socket;
    try {
      socket = net.createConnection({ host: proxyHost, port: proxyPort });
    } catch (err) {
      reject(new HttpNetworkError(err));
      return;
    }
    if (signal) {
      if (signal.aborted) {
        socket.destroy();
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    socket.on("error", (err) => fail(new HttpNetworkError(err)));

    // 阶段 1：CONNECT 隧道握手
    const connectReq = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      "Proxy-Connection: keep-alive",
      "",
      "",
    ].join("\r\n");
    let connectBuf = Buffer.alloc(0);
    let handshakeDone = false;
    socket.on("data", (chunk) => {
      if (handshakeDone) return;
      connectBuf = Buffer.concat([connectBuf, chunk]);
      const headEnd = connectBuf.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        if (connectBuf.length > 65536) fail(new Error("代理 CONNECT 响应头过长（代理异常）"));
        return;
      }
      const statusLine = connectBuf.subarray(0, headEnd).toString("ascii").split("\r\n")[0];
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
      if (!m || Number(m[1]) !== 200) {
        fail(new Error(`代理 CONNECT 失败：${statusLine || "(无状态行)"}（检查 clash 代理 ${proxyHost}:${proxyPort} 是否在运行）`));
        return;
      }
      handshakeDone = true;
      if (signal) signal.removeEventListener("abort", onAbort);

      // 阶段 2：隧道上建立 TLS
      let tlsSocket;
      try {
        tlsSocket = tls.connect({
          socket,
          servername: targetHost,
          rejectUnauthorized: true,
        });
      } catch (err) {
        fail(new HttpNetworkError(err));
        return;
      }
      tlsSocket.on("error", (err) => fail(new HttpNetworkError(err)));
      tlsSocket.on("secureConnect", () => {
        if (signal) signal.addEventListener("abort", () => tlsSocket.destroy(), { once: true });
        const pathAndQuery = u.pathname + (u.search || "");
        const headLines = [`${method} ${pathAndQuery} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`];
        for (const [k, v] of Object.entries(reqHeaders)) {
          if (k.toLowerCase() === "host") continue;
          headLines.push(`${k}: ${v}`);
        }
        headLines.push("Connection: close", "", "");
        let reqBuf = Buffer.from(headLines.join("\r\n"), "latin1");
        if (bodyBuf) reqBuf = Buffer.concat([reqBuf, bodyBuf]);

        let respBuf = Buffer.alloc(0);
        let timeoutId = setTimeout(() => {
          tlsSocket.destroy();
          fail(new HttpTimeoutError(timeoutMs));
        }, timeoutMs);
        const done = (err, result) => {
          clearTimeout(timeoutId);
          if (settled) return;
          settled = true;
          if (err) return reject(err);
          resolve(result);
        };
        tlsSocket.on("data", (d) => {
          respBuf = Buffer.concat([respBuf, d]);
        });
        tlsSocket.on("end", () => {
          try {
            const parsed = parseHttpResponse(respBuf);
            done(null, {
              status: parsed.status,
              statusText: parsed.statusText,
              headers: parsed.headers,
              body: parsed.body,
            });
          } catch (err) {
            done(new HttpNetworkError(err));
          }
        });
        tlsSocket.on("error", (err) => done(new HttpNetworkError(err)));
        tlsSocket.on("close", (hadError) => {
          if (!hadError && !settled) {
            // 已收到 end 会走 done；防御性兜底
            try {
              const parsed = parseHttpResponse(respBuf);
              done(null, { status: parsed.status, statusText: parsed.statusText, headers: parsed.headers, body: parsed.body });
            } catch (err) {
              done(new HttpNetworkError(err));
            }
          }
        });
        tlsSocket.write(reqBuf);
      });
    });
    socket.write(connectReq);
  });
}
