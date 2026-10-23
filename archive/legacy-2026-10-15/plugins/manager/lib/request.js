import http from "node:http";
import https from "node:https";
import { HttpNetworkError, HttpTimeoutError, requestViaTunnel } from "./tunnel.js";

const TIMEOUT_MS = 20_000;

class HttpStatusError extends Error {
  constructor(response, bodyText) {
    super(`HTTP ${response.status} ${response.statusText}`.trim());
    this.name = "HttpStatusError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.bodyText = bodyText;
  }
}

function headersObject(headers) {
  if (headers === undefined) return {};
  if (typeof headers.entries === "function") return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers));
}

async function encodeBody(url, method, body, headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const encoded = new Request(url, { method, body });
    headers["content-type"] ??= encoded.headers.get("content-type");
    return Buffer.from(await encoded.arrayBuffer());
  }
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  throw new TypeError("request body must be a string, Buffer, Uint8Array, or FormData");
}

function validateUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only http and https URLs are supported");
  if (parsed.username || parsed.password || parsed.hash) throw new Error("request URL must not contain userinfo or fragment");
  return parsed;
}

function directRequest({ method, url, headers, body, timeoutMs }) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers, rejectUnauthorized: true, timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on("error", (error) => reject(new HttpNetworkError(error)));
    });
    request.on("timeout", () => request.destroy(new HttpTimeoutError(timeoutMs)));
    request.on("error", (error) => {
      if (error instanceof HttpTimeoutError) reject(error);
      else reject(new HttpNetworkError(error));
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function responseObject(raw) {
  const body = raw.body;
  const text = () => Promise.resolve(body.toString("utf8"));
  return {
    status: raw.status,
    ok: raw.status >= 200 && raw.status < 300,
    statusText: raw.statusText,
    headers: new Headers(raw.headers),
    text,
    json: async () => JSON.parse(await text())
  };
}

async function send(url, init, proxy) {
  const method = init?.method ?? "GET";
  const headers = headersObject(init?.headers);
  const body = await encodeBody(url, method, init?.body, headers);
  if (body !== undefined) {
    headers["content-length"] = String(body.length);
    headers["content-type"] ??= "application/octet-stream";
  }
  const proxyValue = typeof proxy === "string" ? proxy.trim() : "";
  const raw = proxyValue !== "" && proxyValue.toLowerCase() !== "direct" && url.protocol === "https:"
    ? await requestViaTunnel({ method, url: url.toString(), headers, body, proxy: proxyValue, timeoutMs: TIMEOUT_MS })
    : await directRequest({ method, url, headers, body, timeoutMs: TIMEOUT_MS });
  const response = responseObject(raw);
  if (!response.ok) throw new HttpStatusError(response, await response.text());
  return response;
}

export function requestWorker(config, path, init = {}) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("manager request path must start with '/'");
  const url = new URL(path, `${config.workerApiUrl.replace(/\/+$/, "")}/`);
  const headers = {
    ...headersObject(init.headers),
    "CF-Access-Client-Id": config.accessId,
    "CF-Access-Client-Secret": config.accessSecret
  };
  return send(url, { ...init, headers }, config.proxy);
}

export function requestCloudflare(config, url, init = {}) {
  const headers = {
    ...headersObject(init.headers),
    Authorization: `Bearer ${config.uploadToken}`
  };
  return send(validateUrl(url), { ...init, headers }, config.proxy);
}
