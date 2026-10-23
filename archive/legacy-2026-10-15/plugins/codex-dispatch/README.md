# @sagitta/codex-dispatch

本插件通过一个常驻的 `codex app-server` WebSocket 连接派发 Codex 会话，工作生命周期由 `sagitta-async-work` 负责。

工具：

- `codex_dispatch(task_id, task, model?, cwd?)`：建立 thread 并启动第一轮。
- `codex_status(work_id?)`：查询 async-work 与会话状态。
- `codex_append(work_id, message)`：向指定 codex 会话追加一条指示；会话正在运行时并入当前轮次（下一步即被读取），会话已结束时开新一轮。

首次派单时插件惰性启动 `codex app-server`，优先探测 `127.0.0.1:18787/healthz`；端口被占用时在 `18787–18800` 中选择空闲端口。Windows 启动命令为 Node 执行全局 Codex 的 `bin/codex.js app-server --listen ws://127.0.0.1:<port>`。默认模型从 `sagitta-manager.apiConfig().codexModel` 读取，沙箱和推理档位默认分别为 `danger-full-access` 与 `xhigh`。

`codex_append` 统一使用 `turn/start`。app-server 会根据会话状态自动处理：有活跃轮次时把输入并入当前轮次，没有活跃轮次时排队开启下一轮。
