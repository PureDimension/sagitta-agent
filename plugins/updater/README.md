# Sagitta Updater

手动安装的 DSH 宿主插件。每次启动检查 `PureDimension/sagitta-agent` 的最新正式 GitHub Release，安装预编译运行包，再准备 Sagitta 原生预设声明。Updater 自身和 DSH 本体保持手动更新。

从 GitHub 最新正式 Release 下载 `install.py`，在保存位置运行：

```sh
python3 install.py --directory "$HOME/Sagitta"
"$HOME/Sagitta/sagitta.sh"
```

需要 Python 3、Node.js、npm 和 pnpm。Windows 使用 `py -3 install.py --directory D:\Sagitta`，随后运行 `D:\Sagitta\sagitta.cmd`。仓库内对应入口为 `python3 scripts/install-updater.py --directory <目录>`，行为相同。脚本读取最新正式发布清单，下载 Updater 包并核对 SHA-256，在 runtime 子目录用 npm 严格校验引擎要求并安装精确版本 DSH，再通过这套 DSH 的官方插件命令安装 Updater。

首次安装使用空目录。runtime/package.json 的 sagitta-environment 标识用于识别已有安装，再次指定同一目录会保留数据并更新；已识别安装中途失败可重新运行。安装脚本可在任意工作目录执行，成功后生成当前平台的启动入口。

启动入口设置 DSH_HOME=<安装目录>/home、DSH_AGENTS_HOME=<安装目录>/agents，并将局部 DSH 加入当前进程 PATH，保持原工作目录、透传启动参数。例如 `sagitta.sh --no-open --port 8080`。系统中的其他 DSH 保持独立；Node.js、包管理器和下载缓存仍由用户环境提供。

下载包保存在 home/profiles/web/sagitta-releases/<tag>/，供 pnpm 保存的本地路径复用。脚本使用 Python urllib 标准代理和证书校验；Updater 下载使用 DSH 为全局 fetch 配置的代理。升级 DSH 和 Updater 需要手动重新运行安装器，业务包由 Updater 自动更新。

## 启动更新

1. 读取 `/releases/latest/download/release.json`，检查正式构建标记和 DSH 精确版本。
2. 对比当前 profile 安装的 `@sagitta/runtime` 版本；相同则复用。
3. 版本不同时，按清单中的固定 tag 下载运行包，核对 SHA-256。
4. 将包保存在 `profile/sagitta-releases/`，调用与 `dsh plugin` 共用的官方安装操作；关闭安装脚本及 peer 自动安装。运行包只携带生产依赖，DSH 框架 peer 由宿主提供。
5. 刷新 DSH 模块解析表，读取运行包的 `sagitta.json` 和提示词，保存原生预设配置，最后提供 `sagittaReady`。

运行代码位于 profile 的 `node_modules/@sagitta/runtime/`；包缓存保留，供 pnpm 后续使用保存的本地包路径。原来的 `sagitta-source/` 和 `sagitta-built-commit` 已停止使用，已有旧文件由用户自行清理。

下载、版本检查、校验、安装或配置准备失败会输出错误；Sagitta 声明等待准备完成，其他 DSH 预设继续运行。当前网络检查失败同样会阻止 Sagitta 就绪。memory 仍是空插件；task 可配置本地目录或自定义数据库连接。

`src/release.ts` 负责发布包检查与安装，`src/profile.ts` 负责配置保存，`src/index.ts` 串联启动流程。编译产物集中在 `dist/`，DSH 通过包入口加载 `dist/index.js`。

Git 仓库保存源码，`dist/` 被 Git 忽略；开发端编译后上传 Release。使用端安装运行包时无需 Git、TypeScript 或源码构建。终端显示检查、下载、安装、配置保存和就绪阶段。

开发时在 `plugins/updater` 目录用 `npm run check` 检查类型、`npm run build` 编译 updater；仓库根目录的 `npm run build` 编译业务插件。构建不生成 `.d.ts`。

运行时依赖安装关闭生命周期脚本，带有构建或原生安装脚本的依赖需要另行接入。保留官方标准预设，persona 只替换 Sagitta 这一份副本。

## 配置保存与生效

安装包声明 `preset-sagitta`，类型为官方 `@deepseek-ai/dsh-agent-preset`；它通过 `sagittaReady` 依赖等待 Updater 安装和配置准备完成，之后由 DSH 加载。业务插件位于这条预设内，仅供 Sagitta 会话使用。

配置存放在当前 profile 的 `cordis.patch.yml`（启动日志显示完整路径），位于 `id: preset-sagitta` 的 `config.plugins` 中。例如找到 `id: sagitta-task`，修改其 `config`；字段由任务插件自己的 `Config` 定义。可使用 DSH 原生配置编辑接口保存，也可直接编辑此文件。本批未新增专用 Web 配置表单。

**修改并保存后，请手动重启 DSH，让已有会话使用新配置。** 配置说明和运行期变更日志都会提示这一点。DSH 原生热重载可能提前为新会话应用修改；已有会话按官方预设生命周期保留原组合。

预设更新采用白名单：`persona` 和 `sagitta.json` 登记的业务插件。首次配置空预设声明时填入官方默认组合；后续以本地清单为基础，仅更新白名单条目，新加入白名单的插件追加到末尾。已有条目保持原位置。

非白名单条目整体保留，包括名称、配置、启停状态、条件表达式和嵌套插件组；用户删除的非白名单插件不会被补回，官方默认组合新增的条目也不会自动加入已有预设。此前托管但已移出白名单的条目同样保留，删除或迁移需要明确处理。

白名单业务插件按稳定 ID 合并配置：已有同名值保留，新字段采用发布包默认值；`persona.config.prefix` 始终采用发布包中的 Sagitta 身份正文，其他配置保留用户值。字段改名、类型变化和数据库迁移仍需显式处理。
