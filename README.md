# @sagitta/memory — Sagitta 记忆模块插件与 Worker/D1 服务

把设计文档（`memory-system-design.md`）里的记忆工具接到已部署的
Cloudflare Worker API（`REPLACE_WITH_WORKER_URL`），以 DSH
（DeepSeek Harness）本地插件形式提供（当前契约版本 **v1.3：分数驱动 + 事件化验证**）。
这是 Sagitta 长期使用的真实代码：**Sagitta 每次记/忆/治理/验证都走这里**，
按生产标准实现，无 TODO。

- 插件格式：cordis 插件（对照 `@deepseek-ai/dsh-tool-web` / `dsh-tool-ask-user`）
- 工具名：`memory_remember` / `memory_recall` / `memory_consolidate` / `memory_verify`
- 零运行时依赖：HTTP 走 `node:` 核心模块（https 走 CONNECT 隧道；http 直连用于
  本地 wrangler dev / 本地冒烟桩），不需要 undici/fetch 代理支持
- 凭据零明文：只从 `.env`（或显式注入）读取，诊断只输出“是否配置 + 掩码尾巴”

---

## 目录结构

```
sagitta-memory/
  package.json      # 私有包声明（name=@sagitta/memory）
  lib/
    index.js        # cordis 插件壳：Config/apply + 启动诊断（掩码） + 系统提示词段
    config.js       # 配置解析 + .env 读取（极简 parser，不打印明文）+ 枚举白名单
    http.js         # 极简 HTTP(S) 客户端：https 直连/CONNECT 隧道 + http 直连（本地）
    client.js       # Worker API 客户端：端点映射 + 错误归一化（401/302/409/422…→中文指引）
    tools.js        # 四个工具定义 + 输出渲染 + §4 v1.3 信任轨道系统提示词引导
  worker/
    worker.js        # Cloudflare Worker ES Module
    wrangler.toml    # D1 binding 占位配置
  d1/
    schema.sql       # D1 初始化 schema
    migrate-v12-to-v13.sql
  scripts/
    export-memory.mjs
    import-memory.mjs
  test/
    smoke.mjs       # 验收冒烟：本地桩（真实 worker + node:sqlite D1 适配器）或线上真链路
  README.md
```

## 安装与启用

安装后的插件是普通 cordis 插件：`export { name, inject, Config, apply }`，声明方式与
DSH 自带工具插件完全一致。两条路径任选：

### 路径 A：作为 profile 依赖安装（推荐，与现有插件同构）

1. 把本仓库放到需要的位置。
2. 在 profile（如 `$HOME/.dsh/profiles/web`）里把它加为依赖并安装：

   ```sh
   cd "$HOME/.dsh/profiles/web"
   pnpm add "@sagitta/memory@file:/path/to/sagitta-memory"
   ```

3. 在 `cordis.patch.yml`（profile 的补丁层）追加：

   ```yaml
   - id: memory
     name: '@sagitta/memory'
     config:
       proxy: direct                       # 或显式填写本机 HTTP 代理
       envPath: $HOME/.config/sagitta/memory.env
       timeoutMs: 20000
       # baseUrl 缺省即线上地址；本地实验可指 http://127.0.0.1:8787（wrangler dev，v1.3 起支持 http 直连）
       # accessClientId/accessClientSecret/authToken 一般不填（走 .env）；仅 CI/容器注入时显式给
   ```

4. 重启/重载 DSH Web。启动日志会出现 `sagitta-memory 加载完成` + 凭据诊断（仅掩码）。

### 路径 B：不装包，直接以相对入口挂载

```yaml
- id: memory
  name: ./node_modules/@sagitta/memory/lib/index.js
  config:
    proxy: direct
```

> 任一路径都用同一份代码；区别只在 `name` 的解析方式。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
 | `baseUrl` | `REPLACE_WITH_WORKER_URL` | Worker API 根地址（可指向本地 wrangler dev，http 直连） |
| `proxy` | `direct`（部署包默认） | HTTP 代理（https 走 CONNECT 隧道）；`direct`/空串 = 直连 |
| `envPath` | 由 profile patch 指向 `$HOME/.config/sagitta/memory.env` | .env 路径，读 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` / `AUTH_TOKEN` |
| `timeoutMs` | `20000` | 单请求超时 |
| `accessClientId` / `accessClientSecret` / `authToken` | 缺省走 .env | 显式覆盖（CI/容器注入用；正常本地使用不填） |

环境变量覆盖：`DSH_MEMORY_BASE_URL` / `DSH_MEMORY_PROXY` / `DSH_MEMORY_ENV_PATH` / `DSH_MEMORY_TIMEOUT_MS`。

## 工具与设计 §10 的映射（v1.3）

| 设计 §10 | 插件工具 | 云端端点 | 语义要点 |
|---|---|---|---|
| `remember` | `memory_remember` | `POST /mem/{stream}` | 只提交素材；管理字段（id/created/status/score）服务端生成；**origin 决定初始信任**——`ripple`（涟漪提出的）→ score=2、status=corroborated（先天带信任）；`sagitta`（缺省，AI 自想）→ score=0、status=captured（默认无信任）。参数里没有也不接受直接改 status/score |
| `recall` | `memory_recall` | `GET /mem/{stream}`、`GET /mem/{stream}/{id}`、`POST /mem/search` | 三种模式：`id`（单条，需 `stream`）→ `query`（关键词检索，LIKE，v1 禁 embedding）→ `stream`（列表钻取）；**默认排除 archived/superseded**（除非显式 `status` 过滤）；条目带 `trust_level`/`trust_hint`（服务端按 score 生成）与 `validation_events`（validated 事件，explanation 可作 few-shot） |
| `consolidate` | `memory_consolidate` | `POST /mem/consolidate` | **治理动作集**（v1.3：状态升级已由 ack 自动联动，不再是升级唯一通道）：`validate`（事件化，blind_spot 必填 → 422）、`replace`（整体更换，score 按新 origin 重置，旧内容审计留痕）、`archive`（治理归档，pinned 拒绝）、`digest`/`corroborate`（兜底）；supersedes 挂链；任一失败整体 422 不写入 |
| `verify` | `memory_verify` | `POST /mem/ack`、`GET /mem/delegations/{task_id}`、`GET /mem/{stream}/{id}` | `task_id` → 验证结果复核（validated 已事件化，可经 linked_delegation_id 关联）；`entry_id+signal` → **三态信任信号**登记（explicit +2 / unobjected +1 需 statement_source / oppose −3）；`entry_id` → 现状/信任复查 |

### 信任轨道（§4 v1.3）在本插件的落点

- **插件不产生任何状态转移决策**：score 与 status 都由服务端按信号自动联动——
  这里只提交素材与三态信号（explicit/unobjected/oppose），实现本身没有状态机。
- **分数驱动**：score 钳制 0~3；ack 提交时自动推进 status（score≥1→digested、
  score≥2→corroborated）；**score<0 → 软归档**（status=archived、score=0、
  archived_at=now——涟漪拍板：软归档而非硬删，条目不可正常检索、不作为经验）。
- **origin 初始信任**：`ripple` 提出的条目先天 score=2（可作回忆基线）；
  `sagitta` 自想默认 score=0——AI 自想默认不给信任，必须靠认可爬升。
- **oppose**：涟漪明确反对 = −3；从 score≤2 一次反对即越界归档；
  对 pinned 条目自动机制不归档（分数压到 0 为止，涟漪的“永远记住”优先）。
- **validated 事件化**：不再由 consolidate 门槛堆次数——`validate` 动作写入
  `validation_events`（event_type='validated'）即 validated 事实；**blind_spot
  必填**（该经验未涉及的盲点，缺失服务端直接 422）；explanation 随召回返回，
  可作解释性 few-shot；linked_delegation_id 关联验证结果。
- **replace**（涟漪拍板：经验过时/被相反经验推翻 → 给一个更换指令更新，
  更换把所有描述更换掉，更新后分数按新 origin 重置）：
  content/condition/tags 全换，ripple→score=2 / sagitta→score=0，status 回对应档；
  旧内容写入 replaced 事件**仅审计留痕，不参与 recall**；可把 soft-archived 条目
  改写为相反经验（改写即复活，archived_at 清空）。
- `memory_verify` 的 `unobjected` 信号**必须带 `statement_source`**（本会话中你
  主动陈述过该立场的会话事件引用）；缺省即 422（防后门保留：空缺 ≠ 默许，AI
  无权虚构“我陈述过”）。`delegatee=ripple` 的记录仅限涟漪**实际输入**背书时写入，
  插件不提供任何代填路径。

## 安全纪律

1. **凭据只存在于 `.env` 与进程内存**：`lib/config.js` 读取
   `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` / `AUTH_TOKEN`，代码里没有任何
   默认凭据；插件输出只出现“是否配置”与掩码尾巴（前 2 后 2），**任何路径都不打印
   明文 token**。
2. **Access 令牌是裸值**：`CF_ACCESS_CLIENT_SECRET` 绝不含 `CF-Access-Client-Secret:`
   前缀——带前缀会让 Access 校验失败（实测教训：`service_token_status:false`）。
3. **Bearer 是兜底**：`AUTH_TOKEN` 未配置时插件不发送 Bearer，完全依赖 Access
   服务令牌放行；若部署关闭了 Access，才需要在 .env 补 `AUTH_TOKEN` 后重启。
4. **TLS 全程校验**：隧道模式 `rejectUnauthorized: true`；`--ssl-no-revoke` 是
   Windows curl/schannel 特有坑，Node/OpenSSL 无此问题。
5. **L1 硬规则**：密钥/明文永不写入任何 stream（设计 §7）；公司流条目不含个人
   标识符；recall 默认不跨流混注入。
6. **代理**：部署包默认直连；如目标机必须走本地 HTTP 代理，在 profile patch 或 `.env`
   中设置 `DSH_MEMORY_PROXY`（https 目标）；本地 http 目标
   （wrangler dev / 冒烟桩）走直连，不走代理。

## 验收命令

```powershell
# 1) 语法检查（package.json 已声明 type:module，按 ESM 解析）
cd path/to/sagitta-memory
node --check lib/index.js lib/config.js lib/http.js lib/client.js lib/tools.js
node --check test/smoke.mjs

# 2a) 本地桩冒烟（缺省）：真实 worker.js + node:sqlite 内存库 D1 适配器 + 真实客户端，
#     全链路逐条断言（v1.3 机制全覆盖），纯内存无线上副作用，离线可复现
node test/smoke.mjs

# 2b) 线上真链路冒烟（需已部署 v1.3）：
#     线上部署后由涟漪在 Dashboard 重新粘贴部署 v1.3，再跑：
$env:DSH_MEMORY_SMOKE_TARGET = "online"
node test/smoke.mjs
```

冒烟覆盖（v1.3）：health → 创建（sagitta 缺省 captured/score=0；ripple 先天
score=2/corroborated）→ 单条读回带信任分级 → 检索命中（默认排除 archived/
superseded，显式 status 可查）→ `unobjected` 缺 `statement_source` 422（门禁保留）
→ `explicit` +2 与状态自动联动 → 分数钳制停在 3 → `oppose` −3 触发软归档 →
终态 409 → `validate` 缺 `blind_spot` 422 / 带盲点事件化（召回带事件与 few-shot 解释）
→ `replace` 整体更换 + 分数重置 + 旧内容审计留痕 → 信任提示三档（low 提示/
medium 无提示/high 已固化）→ supersedes 链默认排除 → 错误令牌负例可读中文错误。
退出码 0 = 全过。

## 已知边界（诚实声明）

- **设计 §10 的 `verify` 在服务端没有独立 `/mem/verify` 端点**：本插件用
  “ack 登记 + delegation 复核 + 条目现状复查”三合一来实现 §10 语义，与 Worker
  实际契约一致；不要期待 `/mem/verify` 路径。
- **replace/archive 的审计事件（replaced/archived）不随 recall 返回**（涟漪拍板：
  留痕不参与 recall）；召回条目只带 validated 事件。审计留痕可经 consolidate
  响应（replace 回显 old_content）或 D1 Console 查 `validation_events` 表。
- 设计 §3 的 `source` 字段在 v1.2 起未存在于 schema/worker 的 INSERT 列：
  插件不发送该字段，README 以 Worker 契约为准。
- 插件不实现本地写队列（设计 P2：断网排队回放）——失败时给出可读中文错误，
  调用方自行决定重试时机。

## Worker 与 D1

`worker/worker.js` 是 Cloudflare Worker 的 ES Module 源码，`worker/wrangler.toml` 只包含
D1 binding 的占位 `database_name` 和 `database_id`。部署前请在本地或 CI 中替换占位项，
并通过 Cloudflare Secret 注入 `AUTH_TOKEN`；不要把真实值写回仓库。

初始化全新 D1 时执行 `d1/schema.sql`；已有 v1.2 数据库按 `d1/migrate-v12-to-v13.sql`
逐条迁移。详细端点和 Dashboard 步骤见 [`worker/README.md`](worker/README.md)。

## 导入与导出

导入导出脚本位于 `scripts/`，使用 `--env-file` 指向私有 `.env` 文件。导出的 JSONL
记忆内容和导入映射属于敏感数据，已由 `.gitignore` 排除：

```sh
node scripts/export-memory.mjs --env-file /private/path/memory.env --out /private/path/memory.jsonl
node scripts/import-memory.mjs --env-file /private/path/memory.env --in /private/path/memory.jsonl
node scripts/import-memory.mjs --env-file /private/path/memory.env --in /private/path/memory.jsonl --apply
```

配置模板见 [`.env.example`](.env.example)。模板只列变量名，不包含任何凭据。
