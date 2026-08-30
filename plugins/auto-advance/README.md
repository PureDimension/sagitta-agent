# @sagitta/auto-advance v0.1.8

Sagitta 的 Cordis 自主推进插件，包含：

- 后端 per-agent idle 计时器、严格云端任务快照、按 task_id 隔离的有界工作判断、持久化模式、v2 round-close/confirm 协议提示和停止协议；
- `sagittaAutoAdvance` typed RPC；
- 右下角可拖拽悬浮球和只读 `TASKS.md` 面板（v0.1.8 交互）。面板顶部显示 §2 汇报箱中的“待处理需求”，其后显示项目进度。默认显示圆圈；点击圆圈后圆圈消失并展开面板，点击面板右上角“收起”后面板消失并恢复圆圈。圆圈与面板共用一个屏幕锚点，面板会贴着悬浮球并在拖动和窗口 resize 时限制在视口内；面板高度随内容自适应，任务较多时仅任务列表在面板内部滚动且保留滚动位置。收起/展开只影响界面显示，模式状态会保持。
- 自主推进资格只使用完整云端 `/task` 快照；云端不可用时不注入、不熄火，面板可显示带 `source=file-stale` 标记的旧文件快照。
- runnable 清单是本轮唯一任务选择范围；新想法必须先 `task_create`，等待下一次完整快照后才能推进。每个已选择任务的 autonomous round 必须用一次 `task_round_close` 收尾，`done/blocked` 仅产生 pending 申请；终态必须由确认质询中的 `task_confirm(accept|reopen)` 完成。
- 兼容文本收尾仅接受单个完整 JSON 对象或 fenced JSON，字段必须满足 `task_id/action/progress/next/round_id`；多 JSON、夹带自然语言、缺字段和未知 action 都不会写任务状态。只输出停止标记但没有 close 会记录“未收尾停止”，保留 `in_progress`。
- 文本兜底写回使用 Manager 的 D1 写凭据或成对 Access 凭据，并沿用 `DSH_MEMORY_PROXY`；缺凭据、网络失败或 Worker 拒绝时只进入 degraded/defer，不改变任务状态。工具调用仍由 memory task 工具/Worker 负责写入。

停止协议：assistant 消息包含 `【停止自主推进】` 仅在最新完整云端快照显示所有任务均为 `done/blocked` 且没有 pending 时触发；否则保持自主推进并提示仍有未完成任务。云端读取失败不触发停止。

## 间隔配置

最终默认值是 `idleTimeoutMs: 300000`（300 秒）。本地短间隔测试时，在 profile 的
`cordis.patch.yml` 临时覆盖为例如 `idleTimeoutMs: 10000`；测试完恢复为 `300000`。

模式状态写入 `statePath`，任务文件由后端读取 `tasksPath`；两者显式配置优先。未配置时，
后端依次使用 `SAGITTA_WORKSPACE`、包含 `TASKS.md` 的兼容工作区候选，最后才使用当前工作
目录。浏览器只通过 RPC 读取，不能修改文件。部署包会在 profile patch 中写入目标机
workspace 的绝对路径。
