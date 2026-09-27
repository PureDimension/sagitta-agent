# 记忆系统 / 任务系统 清理决策清单（2026-09-27 涟漪逐条拍板）

> 本文档是**施工依据**：列出的都是涟漪已确认的结论；标「待定」的是尚未拍板的，不要动。
> 每条尽量附证据（文件行号 / 实测输出），便于施工时复核。

## 0. 总原则（涟漪 2026-09-27）

1. **如无必要勿增实体**：没有消费者的字段/接口/机制，一律删掉，不留"将来可能有用"。
2. **分类不强加**：分类必须来自真实使用；模型自己想的分类法会反过来制约以后（type/stream 的教训）。
3. **代码里不出现"涟漪"**：枚举取值统一用 `user`；"涟漪"只出现在 persona 与记忆里作为称呼。
4. **这一轮以删为主**：记忆模块"太脏以至于没法设计"，先把脏东西删干净，再谈新设计。

## 1. 命名

| 项 | 结论 | 影响面 |
|---|---|---|
| `origin` 取值 `ripple` | **改 `user`** | worker `ORIGINS`、`TASK_NEED_HUMAN_RESOLVED_BY`、`DELEGATEES`、工具枚举与描述、设计文档/README 里的取值说明 |
| `delegatee=ripple` | 同上改 `user`（语义不变：只能由用户本人触发） | worker 白名单、工具描述、设计稿 §3 |
| 叙事里的"涟漪" | **保留**（那是对用户的称呼，不是枚举值） | persona、记忆条目文本 |

## 2. 记忆侧：删除清单（已确认）

| 删除对象 | 依据 |
|---|---|
| `stream` 字段（含索引、白名单校验、召回过滤、工具参数） | 设计稿把"四流是否保持"列为**待拍板**（`memory-system-design.md:330`），却实现成必填 + 索引 + 白名单；涟漪 2026-09-27 确认删除 |
| `evidence` 字段与四个取值 | v1.2 遗留；v1.3 后语义由 score + validated 事件承担；模型永远只填一个值（默认 `plausible`），与信任重复 |
| `tier` / `ttl` / `last_access` | `tier`/`ttl` 在设计中只有一句"预留"，**零实现**；`last_access` 有写无读，且写入失败被吞（`worker.js` getEntryHandler） |
| `source` / `source_task_id` / `cross_session_count` | 只写不读（`source_task_id` 有工具参数但无人消费） |
| `POST /mem/delegations` 写接口 + `delegations` 表 + 工具里的读取 | **实测零调用**：`tools.js` 中只有 `getDelegation`（731 行），无 `createDelegation`；`memory_verify(task_id=tsk-20260927-45332d)` 返回「delegation 记录不存在」 |
| `consolidate` 的 `digest` / `corroborate` 两个动作 | v1.3 后升级已由 ack 按分数自动完成，这两个动作退化为兜底、实际不会被调用 |
| 设计稿中写了但代码里没有的 `counterexample` / `access` | 设计-实现不一致，随本次清理一并从设计中移除 |

## 3. 记忆侧：保留（已确认）

| 保留 | 说明 |
|---|---|
| `content`（唯一必填正文） | 记忆的本质 |
| `type`（8 值） | 涟漪确认保留 |
| `origin`（user / sagitta） | 决定初始信任分 |
| `domain` | **层级分类**，见第 5 节 |
| `tags` | 涟漪确认保留 |
| `condition` | **可选**（不只是经验，也可能只是"记住某件事"）；现状已是可选，无需改 |
| `supersedes` / `superseded_by`（取代链） | 经验更替的事实 |
| `pinned` | 治理永不归档 |
| `score` / `status` / `ack_count` / `explicit_ack_count` / `unobjected_ack_count` / `oppose_count` | 信任轨道（状态机本轮不动） |
| `validation_events` 表 | validated 事件 = 验证事实 |
| `memory_remember` / `memory_recall` / `memory_verify` 三工具 + 对应接口 | 保留 |
| `consolidate` 的 `validate` / `replace` / `archive` 三个动作 | 保留（形态是否拆成独立工具：待定） |

## 4. 归档语义（澄清）

`archived` = **软归档**：行仍在表中、**默认不参与召回**，显式 `status=archived` 或按 id 仍可读到。
两条触发路径：① 治理归档（`consolidate archive`，pinned 拒绝）；② 反对信号把 score 压到 0 以下 → 自动软归档（涟漪拍板"软归档而非硬删"）。

## 5. 分类方案（涟漪授权由 Sagitta 决定，2026-09-27）

**结论：单一层级分类 = `domain`；"谁的"由 `origin` 表达。**

- `domain` 形态：`<一级：领域>/<二级：主题>[/更细…]`，自由文本，**服务端不校验形态**（避免又写死一套分类）。
- **一级 = 领域**：项目名（`sagitta-agent`、`reachflow`、`游戏A`）或非项目的个人领域（如 `personal`、`meta`）。项目的"领域"地位由此确立——**项目即一级**。
- **二级 = 主题**：在该领域里谈什么（`plugins`、`关卡设计`、`偏好`…）。
- **任务侧对齐**：`tasks.project` **就是**记忆里的一级领域（同一个概念，不引入第二种叫法）；任务侧不再有 `stream`/`company`。
- **归属不再是独立维度**：`origin=user|sagitta`（谁的）+ `type`（偏好/教训/决策…）已经表达了旧的 stream 想表达的东西。
- **召回不强制分类**：`domain` 前缀、`origin`、`type`、`status` 全部是**可选**过滤；不带过滤 = 全库搜。
- 旧设计里那四个"指挥链域前缀"（`delegation/*`、`verification/*`、`supervision/*`、`cost-timing/*`）**降级为二级主题示例**，不再是"域约定"。

## 6. 不落实 / 后置（已确认）

| 项 | 状态 |
|---|---|
| 记忆分层（L0/L1/L2/L3 常驻注入、四层强制复写） | **未实现，本轮不落实**：设计稿只写了"三级注入"却没定义"层"是什么；代码里只做到"recall 可选 domain 前缀 + 默认排除终态"。召回机制需要重新设计，**等记忆清干净之后再谈** |
| 状态机（captured→digested→corroborated→validated、superseded/archived） | **本轮不动**（"没利用起来"的部分后置，不影响使用） |

## 7. 任务侧待办（尚未逐条拍板，列出备查）

| 项 | 证据 | 状态 |
|---|---|---|
| `priority` 字段 | 只有存/校验/下发，**无任何行为读它** | 涟漪："没人用就应该删" → 待施工 |
| `stream` + `company` 默认值 | 与记忆侧同名概念；记忆侧已删 | 待施工（与第 5 节一致） |
| `ripple-stop` | 全历史仅引入一次；6 处引用（worker / schema 注释 / 2 文档 / 客户端 2 校验） | 涟漪确认删除；**需联动 auto-advance `round-close.js:62`** |
| `claim_token` 兼容字段 | v3 文档自述"仅旧客户端兼容，非权限来源" | 待定 |
| PATCH 终态 vs round-close+confirm 双通道 | v3 文档 §4 | 待定 |

## 8. worker 侧已完成的清理（2026-09-27）

| 改动 | commit |
|---|---|
| 删 CORS + `OPTIONS` 免认证分支；删死常量 `EVENT_TYPES`；`parseJsonArray` 坏数据改为 fail-loud（`CORRUPT_JSON_FIELD`），调用点带字段名 | `c007864` |
