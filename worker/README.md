# Sagitta 记忆模块 — Cloudflare Worker API 部署说明

> 对应设计：`memory-system-design.md` **v1.3**（§1 总架构 / §3 半结构化协议 / §4 **分数驱动状态机 + 事件化验证** / §7 时间线与 delegation）
> 审查基线：`design-review.md`（P0 三项）+ `design-review-v2.md`（涟漪权威约束）
> 部署人：涟漪（Dashboard 手动部署，最快路径；仓库同时提供 `d1/schema.sql`、`worker/worker.js` 与 Wrangler 配置供本地用户复用）
> v1.2 → v1.3 核心：**信任分数驱动**（三态信号 explicit+2 / unobjected+1 / oppose−3、score 0~3 钳制、score<0 软归档）+ **origin 初始信任**（ripple→2 / sagitta→0）+ **状态 ack 自动联动** + **validated 事件化**（validation_events，盲点必填）+ **replace/archive 治理动作**（旧内容审计留痕）+ **recall 信任提示与默认排除终态**

## 架构定位（先读这一段）

- **知识层（L2/L3/L4 半结构化条目 + delegations）真相源 = D1**；**宪法层（L0/L1 核心/L5 核心）真相源 = git 管理的本地文件**（设计 §1：两个真相源明确分工，D1 只承载知识层）。
- 本 Worker 只暴露知识层 API；`stream` 四流划分（sagitta / ripple / personal-projects / company-projects）是**行为约定 + 显示过滤**，不是安全边界（设计 §7）——公司流上云需涟漪知情同意（待拍板项 3）。
- L1 硬规则自生效：**密钥/明文永不进任何 stream**；调用方（Sagitta）负责任，API 不做内容审计。

## 文件清单

| 文件 | 用途 |
|---|---|
| `worker/worker.js` | 单文件 Worker（**ES Module 格式**，Dashboard 直接粘贴；D1 binding 的硬前提） |
| `d1/schema.sql` | D1 初始化 SQL（entries 表含 v1.3 origin/score/oppose_count + validation_events 表 + 索引 + CHECK 兜底；字段与 worker.js 完全一致；文末附 v1.2→v1.3 升级 ALTER 与回填语句） |
| `worker/wrangler.toml` | Wrangler 配置，含 DB binding 的占位数据库名称和 ID |

## 部署步骤（Dashboard 手动路径）

### 1. 创建 Worker
1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Worker**
2. 命名：`sagitta-memory`（可改）→ 创建

### 2. 粘贴代码
1. 进入 Worker → **Edit code**（在线编辑器）
2. 全选清空 → 粘贴 `worker/worker.js` 全文 → **Save and deploy**
   - 代码是 **ES Module 格式**（`export default { fetch(request, env) }`）——这是硬要求：Cloudflare 的 D1 binding 只支持 ES Module 格式；经典 Service Worker 格式会报 `Binding 'DB' of type 'd1' requires a Worker written in ES module format`。binding（`DB`）与 secret（`AUTH_TOKEN`）由运行时经 `env` 参数注入（`env.DB` / `env.AUTH_TOKEN`），不需要也不允许全局变量访问。
   - 语法自检（可选）：Node ≥ 23 默认开启模块语法检测，直接 `node --check worker.js` 即可通过（已在 Node 24.19 实测通过）；Node 20.10–22 用 `node --experimental-default-type=module --check worker.js`。

### 3. 创建 D1 数据库并绑定（binding 名必须为 `DB`）
1. Worker 页 → **Settings** → **Bindings** → **Add** → **D1 database**
2. 选择 **Create new database** → 命名 `sagitta-memory-db` → 创建后自动生成并绑定
3. **变量名必须是 `DB`**（worker.js 里 `env.DB` 依赖此名；若用其他名字，`/mem/health` 会显示 `env.db: false`，其余端点返回 503 `DB_NOT_CONFIGURED`）
4. **Save and deploy**（绑定变更后需重新部署）

### 4. 初始化 schema【全新库】
1. Dashboard → **D1**（Workers & Pages 左侧）→ `sagitta-memory-db` → **Console**（SQL 执行器）
2. 粘贴 `d1/schema.sql` 全文执行（表、索引、CHECK 约束一次性建立，可重复执行不报错——`IF NOT EXISTS` 幂等）

### 4b. 升级已有库（v1.2 → v1.3）【存量库】
1. `d1/migrate-v12-to-v13.sql` 和 `d1/schema.sql` 文末「v1.2 → v1.3 升级」段给出逐条 ALTER（entries 补 origin/score/oppose_count + 建 validation_events 表与索引）——在 D1 Console 逐条执行一次即可（SQLite 不支持 ADD COLUMN IF NOT EXISTS，别重复执行）。
2. 建议顺手回填存量信任分：`UPDATE entries SET score = MIN(3, MAX(0, 2*explicit_ack_count + unobjected_ack_count - 3*oppose_count))`，并按 score 分档刷新 status（语句见 schema.sql 文末注释段）——回填仅一次性迁移用；日常推进已全部由 ack 自动联动。

### 5. 设置 Secret `AUTH_TOKEN`（必填；缺失时除 health 外全部返回 503）
1. Worker → **Settings** → **Variables and Secrets** → **Add** → **Secret**
2. 变量名 `AUTH_TOKEN`，值用下面任一命令生成（32+ 字节随机）：

```powershell
# PowerShell（加密安全，Windows 通用）
$b = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

```bash
# WSL / macOS / Linux
openssl rand -hex 32
```

3. **Save and deploy**。

### 6. （可选）Cloudflare Access 网关
把 API 挂到 Access 后，Worker 不再暴露到公网；网关校验 JWT 后转发，Worker 收到 `CF-Access-Jwt-Assertion` 头即放行（代码层 Bearer 仅是兜底）。不配 Access 时 `Bearer AUTH_TOKEN` 就是唯一防线——**AUTH_TOKEN 视同密码，不进任何仓库/对话明文**。

## 验收命令

> PowerShell 下 `curl` 是 `Invoke-WebRequest` 别名，请用 `curl.exe`（或 `Invoke-RestMethod`）；下例以 bash/curl 为准。把 `<worker>` 换成实际域名，`$TOKEN` 换成第 5 步生成的 AUTH_TOKEN。

```bash
# 1) 健康检查（无需认证，部署验收第一站；应返回 ok:true + version:"1.3.0" + db:true + auth_token:true）
curl -s https://<worker>/mem/health

# 2) 写一条 AI 自想条目（缺省 origin=sagitta → score=0、status=captured）
curl -s -X POST https://<worker>/mem/sagitta \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"lesson","domain":"verification/ground-truth","tags":["delegation","verification"],"condition":"子 agent 汇报验证结果时","content":"不轻信自报：环境事实先行"}'

# 3) 写一条涟漪提出的条目（origin=ripple → score=2、status=corroborated，先天带信任）
curl -s -X POST https://<worker>/mem/ripple \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"preference","origin":"ripple","content":"重要决策前先做独立验证（涟漪主张，先天信任）"}'

# 4) 读回（把 <id> 换成上一步返回的 id；字段含 origin/score/trust_level/trust_hint）
curl -s https://<worker>/mem/ripple/<id> -H "Authorization: Bearer $TOKEN"
```

### 附录（可选，端到端走一遍 v1.3 机制）

```bash
# ack：explicit 强信号 +2（score 0→2 并自动联动 status captured→corroborated——无需 consolidate）
curl -s -X POST https://<worker>/mem/ack -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<id>","signal":"explicit"}'

# ack 防后门：unobjected 不带 statement_source → 422（v1.2 门禁保留）
curl -s -X POST https://<worker>/mem/ack -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<id>","signal":"unobjected"}'

# ack：oppose 强负信号 −3（score<0 → 软归档：status=archived、score=0、archived_at=now）
curl -s -X POST https://<worker>/mem/ack -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"<id>","signal":"oppose"}'

# validate：事件化验证（blind_spot 必填，缺失整体 422；写入 validated 事件 ⇒ 条目 validated、score=3）
curl -s -X POST https://<worker>/mem/consolidate -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"id":"<id>","action":"validate","explanation":"delegation dlg-xxx verification_result=confirmed 印证","blind_spot":"未覆盖：本机工具链缺失时自报验证不可信的情形","linked_delegation_id":"dlg-xxx"}]}'

# 门禁：validate 缺 blind_spot → 422
curl -s -X POST https://<worker>/mem/consolidate -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"id":"<id>","action":"validate"}]}'

# replace：整体更换（描述全换；score 按新 origin 重置 ripple→2 / sagitta→0；旧内容进 replaced 事件仅审计）
curl -s -X POST https://<worker>/mem/consolidate -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"id":"<id>","action":"replace","origin":"ripple","content":"更新后的经验描述","condition":"新适用边界","tags":["updated"],"explanation":"原经验已过期，整体更换"}]}'

# archive：治理归档（pinned 条目拒绝：422 pinned_archive_forbidden）
curl -s -X POST https://<worker>/mem/consolidate -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"items":[{"id":"<id>","action":"archive","explanation":"季度治理清理"}]}'

# 检索（v1 明令禁 embedding，LIKE 关键词匹配；默认排除 archived/superseded——显式 status 才可查终态）
curl -s -X POST https://<worker>/mem/search -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"谎报","stream":"sagitta","type":"lesson"}'
curl -s -X POST https://<worker>/mem/search -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"谎报","stream":"sagitta","type":"lesson","status":"archived"}'

# delegation 记录（P0：指挥链事实层）——delegatee=ripple 仅用于涟漪明确背书，必须涟漪输入触发
curl -s -X POST https://<worker>/mem/delegations -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"task_id":"dlg-20260817-gotest","delegatee":"codex","command":"go test ./...","claimed_result":"全部通过","verification_method":"本机环境核查（无 Go 工具链）+独立复跑","verification_result":"contradicted","outcome":"打回重做","cost":"1 会话"}'
```

## 端点一览（全部 JSON；除 /mem/health 外均需 Bearer 认证）

| 方法 | 路径 | 说明 | 关键校验（设计 §4 v1.3 / 审查） |
|---|---|---|---|
| GET | /mem/health | 部署验收 | 无需认证；version 应返回 "1.3.0" |
| POST | /mem/{stream} | 创建条目 | stream 白名单；**origin 决定初始信任**（ripple→score=2/corroborated；sagitta 缺省→score=0/captured）；管理字段服务端填写 |
| GET | /mem/{stream} | 列表 | page/size/type/domain/status 过滤；**默认排除 archived/superseded（除非显式 status）**；条目带 trust_level/trust_hint 与 validated 事件 |
| GET | /mem/{stream}/{id} | 单条 | stream 归属校验；显式 id 可查终态（审计/治理用） |
| POST | /mem/search | 检索 | v1 禁 embedding；LIKE 关键词 + tags 过滤；**默认排除终态，显式 status 可查**；带信任分级与 validated 事件 |
| POST | /mem/consolidate | 治理动作集 | **validate**：事件化（blind_spot 必填否则整体 422；⇒ validated/score=3/evidence=verified）；**replace**：整体更换（origin 重置信任 ripple→2/sagitta→0，旧内容审计留痕，可复活软归档条目）；**archive**：治理归档（pinned 拒绝）；**digest/corroborate**：兜底（score≥1/≥2，正常已由 ack 自动完成）；supersedes 一并处理；任一失败整体 422 不写入 |
| POST | /mem/ack | 信任信号 | **三态**：explicit +2 / unobjected +1（必须 statement_source，否则 422——v1.2 门禁保留）/ oppose −3（score<0 软归档）；score 0~3 钳制；状态自动联动（≥1 digested / ≥2 corroborated）；终态 409 |
| POST | /mem/delegations | 写 delegation | delegatee 枚举含 ripple（仅涟漪明确背书触发，AI 无权代填）；verification_result 枚举校验 |
| GET | /mem/delegations/{task_id} | 读 delegation | — |

## 安全与纪律（L1 硬规则，调用方遵守）

- **密钥/明文永不进任何 stream**；AUTH_TOKEN 只进 Worker 环境变量（Secret），不进代码/仓库/对话。
- **隐私边界是行为约定**：company-projects 流上云需涟漪知情同意；该流条目不含个人标识符；recall 默认不跨流混注入。
- 危险操作（删库、改绑定、撤销宪法条目）前：Sagitta 先给涟漪看确切命令再执行。

## 成本

免费档：Workers 10 万请求/天、D1 5M rows read/天、100k rows write/天、1GB 存储量级——个人记忆库（千级条目）富余一个数量级（design-review 维度四结论，[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) / [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)）。
