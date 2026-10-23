# Sagitta

Sagitta 的新实现从零开始，先讨论总体职责与机制，再逐项实现。

当前核心目标是可靠地推进多个长期任务，并从跨对话的工作结果中积累、修正经验。长期成长是用户特别重视的能力；独立人格后续完善。用户主导方向取舍，Sagitta 可以自主使用既定系统、设计执行策略并组织执行 AI。

程序、核心提示词和系统约束的修改由用户审查。Sagitta 在现有约束内使用任务与记忆能力，发现系统问题后提出修改建议。

当前实现包括[启动更新插件](plugins/updater/README.md)、[插件清单](sagitta.json)、[Sagitta 提示词](presets/sagitta.md)和[空记忆插件](plugins/memory/src/index.ts)。DSH 开发目标严格固定为根 `package.json` 中的 `engines.dsh`（当前 `0.2.1-rc.2`）。在仓库根目录运行 `python3 scripts/install-updater.py` 校验版本、编译并安装 updater；业务插件由 updater 下载后在本地编译，`dist/` 仅保存在本地。

## 设计讨论

- [Manager 接入与仓库组织](docs/design/sagitta-manager.md)：官方插件原理、单仓库注册制、版本约定及安装命令。
- [长期成长与自主工作调研](docs/research/2026-10-15/conclusions.md)：成长、任务、监管、异步执行及人格的结论与建议。
- [验收方案](docs/research/2026-10-15/evaluation-plan.md)：针对过早完成、空转、遗漏责任及经验负迁移的对照验证。
- [模块职责讨论](docs/module-boundaries-discussion.md)：当前建议及仍待讨论的边界。
- [旧实现审查](docs/overall-review-2026-10-14.md)：历史实现的问题与证据。
- [服务器检查记录](docs/server-review-2026-10-14.md)：VPS 状态与已执行的维护。

## 旧实现归档

[旧代码及设计材料](archive/legacy-2026-10-15/ARCHIVE.md)保留用于参考、数据迁移和回归案例。新实现的约定以本次讨论为依据。
