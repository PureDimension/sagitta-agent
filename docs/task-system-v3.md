# 任务系统 v3（涟漪 2026-09-07 拍板设计）

## 现状基线与实施落点

本仓库当前 Worker 已有 `owner_agent_id/claimed_at/claim_token/lease_seconds`、
`pending_status`、`task_events` 和 `task_need_human`。任务路由通过
`ensureTasksSchema()` 对存量 D1 做 `PRAGMA table_info` + 缺列 `ALTER TABLE` 的可重入迁移；
v3 不增加列，保留现有数据结构。

主要落点：

- `worker/worker.js`：claim/release 的 owner 会话权限、PATCH 终态分层、need-human
  resolve target、blocked 状态转移和旧 pending confirm 兼容。
- `plugins/memory/lib/task-gate.js`：本地 claims 变为云端 `claim_state=mine` 的可重建缓存；
  `plugins/memory/lib/tools.js` / `task-contract.js` / `client.js` 同步 v3 工具契约。
- `plugins/auto-advance/lib/service.js`：继续以 `pending_status === null` 判断可推进；
  普通 PATCH 终态直落后自然不再进入 pending 队列，round-close 的 pending 仍进入确认流程。
- `worker/test/smoke.mjs`：覆盖重启恢复、resolve target、他人 resolve、blocked 快速转移、
  PATCH/round-close confirm 分层和多 need 全清约束。

## v3 语义

### 1. Claim 会话化

- 权威归属是云端 `tasks.owner_agent_id`，其值等于 DSH `agent.id`/`SessionId`；同一
  对话重启后 id 不变，24 小时租约内仍是同一 owner。
- `POST /task/{id}/claim`：owner 本人且租约有效时视为续租恢复，返回成功，不返回
  `TASK_ALREADY_CLAIMED`；其他 owner 仍受租约保护。claim 仍可返回历史
  `claim_token`，但它只作旧客户端兼容，不是权限来源。
- owner 本人（`X-Agent-Id == owner_agent_id` 且租约有效）可以无 token claim/release/update；
  其他调用方即使持有旧 token 也不能取得 owner 权限。
- `task-gate` 启动/会话懒加载时用 `GET /task?owner=me&include_temp=1` 且带当前
  `X-Agent-Id` 重建 `mine` 集合；进程内 registry 只是缓存，丢失后不构成死锁。

兼容取舍：数据库中的 `claim_token` 不迁移、不删除，claim 响应暂保留该字段，避免旧
客户端解析失败；文档、工具和门禁不再把它当作会话的权威或重启恢复条件。

### 2. Need-human resolve 自由 + target

- resolve 不检查任务认领，不受执行门禁；任何有写权限的调用方都可 resolve。
- 请求支持 `target=open|in_progress|blocked|done`，缺省 `open`。解除当前 need 与
  任务状态流转在同一 D1 batch 中完成。
- `target=done` 只有在本条 resolve 后没有其他 open `type=need` 时允许，否则返回
  `TASK_NEED_HUMAN_OPEN`，need 不会被误标 resolved。
- `target=open/in_progress` 清除 `blocked_reason`；`target=done` 写 `done_at` 并释放
  owner；`target=blocked` 保留已有 `blocked_reason`，若为空使用本条 need 的 content
  作为服务端阻塞原因，以满足既有状态不变量。
- need 可以多挂；open need 只阻挡 done，不阻挡仍有其他可推进工作的任务继续推进。

### 3. 状态简化

- `reopen` 不再是 v3 正常概念。旧 pending 数据仍接受 `confirm(decision=reopen)`，
  兼容返回 `status=open`、`pending_status=null`，不重新进入 `in_progress`。
- blocked 任务 PATCH `status=open` 或 `status=in_progress` 直接成功并清理
  `blocked_reason`；blocked PATCH `status=done` 直接走终态写入，不要求先 reopen。
- 普通 PATCH 终态仍要求已有业务前置条件：done/blocked 从 `in_progress`，或 blocked→done
  shortcut；blocked 必须有非空原因，done 必须无 open need。

### 4. Confirm 分层

- 普通 `PATCH /task/{id}` 的 `status=done|blocked` 直接写最终状态，`pending_status` 保持
  null；done 由服务端写 `done_at`，done/blocked 都释放 owner。
- `POST /task/{id}/round-close` 的 `action=done|blocked` 继续写
  `pending_done|pending_blocked` 和 confirmation_id，必须经 confirm accept 才进入终态。
- 已存在的 pending 申请（旧数据或 round-close 途中）仍只能走 confirm；PATCH status 继续
  返回 pending conflict，避免覆盖在途申请。
- auto-advance 的 `actionableOwnedTasks`、turn-close 和 pending/recheck 逻辑继续按
  `pending_status === null` 工作：PATCH 直落后任务已经是 done/blocked，不会再次注入；
  round-close pending 保持原确认闭环。

## 验证与交付顺序

1. 先完成本文档并以 `node --check` 检查 Worker、memory、auto-advance。
2. 扩展 `worker/test/smoke.mjs`，运行 Worker smoke，并运行受影响的 memory/auto-advance
   smoke（若环境缺少外部 DSH 依赖，记录具体阻塞）。
3. 使用 `scripts/deploy-worker.ps1` 的 Direct multipart PUT 部署并通过 health check。
4. 按 `scripts/install-profile-deps.ps1` 的 profile 同步机制更新
   `C:\Users\cyan\.dsh\profiles\web\node_modules\@sagitta\*`，排除 `node_modules`。
5. git commit、push，并在交付报告中列出文件、commit、测试、部署和同步结果。
