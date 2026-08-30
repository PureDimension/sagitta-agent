# @sagitta/async-work

进程范围的通用有界工作注册表。工作必须绑定 `ownerId` 和 `taskId`，只在
`running` 且未超时期间阻塞对应任务；DSH dispose 时取消并清空全部内存记录，
不从重启前的进程恢复工作。

codex-dispatch 等执行插件只通过 `sagitta-async-work` 服务登记和完成工作，
不得自行维护第二份 active registry。
