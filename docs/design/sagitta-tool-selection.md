# Sagitta 官方工具选型讨论

日期：2026-10-26。状态：已确认的工具选择已接入源码并待发布，其余仍为建议。

## 核对范围

- 以已安装 DSH 0.2.1-rc.2 的官方 Web Standard 预设及 base/web 宿主组合为准。
- 官方预设文件：@deepseek-ai/dsh-web-app/presets/standard.patch.yml；相关工具说明读取同版本包内 README 和实现。
- 旧版依据：archive/legacy-2026-10-15/plugins/manager/presets/sagitta/agent.cordis.yml。旧版“启用”只表示配置声明，无法据此证明历史模型实际调用过；“未列”表示该归档预设没有显式登记，宿主当时是否额外提供不作推断。
- 此处列模型工具及直接影响模型上下文、执行行为的支撑插件；底层模型适配器、传输、日志、前端组件不逐一列出。
- 包名统一省略 @deepseek-ai/。下列建议围绕理解、委派、检查、整合和轻量执行；主 Agent 与执行 Agent 的能力清单可分别配置。

## 主动能力

| 插件 | 定位用途 | 官方 Standard / 宿主 | 旧 Sagitta | 建议 |
|---|---|---|---|---|
| dsh-tool-fs | read、read_image、write、edit；读取交付物、写计划、轻量修改 | 启用 | 启用 | 保留；四种工具可分别开关，具体范围再定 |
| dsh-tool-fs-search | glob、grep；找文件和定位文本 | 启用 | 启用 | 保留，方便核对执行者报告 |
| dsh-tool-bash / dsh-tool-pwsh | 执行命令、启动短脚本和进程 | 按平台二选一 | 按平台二选一 | 保留一种，服务于检查和轻量操作 |
| dsh-tool-jobs | 查询后台进程、读取输出、终止进程 | 启用 | 启用 | 与 shell 一起保留；与任务登记分工不同 |
| dsh-tool-web | web_search、web_fetch | 两者启用 | 搜索启用，fetch=false | 已确认两者启用 |
| dsh-tool-ask-user | 结构化询问用户 | 启用 | 启用 | 保留，后续需与无人推进时的等待策略对齐 |
| dsh-tool-present | 将已有文件声明为交付物，供界面呈现 | 启用 | 未列 | 已确认保留 |
| dsh-tool-working-directory | 读取、改变会话工作目录 | 宿主启用 | 未列 | 已确认保留；工作目录变化与项目激活仍须分别处理 |
| dsh-skill-filesystem + dsh-tool-skill | 发现本地技能，按需读取技能指导 | 启用 | 启用 | 保留；优先提供管理、研究、交接类技能 |
| dsh-tool-subagent，provider=spawn | 派独立上下文的 DSH 子 Agent | 启用 | 启用，提示词限制为轻量用途 | 保留为当前委派入口；后续与任务凭据联动 |
| dsh-tool-subagent，provider=fork | 派继承已完成对话历史的子 Agent | 启用 | 启用 | 按需启用，独立任务优先 spawn 以减少携带无关历史 |
| dsh-tool-subagent-control 及 /list-agents | 给可续行子 Agent 发消息、打断、列出状态 | 启用 | 启用 | 保留，与实际委派后端配套 |
| dsh-tool-goal + dsh-command-goal | 会话级目标读写与用户 /goal 命令；配合宿主驱动续行 | 启用 | 未列 | 用户确认 Sagitta 不需要 Goal；处理预设入口时保留其他预设所需的宿主服务 |
| dsh-tool-todo | 会话内步骤清单 todo_write | 启用 | 启用 | 已确认关闭，后续由任务机制考虑步骤能力 |
| dsh-tool-schedule | 创建、查询、修改、删除本会话持久提醒，到时投递后续输入 | 启用 | 未列 | 已接入启用，未来与自主推进对齐 |
| dsh-plan-mode | 规划模式的指导、切换与 exit_plan_mode 审批 | 启用，进入模式后生效 | 启用 | 已确认在 Sagitta 中禁用 |
| dsh-tool-workflow + dsh-workflow-ptc | 用 JavaScript 编排工具和子 Agent | 启用 | 使用 workflow-worker-thread 后端 | 当前沿用官方启用状态，后续与异步执行一起适配 |
| dsh-tool-ralph | 多轮新子 Agent 循环推进 | Standard 未列 | 启用，maxRounds=64 | 暂缓，避免与未来自主推进形成两套循环 |

## 可选扩展

| 插件 | 定位用途 | 官方 Standard / 宿主 | 旧 Sagitta | 建议 |
|---|---|---|---|---|
| dsh-subagent-codex + 委派入口 | 把具体工作交给 Codex | 本版 Standard 未列，验收安装未含该后端 | 启用；另有自研 codex_dispatch | 优先候选；先确认固定版安装和生命周期，后续对主 Agent 保持一个明确入口 |
| dsh-subagent-claude-code + 委派入口 | Claude Code 执行后端 | 本版 Standard 未列 | 委派工具明确禁用 | 有实际使用需求时再加入 |
| dsh-mcp-client / dsh-mcp-resources | 接入外部服务工具及资源 | 资源桥在宿主；具体客户端按配置 | 未列 | 按需，逐个评估服务用途和工具数量 |
| dsh-tool-session-query | 搜索旧会话、读取事件、追溯关联 | 未列；全文索引默认不开启 | 未列 | 记忆模块设计时评估，实验功能；访问范围受相同 cwd 限制 |
| dsh-tool-bash-persistent / pwsh-persistent / terminal | 持久终端和交互进程 | Standard 未列；Minimal 使用持久 shell | 未列 | 首版关闭，交互环境调试交给执行 Agent |
| dsh-tool-str-replace-editor | 另一套查看、创建、替换、插入文件工具 | 未列 | 未列 | 已有 tool-fs 时保持关闭，减少重复入口 |
| dsh-skill-office + dsh-tool-workspace-dependencies | Office 工作流、配套 Python/Node 等运行环境路径 | Standard 未列 | 未列 | 按需给产出文档的执行 Agent，主 Agent 负责要求和验收 |
| dsh-tool-cordis | 只读检查 DSH 运行时 API，辅助插件开发 | Standard 未列；Cordis 预设启用 | 未列 | 给开发/维护会话按需使用 |
| dsh-plugin-manager/tools + dsh-plugin-market/tools | 模型查询、管理插件及使用插件市场 | 明确禁用；Cordis 预设有条件启用 | 未列 | 保持关闭；安装和修改系统由用户审查 |
| dsh-agent-tool-presentation（PTC 模式） | 通过程序化工具调用入口与 SDK 暴露能力 | Standard 使用 native；PTC 预设启用 | 未列 | 先沿用 native；PTC 需另测收益和模型编排稳定性 |

Codex 官方当前文档确认其为独立产品后端，描述为 one-shot 委派；此信息只作方向参考，不据 master 文档推断 0.2.1-rc.2 的兼容性或可续行能力：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-codex/README.md 。

## 上下文与执行支撑

| 插件 | 用途 | 官方 Standard / 宿主 | 旧 Sagitta | 建议 |
|---|---|---|---|---|
| dsh-persona | 身份与职责提示词 | 启用 | Sagitta 定制内容 | 保留自定义 Sagitta 身份 |
| dsh-agent-instructions | 读取 AGENTS.md、CLAUDE.md 等工作区指引 | 启用 | 启用 | 保留；主 Agent 关注管理约定，执行 Agent 获取目标项目约定 |
| dsh-time-context | 注入当前时间信息 | 启用 | 未列 | 已确认保留 |
| dsh-compaction-basic + dsh-command-compact | 自动上下文压缩和用户手动压缩命令 | 启用 | 启用 | 保留；压缩与长期经验存储分开负责 |
| dsh-compaction-tool-result-pruner | 缩短过长工具结果进入后续上下文的内容 | 启用 | 启用，阈值 8192 字符 | 保留；重要依据通过文件、记忆等持久来源保存 |
| dsh-compaction-image-offload | 图片超出预算时卸载图片内容并重试 | 宿主启用 | 未列 | 保留宿主默认能力 |
| dsh-repeat-tool-reminder | 重复调用达到阈值时提醒模型 | 宿主启用 | 未列 | 保留，辅助发现空转 |
| dsh-tool-call-timeout-policy | 单次工具调用超时控制 | 宿主启用 | 未列 | 保留，继续复用 DSH 原生支撑 |

## 接入时需要保持的边界

- 用户明确 spawn、fork 和子 Agent 控制三组能力后续与异步执行一起适配，属于核心能力；现阶段没有确认删除这些能力。
- Shell 官方按 DSH 进程的 process.platform 二选一：win32 使用 pwsh，其余使用 bash；未检测用户登录 Shell，也未在命令缺失时自动切换。
- Schedule 存储绑定原会话的提醒；DSH 运行时投递，关闭期间无法执行，重启后周期提醒仅处理最近一次遗漏。投递记录确认消息进入会话，不保证业务执行成功；与 task 的工作登记保持分工。
- Workflow 已支持模型提交 JavaScript，使用 agent、parallel、pipeline 等钩子编排子 Agent，支持前台等待和后台 job。当前沿用 Standard 的启用状态与 provider=spawn；动态脚本不能自行选择 Codex 后端。官方指导限定用户明确要求 workflow 或大规模编排时使用；尚未接 Sagitta 任务凭据与异步执行。

- 已发布 v0.1.0 从完整 Standard 组合起步；源码新增 officialPlugins 默认选用白名单。首次组装按白名单选择，已有安装保留用户配置及旧版条目。发布后需要手动更新 Updater 本体。
- Goal、Todo、Schedule 的数据职责分别是会话目标、步骤清单、提醒；它们并非天然等同于 sagitta-task 的项目、任务和认领。是否开放取决于能否清晰分工。
- 减少工具选择与提示词负担，不等同于禁止全部本地执行；也不等同于安全隔离。只要保留 shell，单独关闭文件写工具无法形成文件写入权限边界。
- 主 Agent 的工具清单与子 Agent 的预设应分别核对，不能假设关掉主 Agent 工具后，执行 Agent 仍自动持有这些能力。
- Updater 保留非托管条目。officialPlugins 仅选择默认组合，沿用官方配置和平台条件；Goal、Todo、Plan 不进入默认组合，也不强制禁用用户已有条目。子 Agent/Workflow 嵌套配置、其他预设的宿主服务保持原样。
