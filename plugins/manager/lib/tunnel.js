import net from "node:net";
import tls from "node:tls";

export class HttpNetworkError extends Error {
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "HttpNetworkError";
    this.cause = cause;
  }
}

export class HttpTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function parseResponse(buffer) {
  const headEnd = buffer.indexOf("\r\n\r\n");
  if (headEnd === -1) throw new Error("incomplete HTTP response headers");
  const lines = buffer.subarray(0, headEnd).toString("latin1").split("\r\n");
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(lines.shift() ?? "");
  if (match === null) throw new Error("invalid HTTP response status line");
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
  }
  let body = buffer.subarray(headEnd + 4);
  if (/chunked/i.test(headers.get("transfer-encoding") ?? "")) body = decodeChunked(body);
  const length = headers.get("content-length");
  if (length !== undefined && /^\d+$/.test(length) && !/chunked/i.test(headers.get("transfer-encoding") ?? "")) body = body.subarray(0, Number(length));
  return { status: Number(match[1]), statusText: match[2] ?? "", headers, body };
}

function decodeChunked(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) throw new Error("incomplete chunked response");
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0].trim(), 16);
    if (!Number.isInteger(size) || size < 0) throw new Error("invalid chunked response");
    if (size === 0) return Buffer.concat(chunks);
    const start = lineEnd + 2;
    const end = start + size;
    if (end + 2 > buffer.length) throw new Error("incomplete chunked response");
    chunks.push(buffer.subarray(start, end));
    offset = end + 2;
  }
  throw new Error("incomplete chunked response");
}

export async function requestViaTunnel({ method, url, headers, body, proxy, timeoutMs }) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("CONNECT tunnel requires an HTTPS target");
  const proxyUrl = new URL(proxy);
  if (proxyUrl.protocol !== "http:") throw new Error("proxy must use http://");
  const targetPort = Number(target.port || 443);
  const proxyPort = Number(proxyUrl.port || 80);

  return new Promise((resolve, reject) => {
    let socket;
    let tlsSocket;
    let settled = false;
    let responseBuffer = Buffer.alloc(0);
    let connectBuffer = Buffer.alloc(0);
    let handshakeDone = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      tlsSocket?.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new HttpTimeoutError(timeoutMs)), timeoutMs);

    try {
      socket = net.createConnection({ host: proxyUrl.hostname, port: proxyPort });
    } catch (error) {
      clearTimeout(timer);
      reject(new HttpNetworkError(error));
      return;
    }
    socket.setTimeout(timeoutMs, () => fail(new HttpTimeoutError(timeoutMs)));
    socket.on("error", (error) => fail(new HttpNetworkError(error)));
    socket.on("data", (chunk) => {
      if (handshakeDone) return;
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const headEnd = connectBuffer.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        if (connectBuffer.length > 65536) fail(new Error("proxy CONNECT response headers are too large"));
        return;
      }
      const statusLine = connectBuffer.subarray(0, headEnd).toString("ascii").split("\r\n")[0] ?? "";
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
      if (match === null || Number(match[1]) !== 200) {
        fail(new Error(`proxy CONNECT failed: ${statusLine || "missing status"}`));
        return;
      }
      handshakeDone = true;
      socket.removeAllListeners("data");
      try {
        tlsSocket = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: true });
      } catch (error) {
        fail(new HttpNetworkError(error));
        return;
      }
      tlsSocket.setTimeout(timeoutMs, () => fail(new HttpTimeoutError(timeoutMs)));
      tlsSocket.on("error", (error) => fail(new HttpNetworkError(error)));
      tlsSocket.on("data", (chunk) => { responseBuffer = Buffer.concat([responseBuffer, chunk]); });
      tlsSocket.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          resolve(parseResponse(responseBuffer));
        } catch (error) {
          reject(new HttpNetworkError(error));
        }
      });
      tlsSocket.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          resolve(parseResponse(responseBuffer));
        } catch (error) {
          reject(new HttpNetworkError(error));
        }
      });
      const path = `${target.pathname}${target.search}`;
      const requestLines = [`${method} ${path} HTTP/1.1`, `Host: ${target.hostname}:${targetPort}`];
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== "host") requestLines.push(`${key}: ${value}`);
      }
      requestLines.push("Connection: close", "", "");
      const requestBuffer = Buffer.from(requestLines.join("\r\n"), "latin1");
      tlsSocket.write(body === undefined ? requestBuffer : Buffer.concat([requestBuffer, body]));
    });
    socket.write([
      `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
      `Host: ${target.hostname}:${targetPort}`,
      "Proxy-Connection: keep-alive",
      "",
      ""
    ].join("\r\n"));
  });
}
