# Sagitta 发布流程

开发端编译和打包，将产物上传到 GitHub Release；使用端获取编译后的包。
发布端打包脚本、独立安装脚本与 Updater 的 Release 下载流程已实现。

## 本地验包

开发机先安装根目录和 plugins/updater 的开发依赖，然后执行：

```sh
python3 scripts/release.py
```

脚本清理并重建 shared、task、memory、settings、updater 的 dist 目录，使用 npm pack 按 files 清单打包，输出到 `.runtime/releases/v<根包版本>/`。
包含 runtime、updater 两个 tgz 包、release.json 和 install.py；清单记录提交、工作树是否有修改、DSH 版本和包 SHA-256。
包内包含 JS、必要类型声明、SQL、提示词和包元信息，不携带本机 node_modules 或凭据。
运行包的 bundle patch 挂载宿主级设置服务；会话内加载哪些业务插件仍由 Sagitta 预设决定。

## 发布

更新根 package.json 的 version；Updater 有变更时也更新其自身版本。审查、验证并提交代码，
将对应的 `v<根包版本>` 标签推送到 GitHub，再运行：

```sh
python3 scripts/release.py --publish
```

需要已登录的 GitHub CLI。脚本要求干净工作树及远程标签指向 HEAD，重新构建后上传四个发布资产并标记为 Latest。
现有 Release 不覆盖；每次正式发布使用新的根包版本。Updater 自身仍手动安装，后续只自动更新 runtime。

## 用户安装

从最新正式 Release 下载 install.py，运行 `python3 install.py --directory "$HOME/Sagitta"`；Windows 使用 `py -3 install.py --directory D:\Sagitta`。
需要已安装 Node.js、npm、pnpm 和 Python 3。DSH 由安装器局部安装到 runtime 子目录，精确版本取发布清单；npm 使用 engine-strict 检查 Node.js 要求。
安装器校验 Updater 包 SHA-256，通过目录内 DSH 的官方命令安装到独立 home/profiles/web；插件安装禁用生命周期脚本和 peer 自动安装。
安装完成运行目录内 sagitta.sh / sagitta.cmd；首次安装目录应为空，后续指定同一目录更新 DSH 和 Updater，保留数据。
脚本源文件是 scripts/install-updater.py，发布脚本原样复制为独立资产 install.py。
运行包由启动后的 Updater 下载；数据库、任务和用户配置保留在各自的数据位置。

## Updater 如何使用

启动时读取 Latest Release 的 release.json，要求 dirty=false、DSH 版本匹配。
已安装 runtime 版本等于 tag 去掉 v 后的版本时直接复用；不同则按该 tag 下载清单中的 runtime 资产，
验证 SHA-256 后调用 DSH 原生安装操作。安装保留包缓存，禁用生命周期脚本及 peer 自动安装。
随后刷新模块解析、保留现有用户配置并准备 Sagitta 预设。具体行为见 plugins/updater/README.md。

本地验包的 dirty=true 产物只用于测试；正式发布前需要提交审查后的修改。
安装器和 Updater 读取已发布的 Latest Release，开发目录中的产物须通过下述诊断脚本验收。

## 本地验收

`python3 tests/diagnostics/install-release.py .runtime/releases/v0.1.0 <隔离目录>` 使用打包的 install.py，只替换 GitHub 下载，实际从 npm 安装 DSH 和 Updater。
`node tests/diagnostics/packed-web.js <隔离目录> .runtime/releases/v0.1.0 create` 启动真实 Web 环境、加载业务包、初始化目录内数据库，并执行工具与真实模型验收。
同一命令最后一个参数换成 resume，重启后继续原会话并完成任务。测试读取仓库本地 .env 的 DEEPSEEK_API，通过进程环境提供模型密钥；测试文件不保存密钥。
发布后将发布目录参数改为 online 可访问真实 GitHub 验证。测试数据库进程需在验收后停止；测试环境、日志和本地包均位于 Git 忽略目录中。
