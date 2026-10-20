# Sagitta Updater

手动安装的 DSH 宿主插件。每次启动检查固定 GitHub 仓库，下载同一提交的预设、提示词和插件，检查 DSH 精确版本，安装依赖，再注册 Sagitta。Updater 自身和 DSH 本体保持手动更新。

从仓库根目录安装：

```sh
npm install --global @deepseek-ai/dsh@0.2.1-rc.2
dsh plugin --profile web add file:./plugins/updater
dsh web
```

需要 Git、npm 和 pnpm。下载继承启动进程的代理环境变量（HTTPS_PROXY、ALL_PROXY、HTTP_PROXY 及小写形式，也支持 PROXY/proxy）。

唯一配置 `branch` 默认 `main`；测试开发分支时，在 profile 的 `cordis.patch.yml` 覆盖 `sagitta-updater` 的 `config.branch`。源码保存在该 profile 的 `sagitta-source/`，与本仓库开发目录分开；该目录由 updater 管理，用户配置、密钥和数据应另存。

失败会输出错误，Sagitta 不注册，其他 DSH 预设继续运行。此次只验证启动更新；memory 是空插件。初始化、数据迁移和运行中热更新留待后续审查。

当前运行包使用可直接加载的 JavaScript；依赖安装关闭生命周期脚本，带有构建或原生安装脚本的依赖需要另行接入。保留官方标准预设，persona 只替换 Sagitta 这一份副本。
