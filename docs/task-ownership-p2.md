# 任务认领制（task-ownership-p2）

> 状态：设计稿 v1（涟漪 2026-08-31 拍板实施）
> 关联：task-api-p1.md（云端 task API）、task-enforcement-p1.md（强制力闭环 v1，已完成）
> 目标：解决多对话并发认领同一任务的冲突（对话 A 处理 task1 时，对话 B 不应同时处理）

## 1. 问题

现状：tasks 表无归属概念，A/B 两对话可同时把同一任务置 in_progress 并各自推进。
`expected_updated_at` 只防写覆盖（后写者 409），防不了"重复干活"（两边都白做、都 round-close）。

涟漪拍板（2026-08-31）：
1. **owner 对模型无感知**——DSH 本地阅读任务时看不到 owner 字段，只能看到任务状态（含"已被别人认领"的标记）和原子认领动作
2. **进程退出自动回收**——对话结束或 DSH 进程退出时，in_progress 任务可能残留"进行中"标记；新对话不应永远看到被占用的任务。回收机制可放在 Worker 侧
3. 与 codex 讨论后实施

## 2. 设计原则

- **原子认领**：认领是单条条件 UPDATE（WHERE status='open' 或 owner 过期/为空），不可先读后写
- **owner 不可见**：API 不返回 owner_agent_id 明文；只派生"是否被认领/是否可认领"的可读字段
- **认领有租约（lease）**：认领带过期时间（claimed_at + lease 时长）；超时自动释放（Worker 侧惰性回收）
- **进程退出 = 租约过期**：DSH 进程退出后，其认领的任务租约到期自动变回可认领，不依赖清理钩子
- **模型视角简单**：runnable 清单只显示"未认领"或"自己认领的"（通过 claim token）；"别人认领的"显示为占用

## 3. 数据模型（tasks 表新增）

```sql
owner_agent_id  TEXT NULL,   -- 认领者 agent id（不对外暴露明文；仅服务端使用）
claimed_at      TEXT NULL,   -- 认领时间（ISO8601 UTC）
claim_token     TEXT NULL,   -- 认领凭证（不透明 token，持有者=认领者；对模型可见但不可猜）
```

租约时长：`lease_seconds` 默认 24h（可配置；进程退出后 24h 内任务不回收，超时自动释放）。

## 4. API 契约

### 4.1 认领（claim）

```
PATCH /task/{id}  body: { "status": "in_progress", "claim": true }
```
或独立：
```
POST /task/{id}/claim
```

条件（原子）：
- `status='open' AND owner_agent_id IS NULL` → 认领成功：status→in_progress、owner_agent_id=调用方、claimed_at=now、claim_token=新生成
- `status='in_progress' AND owner_agent_id 过期` → 接管成功（同上述写入）
- 其他 → 409 `TASK_ALREADY_CLAIMED`

响应：完整任务投影（**含 claim_token，不含 owner_agent_id 明文**）。

### 4.2 释放（release）

```
POST /task/{id}/release   body: { "claim_token": "..." }
```
- 仅持有正确 claim_token 的调用方可释放（置 owner_agent_id=null、claimed_at=null、claim_token=null、status→open）
- 终态（done/blocked/waiting）自动释放（服务端在确认路径清除 owner）

### 4.3 读取（对模型可见字段）

serializeTask 派生：
- `claim_state`: `"unclaimed" | "claimed" | "mine"`
  - mine：claim_token 匹配调用方当前持有（需要请求带 claim_token 或按 session 上下文判断）
  - 简化：读取时不校验 token，返回 `claim_state: "unclaimed"|"claimed"`；"mine" 由 auto-advance 本地通过已持有 token 判断
- `owner_agent_id`：**永不下发**
- `claim_token`：**只在 claim 响应中返回一次**；列表/详情读取不下发（防泄露）

### 4.4 自动回收（Worker 惰性）

- 读取/PATCH/claim 时：`owner_agent_id IS NOT NULL AND claimed_at < now - lease_seconds` → 视为未认领（查询时视为 open，写入时条件允许接管）
- 可选：定时清理任务（低频，如每小时）把过期认领复位
- **进程退出即回收**：DSH 崩溃/退出后无人续租，租约自然过期；新对话看到任务回到"未认领"可接管

## 5. auto-advance 集成

- `splitCloudTaskSnapshotStrict`：runnable 过滤 `claim_state != "claimed"`（未认领的 open/in_progress 才进清单；"别人认领的 in_progress" 不进 runnable，可进"占用"展示区）
- 自己认领的任务：auto-advance 本地保存 claim_token（内存 + statePath 持久化），对应任务继续推进
- 认领动作：auto-advance 选择任务时调用 claim（或 task_update(status=in_progress) 自动 claim）
- 进程退出：不主动释放（租约自动过期）——符合涟漪"最好写在 worker 里"的指示

## 6. memory 工具集成

- `task_list`：输出加 `claim_state` 字段（unclaimed/claimed/mine）
- `task_claim` / `task_release`：新工具（claim 传 task_id；release 传 task_id + claim_token）
- `task_update(status=in_progress)`：可选参数 `claim: true`（默认 true——置 in_progress 即认领，符合直觉）
- owner_agent_id 不进 TASK_FIELDS 投影

## 7. 边界与风险

- **token 管理**：claim_token 在 claim 响应返回一次，auto-advance 持久化；丢失 = 失去对该任务的继续操作权（可重新认领，若已过期；未过期则需涟漪手动接管）
- **涟漪接管**：checkbox 任务（涟漪待办）不认领？——涟漪本人操作任务不受认领限制（可选：checkerboard=1 或特定来源跳过）
- **subagent 继承**：对话 A 派 codex 处理 task1，codex 的 round-close 用谁的 claim_token？——沿用 A 的（codex 绑定 task_id 时继承 owner）
- **waiting/blocked 不占用**：waiting/blocked 状态释放 owner（不需要认领）
- **旧数据**：存量 in_progress 任务 owner 为 null → 视为未认领，任意对话可认领接管
- **claim 与 pending 互斥**：pending_done/pending_blocked 任务不可认领（已有人提交终态）

## 8. 实施顺序

1. **Worker**：schema 加 3 列（可空）+ migration（PRAGMA+ALTER）+ claim/release 路由 + serializeTask 派生字段 + 惰性回收 + 终态自动释放 + smoke
2. **memory 工具**：task_claim/task_release + task_list claim_state + task_update claim 参数 + 投影
3. **auto-advance**：runnable 过滤 claimed + claim_token 持久化 + 认领动作 + 占用展示
4. **验收**：A/B 并发认领、接管、过期回收、token 丢失、终态释放、旧数据兼容

## 9. 验收清单

- [ ] A 认领 task1 → B 认领同任务 409；B 的清单看不到 task1（或显示占用）
- [ ] A 释放 / 任务终态 → task1 回到未认领，B 可认领
- [ ] 认领过期（模拟短 lease）→ task1 自动变回可认领
- [ ] owner_agent_id 不出现在任何 API 响应
- [ ] claim_token 只在 claim 响应出现一次
- [ ] 存量 in_progress 任务可被任意对话认领接管
- [ ] DSH 退出后（模拟）→ 新对话可认领旧任务
