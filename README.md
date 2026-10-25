# Sagitta

Sagitta 的新实现从零开始，先讨论总体职责与机制，再逐项实现。

当前核心目标是可靠地推进多个长期任务，并从跨对话的工作结果中积累、修正经验。长期成长是用户特别重视的能力；独立人格后续完善。用户主导方向取舍，Sagitta 可以自主使用既定系统、设计执行策略并组织执行 AI。

程序、核心提示词和系统约束的修改由用户审查。Sagitta 在现有约束内使用任务与记忆能力，发现系统问题后提出修改建议。

当前实验版实现了[任务插件](plugins/task/README.md)、[启动更新插件](plugins/updater/README.md)、[插件清单](sagitta.json)与 [Sagitta 提示词](presets/sagitta.md)。[记忆插件](plugins/memory/src/index.ts)仍为空壳；长期记忆、自主推进和异步执行模块后续开发。

## 安装与启动

准备 Node.js、npm、pnpm 和 Python 3。从 [GitHub Release](https://github.com/PureDimension/sagitta-agent/releases) 下载 `install.py`：

```sh
python3 install.py --directory "$HOME/Sagitta"
"$HOME/Sagitta/sagitta.sh"
```

Windows 使用 `py -3 install.py --directory D:\Sagitta`，然后运行 `D:\Sagitta\sagitta.cmd`。
安装器在指定目录局部安装发布包要求的精确 DSH 版本（当前 `0.2.1-rc.2`）和 Updater；Node.js 引擎要求由 npm 严格校验。
启动入口固定使用目录内的程序、配置、插件、会话和指引目录，并保留启动时的工作目录。Web 中选择 Sagitta 预设。
首次使用请为任务插件配置本地数据库目录，或填写已有 PostgreSQL 连接；保存后重启。数据库配置说明见[任务插件](plugins/task/README.md)。

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
