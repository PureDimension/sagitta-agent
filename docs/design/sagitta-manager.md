# Sagitta Manager 接入约定

2026-10-20。当前准备分发包骨架、注册清单、提示词草稿和空记忆插件。Manager 运行入口、更新逻辑、DSH 挂载及安装尚待逐块审阅实现。

## 已确认的范围

- 来源固定为一个 GitHub 仓库 `PureDimension/sagitta-agent`，统一提供插件、提示词和配置。
- 通过注册清单统一管理 Sagitta 插件。Manager 支持空清单；本次按用户要求登记空 memory 作为管理对象。
- DSH 版本直接相等。当前目标为 `0.2.1-rc.2`，唯一版本字段为根 `package.json` 的 `engines.dsh`。
- 自身更新或装配失败输出 warning/error，只影响 Sagitta 的可用性，其他预设继续可用。
- 首轮只处理单仓库、启动更新、配置读取和预设注册。多仓库、版本回滚、热替换、额外依赖调度后置。
- 程序、核心提示词和注册清单的变更由用户审查后发布。
- 官方 Hindsight 后续独立接入普通 Agent 的可选预设；Sagitta 使用自己的 memory。

## DSH 插件如何工作

1. Profile 保存插件包依赖。包内 `dsh.bundle.patch` 指向配置补丁，官方安装命令负责安装和启用这个配置层。
2. 补丁声明插件行，Loader 导入 JavaScript 入口，调用 `apply(ctx, config)` 或初始化服务类。`ctx` 提供工具、提示词、事件和预设注册等服务。
3. 插件注册工具、注入提示词、监听事件，各自实现功能。Manager 位于宿主层；Sagitta 的身份与工具位于 Sagitta 预设作用域。
4. 预设注册时 DSH 会提前加载插件树；选择预设的 Agent 绑定这套能力。初始化需要区分注册能力与实际处理某个 Agent 的任务；预设作用域也不等同于操作系统安全沙箱。

## Manager 的最小流程（待实现）

1. 更新固定仓库的运行副本。开发 checkout 与运行副本路径在实现安装步骤时确定。
2. 读取仓库目标版本，与官方 `getDshRuntimeVersion()` 的结果直接比较；读取 `sagitta.json`。
3. 从固定版本的官方 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 读取标准工具列表，用官方 YAML 方言保留平台条件。
4. 在自己的列表里替换 persona 的 `config.prefix` 为 `presets/sagitta.md`，追加登记插件。
5. 调用 `ctx.agentPresets.register({ id, name, description, plugins })`，把返回的注销函数交给 Cordis 管理生命周期。

这是 Manager 读取官方内容后自行装配；DSH 预设没有 `extends: standard` 字段。官方标准预设文件和注册记录保持原样。

结果是预设列表出现 Sagitta，所选会话获得对应提示词和能力。空 memory 只验证装配，实际记忆能力后续实现。DSH 已提供预设加载诊断与隔离；Manager 在更新、读文件、解析和注册的边界报告错误。启动和隔离效果仍待接入验证。

## 仓库组织

```text
package.json               单个分发包；DSH 版本、仓库地址、插件入口映射
sagitta.json               预设元信息和插件注册清单
presets/sagitta.md          用户可修改的最简身份指导
plugins/
  manager/index.js          后续实现：更新、读取和预设注册
  memory/index.js           当前为空的普通 Cordis 插件
```

建议首轮用一个 npm 包 `@sagitta/manager` 分发，通过子路径导出各插件。例如 `@sagitta/manager/memory` 映射到 `plugins/memory/index.js`。各模块仍是独立 Cordis 插件；共同分发省去多个包的独立安装和版本同步。

清单直接沿用 DSH 插件行的 `id`、`name`、`config`，由 exports 定位仓库文件。新增插件增加一个导出和一行登记。工具操作规则随插件提供。

当前根包只导出空 memory，尚未声明 bundle。下一块实现 Manager 时添加主入口和 `cordis.patch.yml`，由补丁挂载 Manager。

## 安装命令

安装指定 DSH 版本：

```sh
npm install --global @deepseek-ai/dsh@0.2.1-rc.2
```

安装 Manager（完成入口和 bundle 声明后，从仓库根目录执行）：

```sh
dsh plugin --profile web add .
```

第二条使用官方安装通道，PATH 还需要 pnpm；当前包处于骨架阶段，尚不可作为 Manager bundle 启用。远程安装 spec 在 GitHub 发布时核实。本轮没有运行安装命令或发布新实现。

官方使用 `engines.dsh` 检查兼容性。Manager 再对仓库目标版本和实际运行版本做直接相等检查，以执行本项目约定。

## 提示词取舍与核对依据

参考历史 `99a8ef6`、`6ad14c5`、`36fd923` 与本轮目标，保留工作伙伴、管理与委派、轻量执行、独立判断、用户主导、验收和经验修正。旧四流、评分、固定执行模型、旧工具名称、自行升级及自动提交推送约定已过时。提示词描述目标行为，任务、记忆和长期离线运行还需模块实现。

核对 npm 发布的 DSH CLI、app-boot、agent-preset、agent-preset-registry、persona、web-app 和 plugin-manager 的 `0.2.1-rc.2` 包；该版本为 2026-10-20 检查时的 npm latest。下载材料在忽略目录 `.runtime/dsh-research/`。

- [CLI](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/apps/cli/src/bin.ts)
- [预设注册实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/preset/agent-preset-registry/src/index.ts)
- [标准预设](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/bundle/web-app/presets/standard.patch.yml)
- [persona](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/preset/persona/src/index.ts)
