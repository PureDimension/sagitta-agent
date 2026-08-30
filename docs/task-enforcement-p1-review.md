# 任务系统强制力闭环 v1 工程审查意见

审查对象：`docs/task-enforcement-p1.md`（任务系统强制力闭环 v1）  
审查日期：2026-08-30  
审查范围：设计稿、已上线 `/task` Worker、`tasks` schema、auto-advance、codex-dispatch、memory task 工具及现有冒烟测试。

## 总结结论

设计方向成立：云端任务作为事实源、auto-advance 负责自主推进编排、任务终态需要二次确认、有界异步工作需要绑定任务，这几个方向与现有代码的职责划分基本一致。

但当前稿件还不能直接按“定稿”实施。终态确认协议、云端状态不变量、收尾写回的幂等语义、云端读取失败策略以及已部署 D1 的迁移方案都尚未形成可执行契约；其中几项会直接导致“网络故障被当成无任务”“普通 PATCH 绕过确认”“重复收尾覆盖 body”等生产级错误。

总体结论：**需大改**。这里的“大改”是指必须先补齐设计契约并同步调整现有 API/工具边界，不是要求推倒重来。补齐下文 P0 项、通过 smoke 后，可以沿现有总体方向实施。

## 现状基线与核对结果

1. Worker 目前的任务状态仍是 `open | in_progress | blocked | waiting | done`；`tasks` 表只有 `id/project/title/status/priority/checkbox/stream/body/created_at/updated_at/done_at/archived`，`schema.sql` 与 Worker 内的自举 DDL 两处重复维护（`worker/schema.sql:76-95`、`worker/worker.js:916-945`）。
2. 当前 `PATCH /task/{id}` 只允许 `status/priority/body/title/checkbox` 五个字段，并且只要 PATCH 的 `status=done`，Worker 就会填写 `done_at`；它没有 pending 或确认概念（`worker/worker.js:1091-1146`）。
3. `task_update` 工具直接把参数映射为上述 PATCH；输出契约也没有 `blocked_reason`、`pending_status`（`plugins/memory/lib/tools.js:862-897`、`966-980`）。
4. auto-advance 的 `onTimer` 目前是同步方法，直接构造并注入固定 `AUTONOMOUS_PROMPT`，没有云端前置查询，也没有收尾或确认解析（`plugins/auto-advance/lib/service.js:464-516`）。已有的 `getTasks()` 在 API 失败时默认回退 `TASKS.md`（`plugins/auto-advance/lib/service.js:314-330`）。
5. auto-advance 当前只识别 `sagitta-codex.listActiveWorks(agentId)`；该注册表是 codex 插件内部的内存 `Map`，dispose 时清空（`plugins/auto-advance/lib/service.js:379-418`、`plugins/codex-dispatch/lib/index.js:46-123`、`193-209`）。
6. Worker 已实现读写 Bearer 分流，Cloudflare Access 网关放行时按 `CF-Access-Jwt-Assertion` 处理；auto-advance 自己支持 Bearer 或 Access 双 key，并可选择 CONNECT 隧道，但默认 proxy 是 `direct`（`worker/worker.js:251-274`、`plugins/auto-advance/lib/service.js:674-737`）。

## §10 五个待审查项

### a. 中间态：`pending_status` 单字段还是独立状态枚举

结论：**v1 采用新增 `pending_status`，不要把 `status` 扩展为 `pending_done/pending_blocked`。但必须把两字段不变量写死，并把终态确认从普通 PATCH 中分离出来。**

选择理由：

- 保留 `status=in_progress` 能兼容现有 `GET /task?status=in_progress`、auto-advance 的任务筛选、任务工具枚举和已有 UI；独立枚举会让所有现有消费者都必须同时理解两个新状态。
- `done_at` 可以继续保持“真实进入 `status=done` 时才由服务端填写”的含义。`pending_done` 只是意图，不是完成事实。
- 未来若需要把 pending 作为完整状态机对外呈现，可以在 API 响应中增加派生字段 `lifecycle_status`，不必立即破坏现有 `status` 语义。

建议的不变量：

```text
pending_status = null
  => status 为现有五态之一
pending_status = pending_done
  => status = in_progress，done_at 为空
pending_status = pending_blocked
  => status = in_progress，blocked_reason 非空，done_at 为空
```

并且：

- `pending_status` 只能是 `pending_done | pending_blocked | null`，两个 pending 不能共存。
- 只允许从 `in_progress` 请求终态。`open` 必须先进入 `in_progress`；这样“开始填一次、结束填一次”的生命周期才有明确入口。若确实要允许 `open → done`，必须单独定义这一例外及其审计语义。
- `task_update(status=done)` 只创建 `pending_done`，不得写 `done_at`；`task_update(status=blocked, blocked_reason=...)` 只创建 `pending_blocked`。
- pending 存在时，普通 PATCH 不得通过再传 `status=open/in_progress/waiting` 清掉 pending。允许修改 title/body 等业务字段时，也要明确是否会刷新 pending 的版本；建议只允许确认接口和显式 `reopen` 清除 pending。
- 确认完成才执行原子迁移：`pending_done → status=done, pending_status=null, done_at=server_now`；确认阻塞：`pending_blocked → status=blocked, pending_status=null`；拒绝确认：`pending_* → status=in_progress, pending_status=null`。拒绝 blocked 时是否保留 `blocked_reason` 必须定稿；建议清空当前阻塞原因，历史留在事件中。
- `task_create` 不应允许直接创建 `done` 或 `blocked`。建议创建接口拒绝这两种状态，避免新任务绕过确认；正常创建只接受 `open/in_progress/waiting`。
- `blocked_reason` 必须加入 API PATCH 白名单及 `task_update` 参数。当前 Worker 的 create 允许无原因 `status=blocked`，这与设计稿的 422 约束冲突（`worker/worker.js:1054-1088`）。

与现有 PATCH 的兼容约束：

当前 API 和工具都把 `status=done` 描述为“完成”，并且现有测试断言直接 PATCH 后 `done_at` 应写入。实施后必须同时更新 Worker、memory 工具描述、返回字段、smoke 断言和面板渲染，否则同一个调用在不同层会被理解成“已完成”或“待确认”。`done_at` 只能由确认迁移路径写入；这是服务端约束，不应交给 agent 或 `task_update` 参数。

独立状态枚举并非永远错误，但它更适合一次性升级所有消费者、筛选、排序和 UI 的后续版本。当前云端 API 已部署且工具契约已使用五态，v1 采用它会增加迁移面，收益不足。

### b. 质询确认协议及与 `task_update` 的冲突

结论：**新增独立的 `task_confirm`（或 `task_finalize`）工具和对应 Worker endpoint；不要给 `task_update` 增加含义混杂的 `confirm=true` 特殊参数，也不要把自然语言“是/确认”当作可靠协议。**

建议协议：

```text
POST /task/{id}/confirm
{
  "decision": "accept" | "reopen",
  "expected_pending": "pending_done" | "pending_blocked",
  "expected_updated_at": "...",
  "confirmation_id": "..."
}
```

工具可以暴露为：

```text
task_confirm(
  task_id,
  decision: accept | reopen,
  expected_pending,
  expected_updated_at,
  confirmation_id
)
```

其中 `accept` 根据 pending 类型落 `done` 或 `blocked`，`reopen` 回到 `in_progress`。接口必须在 Worker 侧做条件更新或事务化检查，条件不匹配返回 409；不能先 GET 再 PATCH，否则多个 agent/重复调用会产生竞态。

auto-advance 的交互顺序应明确为：

1. agent 用 `task_update(status=done|blocked, ...)` 请求终态，Worker 返回 pending 事实及版本/确认标识。
2. auto-advance 发现 pending 后，只向该 agent 注入带 `task_id/pending_status/expected_updated_at/confirmation_id` 的质询。
3. agent 必须调用独立的 `task_confirm`；调用成功后由 Worker 完成真实迁移。
4. `reopen` 后下一轮才允许正常推进，不能在同一轮自动再次结账。

这样做的好处是普通 `task_update` 仍然只代表业务字段更新，终态申请和终态确认在工具名、路由、返回值上完全分开。若把 `confirm` 塞进 `task_update`，容易出现 `{status:"done", confirm:true}`、只传 `confirm:true`、或旧 agent 只传 `status=done` 的歧义。

需要特别明确一个边界：Worker 目前只知道 Bearer/Access 认证，不知道调用者是否处于“自主推进模式”。因此“状态机只在自主推进模式启用”不能解释成“普通 API 调用可以直接写终态”。推荐做法是：**Worker 始终强制 pending/确认不变量；只有 auto-advance 在自主模式下负责发起质询和维护当前确认上下文。** 对话中的 task 工具可以记录或产生 pending，但不主动注入质询；待进入自主模式后再处理 pending。若必须禁止对话直接 `task_confirm`，需要额外的、不可伪造的 auto-advance capability/nonce 或独立服务权限，当前稿件没有这部分基础设施，不能假设仅靠工具描述就能做到。

`confirmation_id`/版本还应具备一次性或幂等语义。最小实现可以使用任务的 `updated_at` 加服务端生成的 pending revision；更稳妥的是落一张 task event/idempotency 表。仅靠 auto-advance 的内存 Map，重启后会丢失确认上下文。

### c. 有界工作注册表的模块边界

结论：**建议新建 `@sagitta/async-work`，由它拥有通用注册表服务；codex-dispatch 改为该服务的一个适配器，并保留 `sagitta-codex` facade 兼容现有调用。**

两种方案比较：

| 方案 | 优点 | 主要问题 |
|---|---|---|
| 泛化 `codex-dispatch` | 改动文件少，可直接复用已有 `CodexWorkRegistry`、超时回收和 smoke 经验 | 通用安装/等待工作被迫依赖 codex；注册表仍带 `model/pid` 等 codex 字段；codex 的并发上限和生命周期会成为全局语义；codex 被禁用时其他异步工具没有自然归属 |
| 新建 `@sagitta/async-work` | 通用 owner/task/kind/timeout 生命周期单一归属；auto-advance 只依赖抽象服务；codex 和其他插件平级 | 增加插件安装/启动顺序和迁移工作；需要处理旧 `sagitta-codex` 服务兼容与可选依赖 |

建议抽出的服务接口至少包括：

```text
register({ ownerId, taskId, kind, desc, timeoutMs }) -> work
listActive(ownerId, { taskId? }) -> work[]
get(ownerId, workId) -> work | null
complete(ownerId, workId)
fail(ownerId, workId, reason?)
cancel(ownerId, workId)
reap(ownerId)
```

模型工具可提供 `async_register`、`async_status`、`async_complete`、`async_cancel`；当前设计只有 register/status，没有明确“谁把 running 变成 done”的接口，无法形成闭环。`async_status(task_id?)` 也不足以唯一定位同一任务的多个工作，查询和完成应使用 `work_id`，task_id 作为过滤/绑定。

注册表实现注意点：

- `task_id` 必填，并保留 `kind/desc/startedAt/timeoutMs/status/endedAt`；对 `timeoutMs` 设上下限，不能让 agent 通过超长超时永久占用。
- auto-advance 只依赖 `sagitta-async-work` 一个服务；服务不存在或查询失败时保守视为“有工作”，并广播 degraded 状态，不能回退到笼统 jobs。
- 现有 codex 注册表是按 agent 的全局 active 工作判断；但设计稿要求“有其他独立任务时继续推进”。因此应按 `task_id` 判断：任务 A 的 codex 工作不能阻塞任务 B 的自主推进。当前 `hasRunningWork(agent)` 一旦发现任意 codex work 就返回 true（`plugins/auto-advance/lib/service.js:395-401`），需要改成任务集合级调度，而不只是把两个数组相加。
- 现有注册表是进程内内存，`dispose` 会清空，而 codex 子进程是 detached、可以继续运行（`plugins/codex-dispatch/lib/index.js:165-180、206-209`）。DSH 重启后子进程仍在但注册表为空，会误注入。要么把“detached 与 DSH 解耦”改成有界声明只在单进程有效，要么持久化注册表/启动时恢复并校验 PID，不能两者同时宣称。

### d. 结构化收尾解析容错

结论：**把严格工具调用作为规范通道，文本 JSON 只做兼容兜底；任何无法唯一解析的内容不得自动改任务状态。**

建议新增 `task_round_close` 工具，至少使用如下契约：

```json
{
  "task_id": "tsk-...",
  "action": "update | done | blocked",
  "progress": "本轮完成的一行进展",
  "next": "下一步或等待事项",
  "blocked_reason": "action=blocked 时必填",
  "round_id": "本轮唯一 id"
}
```

`blocked_reason` 是必须补入设计稿的字段；当前五字段结构没有它，但 Worker 设计要求 blocked 缺原因返回 422。还需定义 `progress/next` 的长度、是否允许空串、是否允许换行和敏感信息处理。

规范行为：

- 工具参数通过 schema 校验；`task_id` 必须在本轮云端清单中，且不能凭“当前任务”猜 id。
- 每个 autonomous round 只接受一个 close。以 `round_id + agent_id` 做幂等键；同一提交重试返回第一次结果，不重复写入；不同内容的第二次提交返回冲突。
- `action=update` 必须明确是只写 progress/next 还是把任务置为 `in_progress`；`done/blocked` 只申请 pending，不能直接落终态。
- 文本兼容解析只接受完整、唯一的 JSON 对象或 fenced JSON；多个对象、前后混杂无法确定主对象、字段缺失、类型不对、未知 action 都视为协议错误。不要从任意自然语言中用正则猜“完成了”。
- 解析失败或不完整时：不写 status、不写 `done_at`、保留任务 `in_progress`；广播 `close-protocol-error`，最多注入一次修复提示。连续失败后停止本轮或进入重试退避，但不能为了熄火自动标 done/blocked。
- stop marker 与 close 的优先级要定稿。若 assistant 只输出 `【停止自主推进】` 而没有 close，不能假设上一任务已收尾；至少记录“未收尾停止”，保留 in_progress，并由 UI/日志显示待处理。

当前 `tasks.body` 是一个整体可替换文本字段，而 `PATCH` 的 `body` 会覆盖旧值（`worker/worker.js:1126-1129`）。因此必须定义 progress/next 的落账方式：

- 若只把它拼成新 body，会丢失原有 notes 和上一轮进展；
- 若客户端先 GET 再拼接再 PATCH，会有并发覆盖；
- 推荐增加专用 `round_close` 写入路径，在 Worker 内原子追加结构化事件/日志，并更新任务摘要；或增加 `task_events` 表，把 `progress/next` 作为事件事实，body 只保留当前摘要。无论选哪种，必须带 revision/幂等键。

### e. onTimer 云端任务清单查询失败

结论：**采用“保守停止本轮 + 有界重试”，绝不保守注入，也不能把失败当成空清单，更不能回退 `TASKS.md` 作为自主推进资格判断。**

应区分三种结果：

```text
cloud_ok + runnable_tasks > 0  -> 注入带清单的 prompt
cloud_ok + runnable_tasks = 0  -> autostop: no-runnable-tasks
cloud_error / auth_error / bad_response -> defer: task-api-unavailable
```

失败时建议：

- 不发 autonomous prompt，不执行任何自动状态迁移，不调用 `stopByProtocol`，不把持久化模式设为 chat；保留 `enabled=true`，进入 `task-api-unavailable` degraded 状态。
- 复用 CONNECT 客户端已有的 GET 传输重试，但要设置总 deadline。当前 `taskApiTimeoutMs=3000` 传给每次请求，而 `plugins/memory/lib/http.js` 对 GET 还有 300ms/800ms 重试；如果每个 attempt 都独立占 3000ms，总耗时会超过表面上的 3000ms。需要明确 3000ms 是总预算还是单 attempt。
- 采用指数退避和抖动重新 arm，例如 30s、2min、5min 封顶；重试期间 UI/广播给出错误态和最后失败原因。恢复后必须重新拉完整清单，不能沿用旧快照决定是否熄火。
- HTTP 401/403/404/503、认证配置不完整、CONNECT/TLS 失败、超时、JSON 契约错误一律归入 unavailable；只有成功且结构合法的云端响应才允许产生 no-pending 结论。

这里有一个必须立即修正的生产冲突：08-30 已知 Node 直连 `workers.dev` 被墙，生产读取必须走 CONNECT 隧道并带 Access 双 key 或 Bearer。当前 auto-advance 默认 `proxy=direct`（`plugins/auto-advance/lib/index.js:7-12`、`service.js:147-151`），而安装脚本只给 memory 写入 7897 代理，没有给 auto-advance 写入 proxy（`scripts/install-profile-deps.ps1:353-386`）。即使 memory task 工具可用，auto-advance 前置查询也会直连失败。应统一 transport 配置，至少让 auto-advance 使用与 memory 相同的 `DSH_MEMORY_PROXY`/profile proxy；生产非 loopback API 未配置 proxy 时应明确报配置错误并 fail closed。

另外，`getTasks()` 当前 API 失败会默认读 `TASKS.md`（`service.js:321-323`），这与设计稿“云端唯一事实源、错误态而非空态”冲突。若为面板保留离线文件展示，也必须将其结果标记为 `source=file-stale`，严禁进入 onTimer eligibility、任务选择和熄火判断。建议拆成 `readCloudTaskSnapshotStrict()` 与仅供 UI 的 `getTasks()`，不要通过一个可 fallback 的方法承担两个安全等级。

实现上 `onTimer` 必须改为异步流程。当前方法同步执行并在 try 中直接调用 `agentFollowup`；加入 API 查询后需要在 `await` 前后重新检查 generation、agent 状态、用户消息/inbox、enabled 和 stopped 状态，必要时用 AbortController 取消过时请求，防止用户在查询期间输入后仍被注入。

## 额外发现

### 1. 已部署 D1 不能靠 `CREATE TABLE IF NOT EXISTS` 添加字段

任务 API 已于 08-30 上线，现有 `tasks` 表已经存在。修改 `schema.sql` 或 inline `CREATE TABLE` 不会给既有表增加 `blocked_reason/pending_status`。必须提供一次性、可重入的 D1 migration：先检查 `PRAGMA table_info(tasks)`，再按缺失列执行 `ALTER TABLE ... ADD COLUMN`，或通过受控 migration 脚本执行；不能把带重复 `ALTER` 的语句无条件塞进启动 batch。`ensureTasksSchema` 还需要报告 migration 失败，不能只创建了部分结构却继续提供旧路由。

### 2. API、工具契约和返回投影必须同步扩展

Worker 的 `serializeTask` 会带出数据库行，但 memory 的 `TASK_FIELDS` 和 `pickTask` 是显式字段投影，目前会丢弃新增字段。因此必须同步更新：Worker schema、inline DDL、`TASK_FIELDS`、`pickTask`、task 工具 descriptions/output、auto-advance 的 task mapping、面板状态元数据和所有测试。

### 3. “open 任务”与 `waiting/blocked/pending` 的集合定义不清

当前 `/task?size=200` 实际没有实现 page/size 截断，Worker 直接返回所有未归档任务（`worker/worker.js:1012-1044`）；auto-advance 也没有传 `status`，并把所有返回任务按 project 展示（`service.js:601-659`）。实施前必须定义：

- runnable 是否为 `open | in_progress`；
- `pending_done/pending_blocked` 是否单独进入 confirmation 队列，不能进入普通 runnable 队列；
- waiting 是否造成 `no-runnable-tasks` 还是 `waiting`；
- blocked 是否为终态；
- 任务超过单页上限时是否分页拉完，或因快照不完整而 fail closed。

推荐 server 返回稳定排序、`total/page/size/has_more`，auto-advance 拉取完整快照；若超过安全上限，不要只看截断后的空/非空结果。

### 4. “物理拼入 prompt”不是硬权限边界

把任务清单拼入 prompt 能显著降低偏移，但不能阻止模型调用文件工具、shell 或其他插件处理清单外工作，也不能阻止 `task_create` 后立即推进新任务。稿件同时要求“新想法先 task_create 再推进”和“清单外的事不存在”，两者需要定义时序：新建任务后是本轮允许推进，还是必须等待下一轮重新拉清单。若确实要做到硬门禁，需要工具层/工作区层授权检查；仅靠 prompt 应表述为协议约束，不应称为机制层物理强制。

### 5. 有界工作接口缺少完成路径和与任务的关联传递

现有 `codex_dispatch` 只有 `task` 描述，没有 `task_id`；当前 `CodexWorkRegistry.register` 也没有任务字段（`plugins/codex-dispatch/lib/index.js:58-75`）。若不改，auto-advance 无法知道某个 codex work 是否对应清单中的 in_progress 任务，也无法实现“其他任务继续推进”。codex 工具必须补 `task_id`，并在返回的 work 记录中保留。

### 6. 收尾写回需要并发控制和审计事实

两个 agent、codex 回调和 auto-advance 可能同时更新同一任务。当前 PATCH 没有 `expected_updated_at`/revision，`body` 又是覆盖写。pending 请求、确认、拒绝、round close 也没有历史表；只看当前 `updated_at` 无法回答谁在何时请求/确认过终态。至少需要条件更新和幂等键；若审计要求成立，增加 task event 表比继续堆管理字段更稳妥。

### 7. 当前 profile 配置仍明确保留 `taskFallback: true`

安装脚本在 auto-advance 配置中写入 `taskFallback: true`（`scripts/install-profile-deps.ps1:380-386`），而设计稿已经决定 C1-C2 退场、云端是唯一事实源。必须移除该配置，或明确它只能服务于只读面板、永远不能服务于自主推进资格判断。否则实施后会出现“面板看到云端错误、推进却从旧 TASKS.md 继续”的隐性双源。

### 8. Access-only 配置在 auto-advance 与 memory task 工具中的行为不一致

auto-advance 的 `readTasksFromApi` 会读取 `accessClientId/accessClientSecret` 并发送 Access headers（`service.js:678-685`）。但 `SagittaMemoryClient` 的 `managerConfig` 只归一化 `workerApiUrl/d1ReadToken/d1WriteToken`，没有把 manager 的 Access 双 key 带入 runtime（`plugins/memory/lib/client.js:158-218`）。因此 manager 只配置 Access、未配置 D1 read/write token 时，auto-advance 可能能读，而 `task_list/task_update` 会报“未配置”。需统一认证解析，或明确 Access 只供特定路径且修改 manager UI 文案，不能让同一套配置产生两种结果。

### 9. 现有测试基线本身未全绿

已执行语法检查：`worker.js`、auto-advance、codex-dispatch、memory tools/client 均通过 `node --check`。现有冒烟运行结果为：memory manager smoke 通过；manager smoke 因本环境缺少 `@deepseek-ai/cordis` 无法加载；worker task smoke 在 `ensureTasksSchema` 调用 `db.batch` 处失败，因为测试 D1 adapter 仍只实现 `prepare/bind/first/all/run`、没有 `batch`。这说明实施前必须先更新测试适配器，并补充 pending、confirm、网络失败、分页/截断、Access/CONNECT 和重复 close 场景，不能把当前 smoke 当作完整绿灯。

## 修改建议（实施前必须锁定）

建议把设计稿补成以下六个可验收契约：

1. **状态契约**：明确 pending 组合、允许的来源状态、create 行为、reopen 行为、blocked_reason 清理规则和唯一的 done_at 写入点。
2. **API 契约**：增加 confirm/round-close endpoint；定义 409、422、401/403、重复请求的响应；增加 revision/idempotency；完成线上 D1 migration。
3. **工具契约**：保留 `task_update` 业务 PATCH；新增 `task_confirm` 和 `task_round_close`；补 `blocked_reason/pending_status` 输出；异步工作补 complete/fail/cancel 和 `task_id`。
4. **auto-advance 契约**：拆分云端严格读取和 UI fallback；定义 runnable/confirmation/waiting 集合；异步 onTimer 的 generation、取消、退避和状态广播；统一 proxy/认证来源。
5. **注册表契约**：确定 `@sagitta/async-work` 为单一 owner，codex 通过适配器写入；定义重启恢复策略和按 task_id 的阻塞判断。
6. **数据与审计契约**：定义 progress/next 的持久化格式、追加/覆盖语义、round_id 幂等和 task event 是否入库。

## 实施注意点与验收顺序

建议按以下顺序落地，避免先改 prompt 再被 API 语义反噬：

1. 先做线上 D1 migration 和 Worker API 单测：旧任务读写不变；done/blocked 只能 pending；confirm 成功才写 done_at；重复 confirm、过期 revision、缺 blocked_reason 均有明确断言。
2. 更新 memory client/tool contract 和统一认证解析，分别验证 D1 read/write Bearer、Access 双 key、CONNECT 隧道。生产环境 auto-advance 不得使用 `direct` 访问 workers.dev。
3. 实现严格云端快照和异步 onTimer：成功空集才能 no-runnable；查询失败只 defer/retry；在 await 期间模拟用户输入、agent running、dispose，确认不会晚到注入。
4. 引入通用 async-work 服务，先让 codex 适配，再验证 task_id 关联、不同任务并行、超时回收、服务不可用保守行为、DSH 重启后的策略。
5. 最后接入 `task_round_close`/`task_confirm` 和 prompt 文案；对非规范文本、多个 JSON、缺字段、重复提交、stop marker、body 并发更新做单测和集成测试。
6. 更新测试 adapter 支持 D1 `batch` 或改为与 Worker 实际调用一致的 mock；完成 local smoke 后再部署 Worker，最后重启目标 DSH 并核对 profile/preset 副本同步。

## 总体结论

**需大改。** 当前设计的总体方向可保留，但在补齐上述 P0 契约、迁移已部署 D1、关闭 file fallback/直连代理冲突、以及完成 API/工具/auto-advance 的一致性改造前，不建议开始生产实施。
