# 记忆侧代码块审阅 + 修改初稿（2026-09-27）

**依据**：`docs/memory-task-cleanup-decisions-2026-09-27.md`（涟漪已逐条拍板）
**涟漪 2026-09-27 补充**：① `consolidate` 拆成三个**单条**工具（validate / replace / archive）；② P0 是"没有自动召回"，工具利用率低是必然结果；③ 记忆固有的问题（一多就杂乱、错误经验反复）**不能靠加字段解决**，先让设计简洁清晰。

---

## 0. 一句话结论

记忆侧的问题不是"缺功能"，而是**字段与接口比消费者多**：

| 现象 | 证据 |
|---|---|
| 9 个字段只写不读 | `stream` / `evidence` / `tier` / `ttl` / `last_access` / `source` / `source_task_id` / `cross_session_count`（+ 设计有代码无的 `counterexample` / `access`） |
| 1 个接口零调用 | `POST /mem/delegations`：`tools.js` 里只有 `getDelegation`，无 `createDelegation`；实测 `memory_verify(task_id=…)` 回「delegation 记录不存在」 |
| 1 个工具零调用 | `memory_consolidate`：今天 0 次；且把三件事（验证/替换/归档）塞进批处理外壳 |
| 1 个工具 275 行里三分之一服务于那个零调用接口 | `memory_verify` 的三个模式之一（delegation 复核）|

删除后预估：worker 记忆侧 ~640 行 → ~480 行；`tools.js` 记忆部分 ~673 行 → ~430 行。

---

## 1. worker 记忆侧（310-950）逐块

### 1.1 `healthHandler(env)` — 313-323
- **逻辑**：返回 `{ok, version, ts, env:{db, auth_token}}`，两个布尔只表明"配没配"，不泄值。
- **使用**：部署验收打它；模型从不调用。
- **建议**：保留（零成本、部署必需）。

### 1.2 `createEntryHandler(db, stream, body)` — 333-438
- **逻辑**：校验 stream/type/content → 算 `origin` 与初始 score/status → 写 26 列的 INSERT → 带 `supersedes` 时同批把旧条目标 `superseded` → `db.batch` 原子提交。
- **使用**：`memory_remember` 唯一落地路径；今天调用 3 次。
- **建议**：
  - 删列：`stream`（改由 domain 表达分类）、`evidence`、`tier`、`ttl`、`source`、`source_task_id`、`cross_session_count`；
  - 必填只剩 `type` + `content`（`origin` 缺省 sagitta）；
  - `origin` 取值 `ripple` → **`user`**；
  - `stream` 不再是路径参数 → 路由从 `POST /mem/{stream}` 改为 **`POST /mem`**（写入时 domain 可选）。

### 1.3 `listEntriesHandler(db, stream, url)` — 443-477
- **逻辑**：按 stream 必填过滤 + 可选 type/domain(前缀)/status；默认排除 `archived`/`superseded`；COUNT + 分页查询。
- **使用**：`memory_recall` 的 list 模式（今天用过）。
- **建议**：stream 过滤改为可选（`GET /mem?domain=…&type=…&status=…`）；其余保留。

### 1.4 `getEntryHandler(db, stream, id)` — 480-495
- **逻辑**：按 `id + stream` 读一条；命中后写 `last_access`，**写失败被 catch 吞掉**（486-491）。
- **使用**：`memory_recall` 的 id 模式。
- **建议**：删 `last_access` 更新块（字段没人读、吞异常）→ 变成纯读取。

### 1.5 `searchHandler(db, body)` — 501-546
- **逻辑**：`query` 必填；在 **5 列**（content/condition/tags/domain/id）做 `LIKE '%…%'`；tags 用"带引号的完整标签"精确匹配；默认排除终态。
- **使用**：`memory_recall` 的 query 模式。
- **建议**：删 stream 过滤条件；**保留**其余（性能边界记入文档：前缀通配用不上索引，千级无感、万级未知）。

### 1.6 `consolidateHandler(db, body)` — 568-813（约 247 行）
- **逻辑**：入参两形态（`items` 精确 / `ids` 简写）→ 逐条查状态 → 按 action 校验前置条件 → 攒 SQL → **任一失败整体 422 不写入**，否则 `db.batch`。
- **使用**：**0 次调用**。
- **建议**：**拆成三个单条接口**（对象=单条记忆），并删掉 `digest`/`corroborate`：
  - `POST /mem/{id}/validate`：body `{blind_spot(必填), explanation?, linked_delegation_id?}` → 写 validated 事件 + `status=validated`、`score=3`
  - `POST /mem/{id}/replace`：body `{origin(必填), content(必填), condition?, tags?}` → 整条改写 + replaced 事件
  - `POST /mem/{id}/archive`：body `{explanation?}` → `status=archived` + archived 事件（pinned 拒绝）
  - 同时删掉批处理外壳（items/ids/supersedes/superseding_id 参数）——取代链保留在 `createEntry` 的 `supersedes` 上。
  - ⚠ 注意：id 是 UUID，路径里带上 id 意味着接口从"集合式"变成"资源式"，路由表要相应调整。

### 1.7 `ackHandler(db, body)` — 828-908
- **逻辑**：三态信号 + `unobjected` 必须带 `statement_source`（422）→ 分数加减钳制 → 跌破 0 软归档（pinned 只压到 0）→ 状态只升不降。
- **使用**：`memory_verify` 的 ack 模式（今天 0 次，但这是"你认可/反对"的唯一入口 → 设计必需）。
- **建议**：保留；文案里的"涟漪"改"你/用户"；取值 `ripple`→`user`。

### 1.8 `createDelegationHandler(913-941)` + `getDelegationHandler(944-948)`
- **逻辑**：写/读委派记录（谁派的单、自报结果、验证方式与结论、产物、成本）。
- **使用**：**写=0 次**（客户端有方法、无调用者）；读=只有 `memory_verify` 的 delegation 模式（0 次）。
- **建议**：**删接口 + 删表 + 删客户端两个方法 + 删 verify 的 delegation 分支**。将来真要做"派单-验证账本"时，按当时需求重新设计（而不是留着空表）。

---

## 2. memory 插件逐块

### 2.1 `lib/index.js`（38 行）
- **逻辑**：注入 manager → 建 client → 注册 `systemPrompt` 段（`MEMORY_PROMPT_GUIDANCE`，120 序）→ `registerMemoryTools`。
- **使用**：会话内常驻（我每天都看到那段文案）。
- **建议**：那段 15 行提示词的内容（记忆/任务工具纪律）**正在由另一个 codex 单搬进各工具的 description**（已派），搬完后删掉该段与 `systemPrompt` 注入。

### 2.2 `lib/config.js`（17 行）
- **逻辑**：三个枚举清单：`STREAMS`（四流）、`TYPES`（8 类型）、`ORIGINS`（ripple/sagitta）。
- **建议**：删 `STREAMS`；`ORIGINS` 改 `["user","sagitta"]`。

### 2.3 `lib/tools.js` 43-99（输出 schema 辅助）
- **逻辑**：`VALIDATION_EVENT_FIELDS` / `ENTRY_FIELDS`（条目的对外投影字段）/ `ENTRY_SCHEMA`。
- **建议**：随删除同步——去掉 `stream`、`evidence`、`cross_session_count`、`source_task_id`；`origin` 注释改 user。

### 2.4 `pickEntry(101-132)` / `pickStatusBadge(134-143)` / `excerpt+renderEntry(145-170)`
- **逻辑**：把服务端返回投影成固定字段（101-132）、状态转徽章、渲染一条（含 trust 计数与 validated 事件）。
- **建议**：投影同步删字段；**注意 114 行的兜底 `src.origin === "ripple" ? 2 : 0` 要改成 `"user"`**（否则改名后信任分会算错）。渲染行里的 `evidence=…`、`x${cross_session_count}` 一并去掉。

### 2.5 `registerMemoryTools` 头部 197-231
- **逻辑**：**在这里创建并安装"任务门禁"**（`createTaskGate` + `installTaskGate`），并在进程启动/会话创建时从云端刷新认领（`listTasks({owner:'me'})`）。
- **说明**：这是"任务侧逻辑长在记忆插件里"的证据；门禁本身依赖任务接口。
- **建议**：本轮不动（属任务侧设计），但**在任务侧审阅时优先决定它该不该留在 memory 插件**（它是"记忆插件"里最大的本地逻辑，253 行 `task-gate.js`）。

### 2.6 `memory_remember`（232-361）
- **逻辑**：组装 body（只带用户给的字段）→ `POST /mem/{stream}` → 投影 + 渲染。
- **建议**：删参数 `stream`、`evidence`、`cross_session_count`（及其余 4 个 ack 计数？—— 建议全删：历史迁移已完成，见下）；`origin` 枚举改 user；domain 说明改"领域/主题"。
  ⚠ 待确认：4 个 ack 计数参数只用于"历史迁移"，迁移早已完成 → 建议**全部删掉**，worker 侧也只保留计数字段不自建。

### 2.7 `memory_recall`（363-457）
- **逻辑**：三模式——`id`（需 stream）、`query`（search）、否则 `stream`（list）。
- **建议**：删 `stream` 必填约束（三模式都不再要求），改成可选过滤；新增可选 `origin` 过滤（替代旧 stream 的"谁的"作用——**待你确认要不要加**）。

### 2.8 `memory_consolidate`（459-627）
- **逻辑**：批处理外壳 + **6 处本地预校验**（validate 缺 blind_spot / replace 缺 origin / 缺 content，精确与简写两套）。
- **建议**：**拆成三个单条工具**（`memory_validate` / `memory_replace` / `memory_archive`），本地预校验删掉（交给 worker，错误原样透出——薄层原则）。

### 2.9 `memory_verify`（629-787，275 行）
- **逻辑**：三模式——`task_id` → 读 delegation；`entry_id + signal` → ack；`entry_id + stream` → 读条目现状。
- **建议**：删 delegation 模式（连带参数 `task_id`、输出字段 11 个、渲染分支 20 行）→ 只剩 ack + entry 复查；`stream` 改为可选（条目 id 已唯一）。

### 2.10 `lib/client.js`
- **24-105 错误翻译层**：把 manager 的 HTTP 错误翻成中文指引（Access 拦截识别、401/403/404/409/503、500 截断）。
  **建议**：保留结构；**改过时文案**——现在写的是"确认 Sagitta Manager 中对应 D1 token…"（D1 token 已随重构删除，现在是 Access 服务令牌/凭据引用）；409 文案提"条目处于终态"是对的。
- **115-158 `request()`**：组装 header（`X-Agent-Id`）+ 交给 `manager.request` + 解包 `{ok,data}`。
  **建议**：保留（这就是"薄层"该有的样子）。
- **166-218 记忆方法**：`createEntry/listEntries/getEntry/search/consolidate/ack/createDelegation/getDelegation`。
  **建议**：删 `createDelegation`/`getDelegation`；`consolidate` 拆成三个；路径随路由改动调整。

---

## 3. 施工清单（按文件，可直接照做）

| 文件 | 动作 |
|---|---|
| `worker/schema.sql` | entries 表删列：`stream`、`evidence`、`tier`、`ttl`、`last_access`、`source`、`source_task_id`、`cross_session_count`；删 `idx_entries_stream` 索引；删 `delegations` 表 |
| `worker/worker.js` | ① 常量：`STREAMS` 删、`ORIGINS` 改 `['user','sagitta']`、`EVIDENCE_STATES` 删、`CONSOLIDATE_ACTIONS` 改三项；② 路由：`POST /mem`（写）、`GET /mem`（列）、`POST /mem/{id}/{validate\|replace\|archive}`；删 `/mem/delegations` 两条；③ 删 `createDelegationHandler`/`getDelegationHandler`；④ `consolidateHandler` 拆三；⑤ `createEntryHandler`/`listEntriesHandler`/`searchHandler` 去 stream 与已删字段；⑥ `getEntryHandler` 去 last_access 块 |
| `plugins/memory/lib/config.js` | 删 `STREAMS`；`ORIGINS` 改 user |
| `plugins/memory/lib/tools.js` | ① 投影与 schema 删字段（含 114 行 ripple→user）；② `memory_remember` 删参数；③ `memory_recall` 去 stream 必填；④ `memory_consolidate` → 三个新工具；⑤ `memory_verify` 删 delegation 模式；⑥ 删 `MEMORY_PROMPT_GUIDANCE`（另一单在做） |
| `plugins/memory/lib/client.js` | 删 delegation 两方法；consolidate 拆三；改错误文案（D1 token → Access 服务令牌） |
| 文档 | `memory-system-design.md`：删 §7 四流、§3 字段表同步、§6 标注"未实现"；`worker/README.md` 端点表同步 |

**验收**：`node --check` 全部文件；worker smoke；memory smoke（含 manager/connect 两个）；真机 health；一次 `remember → recall → validate → archive` 端到端回归。

## 4. 风险与顺序建议

1. **先删列还是先停用**：D1 删列需要 migration（SQLite `DROP COLUMN` 或重建表）。建议顺序：代码先不再读写 → 部署验证 → 再执行列删除 migration。
2. **接口路径改造（`/mem/{stream}` → `/mem`）** 会同时改变 worker 路由与客户端方法，属于一次性的协同改动，建议单独一个 commit。
3. **状态机、召回机制本轮不动**：召回要重新设计（P0 是"没有自动召回"），等设计清楚了再加。
4. 每步都要能独立验证：删字段不改变既有行为（因为无人读）→ 风险低；拆接口要跑端点回归。
