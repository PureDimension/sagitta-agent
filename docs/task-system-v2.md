# 任务系统 v2 设计稿（定稿）

> 面向：涟漪（使用者视角）
> 状态：定稿（09-03 三轮讨论吸收完毕）→ 待实施
> 配套原则：preset 只描述机制不写指令；强制力全部由插件代码执行

---

## 0. 一句话

任务系统是"我干活必须挂账、挂账后系统自动给我上下文、需要你时自动记账推给你、干完或卡死必须经你确认才能释放"的强制机制。它同时是项目的长期记忆载体。

---

## 1. 核心概念

| 概念 | 说明 |
|---|---|
| **项目** project | 长期方向/工作域。任务可挂项目（自动带项目记忆）或**无根**（新调研等暂不属某项目） |
| **任务** task | 最小账目单位。`normal`（正式全流程）/ `temp`（临时小事极轻量） |
| **执行记录** log | 任务进展时间线（按需写） |
| **need-human 条目** | "需要涟漪参与/决定"的记账，挂任务下；不阻塞我推进其他部分 |

---

## 2. 状态机

### 2.1 normal 任务（四态，无 waiting）

```
open ──认领──► in_progress ──完成确认──► done
 ▲                │  ▲
 │                │  │ need-human 全清（含"算了不做了"）→ done
 │                ▼  │
 └────────────  blocked ◄── 卡死确认（严格，需质询）
```

| 状态 | 含义 | 进入 |
|---|---|---|
| `open` | 未认领 | 创建默认；need-human 解除 → 回 open |
| `in_progress` | 我认领推进中（可挂 open need-human；交流也算推进） | 认领 |
| `blocked` | 我无自主活，卡你 | **质询确认**后才注册 |
| `done` | 完成 | 需质询（自审交付）+ **无 open need-human** 才可 |

规则：
- **need-human 清完之前不许 done**——一直 blocked 也没关系（你处理方式自由：可能"算了不做了"）
- 你响应某条 need-human → 我 resolve → 若它曾是唯一阻塞 → 任务自动 done / 或回 open 继续
- 只有 in_progress 能走向 done/blocked；done/blocked = 释放认领

### 2.2 temp 任务（两态，豁免质询）

```
temp: in_progress → done（直接完成，无质询）
```
- 前端不可见；目标两次调用完成；可挂项目（自动带记忆）或无根
- 用于"加几个字"等小事，无执行记录负担

### 2.3 need-human（两态）

```
open（等我）──你响应（解决/算了不做）──► resolved
```
- 任意一条 resolve → 所属任务若 blocked → 回 open（或全清后 done）
- 前端"待你处理" = 所有 open need-human 自动汇聚（取代 checkbox）

---

## 3. 强制力（插件执行）

### 3.1 工具门禁
只读/讨论类（read/grep/glob/recall/搜索）自由；执行型（write/edit/pwsh/codex_dispatch/subagent）**必须已认领 normal 或 temp**。拒绝时自动注入提示。

### 3.2 熄火（任务驱动，废除 idle 计时）
存在 in_progress → 推进/注入；全 done/blocked → 熄火；有 open → 提示可开工。

### 3.3 结束对话门禁
有 in_progress 未释放 → 提示先处理；你明确"挂着下次"则允许。

---

## 4. 质询注入（在场与自主推进都执行）

我要**标 blocked 或 done** 前，插件自动注入质询（在场也注入，强化意识），核心问：
"确认已推进到必须由涟漪处理的地步？是否已对交付内容做了审计（自测/自查/验收）？"
- blocked：确认无自主活可干
- done：确认交付完整 + 无 open need-human
- **temp 豁免**：直接完成

---

## 5. 项目记忆召回

- **认领项目任务时**：自动召回该项目记忆**最新 N 条**（先不做"重要标记"优先级）
- 召回内容拼提示："如需了解项目更多背景，可调用 memory_recall 按 domain=projects/项目名 查询"
- 项目记忆存 memory（personal/company 流 + domain=projects/项目名）
- 执行记录的重要发现 → 我可写项目记忆

---

## 6. 插件依赖链

```
auto-advance（自主推进：任务驱动熄火 + 质询注入）
      ↓ 依赖
task（任务/认领/门禁/need-human/注入）
      ↓ 依赖
memory（记忆：项目记忆 + recall/remember）
```

---

## 7. 前端

| 区 | 内容 |
|---|---|
| **待你处理** | 所有 open need-human 跨项目汇聚（倒序）——取代 checkbox |
| **项目进度** | 项目→任务（推进中/卡你/完成；temp 不可见） |
| **任务详情** | body + 执行记录 + need-human 列表 |

你处理某条 need-human 后，提示词提醒我 resolve（防忘清"待你处理"）。

---

## 8. 与旧系统差异

checkbox→need-human 汇聚；waiting→删；round_close→删；blocked_by→不做；idle 计时熄火→任务驱动；TASKS.md→退役；preset 指令→机制说明。