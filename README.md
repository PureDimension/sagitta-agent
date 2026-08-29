# sagitta-agent

Sagitta 的 DSH 插件、默认 preset、本机 updater，以及 Cloudflare Worker/D1 的参考部署材料。

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

进入 `Settings > Plugins > Sagitta Manager`，填写 Worker API URL、Worker upload token、D1 read token 和 D1 write token。token 只在 DSH 设置页输入，不放入命令行、preset、profile patch、Git 或记忆条目。若当前 DSH 版本没有经过验证的整树重启桥，保存后页面会退化为“配置已保存，请手动重启”：

```powershell
dsh --profile web
```

## Worker

GitHub 不替用户部署 Worker。请先复制并审阅 `worker/wrangler.toml.example`、`worker/.dev.vars.example` 和 `worker/reference/*`，将本地副本中的占位符替换为自己的配置；真实文件已被 `.gitignore` 排除。D1 schema/migration 必须人工确认，不由 updater 隐式执行。

代码上传支持人工调用：

```powershell
pwsh -NoProfile -File .\scripts\deploy-worker.ps1 -Mode Direct -DryRun
```

正式 direct PUT 只从进程环境读取 `CLOUDFLARE_API_TOKEN`、`CF_ACCOUNT_ID` 和 `CF_SCRIPT_NAME`，不会回显 token；也可以使用本地 Wrangler 配置：

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
