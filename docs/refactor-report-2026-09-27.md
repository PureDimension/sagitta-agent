# 改造进展报告（2026-09-27）

> 本文件记录本轮基础设施与插件改造的**实际改动与验收证据**，供涟漪审阅。
> 规格与边界见 `docs/refactor-infra-2026-09-27.md`（v3 最终版）。
> 状态：部分进行中，交付后逐项补齐。

---

## 一、总览：行数变化（产品代码，不含测试）

| 插件 | 改造前 | 现在 | 变化 | 状态 |
|---|---|---|---|---|
| `manager` | 1063 | **699** | −364 | ✅ 已验收（独立复跑自测 5 项全过） |
| `async-work` | 617 | **559** | −58 | ✅ 已验收（独立复跑自测 PASS，含 steer 断言） |
| `memory` | 3078 | **2432** | −646 | ✅ 已验收：`Config` 归零、`http.js` 删除、独立复跑自测 63 项 + manager/connect 两个 smoke 全 PASS |
| `updater` | 1167 | **0** | −1167 | ✅ 已整体删除（scripts/README 引用全部清理，零残留） |
| `auto-advance` | 3615 | **3136** | −479 | ✅ 网络层改造已验收：Config 收敛到 8 个推进参数（`proxy`/`taskApiTimeoutMs`/`tasksPath` 已删）、`statePath` 默认落 `<DSH_HOME>/profiles/web/`（推导不出来就抛错）、对 `memory/lib/http.js` 的跨插件依赖清零、已改用 `manager.request`。⏳ 自测修复单已派（`50eb3393`）：`e1663a7e` 删 `handleAsyncWorkSettled` 时漏改测试，测试仍在断言已删除的 `directDrives` 机制 |
| `codex-dispatch` | 980 | **559** | −421 | ✅ 主体已验收：app-server 化、legacy 层零残留、`process-tree.js` 已删、三工具齐备（含新增 `codex_append`）；⏳ `codex_append` 的"排队进入"语义修正单已派（`245efeeb`） |

**仓库合计：44 files changed, 946 insertions(+), 4956 deletions(-) — 净删约 4000 行**，删掉的全是死代码/兜底/兼容层，功能未减。

---

## 二、manager（1063 → 699 行）✅ 验收通过

### 结构（7 个产品文件 + 1 个测试）

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/index.js` | 59 | 服务类 + 三个对外方法 + settings 注册 |
| `lib/config.js` | 12 | 9 个配置字段声明 |
| `lib/credentials.js` | 13 | 引用名 → 凭据值（`ctx.credentials.resolve`） |
| `lib/tunnel.js` | 148 | CONNECT 隧道（手写 HTTP/1.1 解析） |
| `lib/request.js` | 104 | 通道：隧道/直连 + CF-Access 头 + 超时 + 失败抛错 |
| `lib/deploy.js` | 70 | Worker 部署：sha 判据 + bindings + 回读校验 |
| `lib/bindings.js` | 35 | 从 `worker/reference/deploy.json` 解析 D1/secret bindings |
| `lib/client.js` | 258 | 设置卡片：9 文本字段 + 3 个凭据控件 |

### 关键修复与验证

1. **部署必须带 bindings（原本会打挂线上）** ✅
   旧实现 `metadata = { main_module }` 不带 bindings —— 按 Cloudflare 语义，**这会把线上 D1 与 secret 绑定全部清空**。现改为从 `worker/reference/deploy.json` 读取并携带（`lib/bindings.js`），缺失或非法则抛错、不退化上传。
   实测确认 `deploy.json` 的 `AUTH_TOKEN` 标了 `generate: true`，但文件 notes 明确写"Bearer 路径实际未启用，轮换无兼容风险"，因此每次部署随机生成无副作用。

2. **部署判据改为 sha256** ✅
   不再比对源码里的 `VERSION` 字符串（忘改版本号就不部署），改为比对 `<profileDir>/.sagitta-deployed.json` 里记录的源码 sha。状态文件不存在 = 首次部署的正常状态。

3. **凭据走 DSH 原生** ✅
   配置里只有引用名（`SAGITTA_ACCESS_ID` 等三个，且**引用名本身也是可配置字段**，符合"一切可 GUI 配置"），值存 `~/.dsh/.credentials.yaml`。卡片通过官方模式读写：`api.credentials.describe({refs})` / `api.credentials.set({ref, value})` / 订阅 `credentials/reference-updated`，并自带竞态保护（引用名变更时丢弃过期响应）。

4. **死代码清净** ✅
   `getPublicStatus` / `watchConfig` / `notify` / `listeners` / `memoryClient` / `taskClient` / `createAdapterClient` / `requestWorkerUpload` / `requestHostRestart`（两处）/ `hasScope` / `emptyApiConfig` / `safeLog` 吞错 / `queueMicrotask` 兜底 / WeakMap 间接层 —— 全部删除。

5. **preset 随包分发** ✅
   原仓库根 `presets/sagitta/` 迁入 `plugins/manager/presets/sagitta/`，**原 228 行一字未改**，仅末尾追加 7 行（注释 + memory/codex-dispatch 两行）。

### 遗留小瑕疵（待修）

| 位置 | 问题 |
|---|---|
| `lib/deploy.js:13-16` | 读 `config.profileDir`，但 Config 里没有该字段 → 死分支 |
| 同上 | `dshHomePath("profiles","web")` 写死 profile 名（当前事实正确） |

### 独立验证（不由交付方自证）

在仓库内复跑 manager 自测**成功**（5 项全过）：

```
apiConfig returns 9 fields and configurable credential refs: PASS
request CONNECT tunnel branch: PASS
deploy bindings resolution and strict reference errors: PASS
deploy sha branch: PASS ({ status: 'up-to-date' })
deploy sha branch: PASS ({ status: 'deployed', sha })
manager smoke: PASS
```

**复跑方法**（仓库没有 node_modules，插件的 peerDependencies 在 DSH 安装级回退目录）：

```powershell
$link = 'D:\workspace\sagitta-agent\plugins\manager\node_modules'
New-Item -ItemType Junction -Path $link -Target 'C:\Users\cyan\.dsh\profiles\node_modules'
node D:\workspace\sagitta-agent\plugins\manager\test\smoke.mjs
Remove-Item $link -Force
```

坑：链到 `profiles\web\node_modules` 无效（那里没有 cordis）。

---

## 三、async-work（617 → 559 行）✅ 验收通过

按涟漪逐项拍板执行，全部实测确认：

| 项 | 内容 | 证据 |
|---|---|---|
| R1 | 删未使用的上限常量，改内部常量 | `RECENT_LIMIT=20` / `RECENT_TTL_MS=6h` |
| R2 | `AsyncWorkError` 去掉 HTTP 语义的 `status` | 只剩 `code` + `message` |
| R3 | 校验函数 7 → 2（`requireString` / `requireTimeout`） | ✅ |
| R4 | 删 `closed` / `_ensureOpen`（防御不存在的场景） | grep 无命中 |
| R5 | **快照替代克隆+藏字段** | `snapshot()` 显式列 10 字段，注释写明"对外传递的是快照，不是副本"；`Object.defineProperty` 全清 |
| R6 | 删 100 次 id 冲突重试 | ✅ |
| R7 | 配置项 3 → 1（只留 `defaultTimeoutMs`） | ✅ |
| R8 | 删 `listActive` 里第二次 `reap` | ✅ |
| R9 | **通知失败可见但结算照常返回** | 注册表接 `onListenerError`；Service 层接 `ctx.logger.error` |
| R10 | 三个结算工具合并为 `async_settle` | ✅ |
| R11 | 删三个可用性开关 | grep 无命中 |

**新增：自己负责提醒**（涟漪的判定：提醒不该外包）

```js
notifyOwner(payload) {
  const agent = this.ctx.agents?.get?.(payload.ownerId);
  if (agent === undefined) return;
  agent.steer(createUserMessage({ ... }));   // next-step：下一步立刻插入，不再排队
}
```

`inject` 加了 `"agents"`；`settledPayload()` 补了 `kind`。

---

## 四、auto-advance（提醒归属部分）✅

| 删除 | 证据 |
|---|---|
| `handleAsyncWorkSettled()` 整个方法 | grep 残留 0 |
| `settledWorkIds` 两处初始化 | 同上 |
| `directDrive` 参数（`queueNotice` + `agentFollowup`） | 同上 |
| 三个通知辅助函数 | 同上 |

**关键纠正**：`agentFollowup` 原本有个 `if (directDrive)` 分支，但 DSH 的 `followup(input)` 定义就是 `send(input,"next-turn",true)` —— **两条分支行为完全相同**，是一个等价于"绕圈"的冗余（涟漪的判定准确）。现已简化为一行。

订阅保留但改小：只用于触发 `resetTimer` 触发推进检查，不再构造消息、不再投递。

---

## 五、协议验证（路线 A 前置，已跑通）

```
Windows 上 codex app-server daemon 不可用（"only supported on Unix platforms"）→ 自己起进程
  node <npm>/@openai/codex/bin/codex.js app-server --listen ws://127.0.0.1:18787

实测链路：initialize 握手 → thread/start → turn/start → item/agentMessage/delta（流式）
         → turn/completed → 第二轮 turn/start（上下文保留，能复述第一轮回答）✅

额外捞到：thread/tokenUsage/updated（token 用量）、account/rateLimits/updated（周额度进度）、
         turn/interrupt（可中断单轮）、thread/read（读历史）
参考脚本：D:\workspace\exp\codex-verify.mjs
```

---

## 六、⚠️ 高危连锁（必须在重启前处理）

**`auto-advance` 跨插件依赖 `memory` 的隧道实现**：

```js
// plugins/auto-advance/lib/service.js:1588-1593
// 复用 @sagitta/memory 的 http.js（CONNECT 隧道 + 传输层重试），读云端 /task。
memoryRequestModulePromise = import("@sagitta/memory/lib/http.js")
```

同一文件 `:1672` 还有相应的失败分支：
`throw taskApiUnavailable("proxy 已配置但 @sagitta/memory 的 http.js 不可用（memory 插件缺失/版本过旧）")`

**后果**：memory 的 `lib/http.js` 一旦删除（当前正在进行的改造），auto-advance 读取云端任务就会失败，**自主推进直接失效**。

**修法**：auto-advance 改用 `ctx["sagitta-manager"].request(path, init)`（与 memory 改造后的方式一致）。同时它自己的 `proxy` / `taskApiTimeoutMs` 配置项随之下岗（统一归 manager），`tasksPath` 退役、`statePath` 默认落 profile 目录。

**时序要求**：此改动必须与 memory 的删除**同批提交**，且在重启 DSH 之前完成。

---

## 七、待办

| # | 事项 | 状态 |
|---|---|---|
| 1 | memory 网络层改走 manager + 删 `lib/http.js` | 🔄 进行中 |
| 2 | updater 插件整体删除 | 🔄 进行中 |
| 3 | codex-dispatch 切 app-server + 新增 `codex_append` | 🔄 进行中 |
| 4 | auto-advance 网络层改走 manager + `tasksPath` 退役 + `statePath` 默认落 profile | ⏳ 待派 |
| 5 | manager 两个小瑕疵（死分支 + 硬编码 profile 名） | ⏳ 待修 |
| 5b | **仓库根 `presets/` 与 `plugins/manager/presets/` 两份并存**（迁移时原目录未删）→ 必须删掉仓库根那份，否则分不清权威 | ⏳ 待清 |
| 5c | **`.sagitta-auto-advance.json` 仍写在仓库根**（运行状态落在源码仓库内）→ 随 auto-advance 改造移到 profile 目录 | ⏳ 待改 |
| 6 | 配置切换（profile 依赖改 git + bundles 收缩 + patch 极简 + 凭据迁移） | ⏳ 脚本已备 |
| 6b | **提交前清理**：`plugins/auto-advance/node_modules` 与 `plugins/updater/node_modules` 两个链接残留（codex 跑测试时建的，`.gitignore` 已覆盖不会误提交，但需删净） | ⏳ 等单完成 |
| 6c | **可安全删除的兼容残渣**（涟漪重申"很多兼容其实是真的可以安全删除"）：① `memory/lib/tools.js:883-894` 的 `patchTaskCompat`（task_update 失败退回旧字段重试的 shim，worker 早已支持 evidence_json/next_action）② 同文件 4 处 `claim_token` 旧客户端兼容字段（811/1320/1330/1376，v3 已改为云端 owner 匹配）③ `auto-advance/lib/service.js:6,1046` 的 compatibility export / alias ④ 同文件 503/757 的 older-RPC fallback（需确认上下文）。**注意**：`tools.js:9,473` 的"digest/corroborate 兜底动作"是业务语义不是兼容，保留 | ⏳ 等 memory/auto-advance 单落地后派清理单 |
| 7 | 全量 commit + push | ⏳ |
| 8 | codex 交叉审查 | ⏳ |

**配置切换脚本**：`D:\workspace\exp\switch-config-20260927.ps1`（幂等 + 逐步备份 + 支持 `-DryRun`）。
**最后一步重启 DSH 会中断当前会话，需涟漪在场**。
