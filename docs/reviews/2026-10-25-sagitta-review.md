# Sagitta 独立审查与真实 DSH 调用验证

日期：2026-10-25。范围：当前工作树，包括尚未提交的任务插件、Updater、公共支撑、脚本及测试。
用户要求一个子 Agent 独立审查；主线程复核关键路径，并按后续要求使用本地 DeepSeek API 做真实调用。
本批没有修改运行实现，没有提交或推送，也没有将插件安装进日常使用的 profile。

## 审查结论

后续进展：前两项已由预编译 Release 安装、官方 profile 配置持久化解决，真实独立 DSH 安装下已验证工具调用和重启恢复。第三项多实例通知竞争仍保留为首个实验版本的已知限制。以下原始审查结论保留用于追溯。

发现三项 P2，未发现可确认的 P1。任务核心的主动操作可以通过真实 DSH 调用；
完整 Updater 安装路径、配置持久化和多实例通知仍有缺口。

### P2：Updater 安装布局可能产生第二份 DSH scope 实例

- 位置：`plugins/updater/src/index.ts:88`、`plugins/task/src/adapters/maintenance.ts:74`。
- Updater 在 profile 内的 sagitta-source 执行包含开发依赖的 npm install；根包声明了 dsh-scope 的 peer/dev 依赖。
- 官方 DSH 解析器对 profile 内的本地依赖优先采用 native 解析；dsh-scope 使用模块私有 Symbol 和 WeakMap。
- 宿主与任务插件分别加载一份 scope 时，插件的 scopeOf(ctx) 读不到宿主标签；当前 guard 因 scope 为 undefined 放行所有已有会话。
- 结果可能是接管其他预设会话的续租，或将续租错误送到无关会话。
- 证据等级：源码核对，以及两份官方 scope ESM 实例的内存复现。后续使用官方 runtime resolution / Worker bootstrap 在隔离目录模拟当前 profile/sagitta-source 布局：即使根包声明 peer，本地 scope 副本仍被选中，读取宿主作用域失败；移除本地副本或改为官方识别的外部 linked root 后读取成功。完整 GitHub 下载/npm 安装链仍未验证。
- 修复方向：统一框架 peer 的运行时解析来源，并在实际安装布局下验证会话作用域隔离。

### P2：Updater 预设缺少持久的任务数据库配置入口

- 位置：`sagitta.json:12`、`plugins/updater/src/index.ts:111`。
- task 注册配置固定为 `{}`，采用 5432 和空密码；当前数据库安装脚本默认采用 55432 和随机密码。
- Updater 没有读取本地连接配置并传入 task；修改受更新管理的 sagitta.json 会将连接凭据混入仓库内容。
- 官方 programmatic preset 使用内存 PresetTree，write() 为空，预设文档读取接口不能完成持久写回。
- 现有配置热重载测试覆盖直接装载 task，尚未证明通过 Updater 创建的预设能够持久修改连接配置。
- 证据等级：源码及官方 registry 实现核对；默认配置与本机安装参数不匹配。
- 修复方向：确定 profile 本地配置的持久入口，组装预设时显式传入业务插件。
- 后续修复：任务插件新增本地目录托管模式，旧安装脚本已移除；Updater 改用官方 profile 根预设声明，按插件 ID 保留配置。已通过真实 Loader、官方 preset 声明和 ConfigEditor 保存/重启测试；Git/npm 边界使用替身验证更新与失败路径。专用 Web 配置表单及日常 profile 实装仍未验证。

### P2：多个回收实例可能吞掉在线会话的临时任务到期提醒

- 位置：`plugins/task/src/repository/claim.ts:75`、`plugins/task/src/service/automation/reclamation.ts:41`、`plugins/task/src/adapters/maintenance.ts:46`。
- 两个设备或插件作用域共用数据库。B 的原会话持续在线超过 20 分钟，其临时任务到期。
- A 的全库扫描先删除任务并提交，然后按本设备/本作用域过滤通知，将 B 的结果丢弃。
- B 下一次扫描已没有该记录，无法提醒原会话；这是在线通知竞争，超出已接受的离线不补发边界。
- 证据等级：确定的源码执行路径；现有身份过滤测试没有覆盖两个回收器争抢同一记录。
- 修复方向：明确清理结果如何交给原 owner；修改通知过滤条件不足以恢复已被删除的结果。

## 风格与维护性

- Adapter、Service、Repository 分层清楚，事务范围显式，公共调度得到复用，整体符合当前项目约定。
- Updater 的初始化集中承担下载、版本检查、构建、预设组装，可在后续改动时按阶段提取；这是维护建议。
- 架构文档开头和模块表仍有自动维护待实现、工具数量 11 个等旧描述，应更新当前状态摘要。
- 未将已确认的无限制 description、尚未接入的记忆/资源门禁、无离线持久补发列为本轮缺陷。

## 验证结果与范围

- 根构建、Updater TypeScript 检查通过；当前 35 项测试全部通过。
- 使用已安装的 DSH 0.2.1-rc.2 headless 正式启动入口、独立 DSH_HOME、隔离 PostgreSQL schema。
- 加载当前 task 编译入口、memory 空壳入口和 Sagitta persona；禁用本次无关的文件、命令和子 Agent 工具。
- 使用 `.env` 中的 DeepSeek 凭据，沿用 DSH 官方 deepseek-official/deepseek-flash 路由；凭据未输出。
- 第一进程：真实模型依次调用 project_list、project_create、task_create（正式且立即认领）、task_get，均成功。
- 数据库确认任务为 in_progress，返回 claimId 与认领表一致。
- 第二进程：通过 --session-id 恢复同一会话，模型报告当前工作信息，调用 task_complete、task_get，均成功。
- 数据库确认任务为 done，认领行已删除；两个进程均以 0 退出。
- 模型对上下文可见性的陈述仅作辅助证据；任务动态组装另有现有接入测试覆盖。
- 模型建议“详情必须包含 claimId”等属于它的临时判断，未作为本项目需求或缺陷采纳。
- 隔离 schema 和测试 profile 已清理，未留下业务任务。
- 本次直接加载当前工作树并显式传入连接配置，未验证 GitHub Updater 全流程、Web 预设配置界面或真实等待 20 分钟后的到期提醒。
