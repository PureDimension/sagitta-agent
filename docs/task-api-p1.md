# Task API P1 设计草案（拍板⑤ 执行输入）

> 涟漪 2026-08-29 拍板⑤ 的落地草案。涟漪只需确认"照此执行"或指定修改点。
> 现状基线：TASKS.md 活文件（experience）+ `<SAGITTA_TASKS_FILE>` 模板变量 + auto-advance `tasksPath` + updater 开机 pull。本草案把"任务事实源"从文件迁到 manager-backed API。

---

## 1. 资源模型（D1 `tasks` 表）

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,                -- 生成: tsk-YYYYMMDD-<hex6>
  project       TEXT NOT NULL,                   -- 所属项目（对应 TASKS §1A/1B 分类）
  title         TEXT NOT NULL,                   -- 条目一行描述
  status        TEXT NOT NULL DEFAULT 'open',    -- open | in_progress | blocked | waiting | done
  priority      INTEGER NOT NULL DEFAULT 0,      -- 0 普通 / 1 高 / 2 紧急
  checkbox      INTEGER NOT NULL DEFAULT 0,      -- 1=该条是涟漪待处理 checkbox
  stream        TEXT NOT NULL DEFAULT 'company', -- personal-projects | company-projects | sagitta | ripple（对齐记忆四流）
  body          TEXT DEFAULT '',                 -- 内嵌描述/notes
  created_at    TEXT NOT NULL,                   -- ISO8601 UTC
  updated_at    TEXT NOT NULL DEFAULT '',        -- ISO8601 UTC
  done_at       TEXT DEFAULT '',
  archived      INTEGER NOT NULL DEFAULT 0       -- 1=归档（软删，recall 默认排除同 memory 契约）
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_stream   ON tasks(stream);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
```

对齐记忆库 v1.3 契约：`id`/`status`/`archived`/`stream` 四语义与 memory 的 `entries` 一致（召回默认排除 archived）；`checkbox` 对应悬浮窗"待处理需求"区块。

## 2. REST 路由（复用现有 `/mem` 基座与鉴权）

前缀 `/task`（与 `/mem` 平级，同一 Worker）：

| 方法 | 路径 | 用途 | 需要的 D1 token |
|---|---|---|---|
| GET  | `/task?project=&stream=&status=` | 列表（默认排除 archived；status 过滤可选） | read |
| POST | `/task` | 新建（body: project/title/status/priority/checkbox/stream/body） | write |
| GET  | `/task/{id}` | 单条 | read |
| PATCH| `/task/{id}` | 更新 status/priority/body/title/checkbox（部分更新） | write |
| DELETE| `/task/{id}` | 软删 → archived=1（不真删，保审计） | write |
| POST | `/task/search` | 关键词 LIKE（与 /mem/search 同风格） | read |

响应与 memory 同构：`{ok:true, data:{...}}` / `{ok:false, error:{code,message}}`（中文指引风格一致）。

## 3. 鉴权与 manager 契约（无新配置）

- 复用 manager 四字段：`workerApiUrl`（根）+ `d1ReadToken`（读类 GET/search）+ `d1WriteToken`（写类 POST/PATCH/DELETE）。
- 发送形态沿用 memory 现有 `buildAuthHeaders`（Bearer read/write 分流，拍板①结论后统一）。
- **零新配置字段**——涟漪第 5 条的三个 API 已全覆盖。

## 4. 接入改造（涟漪第 6 条：task 直接从 manager 读 API）

| 组件 | 改动 |
|---|---|
| auto-advance service | `tasksPath` 文件模式保留为 fallback；新增 `apiUrl` 模式：读 `ctx['sagitta-manager'].getApiConfig()` → workerApiUrl+d1Read/d1Write → `GET /task?checkbox=1&status=open` 拉待处理需求。`taskFallback: true` 已有：API 不可达/未配置时回退文件 |
| updater | 无改动（它只同步 preset/插件/worker；task API 是数据面，不做数据面推数据） |
| 记忆 manager | 无改动（memory 已接 manager） |

## 5. TASKS.md 退场时序（涟漪第 7 条衔接）

- **阶段 C1（过渡）**：API 上线 + auto-advance 优先 API、文件 fallback；TASKS.md 继续可编辑（persona 指令改"任务从 API 拉，TASKS.md 仅作离线导出/归档"）。
- **阶段 C2（归档）**：C1 稳定运行 N 天后，TASKS.md 降级为只读归档导出（`export-tasks.ps1`：D1 tasks → TASKS.md 格式），`tasksPath`/`<SAGITTA_TASKS_FILE>` 从模板移除。**涟漪确认 C2 时机**（建议：API 连续 7 天无故障后）。

## 6. worker 参考实现改动点

- `worker/worker.js`：新增 `/task` 路由块（复用 `/mem` 的 JSON 解析/D1 绑定/错误壳）+ `tasks` 表 DDL 放 `worker/schema.sql`（同库追加 CREATE TABLE IF NOT EXISTS tasks）。
- 迁移人工 gate（同现有纪律：updater 不隐式执行 DDL）。

## 7. 验收

1. `node --check` worker.js；`/task` 路由冒烟（本地 HTTP 桩 + mock manager，双侧 read/write Bearer 断言）
2. auto-advance smoke：API 可用 → 需求来自 API；API 不可用 → fallback 文件（两态断言）
3. 远端：真机部署后 `curl /task?stream=sagitta` 返回 `{ok:true,data:[]}`

## 涟漪最小拍板动作

> 说一句："**照 task-api-p1.md 执行，C1 过渡、C2 等 7 天无故障再定**" 即可；要改资源字段/路由前缀则在回复里点名。