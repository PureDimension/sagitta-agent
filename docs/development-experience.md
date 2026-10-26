# 项目开发经验

本文件保存可复用的开发经验与当前约定；模块设计细节仍保留在对应文档中。

## 2026-10-20：固定策略与用户配置

- 用户已确认：Updater 固定跟随 `stable`；其他版本选择留待具体需求出现后设计。
- 之前添加 `config.branch` 允许切换分支，超出了当前需求，现已移除。
- 固定策略集中放在有意义的常量中，方便审查和修改；按用户最新审查意见，模块级常量沿用 camelCase，更新分支使用 `const updateBranch`，日志与 Git 拉取共用它。Cordis 需要读取的 `static inject` 保留为框架约定字段。
- 配置 schema 的默认值适用于用户可以覆盖的配置项；固定策略用常量表达。
- 避免把未来可能有用的可配置能力提前加入实现；也避免把同一策略值散落在执行代码里。

## 2026-10-20：TypeScript 与 DSH 接入

- 用户已选择 TypeScript。当前 Updater 和 memory 空占位插件均使用 TS。
- `plugins/updater/src/index.ts` 是维护和审查入口；编译产物集中在 `plugins/updater/dist/`，`package.json` 的入口指向 `dist/index.js`。
- 用户已确认源码分发方案：GitHub 仅提交源码，`dist/` 在本地生成并由 Git 忽略；先前提交产物的约定已替换。
- 手动运行 `python3 scripts/install-updater.py` 时，先校验 DSH 精确版本，再安装依赖、编译 updater 并通过官方命令装入 `web` profile。用户要求安装入口使用 Bash 或 Python，当前选用 Python 标准库实现。
- Updater 启动后拉取 `stable`，在提交变化或业务插件入口缺失时安装构建依赖并编译；构建成功才记录提交。业务构建兼容当前 `stable` 的旧 JS 版本无 `build` 脚本。
- 用户指出源码与产物混放会妨碍阅读：原顶层 `index.js` 已迁入 `dist/`，以后生成文件也应有明确的产物目录。
- 类型由 TS 源码维护。2026-10-21 共用数据库模块被任务模块引用，构建开始在 shared/dist 同时生成 JS 与 .d.ts，避免消费方将共享源码纳入自己的 rootDir；声明文件属于忽略的编译产物。
- 依赖 DSH 的接口优先使用官方类型，框架接入方式同时核对当前安装版本的实现。
- 类型声明、`as` 和非空断言只影响编译检查。外部输入的运行时校验需要单独判断与实现。
- 编码以 Google TypeScript Style Guide 为参考，DSH 框架要求作为明确的适配例外；当前格式检查工具尚待接入。
- 参考：https://google.github.io/styleguide/tsguide.html

## 2026-10-20：编辑器和编译器的类型环境

- 本机项目编译器为 TS 5.9.3，VS Code 内置 TS 6.0.3；使用后者复现了 `node:path` 等模块的 `ts(2591)`，即使 updater 已安装 `@types/node`。
- TS 6 默认 `types` 为 `[]`。Node 插件在 `tsconfig.json` 显式声明 `"types": ["node"]`，使编辑器与构建工具都能加载 Node 类型；版本差异导致的问题需同时验证两侧。
- 修正后项目 TS 5.9.3 检查及编译通过，VS Code 内置 TS 6.0.3 的诊断从 16 条降为 0。Python 安装脚本通过语法及命令替身测试，覆盖版本拒绝、构建和安装顺序、构建失败停止及命令缺失提示。
- 参考：https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html

## 2026-10-20：审查与验证

- 用户需要掌握实现：分小批次改动，解释实际代码及文件关系，审查通过后继续。
- 用户补充：修复已有问题可一次完成，不受约 150 行限制；新增功能继续小批次审查。文件编辑全部通过 Codex 的 apply_patch 工具进行，保证变更在界面可见，禁止使用 Python/Shell 脚本直接改写文件。
- 控制复杂度依靠缩小改动范围和明确职责，代码保留清晰的命名与排版。
- 用户允许并希望合理的中文注释，重点解释框架约定、数据来源、处理原因和生命周期；审查反馈指出条件对象展开、初始化中的局部执行器和过长的初始化流程增加了阅读负担，后续结构调整应先说明再逐批审查。
- 解释接口时同时说明调用者、触发时点、输入来源和结果去向；遇到具体代码问题，按用户当前关注点解释。
- 修改 Updater 后，在其目录运行 `npm run check` 和 `npm run build`，保持源码与编译产物一致。
- 验证记录应明确边界：TS 迁移已通过类型检查、编译和打包内容检查；启动流程测试使用本地 Git 来源及预设注册替身，验证了提示词、memory 加载与失败处理。
- 本地构建改造已用真实 Git/npm/tsc 验证首次编译、相同提交跳过、入口缺失重建、新提交重建、编译失败、旧 JS 版本兼容和 DSH 版本拒绝；预设注册使用替身。安装脚本用命令替身验证版本检查先行、顺序及失败停止，正式 profile 安装和 Windows 执行仍待验证。
- 当前 TS 迁移处于本地待审查状态，实际 DSH 重装启动仍待审查后验证；后续验证完成时更新此条。
- 逐行核对确认：DSH 的 `agentPresets.register()` 会将部分激活失败保存为预设诊断并正常返回；当前 `prepared` 日志只表示注册调用已返回，完整可用性须另查预设诊断。
- 当前构建缓存检查提交编号和入口文件存在性；依赖完整性、入口内容及间接引用文件的有效性仍由后续加载发现。命令失败包装目前只保留退出码或信号，编译器的详细 stderr 尚未输出，这些是现有实现边界，后续修改需审查。

## 2026-10-20：更新和发布边界

- 开发分支使用 `main`；`stable` 承载确认可用的发布版本，发布应经过明确确认。
- Updater 手动安装；当前职责为启动时取得 Sagitta 内容、检查 DSH 精确版本、在本地编译业务插件并注册预设。
- DSH 本体升级、Updater 自更新、memory 初始化和迁移留待各自需求与实现审查。
- 代理处理保留 Git 自身的配置优先级，继承启动环境；此前强制覆盖 Git 代理优先级的实现已按用户意见撤回。
- 保留用户修改的提示词及无关的本地变更；凭据通过本地配置提供。

## 2026-10-20：任务重写的边界

- 用户要求先理解旧版，再确定共用底层模块；参考设计意图并清理历史兼容负担。
- 用户希望任务存储独立、连接可配置，支持数据库迁移位置及远程访问；2026-10-21 已确认直连，当前方案按 PostgreSQL 设计。
- 区分同引擎搬家与更换引擎，后者需要存储适配及数据迁移，不能承诺改地址即可兼容。
- 本轮研究与待审建议记录于 [任务机制讨论](design/sagitta-task-discussion.md)，尚未实现。
- Updater 常量更名为 `updateBranch` 后，类型检查及编译通过；运行逻辑保持原样。
- 顶层讨论应区分用户已确定的目标与待确认语义：紧急路径跳过任务校验及任务数据库访问；2026-10-23 用户取消临时凭证方案，改为执行插件按次选择绿色通道，后续接入时实现。
- 用户要求任务执行记录暂缓，并指出同步操作逐次绑定不灵活；随后也要求暂缓低频复查，先设计项目、任务、认领及插件接入底座。推进质量判断留待后续，避免把上一轮候选方案默认纳入首版。
- 已确认能力为原六项（项目列表、任务列表、创建任务、任务详情、修改任务内容、任务状态变更）加项目创建、编辑说明、删除；2026-10-21 补充项目详情和任务删除，共十一个入口。创建按参数区分正式/临时，状态操作包括认领/释放/完成/阻塞/取消。
- 自动能力为按设备和会话续租正式任务认领，以及上下文注入；temp 不续租且到期清空。紧急执行通过后续绿色通道提供。正式任务与步骤的登记边界仍在讨论。
- 解释 DSH 工具可见性时区分插件注册、每次模型请求的上下文组装、长期记忆存储及缓存。本机 0.2.1-rc.2 的提示词与工具定义由框架组装，仍占模型上下文。
- 用户要求任务有固定递增序号和标题；临时任务与正式认领共用到期字段，并对 AI 和用户隐藏。合并字段时仍须区分任务类型的处理语义，避免续租临时任务或释放时丢掉清理期限。
- 后续用户明确要求独立 task_claims 表存认领及 TTL，有效认领查询仅访问该表。已确认 temp 释放或到期直接删除任务和认领，expires_at 只保存在认领表；此前提议任务表另存 temp_expires_at 已撤回。批量续租关联任务筛选 normal，任务/项目状态变更须事务性撤销认领。

## 2026-10-21：数据库边界讨论

- 区分数据库访问方式、应用表结构维护与数据库进程运维。插件直连与维护 schema 可以同时成立。
- 用户已选择直连并认可独立初始化脚本；当前按 PostgreSQL 设计。下一步先审表结构，再写部署/初始化脚本及插件本地/远程连接配置和默认启动检查，具体目标位置及部署方式待确认。
- 独立 HTTP 服务可集中业务规则并隔离表结构，但增加部署和协议维护；后续迁出仍有实际适配工作，不能承诺零成本替换。
- 已核对 Hindsight 官方 DSH 插件的 external/daemon 路线：插件调用 HTTP，daemon 启动由共享包负责，数据库迁移由后端负责。用户体验上的少步骤依赖这些已有实现；不能据此宣称独立脚本或数据库服务只能选择其一。来源与版本记录于任务设计文档。
- 用户已明确本地数据库按需启动，拒绝开机/登录自启动。直连与按需管理进程可以同时成立：本地受管实例检查后启动或复用，外部实例按配置连接。具体启动时点、退出策略及并发启动协调待设计；当前仅记录决定。
- 表字段、按需启动配置和模块划分汇总到 [存储设计草案](design/sagitta-task-storage.md)。用户已授权本地建库及安装脚本；本批实现数据库初始化，DSH 接入和任务服务待后续审查。
- 用户再次确认 PostgreSQL，要求脚本不校验 PostgreSQL 软件版本；当前默认下载 18，由 PostgreSQL 自身处理数据目录兼容性。应用 schema 的初始化版本记录继续保留。当前安装入口为 macOS/Homebrew，Windows 适配待实现。
- 已在 macOS 创建 PostgreSQL 18.6 本地实例，地址 127.0.0.1:55432/sagitta_tasks，数据位于 ~/.local/share/sagitta/task-db。脚本与 SQL 共 138 行；未设置开机/登录自启动。下载缓慢时本次命令使用清华 Homebrew 镜像，脚本保留默认源。
- 真实验证通过：重复初始化保留版本及业务数据、停止后重新运行脚本启动、单任务认领唯一约束和双客户端竞争、外键/类型约束、仅正式任务的续租 SQL、过期查询及任务删除级联认领。临时验证库已删除，正式业务表为空、schema 版本为 1；状态迁移/续租/清理的插件自动能力尚未实现。

## 2026-10-21：任务插件架构提案

- 用户要求先规范架构，以便扩展与稳定运行；本轮仅提出 [架构方案](design/sagitta-task-architecture.md)，尚未新增插件运行代码。
- 根据本机 DSH 0.2.1-rc.2 核对，可复用工具注册、执行前门禁、section/context、会话生命周期和可释放定时器；公开任务服务与 DSH 适配分开。
- 同一业务事务共用数据库连接；本地事件不能承担跨设备一致性，权威认领通过数据库查询。数据库不可用时紧急路径仍须独立可用。
- 用户已同意模块化单体加 Controller/Adapter、Service、Repository 分层，借鉴 Java 后端及 Spring Modulith 的模块边界，继续使用 TS/DSH；主动工具与自动触发在接入层平级组织，共用 Service 规则。
- 用户要求优先规范错误、审计、通知、事务锁及回滚，依据是旧项目基础能力缺失造成维护困难。新增待审方案见架构文档：统一操作上下文/错误/日志、事务助手、关键变更审计及去重、必要联动持久投递；尚未新增表或运行代码。操作审计与此前暂缓的详细执行流水分开界定范围。
- 已确认基础设施归属：共享基础库复用机制，插件负责业务状态、事务范围与恢复，DSH 负责装配与生命周期；Manager 可按实际需求汇总管理信息。共享代码、运行时服务和跨存储一致性须分别说明，避免把引入 Manager 等同于自动获得可靠性。
- 用户明确实验性个人助手优先扩展性、可修复性，基础支撑尽量从插件核心提取；可接受明确失败和紧急模式修复。首版建议保留错误/日志、事务、关键审计、配置身份与生命周期辅助，暂缓持久去重和完整可靠投递；具体清单待审，尚未编写运行代码。公共模块负责机制，业务事务范围和恢复规则仍由插件声明。
- 用户要求基础支撑优先复用 DSH。核对本机 0.2.1-rc.2：原生日志支持命名/级别/堆栈/cause/exporter，工具异常会转成 isError，HarnessError 可携带结构化错误码；先评估复用再写公共错误适配。普通 interval 回调不等待异步操作，需自行防重叠及处理拒绝。通用日志落盘/轮转与后端通用用户通知入口尚未确认，不能承诺框架已代办；详见架构文档。

## 2026-10-21：核心逻辑与支持逻辑的分离

- 用户明确要求已写入 AGENTS.md：功能块空行分隔；核心路径简洁、单一、可追溯，状态机相对扁平，影响范围小；禁止自行增加兼容或未设计路径，必要扩展须先取得许可。
- 支持逻辑轻量且尽量复用公共组件，业务相关支持行为优先显式注册/回调；保持事务范围和执行顺序可审查。
- 用户纠正：续租是任务业务；日志和错误返回优先直接使用 DSH。当前建议取消独立错误框架与操作关联模块的首批计划，从最小数据库支撑开始。
- 本机静态核对：dsh-anonymous-user-id 提供 DSH_HOME 级 UUID，服务遥测/反馈；写入失败可返回非持久 ID，并发首次创建也有已注明的短暂分歧。作为认领设备身份尚待确认，不等同于硬件 ID；未读取实际标识文件或改变身份。
- 最小数据库模块首批审查后用户允许继续：shared/database.ts 遵循 node-postgres 官方 Pool/事务用法，依赖 pg 8.23.1；DSH 日志由回调提供。接口为 openDatabase、query、transaction、close；业务 SQL/迁移/续租仍由插件负责，尚未接入 DSH 生命周期。
- 用户强调异常处理遵循行业与驱动既有做法，接受个人实验项目的可靠性边界；不能因提交断连等情况自行扩展恢复系统。保留原始错误、合理回滚与释放连接即可，额外业务状态、结果确认服务和补偿机制须另行设计确认。
- 数据库首批验证：npm run check/build 通过；真实 PostgreSQL 临时表验证成功提交、SQL/业务异常回滚、原始错误保留、单连接池释放复用和关闭后拒绝查询。运行时模块 66 行，编译产物位于忽略的 shared/dist；测试配置通过 SAGITTA_TEST_DB_CONFIG 指向本地凭据文件，不输出凭据。原数据库已按需启动，测试结束后服务保持运行；后台断连、回滚失败及 DSH 接入尚未验证。
- 用户纠正：支持逻辑应尽早提取，不能记为“复杂后再提取”。当前数据库模块的局部嵌套 try/catch 因作用范围小、没有其他关联且拆分设计尚无明确收益，暂时保留；此决定不改变其他模块尽早提取支持逻辑的原则。
- 第二批用户已认可并允许继续：任务 contracts/schema/repository 提供 Project 类型、应用 schema 版本 1 检查、项目列表及详情读取。Repository 仅依赖 query，可接收共用数据库实例或事务连接；驱动错误原样传播。列表过滤归档，详情后来按下述统一三态契约调整。类型检查、构建及真实 PostgreSQL 测试通过，DSH 工具和生命周期尚未接入。
- 第三批用户已允许继续：Repository 新增项目创建、仅修改说明的方法；项目操作提供列表/详情/创建/编辑的业务入口，拒绝空名称，并把缺失/归档项目转换为不同 Error。编辑使用同一 SQL 锁定项目、判断归档、写说明和 updated_at、返回三态结果。类型检查和真实数据库测试通过，覆盖引号/多行参数、默认与清空说明、更新时间及归档/缺失拒绝。未修改 schema，未实现项目删除或 DSH 接入。
- schema 版本表示应用结构变化；迁移增加时须同步更新初始化/迁移入口及 schema.ts 的预期记录检查。例如新增版本 2 后记录为 [1, 2]，不能仅把当前常量改成 2 并继续要求恰好一行。本次增加数据访问方法保持版本 1。
- 用户明确 Service 是业务层目录，并接受 service/operations/ 放具体操作、后续 service/automation/ 放自动业务流程的划分。现有项目操作迁为 service/operations/project.ts，类名 ProjectOperations；新增任务操作为同目录 TaskOperations。AI 主动工具与后台自动触发共用此层，提示词注入、工具注册和触发时点放在 adapters/ 接入模块。
- 本阶段目标为完成数据库访问与 operations，仍按小批次审查；每批明确说明操作除了 SQL 写入以外执行了哪些校验、状态规则和协调行为。
- 第四批新增 Task 视图及任务列表/详情/正式任务创建。列表过滤归档，详情按下述三态契约返回；正式任务创建拒绝空标题，默认空说明。后续调整为固定 open 创建，立即认领调用完整 claimTask 转为 in_progress。数据库 bigint ID 保持字符串，结果不暴露期限和认领字段。类型检查、构建和真实 PostgreSQL 测试通过，已补充并发归档的编辑/创建验证；DSH 接入及其他操作留待后续审查。用户要求删除 temp 到期查询过滤，按下述回收规则简化。

## 2026-10-21：租约到期与查询语义（已确认）

- 用户询问是否有必要在查询时推导到期状态。核对 BullMQ 官方文档：worker 的 stalled 检查负责把失去锁的 active 任务转回 waiting 或 failed；状态回收有检查周期。参考：https://docs.bullmq.io/guide/jobs/stalled 和 https://docs.bullmq.io/patterns/manually-fetching-jobs 。
- SQS 官方契约是 visibility timeout 到期后消息重新可接收；此文档不证明它内部在普通查询时重写状态。参考：https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html 。
- 用户已确认回收规则：事务内将正式任务恢复 open 并撤销过期认领、将 temp 连同认领删除；列表读取存储状态，接受回收前的短暂延迟。2026-10-24 单任务访问增加立即回收，详情随之改走统一入口；启动及周期批量回收仍待实现。
- 有效认领校验仍必须按数据库时间检查 expires_at，使用该认领执行的状态写入也须原子检查凭证与期限；回收延迟不应延长操作权限。先前“查询必须立即映射状态”的建议属于可选契约，并非成熟实现的必要条件。
- 本次简化已通过类型检查、构建及两组真实 PostgreSQL 测试；调整既有用例确认 temp 认领到期后列表与详情仍返回原存储结果，归档过滤继续生效。
- 用户进一步要求：任务详情分别提示“不存在”和“已归档”。temp 被回收删除后统一提示不存在；到期通知由后续自动流程提醒 AI，查询阶段继续直接读取存储结果。
- 用户纠正并批准：Repository 的返回契约应直接截断归档内容，且须覆盖所有相关操作。已统一为 RepositoryResult<T>：found 在 value 携带数据，archived/missing 只含状态；覆盖项目详情、项目编辑、任务详情及正式任务创建。service/require-found.ts 统一生成“项目/任务不存在”或“项目/任务已归档”。任务自身或所属项目归档均返回 archived；列表继续过滤归档。数据库行及归档布尔字段止于 Repository 内部。
- 三态契约验证通过：类型检查、构建及真实 PostgreSQL 测试覆盖 found/missing、任务自身归档、所属项目归档、temp 到期仍可见及物理删除后不存在；精确断言 archived/missing 仅含状态字段，Service 错误消息分别匹配。此次全部文件编辑使用 apply_patch。
- 审查纠正：修改一类错误语义时，要沿调用链覆盖读取和写入的所有相关入口；此前只改任务详情，遗漏项目详情/编辑及创建任务的项目检查，现已全部补齐。写入通过行锁和同一 SQL 分类，避免失败后另查造成判断时点偏移。并发归档测试验证编辑和创建在等待锁后正确返回归档，归档正文及关联任务保持原样。

## 2026-10-21：创建正式任务后立即认领

- 用户新增并已实现：创建正式任务支持 options.claimImmediately，默认 false；true 时内部调用须提供 owner.deviceId/sessionId，后续 DSH 工具仅暴露布尔选项并从运行环境填充身份。创建与认领使用同一事务，任一步失败整体回滚。
- 用户已确认正式认领有效期 20 分钟，后续每 5 分钟自动续租。当前只实现首次租约，自动调度与有效认领校验仍属后续批次。
- 初版 TaskOperations 持有 Database 并构造 Repository；用户指出这增加了 Service 对数据库支撑的直接依赖。2026-10-23 经讨论授权抽取事务执行器，现由外部注入查询 Repository 与 TransactionRunner，具体见下文。
- 类型检查、构建及四组数据库测试通过：默认创建无认领、立即认领身份/20 分钟期限、认领约束失败时任务回滚、归档/缺失项目两种创建模式均拒绝、并发归档等待后无额外任务或认领。测试通过连接级临时表及随机命名测试 schema 隔离，结束时清除，应用 schema 保持版本 1。

## 2026-10-21：参考 TradeFlow 的事务分层（方案讨论）

- 已按用户要求只读检查本机 /Users/cyan/Documents/TradeFlow/backend，参考当前 AGENTS.md、docs/coding_standards.md、docs/architecture.md 及审批提交源码。当前明确采用 Controller → Facade → Service → Repository，默认在 Facade 声明事务，内部 Service 负责规则与持久化编排；与本机 Spring 技能较早版本的“事务放 Service”建议有差异，当前仓库证据优先。
- 实例：ApprovalSubmissionFacadeImpl.submit 使用 @Transactional，调用 ApprovalSubmissionService.prepare/create；create 依次写入审批实例、步骤、审批人、任务和操作记录。ApplicationException 继承 RuntimeException；按 Spring 默认规则，异常传播越过事务代理时触发回滚。普通错误结果不会自动触发我们的事务助手回滚，requireFound 必须在事务内把失败标记转换为异常。
- 当时提出事务执行器方案，2026-10-23 用户已授权实施：业务层划定原子操作范围，回调只接收已绑定事务的 Repository；连接获取、Repository 构造、提交/回滚及释放由支持代码负责。多个 Service 需要组合时再讨论外层 Facade 的明确边界；当前不引入代理、装饰器或隐式事务上下文。
- 调研当时仅记录方案。参考 Spring 官方回滚与事务代理说明：https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/rolling-back.html 、https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html 。

## 2026-10-23：任务事务执行器

- 用户已审查通过事务执行器，允许继续下一批数据库与 operations 实现。
- 新增 plugins/task/src/transaction.ts：TransactionRunner 声明泛型回调接口并提供事务 Repository。曾改为提供另一个 TaskService，用户要求回退双层结构后恢复。任务专属组装留在插件内，通用事务机制继续复用 shared/database.ts。
- TaskOperations 通过构造参数接收查询 Repository 和执行器，同一个 Service 类的方法直接调用其他完整业务方法；通过显式复用事务执行器共享事务。DSH 装配仍待后续实现。
- 复杂业务可以共用一个数据库事务，前提是所有数据库操作使用该事务连接。外部 API、文件和通知的一致性需另行设计；本批仅抽取现有支持逻辑。
- 验证通过：类型检查、构建及四组真实 PostgreSQL 测试，包括认领失败整体回滚、20 分钟租约和并发归档拒绝；git diff --check 通过。本地数据库按需启动供测试，测试后保持运行，未设置开机自启动。

## 2026-10-23：修改任务说明

- 按已确认的说明编辑范围实现 updateTask(taskId, description)，允许空字符串清空，只修改说明与更新时间。初版采用单条 CTE；用户审阅后同意优先可读性，现改为显式事务：Repository.lockTask 依次锁定项目和任务、返回三态结果，Service 用 requireFound 确认可用后调用 updateTaskDescription。归档内容仍在 Repository 边界截断。
- 首批仅调整事务结构，表结构保持版本 1。认领者权限随后已确认并在下述编辑权限批次实现；标题编辑不在已确认范围内。
- 验证通过：类型检查、构建、四组真实数据库测试；覆盖说明含引号/换行、清空及更新时间、缺失或归档拒绝、归档内容保持、项目并发归档后任务编辑准确拒绝。收紧并发错误消息断言后任务测试再次通过，git diff --check 通过。

## 2026-10-23：补齐主动业务接口的实施范围

- 用户要求补全 Repository + Service 的 11 个主动接口，继续遵守逐批审查约定。当前项目/任务列表、详情、创建、编辑、删除，以及五个状态动作的 Repository/Service 业务能力均已实现；DSH 工具注册和自动能力另行实施。
- 多步骤业务优先使用显式事务与简单 SQL，按已同意的方向先调整任务编辑。lockTask 与后续写入必须使用同一事务 Repository；当前设计中任务所属项目不可修改。
- 用户补充：每次只实现一个主动接口，说明并审查后继续。当前批次只拆分任务编辑的事务与 SQL；类型检查、构建及四组真实数据库测试均通过，并发归档拒绝及原有读写行为保持。
- 已确认删除规则：正式任务软删除归档，temp 物理删除；项目删除时归档项目及其正式任务、清除 temp、撤销全部认领。
- 已确认任务权限：已认领任务的说明修改、释放、完成、阻塞、取消和删除，仅当前认领设备与会话可执行；未认领任务允许任意会话编辑、取消、删除。2026-10-24 过期访问改为立即回收并返回到期结果，本次原操作停止；原有等待周期回收的路径被替换。
- 已确认并实现正式状态流转：open/blocked 可认领为 in_progress；in_progress 可释放为 open、完成为 done、阻塞为 blocked，均撤销认领；open/in_progress/blocked 可取消为 cancelled；done/cancelled 不重开。temp 从 in_progress 释放、完成、取消时直接清除，阻塞报错。

## 2026-10-23：完整认领能力与事务组合

- 用户要求 Service 提供完整认领、完成、阻塞、释放等业务能力；组合流程调用这些能力，避免直接拼接其他业务能力的 Repository 写入。已先实现 claimTask，其他状态动作后续逐项实施。
- 用户纠正并要求回退重写：当前只做 Service/Repository，不能为了组合创建与认领新增里外两层 Task 或 Facade；对外 AI 接口属于后续 DSH 适配。已撤回 TaskService 类及其装配，重写为 TaskOperations 内完整的创建与 claimTask；创建入口随后统一为 createTask。
- 当时 claimTask 通过 reuseTransactionRunner(repository) 复用创建事务。2026-10-24 统一入口改造后直接向内部 claimTask 传入当前事务 Repository，删除该辅助；创建继续复用认领业务，失败由外层整体回滚。
- 重写后类型检查、构建及五组真实数据库测试通过：独立/创建后认领、重复和过期未回收认领拒绝、非法状态/归档/temp 拒绝、blocked 认领、两设备竞争及两种失败回滚。该认领批次已获用户认可；编辑权限在下一批补齐，尚未接入 DSH。

## 2026-10-23：任务说明编辑权限

- updateTask(taskId, description, owner) 增加必填内部调用身份；同一事务内锁项目/任务、锁认领、检查权限、更新说明。调用身份未来由 DSH 运行环境提供。
- Repository.lockClaim 返回内部 TaskClaim（设备、会话、数据库时间判定的 expired）；service/require-task-write-access.ts 集中判断：未认领允许，过期拒绝并等待回收，有效认领要求设备和会话同时匹配。
- 类型检查、构建及五组真实数据库测试通过：未认领编辑、本人编辑、不同设备/会话拒绝、过期拒绝及拒绝后原说明保留。该批仅补编辑接口，其他状态操作及删除尚待逐项实现。

## 2026-10-23：统一创建与参数排版

- createTask(input) 统一正式、临时创建，返回 Promise<Task>。正式任务可立即认领，temp 必须自动认领；两者先创建 open，再在同一事务内调用完整 claimTask。认领失败整体回滚。
- 用户确认 temp 固定 20 分钟，使用 const；当前与正式认领共用 claimLeaseMinutes，不增加时长配置或兼容入口。续租与回收尚待实现。
- 用户审查后取消紧急分支与 EmergencyTask：随机编号没有提供任务信息，却增加调用方特判。后续由执行插件按次显式选择绿色通道，跳过任务校验及任务数据库访问，无需任务 ID，也不授予项目记忆库权限。本批仅删除创建分支、类型和对应测试，绿色通道尚未实现。
- 用户确认：仅声明处逐个参数换行，涵盖函数、方法、构造函数、回调及函数类型；单参数也换行，无参数保留空括号。调用实参保持现有格式。当前维护的源码、测试及 Python 脚本已统一，归档历史保留原样；规则同步 AGENTS.md。
- 本批根目录及 updater 类型检查、构建通过，七组测试全部通过（六组真实 PostgreSQL、一组紧急路径存储访问禁止测试）；两个 Python 脚本语法检查通过。格式修改经 TS AST 对比确认结构保持一致，嵌套函数类型缩进另经检查修正。
- 紧急创建移除后重新验证：根目录类型检查、构建及剩余六组真实 PostgreSQL 测试全部通过，git diff --check 通过；任务源码与测试已无 EmergencyTask/emergency 引用。

## 2026-10-23：项目与任务删除

- 用户要求本批实现两个删除入口，并再次确认正式任务软删除、temp 物理删除；项目删除归档项目及正式任务、清除 temp、撤销全部认领。
- deleteTask(taskId, owner) 事务内锁项目/任务和认领，复用 requireTaskWriteAccess 检查设备、会话及有效期；撤销认领后按类型删除。未认领允许删除，已过期认领等待回收。
- ProjectOperations 新增注入 TransactionRunner；deleteProject(projectId) 先通过 lockProject 取得项目排他锁并检查三态结果，再执行项目范围的批量清理与归档。项目生命周期删除统一撤销全部会话的认领；任务写入持有项目共享锁，与删除互斥。
- 两个入口返回 Promise<void>，任一步失败整体回滚。归档数据的隐藏沿用 Repository 契约：列表排除归档，详情仅返回 archived，Service 提示已归档；原始 SQL 仍可读取归档行。物理删除的 temp 返回不存在。
- 类型检查、构建和六组真实 PostgreSQL 测试通过，补充删除权限/过期拒绝、归档不可见及正文保留、项目级清理与其他项目隔离、缺失/重复删除、删除中途失败回滚及并发项目归档等待后拒绝。应用 schema 保持版本 1，DSH 接入与自动回收尚待实现。

## 2026-10-23：事务执行器命名与权限检查边界

- 用户指出执行器已同时用于项目和任务操作，名称应体现共同职责；现统一为 TransactionRunner、createTransactionRunner、reuseTransactionRunner，源码、测试和设计文档同步，事务行为保持原样。类型检查、构建及六组数据库测试通过。
- requireTaskWriteAccess：无认领直接通过，有认领须租约有效且设备/会话匹配。任务存在性和归档状态由 lockTask/requireFound 检查；该函数仅检查认领权限，状态动作各自校验状态与所需认领。用户明确保留该函数名称和表达，未采用曾建议的 requireUnclaimedOrOwned 更名。

## 2026-10-23：五个独立状态动作

- 用户纠正：状态机仅用作展示、审查流转规则；代码保留 claimTask/releaseTask/completeTask/blockTask/cancelTask 独立函数，各自声明起始状态与变更。状态表记录于任务架构文档。
- 本批补齐后四个动作，成功返回 void；认领继续返回 Task，供创建后立即认领使用。共用 withClaimedTask 负责事务、锁、确认存在有效的本人认领；释放/完成/阻塞使用它，取消自行声明允许未认领的权限路径。requireTaskWriteAccess 保持原样。
- 后续待设计：参考 legacy 的完成前检查，以及阻塞信息登记、额外处理与联动。具体字段、规则和调用顺序须单独审查；本批仅记录待办。
- 类型检查、构建及七组真实 PostgreSQL 测试通过。新增覆盖四个动作的正式流转、临时清理、身份/过期/终态拒绝、未认领取消、阻塞后重新认领，以及撤销认领后的状态更新或物理删除失败时整体回滚。
- 用户已审查认可本阶段并要求本地提交：11 个主动接口对应的 Repository/Service 业务能力完成；DSH 工具注册、自动续租、到期回收与上下文注入仍属后续接入工作。

## 2026-10-23：自动机制接入前的工具说明核对

- 本机 DSH 0.2.1-rc.2 源码核对：defineTool 接收 description/parameters，tools.register 注册；systemPrompt.assemble 收集工具 schema，agent-loop 将 tools 纳入模型请求。插件负责编写说明，框架负责传递，工具说明无需重复手工追加到对话历史。
- 默认 native 模式以请求 tools 字段提供工具；ptc 模式由框架生成 tools:sdk 提示词区，并提供 run_code。工具说明的模型呈现由模式决定，不能概括为固定插在上下文最底部。
- 当前任务清单、认领状态和临时任务到期提醒属于动态运行信息，需要插件提供。用户明确希望临时任务到期后注入提示；续租、回收和提示投递的具体接入尚未实施。
- 用户要求正式续租先讨论插件行为和代码组织；提案已记录于任务架构文档，尚未编写运行代码。核对本机 DSH 的存活 Agent 列表、创建/销毁事件及 Cordis 定时器；会话空闲是否继续续租按已有“插件存活自动续期”意图建议保留，具体接入待审查。

## 2026-10-23：正式认领的单次批量续租

- 用户批准先实现 Service/Repository。TaskRenewal.renewClaims(deviceId, sessionIds) 接收接入层提供的会话列表，空列表直接返回 0，其余交给 Repository，返回实际续租数量。
- Repository 单条 SQL 筛选有效的正式、进行中、未归档项目/任务认领，匹配设备和会话。按任务 ID 顺序锁定候选认领，更新时复查 claim_id 与有效期，避免等待锁时已过期的认领被延长。到期时间取数据库当前时间加 20 分钟，沿用 claimLeaseMinutes；任务内容、状态和 updated_at 保持原样。
- 单条 SQL 由数据库保证原子性，无额外事务包装、重试或局部错误吞掉。临时及过期认领保持原样；自动调度、DSH 生命周期、回收与提醒仍待实现。
- 类型检查、构建及八组真实 PostgreSQL 测试通过；新增覆盖设备/会话筛选、临时/过期/归档/非进行中排除、连续续租不累计时长、任务及认领身份保持、空会话不访问数据库和错误传播。续租锁等待及并发回收的交互尚未专项测试；git diff --check 通过。

## 2026-10-23：Repository 按职责拆分

- 用户要求将 repository.ts 拆为文件夹，本轮结构调整免于 150 行限制。repository/project.ts、task.ts、claim.ts 分别保存项目、任务、认领的数据访问；三态查询结果类型移至 repository/result.ts。
- repository/index.ts 提供 TaskRepositories，显式组装 projects、tasks、claims，三个对象共用传入的查询入口。Service 与事务回调按对应属性调用；事务执行器始终将同一条连接传给三者，保留原业务顺序、锁顺序及提交/回滚范围。
- 本轮保留方法名和 SQL，移除旧源码入口并更新所有维护中的导入与测试。按实际写入对象归属：项目范围的认领删除在 claim.ts，临时任务删除与任务归档在 task.ts；项目删除的跨表顺序继续由 ProjectOperations 声明。
- 验证：原有 21 个方法的签名及正文与提交版本逐项一致，新增续租方法归入 claim.ts；类型检查、构建、八组真实 PostgreSQL 测试及 git diff --check 通过。首次测试因本地数据库未运行失败，按需启动已有实例后全部通过，未设置开机自启。清除了原路径的两个过时编译产物。

## 2026-10-23：续租身份来源讨论

- 核对本机 DSH 0.2.1-rc.2：Agent.id 是 SessionId，与持久会话身份一致；工具执行上下文可提供 agent。Web 新建会话生成 session-UUID，恢复历史会话通过 resumeSessionId 沿用原 ID。一次模型轮次、页面重新打开和后端进程生命周期均不等同于新的 Session。
- 自动续租需区分持久会话 ID 与本实例正在托管的 Agent；存活会话采集与销毁事件在后续适配层接入，浏览器标签页可见性不足以判断后台 Agent 是否存活。
- 设备身份候选为官方 getOrCreateAnonymousUserId()：它是 DSH_HOME 范围的随机 UUID，可正常跨重启保留，复制整个 home 也会复制 ID；写入失败会退化为本进程标识。可用于安装范围关联，不能视作硬件身份或认证凭据。是否采用该标识仍待用户确认；本轮仅说明语义，未添加身份或自动调度代码。

## 2026-10-23：续租调度与失败处理讨论

- 用户保留 20 分钟租约、5 分钟续租；明确每个会话续租本会话认领的正式任务。后端退出保留认领，由到期回收处理；恢复同一会话且租约有效时继续续租。
- 用户希望简单重试，持续失败进入该会话上下文，支持逻辑集中维护。本轮提议增加轻量后台执行辅助，集中防重叠、有限重试、停止与结果回调，续租 Service 保持单次业务；次数、间隔与具体公共接口仍待确认。
- 本机源码核对：Cordis 提供生命周期绑定的 interval/timeout，systemPrompt.context 提供按作用域注入的动态上下文；已发现的 dsh-llm-retry 专用于模型请求恢复，不能直接承担数据库续租重试。尚未发现覆盖本需求的通用后台作业执行器。
- 待审建议：整轮含重试期间保持 running，finally 释放；失败状态经 DSH 动态上下文呈现，下次模型请求可见，成功后清除当前告警。提示本身不保证唤醒空闲 Agent；下一周期成功也不代表先前过期的任务已重新认领。当前仅记录讨论，未编写调度代码。

## 2026-10-23：成熟续租机制与轻量依赖调研

- 用户希望参考工业实现并优先复用公共库。本轮阅读 BullMQ 的 LockManager/extendLocks Lua：独立管理续租、持有 job/token、单轮 await 完成后递归安排下一次 timeout、原子校验 token 并延长 TTL、报告具体续租失败任务。LockManager 依赖 Worker 及存储接口，直接调用它无法自动管理 Sagitta 自定义认领表。
- Kubernetes client-go leader election 区分 LeaseDuration/RenewDeadline/RetryPeriod，续租超过截止窗口后停止领导职责；引用用于借鉴有界重试和租约丢失语义，不引入其选主系统。此前“5 秒额外重试 2 次”仅为本项目候选参数，并非行业标准。
- 轻量候选 p-retry 提供重试次数、退避、时间预算、shouldRetry、AbortSignal 和失败回调；本次读取的上游 package.json 为 8.0.1、Node >=22、一个直接运行依赖，本机 Node 24.16.0。建议使用 DSH 定时/生命周期 + p-retry + 现有续租 SQL，具体版本和参数待实现时确认；未安装依赖。
- p-queue 是进程内并发队列，pg-boss/Graphile Worker 是完整 PostgreSQL 作业队列，均有各自的语义与集成成本。当前单个续租循环优先复用 DSH；可借鉴 BullMQ 的递归 timeout 自然串行模式，替代 interval/running 提案，尚待用户确认。
- 仍需显式设计的边界：现有续租返回数量无法报告预期认领的丢失；当前 SQL 从数据库读取 claim_id 后在本轮内匹配，区别于 Worker 保留旧 token 并提交验证，不能宣称可隔离同设备同会话的旧运行实例。p-retry 不能取消底层 SQL，重试时间预算也不等同于单次调用硬超时。上述为发现与待审事项，本轮保持代码不变。
- 官方依据：[BullMQ LockManager](https://github.com/taskforcesh/bullmq/blob/master/src/classes/lock-manager.ts)、[extendLocks](https://github.com/taskforcesh/bullmq/blob/master/src/commands/extendLocks-1.lua)、[client-go leader election](https://github.com/kubernetes/client-go/blob/master/tools/leaderelection/leaderelection.go)、[p-retry](https://github.com/sindresorhus/p-retry)、[p-queue](https://github.com/sindresorhus/p-queue)、[pg-boss](https://github.com/timgit/pg-boss)、[Graphile Worker](https://github.com/graphile/worker)。

## 2026-10-23：公共串行执行组件首批实现

- 用户同意复用 p-retry 并采用串行周期流程。本批新增 50 行 shared/periodic-task.ts，立即执行首轮，本轮业务与结果回调完成后才等待下一周期；由 p-retry 8.0.1 处理业务重试，参数直接沿用官方 Options，signal 统一由执行组件传入。
- 接入层注册 run、wait、onSuccess、onFailure、周期、重试策略与 AbortSignal；wait 后续使用 DSH timeout，卸载须同时中止 signal 并取消等待。结果回调与调度错误向返回的 Promise 传播，避免重放已经成功的业务；执行中停止仍等待原调用结束并抑制结果通知。业务最终失败经 onFailure 报告后继续后续周期。
- 类型检查、构建共享模块及三组测试通过，覆盖重试耗尽后恢复、结果传递、执行顺序、启动前/执行中/重试等待/周期间隔停止、报告与调度错误传播；git diff --check 通过。依赖经 npm 安装，清单与源码均用 apply_patch 修改。
- 本批尚未接入 DSH，未改变数据库业务或启动实际续租；会话身份、具体重试策略、上下文告警、续租结果语义补充按后续小批次审查。

## 2026-10-23：注册式自动续租接入

- 用户明确要求固定间隔与回调通过注册启动，本批增加 PeriodicTasks.register/dispose，复用已有 runPeriodicTask。管理器统一持有各注册的 AbortController、等待取消函数和运行 Promise；注销中止重试并解除等待，等待在途调用结束；统一关闭后拒绝新注册。
- 注册能力最初位于 adapters/automation.ts；后续按职责归入 TaskRenewal.register，捕获 owner 的设备/会话身份，只传入本会话 ID；周期固定 5 分钟，重试常量为最多额外 2 次、间隔 5 秒、60 秒时间预算。成功/最终失败交给插件注册的回调，报告与调度错误交给管理器的 reportError；数量 0 保留原业务语义，未宣称代表所有历史认领恢复。
- 后续装配将 schedule 绑定 DSH ctx.timeout(callback, delay)，reportError 绑定 DSH logger；会话卸载时调用并等待注销函数，插件卸载时调用并等待 dispose，再关闭数据库。停止只撤销运行安排，认领行由原租约规则处理。本批未启动实际 DSH 插件或读取身份。
- 类型检查、全量构建、五组周期执行与续租接入测试、git diff --check 通过；新增验证真实 p-retry 配合虚拟计时器下的重试次数、会话范围、失败后下一周期恢复、单项等待取消、统一关闭等待在途调用和关闭后注册拒绝。DSH 实际生命周期集成仍待验证。

## 2026-10-23：周期任务可读性与接入层边界整理

- 用户指出嵌套回调使代码难维护，要求保持注册能力并整理为可直接理解的对象和方法。PeriodicTasks 只登记、启动及统一停止实例；内部 PeriodicTaskRunner 保存停止信号、运行 Promise 和计时状态，分为 start/stop/execute/wait/cancelWaiting。复合函数类型使用命名类型，批量停止展开循环，错误报告与注册移除使用显式 try/catch/finally。
- 注册制仍需要业务和定时回调，按职责收敛到短方法，避免把全部生命周期状态塞进 register 局部闭包；单项执行继续复用 runPeriodicTask/p-retry，成功/失败通知和注销行为保持原样。
- 接入层的职责是连接 DSH 与内部服务：取得调用身份、绑定框架定时器/日志/上下文、响应生命周期。原 adapters/automation.ts 只定义续租业务策略，归类不准确；现移入已有 TaskRenewal.register，并移除原入口及过时编译产物。后续 DSH 接入层直接调用该方法，Service 调用公共管理器并返回注销函数。
- 类型检查、全量构建及六组周期执行/续租注册测试通过，新增验证单项注销和异常不会影响其他注册；git diff --check 通过。续租周期、重试策略、Repository 与数据库行为保持原样，实际 DSH 装配仍待后续实施。

## 2026-10-23：自动计时统一注册约定

- 用户确认并要求推广：涉及自动计时的业务必须提供注册函数；接入层调用业务注册函数，业务注册函数依赖公共调度组件，循环和计时统一由公共组件管理。已同步 AGENTS.md，替换此前仅按复用需要考虑提取调度的条目。
- 业务模块负责执行内容、间隔、重试策略及结果处理；接入层绑定 DSH 原生计时器、日志和生命周期，并负责注销。当前 TaskRenewal.register → PeriodicTasks.register 的结构符合该约定；后续定时上下文处理也沿用此入口关系。
- 本次仅更新开发约定，运行代码与行为保持原样。

## 2026-10-24：单任务访问统一检查与到期回收

- 用户要求首次访问发现到期就清理并带回内容，且每个业务函数连一行检查调用也不重复。已授权将已有单任务操作集中到 TaskOperations.execute；列表保持普通查询，周期批量回收后续接入。
- execute 统一事务、锁定、到期回收；dispatch 统一写入权限并分发，动作只保留各自状态校验和数据库修改。创建和列表独立保留；创建后认领继续直接调用相同认领处理函数。未添加外层 Task 类、代理或装饰器。
- reclaimExpiredTask 作为共用业务返回 expired/task/owner/message；临时任务删除，正式任务撤销认领并恢复 open。返回值在事务提交后交付；清理路径不抛业务异常，避免清理被回滚。原内容随结果返回，尚未提供跨崩溃的持久通知保障。
- 移除被替代的 withClaimedTask、reuseTransactionRunner 及过时编译文件。requireTaskWriteAccess 保持原名与原逻辑。lockClaim 在取得行锁后用数据库时间判断到期，防止锁等待期间失效仍继续操作。
- 类型检查、全量构建及 12 组真实 PostgreSQL 测试通过：正常业务回归、八种单任务动作的两类到期回收、内容保留、目标范围隔离、两类清理失败回滚、并发回收及锁等待跨越到期。测试只使用临时表或随机 schema 并清理；本地数据库按需启动，未设置自启动。
- 另通过 6 组周期执行与续租注册测试及 git diff --check；本批未修改周期策略或实际挂载 DSH。

## 2026-10-24：周期回收与主动访问共用业务

- 用户已通过上一批统一入口审查，并要求实现定时维护，强调两条路径必须共用清理规则。新增 TaskReclamation.register/reclaimExpiredTasks；全部清理调用既有 reclaimExpiredTask，Service 仅选择候选、组织事务和汇总结果。
- 续租按会话注册，回收按插件注册一次；回收全库未归档任务的过期认领，覆盖已关闭会话及其他设备遗留的数据。注册立即执行，单轮结束等待 5 分钟，循环和停止复用 PeriodicTasks。
- 候选查询按任务 ID 排序；取得项目、任务和认领锁后复查，已删除/归档候选跳过。一批回收共享事务，失败整体回滚，提交后才交付包含原内容与 owner 的回收结果。共用提示描述回收事实，主动操作入口补充原动作未执行。
- 回收包含物理删除，采用 retries: 0，失败原样报告，下一周期重新检查；提交结果不明时不立即重放清理。续租原有重试策略保持原样；未加入持久通知或额外恢复状态。
- 类型检查、构建、15 组真实 PostgreSQL 测试、7 组周期/注册测试通过。新增覆盖跨会话回收、有效认领保持、整批回滚、主动与周期回收竞争、注册首次执行及失败后下一周期恢复。实际 DSH 装配与上下文消息投递仍待实现。

## 2026-10-25：DSH 配置与已有数据库连接初始化

- 用户确认本批挂载 DSH 配置与初始化，只连接已有数据库；工具、自动维护及上下文留待后续。首版连接模式取代此前 local/external 双模式提案，数据库安装和启动仍使用独立脚本。
- index.ts 使用 static Config 与 Service.init；配置声明和 pg 参数转换放在 runtime/database-config.ts，连接及状态记录放在 runtime/connection.ts。sagitta.json 注册 @sagitta/runtime/task；当前变更尚未发布或安装到用户正在运行的 DSH profile。
- 本机 Cordis 4.0.5 的普通配置更新会卸载并重新初始化插件，因此直接复用框架重启与资源释放。真实测试发现初始化抛错时 Fiber.update 丢弃 restart 返回的拒绝 Promise；插件入口捕获初始化失败并调用 DSH logger，保留配置入口供修正后重新检查。连接成功的日志只在记录保存成功后输出。
- 配置提供 host、port、database、user、password、ssl、可选 caFile；密码使用 Schemastery 原生 secret 标记。TLS 开启时验证证书，CA 文件通过 Node 读取；本轮只验证参数转换，远程 TLS 握手与 Windows 尚未实测。
- 使用 DSH 的 writeFileAtomic 保存 `<profileContext.dir>/sagitta-task/connection-status.json`，包含检查时间、目标摘要和 connected/failed；该文件只代表最近检查结果，每次初始化仍执行 SELECT 1。凭据和原始错误不写入记录；错误通过日志报告。记录失败时释放新连接池并保留原始异常，避免交付未完成初始化的连接。
- 本轮连通性检查尚未接入业务 schema 检查；既有 checkTaskSchema 应在挂载业务前接入。插件卸载关闭连接池，数据库服务由其部署环境管理。
- 验证：类型检查、构建、git diff --check 通过；24 组测试通过，包括真实 Cordis + PostgreSQL 的初始化、配置变更失败及修正恢复、本地状态脱敏、配置校验、TLS 参数、连接关闭，以及此前全部数据库/周期业务回归。Web 配置页操作及实际 profile 安装仍待验证。

## 2026-10-25：任务主动工具完整接入

- 用户同意按前轮方案一次接完 11 个主动工具，本批免除约 150 行限制。项目五项、任务六项沿用既定命名和参数；状态工具通过 action 选择五个已有动作。Repository 和 Service 本批保持原样。
- 使用官方 defineTool/ctx.tools.register，参数和输出 schema 由 DSH 校验，业务错误沿用原生转换。共用参数、输出结构和 JSON 渲染提取到 adapters/tools；到期结果显式保留原任务与说明，内部 owner 由统一投影移除。详细接口见 [主动工具接入](design/sagitta-task-tools.md)。
- 身份采用前轮建议：deviceId 来自 getOrCreateAnonymousUserId，sessionId 来自 exec.agent.id。标识按 DSH_HOME 持久化，保留官方复制目录、写入失败的实际边界；AI 参数不参与身份构造。
- 初始化在连接成功后检查现有 schema 版本，再装配 Repository、事务执行器和 Operations，并注册工具。配置变更复用 DSH 重载；连接记录继续只表示连通性，schema 错误由日志报告。
- 已验证 Cordis effect 的关键边界：嵌套 effect 中通过外部 ctx 注册的资源，需要显式 yield 注册返回的注销函数，才能保证嵌套初始化失败时及时撤销。两个注册入口使用生成器逐个 yield，index 通过 yield* 接收；数据库关闭函数同样交给 effect，复用框架清理，避免另写注册回滚机制。
- 类型检查、构建与 30 组测试通过；本轮新增真实 DSH 工具执行管线测试，覆盖全部接口、状态动作、输入校验、跨会话权限、身份伪造无效、到期结果、作用域隔离、取消前拒绝执行、卸载及部分注册失败清理；schema 失败测试确认池已关闭并可在修正后恢复。测试使用隔离 schema 和临时身份目录，无 LLM 调用。
- 自动续租、周期回收和上下文留待后续；现阶段正式认领仍按 20 分钟期限生效。运行中的 DSH profile 尚未安装本批变更，真实 Web UI 和模型工具选择行为仍待验证。

## 2026-10-25：说明原子追加

- 用户要求系统提供追加写入。project_update/task_update 共用 mode=replace/append，省略保持替换；系统层的 ProjectOperations.updateProject 和 TaskOperations.execute(update) 同样支持该参数，工具数量保持 11 个。
- Repository 在既有 SQL 内使用 CASE 选择替换或 description || 新文本，保留行锁、事务、归档和权限路径。追加原样拼接，换行由调用方提供；并发追加均保留，整体替换仍按完整输入覆盖，尚无版本冲突检查。
- 已核对 description 为 text NOT NULL DEFAULT ''，应用及数据库未设额外字符数上限，无需变更 schema。PostgreSQL 自身的字符串值大小上限约 1 GB，属于引擎边界；依据：https://www.postgresql.org/docs/18/datatype-character.html 。
- 类型检查、构建和 23 组相关回归测试通过；新增真实 DSH/数据库测试覆盖项目和任务各八次并发追加、原文保留、空文本、引号/换行/长文本、默认替换、非法模式、跨会话拒绝、到期与归档拒绝。

## 2026-10-25：工具说明保留使用规则

- 用户明确：模型侧 description 只表达业务使用方式。正式任务认领后由系统负责续租，会话消失且续租失败后回收；临时任务有效期 20 分钟。检查时点、续租周期和扫描过程属于内部机制。
- 已精简 task_list/task_get 说明，并在 task_create 明示临时任务 20 分钟。实际回收结果仍返回说明与原内容，业务代码和当前续租挂载进度保持原样。
- 用户要求 task_transition 先解释状态，再说明每个动作的起始与目标状态。已按 Service 实现逐项展开 open/in_progress/blocked/done/cancelled、五种动作、认领权限和临时任务清除规则；说明只涉及业务语义，保持内部计时细节隐藏。

## 2026-10-25：独立动作工具与固定总体说明

- 用户确认在接入层拆分 task_claim/release/complete/block/cancel，替换 task_transition；工具总数由 11 变为 15。每个动作独立定义，内部继续调用同一个 TaskOperations.execute，保留统一事务、权限和回收；专属参数留待后续。
- 新增 adapters/guidance.ts，说明项目与任务关系、正式/临时用途、状态含义、多任务认领、查询/登记/交接与清理流程。index 显式注册到 systemPrompt.section，与工具共同由 ctx.effect 管理；固定总体说明和每个工具的使用说明分别由原生注册器组装。
- 已核对 DSH SystemPrompt.assemble/renderPrompt 及 AgentLoop 的 SystemPromptProjection：每次模型步骤使用当前组装，提示词文本相同不重复追加；文本变化时可能按连接能力替换或追加新版本。注册一次与每次请求可见可以同时成立，输入 token 仍有固定占用；持续可见不保证模型始终正确执行。
- 验证：类型检查、构建、9 组真实 DSH/PostgreSQL 接入测试通过，覆盖五个独立动作、旧入口移除、连续三次组装只有一份固定说明、工具共用组装、作用域隔离、重载无重复及卸载清理。Service/Repository 本轮保持原样，任务数据动态上下文和自动维护仍待挂载。

## 2026-10-25：说明文本分段排版

- 用户要求 description 等长说明按语义分行，方便阅读源码；进一步明确起始反引号后换行，正文从下一行顶格书写，正文各行之间不留空行。已更新多行模板字符串，短说明保持简洁。
- 已整理项目、任务工具及更新模式说明，保留原有文字含义和业务逻辑；约定同步到 AGENTS.md。

## 2026-10-25：临时任务立即认领参数

- 用户确认 temp 创建接受 claimImmediately 省略或 true，仅显式 false 报错；替换之前拒绝传入该参数的接入层规则。Service 继续统一自动认领，正式任务行为保持原样。
- 参数说明和接口文档已同步；接入测试验证省略/true 均写入本会话认领，false 报错且不创建任务。

## 2026-10-25：用户维护开头与模块说明边界

- 用户自行删除 task_block 中要求先登记障碍和解除条件的指引；专门的阻塞登记尚未实现，后续说明保持现有状态操作语义。
- 用户重写 guidance 开头，要求后半段按清晰条理介绍模块。已保留用户开头与预设，按记录结构、任务类型、状态、动作、说明维护、建议流程补充后半段，避免重复预设中的身份与人格定位。
- 用户开头包含跨模块任务资源门禁及 <SagittaEmergencyCode> 占位文本；用户明确这些能力由其他模块实现，任务模块保留原文说明，其实现归属相应模块。
- 用户明确 guidance 负责通用知识（任务类型、状态、会话关系等）和工作流程参考；各工具的参数、操作含义和前置条件由 API description 定义。后半段已据此精简，保留用户开头。
- 本轮验证：构建、5 组 DSH 工具/PostgreSQL 接入测试及 diff 格式检查通过；固定说明测试改为检查状态知识，避免要求 guidance 重复具体工具名称。

## 2026-10-25：重启与认领恢复的源码核对

- archive 最终版本的 memory/tools.js 将 DSH agent.id 作为云端 owner，启动时重建本地门禁；worker/worker.js 的 claim 允许同 owner 续租恢复。早期 task-ownership-p2.md 仍描述丢失 token 后无法操作的设计，不能据此断言最终归档代码仍有同一问题。历史部署版本和当时会话 ID 未核实，实际故障原因尚不能确定。
- 当前认领持久化在 PostgreSQL；插件卸载只关闭连接，不撤销认领。相同设备标识、恢复原会话且租约有效时可继续操作；重复 claim 仍按现有规则报已有认领。相同目录新建会话会生成另一 session ID。
- 20 分钟租约从创建认领或最后一次成功续租计算。自动维护 Service 已实现，当前 index 尚未挂载；过期认领可由单任务访问回收，正式任务回到 open，触发回收的本次操作不执行。以上为源码核对，未进行实际 DSH 重启测试。

## 2026-10-25：续租接入与提示词边界

- 用户要求本批注册续租；模型组装时展示已认领任务、认领 ID 和 description 留待下一批。认领 ID 的具体投影需在该批核对既有任务 ID 与内部 claim_id 的用途。
- adapters/renewal.ts 将 TaskRenewal.register 接到 DSH agents 的 created/disposed 事件，同时扫描已加载会话以支持配置重载；通过官方 scope 链限定本插件范围。index 在工具注册后挂载，计时使用官方 cordis-plugin-timer 的 ctx.timeout，循环/重试/停止复用 PeriodicTasks。
- 注册后立即续租，之后沿用单轮结束后等待 5 分钟、失败重试两次的业务策略；续租只涉及本设备、本会话尚有效的正式认领。卸载停止并等待在途续租结束，随后关闭连接池；认领保留到期。周期回收仍待挂载。
- 失败耗尽后记录原始错误，以 DSH 原生消息来源 sagitta-task 向所属会话发送 next-step 提醒，wakeup=false；等待下一次运行读取。正常续租保持安静。
- 用户认可提示词两处修正：其他会话可读已认领任务，修改/删除/状态操作受认领限制；阶段性结果本身不等于阻塞或完成，应根据实际结果决定。
- 用户希望 description 仅承担概览。已在记忆路线图记录：记忆区实现后提醒确认大小限制，并指导模型持任务 ID 存取具体情报；当前维持已有字段大小与工作目录存放材料的指引。
- 验证：构建、17 组初始化/工具/周期执行测试通过；追加的续租失败提醒断言单独复跑通过，diff 检查通过。接入测试使用真实 DSH 注册表、作用域、计时服务与会话替身，覆盖已有/新建会话、范围隔离、停止、恢复及失败提醒；实际 DSH UI 重启尚未测试，本批未发布或安装到运行 profile。

## 2026-10-25：认领凭据与本会话工作上下文

- 用户明确认领 ID 用于跨模块资源访问，要求同时展示任务 ID 和认领 ID。沿用工具命名风格：任务对象 id 对应 taskId 参数，数据库 claim_id 输出为 claimId。正式/临时创建并认领、独立认领均提供该值；普通列表/详情和过期结果维持任务资料投影。
- createClaim 使用 INSERT RETURNING 取得数据库生成的 UUID；原子认领仍在同一事务内创建认领并修改任务状态。续租保持凭据，重新认领生成新凭据；其他模块的访问校验后续实现。
- 新增当前工作读取：Repository 单次联查本设备、本会话有效认领和未归档任务/项目，Service 去重分组。有效凭据展示专用查询过滤到期行，普通任务列表维持既定行为；上下文读取保持只读。
- adapters/work-context.ts 注册工具工作说明区的 section，并通过 DSH 异步 system-prompt/assemble 填充本次结果。项目含 id/name/description，任务含原字段及 claimId；没有共享会话缓存或额外定时器。无 Agent 的诊断组装不查询；读库失败交给原生组装错误传播，未增加降级路径。
- guidance 补充两类 ID 的用途和生命周期，跨模块资源访问指引改为使用 claimId；description 长度限制继续等待记忆模块实现后确认。
- 验证：构建及 24 组数据库/到期回收/初始化/工具测试通过；文本排版调整后重新构建并通过 6 组工具测试，diff 检查通过。新增验证覆盖两个会话并发组装隔离、项目分组、正式/临时凭据返回、说明更新、续租凭据保持、重新认领更换、到期隐藏、项目归档与作用域卸载。尚未调用真实模型或安装到运行 profile。

## 2026-10-25：任务插件独立可用性核对

- 已验证 @sagitta/runtime/task 入口可直接 import，npm pack --dry-run 包含任务编译文件、初始化 SQL 和 shared 支撑模块。任务插件可单独挂载在 DSH 中，业务上不依赖 memory、异步执行或自主推进插件；安装单元仍为 @sagitta/runtime。
- 此次核对发现 TaskReclamation.register 已实现但 index 漏接，导致后台回收未运行。该遗漏已在下述“周期维护补齐”批次修复；仍需真实 DSH 加载、重启及到期通知验收。
- 独立使用需要匹配的 DSH 原生服务和已初始化的 PostgreSQL；本地数据库部署脚本目前仅支持 macOS/Homebrew。未安装到运行 profile，未以真实模型完整验收。本轮只核对并记录，未改运行逻辑。

## 2026-10-25：周期维护补齐与临时到期通知

- 用户指出正式回收本属已确认能力，应修复入口遗漏；临时任务额外需要周期清理后的显式上下文提示。维护入口更名 registerTaskMaintenance（adapters/maintenance.ts），统一调用已有 TaskRenewal.register 与 TaskReclamation.register；前者按会话续租，后者插件级扫描一次，避免逐会话重复全库清理，也覆盖无在线会话时的遗留认领。两项沿用各自 5 分钟周期、重试和停止策略，未新写循环或回收 SQL。
- 通知仅处理本次周期回收返回的 temp 原内容，匹配本设备和当前作用域内的原会话，包含标题、任务 ID、description 等。使用 DSH next-step、wakeup=false；正式回收静默，主动访问继续只返回原有工具结果。续租故障提醒保持已有行为。
- 用户希望首次初始化清理静默，且只提醒同一会话持续超过 20 分钟的临时到期。本批按会话在当前插件中的连续加载时长至少 20 分钟判断；首次成功扫描一律静默。会话卸载/恢复或插件重载会重新计时；原会话离线、其他设备及其他作用域的数据清理静默，当前不提供持久补发。
- 初始化现在会写数据库，已将全部初始化测试改为隔离 schema，避免后台清理触碰真实任务。入口集成测试直接验证插件挂载后删除遗留 temp、正式认领恢复 open；期间未调用主动清理入口。
- 验证：构建及 17 组周期、接入、回收和初始化测试通过；新增真实数据库入口测试后 5 组初始化测试再次通过，diff 检查通过。通知覆盖首次静默、20 分钟阈值、身份隔离、正式静默、同会话恢复重计时、无在线会话持续扫描及卸载停止。尚未安装到真实运行 profile。

## 2026-10-25：独立审查与真实模型接入验收

- 用户要求一个子 Agent 独立审查当前代码，同时由主线程验证真实 DSH 加载及 DeepSeek 工具调用。完整发现和证据范围记录于 [审查报告](reviews/2026-10-25-sagitta-review.md)。本批只审查、验证和记录，未修改运行实现。
- 构建、Updater 类型检查和现有 35 项测试通过。通过独立 DSH_HOME、隔离数据库 schema 和正式 headless 启动入口，真实模型成功列项目、创建项目、创建并认领正式任务、查询详情；退出进程后恢复同一 session，再成功完成任务。数据库核对最终为 done 且认领清除；测试数据和 profile 已删除。
- 该结果验证直接加载 task 并显式配置数据库的路径；Updater 生成的 programmatic preset 仍缺少持久连接配置入口。框架依赖重复安装还存在 scope 实例隔离风险，已用官方实现的两个模块实例复现，真实 Updater 布局待验证。
- 多实例全库清理与仅本地通知组合存在在线提醒丢失路径：其他实例抢先删除后，原会话无法再得到结果。此前接受的离线不补发不能覆盖这一竞争；后续需明确清理与原 owner 通知的协调方式。

## 2026-10-25：更新配置与本地数据库托管讨论

- 已确认更新方向：启动时检查远程版本；版本变化才部署、构建并处理配置。已有同名配置值保留，新字段采用默认值；字段改名或类型变化需要显式迁移，数据库表结构迁移另行处理。
- 用户确认任务插件配置分为“本地目录”和“自定义连接”：前者管理目录内的数据库准备、启动和连接，后者仅连接已有服务；各阶段须向终端报告。用户随后澄清“记忆插件”为口误，实际挂在任务插件初始化。按约 150 行分批实现。
- 已核对现有 install-task-db.py：数据和连接信息位于指定目录，PostgreSQL 程序通过 Homebrew 安装到公共前缀。因此该脚本不能直接充当用户要求的全目录内自动安装器。
- embedded-postgres 提供初始化、启动、停止及持久数据目录，支持多平台；其上游二进制主要定位于测试用途，且 npm 包要求 postinstall，与当前 Updater 的 --ignore-scripts 存在接入冲突。首批局部安装验证见下文，完整生命周期接入仍待实施。来源：https://github.com/leinelissen/embedded-postgres 、https://github.com/zonkyio/embedded-postgres-binaries 。

## 2026-10-25：本地 PostgreSQL 程序准备第一批

- 新增独立目录 plugins/task/src/database-management，runtime.ts 的 preparePostgresRuntime 在用户目录的 runtime 子目录局部安装 embedded-postgres 及当前平台程序包，固定已验证的包版本。使用 DSH withFileLock 串行准备；默认禁用安装脚本，只执行所选平台包的符号链接恢复脚本，运行 postgres --version 成功后记录就绪。
- 程序已就绪则复用；目录不完整或记录的程序包版本不同则报错，保留现场。此限制针对插件托管的程序包，现有自定义 PostgreSQL 连接继续不校验数据库引擎版本。未执行 Homebrew、全局 npm 安装或注册系统服务；npm 自身仍使用用户配置和缓存。
- 首次测试遇到代理连接 ECONNRESET；仅在重试测试进程中移除代理环境变量后，真实安装和验证约 18 秒通过，运行实现保持继承环境。macOS ARM 包解压约 148 MB。
- 新增显式启用的 postgres-runtime.test.js：验证程序复用、真实初始化/启动、写入后停止重启读取同一数据，测试实例和目录自动清理。构建和 diff 检查通过；Windows/Linux 尚未实测。
- 本批约 150 行（模块、测试及记录），尚未接入插件 Config/index、连接信息生成、任务表初始化或已有运行实例复用；这些留待用户审查后继续。

## 2026-10-25：本地数据库准备第二批

- database-management/local.ts 新增 prepareLocalDatabase：复用程序准备模块，首次选择本地可用端口、生成随机密码，使用 PostgreSQL 原生 initdb 初始化 data，持久保存 connection.json；后续读取配置。缺配置但已有 data 或缺 PG_VERSION 均报错，保留数据。
- 复用 DSH 文件锁串行初始化和启动；通过 pg_ctl status 判断运行状态，仅未运行时 start。绑定本机回环地址、关闭 Unix socket；使用 pg 校验实际 data_directory，并创建缺少的目标数据库，返回既有 TaskDatabaseConfig。
- initdb 使用目录内 0600 临时密码文件，执行结束清理，避免凭据进入命令参数和日志。各准备阶段调用传入的日志函数；本批提供启动与复用，不绑定插件卸载停库，避免关闭其他调用方复用的实例。
- 构建、格式检查及两组真实 PostgreSQL 测试通过，覆盖程序准备、数据库配置生成、并发复用运行实例、停机重启和数据保留；实例与测试目录清理。当前仅 macOS ARM 实测，任务表初始化、配置模式选择及 index 挂载留待下一批。

## 2026-10-25：数据库模式配置与初始化挂载

- 新增 taskConfig 原生条件配置：local 必填 directory，custom（默认）复用原连接字段。index 在 local 时准备本地实例，两种模式都调用同一 connectTaskDatabase；只有 local 自动初始化任务表，custom 保持只连接和版本检查。
- 001-initial.sql 改为单条 PostgreSQL DO 语句：事务级 advisory lock 后检查迁移表，缺少时创建原有四张表并登记版本；与安装脚本共用文件，移除 psql 专属命令，表字段和约束保持原样。已有其他结构版本仍报错，未增加自动迁移路径。
- 配置分支和数据库准备阶段日志已挂载 DSH。插件卸载仍关闭连接池并撤销工具/维护注册，共享本地数据库进程保留。Updater 预设的用户配置持久入口仍待接通。
- 构建、4 项配置/真实本地数据库测试及 11 项已有初始化/工具测试通过。验证本地模式建表并注册 15 个工具、重复挂载保留项目、切换 custom 使用相同工具和数据；隔离实例与目录清理。未进行真实 Web 配置页验收，Windows/Linux 尚未实测。

## 2026-10-25：Updater 原生预设配置与手动重启

- 用户确认采用 DSH profile 中的官方 Sagitta 预设声明；修改配置后提示用户手动重启 DSH。任务插件继续声明 Config、负责初始化和卸载；已有会话按官方预设生命周期保留原组合，重启恢复时读取当前配置。本批没有实现专用 Web 表单或重启按钮。
- 撤销讨论中临时加入的 Updater.pluginConfigs 配置层。安装 bundle 声明 preset-sagitta（@deepseek-ai/dsh-agent-preset），通过 sagittaReady 服务依赖等待 Updater 完成；业务插件保持在 Sagitta 预设内。启动准备采用原生 Entry.update 更新单个等待条目，避免在 Updater 自己初始化时等待包含自身的全局 reconcile。
- profile.ts 使用 DSH 原生 profile 读取/组合、文件锁和原子写入，保留 YAML 注释与 !!js 表达式。对 sagitta.json 中注册的业务插件，按稳定 ID 保留现有 config 同名值；新字段采用仓库默认。插件清单、标准组合和 persona 提示词由仓库维护。配置存在 profile/cordis.patch.yml，原子写入权限 0600。
- 启动查询 stable 最新提交，变化时才 fetch、安装和编译；相同提交校验本地 HEAD 后复用产物。准备配置后原子记录成功提交。终端报告检查、下载、安装、编译、保存及就绪阶段；预设配置变更时提示手动重启，配置 Schema 中也注明。错误保留 cause，失败不发布就绪服务。
- 按用户要求删除旧 install-task-db.py，保留已有本地数据库及凭据；数据库文档改为任务插件按需托管与自定义连接两种模式。
- 验证：根构建、Updater 构建、配置 Schema 测试及两组新增接入测试通过。接入测试使用真实 DSH Loader、官方 preset 声明和 ConfigEditor，覆盖首次等待准备、保存后重启读取、升级保留用户值并补新字段、提示词更新、YAML 注释/表达式保留、相同配置不重写、相同版本跳过部署、编译失败保持未就绪和旧成功记录；registry 使用记录替身，Git/npm 使用命令替身。未安装进日常 profile、未推送 GitHub；本批未重复执行真实 PostgreSQL 部署测试。

## 2026-10-25：框架 peer 解析路径核实

- 用户要求确认第二份框架依赖是否会被实际使用，本批检查并保留诊断脚本，未修改运行实现。DSH 0.2.1-rc.2 官方解析器区分 profile 内路径与外部 linked root：前者优先本地 node_modules，后者在各层 package.json 声明 peer 时优先宿主映射。不能笼统认为 peerDependencies 一定让所有安装布局共享宿主实例。
- tests/diagnostics/dsh-scope-resolution.js 使用官方 createRuntimeResolution 和公开 Worker bootstrap（相同 ESM/CommonJS 路由实现），隔离临时目录验证三种布局。profile/sagitta-source 内存在 scope 副本时，实际 ESM URL 指向该副本，函数身份不同，读取宿主 scope 失败；没有本地副本时，或目录位于 profiles 之外且通过 profile node_modules 链接、声明 peer 时，均读取宿主实例成功。三组断言通过，临时目录自动删除。
- 此证据确认当前 Updater 部署目录配合本地 framework 副本会触发问题；完整下载/安装/模型调用链仍待验收。后续修复应统一框架 peer 的运行时来源，具体部署改法尚未实施。

## 2026-10-25：改用预编译 Release，发布端第一批

- 用户决定由开发端本地编译、打包并上传发布包，使用端下载预编译包；取代此前用户机器上拉取源码并编译的方向。采用 GitHub Release，Updater 自身保持手动安装，按约 150 行分批审查。
- 首批 scripts/release.py 默认清理生成目录、编译并 npm pack 两个包，生成 release.json（tag、commit、dirty、DSH 版本和资产 SHA-256）。显式 --publish 才上传，要求干净工作树且远程版本标签指向 HEAD；版本取根 package.json，Updater 保留自身包版本。使用 gh 官方 Release 命令，新版本标记 Latest，现有 Release 不覆盖。
- 根运行包添加空 bundle patch，以便后续走 DSH 官方安装入口；业务插件启用仍由预设控制。产物写入已忽略的 .runtime/releases，编译产物仍不进入 Git。
- 验证：本地构建与打包通过，runtime 41 个文件、updater 5 个文件；归档含所需 JS/SQL/提示词及 bundle 声明，不含 node_modules、src 或 .env，SHA-256 匹配。未提交工作树的发布调用按预期在网络操作前拒绝。
- 本批没有创建 Release、提交或推送。当前包仅用于验包，Updater 仍执行旧源码更新逻辑；下一批需改为下载发布清单、检查 DSH 版本与资产、安装 runtime，并调整手动安装 Updater 的入口。框架 peer 重复加载问题须在新安装路径下复验，当前不能标记已解决。
- 用户明确编译打包脚本无需逐行审查，后续对此类脚本说明行为、输入输出和验证结果即可；其余业务代码继续遵循原有分批审查约定。

## 2026-10-25：Updater 对齐预编译 Release

- 本批以 release.ts 替换启动时 Git 拉取、源码依赖安装和编译。读取固定仓库 Latest 的 release.json，校验 dirty=false 与 DSH 精确版本；已安装 runtime 同版复用，异版按清单 tag 下载、核对 SHA-256，再安装。此前 stable 分支与 sagitta-built-commit 的部署规则由此替代；旧下载目录未自动删除。
- 使用官方公开的 @deepseek-ai/dsh-plugin-manager/operations.runPluginCommand，复用 profile 文件锁、pnpm、版本检查与诊断日志。此接口完成磁盘安装；随后 pluginPackages.refresh 更新解析表，现有 preparePresetProfile 保存用户配置，最后提供 sagittaReady。启动初始化中避免调用等待整个插件树重载的安装入口，以免等待自身。
- 运行包留在 profile/sagitta-releases，供 pnpm 保存的本地包路径复用；运行代码安装在 profile/node_modules。安装禁用生命周期脚本和 peer 自动安装；全局 fetch 沿用 DSH 代理策略。Updater 与 DSH 自身仍手动更新，用户安装脚本留待下一批。
- 预设字段通过解构排除 prompt 后传给官方接口，避免将未提供的可选 description 显式写成 undefined；真实配置编辑器测试发现后者经 YAML 序列化会变为 null，导致编辑一致性校验失败。
- 验证：根包及 Updater 构建、发布端本地打包通过；两组接入测试通过，使用真实 Loader、官方预设/ConfigEditor、模块解析刷新和 pnpm，GitHub 下载替换为本地发布样本，预设 registry 为记录替身。覆盖首次安装、同版跳过、升级保留配置/更新提示词、SHA/版本/dirty 校验拒绝及失败不发布就绪。
- 实际 runtime.tgz 在隔离 profile 通过官方接口安装后，诊断脚本 release 模式确认 scope 解析到宿主同一模块，函数身份相同且读取宿主 scope 成功。此前重复框架问题已在此新安装路径验证解决；历史源码安装残留及其他安装布局不在此结论范围。
- 未创建 GitHub Release，未提交、推送或替换日常 profile；正式 GitHub 下载到模型运行的全链路尚待首个发布包与用户安装入口完成后验收。网络检查失败仍会阻止 Sagitta 就绪，未新增离线回退。

## 2026-10-25：独立安装脚本对齐 Release

- scripts/install-updater.py 改为独立 Python 标准库安装器，替代原来的仓库内 npm install/build/file-directory 安装。读取最新正式 release.json，精确核对已安装 DSH 版本，下载该 tag 的 Updater tgz 并校验 SHA-256，再调用 dsh plugin --profile web add；禁用生命周期脚本及 peer 自动安装。Updater 仍由用户手动安装和更新。
- 缓存写入 DSH_HOME/profiles/web/sagitta-releases/<tag>/（默认 ~/.dsh），下载校验完成后原子替换文件；因 pnpm 保存本地 tgz 路径而持续保留。安装器可脱离仓库运行，使用 urllib 原生代理和证书校验；缺少命令、网络失败、校验失败或安装失败均直接报错停止。
- scripts/release.py 原样复制安装器为 install.py，并连同两个 tgz 和 release.json 共四个资产发布；Release 说明附安装命令。此前独立用户安装入口待实现的记录由本批取代。
- 验证：发布端本地构建/打包通过；脚本测试覆盖安装及重复运行、版本/哈希/正式标记/路径校验拒绝、命令缺失、下载失败与安装失败。实际预编译 Updater 包通过真实 dsh plugin 命令安装进隔离 DSH_HOME，官方配置导出包含 preset-sagitta 和 sagittaReady，未安装第二份 dsh-scope。该测试仅替换 GitHub HTTP 下载，执行后清理隔离目录。
- 当前在 macOS 验证；Windows/Linux 未实测。未发布 Release、提交或推送，也未改日常 profile；GitHub 在线全链路仍待首次正式发布。任务模块的多实例清理通知竞争不属于本次安装脚本修改，仍待处理。

## 2026-10-25：预设插件按白名单更新

- 用户要求 Updater 只管理指定白名单，升级时原样保留其他插件清单。白名单在 index.ts 显式由 persona 与 sagitta.json 中的业务插件 ID 组成；不增加另一份配置清单。此规则取代此前每次重建整个官方标准组合的行为。
- profile.ts 以已有插件列表为基础，仅替换白名单条目，保持已有条目位置；新白名单插件追加。非白名单插件及其 config、disabled、条件表达式、嵌套组和顺序整体保留；缺少的非白名单默认条目不自动补入。白名单业务配置继续保留用户同名值，persona 的 prefix 随发布更新，其余配置保留用户值。
- 仅当本地没有 preset-sagitta 覆盖条目且有效插件列表为空时，视作尚未配置的初始声明，填入完整默认组合。已有预设正常清空 plugins 后仅恢复白名单；完全删除本地预设覆盖并还原空声明则回到初始化状态。移出白名单的旧条目会保留，后续移除或迁移需显式处理。
- 验证：Updater 编译及两组接入测试通过。真实 Loader、官方 ConfigEditor 保存/重启验证非托管插件和嵌套配置保留、启停状态/顺序保留、删除不补回、官方新增条目不擅自加入、白名单新增、提示词更新、业务配置保留、空清单与重复启动不重写。Release 安装测试继续通过；未修改日常 profile、未提交或发布。

## 2026-10-25：独立安装目录与首版打包验收

- 用户确认独立目录分发：runtime 局部安装发布清单指定的精确 DSH，home 作为 DSH_HOME，agents 作为 DSH_AGENTS_HOME；平台启动脚本仅为当前进程设置这些路径及本地 PATH，保持调用时的工作目录。此规则替代上一批安装到已有 DSH 的方案。Node.js、npm、pnpm 只检查，npm engine-strict 校验安装所需 Node 版本。
- 安装器必须传入 --directory，首次使用空目录；用 runtime/package.json 的 sagitta-environment 名称识别已有安装。重复运行保留数据，支持失败后重试；中途失败直接报告，未增加整体安装回滚。缓存的 tgz 保留供 pnpm 引用。DSH 和 Updater 手动更新，业务包启动更新。
- 首个实验版本编号 0.1.0，固定 DSH 0.2.1-rc.2。Web 启动后由用户选择 Sagitta 预设并配置任务数据库目录或已有连接；启动脚本透传 --no-open、--port 等 Web 原生参数。未添加自动选择预设的新路径。
- 安装器 5 项测试通过，覆盖重复安装、用户数据保留、格式/哈希/引擎安装失败、未知目录拒绝，以及含空格目录下启动参数和工作目录保留。现有 Node 测试 41 项中 38 项通过、3 项显式部署测试默认跳过；开启本地 PostgreSQL 验证后，相应测试文件 4 项全部通过。
- 使用打包的 install.py 在 .runtime 下含空格的隔离目录实际安装 DSH/Updater，启动真实 Web、安装 runtime、准备本地数据库。真实 DeepSeek 模型调用项目工具成功；重新启动后同一会话继续认领任务、完成任务并删除测试项目成功，动态上下文包含已认领任务。Web 登录链接先返回 303 设置 cookie，再访问页面为 200；未携带凭据时 401 属于官方认证行为。
- 验收脚本集中在 tests/diagnostics：install-release.py 仅替换发布资产 HTTP 下载，packed-web.js 运行实际独立环境及测试插件，online 模式访问真实 GitHub。测试密钥从本机 .env 进入测试进程环境，未写入发布包或 Git。日志含本地 Web 登录令牌，留在忽略目录。
- 已实测 macOS ARM。Windows/Linux 尚未实机验证；多个实例共用数据库时临时任务通知竞争仍为已知限制。记忆模块仍为空壳，发布说明明确本版范围。
- v0.1.0 已从提交 1429df3 发布，包含 install.py、release.json 及两个 tgz；标签和源码已推送 main。发布后从 GitHub 下载 install.py，确认与源码一致，在另一个全新目录完成在线安装。Updater 实际下载 GitHub runtime、真实模型调用工具、Web 认证访问、重启恢复认领并完成任务全部通过。验收插件已移除，隔离测试 PostgreSQL 进程已停止；没有改动日常 DSH profile。

## 2026-10-26：管理者工具清单核对

- 用户要求对照官方预设与归档 Sagitta，评估管理者需要的工具。已按安装包 0.2.1-rc.2 的 Standard、base/web 组合和包内说明核对，形成 [工具选型讨论](design/sagitta-tool-selection.md)；本轮仅记录建议，未修改配置。
- 区分模型主动工具、提示词支撑和宿主服务；旧版“启用”来自归档配置声明，不代表历史实际调用。官方 master 的可选 Codex 后端文档仅作参考，固定版兼容性仍须验证。
- 当前发布版从完整 Standard 起步。裁剪既有安装需考虑此前确认的非白名单保留规则；主 Agent 与子 Agent 清单需分别配置。
- 用户已确认 web 搜索/读取、present、working-directory、time-context 保留；Goal 不需要、Todo 关闭且后续归任务机制、Plan 禁用。随后授权先接入所讨论工具：启用 Schedule，子 Agent 和 Workflow 沿用官方实现，后续与异步执行统一适配。

## 2026-10-26：官方工具选择接入

- 用户纠正后，sagitta.json 的 officialPlugins 改为默认选用的官方插件 ID 白名单，替代上一版强制覆盖启停状态的实现。Updater 按 ID 选取 Standard 条目并沿用其配置；缺少官方定义直接报错。首次配置采用该组合，后续沿用既有更新规则，仅 persona 和业务插件参与托管更新。
- Goal 工具/命令、Todo、Planning 组不进入默认组合；Web、Present、时间、Schedule、委派组等进入白名单。工作目录沿用宿主入口，Shell 沿用官方平台条件。已有安装的官方插件及用户配置保留，包括旧版已有的 Goal 等条目；用户删除的非托管条目不补回。策略不承担子 Agent 任务绑定和异步执行适配。
- 本次修改包括 Updater 本体，后续发布需要手动重跑安装器才能取得新实现；当前线上 v0.1.0 保持原样。本批未发布或安装到日常环境。
- 验证：Updater 类型检查、构建及两组接入测试通过。真实 Loader、ConfigEditor 和 pnpm 覆盖首次按白名单组装、升级保留用户 Web 配置、启停状态、删除结果及旧版非托管条目；发布下载使用本地样本，未进行新的模型调用。

## 2026-10-26：异步执行接入前核对

- 用户提出异步调用显式传入 claimId，通过任务校验后放行，未来为记忆快照、过程记录和目录联动保留执行归属；当前先讨论异步接入。详见 [异步执行讨论](design/sagitta-async-discussion.md)。
- 固定 DSH 0.2.1-rc.2 的 spawn/fork 可续聊；同版本官方 Codex 后端每次新进程/临时线程/单轮执行，无续聊或过程工具事件流。已读 npm 包源码，未安装或调用 Codex；不能把官网 master 的能力直接视作本地能力。
- 官方异步启动、通知、取消能力可复用；claim 校验与关联尚未实现。tools.guard 同步、subagent/start 为发布后的观察事件，均不能直接承担异步数据库授权与严格执行前快照。

## 2026-10-26：自主推进与记忆的实施顺序讨论

- 用户提出辅助 AI 定期检查任务偏离、停滞、重组及进展，候选间隔 30 分钟或 1 小时，并将执行记录交给未来记忆模块整理。
- 本轮建议顺序为最小证据/关联、异步委派、自主复查、长期记忆，细节记入异步执行讨论；属于待审查方案，尚未编写功能代码或固定周期。全量操作观察与异步派发分清职责，任务快照与文件快照范围需明确，第二模型收益不预设为已验证结论。
- 用户提出公共包装统一 claim 校验和输入输出记录，以及监督模型双向通信。核对固定版 DSH：tools/pre-execute 支持异步，tools/result 可观察最终工具结果，会话日志已有消息及工具事件。建议优先记录关联并引用原日志，完整请求上下文与子执行过程另行区分；方案待审查，未实现。

## 2026-10-26：结合归档的后续方向调研

- 按用户要求汇总归档、新版和已讨论功能，并检索 Paperclip、OpenClaw、Deep Agents/LangGraph、Mastra、Hindsight/Letta 和 Langfuse 官方资料，记录于 [后续开发方向](design/sagitta-development-direction-2026-10-26.md)。本轮仅研究与建议，未安装框架或改运行代码。
- 优先建议保留 DSH，借鉴 Paperclip 的任务交接/停止检查与 OpenClaw 的唤醒机制；Task Watchdog 检查已停下的任务树，不能等同于运行中偏离监督。其他完整框架会带来另一套消息、状态及运行体系，不能将功能清单丰富直接视为接入收益。
- 建议依次完成授权/派发契约、异步结果处理、事件推进、独立双向复查、记忆首批接入。此为待审查建议，未撤销已确认记忆功能；不将先前讨论或本次调研写成一次性实现授权。

## 2026-10-26：本地聊天预览部署

- 用户要求启动后直接聊天。当前源码重新编译打包，使用本地验包安装入口部署到 `.runtime/Sagitta Chat`，独立 DSH 0.2.1-rc.2、home、agents、workspace 和本地任务数据库。未发布 GitHub Release；公开 v0.1.0 资产不受本地同版本构建影响。
- 本地 `chat.sh` 沿用验包预加载器，将 GitHub 发布下载指向当前本地构建，并在进程启动时从项目 `.env` 提供 DeepSeek 密钥；密钥未复制进脚本或发布包。仅此开发预览入口使用本地样本，正式更新校验未改。
- Web 在 `127.0.0.1:3788` 启动。全新预设采用官方工具白名单，任务模式配置为环境内本地数据库目录，首次挂载自动初始化成功。原有验收环境及日常 DSH 配置未修改。
- 通过浏览器实际选择 Sagitta、调用 DeepSeek，模型执行 `project_list`，工具记录显示输入 `{}`、输出 `[]`，并正常回答。随后创建新的空白会话并选中 Sagitta，页面留给用户；本地服务保持运行。
- 当前可用任务模块与 DSH 原生工具。异步 claim 接入、独立监督及长期记忆仍未实现；persona 中的目标描述不能当成这些能力已完成的证明。

## 2026-10-26：插件显示名称与配置入口核实

- 用户要求任务/记忆插件使用可读名称并前移。Updater 保留 `@sagitta/runtime/task` 和 `/memory` 包子路径，继续检查入口可读；根包导出各自 locale/en.json、zh.json，使用 DSH 原生 meta.title/description。文件 URL 被 readPluginMeta 跳过，是此前显示路径的原因。
- 新初始化的预设将业务插件放在官方组合前；已有配置继续保留顺序。本地聊天环境按本次明确要求前移任务/记忆条目，配置与数据保留，重装当前本地打包的 runtime 和 Updater 后生效。类型检查、构建、两组接入测试通过；实际 Web 已确认中文标题和前两项顺序。
- 核实配置入口：「设置 → 内置插件」为只读状态清单；「设置 → 打开配置文件」访问当前 profile/cordis.patch.yml。任务参数位于 preset-sagitta.config.plugins 中 sagitta-task 的 config；原生后端编辑能力不等于已有专用 Web 表单，图形表单尚未实现。
- 本次重启意外中断用户已开始的模型回合，DSH 保留历史并标记停止。以后维护当前聊天实例，重启前检查活跃回合；不能依据浏览器显示设置页推断后端空闲。
- 用户进一步明确要求通过 GUI 配置任务数据库，打开 YAML 不满足要求。当前缺少 GUI 入口，需要补齐；数据库选择与连接字段继续沿用现有 taskConfig 和 preset-sagitta 中的配置，不应为界面另建一套配置来源。
- 本机官方 ui-settings-plugins 的 README 确认内置清单只读，配置页面由各插件的配套 UI 注册。原生 SettingsForms.describe 还要求 volatileForm 可用；声明构造时 Config 本身不能保证 GUI 自动出现。配套页面及写回预设的方案尚未实现，后续按小批次审查。

## 2026-10-26：独立 Sagitta 设置，后端第一批

- 用户要求设置侧栏单列 Sagitta 设置，前后端分离并分别审查。本批先提供任务配置读写核心 `plugins/task/src/settings/service.ts`；后续独立设置入口通过通信适配调用，尚未注册 RPC、编写前端或改动运行中的聊天实例。
- TaskSettingsService.read 读取 preset-sagitta 内的任务配置，密码仅返回已配置标记；save 复用 taskConfig 校验及 DSH ConfigEditor.edit，保留其他预设字段和插件。密码省略表示保留，显式空字符串表示清空；切到本地模式仅保存 mode/directory。
- 复用原生编辑器的锁、文件持久化及正常 Loader 更新，服务本身不重复实现文件写入或数据库连接；GUI 保存后仍提示用户在当前工作结束后重启。下一批真实接入发现 Loader 条目可能仍保留旧配置，配置读取已改为官方 profile 组合函数，见下文。
- 类型检查、构建及设置服务测试通过，覆盖密码保留/修改/清空/不回显、无效参数不写入、切换模式清除无关字段、其他插件保留和目标缺失。测试使用配置编辑器替身，真实 GUI/RPC 和通过原生编辑器写回文件的验证留到对应接入批次。
- 测试发现 Schemastery 保留输入中的额外字段，不能把模式校验当成自动清理旧字段；本地视图和保存路径显式选取 mode/directory，避免遗留远程密码被带入页面。

## 2026-10-26：Sagitta 设置后端通信

- 用户审查通过读写服务后，本批增加 `settings/controller.ts`，以原生 TypertRemoteService 和 @Remote 暴露 `sagittaSettings/readTask`、`saveTask(input)`；runtime bundle 在宿主注册该服务，依赖 ConfigEditor/profileContext，与会话和数据库实例分开。
- 使用官方支持的 SRC 标记发现模式，Gateway 校验方法及参数名，业务字段沿用 taskConfig 校验；尚未生成 Typert 类型反射或编写前端。身份与权限沿用 DSH Gateway/RemoteAccess。
- 真实原生编辑器测试发现：配置已落盘，但本测试的 Loader 条目仍保留旧值。读写服务因此改用 `composeEntries([readProfilePatches(...)])` 读取保存配置；save 在 ConfigEditor 的锁内读取并合并最新值，避免连续保存丢失修改或恢复旧密码。此方式沿用 Updater 的官方 profile 读取路径。
- 类型检查、构建和两组设置测试通过。临时 profile 中真实挂载 Gateway、ConfigEditor、预设声明和设置服务，验证保存后读取、连续保存保留新密码、非法端口不改文件、非 owner 无策略时拒绝访问，以及重启后恢复并保留其他插件。预设注册的消费者使用替身，未启动数据库、浏览器 HTTP 或调用 LLM。
- 本批未安装到当前聊天环境，未重启正在运行的聊天服务。前端设置页留待后端代码审查后实现。

## 2026-10-26：Sagitta 设置前端

- 用户审查通过后端后，实现 `plugins/settings/src/index.tsx`，通过原生 `settings.section` 注册侧栏独立入口，使用 Connection RPC 调用既有 readTask/saveTask。前端仅以类型导入后端契约，浏览器运行时复用宿主 React；构建产物单独放在 plugins/settings/dist。
- 页面提供本地目录、自定义主机/端口/数据库/用户/密码/TLS/CA 路径。密码留空保留，勾选清空明确提交空字符串；保存期间禁用表单，失败保留输入并显示错误，成功提示手动重启。保存请求只维护配置，数据库连接和初始化仍由任务插件承担。
- 核对固定版 ClientModules：裸包名和文件路径参与前端发现，包子路径不参与。宿主设置入口因此改为根导出 `@sagitta/runtime`，RPC 名称保持不变；根清单声明 ./client 和 dsh.client，发布脚本同步清理并打包前端产物。
- 类型检查、构建、两组后端设置测试及 npm pack 内容检查通过。独立 DSH_HOME 的真实 Web 在 3790 验证侧栏入口、两种表单保存、重新打开读取保存值及成功提示；未调用模型、未执行数据库连接测试。临时服务和浏览器页已关闭，当前 3788 聊天实例保持运行。
- npm 官方源下载 esbuild 平台二进制缓慢，本次依赖安装临时使用 npmmirror 命令参数，未修改全局 registry。前端截图保存在忽略的 .runtime/settings-ui-review/sagitta-settings.png，代码留待用户审查后再安装到聊天环境。

## 2026-10-26：设置页样式调整

- 用户反馈首版样式生硬。本批将样式独立到 settings/src/styles.ts，沿用 DSH 主题变量，改为圆角卡片、细边框、次级说明与原生主按钮配色；常用连接字段双列排列，小屏单列。仅调整展示结构和说明层级，配置与 RPC 行为沿用已审查实现。
- build:settings 类型检查和构建通过；独立 3790 Web 实际查看本地、自定义两种布局并保存截图。当前聊天实例保持原样，样式仍待审查后安装。

## 2026-10-26：准备发布 v0.1.1

- 用户授权将已审查版本推送 main、发布 0.1.1 并验证自动更新。根运行包及有改动的 Updater 均升为 0.1.1，DSH 仍固定 0.2.1-rc.2；安装与发布文档补齐 GUI 配置入口。
- 发布前根目录类型检查/构建、38 项真实 PostgreSQL 与设置测试、2 项 Updater 接入测试、5 项安装器测试通过；3 项可选的数据库部署测试未启用。首次全量测试缺少 SAGITTA_TEST_DB_CONFIG，提供隔离验收库后全部必需检查通过。
- 在既有 Sagitta Test 验收环境中，保留正式发布的 Updater 0.1.0，使用本地下载替换器提供 0.1.1 运行包，启动后实际安装并通过认证 HTTP 调用新设置接口成功。此为发布前本地预检；真实 GitHub 下载及同版跳过结果将在发布后另记。

## 2026-10-26：v0.1.1 发布和联网升级验收

- 748c29a 已推送 main 并标记 v0.1.1；发布脚本从干净工作树重新构建，上传 install.py、release.json、runtime/updater 两个 tgz，GitHub Latest 指向该正式版本，清单 dirty=false。Updater 0.1.1 包含此前已审查的工具白名单及包名处理；自身保持手动安装。
- 在 Sagitta Online 隔离验收环境中，保留正式 Updater 0.1.0 并关闭下载替换器，实际从 GitHub 自动安装 runtime 0.1.1。缓存归档 SHA-256 与发布清单相同；原任务库配置和非托管插件的完整配置哈希保持一致；新设置 RPC 返回原配置，前端模块被实际 Web 页面发现。
- 再次正常联网启动时，日志明确显示“已安装，跳过下载和安装”及“准备完成”；认证调用 agentPresets/list 确认 Sagitta 存在且无 broken 诊断。归档修改时间和 profile package.json 哈希均未变化，证明未重复下载或安装。
- 复测过程中曾遇到 github.com/release-assets.githubusercontent.com 的 TLS ECONNRESET，导致现有实现不提供 sagittaReady；这是已知的联网检查失败即不就绪路径。后续使用原代理环境正常重启通过；未添加重试、离线回退或改动代理优先级。临时日志导出仅用于隔离验收，未进入发布包。
- 当前 3788 聊天进程保留，会话未中断；其本地 chat.sh 从固定本地 v0.1.0 验包切到 online，之后手动重启会检查正式 Release。实际联网升级结论来自隔离环境；当前进程仍使用启动时版本。
