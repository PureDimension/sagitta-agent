# Sagitta Updater

手动安装的 DSH 宿主插件。每次启动检查固定 GitHub 仓库，下载同一提交的预设、提示词和插件，检查 DSH 精确版本，在本地安装构建依赖并编译，再注册 Sagitta。Updater 自身和 DSH 本体保持手动更新。

从仓库根目录安装：

```sh
python3 scripts/install-updater.py
dsh web
```

需要 Python 3、匹配版本的 DSH、Git、npm 和 pnpm。安装脚本只使用 Python 标准库，先将 `dsh --version` 与根 `package.json` 的 `engines.dsh` 精确比较，再安装 updater 开发依赖、编译并安装到 `web` profile；任一步失败即停止。Windows 可使用 `py -3 scripts/install-updater.py`。下载继承启动进程的代理环境变量（HTTPS_PROXY、ALL_PROXY、HTTP_PROXY 及小写形式，也支持 PROXY/proxy）。

Updater 固定拉取 `stable` 分支；`main` 用于日常开发，确认可用的版本再推进到 `stable`。源码保存在该 profile 的 `sagitta-source/`，与本仓库开发目录分开；该目录由 updater 管理，用户配置、密钥和数据应另存。

失败会输出错误，Sagitta 不注册，其他 DSH 预设继续运行。此次只验证启动更新；memory 是空插件。初始化、数据迁移和运行中热更新留待后续审查。

源码为 `src/index.ts`；编译产物集中在 `dist/`，DSH 通过包入口加载 `dist/index.js`。

GitHub 只保存源码，`dist/` 为本地生成的 Git 忽略目录。安装脚本编译 updater；updater 启动后安装下载仓库的开发依赖并调用根 `build` 脚本。当前提交已成功构建且业务插件入口存在时跳过构建；成功记录保存在 profile 的 `sagitta-built-commit`。目前 `stable` 的旧 JS 版本无构建脚本，使用 `--if-present` 兼容。

开发时在 `plugins/updater` 目录用 `npm run check` 检查类型、`npm run build` 编译 updater；仓库根目录的 `npm run build` 编译业务插件。构建不生成 `.d.ts`。

运行时依赖安装关闭生命周期脚本，带有构建或原生安装脚本的依赖需要另行接入。保留官方标准预设，persona 只替换 Sagitta 这一份副本。
