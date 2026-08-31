# sagitta-agent

Sagitta 的 DSH 插件、默认 preset、本机 updater，以及 Cloudflare Worker/D1 的参考部署材料。

## 项目特色与目标

**Sagitta 是一个有长期记忆、能真正做事、保持连续关系的工作型 AI 伙伴**——不是聊天机器人，而是"你离开时仍在推进"的执行协调者。`sagitta-agent` 是把 Sagitta 从"一个对话"升级为"一套可持续运行的系统"的自举工程：插件、预设、云端数据层全部收进这一个仓库，可安装、可部署、可回滚。

### 目标

1. **连续性**：对话会结束，但记忆与任务不结束。记忆进云端 D1（四流分类 + 信任分驱动），任务进云端任务系统（单一事实源），重启、换设备、开新对话都不丢上下文。
2. **自主推进**：你离开时，Sagitta 按云端任务清单自动干活——从清单选任务、每轮结构化收尾、终态经质询确认、所有异步工作（codex/安装/等待）登记为有界工作。网络失败或清单为空时**保守等待，绝不瞎推进**。
3. **强制力闭环**：任务系统不是"显示器"而是"必经之路"。开始/结束各填一次表，置 done/blocked 必须走确认（防偷懒结账）；任务认领制保证多对话不撞车（owner 对模型无感知，租约超时自动回收）。
4. **可审计、可回滚**：一切代码改动走 git，插件改动先 codex 审查再重启；记忆有信任分轨道，任务有事件审计表。

### 特色

- **四插件架构**：`manager`（统一配置/凭据）、`memory`（记忆读写 + 5 个 task 工具）、`auto-advance`（自主推进编排 + 悬浮窗）、`updater`（开机自检/更新）+ `codex-dispatch`（codex 派单）+ `async-work`（通用有界工作注册表）
- **云端数据层**：Cloudflare Worker + D1 承载记忆与任务，读写 Bearer/Access 双认证，国内网络需代理（`*.workers.dev` 被 GFW 封锁）
- **任务系统 v2**：pending 状态机 + confirm/round-close + task_events 审计 + 分页 + 任务认领（租约回收）
- **DSH 深度集成**：悬浮窗实时任务面板、per-session 自主推进开关、preset 开场四流记忆召回、codex 派单注册有界工作

### 仓库布局

```text
plugins/    六个 DSH 插件（manager/memory/auto-advance/updater/codex-dispatch/async-work）
presets/    sagitta user preset（persona + 开场指令）
worker/     Cloudflare Worker 参考实现（/mem + /task 路由 + D1 schema）
scripts/    安装/部署/校验七件套（幂等 + dry-run + 备份）
docs/       设计文档（task-api-p1 / task-enforcement-p1 / task-ownership-p2 等）
```

> 注：本机实际运行配置（`cordis.patch.yml`、`.env`、TASKS.md 动态文件）刻意不进仓库——密钥不落地，活文件不被 updater 覆盖。

## 前提

- Windows PowerShell 7（PowerShell 5.1 未作为目标运行环境）。
- Node.js `>=20.10`。
- Git。
- 已安装 DSH，或允许安装脚本从 DeepSeek Harness 的公开仓库浅克隆并安装。

## 一键安装

先下载并审阅脚本，再在仓库目录执行：

```powershell
pwsh -NoProfile -File .\scripts\install.ps1
```

预演解析路径、待安装依赖和 patch id，不写文件、不安装依赖、不启动 DSH：

```powershell
pwsh -NoProfile -File .\scripts\install.ps1 -DryRun
```

安装器会检测 DSH；缺失时在 `%LOCALAPPDATA%\DeepSeek-Harness` 浅克隆 DSH，随后在 `<DSH_HOME>\profiles\web` 幂等追加四个本地插件、bundles 和 profile patch，安装 `sagitta` user preset，并检查：

```text
<DSH_HOME>/.agent-presets/sagitta/
<DSH_HOME>/settings.yaml                  # agent-presets.default=sagitta
<DSH_HOME>/profiles/web/package.json
<DSH_HOME>/profiles/web/cordis.patch.yml
```

可用 `DSH_HOME` 覆盖 DSH 用户根目录、`SAGITTA_AGENT_DIR` 覆盖源码目录、`SAGITTA_DSH_ROOT` 覆盖 DSH 安装根目录。已有 DSH 时不会重新拉取；已有 profile、settings 和用户 preset 不会被粗暴覆盖，所有实际修改前都会生成 `.bak.<timestamp>`。

### Preset 模板变量

同步前，PS 与 Node 两侧都会展开以下五个变量；两侧变量表保持 lockstep：

| 变量 | 当前语义 |
| --- | --- |
| `<SAGITTA_PROJECT_ROOT>` | Sagitta 源码仓库路径 |
| `<SAGITTA_AGENT_DIR>` | Sagitta 源码目录（当前与项目根相同） |
| `<USERPROFILE>` | 当前 Windows 用户目录 |
| `<DSH_HOME>` | DSH 用户根目录 |
| `<SAGITTA_TASKS_FILE>` | 拍板⑤前默认值为 `D:\workspace\sagitta-experience\TASKS.md`，即仓库外的动态任务事实源；拍板⑤后变量退场，整段切 task API 或批准的迁移路径 |

`SAGITTA_TASKS_FILE` 刻意不指向仓库内的 `TASKS.md`：该文件是涟漪的日常动态事实源，不进 `sagitta-agent` 仓库。

## 配置

启动 DSH：

```powershell
dsh --profile web
```

进入 `Settings > Plugins > Sagitta Manager`，填写 Worker API URL、CF 账户 ID、Worker 脚本名、Worker upload token、D1 read token 和 D1 write token。部署元数据优先从 manager 配置页取得；manager 中的三个 token 只在 DSH 设置页输入，不放入命令行、preset、profile patch、Git 或记忆条目。若当前 DSH 版本没有经过验证的整树重启桥，保存后页面会退化为“配置已保存，请手动重启”：

```powershell
dsh --profile web
```

## Worker

GitHub 不替用户部署 Worker。请先复制并审阅 `worker/wrangler.toml.example`、`worker/.dev.vars.example` 和 `worker/reference/*`，将本地副本中的占位符替换为自己的配置；真实文件已被 `.gitignore` 排除。D1 schema/migration 必须人工确认，不由 updater 隐式执行。

代码上传支持人工调用：

```powershell
pwsh -NoProfile -File .\scripts\deploy-worker.ps1 -Mode Direct -DryRun
```

独立 CLI 不直接连接 DSH settings：调用方可把 manager `getApiConfig()` 的 `cfAccountId`/`cfScriptName` 传入 `-AccountId`/`-ScriptName`；未传参数时按环境变量 `CF_ACCOUNT_ID`/`CF_SCRIPT_NAME`，再按 `worker/reference/account.example.json` 占位符回退。显式参数优先于环境变量。上传 token 仍从进程环境读取 `CLOUDFLARE_API_TOKEN`，不会回显 token；也可以使用本地 Wrangler 配置：

```powershell
pwsh -NoProfile -File .\scripts\deploy-worker.ps1 -Mode Wrangler -WranglerConfigPath .\worker\wrangler.toml
```

## 验收与更新

```powershell
dsh --profile web --dump-config
pwsh -NoProfile -File .\scripts\verify-install.ps1
```

重点检查四个插件行、`agent-presets.default=sagitta`、profile path、Manager configured 状态、`/mem/health`、一次只读 recall 和 auto-advance 面板。updater 随每次 `dsh --profile web` 启动做本机源码、插件和 preset 自检；更新冲突、脏工作树、网络失败和未配置凭据会成为可重试诊断，不阻塞 DSH 启动。

Windows 登录自动启动 DSH 不属于默认安装范围。Worker migration 仍需人工确认。
