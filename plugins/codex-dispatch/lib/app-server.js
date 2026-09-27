import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 18787;
const LAST_PORT = 18800;
const CLIENT_VERSION = "0.3.0";

function rpcError(method, error) {
  const detail = error?.message ?? JSON.stringify(error);
  const result = new Error(`codex app-server RPC ${method} 失败：${detail}`);
  if (error?.code !== undefined) result.code = error.code;
  result.data = error?.data;
  return result;
}

function codexJsPath() {
  const path = process.env.CODEX_JS_PATH ?? join(
    process.env.APPDATA ?? "",
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  if (!existsSync(path)) throw new Error(`找不到 codex app-server 脚本：${path}`);
  return path;
}

async function healthz(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    return response.ok;
  } catch (error) {
    if (error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED") return false;
    throw error;
  }
}

function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function selectPort() {
  if (await healthz(DEFAULT_PORT)) return { port: DEFAULT_PORT, ownsProcess: false };
  for (let port = DEFAULT_PORT; port <= LAST_PORT; port++) {
    if (await portAvailable(port)) return { port, ownsProcess: true };
  }
  throw new Error(`没有可用的 codex app-server 端口（${DEFAULT_PORT}-${LAST_PORT}）`);
}

class CodexAppServer {
  constructor({ logger = () => {} } = {}) {
    this.logger = logger;
    this.socket = null;
    this.process = null;
    this.port = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.connectPromise = null;
    this.disposePromise = null;
    this.terminating = false;
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect() {
    if (this.socket !== null) return;
    if (this.connectPromise !== null) return this.connectPromise;
    this.connectPromise = this.#connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async #connect() {
    const endpoint = await selectPort();
    this.port = endpoint.port;
    try {
      if (endpoint.ownsProcess) await this.#startProcess();
      await this.#openSocket();
      await this.request("initialize", {
        clientInfo: {
          name: "sagitta-codex",
          version: CLIENT_VERSION,
          title: "Sagitta codex dispatch",
        },
        capabilities: { experimentalApi: true },
      });
    } catch (error) {
      await this.#closeSocket();
      if (this.process !== null) await this.#terminateProcess();
      throw error;
    }
  }

  async #startProcess() {
    const path = codexJsPath();
    const url = `ws://127.0.0.1:${this.port}`;
    const child = (this.process = spawn(
      process.execPath,
      [path, "app-server", "--listen", url],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    ));
    await new Promise((resolve, reject) => {
      let stderr = "";
      const onData = (chunk) => {
        stderr += String(chunk);
        if (!stderr.includes(`listening on: ${url}`)) return;
        child.stderr.off("data", onData);
        child.stderr.on("data", (chunk) => this.logger(`sagitta-codex: app-server stderr：${String(chunk).trim()}`));
        child.off("error", onError);
        child.off("exit", onExit);
        resolve();
      };
      const onError = (error) => {
        child.stderr.off("data", onData);
        child.off("exit", onExit);
        reject(error);
      };
      const onExit = (code, signal) => {
        child.stderr.off("data", onData);
        child.off("error", onError);
        reject(new Error(`codex app-server 启动失败：code=${code} signal=${signal} stderr=${stderr.trim()}`));
      };
      child.stderr.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    child.on("error", (error) => this.logger(`sagitta-codex: app-server 进程错误：${error.message}`));
    child.on("exit", (code, signal) => {
      if (!this.terminating) this.logger(`sagitta-codex: app-server 已退出：code=${code} signal=${signal}`);
      this.#rejectPending(new Error(`codex app-server 已退出：code=${code} signal=${signal}`));
    });
  }

  #openSocket() {
    return new Promise((resolve, reject) => {
      const WebSocketClass = globalThis.WebSocket;
      if (typeof WebSocketClass !== "function") {
        reject(new Error("当前 Node 没有原生 WebSocket，无法连接 codex app-server"));
        return;
      }
      const socket = new WebSocketClass(`ws://127.0.0.1:${this.port}`);
      this.socket = socket;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.onerror = (event) => fail(new Error(`WebSocket error: ${event?.message ?? "unknown"}`));
      socket.onmessage = (event) => this.#message(event.data);
      socket.onclose = () => {
        this.#rejectPending(new Error("codex app-server WebSocket 已关闭"));
        if (!settled) fail(new Error("codex app-server WebSocket 在打开前关闭"));
        this.socket = null;
      };
    });
  }

  #message(data) {
    const message = JSON.parse(String(data));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(rpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === undefined) return;
    for (const listener of this.listeners) listener(message.method, message.params);
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params = {}) {
    if (this.socket === null) throw new Error(`codex app-server 尚未连接，不能调用 ${method}`);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async #closeSocket() {
    const socket = this.socket;
    if (socket === null) return;
    this.socket = null;
    this.#rejectPending(new Error("codex app-server 客户端关闭"));
    socket.close();
  }

  async #terminateProcess() {
    const child = this.process;
    this.process = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    this.terminating = true;
    if (process.platform === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
      return;
    }
    child.kill("SIGTERM");
  }

  async dispose() {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposePromise = (async () => {
      await this.#closeSocket();
      await this.#terminateProcess();
      this.listeners.clear();
    })();
    return this.disposePromise;
  }
}

export {
  CodexAppServer,
  DEFAULT_PORT,
  LAST_PORT,
};
