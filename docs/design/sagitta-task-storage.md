# 任务存储与按需启动设计草案

2026-10-21。表结构与本机安装初始化脚本已进入首批实现，其余插件能力仍为设计。

## 运行与配置

- 已确认：PostgreSQL 直连，本地数据库按需启动，独立脚本完成部署和初始化。
- 建议：任务插件加载时检查数据库；本地受管实例按需启动并等待就绪，已有实例复用。
- 配置采用两个分支：local 提供 dataDir；external 提供 connectionString（可连接本地已有服务或远程）。
- local 安装脚本在所选目录保存运行信息，包括 PostgreSQL 程序路径、端口和连接配置；
  插件通过同一目录读取。数据目录放在源码更新目录之外；敏感连接信息只留本地。
- 本地默认只监听回环地址；外部实例由其部署环境管理。连不上外部实例时返回明确错误。
- 启动复用 PostgreSQL 的 pg_ctl，并按数据目录协调并发启动；校验目标实例身份及实际 SQL 连接。
- 等待启动有时间上限，失败后任务能力标记不可用并报告原因；后续执行插件的绿色通道独立于任务数据库。
- 停止策略建议首版采用显式停止命令：插件退出关闭连接池，数据库保留到手动停止或关机。
  这意味着按需启动后进程可能继续驻留；自动空闲退出需要额外协调共享使用者，留待审查。
- PostgreSQL 的本机安装来源、支持平台与安装脚本具体命令在实现批次确定。

## projects

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| id | uuid，主键 | 稳定项目标识，供任务和记忆插件引用 |
| name | text，必填 | 项目名称 |
| description | text，默认空 | Markdown 说明，包含范围、目标和资料链接 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 最近内容或生命周期修改时间 |
| deleted_at | timestamptz，可空 | 删除归档时间；有值时 Agent 不可访问、不可恢复 |

项目删除保留项目和正式任务数据，同一事务内撤销其全部认领，使授权立即失效。
项目归档和记忆 Bank 归档跨越两个存储，联动失败重试在记忆接入阶段处理。

## tasks

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| id | bigint identity，主键 | 全库递增任务号；允许空号，插件不复用或重排 |
| project_id | uuid，外键 | 所属项目，必填 |
| kind | text + CHECK | normal / temp |
| title | text，必填 | 简短标题 |
| description | text，默认空 | Markdown 任务说明、验收、交接、阻塞原因和文件链接 |
| status | text + CHECK | open / in_progress / blocked / done / cancelled |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 内容、状态或认领变化时间；纯续租不改此字段 |
| deleted_at | timestamptz，可空 | 建议显式删除任务也采用归档隐藏；此选择待审 |

绿色通道无需任务记录或任务号。正式、临时任务号对工具以十进制字符串传递，避免 JavaScript 大整数精度问题。
业务时间与有效期判断采用数据库时间。设备和会话身份、claim_id 均由插件处理。
编号顺序只用于稳定列表，不表示完成顺序或调度优先级。

## task_claims

用户已要求独立认领表，并只访问该表判断认领情况；替代此前认领字段放任务行的提案。
以下字段为具体实现建议：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| task_id | bigint，主键及外键 | 被认领任务，每个任务最多一条当前认领记录 |
| claim_id | uuid，唯一，必填 | 每次重新认领生成，拒绝旧持有者的迟到请求 |
| owner_device_id | text，必填 | 认领设备 |
| owner_session_id | text，必填 | 认领会话 |
| expires_at | timestamptz，必填 | 认领到期时间，使用数据库时间判断，对 AI/用户隐藏 |

有效认领查询仅访问 task_claims，匹配调用身份及 expires_at；查询具体凭证时同时匹配 claim_id。
过期行即使尚未物理清理也无效。该表保存当前认领，历史日志暂缓。
创建认领及状态变更仍需校验项目和任务，并在事务内更新相关表。

已确认：temp 释放或到期直接删除任务及认领，expires_at 只存在于认领表。
正式任务释放则删除认领、保留任务；批量续租关联 tasks 并筛选 normal。
正式任务认领有效期已确定为 20 分钟，后续自动续租周期为 5 分钟；当前已实现首次认领期限，自动续租尚待接入。

## 数据规则

- 有认领行的任务须处于 in_progress；无认领通过缺少认领行表达。
- temp 释放或到期清理两表记录；没有释放后继续保留至原期限的阶段。
- 正式任务默认创建为 open；选中立即认领时，先插入 open，再调用认领操作，在同一事务内转为 in_progress 并写入认领，失败整体回滚。
  temp 同样在创建事务内调用认领操作，提交时为 in_progress，有效期固定 20 分钟，由 claimLeaseMinutes 常量维护。
  2026-10-23 用户确认取消紧急任务创建，改为执行调用显式选择绿色通道，限本次调用、跳过任务校验且不访问任务数据库，不授予项目记忆库权限；后续接入时实现。
- normal 释放回到 open 并删除认领；阻塞、完成、取消同样撤销认领。
  temp 释放、完成、取消直接清除任务及认领，阻塞操作报错（2026-10-23 已确认）。
- normal 认领到期保留原任务；回收将其恢复 open 并删除过期认领，后续重新认领生成新的 claim_id。
- 续租必须匹配设备、会话、claim_id，且原租约仍有效；已过期时需要重新认领。
- 任务列表和详情统一读取存储状态，接受到期至回收之间的短暂不一致；temp 到期后由插件启动及周期回收删除。
  无进程运行时回收延后至下次启动；有效认领与授权判断仍依据到期时间。
- 项目归档、任务归档与对应认领行删除在同一事务提交；并发认领只允许一方成功。
- 项目可用性校验、任务和认领写入按固定锁顺序协调，防止归档后仍授予认领。
  这样后续认领查询可以只查认领表；查询结果表示查询时有效，执行期间撤权另行处理。
- description 编辑接口只改内容；状态和认领由专门业务操作管理。
- 内容更新建议使用 expectedUpdatedAt 做冲突检查，防止跨会话静默覆盖；是否暴露工具参数待审。
- 已认领任务的说明修改、释放、完成、阻塞、取消及删除仅当前认领设备与会话可执行；
  未认领任务允许任意会话编辑、取消和删除；认领过期后等待回收完成再操作。
- normal 的 open/blocked 可认领为 in_progress；仅 in_progress 可释放、完成或阻塞；
  open/in_progress/blocked 可取消，done/cancelled 不重开。
- 删除 normal 时软删除归档，删除 temp 时物理清除；删除项目时归档项目及其正式任务、清除 temp、撤销全部认领。
  2026-10-23 已实现对应 Repository/Service 删除入口；项目删除持有项目排他锁，单任务删除校验当前认领权限，清理与归档在同一事务提交。
  默认列表排除归档数据，详情仅返回归档标记；原始 SQL 仍可读取保留行。

主键/外键/枚举及字段组合用数据库约束保护；状态迁移规则由任务服务集中处理。
初始索引覆盖项目任务列表、设备/会话认领查询和 temp 到期清理；具体 SQL 下一批审查。
另设一张 schema_migrations 技术表保存已应用版本；首次初始化和升级由脚本执行，
插件启动检查版本兼容性。迁移在事务/数据库锁保护下串行进行，重复初始化保留数据。

## 实现模块

- runtime.ts：只管理本地 PostgreSQL 的检查、启动、就绪和停止。
- store.ts + migrations/：SQL 连接、事务、表结构和版本迁移。
- service/：operations/project.ts 和 operations/task.ts 放项目/任务操作，后续自动业务流程放 automation/；按职责拆分状态变更、租约与项目权限。
- index.ts：DSH 配置、工具注册、设备/会话身份、生命周期与上下文注入。
- types.ts：共用输入输出类型；脚本入口独立于 DSH，复用运行与存储模块。

首批实现：scripts/install-task-db.py 与 plugins/task/migrations/001-initial.sql，共 138 行。
脚本当前支持 macOS/Homebrew，安装 PostgreSQL 18，默认目录 ~/.local/share/sagitta/task-db、
端口 55432；python3 scripts/install-task-db.py 可重复执行，--directory/--port 可指定首次位置和端口。
连接凭据存 connection.json，实例使用 SCRAM 密码认证，仅监听 127.0.0.1。
初始化写入 schema_migrations 的版本 1，三个业务表初始为空；未注册开机/登录自启动。
用户确认采用 PostgreSQL，并要求移除数据库软件版本校验；18 仅为当前下载目标，
程序与数据目录能否兼容由 PostgreSQL 自身判断。当前脚本仅支持 macOS，Windows 安装适配尚未实现。
表结构约束覆盖类型、外键和单任务单认领；状态迁移、续租、清理及归档撤权由后续服务实现。

本机验证：PostgreSQL 18.6，127.0.0.1:55432/sagitta_tasks，三个业务表为空、schema 版本 1。
重复初始化保留记录、关闭后重新启动、并发认领唯一性、外键/类型、续租筛选、
到期查询及任务删除级联认领均通过真实 SQL 测试；临时测试库已清理。
Homebrew 同时创建了未运行的默认目录 /opt/homebrew/var/postgresql@18；Sagitta 使用上述独立目录。

官方依据：https://www.postgresql.org/docs/current/app-pg-ctl.html
https://www.postgresql.org/docs/current/ddl-identity-columns.html
