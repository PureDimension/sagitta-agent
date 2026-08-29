# @sagitta/auto-advance

Sagitta 的 Cordis 自主推进插件，包含：

- 后端 per-agent idle 计时器、pending-work 判断、持久化模式、定稿提示词注入和停止协议；
- `sagittaAutoAdvance` typed RPC；
- 右下角可拖拽悬浮球和只读 `TASKS.md` 面板（v0.1.7 交互）。面板顶部显示 §2 汇报箱中的“待处理需求”，其后显示项目进度。默认显示圆圈；点击圆圈后圆圈消失并展开面板，点击面板右上角“收起”后面板消失并恢复圆圈。圆圈与面板共用一个屏幕锚点，面板会贴着悬浮球并在拖动和窗口 resize 时限制在视口内；面板高度随内容自适应，任务较多时仅任务列表在面板内部滚动且保留滚动位置。收起/展开只影响界面显示，模式状态会保持。

停止协议：assistant 消息包含 `【停止自主推进】` 即触发停止。

## 间隔配置

最终默认值是 `idleTimeoutMs: 300000`（300 秒）。本地短间隔测试时，在 profile 的
`cordis.patch.yml` 临时覆盖为例如 `idleTimeoutMs: 10000`；测试完恢复为 `300000`。

模式状态写入 `statePath`，任务文件由后端读取 `tasksPath`；两者显式配置优先。未配置时，
后端依次使用 `SAGITTA_WORKSPACE`、包含 `TASKS.md` 的兼容工作区候选，最后才使用当前工作
目录。浏览器只通过 RPC 读取，不能修改文件。部署包会在 profile patch 中写入目标机
workspace 的绝对路径。
