# @sagitta/updater v2

DSH 启动时运行的 Sagitta 本机维护插件，负责：

- 对 `sagitta-agent` 做 `git fetch`、SHA 比较和 `merge --ff-only`；脏工作树、离线和非 fast-forward 只会跳过本次更新。
- 在源码更新后重新安装已有 profile 依赖，并把 `presets/sagitta` 同步到 `<DSH_HOME>/.agent-presets/sagitta`。
- 通过 `.sagitta-managed.json` 判断 preset ownership。用户修改过的 preset 不会被静默覆盖，只生成 update candidate。
- 从 `sagitta-manager` service 读取 Worker API 配置；配置完整时默认 direct PUT 上传 `worker/worker.js`，必要时使用 Wrangler fallback，并执行 `/mem/health` 检查。

配置字段以 `lib/config.js` 的 Schemastery schema 为准。旧版 `path`、`branch`、`repos` 仍兼容；新配置使用 `repoPath`、`profile`、`presetId`、`workerUpdate` 和 `restartPolicy`。默认重启策略是 `prompt`，即磁盘更新后提示手动执行 `dsh --profile web`。

Worker token 不属于 updater Config，也不写入 README、日志或 preset；它只由 `ctx['sagitta-manager'].getApiConfig()` / manager service 提供。本文不包含任何真实凭据。
