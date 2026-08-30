# 任务系统强制力闭环 v1（task-enforcement-p1）

> 状态：设计定稿 v2（已吸收 codex 审查六契约）→ 待实施
> 关联：task-api-p1.md（云端 task API）、auto-advance（自主推进插件）、sagitta-codex（codex 派单插件）、@sagitta/async-work（通用有界工作注册表）
> 任务：tsk-20260830-0d1bed（P1 级）

## 1. 背景与问题

现状：任务系统（云端 D1 task API + 悬浮窗）是“显示器”——只负责显示任务，工作流（开场、推进、写回）全靠自觉。后果：

- 自主推进无法自然结束：结束靠模型主观判断输出【停止自主推进】，容易空转或过度推进；
- 工作与任务系统偏移：推进了但不写回，任务系统逐渐失真；
- 双实现（文件正则解析 vs API 映射）语义分裂，硬编码解析措辞脆弱；
- 终态普通 PATCH、云端读取失败、异步工作重启等边界会产生“误完成、误熄火、误注入”。

涟漪拍板（08-30）及 codex 审查定稿：

1. 云端 task API（D1）为唯一事实源；`TASKS.md` 不再参与自主推进资格判断；
2. 双实现收紧：严禁依赖“需涟漪确认/行动”等标题正则，任务语义全部使用独立字段和工具契约；
3. 任务终态采用“申请 pending → 独立 confirm”闭环，防止普通 PATCH 绕过确认；
4. auto-advance 只在取得合法云端快照后运行，云端错误一律 fail closed；
5. 有界异步工作统一进入 `@sagitta/async-work`，并按 `task_id` 隔离阻塞关系。

## 2. 核心概念原则

- **对话无状态，服务端不放松约束**：状态机的质询和自动注入只在自主推进模式（涟漪离开）启用；对话中 task 工具不主动注入。但 Worker 始终强制 pending、确认和 `done_at` 不变量，不能因为调用来自对话就允许直接写终态。
- **云端唯一事实源**：auto-advance 的资格判断、任务选择、确认队列和客观熄火只能使用合法的云端快照。UI 可以展示带 `source=file-stale` 的旧文件快照，但该数据不能进入任何资格判断。
- **任务 = 做了什么**：任务条目必须对应“可交付的推进单位”；验收/跟踪类不单独建任务，宏观目标放在 `project` 字段。
- **强制的是生命周期闭环，不是过程记账**：开始时置 `in_progress`，每轮用 `task_round_close` 写入一条进展事实，结束时申请终态并走 `task_confirm`；不要求用 PATCH 逐句记账。
- **prompt 是协议约束，不是硬权限边界**：结构化清单物理拼入 prompt 可减少偏移，但不能阻止模型调用文件、shell 或其他插件。真正的边界由 task 工具、服务端状态约束和有界工作注册表提供。
- **新想法先建任务**：新建任务后不得绕过本轮云端快照直接开展；任务在下一次成功拉取的快照中才成为可选项。若确实要在同一轮推进，必须由编排器重新拉取并校验完整快照。

## 3. 状态机（云端 schema 扩展）

现有 `status` 枚举保持不变：`open | in_progress | blocked | waiting | done`。

### 3.1 新增字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `blocked_reason` | TEXT 可空 | 阻塞原因；申请/进入 `blocked` 时必须为非空，必须指向超出 agent 能力范围的外部依赖（等涟漪、等外部系统、等网络等） |
| `pending_status` | TEXT 可空 | 唯一的终态申请载体，只允许 `pending_done`、`pending_blocked`、`null`；不是 `status` 新枚举 |

终态申请的 `confirmation_id`、进展和确认历史持久化在 §11 的 `task_events`，不把它们伪装成状态枚举。

### 3.2 不变量

```text
pending_status = null
  => status 为 open | in_progress | blocked | waiting | done

pending_status = pending_done
  => status = in_progress，done_at 为空，blocked_reason 为空

pending_status = pending_blocked
  => status = in_progress，done_at 为空，blocked_reason 非空

status = done
  => pending_status = null，done_at 非空
status = blocked
  => pending_status = null，blocked_reason 非空
```

`pending_status` 只能是上述三个值，两个 pending 不能共存。v2 服务端对新写入严格执行这些约束；迁移发现的历史 `blocked` 且无原因数据标为 legacy invalid，必须在启用终态写入前补数，不得由迁移伪造阻塞原因。

### 3.3 迁移规则（双重确认）

- 只有当前 `status=in_progress` 且 `pending_status=null` 的任务可以请求终态；`open` 必须先进入 `in_progress`。`task_create` 拒绝直接创建 `done` 或 `blocked`，也拒绝传入 `pending_status`、`done_at`。
- `task_update(status=done)` 或 `task_round_close(action=done)` 只写 `pending_status=pending_done`，不写 `done_at`，并返回服务端生成的 `confirmation_id` 与当前 `updated_at`。
- `task_update(status=blocked, blocked_reason=...)` 或 `task_round_close(action=blocked, blocked_reason=...)` 只写 `pending_status=pending_blocked`；缺少非空 `blocked_reason` 返回 422。
- `POST /task/{id}/confirm` 的 `accept` 才能原子迁移：`pending_done → status=done, pending_status=null, done_at=server_now`；`pending_blocked → status=blocked, pending_status=null`。`done_at` 只能由该确认路径写入，服务端拒绝任何普通 PATCH、create 或工具参数直接写入 `done_at`。
- `confirm(decision=reopen)` 将任一 pending 迁回 `status=in_progress, pending_status=null`，并清空当前 `blocked_reason`；原阻塞原因保留在事件历史中。reopen 后本轮不得再次自动结账，下一轮才能正常推进。
- pending 存在时，普通 PATCH 不得通过 `status=open|in_progress|waiting` 清除 pending，也不能再次申请另一个终态；传入 `status` 一律 409。`title/body/priority/checkbox` 可修改并刷新 `updated_at`，但不改变 pending；`blocked_reason` 在 `pending_blocked` 时可修订，在其他状态设置非空值返回 422。
- `blocked_reason` 加入 PATCH 白名单；禁止客户端直接传 `pending_status`、`done_at`、`created_at`、`updated_at` 等服务端字段。

质询只在自主推进模式下由 auto-advance 发起，但 Worker 不依赖调用者是否处于自主模式来放松状态机约束。

## 4. 入向强制（任务来源唯一化）

三层机制：

1. **onTimer 前置查询（机制层）**：auto-advance 在注入 prompt 前调用严格云端快照函数，将合法快照拆分为 runnable 集合、confirmation 队列、waiting 集合和 blocked/done 集合；有 runnable 时把结构化清单物理拼入 prompt，无 runnable 且无 pending 时客观熄火。快照不完整或失败不产生任何资格结论。
2. **协议层**：`AUTONOMOUS_PROMPT` 明确“新想法先 task_create 再推进”“清单外任务不能在本轮推进”“终态只能通过 task_confirm”；禁止从自然语言猜状态。
3. **会话层**：开场三件事第①件从“读 TASKS.md”改为云端 `task_list` 全量对账，注明每个任务的 `status/pending_status/blocked_reason`。

结构化清单是编排输入，不是硬权限。清单外工作若要进入流程，必须先 `task_create`，并等待下一次完整云端快照（或由编排器明确重拉快照）后才可被选择。

## 5. 出向强制（写回唯一化）

- 每个自主推进 round 最多接受一个 `task_round_close`；规范通道是工具调用，不依赖模型输出“完成了”等自然语言。
- `task_round_close` 的 `action=update` 只持久化本轮 `progress/next`，不改变任务状态；任务开始必须显式 `task_update(status=in_progress)`。`action=done|blocked` 只申请 pending，不直接进入终态。
- 收尾事件由 Worker 原子写入 `task_events`；不通过客户端 GET → 拼接 → 覆盖 `tasks.body`，不会丢失既有 notes 或上一轮进展。每轮一行进展和一项下一步即可。
- 文本 JSON 只作为兼容兜底，解析不唯一、缺字段、类型错误或未知 action 时不写任何任务状态；详见 §13。
- 每轮都要有结构化 close，除非该轮尚未选择任务。仅输出【停止自主推进】而没有 close 时，保留 `in_progress`，记录“未收尾停止”，不得据此写 `done/blocked`。

## 6. 触发条件与客观熄火

### 6.1 集合定义

```text
runnable = status ∈ {open, in_progress} AND pending_status = null
confirmation_queue = pending_status ∈ {pending_done, pending_blocked}
waiting = status = waiting（不要求绑定有界工作）
blocked/done = 终态（不进入 runnable）
```

pending 任务只进入 `confirmation_queue`，绝不进入 runnable。`waiting` 不要求绑定异步工作，也不会因为没有绑定而被反复打扰。任务 A 的异步工作不阻塞任务 B，调度判断必须按 `task_id` 做集合匹配。

### 6.2 onTimer 结果

每次 onTimer 必须先取得完整、合法的云端快照，并区分三种结果：

```text
cloud_ok + confirmation_queue 非空 -> 只注入带 task_id/confirmation_id/版本的确认质询
cloud_ok + runnable 非空           -> 注入带 runnable 清单的自主推进 prompt
cloud_ok + 两者均为空              -> 广播 autostop: no-runnable-tasks
cloud_error/auth_error/bad_response -> defer: task-api-unavailable，不注入、不迁移、不熄火
```

确认队列优先于普通推进；确认成功后下一次循环再读取快照。`onTimer` 是异步方法，`await` 前后都要检查 generation、agent running/idle、用户消息或 inbox、`enabled`、`stopped` 和 dispose 状态。每次查询绑定 `AbortController`，过期 generation 取消请求，禁止晚到响应注入 prompt。

云端失败使用有界指数退避和抖动重新 arm：约 30 秒、2 分钟、5 分钟封顶；UI/广播标记 degraded 并给出最后失败原因。恢复后必须重新拉完整快照，不能沿用旧快照熄火或选任务。保守停止绝不调用 `stopByProtocol`，也不把持久化模式改成 chat。

### 6.3 严格读取与 UI 读取

- `splitCloudTaskSnapshotStrict()`：安全等级为“资格判断”。只接受云端合法响应，校验字段、分页完整性、稳定排序和 pending 不变量；失败抛出 `task-api-unavailable`，不能返回空数组。
- `getTasks()`：仅供 UI 展示。可在云端失败时读取 `TASKS.md`，但结果必须带 `source=file-stale` 和错误信息；auto-advance、任务选择、确认和熄火禁止调用这条 fallback 路径。

### 6.4 传输与认证

auto-advance 与 memory task 工具统一使用同一份 worker URL、Bearer token/Access 双 key 和 CONNECT 配置；Access-only 配置必须在两条路径得到一致结果。生产访问非 loopback Worker 禁止 `direct`，统一使用 `DSH_MEMORY_PROXY`（或 profile 的同源 proxy 配置）；未配置 proxy 时明确报配置错误并 fail closed，不得静默直连 `workers.dev`。

## 7. 异步插件（有界工作泛化）

本质：把“有界工作”从 codex 专用泛化为任何需要等待、且等待期间不应触发自主推进的异步工作。

### 7.1 场景与绑定

安装过程、等待模型运行、等待外部系统响应等场景注册有界工作；同步操作和笼统后台 jobs 不注册。注册必须有 `task_id`，表示该工作只阻塞这个任务；agent 可以在等待任务 A 时推进任务 B。

### 7.2 通用注册表

新建 `@sagitta/async-work` 服务，唯一拥有通用注册表：

```js
register({ ownerId, taskId, kind, desc, timeoutMs }) -> work
listActive(ownerId, { taskId? }) -> work[]
get(ownerId, workId) -> work | null
complete(ownerId, workId)
fail(ownerId, workId, reason?)
cancel(ownerId, workId)
reap(ownerId)
```

记录至少包含 `work_id/task_id/owner_id/kind/desc/started_at/timeout_ms/status/ended_at/reason`；`timeoutMs` 由服务端校验 1 秒至 24 小时，越界返回 422，不允许用超长超时永久占用。`listActive` 只返回 running 且未超时工作，调用前后执行 `reap`。

codex-dispatch 改为该服务的适配器：`codex_dispatch` 必须接受并回传 `task_id`，codex 的 work 记录保留该绑定；现有 `sagitta-codex` facade 保留并兼容原调用，内部委托 `@sagitta/async-work`。auto-advance 只依赖 `sagitta-async-work`，不直接依赖 codex 内部 Map。

### 7.3 重启策略（v1 定稿）

v1 采用**进程范围声明，不恢复 detached 工作**：codex adapter 启动受控、非 detached 的子进程，服务 dispose 时先 `cancel` 并终止/回收子进程，再清空内存注册表；DSH 重启后不宣称任何旧 work 仍 active，也不从内存 Map 恢复。历史 detached codex 进程必须在启用新适配器前清理；无法确认清理结果时，auto-advance 进入 degraded 并 fail closed。

这样不会同时宣称“子进程可跨重启继续”和“注册表只在内存中有效”。若未来需要跨重启恢复，必须另立 v2：持久化 registry、启动时校验 PID/owner/task、定义 orphan 状态和恢复审计，不能在 v1 偷加隐式恢复。

## 8. 实施顺序

1. **D1 migration 与 Worker 状态/API**：先执行可重入线上 migration，补 `blocked_reason/pending_status/task_events`；实现 create/PATCH/confirm/round-close 的事务、条件更新和返回投影；更新 fresh schema 与 inline DDL。先通过 Worker 单测和旧任务回归。
2. **memory 工具与认证统一**：扩展 `TASK_FIELDS/pickTask`、task 工具描述与输出；保留 `task_update` 业务 PATCH，新增 confirm/round-close；统一 Bearer、Access 双 key、CONNECT 和 `DSH_MEMORY_PROXY`，移除推进资格路径的 `taskFallback`。
3. **严格云端快照与 auto-advance**：实现 `splitCloudTaskSnapshotStrict()`/UI `getTasks()` 分离、分页拉完整、runnable/confirmation 集合；把 onTimer 改异步，加入 generation、AbortController、广播和退避；先验证网络失败绝不注入。
4. **通用 async-work 与 codex 适配**：实现完整生命周期和超时回收，codex 补 `task_id` 并改非 detached 受控进程；验证服务不可用保守行为、任务 A/B 隔离和重启策略。
5. **接入 round close/confirm 与 prompt**：实现严格工具调用、pending 质询、accept/reopen 和文本 JSON 兼容兜底；定义 stop marker、重复提交和协议错误行为。
6. **整体验收与发布**：更新 D1 `batch` 测试 adapter 和 smoke；验证 Access/CONNECT、分页、并发、重试、重启、面板 stale 标记；通过 smoke 后再部署 Worker、重启目标 DSH，并核对 profile/preset 副本同步。

## 9. 边界与风险

- 云端唯一源使隧道、认证和 proxy 成为硬依赖；401/403、CONNECT/TLS、超时、404/503、坏 JSON 和分页截断均是错误态，不得变成空任务。
- `TASKS.md` fallback 仅服务 UI 离线展示，必须有 `source=file-stale`；严禁恢复为自主推进的隐式双源。profile 中的 `taskFallback: true` 必须移除，或限定为 UI-only。
- prompt 不是安全边界；若未来需要绝对禁止清单外工具调用，需另建工具层/工作区授权能力，不能把 prompt 拼接描述成硬权限。
- 质询机制不能变成过程填表；只要求开始、每轮一条 close、终态一次 confirm，progress/next 采用短文本事实记录。
- `done_at`、pending 和 confirm 必须由 Worker 服务端事务写入；任何旧客户端直接 PATCH done 的行为都会得到 pending，不得保留旧的“直接 done_at”兼容分支。
- `task_events` 解决收尾与确认审计，但仍需通过 `round_id + agent_id` 和 `expected_updated_at` 处理并发；body 继续是业务字段，不承担事件追加。
- 现有 smoke 已暴露测试 D1 adapter 缺少 `batch` 的问题；在 adapter 更新前不能把当前 smoke 结果当成全绿。

## 10. 审查结论与定稿契约

原稿审查结论为“需大改”；总体方向保留，但以下六个 P0 契约在 v2 锁定后才允许实施：

| 契约 | v1 定稿决策 |
|---|---|
| 状态契约 | `status` 保持五态；新增单字段 `pending_status`；只有 `in_progress` 可申请终态；create 禁止直接 done/blocked；reopen 回 in_progress；`blocked_reason` 进入 PATCH 白名单；`done_at` 只能由 confirm 写入 |
| API 契约 | 新增独立 confirm、round-close endpoint；confirm 用 `expected_pending + expected_updated_at + confirmation_id` 条件更新并处理 409；统一 401/403/409/422；线上 D1 用 `PRAGMA table_info` + 缺列 `ALTER TABLE ADD COLUMN` 可重入迁移 |
| 工具契约 | `task_update` 保持业务 PATCH；新增 `task_confirm`、`task_round_close`；所有 task 输出补 `blocked_reason/pending_status`；异步工作补 `complete/fail/cancel` 和必填 `task_id` |
| auto-advance 契约 | `splitCloudTaskSnapshotStrict()` 只做资格判断，`getTasks()` 只供 UI；runnable 为 `open|in_progress` 且无 pending；pending 进入确认队列，waiting 不要求绑定；onTimer 异步且 generation/取消/退避/广播完整；cloud_error 绝不注入；生产统一 `DSH_MEMORY_PROXY`，禁 direct |
| 注册表契约 | 新建 `@sagitta/async-work`，codex-dispatch 为适配器并保留 `sagitta-codex` facade；auto-advance 只依赖通用服务；按 task_id 判断阻塞；v1 不恢复 detached 进程，使用受控非 detached 生命周期 |
| 数据与审计契约 | progress/next 进入 `task_events`，不覆盖 body；`round_id + agent_id` 幂等，同键不同内容 409；confirm 以 `expected_updated_at` 条件更新；file fallback 退役为 UI-only stale 展示，不能参与资格判断 |

以上契约优先级高于旧工具描述、旧 prompt、旧 smoke 断言和旧 profile 配置；实施时必须同步更新所有消费者。

## 11. 数据模型

### 11.1 tasks 表

保留既有字段 `id/project/title/status/priority/checkbox/stream/body/created_at/updated_at/done_at/archived`，新增：

```sql
blocked_reason TEXT NULL,
pending_status TEXT NULL
```

新鲜数据库的 DDL 可以使用上述列定义；运行中的 D1 不得靠重复 `CREATE TABLE IF NOT EXISTS` 添加列。服务端校验 `pending_status` 的允许值和 §3 不变量；D1 schema 约束是辅助，不替代路由事务校验。

### 11.2 task_events 表与持久化格式

新增 `task_events` 作为不可变审计事实表，至少包含：

```text
event_id          TEXT PRIMARY KEY
task_id           TEXT NOT NULL
agent_id          TEXT NOT NULL
event_type        TEXT NOT NULL       -- round_close | terminal_requested | confirmed | reopened
round_id          TEXT NULL
action            TEXT NULL           -- update | done | blocked
progress          TEXT NULL
next              TEXT NULL
blocked_reason    TEXT NULL
pending_status    TEXT NULL
confirmation_id   TEXT NULL
expected_updated_at TEXT NULL
payload_json      TEXT NOT NULL
created_at        TEXT NOT NULL
```

建立 `task_id` 索引，并对 `round_close` 建唯一约束 `(task_id, agent_id, round_id)`；对非空 `confirmation_id` 建唯一约束。`agent_id` 来自运行时身份/工具上下文；不得让模型通过自然语言猜测。若当前认证层无法提供可信 agent 身份，工具必须显式传入稳定 `agent_id`，Worker 仍将其纳入幂等键。

`progress` 与 `next` 作为事件字段持久化，任务 `body` 不被 round-close 自动覆盖、不做客户端拼接。查询任务时可由最新 round event 投影 `last_progress/next` 供 UI 使用，审计仍以事件行和 `event_id` 为准。

文本规则：`progress` 必填，`next` 必填；trim 后各为 1–1000 个 Unicode 字符，禁止 NUL/控制字符和 CR/LF，必须是摘要而不是大段日志。不得写入 token、密码、Access key、个人敏感数据或完整外部响应；HTTP/access log 不记录认证头和完整 payload。违反 schema 返回 422，不能静默截断。

round-close 的插入与 pending 申请、`updated_at` 修改在同一 D1 原子批处理中完成。第一次提交返回事件和任务结果；相同 `(task_id, agent_id, round_id)` 且内容完全相同的重试返回第一次结果并标记 `idempotent=true`；同键不同内容返回 409，不覆盖原事件。

### 11.3 已部署 D1 migration

`ensureTasksSchema` 在 Worker 启动/部署前执行以下可重入流程，并在每步后复核结构：

```js
const taskInfo = await db.prepare('PRAGMA table_info(tasks)').all();
const taskColumns = new Set(taskInfo.results.map(row => row.name));
const alter = [];

if (!taskColumns.has('blocked_reason')) {
  alter.push(db.prepare('ALTER TABLE tasks ADD COLUMN blocked_reason TEXT'));
}
if (!taskColumns.has('pending_status')) {
  alter.push(db.prepare('ALTER TABLE tasks ADD COLUMN pending_status TEXT'));
}
if (alter.length) await db.batch(alter); // 仅执行真正缺失的列

// task_events 是新表：创建后仍需 PRAGMA table_info(task_events) 复核；
// 已存在但缺列时同样逐列 ALTER，不能无条件重复 ALTER。
```

`task_events` 新表可以使用 `CREATE TABLE IF NOT EXISTS`，但该语句不能替代已部署 `tasks` 的缺列 migration。migration 必须可重复执行；失败或只完成部分结构时，`ensureTasksSchema` 抛出并让 task route 进入不可用错误态，不能继续以旧 schema 提供服务。迁移不伪造历史 `blocked_reason`；legacy invalid 行在发布前由受控 backfill 处理。

## 12. API 契约

### 12.1 通用响应与错误

任务响应统一扩展 `blocked_reason/pending_status/done_at/updated_at`，pending 时额外返回当前 `confirmation_id`。变更响应至少包含完整 task 投影、`request_id` 和必要的 `idempotent` 标记。

错误统一为：

```json
{
  "error": { "code": "TASK_VERSION_CONFLICT", "message": "...", "details": {} },
  "request_id": "..."
}
```

- **401**：缺少、过期或无法验证 Bearer/Access 凭据；不执行任何写入。
- **403**：凭据有效但不具备对应 read/write scope，或不允许访问该 task；不执行任何写入。
- **409**：条件版本过期、pending 不匹配、重复 round 内容冲突、确认重放冲突或并发占用；返回当前安全可读的 task 投影。
- **422**：JSON/schema/枚举/长度/业务前置条件错误，例如 create 直接 done/blocked、终态缺少 blocked_reason、未知 action、非法 timeout。

### 12.2 既有接口边界

**`POST /task`**：接受 `open|in_progress|waiting`；拒绝 `done|blocked`、`pending_status` 和客户端 `done_at`，返回 422 `TASK_CREATE_TERMINAL_FORBIDDEN`。创建 `in_progress` 仍是正常开始态，不代表终态。

**`PATCH /task/{id}`**：业务白名单为 `status/priority/body/title/checkbox/blocked_reason`（可选实现 `expected_updated_at` 作为并发保护）；禁止 `pending_status/done_at/created_at/updated_at`。status 的终态写入遵守 §3：done/blocked 只生成 pending；pending 存在时传 status 返回 409；普通字段更新不清 pending。所有状态写入和 `updated_at` 修改服务端完成。

**`GET /task`**：返回稳定排序的 `total/page/size/has_more/items`，size 有服务端上限；auto-advance 必须拉完所有页并验证快照完整，不能把截断结果当成空集或完整清单。响应来源明确为 `source=cloud`。

### 12.3 `POST /task/{id}/confirm`

请求体：

```json
{
  "decision": "accept",
  "expected_pending": "pending_done",
  "expected_updated_at": "2026-08-30T12:34:56.000Z",
  "confirmation_id": "cnf-..."
}
```

字段契约：`decision` 为 `accept|reopen`；`expected_pending` 为 `pending_done|pending_blocked`；`expected_updated_at` 必填且必须等于当前任务版本；`confirmation_id` 必填且必须匹配当前 pending 请求事件。

Worker 必须在单一条件更新/事务中校验 task id、pending、版本和 confirmation id，不能先 GET 再 PATCH：

- `accept`：按 pending 类型写入 done 或 blocked，清空 pending；只有 pending_done 写入 `done_at=server_now`，pending_blocked 保留非空 `blocked_reason`；
- `reopen`：写 `status=in_progress, pending_status=null, blocked_reason=null`，并追加 reopened 事件；
- 同一 confirmation 的完全相同重试返回第一次结果并标 `idempotent=true`；同 confirmation 不同 decision 或不同 expected 值返回 409；当前 pending、版本或 confirmation 不匹配返回 409。

成功响应示例字段：`task_id/status/pending_status/blocked_reason/done_at/updated_at/confirmation_id/idempotent`。确认成功后 `pending_status=null`；普通 PATCH 永远不能产生同等结果。

### 12.4 `POST /task/{id}/round-close`

请求体：

```json
{
  "agent_id": "agent-main",
  "round_id": "round-20260830-001",
  "action": "update",
  "progress": "完成 API 状态契约与迁移草案",
  "next": "实现 Worker 条件更新并运行 smoke",
  "blocked_reason": null,
  "expected_updated_at": "2026-08-30T12:34:56.000Z"
}
```

`agent_id/round_id/action/progress/next` 必填；`blocked_reason` 仅 `action=blocked` 时必填且非空；`expected_updated_at` 对 `done|blocked` 必填，`update` 可选但有值时必须条件匹配。`action` 只允许 `update|done|blocked`。

- `update`：原子追加事件，任务状态保持不变；推荐当前任务为 `in_progress`，若是其他状态返回 422。
- `done`：原子追加事件并申请 `pending_done`，不写 `done_at`；成功响应包含 `confirmation_id/pending_status=pending_done`。
- `blocked`：原子追加事件并申请 `pending_blocked`，不进入 `status=blocked`；缺原因返回 422。
- 同 `(task_id,agent_id,round_id)` 同内容重试返回第一次结果；同键不同内容 409；事件写入、pending 申请和版本更新不能拆成客户端多步。

round-close 是结构化收尾唯一规范 API，不接受自然语言“完成/阻塞”作为等价协议。

## 13. 工具契约

### 13.1 task 工具

- `task_list`：返回云端分页合并后的任务投影，至少包含 `task_id/status/pending_status/blocked_reason/updated_at/done_at`；工具层统一 Bearer/Access/CONNECT 配置。
- `task_update`：保留业务 PATCH 语义，参数为 `task_id` 加 `status/priority/body/title/checkbox/blocked_reason` 的白名单字段，可带 `expected_updated_at`；不得有 `confirm=true`、`done_at` 或 `pending_status` 参数。请求 done/blocked 时输出 pending 事实、`confirmation_id` 和 `updated_at`，不得声称已完成/已阻塞。
- `task_confirm`：

  ```text
  task_confirm(
    task_id,
    decision: accept | reopen,
    expected_pending: pending_done | pending_blocked,
    expected_updated_at,
    confirmation_id
  )
  ```

  输出 `task_id/status/pending_status/blocked_reason/done_at/updated_at/confirmation_id/idempotent`；成功 accept 才是终态，reopen 输出 `status=in_progress`。

- `task_round_close`：

  ```text
  task_round_close(
    task_id,
    round_id,
    action: update | done | blocked,
    progress,
    next,
    blocked_reason?,
    expected_updated_at?
  )
  ```

  输出 `event_id/round_id/idempotent` 及完整任务投影，必须包含 `blocked_reason/pending_status`；done/blocked 输出 pending 和确认上下文，不直接输出终态。

### 13.2 异步工作工具

通用工具由 `@sagitta/async-work` 提供：

```text
async_register(task_id, kind, desc, timeoutMs)
async_status(work_id?, task_id?)
async_complete(work_id, task_id)
async_fail(work_id, task_id, reason?)
async_cancel(work_id, task_id)
```

`task_id` 在 register/complete/fail/cancel 中必填，服务端核对 work 绑定；查询可以用唯一 `work_id` 或按 `task_id` 过滤。每个输出保留 `work_id/task_id/status/started_at/timeout_ms/ended_at/reason`。状态只允许 `running|completed|failed|cancelled|expired`，终态不可再次完成。

`codex_dispatch` 新增必填 `task_id` 并返回通用 `work_id`；`sagitta-codex` 原 facade 的方法名和返回兼容层保留，但 auto-advance 不再读取其内部注册表。

### 13.3 收尾解析容错

严格工具调用优先。文本兼容通道只接受一个完整、唯一的 JSON 对象或 fenced JSON，字段必须满足 `task_id/action/progress/next/round_id` schema；多个对象、前后混杂、字段缺失、类型错误、未知 action 均为协议错误。解析失败时：

1. 不写 status、不写 pending、不写 `done_at`、不追加伪造 close；
2. 广播 `close-protocol-error`，最多注入一次修复提示；连续失败则停止本轮或进入退避；
3. 仅有【停止自主推进】而无 close 时，保留任务 `in_progress`，记录未收尾停止；不能为熄火而自动标 done/blocked。

## 14. 实施验收清单

### A. Worker、迁移与状态

- [ ] 对已有 D1 执行两次 migration：`PRAGMA table_info` 只为缺失列执行 `ALTER TABLE ADD COLUMN`，第二次无重复 ALTER；migration 失败不会继续提供旧路由。
- [ ] fresh schema、inline DDL、`tasks` 投影和 `task_events` schema 一致；legacy blocked-null 行有明确 backfill/阻断结果。
- [ ] 覆盖全部 pending 不变量；只有 `in_progress` 可请求 done/blocked；create 直接 done/blocked 返回 422。
- [ ] `blocked_reason` 在 PATCH 白名单；blocked/pending_blocked 无原因返回 422；pending 存在时普通 status PATCH 返回 409。
- [ ] 只有 confirm accept 的服务端路径写 `done_at`；reopen 清 pending、回 in_progress 并清当前 `blocked_reason`。
- [ ] confirm 的 stale `expected_updated_at`、错误 pending、重复 confirmation、不同内容重放均有正确 409/幂等断言。

### B. API、工具与审计

- [ ] confirm 请求严格校验 `decision/expected_pending/expected_updated_at/confirmation_id`，round-close 校验 `round_id/action/progress/next/blocked_reason`。
- [ ] 401、403、404、409、422 响应结构统一；不在错误日志中记录认证头或敏感 payload。
- [ ] `round_id + agent_id` 同内容重试不重复写入，不同内容 409；事件与 pending/版本更新原子完成。
- [ ] round-close 不覆盖 `tasks.body`；查询可得到最新 progress/next，审计可按 event_id 追溯请求、确认、reopen。
- [ ] memory 的 `TASK_FIELDS/pickTask`、工具 description/output、面板元数据全部包含 `blocked_reason/pending_status`；不存在 `confirm=true` 旁路。

### C. auto-advance 与传输

- [ ] `splitCloudTaskSnapshotStrict()` 只接受完整云端快照；分页截断、坏 JSON、401/403/404/503、超时和 CONNECT/TLS 失败都进入 unavailable。
- [ ] `getTasks()` 的 file fallback 仅返回 `source=file-stale` UI 数据；资格判断、任务选择、confirm、熄火完全不读取文件。
- [ ] runnable 仅为无 pending 的 open/in_progress；pending 只进 confirmation queue；waiting 不要求异步绑定；成功空集才广播 `autostop: no-runnable-tasks`。
- [ ] onTimer await 期间模拟 generation 变化、用户输入、agent running、disable 和 dispose，确认不会晚到注入或迁移。
- [ ] 重试使用约 30s/2min/5min 退避并广播 degraded；cloud_error 绝不注入、绝不 stopByProtocol、绝不当成空集。
- [ ] Access-only、Bearer、CONNECT 和生产 `DSH_MEMORY_PROXY` 配置在 auto-advance 与 memory 工具行为一致；生产禁止 direct。

### D. async-work、codex 与回归

- [ ] `@sagitta/async-work` 覆盖 register/listActive/get/complete/fail/cancel/reap、ownerId+taskId、timeout 上下限和重复终态保护。
- [ ] codex adapter 传递 task_id/work_id，sagitta-codex facade 兼容；任务 A 的 active work 不阻塞任务 B。
- [ ] 服务不可用/查询失败按“有工作”保守处理并 degraded；超时自动 reap 后恢复调度。
- [ ] codex 子进程为受控非 detached；dispose 会终止/回收；重启不恢复旧 registry，遗留 detached 进程清理失败时 fail closed。
- [ ] 更新 D1 测试 adapter 的 `batch` 能力，补齐 pending、confirm、round-close、分页、网络失败、Access/CONNECT、并发、重复 close、解析错误和重启场景 smoke。

全部清单通过后，才允许部署 Worker、重启目标 DSH、复核 profile/preset 配置并由 Sagitta 统一提交；本设计稿本身不包含其他文件修改和 git commit。
*** End Patch
