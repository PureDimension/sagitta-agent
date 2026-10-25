# 任务存储与按需启动设计草案

2026-10-21 建立；2026-10-25 更新连接配置与初始化。业务层和 DSH 主动工具已实现，自动业务挂载待后续批次。

## 运行与配置

- 2026-10-25 用户确认首版只连接已有 PostgreSQL，包括本地或远程服务；取代此前 local/external 双模式提案。本机进程按需启动继续由独立脚本处理，插件的受管启动留待后续。
- DSH 原生配置字段：host（127.0.0.1）、port（5432）、database（sagitta_tasks）、user（sagitta）、password（空）、ssl（false）、可选 caFile。
  password 使用原生 secret 字段；TLS 开启时验证服务器证书，自定义 CA 从本地文件读取。远程数据库须由其部署环境开放网络及认证权限。
- 插件初始化调用 openDatabase 的 SELECT 1 检查；普通配置保存后，Cordis 先卸载旧实例、关闭连接池，再用新配置重新初始化。
- 最近检查结果原子写入 `<profileContext.dir>/sagitta-task/connection-status.json`，包含 connected/failed、检查时间、主机/端口/库名/用户名/TLS 开关；密码与原始错误均不写入此文件。
  文件表示最近检查的快照，无法证明当前在线，每次初始化仍实际连接。连接失败由 DSH logger 报错，修正配置后再次检查。
- 表结构由已有独立脚本初始化；主动工具挂载前已调用 checkTaskSchema。连接记录仅表达连通性，schema 不匹配会报告错误并停止注册工具；插件当前不执行迁移。
- 插件卸载关闭连接池；数据库进程保持其部署环境的生命周期。本机现有实例端口为 55432，需要在配置中填写。

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
业务时间与有效期判断采用数据库时间。设备和会话身份由插件处理；claim_id 由数据库生成，现以 claimId 提供给认领会话，供跨模块资源访问使用。
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
- 任务列表读取存储状态，接受到期至回收之间的短暂不一致。
  2026-10-24 单任务详情、编辑、删除和状态操作统一在事务内检查目标任务；发现到期立即回收，提交后返回原内容及到期说明，本次原操作停止执行。
  2026-10-24 已提供插件级周期回收 Service：注册时立即执行，此后每轮结束等待 5 分钟；实际 DSH 挂载仍待接入。无进程运行时回收延后至后续访问或启动。
- 项目归档、任务归档与对应认领行删除在同一事务提交；并发认领只允许一方成功。
- 项目可用性校验、任务和认领写入按固定锁顺序协调，防止归档后仍授予认领。
  这样后续认领查询可以只查认领表；查询结果表示查询时有效，执行期间撤权另行处理。
- description 编辑接口只改内容；状态和认领由专门业务操作管理。
- 内容更新建议使用 expectedUpdatedAt 做冲突检查，防止跨会话静默覆盖；是否暴露工具参数待审。
- 已认领任务的说明修改、释放、完成、阻塞、取消及删除仅当前认领设备与会话可执行；
  未认领任务允许任意会话编辑、取消和删除；访问发现过期时先完成回收并返回到期结果，正式任务恢复 open 后可再次操作。
- normal 的 open/blocked 可认领为 in_progress；仅 in_progress 可释放、完成或阻塞；
  open/in_progress/blocked 可取消，done/cancelled 不重开。
- 删除 normal 时软删除归档，删除 temp 时物理清除；删除项目时归档项目及其正式任务、清除 temp、撤销全部认领。
  2026-10-23 已实现对应 Repository/Service 删除入口；项目删除持有项目排他锁，单任务删除校验当前认领权限，清理与归档在同一事务提交。
  默认列表排除归档数据，详情仅返回归档标记；原始 SQL 仍可读取保留行。

主键/外键/枚举及字段组合用数据库约束保护；状态迁移规则由任务服务集中处理。
初始索引覆盖项目任务列表、设备/会话认领查询和 temp 到期清理；具体 SQL 下一批审查。
另设一张 schema_migrations 技术表保存已应用版本；本地模式由插件首次初始化，
自定义连接使用已初始化数据库。插件启动检查表结构版本；后续升级需显式实现迁移。
初始化在事务/数据库锁保护下串行进行，重复初始化保留数据。

## 实现模块

- runtime/database-config.ts：DSH 配置声明与 pg 连接参数转换。
- runtime/connection.ts：连接检查及本地检查结果保存；复用 DSH 原子文件写入。
- shared/database.ts + migrations/ + schema.ts：SQL 连接、事务、表结构和版本检查。
- service/：operations/project.ts 和 operations/task.ts 放项目/任务操作，后续自动业务流程放 automation/；按职责拆分状态变更、租约与项目权限。
- index.ts：DSH 配置、工具注册、设备/会话身份、生命周期与上下文注入。
- contracts.ts：共用输入输出类型。
- database-management/：本地目录内准备 PostgreSQL 程序、初始化及启动数据库；自定义连接跳过此层。

旧 Homebrew 安装脚本已移除，本地模式由任务插件按需准备，详见 plugins/task/README.md。
程序、数据和 connection.json 位于用户选择的目录；新建实例选择可用端口，使用 SCRAM 密码认证，
仅监听 127.0.0.1。初始化执行 migrations/001-initial.sql，写入 schema 版本 1，业务表初始为空。
自定义连接继续复用 pg 访问已有 PostgreSQL，不校验数据库引擎版本。当前仅 macOS ARM 完成实测。

早期脚本的历史验证：PostgreSQL 18.6，127.0.0.1:55432/sagitta_tasks，初始化时三个业务表为空、schema 版本 1。
重复初始化保留记录、关闭后重新启动、并发认领唯一性、外键/类型、续租筛选、
到期查询及任务删除级联认领均通过真实 SQL 测试；临时测试库已清理。
Homebrew 同时创建了未运行的默认目录 /opt/homebrew/var/postgresql@18；Sagitta 使用上述独立目录。

官方依据：https://www.postgresql.org/docs/current/app-pg-ctl.html
https://www.postgresql.org/docs/current/ddl-identity-columns.html
