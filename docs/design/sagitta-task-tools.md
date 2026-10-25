# 任务主动工具接入

2026-10-25。当前提供 15 个主动工具，使用本机 DSH 0.2.1-rc.2。
原先统一的状态工具已按用户要求在接入层拆为五个动作工具；业务规则继续复用已有 Operations。

## 初始化与文件关系

`index.ts` 等待 DSH 的 tools、systemPrompt、agents 和 timer 服务，按以下顺序初始化：

1. 根据配置连接 PostgreSQL，保存最近连接检查结果。
2. 检查 schema_migrations 是否符合现有版本 1。
3. 创建 TaskRepositories、事务执行器、ProjectOperations 和 TaskOperations。
4. 调用两个工具注册生成器，把每个工具的注销函数交给 Cordis。
5. 调用 registerTaskGuidance，将项目与任务总体说明注册为固定系统 section，并交付注销函数。

初始化使用原生 ctx.effect。数据库关闭函数和工具注销函数都显式 yield；
途中失败自动清理已经取得的资源，错误进入 DSH logger。普通配置保存触发框架卸载和重新初始化。
connection-status.json 仍然只表示数据库连通性：schema 检查失败时，它可以为 connected，工具则未注册。

| 文件 | 职责 |
| --- | --- |
| adapters/identity.ts | 从 DSH 环境取得认领设备与会话身份 |
| adapters/tools/parameters.ts | 共用项目 ID、任务号和说明的参数定义 |
| adapters/tools/results.ts | 共用输出 schema、JSON 展示、到期结果投影 |
| adapters/tools/project.ts | 五个项目工具的定义及注册 |
| adapters/tools/task.ts | 十个任务工具的定义及注册 |
| adapters/guidance.ts | 项目/任务概念、状态含义与总体使用流程的固定系统说明 |

`defineTool` 提供参数类型推断与运行时校验，输出同样由框架校验。
业务异常直接交给 DSH 转换为工具错误；事务、权限和到期规则使用现有 Service。
工具默认采用 DSH 的独占调度规则，本批未声明可并行或自定义超时。
已开始的 SQL 使用既有数据库超时；中途取消无法保证已提交的写入撤销。

## 主动工具

以下 `?` 表示可省略；所有 ID 都使用字符串，taskId 保留 bigint 的十进制表示。

| 工具 | 参数 | 行为与结果 |
| --- | --- | --- |
| project_list | 无 | 返回所有可用项目 |
| project_get | projectId | 返回项目详情 |
| project_create | name, description? | 创建并返回项目；说明默认空字符串 |
| project_update | projectId, description, mode? | replace 替换、append 原子追加说明，返回项目 |
| project_delete | projectId | 归档项目与正式任务、删除临时任务、撤销全部认领；返回完成说明 |
| task_list | projectId | 返回该项目的任务列表，沿用存储状态 |
| task_get | taskId | 经统一单任务入口读取，可能先回收过期任务 |
| task_create | projectId, kind, title, description?, claimImmediately? | kind 为 normal/temp，返回创建的任务 |
| task_update | taskId, description, mode? | replace 替换、append 原子追加说明；经统一权限与到期检查 |
| task_delete | taskId | 正式任务归档，临时任务物理删除；经统一权限与到期检查 |
| task_claim | taskId | 正式任务 open/blocked → in_progress，本会话取得认领 |
| task_release | taskId | 正式任务 in_progress → open；临时任务清除 |
| task_complete | taskId | 正式任务 in_progress → done；临时任务清除 |
| task_block | taskId | 正式任务 in_progress → blocked，撤销认领；临时任务拒绝 |
| task_cancel | taskId | 正式任务 open/in_progress/blocked → cancelled；临时任务清除 |

五个动作入口各自声明参数与说明，内部仍调用 TaskOperations.execute；task_transition 已移除。
当前动作参数均为 taskId，完成验收和阻塞原因登记等专属字段待后续设计。

正式任务 claimImmediately 省略为 false；为 true 时由现有 Service 在同一事务创建并认领。
临时任务自动认领，有效期固定 20 分钟；claimImmediately 省略或传 true 均接受，显式传 false 报错。
绿色通道在执行插件设计，本批 task_create 只接受 normal/temp。

两个更新工具的 mode 省略时为 replace。append 在 SQL 中使用当前 description 与新增文本拼接，
并发追加按行锁串行保留各自内容；调用方只提交新增部分，换行等分隔符由传入文本提供。
整体替换仍按调用方提交的完整说明覆盖，没有版本冲突检查。追加沿用原有归档、权限和到期处理。
description 使用 PostgreSQL text，应用与表结构均未添加长度上限；本次增加更新方式无需迁移。

项目返回 id/name/description；任务返回 id/projectId/kind/title/description/status。
task_create 立即认领成功以及 task_claim 成功时，任务对象额外提供 claimId（数据库 claim_id），用于其他模块的资源访问校验。
续租保持 claimId；释放/到期后失效，重新认领生成新值。任务管理工具仍使用 taskId 参数。
task_get/update/delete 与五个状态动作共用结果结构：

```json
{"kind":"success","task":null,"message":"认领已释放；正式任务恢复待领取，临时任务已清除"}
```

读取、编辑或认领成功时 task 含任务内容，其余动作成功时为 null。
到期返回 kind=expired、回收前的 task 和到期说明，说明包含“本次操作未执行”。
回收已提交，调用方可据说明决定后续动作；expired 属于显式业务结果。
owner、expires_at 保持内部使用；普通列表、详情及到期结果不提供认领凭据。

每次 system-prompt/assemble 通过一次查询取得本设备、本会话的有效正式/临时认领，按项目分组。
项目展示 id/name/description，任务展示完整任务字段和 claimId；结果放在 TOOL_WORKFLOW 后的“本会话当前工作”。
各次组装独立读取，不共享查询缓存。查询过滤到期认领和归档记录，但不执行清理；普通列表行为保持原样。
查询失败沿用 DSH 组装错误传播，当前没有错误降级或旧数据回退。

## 身份与作用域

总体说明通过 systemPrompt.section 注册一次，每次请求组装都提供当前内容；工具使用说明由 DSH
ToolRuntime 在同次组装提供。固定说明不作为每轮新增的普通聊天消息注入。
已核对 AgentLoop 的 SystemPromptProjection：提示词内容未变时不追加相同副本，变化时依照连接能力
更新系统消息或追加新版本。每次请求仍占用相应输入空间；长期可见与模型正确遵循是两件事。
固定说明和工具均继承 Sagitta 作用域，配置重载和卸载时共同清理。

模型侧工具说明只描述使用规则：正式任务认领后由系统维护其可用性，模型负责推进和显式状态变更；
临时任务有效期 20 分钟。租约检查时点、续租频率及回收扫描属于内部机制，工具 description 省略这些内容。
实际回收时的结果说明继续保留，帮助模型理解本次操作结果。自动续租的挂载进度见下节。

- deviceId 使用官方 getOrCreateAnonymousUserId()，按 DSH_HOME 持久化；sessionId 来自 exec.agent.id。
  该设备标识属于 DSH 安装环境，复制 home 会复制标识，持久化失败时沿用官方进程内身份行为。
- 需要认领身份的操作缺少 Agent 时明确报错。工具字段只暴露业务参数，显式构造 Service 输入，忽略外部添加的 owner 等字段。
- 工具通过调用方 ctx 注册，继承 Sagitta 预设作用域；其他作用域看不到它们。
- 数据库凭据决定连接权限。设备/会话标识用于协作归属，数据库直连的持有者仍可直接执行 SQL。

## 验证与当前边界

- 使用真实 Cordis、ToolRuntime、SystemPrompt、scope 和 PostgreSQL；Agent 测试替身只提供 ID 与作用域关系，未调用 LLM。
- 覆盖全部工具和状态动作、参数拒绝、身份伪造无效、跨会话权限、到期结果与清理提交、作用域隔离与卸载。
- 初始化测试覆盖配置变更失败后恢复、schema 不匹配关闭连接池、部分注册失败整体撤销及重载恢复。
- 本轮 9 组接入测试通过，覆盖 15 个工具及连续组装无累积、作用域隔离、重载与卸载。业务测试使用随机 schema 并清理，身份文件使用临时 DSH_HOME。
- 固定使用说明、任务数据动态上下文、自动续租与周期回收已挂载。维护入口统一注册会话续租和插件级回收，两者均沿用立即执行、单轮结束后等待 5 分钟的策略；回收全库过期认领，续租只延长本设备已加载会话的有效正式认领至 20 分钟。会话卸载停止其续租，插件卸载停止全部维护；数据库认领保留至到期回收。主动单任务访问继续复用同一回收逻辑。
- 周期回收正式任务时保持静默。临时任务清理后，仅向本设备、当前插件范围内连续加载满 20 分钟的原会话投递 next-step 提示，回显任务 ID、标题、description 等原内容，wakeup=false。初始化的首次成功扫描静默；会话卸载后重新加载、插件配置重载均重新计算在线时长。离线或其他设备的历史清理不补发通知，主动访问仅通过工具原有结果返回。
- 续租重试耗尽时记录原始错误，并通过 DSH next-step 消息提醒对应会话，wakeup=false；下一周期继续尝试。计时、重试和停止继续由已有公共组件处理。
- 本批尚未发布到 stable 或安装到用户运行中的 profile；Web UI 与真实模型选择工具的行为仍待后续验证。
