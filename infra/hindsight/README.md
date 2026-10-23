# Hindsight 本地查看环境

使用官方 Hindsight 1.0.0 一体镜像，包含 API、Control Plane、后台 worker、嵌入式 PostgreSQL，以及镜像提供的本地 embedding/reranker。

通过南京大学 GHCR 缓存下载，使用与官方核对一致的镜像清单摘要固定内容：`sha256:a88678c038b0e4340822b02a5efc566c56d8176b5bffa731bc433fd37f978e4c`。镜像站说明：<https://doc.nju.edu.cn/books/e1654/page/ghcr>。

- Control Plane：<http://127.0.0.1:9999>
- API：<http://127.0.0.1:8888>
- API 文档：<http://127.0.0.1:8888/docs>
- 数据：Compose 命名卷 `sagitta-hindsight-local_hindsight-data`。
- 服务端口只绑定本机回环地址。

## 启动与停止

在此目录执行：

```sh
cp settings.example.env .env.local
docker compose up -d
docker compose ps
docker compose logs --tail 100
docker compose stop
```

已有 `.env.local` 时保留其内容。`docker compose stop` 保留容器与数据；`docker compose down` 移除容器但保留数据卷。

## 接入 LLM

`.env.local` 由 Git 忽略。填写密钥，并将 `HINDSIGHT_API_LLM_PROVIDER` 从 `none` 改为 `deepseek` 后执行：

```sh
docker compose up -d --force-recreate
```

`none` 模式用于无密钥时先浏览界面及检查存储/检索接口：仅保存文本块，LLM 提取、observation 整理、reflect 和页面生成尚不可用。接入模型后，之前在此模式写入的测试文档需要重新处理，才能按新配置提取事实。

模型、密钥、并发、提取和整理规则属于人工维护的配置；Agent 运行时管理哪些项目 Bank、记录、检索和知识页面，待用户查看界面后再确定。

本环境尚未接入 DSH 或 Sagitta 插件。

## 中文界面说明

术语、全部页面、折叠选项和当前版本全部逐库配置的逐项解释，见[文字手册](../../docs/hindsight-guide/guide.txt)或[带搜索和目录的 HTML 手册](../../docs/hindsight-guide/index.html)。

## 当前验证（2026-10-16）

- LLM：DeepSeek `deepseek-flash`，已验证 JSON 输出；本地私有配置从仓库根目录 `.env` 的 `DEEPSEEK_API` 读取并生成。
- 服务：API readiness 与 Control Plane HTTP 均返回 200。
- 演示 Bank：`sagitta-local-demo`，界面名称明确标注“虚构数据，可删除”。
- 演示结果：2 份文档提取 4 条事实，自动生成 4 条 observation；召回、reflect 和 1 个知识页面生成成功，后台任务均完成。
- 直接查看配置：<http://127.0.0.1:9999/banks/sagitta-local-demo?view=profile&bankConfigTab=configuration>。

当前沿用镜像内的 `BAAI/bge-small-en-v1.5` embedding 和 `cross-encoder/ms-marco-MiniLM-L-6-v2` reranker。这两个模型偏英文，本次验证的是处理链路；正式评估中文记忆质量时应另选多语言模型。

## 配置的管理分工

人工维护服务模型、提取规则、observation 整理规则、Reflect 提示、资源预算和访问权限。大部分可先保留默认值，再依据实际记录调整。

Agent 在既定规则内维护普通项目 Bank、记忆、知识页面的主题与来源范围，并主动查询或申请刷新。常态/项目/情景召回绑定属于未来的 `sagitta-memory` 配置，Hindsight Control Plane 中尚无这层插件配置。
