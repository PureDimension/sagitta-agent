import assert from "node:assert/strict";
import { AsyncWorkRegistry } from "../../async-work/lib/registry.js";
import { CodexAppServer } from "../lib/app-server.js";

const MODEL = "gpt-5.6-luna";
const CWD = "D:\\workspace\\exp";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDefaultHealthUnavailable(action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "http://127.0.0.1:18787/healthz") return new Response("forced test miss", { status: 503 });
    return originalFetch(input, init);
  };
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function waitFor(predicate, message, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(message);
}

function notificationWaiter(client, method, threadId) {
  return new Promise((resolve) => {
    const dispose = client.onNotification((received, params) => {
      if (received !== method || (threadId !== undefined && params?.threadId !== threadId)) return;
      dispose();
      resolve(params);
    });
  });
}

async function directContextCase() {
  const client = new CodexAppServer();
  await client.connect();
  const started = await client.request("thread/start", { cwd: CWD, model: MODEL });
  const threadId = started.thread.id;
  const completed1 = notificationWaiter(client, "turn/completed", threadId);
  const first = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "请只回答固定字符串 CONTEXT_FIRST_OK，不要调用工具。" }],
  });
  await completed1;

  const deltas = [];
  const stopDeltas = client.onNotification((method, params) => {
    if (method === "item/agentMessage/delta" && params.threadId === threadId) deltas.push(params.delta);
  });
  const secondCompleted = notificationWaiter(client, "turn/completed", threadId);
  const second = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "请复述上一轮的固定字符串，并包含它。" }],
  });
  await secondCompleted;
  stopDeltas();
  const secondText = deltas.join("");
  assert.match(secondText, /CONTEXT_FIRST_OK/u);
  console.log(`SECOND_TURN_RAW ${JSON.stringify({ threadId, firstTurnId: first.turn.id, secondTurnId: second.turn.id, response: secondText })}`);
  await client.dispose();
}

async function toolCase() {
  let plugin;
  try {
    plugin = await import("../lib/index.js");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      console.log(`codex app-server integration: SKIP (peer runtime unavailable: ${error.message})`);
      return;
    }
    throw error;
  }

  const asyncWork = new AsyncWorkRegistry();
  const tools = new Map();
  const listeners = new Map();
  const requestLog = [];
  const turnEvents = [];
  const originalRequest = CodexAppServer.prototype.request;
  const originalOnNotification = CodexAppServer.prototype.onNotification;
  CodexAppServer.prototype.request = function (method, params = {}) {
    requestLog.push({ method, params });
    return originalRequest.call(this, method, params);
  };
  CodexAppServer.prototype.onNotification = function (listener) {
    return originalOnNotification.call(this, (method, params) => {
      if (method === "turn/started" || method === "turn/completed") turnEvents.push({ method, params });
      return listener(method, params);
    });
  };
  let ctx;
  try {
    ctx = {
      tools: { register(tool) { tools.set(tool.name, tool); } },
      "sagitta-async-work": asyncWork,
      "sagitta-manager": { apiConfig: async () => ({ codexModel: MODEL }) },
      logger: { warn(message) { console.log(`PLUGIN_WARN ${message}`); } },
      on(event, listener) {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
        return () => set.delete(listener);
      },
      effect(factory) { this.dispose = factory(); },
    };
    plugin.apply(ctx, { workTimeoutMs: 120000, maxConcurrent: 4 });
    const dispatch = tools.get("codex_dispatch");
    const status = tools.get("codex_status");
    const append = tools.get("codex_append");
    assert.ok(dispatch && status && append, "all codex tools must be registered");
    const exec = { agent: { id: "integration-owner" } };

    const first = await withDefaultHealthUnavailable(() => dispatch.execute({
      task_id: "integration-first",
      task: "请只回答固定字符串 DISPATCH_FIRST_OK，不要调用工具。",
      cwd: CWD,
    }, exec));
    console.log(`DISPATCH_RAW ${JSON.stringify(first)}`);
    await waitFor(() => turnEvents.some((event) => event.method === "turn/completed" && event.params?.threadId === first.thread_id), "第一轮没有收到 turn/completed");
    const firstStatus = await status.execute({ work_id: first.work_id }, exec);
    assert.equal(firstStatus.works[0].status, "completed");
    console.log(`ASYNC_COMPLETED_RAW ${JSON.stringify(firstStatus.works[0])}`);

    const completedTurnCountBeforeAppend = turnEvents.filter((event) => event.method === "turn/completed" && event.params?.threadId === first.thread_id).length;
    const completedAppend = await append.execute({
      work_id: first.work_id,
      message: "追加指示：请只回答固定字符串 AFTER_COMPLETED_APPEND_OK，不要调用工具。",
    }, exec);
    const completedAppendRequest = requestLog.at(-1);
    assert.equal(completedAppendRequest.method, "turn/start");
    await waitFor(
      () => turnEvents.filter((event) => event.method === "turn/completed" && event.params?.threadId === first.thread_id).length > completedTurnCountBeforeAppend,
      "任务结束后 append 没有收到后续 turn/completed",
    );
    const completedAfter = await status.execute({ work_id: first.work_id }, exec);
    assert.equal(completedAfter.works[0].thread_id, first.thread_id);
    assert.match(completedAfter.works[0].response, /AFTER_COMPLETED_APPEND_OK/u);
    console.log(`CODEX_APPEND_AFTER_COMPLETED_RAW ${JSON.stringify({
      result: completedAppend,
      request: completedAppendRequest,
      completed: turnEvents.filter((event) => event.method === "turn/completed" && event.params?.threadId === first.thread_id).at(-1),
      response: completedAfter.works[0].response,
    })}`);

    const active = await dispatch.execute({
      task_id: "integration-active",
      task: "请依次执行 3 次 sleep 2 命令，每次完成后再执行下一次，最后只回答 ACTIVE_DONE。不要提前结束。",
      cwd: CWD,
    }, exec);
    await waitFor(() => turnEvents.some((event) => event.method === "turn/started" && event.params?.threadId === active.thread_id), "运行中任务没有收到 turn/started");
    const activeStartedCountBeforeAppend = turnEvents.filter((event) => event.method === "turn/started" && event.params?.threadId === active.thread_id).length;
    const appended = await append.execute({
      work_id: active.work_id,
      message: "追加指示：完成原来的 sleep 后，回复 ACTIVE_APPEND_OK。",
    }, exec);
    assert.equal(appended.work_id, active.work_id);
    const activeAppendRequest = requestLog.at(-1);
    assert.equal(activeAppendRequest.method, "turn/start");
    await waitFor(() => turnEvents.some((event) => event.method === "turn/completed" && event.params?.threadId === active.thread_id), "运行中 append 没有收到 turn/completed");
    const activeAfter = await status.execute({ work_id: active.work_id }, exec);
    assert.equal(turnEvents.filter((event) => event.method === "turn/started" && event.params?.threadId === active.thread_id).length, activeStartedCountBeforeAppend);
    assert.match(activeAfter.works[0].response, /ACTIVE_APPEND_OK/u);
    console.log(`CODEX_APPEND_ACTIVE_RAW ${JSON.stringify({
      result: appended,
      request: activeAppendRequest,
      turnStartedCount: activeStartedCountBeforeAppend,
      completed: turnEvents.filter((event) => event.method === "turn/completed" && event.params?.threadId === active.thread_id).at(-1),
      response: activeAfter.works[0].response,
    })}`);
    console.log(`ASYNC_ACTIVE_COMPLETED_RAW ${JSON.stringify(activeAfter.works[0])}`);

    console.log("codex app-server integration: PASS (real server, dispatch, async-work completion, completed append, active append, context retained)");
  } finally {
    if (ctx?.dispose) await ctx.dispose();
    CodexAppServer.prototype.request = originalRequest;
    CodexAppServer.prototype.onNotification = originalOnNotification;
  }
}

await directContextCase();
await toolCase();
