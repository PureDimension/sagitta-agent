# 基础设施重构规格书 v3（最终版 · 2026-09-27）

> **本文件是唯一权威。** 与任何代码或旧版规格冲突时，以本文件为准。
> v3 相对 v2 的变更：preset 随 manager 包分发、凭据走 GUI 输入框、codex 模型归 manager、
> Worker 部署判据改为"已部署哈希"、新增第三阶段（交互模型）规格。

---

## 0. 涟漪定下的原则（硬性，逐条执行，违反即返工）

1. **不写兜底。** 兜底只在"前面的逻辑概率性正确"时才允许。前面逻辑正确则不需要；
   前面逻辑错误则应改正确，而不是兜底。
2. **不吞异常。** 只有日志/诊断这类副作用可以 try/catch，且不得掩盖真实失败。
3. **不写没有调用者的代码。** 任何函数、字段、导出，全仓库无消费者即删除（含仅被单测引用的）。
4. **不写没有消费者的机制。** 订阅/通知/监听，无订阅者则整套删除。
5. **不写时序兜底。** 禁止 `queueMicrotask` 等"再等一拍"式的第二次机会。
6. **不保留兼容字段。** 同一语义只允许一个字段名，旧名一律删除。
7. **不写死分支。** 到达不了的分支删除。
8. **一切配置必须有 GUI 入口。** 不得存在"只能改文件"的配置项。
9. **代码必须简洁。** 每一处代码的实际效果都要能用中文讲清并经涟漪确认。
10. **行为不得退化。** 重构后功能不得少于重构前。

---

## 1. 硬约束（DSH 源码实证，不得违抗）

| 约束 | 出处 |
|---|---|
| 工具/提示词可见性由注册层决定：host → 全局；preset → 仅该 preset 的会话 | `dsh-agent-presets/README.md` |
| **浏览器端部件（`dsh.client`）只能从 host 加载**：client 扫描 `ctx.loader.entries()`，preset 子树是 directly-plugged、不在其中 | `dsh-client-modules/lib/index.js:290,423` + `dsh-agent-presets/README.md` |
| **preset 层插件不能注册 settings namespace**（第二个会话挂载同一 preset 会因重复注册失败） | `dsh-client-ui-settings-plugins/README.md:37` |
| 跨层只能 preset → global 读，不能 global → preset 读 | `dsh-agent-presets/README.md` |
| patch 是**整体替换** entry 的 config，不是深合并；未写字段回到 schema 默认值 | `dsh-app-boot/README.md` |
| `cordis.patch.yml` 热重载，改配置不需重启 | `dsh-app-boot/README.md` |
| `dsh.web-app` 的 `ui-settings-plugins` **只渲染有卡片认领的 namespace**；第三方插件必须自己写卡片，且禁止 import 官方卡片代码 | `dsh-client-ui-settings-plugins/README.md:9,38` |
| Node 原生 `fetch` 不走系统代理；必须自实现 CONNECT 隧道 | 实测 |
| `--dump-config` 可离线验证组合结果（**会打印明文密钥，必须过滤**） | 实测 |

---

## 2. 目标形态

### 2.1 分层（3 + 2）

```
host 层（profile bundles；进程级，所有会话共享）
├── @sagitta/manager        配置 + 凭据 + HTTP 通道 + Worker 部署 + preset 分发
├── @sagitta/auto-advance   自主推进编排 + 任务面板（有 dsh.client → 必须 host）
└── @sagitta/async-work     有界工作注册表（auto-advance 注入它）

preset 层（仅 sagitta 会话可见）
├── @sagitta/memory         记忆四工具 + 任务工具 + 门禁
└── @sagitta/codex-dispatch codex 派单工具

删除
└── @sagitta/updater        功能归零
```

### 2.2 profile/package.json

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-sdk-protocol": "0.0.1-rc.1",
    "@deepseek-ai/dsh-subagent-codex": "0.0.1-rc.1",
    "@sagitta/manager":        "github:PureDimension/sagitta-agent#path:plugins/manager",
    "@sagitta/auto-advance":   "github:PureDimension/sagitta-agent#path:plugins/auto-advance",
    "@sagitta/async-work":     "github:PureDimension/sagitta-agent#path:plugins/async-work",
    "@sagitta/memory":         "github:PureDimension/sagitta-agent#path:plugins/memory",
    "@sagitta/codex-dispatch": "github:PureDimension/sagitta-agent#path:plugins/codex-dispatch"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@sagitta/manager",
        "@sagitta/auto-advance",
        "@sagitta/async-work"
      ]
    }
  }
}
```

### 2.3 profile/cordis.patch.yml（全部内容）

```yaml
- id: agent-presets
  config:
    default: sagitta
    roots:
      - path: !!js dshHomePath('profiles', 'web', 'node_modules', '@sagitta', 'manager', 'presets')
        trust: user
    includeUserRoot: false
```

**这是唯一的 patch 内容。** manager 的 workerApiUrl / proxy / 凭据全部走 GUI（settings + credentials），
不再出现在 patch 里。

### 2.4 preset 随 manager 包分发

```
plugins/manager/
├── package.json
├── cordis.patch.yml
├── presets/
│   └── sagitta/
│       ├── agent.cordis.yml     现有 277 行 + 末尾两行（memory / codex-dispatch）
│       └── preset.yml
└── lib/...
```

- 仓库根 `presets/` 迁移进 manager 包后删除
- `<dshHome>/.agent-presets/sagitta/`（含 20+ 份历史 .bak）整体删除

### 2.5 凭据（DSH 原生，全部可从 GUI 写）

```yaml
# ~/.dsh/.credentials.yaml
version: 1
refs:
  SAGITTA_ACCESS_ID: ...
  SAGITTA_ACCESS_SECRET: ...
  SAGITTA_UPLOAD_TOKEN: ...
```

---

## 3. manager 规格（最终版）

### 3.1 定位

整个 sagitta 体系**唯一的基础设施主人**：配置、凭据、对外 HTTP 通道、Worker 部署、preset 分发。

### 3.2 对外 API（仅三个方法）

```js
await manager.apiConfig()
// → { workerApiUrl, proxy, scriptName, repoPath, accessId, accessSecret, uploadToken, codexModel }
//   凭据已解析为实际值（异步）

await manager.request(path, init)
// path: '/mem/recall' 等；init: { method, body, headers, timeoutMs }
// 内部：加 CF-Access 头、走 CONNECT 隧道或直连、超时、失败抛错
// → { status, ok, headers, json(), text() }

await manager.deployWorker()
// → { status: 'deployed' | 'up-to-date', version, sha }
```

### 3.3 配置字段（全部 GUI 可改）

| 字段 | 默认值 | 类型 | 说明 |
|---|---|---|---|
| `workerApiUrl` | 空（必填） | 文本 | Worker 根地址 |
| `proxy` | `http://127.0.0.1:7897` | 文本 | 空串 = 直连 |
| `scriptName` | `sagitta-memory` | 文本 | Cloudflare Worker 脚本名 |
| `cfAccountId` | 空（部署时必填） | 文本 | Cloudflare 账户 ID（非密钥）。**不要改成为查询 memberships 接口** —— 那需要额外权限、且多账户时会歧义；配置一个确定的 ID 更可靠 |
| `repoPath` | 空（选填） | 文本 | 部署 Worker 时定位 `worker/worker.js`；空 = 关闭自动部署 |
| `codexModel` | `gpt-5.6-luna` | 文本 | codex 派单默认模型（codex-dispatch 在 preset 层、无法注册 settings，故归此处） |
| `accessIdRef` | `SAGITTA_ACCESS_ID` | 文本 | 凭据**引用名**（涟漪要求：引用名也必须可改） |
| `accessSecretRef` | `SAGITTA_ACCESS_SECRET` | 文本 | 同上 |
| `uploadTokenRef` | `SAGITTA_UPLOAD_TOKEN` | 文本 | 同上 |
| 三个凭据的值 | — | **密钥控件**（走 credentials domain） | 分别对应上面三个引用名当前指向的凭据 |

**共 9 个文本字段 + 3 个密钥控件。** 引用名与值都是可配置的：
改引用名 → 指向另一份凭据；写值 → 改当前引用名下的凭据。

### 3.4 文件结构

```
plugins/manager/
├── package.json
├── cordis.patch.yml
├── presets/sagitta/{agent.cordis.yml, preset.yml}
└── lib/
    ├── index.js        服务类 + 三方法 + settings 注册            约 90 行
    ├── config.js       字段声明                                    约 45 行
    ├── credentials.js  引用名 → 值（ctx.credentials.resolve）       约 30 行
    ├── tunnel.js       CONNECT 隧道（从 memory 搬）                 约 70 行
    ├── request.js      通道：隧道/直连 + 头 + 超时                   约 70 行
    ├── deploy.js       Worker 部署                                  约 90 行
    └── client.js       设置卡片（含 3 个密钥控件）                   约 250 行
```

### 3.5 Worker 部署判据（v3 修订：不再用 VERSION 字符串）

```
deployWorker():
    1. 读 <repoPath>/worker/worker.js，算 sha256
    2. 读本地状态文件 <profileDir>/.sagitta-deployed.json 里记录的"上次成功部署的 sha"
    3. 相同 → 返回 { status: 'up-to-date' }
    4. 不同 → 上传（multipart，经 CONNECT 隧道）→ 回读 /mem/health 校验 → 写入新的 sha
    任何失败 → 抛错（不吞、不重试、不降级）
```

**为什么不用 VERSION 字符串**：忘改版本号就不会部署，是个易错判据。
**为什么不用线上哈希**：Worker 运行时拿不到自己的源码哈希，需要额外注入；本地记录更简单。
**已知局限**：清空本地状态会多部署一次（无害，幂等）。

**启动时机**：`apply()` 之后发起；`repoPath` 为空则显式关闭并在 README 写明。

### 3.6 设置卡片（含密钥控件）

- 4 个文本字段 + 3 个密钥控件
- 密钥控件：空白起步，只显示"已配置/未配置"；写入走 credentials domain；`writable:false` 时只读
- 渲染用 `--dsw-alias-*` 变量，观感与官方卡片一致
- 只读写 `sagitta-manager` 一个 namespace
- **禁止** import `@deepseek-ai/dsh-client-ui-settings-plugins` 的任何代码（自持 staging 与 revision fencing）

官方写法（`dsh-client-ui-settings-plugins/lib/client.js:96,986-1110`，API 名称以官方代码为准）：

```js
const response = await api.credentials.describe({ refs: [ref] });
await api.credentials.set({ ref, value });
ctx.remote.$on('credentials/reference-updated', (ref) => { /* 重新 describe */ });
```

实施前必须核对并写进报告：浏览器端 credentials 的确切调用路径、`writable` 语义、失效事件名。

---

## 4. 其余插件改动

> ⚠️ **本节 4.2 / 4.3 / 4.4 / 4.5 尚未获得执行授权**（涟漪 2026-09-27：全部代码还没审阅完）。
> 它们记录的是"已发现的问题"，**不是当前的施工命令**。执行见 §7 阶段三。

### 4.1 memory（瘦身）

- 删 `lib/http.js`（16KB 隧道 + 凭据）→ 改用 `manager.request()`
- 删 `lib/config.js` 的 proxy/timeout 逻辑；**取消全部配置项**（preset 层不能 GUI 配置，
  无配置项即无违反）
- 保留：四个记忆工具、任务工具、`task-gate.js` 门禁、提示词注入
- **删除 tasksPath / TASKS.md 相关的全部代码与文案**

### 4.2 codex-dispatch

- **删除全部 legacy 兼容代码**（约 150 行，见 §6 自审计）：
  `legacyStatus` / `toLegacyCodexWork` / `cleanupLegacyDetachedCodex` / `legacyPidsFrom` /
  `CodexWorkRegistry` 类 / `SAGITTA_CODEX_LEGACY_PIDS` / `markUnavailable` 相关降级路径
- `toCodexWork()` 只保留一种命名（snake_case，与 async-work 对齐）
- 默认模型改为从 manager 读（`manager.apiConfig().codexModel`）
- 本次不改派单模式（第三阶段的 app-server 改造单独做，见 §5）

### 4.3 auto-advance

- 删自带网络实现与 `proxy`/`taskApiTimeoutMs` 配置 → 改用 `manager.request()`
- `statePath` 给默认值 `<DSH_HOME>/profiles/<profile>/.sagitta-auto-advance.json`
- **`tasksPath` 与 TASKS.md 相关逻辑彻底删除**
- **删除 `handleAsyncWorkSettled` 里的 `directDrive` 死分支**（自主推进下 agent 几乎不 idle；
  该分支等价于"意见一致听我的、不一致听老婆的"的原地绕圈）
- 其余行为参数保留并注册 `sagitta-auto-advance` settings namespace（GUI 可改）
- **本次不精细重构其内部逻辑**（涟漪后续单独提要求）

### 4.4 async-work

- 删 `listActive` 里连续两次 `reap` 的第二次
- 删 `register` 里的 100 次 id 冲突重试循环
- `AsyncWorkError` 去掉 HTTP 语义的 `status` 字段（本地注册表无 HTTP 传输）
- 注册 `sagitta-async-work` settings namespace
- `markUnavailable/markAvailable` 随 codex-dispatch 的 legacy 路径一起删除

### 4.5 updater

删除整个 `plugins/updater/`，并从 profile 依赖、bundles、README、脚本引用中移除。

---

## 5. 第三阶段：交互模型（待涟漪确认后执行）

### 5.1 async-work 的"插入"语义

- 现状：工作完成发 `async-work/settled` 事件 → auto-advance 处理
- 现状问题：`directDrive` 死分支（见 §4.3）
- 目标：**通知立即被看到**，不排队等到整个回合结束
- 技术约束：LLM 回合不可打断（DSH 的回合是完整请求-响应循环）
- **待定方案**：把通知"捎带"到 agent 的下一个工具结果上（需先确认 DSH 是否提供该钩子）

### 5.2 codex 派的实时互动（路线 A）

- 目标：派单后可与运行中的 codex 实时对话
- 方案：`codex app-server`（daemon）+ JSON-RPC 客户端
  - 传输：`--listen ws://IP:PORT` / `unix://` / `stdio://`
  - 协议：`generate-json-schema` / `generate-ts` 现成导出（v2 有 252 个消息类型）
  - 关键方法：`ThreadStart` / `TurnStart` / **`TurnSteer`**（轮次中插话）/ `TurnInterrupt` /
    `ThreadRead`；通知：`AgentMessageDeltaNotification` / `TurnCompletedNotification`
- 收益：真·实时互动；**且 `process-tree.js` 的 420 行大部分可删**（不再自己 spawn 子进程）
- 成本：约 500~600 行新代码 + 一个常驻进程
- 风险：协议标记 `[experimental]`

---

## 6. 设计自审计（涟漪要求：修改后的配置与 manager 是否合理）

### 6.1 合理之处

1. **manager 该存在，理由是硬的**：DSH 的 settings namespace 只能有一个 owner（重复注册 fail loud），
   而"三个插件共用一份配置"必须有一个 owner 来承载 —— 这个位置只能是 manager。
2. **HTTP 通道收归 manager 是对的**：CONNECT 隧道是所有联网插件共用的底座，
   原本躺在 memory 里（第一个联网的插件），属于历史顺序造成的错位。
3. **preset 搭 manager 包分发是对的**：manager 是 host 层最不可能被移除的包，
   且 preset 本就是"配置"，与 manager 的定位一致；roots 指向 node_modules 安装产物，
   不依赖开发工作目录。
4. **3+2 分层是硬约束推出来的**，不是偏好：有 client 部件的必须 host，工具类应放 preset 以隔离。

### 6.2 我发现的三个问题（已在本版修正）

1. **原先打算新增 `@sagitta/preset` 独立包** —— 多余。preset 只是几个文件，
   搭 manager 包分发即可，省一个依赖、省一次拉取。→ v3 已改为随 manager 包。
2. **原先 Worker 部署用 `VERSION` 字符串比对** —— 易错（忘改版本号就不部署）。
   → v3 改为"本地记录的已部署 sha256"比对。
3. **原先三个凭据的"引用名"也是可配置字段** —— 违反"简洁"。引用名固定为约定值，
   GUI 只暴露"值"的输入框，少 3 个可配置项。→ v3 已改。

### 6.3 仍然存在的代价（需要涟漪知晓）

1. **`lib/client.js` 约 250 行是纯 UI**（占 manager 的 39%）。这是"一切可 GUI 配置"的
   必然成本 —— DSH 不提供自动渲染，卡片必须自己写。若放弃 GUI，manager 可降到约 390 行。
2. **`cfAccountId` 仍是人工填写的配置项**：Cloudflare 没有"从 token 反推唯一账户"的可靠契约
   （memberships 接口在多账户时会歧义），所以这个值必须人来填一次。

（第三阶段的代价与风险记录在 §5，不属于基础设施审计范围。）

---

## 7. 任务分解

> **边界（涟漪 2026-09-27 明确）**：全部插件代码尚未审阅完毕。
> **只有已审阅并经涟漪确认的改动才进入执行。** async-work / codex-dispatch / auto-advance
> 的内部改动不在本阶段，等全盘审阅之后再逐项定。

### 阶段一：基础设施（任务 `tsk-20260927-d4f22e`）

已完成：manager 骨架重建（551 行 / 7 文件，原 1063 行）

待办：
1. **manager 补齐**
   - 部署必须携带 bindings（读 `worker/reference/deploy.json`）—— 否则会清空线上 D1 与密钥绑定
   - 增加 `cfAccountId` 字段（不用 memberships 查询）
   - 三个凭据引用名回退为**可配置文本字段**（涟漪要求）
   - 增加 `codexModel` 字段
   - 部署判据改"本地记录的已部署 sha256"
   - 去掉 `states = new WeakMap()` 间接层（`this.ctx` / `this.scope` 即可）
2. **memory 瘦身**：删 `lib/http.js`，改走 `manager.request()`；取消全部配置项
3. **updater 整体删除**
4. **preset 迁入 manager 包**
5. 全部 commit + push

### 阶段二：配置切换（脚本已备：`D:\workspace\exp\switch-config-20260927.ps1`）

6. profile/package.json 改 git 依赖 + bundles 收缩
7. cordis.patch.yml 改为 §2.3 的内容
8. 凭据迁入 `.credentials.yaml`
9. 删除 `.agent-presets/sagitta/`
10. `pnpm install`（从 git 拉取）
11. `--dump-config` 验证（过滤密钥）
12. 重启 DSH，验证：工具隔离 / 设置卡片 / 凭据输入框 / Worker 自动部署

### 阶段三：全盘审阅后的改动（待涟漪逐项确认）

尚未审阅的代码：memory 其余部分、auto-advance（3615 行）、codex-dispatch legacy（150 行）、
async-work 清理项、worker.js（2423 行）、scripts、preset。

### 阶段四：交互模型（`tsk-20260927-25c73f`，待涟漪确认）

- async-work "插入"语义
- codex app-server 客户端（路线 A）

---

## 8. 验收标准

1. `node --check` 通过全部改动文件
2. 全仓库搜索确认不存在：`wrangler`、`tasksPath`、`TASKS.md`、`restartBridge`、
   `SAGITTA_CODEX_LEGACY_PIDS`、`CodexWorkRegistry`、`queueMicrotask` 兜底、旧字段别名
3. 每个被删除的符号附"零调用者"grep 证据
4. 重启后：sagitta 会话有全部工具；standard preset 会话看不到 sagitta 工具；
   设置卡片可改 4 个字段 + 3 个密钥；Worker 部署按 sha 判据工作
5. **行为不退化**：记忆四工具、任务工具、codex 派单、自主推进全部可用
6. 每一处代码的效果都能用中文讲清并经涟漪确认
