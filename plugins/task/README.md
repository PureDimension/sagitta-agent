# Sagitta Task 数据库配置

DSH 任务插件的配置由 `src/config.ts` 声明，数据库位置支持两种模式。

## 本地目录

```json
{ "mode": "local", "directory": "/用户指定的绝对路径/sagitta-task-db" }
```

初始化时在该目录准备 PostgreSQL 程序、数据和连接配置，启动或复用实例，初始化任务表。
各阶段通过 DSH 日志报告。首次准备需要网络和 npm；本地部署目前已实测 macOS ARM。
已生成的账号、密码和端口保存在 connection.json；内容不完整时报告错误，保留原数据。
插件卸载关闭自身连接池，共享数据库进程继续运行。

## 自定义连接（默认）

```json
{ "mode": "custom", "host": "数据库地址", "port": 5432, "database": "sagitta_tasks", "user": "sagitta", "password": "本地填写", "ssl": true }
```

沿用已有数据库连接逻辑；启用 TLS 时验证证书，可通过 caFile 提供 CA 文件。
此模式要求数据库已运行、任务表已初始化，仅检查现有表结构版本。
本地与自定义模式共用 pg 连接池模块、事务、Repository、Service 和工具。

使用 Updater 时，以上内容填写到 DSH profile 的 `cordis.patch.yml` 中：
找到 `id: preset-sagitta` 的 `config.plugins`，再找到 `id: sagitta-task` 的 `config`。
启动日志显示配置文件完整路径。修改并保存后，请手动重启 DSH，让已有会话使用新配置。
Updater 更新时按插件 ID 保留这些配置；本批未添加专用 Web 配置表单。
