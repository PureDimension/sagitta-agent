# Sagitta Worker 参考实现

本目录的参考实现来自 `D:\workspace\sagitta-memory`：

- `worker.js`：Cloudflare Worker ES Module 实现，原样迁移。
- `schema.sql`：D1 全新数据库初始化结构，原样迁移。
- `migrations/`：已有 v1.2 数据库升级脚本。

## 本地部署

从仓库根目录执行：

```powershell
Copy-Item .\worker\wrangler.toml.example .\worker\wrangler.toml
```

编辑 `worker/wrangler.toml`，将其中全部 `REPLACE_WITH_...` 占位符替换为本地实际配置；该文件已被 `.gitignore` 忽略，不要提交真实 Cloudflare 标识。然后执行：

```powershell
pwsh -NoProfile -File .\scripts\deploy-worker.ps1 `
  -Mode Wrangler `
  -WranglerConfigPath .\worker\wrangler.toml
```

配置 `worker/.dev.vars` 时，可从 `.dev.vars.example` 复制并填写本地变量；不要提交 token 或其他凭据。

新建 D1 数据库时，人工执行 `schema.sql` 初始化表结构。已有 v1.2 数据库才需要人工执行 `migrations/migrate-v12-to-v13.sql`；迁移脚本只允许人工执行一次，部署脚本不会自动执行 migrations。

`wrangler.toml.example` 使用 `main = "worker.js"`，与本目录布局一致。部署前可运行：

```powershell
node --check .\worker\worker.js
```

## 任务认领制（task-ownership-p2，阶段 1：Worker 侧）

设计稿：`docs/task-ownership-p2.md`（commit 69944a8）。tasks 表新增四列（可空，惰性迁移）：

- `owner_agent_id`：认领者 agent id——**永不下发**（owner 对模型无感知）
- `claimed_at`：认领时间（ISO8601 UTC），租约起点
- `claim_token`：认领凭证，**只在 claim 成功响应下发一次**（列表/详情剥离）
- `lease_seconds`：认领租约秒数（1~604800，claim body 逐认领持久化；null = 全局默认 24h）

### 认领 POST /task/{id}/claim

单条条件 UPDATE 原子认领（不可先读后写；过期判定在 SQL 内按行内租约 `COALESCE(lease_seconds, 86400)` 计算）：

- `status='open'`，或 `in_progress` 且 owner 过期/为空 → 置 `in_progress` + owner + token + lease_seconds
- body 可选 `lease_seconds`（1~604800 秒，默认 24h）：持久化到该行，读取/接管均按此判定过期；未传存 NULL
- 调用方标识从请求头取（`X-Agent-Id`，可经 `TASK_AGENT_ID_HEADER` 配置；缺省 `unknown`）
- 被占用未过期 → `409 TASK_ALREADY_CLAIMED`；pending 任务 → `409 TASK_PENDING_CONFLICT`

### 释放 POST /task/{id}/release

body 必填 `claim_token`；token 匹配 → 清空 owner/claimed_at/claim_token/lease_seconds，`in_progress` 且无 pending 时 status 回 `open`；不匹配 → `403 CLAIM_TOKEN_MISMATCH`。

### 惰性回收与终态释放

- 读取/PATCH/claim 时按行内租约判定过期 = 未认领（null 用全局默认 24h）；不做定时清理，进程退出后租约自然过期
- 终态自动释放：confirm accept（done/blocked）与 PATCH 到 waiting/open 清除 owner（含 lease_seconds）；round-close 与 pending 申请不影响 owner
- PATCH `status=in_progress` 防绕过认领：他人认领（租约内）→ `409 TASK_ALREADY_CLAIMED`；owner 本人（X-Agent-Id 匹配）或未认领允许
- 存量 `in_progress` 无 owner → 视为未认领，任意调用方可接管

### 已知限制

- **'unknown' 调用方不可区分**：PATCH 防绕过依赖 X-Agent-Id 与 owner 匹配；不带该头时标识缺省 `'unknown'`，两个无头调用方之间无法区分（owner 本人无头 PATCH in_progress 会被 409，需带头或走 claim 路由）——保持现状，由上层（auto-advance）约定统一携带 X-Agent-Id
