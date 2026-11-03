# Sagitta

天箭座计划（ProjectSagitta）是星伞计划（ProjectCelis）面向实际工作的前置探索。我们希望 Sagitta 成为能长期共事的 AI 助手：人与它一起确定方向，它负责拆解工作、协调执行、检查结果，并从一次次交付中学会怎样把事情推进下去。

用户主导方向取舍，Sagitta 可以在既定系统内选择策略、安排任务或提出不同意见。程序、核心提示词和系统约束的修改由用户审查。

## 四个开发方向

以下状态以 [v0.1.2](https://github.com/PureDimension/sagitta-agent/releases/tag/v0.1.2) 为准。

| 方向 | 希望 Sagitta 能做什么 | 当前状态 |
| --- | --- | --- |
| **多任务管理** | 同时跟进多个长期项目。先安排眼前能做的任务，取得阶段结果后，再决定下一批工作。 | **任务插件已发布。** 项目下可以直接建任务，也可以用目标组织多批任务。已支持跨会话保存、认领与交接、状态变更，以及在模型上下文中展示当前工作。完成目标时会列出尚未结束的任务。[任务与目标接口](docs/design/sagitta-task-tools.md) |
| **记忆与成长** | 跨对话跟进具体项目，从实际结果中积累管理经验。例如记住上次委派为何返工，下次遇到类似工作时主动调整验收方式。 | **已讨论设计，插件目前为空壳。** 已研究按基础库和项目库保存材料、召回相关经历及整理经验。自动写入、召回和经验修正均待接入，长期使用效果待验证。[记忆设计](docs/design/sagitta-memory-discussion.md) |
| **自主推进与监管** | 用户离开后，Sagitta 能回看目标和实际产出，判断工作是否停滞或偏离，并决定继续、调整方向或请求协助。 | **处于设计阶段。** 当前后台会定时续租和回收认领；这些操作只维护任务归属。根据进度唤醒管理会话、检查工作质量和纠偏仍待实现。[自主推进方向](docs/design/sagitta-development-direction-2026-10-26.md) |
| **异步执行与协作** | 将具体工作委派给 Codex 等子 Agent，等待期间切换到其他任务，结果返回后再检查和接续。 | **已有 DSH 基础，Sagitta 适配待实现。** 预设已启用 DSH 的委派和后台作业工具。把执行绑定到任务认领、跟踪子 Agent 的产出并交还给对应任务，仍是后续工作。[异步执行设计](docs/design/sagitta-async-discussion.md) |

## 安装与启动

准备 Node.js、npm、pnpm 和 Python 3。从 [GitHub Release](https://github.com/PureDimension/sagitta-agent/releases) 下载 `install.py`：

```sh
python3 install.py --directory "$HOME/Sagitta"
"$HOME/Sagitta/sagitta.sh"
```

Windows 使用 `py -3 install.py --directory D:\Sagitta`，然后运行 `D:\Sagitta\sagitta.cmd`。
安装器在指定目录局部安装发布包要求的精确 DSH 版本（当前 `0.2.1-rc.2`）和 Updater；Node.js 引擎要求由 npm 严格校验。
启动入口固定使用目录内的程序、配置、插件、会话和指引目录，并保留启动时的工作目录。Web 中选择 Sagitta 预设。
首次使用请在「设置 → Sagitta 设置」配置本地数据库目录，或填写已有 PostgreSQL 连接；保存后重启。数据库配置说明见[任务插件](plugins/task/README.md)。

```text
Sagitta/
├── runtime/       固定版本 DSH 与依赖
├── home/          DSH 配置、插件、会话和发布包缓存
├── agents/        通用指引与技能
└── sagitta.sh     Windows 对应 sagitta.cmd
```

再次运行安装器并指定同一目录可更新 DSH 和 Updater；业务包由启动时的 Updater 自动检查更新。
源仓库只提交源码，开发端编译并发布 tgz，使用端无需 TypeScript 或 Git。[发布说明](docs/release.md)介绍构建与验收流程。

## 当前边界

- 首版以单实例使用为主要验收范围。多个实例共用数据库时，临时任务到期提醒存在竞争丢失问题，详见[审查报告](docs/reviews/2026-10-25-sagitta-review.md)。
- 启动检查 GitHub 失败时 Sagitta 不就绪；当前没有离线回退。
- 本机验收平台为 macOS ARM；Windows/Linux 安装路径已提供，尚未实机验证。

## 设计讨论

- [Manager 接入与仓库组织](docs/design/sagitta-manager.md)：官方插件原理、单仓库注册制、版本约定及安装命令。
- [长期成长与自主工作调研](docs/research/2026-10-15/conclusions.md)：成长、任务、监管、异步执行及人格的结论与建议。
- [验收方案](docs/research/2026-10-15/evaluation-plan.md)：针对过早完成、空转、遗漏责任及经验负迁移的对照验证。
- [模块职责讨论](docs/module-boundaries-discussion.md)：当前建议及仍待讨论的边界。
- [旧实现审查](docs/overall-review-2026-10-14.md)：历史实现的问题与证据。
- [服务器检查记录](docs/server-review-2026-10-14.md)：VPS 状态与已执行的维护。

## 旧实现归档

[旧代码及设计材料](archive/legacy-2026-10-15/ARCHIVE.md)保留用于参考、数据迁移和回归案例。新实现的约定以本次讨论为依据。
