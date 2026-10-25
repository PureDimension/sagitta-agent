# 任务插件架构提案

2026-10-21。依据本机 DSH 0.2.1-rc.2、已创建的 PostgreSQL 表结构和已确认规则。
主动业务接口已完成；2026-10-25 已挂载 DSH 配置、连接初始化、15 个主动工具及固定使用说明，自动业务与任务数据动态上下文留待后续批次。2026-10-24 单任务入口改造见下文；各批次记录保留演化过程，当前调用方式以对应最新章节为准。

## 架构范式：已确认方向

用户要求逐项讨论，并已同意借鉴 Java 后端的模块化单体，
模块内部沿用 Controller/Adapter → Service → Repository 的常见分层方式。
DSH 工具、定时器等是接入适配；Service 承担业务操作与事务边界；Repository 承担持久化。
借鉴 Spring Modulith 的公开 API / 内部实现 / 显式模块依赖边界，使用 TS 与 DSH 落实。
Spring Boot 并不强制这种分层；当前仅选择架构思路，具体 DTO、领域对象与文件拆分逐项审查。
来源：https://docs.spring.io/spring-modulith/reference/fundamentals.html
https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html

### 主动与自动入口：已确认方向

AI 主动调用和事件/定时自动触发同属接入层，用户已同意平级组织；当前文件提案为 tools.ts 与 automation.ts。
工具入口负责注册、参数格式、身份提取和返回结果；自动入口负责触发时点、托管会话、
调用调度及错误报告；业务规则统一进入 Service，持久化统一进入 Repository。
例如续租 Service 声明周期并提供注册函数，自动入口调用注册并绑定 DSH 生命周期，批量更新 SQL 由 Repository 执行。
规模较小时保持平级文件，内容增长后可分别升为 tools/ 与 automation/ 目录。
下面的模块表为职责清单，辅助文件按实现规模创建。

## 目标与依赖方向

首版以一个任务插件包交付，按职责划分内部模块；扩展通过明确的公共业务接口完成。
AI 工具、其他插件、续租和清理均进入同一任务服务；DSH 类型停留在接入模块。

DSH 工具 / Sagitta 插件 / 生命周期与定时器 → service/ 中的业务服务 → Repository → PostgreSQL 存储。
本地 PostgreSQL 的启动属于独立运行模块；外部连接复用同一存储和业务逻辑。
记忆、异步执行、自主推进依赖任务公开接口；任务核心只理解项目、任务、认领。

## 模块

| 文件/目录 | 所有职责 | 主要输入输出 |
| --- | --- | --- |
| index.ts | 装配、配置校验、服务发布、注册和销毁 | DSH Context、配置 → 可用的任务服务与适配器 |
| contracts.ts | 公共输入输出、身份和错误码 | Project/Task 视图、Actor、内部认领凭证、变更通知 |
| service/ | 按业务拆分项目/任务操作、状态规则、授权、业务事务边界 | 普通 TS 参数 → 业务结果或明确错误 |
| repository/ | 按项目、任务、认领拆分参数化 SQL、锁和数据库行转换，使用传入的查询入口 | 内部查询参数 → 数据对象 |
| schema.ts | 检查任务应用表结构版本 | 查询入口 → 检查通过或明确错误 |
| runtime.ts | 本地数据库按需启动、就绪检查 | 本地运行配置 → 可连接实例；external 跳过 |
| adapters/tools.ts | 已确认的 11 个模型工具 | 官方参数校验、调用者身份 → service；结果向模型投影 |
| adapters/context.ts | 稳定使用说明与动态任务摘要 | 官方提示词注册、刷新后的任务快照 → 上下文 |
| adapters/automation.ts（待实现） | 从 DSH 取得会话身份，将定时器、日志和上下文接入 Service，绑定注册与注销 | 官方生命周期 → service.register / 注销函数 |
| adapters/gate.ts | 执行前权限检查 | 官方 tools/pre-execute → 权限结果；覆盖范围仍待审 |
| migrations/ | 可审查的结构变更 | 现有 SQL 与初始化入口；版本由应用 schema 管理 |

按用户已接受的划分，service/operations/ 放具体操作，当前已有 project.ts、task.ts；
后续自动业务流程放 service/automation/，DSH 触发和注册仍放 adapters/。其余文件随实现增加。
repository/ 内 project.ts、task.ts、claim.ts 分别承载三类数据访问；result.ts 保存查询三态类型。
index.ts 的 TaskRepositories 仅组装 projects、tasks、claims，三者共用传入的查询入口。
事务执行器为每次事务传入同一条连接；Service 显式选择对应 Repository，业务顺序及事务边界保持原样。
仅公开 contracts 与任务服务入口；SQL、连接池和运行目录属于私有实现。
首版采用 pg 驱动与明确 SQL，延续现有 PostgreSQL 结构；暂缓通用存储框架。
连接池与事务收尾已由 shared/database.ts 提供。

### 第二批已实现，用户已认可

- contracts.ts：Project 读取结果含 id、name、description。
- schema.ts：checkTaskSchema 要求迁移记录恰为 [1]，空记录及其他版本直接报错；不会自动修改结构。
- repository/：各 Repository 接收 Pick<Database, 'query'>，可使用共用实例或事务连接的查询能力。
  listProjects 按 created_at、id 排序并过滤归档；getProject 按参数化 ID 查询，以三态结果区分可用、归档和缺失。
  归档/缺失结果只含状态标记，Service 通过 requireFound 转换为明确错误。
- 编译通过 shared/dist/database.d.ts 引用公共类型；源码仍只维护 .ts，产物保持忽略。
- 真实 PostgreSQL 测试覆盖归档过滤、详情/缺失和版本检查；本批尚未注册 DSH 工具或启动钩子。

### 第三批已实现，用户已允许继续

- Repository 新增 createProject(name, description) 和 updateProject(projectId, description)。
  创建返回数据库生成的 ID；编辑先在同一 SQL 内锁定项目，再按归档状态决定是否更新说明和 updated_at。
- service/operations/project.ts 中的 ProjectOperations 接收 Repository，提供上述两项及列表/详情；创建拒绝空名称，说明默认空字符串。
  详情/编辑分别抛出“项目不存在”或“项目已归档”，供后续 DSH 工具边界原生转换。
- 单条写入由 PostgreSQL 原子执行；归档及认领撤销等多表事务留待相应批次实现。
- 类型检查、构建、真实 PostgreSQL 临时表验证通过；版本仍为 1，迁移与正式数据保持原样。

### 第四批已实现，待审查

- service/operations/task.ts 提供 listTasks(projectId)、getTask(taskId)、createTask(input)（创建入口已在第七批统一）。
  创建拒绝空标题，说明默认空字符串；所属项目缺失或归档时分别报错。
  input.claimImmediately 默认为 false；true 时须提供内部 owner，先创建 normal/open，再调用完整认领能力转为 in_progress，二者在同一事务提交。
  未选择立即认领时创建 normal/open 任务。正式认领有效期 20 分钟；已确认每 5 分钟续租，自动调度仍待实现。
- Repository 用同一语句锁定目标项目、按归档状态决定是否插入并返回准确结果。FOR SHARE 阻止项目在事务结束前被归档；
  后续项目删除流程须先锁定/更新项目，再处理任务与认领，遵守既定锁顺序。
- 列表按数值 ID 升序，排除归档项目、归档任务。项目详情、项目编辑、任务详情及正式任务创建统一返回 RepositoryResult<T>：
  found 在 value 字段携带结果；归档只返回 archived 标记；缺失返回 missing 标记。
  service/require-found.ts 按当前操作对象生成明确错误；任务自身或所属项目归档均返回 archived，正文止于 Repository。
  当时按用户要求移除 temp 到期查询过滤；2026-10-24 列表继续保持此行为，单任务详情改由统一入口访问时回收。
  Task 视图仅含 id、projectId、kind、title、description、status。
- 类型检查、构建及四组真实数据库测试通过，覆盖正常创建、空标题/无效项目拒绝、三态结果、temp 到期后仍可读取与删除后不存在、
  立即认领的身份/期限、认领失败整体回滚、项目并发归档时编辑/创建等待后正确拒绝；测试数据通过临时表或独立随机 schema 隔离并清理。
  本批不改变应用表结构。
- 2026-10-23 按讨论抽取 transaction.ts，回调接收绑定同一连接的 Repository。
  TaskOperations 注入查询用 Repository 和 TransactionRunner，在同一个业务类内声明事务并调用其他完整业务方法。
  Database 继续负责提交、回滚及连接释放；调用方在同一数据库实例上组装查询 Repository 和执行器。

### 第五批：修改任务说明（待审查）

- TaskOperations 提供 updateTask(taskId, description, owner)，允许清空说明，返回更新后的 Task；owner 为内部调用身份。
- 经用户同意，原单条 CTE 改为显式事务内的简单 SQL：Repository.lockTask 依次锁项目和任务并返回三态结果，
  Service 通过 requireFound 确认可用，再调用 updateTaskDescription 更新 description 和 updated_at。
  两个 Repository 方法共用事务连接；其他字段及认领记录保持原样。
- 权限补充批次：锁任务后调用 lockClaim 锁定认领，requireTaskWriteAccess 允许未认领编辑；已有认领须有效且设备/会话同时匹配。
  当时已过期认领返回等待回收错误；2026-10-24 改为统一入口清理并返回到期结果。权限检查与编辑共用事务，尚未接入 DSH 工具。

### 第六批：正式任务认领（已审查）

- 用户撤回双层 TaskOperations/TaskService 方案；现仅保留 service/operations/task.ts 的 TaskOperations，直接实现创建、编辑、认领。
- 当时 claimTask 通过 reuseTransactionRunner 组合创建事务；2026-10-24 统一入口直接向内部动作传递事务 Repository，该辅助已删除。
- claimTask 锁定任务并确认未归档，接受 open 或 normal/blocked；第七批允许创建事务中的 temp/open 复用首次认领。拒绝任何尚未清除的认领，包括已过期记录。
  校验通过后创建 20 分钟认领，再更新状态为 in_progress；二者共享事务，失败整体回滚。
- Repository 新增 hasClaim 与 updateTaskStatus，正式任务创建固定 open；认领状态转换由 Service 负责。
- 重写后类型检查、构建及五组真实数据库测试通过：独立/立即认领、重复及过期认领拒绝、终态拒绝、blocked 认领、
  两设备竞争仅一方成功、状态更新失败撤销新认领、创建后认领失败撤销新任务。任务编辑权限已在随后独立批次补齐。

### 第七批：统一创建任务（待审查）

- createTask(input) 按 kind 区分 normal、temp，统一返回 Promise<Task>。normal 保留可选立即认领；temp 必须提供内部 owner 并自动认领；二者共用项目检查、标题检查和创建事务。
- Repository.createTask 固定插入 open；Service 创建后按类型和选项调用完整 claimTask，复用同一事务，创建函数不直接写认领表或修改状态。
- claimLeaseMinutes 固定为 20，供正式认领与 temp 首次认领使用；不提供时长参数。自动续租和到期回收仍待实现。
- 用户审查后取消紧急任务编号及 EmergencyTask 类型，改为执行插件按次选择绿色通道；本批只简化创建入口，绿色通道尚待实现。
- 创建验证覆盖正式与临时任务归属、认领身份、固定期限和失败回滚；取消紧急创建后移除对应测试。

### 第八批：项目与任务删除（待审查）

- TaskOperations.deleteTask(taskId, owner)：事务内锁项目/任务与认领，复用编辑权限校验；撤销认领，再软删除 normal 或物理删除 temp，返回 void。已有归档/缺失结果分别报错。
- ProjectOperations 新增注入 TransactionRunner；deleteProject(projectId) 先取得项目排他锁，随后撤销项目下全部认领、物理删除 temp、归档未归档的 normal 与项目。按此前确认的项目生命周期规则统一处理全部会话的认领。
- Repository 新增 lockProject、archiveTask、deleteClaim、deleteTaskRecord 及项目范围的四个清理/归档方法。写入方法要求调用方在同一事务中持有相应行锁；单任务业务在项目上取共享锁，项目删除取得排他锁，防止并发新增或修改。
- 归档可见性沿用列表过滤与 RepositoryResult 的 archived 标记，服务层无法取得归档正文；原始 SQL 查询保留行仍可用于管理。应用表结构保持版本 1。
- 类型检查、构建与六组真实数据库测试通过，新增验证覆盖删除权限、期限、归档隔离、项目批量清理、事务中途失败回滚及并发归档拒绝。

### 第九批：五个独立状态动作（已审查）

用户要求状态机仅作审查展示，代码保留五个独立函数。新增四个动作返回 void，原 claimTask 返回 Task；状态检查在各函数内直接表达。

| 动作 | 正式任务起始 → 目标 | 临时任务 | 认领要求 |
| --- | --- | --- | --- |
| 认领 | open/blocked → in_progress | 创建事务内 open → in_progress | 无认领记录，然后创建认领 |
| 释放 | in_progress → open | 从 in_progress 物理删除 | 本人有效认领，执行时撤销 |
| 完成 | in_progress → done | 从 in_progress 物理删除 | 本人有效认领，执行时撤销 |
| 阻塞 | in_progress → blocked | 拒绝 | 本人有效认领，执行时撤销 |
| 取消 | open/in_progress/blocked → cancelled | 从 in_progress 物理删除 | 无认领或本人有效认领，执行时撤销 |

- done/cancelled 不再执行这五个动作；2026-10-24 过期认领改为访问时回收。所有修改在同一事务提交。
- 当时 service/with-claimed-task.ts 共用事务及认领检查；2026-10-24 这些职责集中到 execute/dispatch，该辅助已删除。requireTaskWriteAccess 名称和逻辑按用户要求保留。
- 已通过类型检查、构建和七组真实数据库测试，覆盖正式/临时动作、权限和终态拒绝、未认领取消及失败回滚。

### 2026-10-24：单任务统一入口与访问时回收（已审查）

- TaskOperations 对外保留 createTask、listTasks，并以 execute(input) 统一承接 get/update/delete/claim/release/complete/block/cancel。
  execute 在同一事务中锁项目、任务、认领，调用 reclaimExpiredTask；正常路径再由 dispatch 分发至内部动作。
  各动作接收 TaskContext，复用已读取数据；到期检查只在入口调用一次，正常写入无需额外预查询。
- reclaimExpiredTask：有效或无认领直接返回；过期 normal 撤销认领并恢复 open，过期 temp 撤销认领并删除任务。
  返回 expired、回收前 Task、原 owner 和说明；入口直接返回该结果并提交，原请求动作不执行。
  正常结果为 success/value，数据库或业务异常沿用事务回滚。消息呈现留给 DSH 接入层。
- 创建后立即认领直接复用内部 claimTask，依然与创建共用事务；读取详情也进入事务并取得行锁。
  列表和项目操作保持原语义；周期回收见生命周期章节，上下文通知仍待 DSH 接入。
- lockClaim 用物化 CTE 先取得行锁，再计算 expired；避免锁等待跨过到期点后仍使用提前计算的判断。
- 到期结果随本次调用返回；物理删除后再访问返回不存在。尚未引入持久通知记录，提交后进程崩溃不能保证提示送达。
- 验证：12 组真实 PostgreSQL 测试通过，覆盖全部单任务动作到期回收、原内容返回、范围隔离、失败回滚、并发仅一方回收和等待认领锁期间到期。

### 后续动作扩展待办

- 完成：参考 legacy 的完成前检查；具体检查内容、结果记录及拒绝条件另行设计。
- 阻塞：参考 legacy 的阻塞信息登记、额外处理及联动；具体字段、依赖和恢复流程另行设计。
- 这些能力后续在对应动作内扩展，本批实现基础状态流转，尚未加入上述检查和联动。

## 两类调用者与公共接口

- 模型工具仍为已确认的 11 个，内部方法可以按 claim/release/complete 等明确动作组织。
- 其他插件直接注入任务服务，通过类型明确的方法调用，复用相同规则。
- 内部查询示例：有效认领、项目详情、任务详情、会话可访问的项目 ID。
- 会话身份来自运行环境；设备身份来源待确认。DSH anonymous-user-id 按 DSH_HOME 持久化，
  用于遥测与反馈，写入失败仍返回临时 ID，不能直接视为已验证的稳定设备身份；复制目录还会复制 ID。
- 模型输入不能自行指定 owner 或内部 claim_id。内部续租使用本进程已取得的认领凭证。
- 对模型的结果投影隐藏 expires_at、连接配置和内部凭证；数据库行与公开结果分别定义。
- 业务方法验证供所有调用者共用；工具参数 schema 主要处理格式与模型使用说明。
- 具体公共方法只覆盖已确定功能；新增能力显式加入契约，状态机修改仍经代码审查。

## 一致性与失败语义

1. service 规定一次操作的事务范围，repository 确保所有 SQL 使用同一数据库连接。
2. 认领、状态修改、任务/项目归档及撤销认领在数据库事务内完成。
   锁顺序统一为项目、任务、认领；批量时同类对象按稳定 ID 顺序处理。
3. 有效认领判断只查询 task_claims 并使用数据库时间；过期行不产生授权。
4. temp 释放/到期删除任务并级联认领；先识别 temp 再清理，避免只清理认领遗留任务。
5. 批量续租筛选 normal、当前设备/托管会话、本进程取得的 claim_id 和尚有效的期限。
6. 数据库提交成功后才通知本进程订阅方；订阅失败分别报告，不把成功操作改报为回滚。
7. 本地事件用于刷新提示与触发联动；跨设备、重启和重连通过重新查询权威状态收敛。
   后续 memory 接入时，以可重试的 Bank 创建/归档及对账补偿跨存储操作。
8. 查询可以在明确失败后重试；创建或提交结果不明时返回可辨识错误，避免盲目重复创建。
   持久操作编号及结果查询/去重作为后续候选；首版遇到提交结果未知须明确报告并允许查询核实。
9. 错误分为参数/状态/归属冲突、数据库不可用、结果待确认；保留稳定错误码和可读原因。
   统一边界记录必要的错误，连接密码和原始连接 URI 从日志排除。

## 错误、审计、事务与可靠通知：待审基础设施

用户指出旧项目曾因这些基础能力不足而难以维护，要求在功能扩展前规范。
以下是机制候选，尚未新增表、迁移或运行实现；此前暂缓的详细任务执行流水继续暂缓。
按用户后续确认的实验项目定位，首版范围以下节“建设范围”优先；持久去重和完整可靠投递暂缓。

- 统一操作上下文：operationId、来源（tool/automation/plugin）、设备/会话、动作与目标。
  同一逻辑请求的重试复用编号；新的调用是新请求，编号不自动解决语义重复任务。
- 统一错误：区分业务拒绝、基础设施故障、提交结果未知；向模型返回可读原因及错误码，
  保留原始 cause 给日志。业务错误集中转换，后台入口捕获失败并保留可再次运行能力。
- 事务助手：取得同一连接，BEGIN → 调用业务 → COMMIT；确定未提交的失败回滚，
  finally 释放连接。回滚/连接故障保留原始错误并丢弃损坏连接；提交断连不能谎报已回滚。
- service 决定事务范围，Repository 的写方法显式接收事务连接；所有关联写入共用它。
  网络请求、LLM、文件变更在数据库事务之外处理，后者无法被 SQL ROLLBACK 撤销。
- 锁：业务操作采用数据库行锁/条件更新和唯一约束；锁顺序统一，批量按稳定 ID 排序。
  设置锁和语句超时；死锁等确定回滚的事务可有限重试整个事务，业务冲突返回调用者。
- 运行日志：统一结构、级别和 operationId；记录耗时、错误原因和堆栈，凭据脱敏。
  复用 DSH 日志出口并核对落盘/轮转；日志保留周期单独确定，数据库断连仍须能记录。
- 操作审计：建议增加 audit_events，保存谁对哪个对象做了何种关键变更、时间与操作编号。
  成功的关键变更与审计同一事务；要求审计的操作若写审计失败，一并回滚。
  回滚、拒绝及数据库不可用的尝试记录到事务外日志。续租心跳可做汇总，避免高频逐条审计。
- 去重：建议持久保存 operationId、请求指纹及最小结果，重复编号相同请求复用已提交结果，
  相同编号不同请求拒绝。具体独立操作表或与审计结合、保留窗口均在字段设计时审查。
- 通知分两类：上下文/UI 刷新可以提交后通知并在下次查询补齐；必要跨模块联动采用持久投递。
- 可靠联动建议使用 outbox：业务事务内写待投递记录，提交后自动入口调度投递，记录结果并重试。
  失败保留并可查询；达到重试边界报告给用户/模型，不默默删除。
- 投递按订阅者记录进度，采用可恢复的处理租约；外部调用期间释放数据库锁。
  投递可能重复，消费端按事件 ID 或目标状态实现幂等；永久故障只能报告待处理，不能承诺必达。
- 项目归档示例：事务内归档项目、撤销认领、写审计和待投递记录；事务外完成 Bank 归档。
  Bank 归档失败时显示“项目已归档、记忆联动待处理”；重启后补发，避免重复归档业务操作。
- 首批基础能力顺序建议：最小数据库模块 → 业务操作并接入 DSH 原生错误/日志 → 必要审计。
  持久去重与 outbox 待实际联动需要时评估，对账能满足要求时优先采用对账；逐批审查代码。
- 验收包含注入失败：多表写入中途失败、审计失败、并发抢占、提交断连、重启恢复、重复投递。

参考：PostgreSQL 锁 https://www.postgresql.org/docs/current/explicit-locking.html
Spring Modulith 事件发布记录 https://docs.spring.io/spring-modulith/reference/events.html

## 共用基础设施的归属：已确认方向

- 用户同意采用仓库内共享基础库、插件拥有业务状态、DSH 承担装配与生命周期的组合。
  基础库按实际需求提取错误、操作上下文、日志适配和事务等公共实现，随插件加载，无独立服务进程。
- 插件负责自己的连接、事务边界、审计内容、锁定对象及恢复规则；共用事务助手不意味着共用全局事务。
  数据库事务与 Hindsight HTTP 调用仍需分别处理，Manager 无法把它们自动变成原子操作。
- 跨插件调用使用公开业务契约；查询设置超时并明确不可用结果，必要联动由来源插件持久登记，
  消费插件幂等处理。可复用投递机制，事件与处理进度的归属须在具体联动中确定。
- Manager 如有实际需求，可汇总配置、健康状态与待处理事项；目前无需以它作为业务调用的中转或前置条件。
- 共享实现便于统一修复；同一 DSH 进程内仍共享进程故障风险，不把逻辑模块独立等同于进程隔离。
- 已确认归属原则；具体公共接口与代码仍须逐批审查。

### 建设范围：原则已确认，清单待审

用户明确这是实验性个人助手，优先扩展性和可修复性，基础支撑尽量从插件核心能力中提取。
接受明确失败与人工/紧急模式修复；仍须保留事务、有效认领校验及故障线索，以免无法判断状态。

按用户最新要求缩减建设范围：
1. 直接复用 DSH 错误返回与日志。业务错误指规则拒绝的原因，优先使用原生错误表达；独立错误框架暂缓。
2. PostgreSQL 最小模块负责连接、事务、释放与必要检查；各插件保留业务 SQL 和事务范围。
3. 配置与注册沿用 DSH；设备身份先核对现有能力，再确定来源。
4. 操作关联仅指同一次调用的日志/审计使用相同编号，属于可选排障辅助，暂缓独立实现。
5. 续租及其触发规则归任务业务；仅有实际复用需求的防重叠、清理等机制提取公共辅助。
6. 必要审计等支持行为通过显式注册或回调接入；执行顺序与事务范围保持清晰，避免隐藏业务影响。

上述为职责清单，不要求各建一个包；已有框架能力直接复用，抽取公共实现时以具体调用场景为依据。
跨插件通知先明确公开契约、提交后通知与恢复查询；可靠投递、持久去重、统一健康面板按实际需要后补。
任务 SQL、状态规则、审计内容与事务范围属于插件；通用机制可共用，但业务语义不能由基础库推断。
首批已实现最小数据库模块；DSH 已提供 HarnessError 和工具异常转换，后续按具体业务接入。

### DSH 原生能力核对（0.2.1-rc.2，本机源码）

- Cordis 的 ctx.logger 提供命名、级别、时间、Error 堆栈与 cause 输出、exporter 和有界内存缓存。
  日志调用直接复用；目前核对的缓存默认 1000 条，尚未确认当前运行配置具备通用日志落盘/轮转。
  持久审计、操作关联字段和敏感信息处理仍需明确，不能把会话持久化等同于全部插件日志持久化。
- dsh-tools 捕获工具执行异常并生成 isError 结果；HarnessError 的 name/code 可进入结构化错误信息。
  插件需要提供业务原因，后台回调与数据库回滚不由工具异常转换代管。
- Cordis 提供带作用域的事件、依赖注入和清理机制，可直接承担本进程通知与生命周期。
- cordis-plugin-timer 的回调式 interval 直接调用 setInterval；不会等待异步回调或自动防重叠。
  续租等操作需要小型串行调度与错误处理；计时器清理不会取消已经运行的数据库操作。
- 已发现前端 Workspace 的业务 Toast 插槽，尚未确认通用后端通知接口；用户提示、模型输入和内部事件须分开接入。
- 官方 README 明示 developer preview 与可能破坏兼容；继续固定 DSH 版本，并把框架调用集中在接入层。
  本轮为静态源码核对，未进行日志落盘、通知呈现或故障恢复的运行验证。

### 最小数据库模块：首批实现待审

- 使用 node-postgres（npm 包 pg）的连接池和参数化查询，事务遵循该项目官方示例。
  pg 是现成驱动，不称为 PostgreSQL 官方驱动；公共模块只封装本项目需要的资源与事务生命周期。
- 已实现于 shared/database.ts，为普通 TS 模块，依赖 pg 8.23.1，不导入 DSH；插件接入留待下一批。
  插件通过回调提供后台错误报告，绑定 ctx.logger；各实例独立持有连接池，不设置全局数据库单例。
- 入口 openDatabase(config, reportBackgroundError)：建立池、注册 error 监听、SELECT 1 检查连通性；
  初始化失败关闭池并向调用方报告。默认连接等待 5 秒、服务端单条语句 30 秒，调用方 PoolConfig 可覆盖。
- 返回 query、transaction、close 三项能力：单条查询用 pool.query；事务取得一条连接，
  BEGIN 后将该连接的查询能力交给回调，成功 COMMIT，明确未提交的失败 ROLLBACK，最终释放连接。
  回滚失败保留原因并丢弃连接；提交时断连须报告结果待确认，首版不自动重放业务写入。
- 用户进一步明确：失败处理遵循驱动常见模式，保留原始错误并清理资源；“提交可能无法确认”
  仅作为错误解释的边界，不据此新增结果确认服务、业务状态、自动补偿或重试系统。
- reportBackgroundError 是插件装配时提供的程序回调，拟用于把连接池空闲连接错误接到 DSH 日志，
  并非用户配置或 AI 工具参数。监听本身不会输出日志；回调调用 ctx.logger.error 才进入 DSH 日志出口。
- close 调用 pool.end，只关闭应用连接池；DSH 接入层负责在卸载收尾时调用，数据库进程生命周期另行处理。
- 锁通过业务 SQL 与数据库约束表达；事务回调中的 Repository 查询显式使用同一事务连接。
  业务 schema 检查、迁移、审计内容和任务续租归相应模块；公共数据库层不自动推断或执行这些业务。
- 模块 66 行，配置和真实数据库测试随本批提供；编译输出位于 shared/dist，导出 @sagitta/runtime/database。
  类型检查、构建及 PostgreSQL 集成测试通过：参数查询、提交及回调返回值、SQL/业务异常回滚、
  单连接池归还复用、关闭后拒绝查询；测试只使用连接级临时表。后台断连/回滚失败未做故障注入验证。
- 依据：https://node-postgres.com/features/transactions 、https://node-postgres.com/apis/pool 、https://node-postgres.com/apis/client

## 生命周期

### 正式任务续租（2026-10-23，单次业务已实现，DSH 接入待审查）

- DSH 接入层取得本设备身份及本实例负责的存活会话；会话空闲时继续续租，销毁或插件卸载后停止纳入。历史会话记录和浏览器标签页不直接作为存活依据。
- 就绪后执行一次，每轮完成后等待 5 分钟再开始下一轮；串行等待自然防重叠，错误交给 DSH logger，下一周期重新按数据库现状查询。
- 每轮仅续租匹配设备/会话的有效 normal 认领，任务须 in_progress 且项目/任务均未归档。沿用认领代次约束：从本轮候选记录取得 claim_id，更新时匹配该代次并复查有效期；无须向 AI 暴露。
- expires_at 更新为数据库当前时间加 20 分钟，保持任务状态和 updated_at；temp 与过期认领留给独立回收流程。
- 组织：service/automation/renewal.ts 的 TaskRenewal 提供 register(periodicTasks, owner, callbacks) 注册策略，以及 renewClaims(deviceId, sessionIds) 单轮业务；repository/claim.ts 执行批量续租 SQL。后续 adapters/automation.ts 从 DSH 取得身份、绑定定时/日志/上下文与生命周期，再调用 Service；插件 index.ts 装配依赖。
- 当前已实现 TaskRenewal 与 Repository.renewClaims：空会话列表返回 0；单条 SQL 按任务 ID 顺序锁定候选认领，再检查代次及有效期并更新，返回续租数量。错误直接传播；任务数据保持原样。周期注册与到期回收已提供内部能力，实际 DSH 定时器及会话采集仍待接入。
- 公共执行组件 shared/periodic-task.ts 中，PeriodicTasks 负责登记运行实例及统一停止；内部 PeriodicTaskRunner 通过 start/stop/execute/wait/cancelWaiting 管理单项的停止信号、计时器和运行 Promise，复用 runPeriodicTask 循环。定时和日志仍由构造参数注入；register 返回异步注销函数。各注册独立串行运行，周期从本轮业务及结果回调结束时计算。
- TaskRenewal.register 注册立即执行的本会话续租，间隔 5 分钟；额外重试最多 2 次、间隔 5 秒、重试时间预算 60 秒。成功传递续租数量，重试耗尽传递原始异常；重试预算不能中止正在执行的 SQL。实际 DSH 挂载、身份读取、上下文提示与续租结果语义补充仍待后续接入。原 adapters/automation.ts 仅声明业务策略，已合并进 Service。
- 本机 DSH 0.2.1-rc.2 已核对 AgentRegistry.list()、agent/created/disposed 和 session/created/disposed；ctx.interval 回调不等待 Promise，因此串行调度交给公共组件，接入层绑定 ctx.timeout。设备 ID 来源及任务插件作用域内的会话筛选仍待接入时确定。

### 周期回收（2026-10-24，内部能力已实现，待审查）

- service/automation/reclamation.ts 的 TaskReclamation 在插件级注册一次，立即执行首轮，此后每轮结束等待 5 分钟。与按会话注册的续租独立调度，覆盖所有设备、包括已经关闭的会话遗留的到期认领。
- listExpiredTaskIds 只查询未归档项目/任务的到期候选，按数值任务 ID 排序；单次回收事务按顺序锁项目、任务和认领，复查当前状态。
  候选已删除或归档时跳过；有效或已撤销认领由 reclaimExpiredTask 返回无需回收。主动访问与周期回收共用该函数的全部清理规则。
- 一批回收在同一事务提交，任一项失败整体回滚；成功后 onSuccess 接收 ExpiredTask[]（原任务内容、原 owner、回收说明），接入层据 owner 路由提示。
  共用说明只描述回收结果，主动 execute 额外说明本次请求动作未执行。
- 回收注册 retries: 0，异常原样交给 onFailure，下一周期按数据库现状继续扫描；避免立即重放物理删除使提交结果不明的清理被后续空结果掩盖。续租保留原有重试策略。
- 验证：15 组真实 PostgreSQL 测试和 7 组周期组件/注册测试通过，覆盖跨会话回收、有效记录保留、批量整体回滚、主动与两个回收调用竞争、首次执行及失败后下一周期恢复。
  尚未实际挂载 DSH 或实现提示投递；跨进程崩溃的通知持久化仍未提供。

### DSH 装配与生命周期待办

- 2026-10-25 本批：index.ts 声明 static Config，Service.init 调用 runtime/connection.ts；普通配置变更复用 Cordis 重启实例，卸载时关闭池。连接失败记录到本地并交给 logger，初始化到此结束，修正配置可重新检查。
  根包导出 @sagitta/runtime/task，sagitta.json 登记插件。后续同日已增加 schema 检查、业务装配、15 个主动工具和固定说明，详见 [主动工具接入](sagitta-task-tools.md)；定时维护与任务数据动态上下文仍待挂载。
- 插件在 Sagitta 对应作用域内发布服务，工具/上下文/门禁沿用相同作用域。
- 工具注册与数据库就绪分开；后续执行插件的绿色通道在任务数据库不可用时仍须可用。
- 首版只连接已有服务；初始化迁移由独立脚本处理，业务挂载前已接入已有 schema 检查。受管数据库启动留待后续。
- 会话创建/恢复时纳入本进程托管范围，销毁时停止为它续租；加载时兼顾已存在的会话。
- 定时维护串行运行，上一轮未结束时不会再重叠；查询与锁等待有超时。
- 上下文注入采用 DSH section/context；context 的同步文本回调读取已刷新快照，
  异步查询在可等待的生命周期/组装钩子中进行；权限查询始终查数据库。
- 卸载时先停调度、注销接入，再等待有界的在途操作收尾并关闭连接池。
  数据库进程是否自动停止仍按待审生命周期方案处理，避免影响共享使用者。
- 同步工具门禁只能表达执行时点的准入；异步工作的后续撤权与取消需执行插件协作。

## 验证与扩展例子

- 规则测试：状态变化、临时任务语义、错误投影；业务逻辑可脱离 DSH 调用。
- PostgreSQL 集成测试：双设备竞争、旧凭证续租、释放/归档并发、断连、重复初始化。
- DSH 接入测试：两个会话隔离、插件卸载清理、后台续租及 context 刷新。
- 未来增加 memory：读取授权项目、订阅本地变化并自行对账，不接触任务表写入。
- 未来增加异步执行：启动时取得任务凭证、报告结果调用任务服务；执行器仍独立。
- 未来增加 UI：复用业务契约；若通过网络访问，需新增身份与传输适配层。
- Windows：适配安装与运行模块；任务规则和数据库 SQL 复用，运行结果须在 Windows 验证。

实现顺序：公共契约与错误 → 存储/事务 → 项目任务服务 → 认领/续租/清理 → DSH 工具/上下文/门禁。
本地启动与迁移接入按相关批次补齐；每批约 150 行，用户审查后继续。

## 核对依据

- 本机 @deepseek-ai/dsh-tools：defineTool、tools.register、tools/pre-execute，执行上下文提供 agent。
- 本机 dsh-system-prompt：section/context 注册与注销，context.text 为同步 provider。
- 本机 dsh-agent / dsh-session：创建、销毁与注册表；cordis-plugin-timer 提供可释放定时器。
- node-postgres 事务须使用同一 client：https://node-postgres.com/features/transactions
