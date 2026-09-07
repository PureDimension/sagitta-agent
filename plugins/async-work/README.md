# @sagitta/async-work

进程范围的通用有界工作注册表。工作必须绑定 `ownerId` 和 `taskId`，只在
`running` 且未超时期间阻塞对应任务；每个 owner 另有默认 20 条、6 小时 TTL
的最近终态 ring，可通过 `listRecent(ownerId)` 读取 completed/failed/cancelled/expired
记录。DSH dispose 时先把运行中的工作记为 `cancelled/plugin-dispose` 再清空 active
记录；recent ring 仍按自身的数量和 TTL 界限保留，且不从重启前的进程恢复。

codex-dispatch 等执行插件只通过 `sagitta-async-work` 服务登记和完成工作，
不得自行维护第二份 active registry。
