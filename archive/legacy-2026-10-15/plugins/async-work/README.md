# @sagitta/async-work

进程范围的通用有界工作注册表。工作必须绑定 `ownerId` 和 `taskId`，只在
`running` 且未超时期间阻塞对应任务；每个 owner 固定保留 20 条、6 小时 TTL
的最近终态 ring，可通过 `listRecent(ownerId)` 读取 completed/failed/cancelled/expired
记录。DSH dispose 时先把运行中的工作记为 `cancelled/plugin-dispose` 再清空 active
记录；recent ring 仍按固定数量和 TTL 保留，且不从重启前的进程恢复。

工具通过 `async_register` 登记、`async_status` 查询、`async_settle`（`complete` /
`fail` / `cancel`）结算工作。codex-dispatch 等执行插件只通过
`sagitta-async-work` 服务登记和完成工作，
不得自行维护第二份 active registry。
