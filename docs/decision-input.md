# sagitta-agent 拍板输入包（六项）

> 涟漪 2026-08-29 拍板清单的决策材料。每项给出：现状实证 / 选项 / 推荐。
> 本文件只整理事实与选项，**不替涟漪拍板**。

---

## 拍板① D1 read/write token 语义

**现状实证**（自 sagitta-memory 迁移、v1.3 契约实测）：
- memory 插件现有认证：`CF-Access-Client-Id` + `CF-Access-Client-Secret`（Access 服务令牌对）→ Worker 在 Access 网关后放行（实测 `service_token_status:false` 教训：secret 绝不含 `CF-Access-Client-Secret:` 前缀）。
- `AUTH_TOKEN`（Bearer）仅作为 Worker 代码层兜底；未配置时不发送。
- Worker 侧路由：`/mem/health`、`/mem/{stream}`（POST recall/consolidate/verify）、`/mem/search`、`/mem/{stream}/{id}`（GET/PUT/DELETE）。

**选项**：
- A. 保持 Access 双 key 语义 → manager 的 `d1ReadToken`/`d1WriteToken` 仅作重命名，实际仍发 `CF-Access-Client-Id/Secret`（只读/写各一套 Access token 对）。
- B. 改用纯 Bearer（Worker secret `AUTH_TOKEN` 拆成 read/write 两个）→ manager 两字段直映射 `Authorization: Bearer`；Worker 侧需加 secret 匹配改造（当前 v1.3 worker 没有分离的 read/write Bearer）。
- C. 混合（推荐）：**manager 的 `d1ReadToken`/`d1WriteToken` 语义 = 该操作使用的认证凭据；具体发送形态（Access 对 vs Bearer）由 memory 插件现有 `buildAuthHeaders` 契约决定**——即"两字段 = 操作级授权边界"语义，不绑定协议细节。这样 Worker 从 Access-only 演进到 Bearer-only 时 manager 配置不变，只是插件发送头变化。**涟漪需确认的仅一点：当前使用 Access 双 key 形态还是已切换到 Bearer 形态**（若仍 Access，则两字段就是 read/write 两套 Access token；若已切 Bearer，则是 read/write 两个 Bearer）。

**推荐**：C。两字段=操作级授权边界，协议形态交给插件现有契约，不臆造新协议。

---

## 拍板② Worker 部署元数据位置

**现状实证**：deploy-worker.ps1 已实现 direct PUT（`https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{name}`，Bearer upload token，实测可行）；wrangler fallback。所需元数据：`CF_ACCOUNT_ID` + script name（+ 可选 `SAGITTA_WORKER_API_URL` 供 health check）。

**选项**：
- A（现状，推荐）：放 `worker/reference/account.example.json` + 环境变量（`CF_ACCOUNT_ID`/`CF_SCRIPT_NAME`）→ 部署脚本读环境。仓库零真实标识符；用户在本机 `.env`/环境变量填。
- B：进 manager settings 新增可见字段（`CF_ACCOUNT_ID`、script name）→ 统一收口但把"部署元数据"与"D1 访问凭据"混在一个配置页，且不是 secret 也占 secret 脱敏通道。
- C：半混合（推荐补充）：account+script name 走环境变量（A），但 `SAGITTA_WORKER_API_URL`（health check 目标，非 secret）可进 manager `workerApiUrl` 字段——**它本来就已存在**（涟漪第 5 条要的 worker api 字段）。即涟漪第 5 条已覆盖 health 目标，无需新增字段。

**推荐**：A + C 组合（保持 A 现状；workerApiUrl 复用既有字段；不为部署元数据新开 settings 字段）。

---

## 拍板③ 重启语义

**现状实证**：DSH 无已坐实整树重启公共 API（Cordis 有单 Fiber `restart()`，但 DSH 对外只有进程 shutdown）；manager 卡片已有"保存并重启"按钮 → 内部 adapter 尝试整树重启桥，未验证则降级"配置已保存，请手动重启 DSH（`dsh --profile web`）"。updater 同步 preset/插件后同样提示手动重启。

**选项**：
- A（推荐，现状）：接受"保存后提示手动重启"为长期行为——适配器层保留，未验证桥时降级提示。
- B：涟漪内部有重启入口（如 `dsh --restart` / Ctrl+R 之类）→ 告诉我具体命令，适配器接上，按钮变成真重启。

**推荐**：A；若涟漪有内部入口，B 一行接入（涟漪只要告诉我命令即可）。

---

## 拍板④ 自启动范围

**现状实证**：updater 插件随 DSH 加载（patch `sagitta-updater`），`queueMicrotask` 异步开机编排（不影响 DSH 启动）。目前"自启动"= 随 DSH 进程启动。

**选项**：
- A（推荐）：仅随 DSH 启动——涟漪手动开 DSH 时 updater 跑；不开不跑。行为明确、无系统级改动。
- B：加 Windows 登录自启（注册表 Run / 启动文件夹跑 `dsh --profile web`）→ 每登录即开 DSH+updater，但涟漪可能不想要"登录必弹 DSH"。
- C：折中——提供可选脚本 `scripts/install-autostart.ps1`（默认不开，涟漪想要时手动跑）。

**推荐**：A + C 可选（脚本就绪、默认不启用）。涟漪决定用不用。

---

## 拍板⑤ task API 契约（TASKS.md 退场时机）

**现状实证**：TASKS.md 是涟漪日常动态事实源（现位于 `D:\workspace\sagitta-experience\TASKS.md`），auto-advance `tasksPath` 与 preset persona「会话开始先读 TASKS.md」均指向它。**已修复断链**：`<SAGITTA_TASKS_FILE>` 第五变量（默认指向 experience 活文件），拍板⑤前不把动态任务文件进仓库（否则 updater 开机 git pull 冲突 + persona 断链，三重断链已修）。

**选项**：
- A（现状过渡）：保持 TASKS.md 文件事实源 + `<SAGITTA_TASKS_FILE>` 变量；涟漪照旧编辑文件，面板/会话照旧读。
- B（拍板目标）：task 上云——manager 持 workerApiUrl+d1Read/write，task 资源模型（D1 表 `tasks` 或复用 `entries`？）+ API 路由（`/task/...`）+ auto-advance 改读 API + persona 指令改「从 task API 拉」。TASKS.md 退场为归档/导出。
- C：A/B 并行过渡期——TASKS.md 继续可编辑，auto-advance 优先 API、API 缺失 fallback 文件（`taskFallback: true` 已有）。

**推荐**：先拍 B 的资源模型与路由契约（进入 P1 设计），执行时走 C 过渡（API 优先、文件 fallback 保底）。**涟漪最省事的拍板点：说一句"task 要上云，D1 建 tasks 表，路由 /task"，其余我来设计。**

---

## 拍板⑥ 包名 memory-plugin vs memory

**现状实证**：仓库 plugins/memory 的 package.json `name: @sagitta/memory-plugin`（v1.2.0）；profile 依赖 `@sagitta/memory-plugin`；patch id 用 `memory`（cordis id，与包名独立）。auto-advance = `@sagitta/auto-advance`、manager = `@sagitta/manager`、updater = `@sagitta/updater`——后三者都是裸名，只有 memory 带 `-plugin` 后缀，命名不一致。

**选项**：
- A（推荐）：更名为 `@sagitta/memory`（与另三插件裸名一致）。兼容处理：install/脚本两处依赖名同步改；旧 `@sagitta/memory-plugin` 若本机 profile 已装，重装即切新名（updater 副本/sync 已对账）。
- B：保留 `@sagitta/memory-plugin`（现状）——命名不齐但零迁移成本。

**推荐**：A。命名一致性成本小（install-profile-deps 幂等切换），涟漪一句话即可，我完成全部改名+副本切换。

---

## 汇总（涟漪最小动作清单）

| # | 涟漪最小拍板动作 | 我随后执行 |
|---|---|---|
| ① | 说一句当前 D1 认证是 Access 双 key 还是 Bearer | 两字段语义定稿 + 冒烟断言更新 |
| ② | 认可 A+C（环境变量+workerApiUrl 复用）\| 反对则说方案 | 无需改代码（已实现） |
| ③ | 说"接受手动重启"\| 或给我内部重启命令 | 接受则保留现状；命令则 adapter 一行接入 |
| ④ | 说要不要登录自启（默认不做） | 要则写 install-autostart.ps1 |
| ⑤ | 说"task 上云，D1 建 tasks 表，路由 /task" | P1 设计 + C 过渡 |
| ⑥ | 说"改名 @sagitta/memory"\|"保留" | 改名+全链路切换 |