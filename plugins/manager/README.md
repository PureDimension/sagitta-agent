# @sagitta/manager

`@sagitta/manager`（Cordis id：`sagitta-manager`）是 Sagitta 唯一的基础设施服务：它注册配置、解析凭据、提供 Worker HTTP 通道，并负责显式触发 Worker 部署。

## Sagitta 预设安装

预设源位于本包的 `presets/sagitta`。在源码仓库运行
`pwsh -File scripts/sync-preset.ps1 -RepoPath <仓库路径> -DshHome <DSH_HOME>`，
将展开路径变量后的预设安装到 `<DSH_HOME>/.agent-presets/sagitta`。
Profile 的 `agent-presets.config.includeUserRoot` 必须为 `true`（默认值）。
DSH 0.1.1-rc.2 启动器会覆盖自定义 `roots`，不能只指向本包目录并关闭用户目录扫描。
同步脚本会保留用户修改；包更新后应再次同步预设。

## 配置字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `workerApiUrl` | 空串 | Worker 运行时 API 根地址；请求和部署健康检查时必填。 |
| `proxy` | `http://127.0.0.1:7897` | HTTP CONNECT 代理；空串表示直连。 |
| `scriptName` | `sagitta-memory` | Cloudflare Worker 脚本名。 |
| `cfAccountId` | 空串 | Cloudflare 账户 ID；部署时必填，不查询 memberships。 |
| `repoPath` | 空串 | 包含 `worker/worker.js` 的仓库路径；空串显式关闭启动时自动部署。 |
| `codexModel` | `gpt-5.6-luna` | codex 派单默认模型。 |
| `accessIdRef` | `SAGITTA_ACCESS_ID` | Access Client ID 的凭据引用名，可在设置卡片修改。 |
| `accessSecretRef` | `SAGITTA_ACCESS_SECRET` | Access Client Secret 的凭据引用名，可在设置卡片修改。 |
| `uploadTokenRef` | `SAGITTA_UPLOAD_TOKEN` | Cloudflare API Token 的凭据引用名，可在设置卡片修改。 |

三个引用名与对应的凭据值都可从设置卡片修改。凭据输入框从空白开始，只显示“已配置/未配置”；实际读写走 credentials domain，明文不会回显。

## 服务 API

```js
const manager = ctx["sagitta-manager"];
await manager.apiConfig();
await manager.request("/mem/recall", { method: "GET" });
await manager.deployWorker();
```

`apiConfig()` 返回九个字段：`workerApiUrl`、`proxy`、`scriptName`、`cfAccountId`、`repoPath`、`codexModel`、`accessId`、`accessSecret`、`uploadToken`。后三个值由配置中的引用名异步解析。

`request()` 自动附加 Cloudflare Access 头，按 `proxy` 选择 CONNECT 隧道或直连，并在 HTTP 失败、网络失败或超时时抛错。

## Worker 部署

配置 `repoPath` 后，manager 读取 `<repoPath>/worker/worker.js` 并计算 SHA-256，与 `<dshHome>/profiles/web/.sagitta-deployed.json` 中上次成功部署的 SHA 比较。相同则返回 `{ status: "up-to-date" }`；不同则读取 `worker/reference/deploy.json` 的 `bindings`，以包含 D1 与 secret bindings 的 multipart 上传，回读 `/mem/health` 成功后写入新 SHA，并返回 `{ status: "deployed", sha }`。

`deploy.json` 缺失或没有 `bindings` 数组会直接报错，不会退化为无 bindings 上传。`cfAccountId` 为空也会直接报错。状态文件不存在表示尚未成功部署，属于首次部署的正常状态。

未配置 `repoPath` 时启动自动部署显式关闭，但直接调用 `deployWorker()` 会报错。

浏览器端 `lib/client.js` 是独立的 `dsh.client` bundle，自己渲染九个文本字段与三个凭据控件，不导入 `@deepseek-ai/dsh-client-ui-settings-plugins` 的代码；样式使用 `--dsw-alias-*` 变量。
