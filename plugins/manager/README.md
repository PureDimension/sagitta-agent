# @sagitta/manager

`@sagitta/manager`（Cordis id：`sagitta-manager`）是 Sagitta 的统一配置插件。它把 Worker 运行时 API 地址、Worker 部署元数据与凭据以及 D1 读写凭据注册到 DSH settings，并提供浏览器端插件配置卡片。

## 配置字段

| 字段 | 是否 secret | 用途 |
| --- | --- | --- |
| `workerApiUrl` | 否 | Sagitta Worker 运行时 API 根地址；memory、task 和 health 从这里派生。 |
| `cfAccountId` | 否 | Cloudflare 账户 ID；Worker direct PUT 部署元数据。 |
| `cfScriptName` | 否 | Cloudflare Worker 脚本名；Worker direct PUT 部署元数据。 |
| `workerUploadToken` | 是 | 仅 updater 用于部署 Worker。 |
| `d1ReadToken` | 是 | memory recall/list/search 与 task list/get 的读凭据。 |
| `d1WriteToken` | 是 | memory remember/consolidate/verify 与 task 写操作的写凭据。 |

六个字段默认都是空字符串。浏览器端会回填两个非 secret 字段，但不会回填 secret；secret 输入框只保留本地草稿，空输入不修改已有值，明确点击“清除”才会调用 `scope.unset`。界面和诊断只显示已配置/未配置状态，不显示 token 明文。

## 被其他插件读取

其他 Host 插件通过 Cordis service 读取当前值，不应直接读取 `settings.yaml` 或复制 manager 配置：

```js
const manager = ctx["sagitta-manager"];
const { workerApiUrl, workerUploadToken, d1ReadToken, d1WriteToken, cfAccountId, cfScriptName } = manager.getApiConfig();
const status = manager.getPublicStatus();
```

`getApiConfig()` 只用于同一 DSH 进程内的 memory/updater 等 Host 插件；不要把它原样暴露给 browser remote API。`getPublicStatus()` 是不含 secret 的布尔状态投影。

memory/task 的具体 token header 与 endpoint 由各自 adapter 决定，manager 不猜测旧的 Cloudflare Access 字段语义。当前 DSH 没有已验证的整树重启桥接，因此“保存并重启”会保存配置并提示 `dsh --profile web` 手动重启。
