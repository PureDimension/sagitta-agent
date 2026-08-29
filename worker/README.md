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
