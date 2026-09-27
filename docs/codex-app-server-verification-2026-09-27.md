# codex app-server 协议验证记录（2026-09-27，本机实测）

> 三个实验全部在本机跑通。脚本：`D:\workspace\exp\codex-verify.mjs`、`codex-verify-steer.mjs`、`codex-verify-append.mjs`

## 环境事实

- **Windows 上 `codex app-server daemon` 不可用**：`Error: codex app-server daemon lifecycle is only supported on Unix platforms`。因此必须自己起进程。
- 启动方式：`node <APPDATA>\npm\node_modules\@openai\codex\bin\codex.js app-server --listen ws://127.0.0.1:<PORT>`
  启动后 stderr 打印 `listening on: ws://127.0.0.1:PORT`，另有 `/healthz`、`/readyz`。
- **消息格式**：简化 JSON-RPC，**无 `jsonrpc` 字段**：`{ id, method, params }`；响应 `{ id, result|error }`；通知 `{ method, params }`（无 id）。
- **必须先握手**，否则一切请求返回 `{"code":-32600,"message":"Not initialized"}`：
  `{ id, method: "initialize", params: { clientInfo: { name, version }, capabilities: { experimentalApi: true } } }`
- 协议可由 `codex app-server generate-json-schema --out <dir>` 导出（v2 有 252 个消息类型）。

## 实验一：基础链路（`codex-verify.mjs`）

```
initialize → thread/start → turn/start → item/agentMessage/delta（流式）→ turn/completed
→ 第二轮 turn/start，问"复述上一条回答" → 回答"你上一条回答是：'你收到指令了。'" ✅ 上下文保留
```

## 实验二：`turn/steer`（`codex-verify-steer.mjs`）

起一轮长任务（3 × sleep 12），6 秒后调用 `turn/steer`：

```
turn/steer 结果 → 成功: {"turnId":"01a0e234-58a6-7920-9281-e0818761f8dd"}
codex 最终回复："开始执行第 1 条命令。第 1 条命令已完成。根据追加指示，未执行第 2、3 条命令，任务结束。"
```

**追加的指示作为一条新的 `userMessage` 进入历史**，codex 重新 reasoning 后按新指示结束。

- `turn/steer` **必须带 `expectedTurnId`**（当前活跃轮次 id），不匹配则请求失败。
- 语义是"改变**正在进行的这一轮**的方向"。

## 实验三：轮次进行中再调 `turn/start`（`codex-verify-append.mjs`）★关键

```
turnA = 01a0e234-f4d2-7100-a1af-6c67692935a9   （第一轮）
6 秒后再调 turn/start →
   ✅ 成功  返回 turnB = 01a0e234-f4d2-7100-a1af-6c67692935a9   ← 与 turnA 完全相同
事件序列：turn/started 只出现 1 次；item/started userMessage 出现 2 次；turn/completed 只出现 1 次
codex 输出采纳第二条："…现在执行第 2 条命令；完成后我会直接总结，不再执行第 3 条。…按你的要求，未执行第 3 条。"
```

**结论：`turn/start` 自己处理了两种情况**

```
turn/start = "把这个输入交给这个会话"
    有活跃轮次 → 并入该轮次（返回当前 turnId）
    无活跃轮次 → 开新一轮（返回新 turnId）
```

**因此"给会话追加一条指示"不需要任何状态判断，也不需要新方法** —— 与 `codex_dispatch` 用的是同一个方法。

## 对设计的直接影响

| 能力 | 实现 |
|---|---|
| 派单 | `thread/start` + `turn/start` |
| **追加指示** | **`turn/start`（同一方法，零分支）** |
| 改变正在进行的那一轮 | 才需要 `turn/steer` + `expectedTurnId` |
| 中断某一轮 | `turn/interrupt`（会话保留） |
| 读历史 | `thread/read`（可选 `includeTurns`） |

## 实测可用的通知（按时间顺序）

```
thread/started / thread/status/changed(active|idle) / mcpServer/startupStatus/updated
turn/started { turn: { id, status:"inProgress" } }
item/started · item/completed   （item.type: userMessage | agentMessage | reasoning | commandExecution …）
item/agentMessage/delta         （流式增量）
thread/tokenUsage/updated       （token 用量）
account/rateLimits/updated      （周额度：usedPercent / windowDurationMins / resetsAt —— 可用于额度监控）
turn/completed
```

## 附带发现

- `thread/start` 支持 `sandbox` / `approvalPolicy` / `model` / `cwd` 等参数；实测传 `sandbox: "danger-full-access"` + `approvalPolicy: "never"` 后 codex 能正常执行命令。
- `input` 数组的元素形如 `{ type: "text", text: "..." }`。
