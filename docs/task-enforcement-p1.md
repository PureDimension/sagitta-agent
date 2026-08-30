# 任务系统强制力闭环 v1（task-enforcement-p1）

> 状态：设计定稿（涟漪 08-30 拍板）→ 待 codex 审查 → 实施
> 关联：task-api-p1.md（云端 task API）、auto-advance（自主推进插件）、sagitta-codex（codex 派单插件）
> 任务：tsk-20260830-0d1bed（P1 级）

## 1. 背景与问题

现状：任务系统（云端 D1 task API + 悬浮窗）是"显示器"——只负责显示任务，工作流（开场、推进、写回）全靠自觉。后果：

- 自主推进**无法自然结束**：结束靠模型主观判断输出【停止自主推进】，容易空转或过度推进；
- 工作与任务系统**偏移**：推进了但不写回，任务系统逐渐失真；
- 双实现（文件正则解析 vs API 映射）语义分裂，硬编码解析措辞脆弱。

涟漪拍板（08-30）：
1. **云端 task API（D1）为唯一事实源**，只看云端；拍板⑤的 C1-C2 退场时序不做，直接切云端；
2. 双实现收紧：严禁硬编码解析措辞（如 `需涟漪确认/行动` 标题正则），任务语义全部用独立字段；
3. 增加任务系统的**强制力**：让任务系统成为工作闭环的必经之路，防止日后工作偏移。

## 2. 核心概念原则

- **对话无状态**：正常对话（涟漪在场）时我没有处理任务，对话不需要任务状态；**状态机只在自主推进模式（涟漪离开）下启用**。对话中 task 工具只做记录，不触发质询/注入。
- **任务 = 做了什么**：任务条目必须对应"可交付的推进单位"（做了什么），验收/跟踪类不算任务（如"待重启生效项跟踪"只是验收的一环，不是任务）。宏观目标是 project 字段。
- **强制的是生命周期闭环，不是过程记账**：开始填一次表（置 in_progress）、结束填一次表（置 done/blocked，走确认），过程中不填表。
- **task_create 权限**：暂不设权限，agent 自由调用。设计考虑（未来可选）：小修改（追加几行）不建 task；涟漪允许在领域内自由探索时可建新 task。

## 3. 状态机（云端 schema 扩展）

现有 status 枚举：`open | in_progress | blocked | waiting | done`。

### 3.1 新增字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `blocked_reason` | TEXT 可空 | 置 blocked 时必填；阻塞原因，必须指向"超出 agent 能力范围的外部依赖"（等涟漪/等外部系统/等网络等） |
| `pending_status` | TEXT 可空 | 中间态载体：`pending_done` / `pending_blocked`。任务迁移到终态的"待确认"状态，确认后才真正迁移 |

### 3.2 迁移规则（双重确认）

- `task_update(status=done)` → 实际写入 `pending_status=pending_done`，status 不变（或标记待确认）；auto-advance 检测到中间态 → 注入质询（复用 AUTONOMOUS_PROMPT 决策话术："真完成了吗？是否所有验收点都过了？"）→ agent 确认 → 插件自动迁移 `done`；agent 改口 → 回退 in_progress。
- `task_update(status=blocked)` → 必须带 `blocked_reason`（缺失 422）→ `pending_status=pending_blocked` → 同上质询确认。
- 质询只发生在自主推进模式（见 §2 对话无状态）。

> 设计意图：防止"偷懒结账"——把任务标 blocked/done 来触发熄火。终态必须经质询，由插件落账，不靠模型自觉。

## 4. 入向强制（任务来源唯一化）

三层机制：

1. **onTimer 前置查询（机制层，最硬）**：auto-advance 注入自主推进 prompt 之前，先调云端 API 拉 open 任务清单；有 → 把清单渲染成结构化列表**物理拼进注入的 prompt**（模型只能从清单里选任务继续，清单外的事=不存在）；没有 → 不注入，自动停止（客观熄火，见 §6）。
2. **协议层**：AUTONOMOUS_PROMPT 重写——"新想法先 task_create 再推进"、"不在清单中的工作禁止开展"。
3. **会话层**：开场三件事第①件从"读 TASKS.md"改为云端 task 对账（task_list 全量拉取）。

## 5. 出向强制（写回唯一化）

- 每轮推进结束（无论继续或停止）结构化收尾：`{task_id, action: done|update|blocked, progress, next}`；插件解析后自动 task_update 落账。**写回从"模型自觉"变成"插件动作"**，模型只填字段。
- 收尾粒度：每轮一次，一行 progress + 状态迁移，不要求周报式详述。

## 6. 触发条件与客观熄火

现状：`readyToDrive = live && enabled && !stopped && idle && !pendingWork`，idle 300s 后注入。

新触发条件：
- **推进中触发**：agent idle 且存在 `in_progress` 任务 且无绑定有界工作（codex 注册表 + 异步插件注册表）→ 立即注入"要么继续处理 in_progress 任务，要么发起 codex，要么置 waiting/blocked"。
- **waiting/blocked 任务不要求绑定**（等涟漪回复的任务不该被反复打扰）。
- **客观熄火**：onTimer 前置查询云端，无 open 任务（全部 done/blocked）→ 不发 prompt，自动停止并广播 `autostop: no-pending-tasks`。熄火由任务系统状态（油量表）决定，不消耗模型判断。
- 保留【停止自主推进】协议标记作为显式兜底。

## 7. 异步插件（有界工作泛化）

本质：把"有界工作"从 codex 专用泛化为"任何有界的异步工作"。

### 7.1 场景

安装过程、等待模型运行、等待外部系统响应等——不是 codex、不需要我动手、只需要等待的异步操作。若不注册，自主推进会误判空闲并注入打扰；注册后自主推进识别为"有工作进行中"。

### 7.2 接口

```js
async_register(task_id, { desc, timeoutMs })  // 注册异步有界工作，必须绑定 task
async_status(task_id?)                        // 查询/回收状态
// 复用 sagitta-codex 的注册表机制：listActiveWorks(agent_id) + 超时自动回收
```

- **注册 = 声明"我在等，别打扰我"**：只有"agent idle 且确实在等某个东西"才注册；一边等一边干别的活不注册（不 idle 不会误触发）。
- **同步操作不注册**（agent 自己完成）；**后台任务不注册**（直接挂后台，08-30 已修复：笼统 jobs 不算有界工作）。
- **超时回收**：与 codex 一致，超时未完成自动回收 → 重新进入注入逻辑，防止"注册了然后忘了"永久卡住。
- auto-advance 的 hasRunningWork 从"codex 注册表"扩展为"codex 注册表 + async 注册表"（或统一为 sagitta 有界工作注册表服务，由 codex/async 共同写入）。

## 8. 实施顺序

1. **worker schema 补字段**：tasks 表加 `blocked_reason`、`pending_status`；/task 路由支持 pending 语义（写 done/blocked 时先落中间态、blocked 缺 reason 422、确认接口/机制）。
2. **auto-advance 改造**：onTimer 前置查云端+清单注入；中间态质询+自动迁移；新触发条件；结构化收尾解析落账。
3. **异步插件**：@sagitta/async-work（或并入 codex-dispatch 泛化注册表）+ async_register/status 工具 + auto-advance 识别。
4. **整理现有云端任务**：分层清理（验收/跟踪类删除或并入验收环，任务=做了什么）。

## 9. 边界与风险

- 云端唯一源 → 悬浮窗/开场/自主推进全依赖 隧道+Access 认证 链路；云端不可达要有明确降级（错误态而非空态，可重试，不静默）。
- 质询机制不能变成填表负担；强制对象是生命周期闭环不是过程。
- 状态机迁移规则要先有 smoke 测试（单测 worker 路由 + auto-advance 判定）。
- 改动一律走 sagitta-agent 仓库（git commit + push），副本同步、重启生效。

## 10. 待 codex 审查项

- 中间态（pending_status 单字段 vs 独立状态枚举）取舍；与现有 task_update PATCH 语义兼容性；
- 质询确认的协议交互细节（agent 怎么"确认"？工具调用参数？避免与现有 task_update 冲突）；
- 有界工作注册表泛化的模块边界（改 codex-dispatch 还是新建插件）；
- 结构化收尾的解析容错（agent 输出不规范时的兜底）；
- onTimer 前置查询失败（网络）时的行为（保守注入 vs 保守停止）。
