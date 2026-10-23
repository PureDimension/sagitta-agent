# void island 服务器运行与清理记录

2026 年 10 月 14 日检查并按用户授权精简 `void-island-site`。当前保留网站、两个公网隧道、唯一 webhook 自动部署服务，以及系统基础与安全维护服务。ReachFlow 代理已移除，Codex app-server 已关闭，设备管理、旧证书工具、Snap/LXD 等冗余已卸载。下文先记录当前交付结果，再保留前期调查证据。

## 网站服务精简交付结果

用户授权范围是保留网站所需服务，关闭 ReachFlow 与 Codex，并停用、删除与现有用途无关的后台组件。

已完成：

- ReachFlow tinyproxy stop/disable，删除 unit、专用配置与系统用户，移除 3128 的 IPv4/IPv6 入站规则，卸载 tinyproxy。
- 关闭原 Codex app-server 及其 npm 启动进程。后续检查未发现 Codex 进程；CLI、登录与历史资料保留在磁盘上。
- 删除长期读取初始化日志的服务；设置 mask，阻止它重新启动。
- 移除月度 Cloudflare 80/443 防火墙维护 cron 和脚本。
- 移除全部 Snap 应用与运行框架，包括 LXD、core20、core22、snapd。
- 卸载 multipath、ModemManager、UPower、UDisks2、PackageKit、fwupd、watchdog、旧 Nginx/Certbot、Chrome、open-iscsi、open-vm-tools、LXD agent loader、thermald 与 smartmontools。
- 经依赖预演和保留包检查，清理 121 个孤立依赖；本轮 apt 共移除 153 个软件包。
- 停用 MOTD 新闻和桌面更新提示定时任务，保留 apt 安全更新、日志轮转、磁盘维护与系统包数据库备份。
- 开机默认目标由 graphical.target 调整为 multi-user.target，保留现有运行会话。

apt 连带移除了 `ubuntu-server`、`ubuntu-server-minimal` 元包。这些元包定义软件组合；Ubuntu 实际基础包、内核元包、网络、SSH、UFW、Python 和安全更新已标为保留。`ubuntu-minimal` 与 `ubuntu-standard` 仍保留。软件包完整性与依赖检查均通过。

| 当前指标 | 清理前本轮 | 完成后 |
| --- | ---: | ---: |
| 根盘可用空间 | 约 7.6 GiB | 约 9.0 GiB |
| 根盘使用率 | 66% | 59% |
| available 内存 | 514 MiB | 570 MiB |
| running systemd 服务 | 26 | 17 |
| failed systemd 服务 | 含历史残留 | 0 |

内存属于采样值，受驻留页与缓存变化影响。保留的 17 个 systemd 服务包括网络、DNS、SSH、时间同步、日志、会话和安全维护；业务进程为网站、两个 tunnel 与 webhook，PM2 管理网站和 tunnel。

完成后的验证：本地网页、主域名与 www 域名均 HTTP 200；webhook 未签名 ping 为 403，签名 ping 为 200；Next.js、Express、Socket.io、SQLite 原生模块和 Flask/WSGI 依赖均可重新加载；`dpkg --audit` 与 `apt-get check` 通过。开机所需的 SSH、PM2、webhook、网络和安全更新服务均 enabled。验证未触发 GitHub push 构建或服务器重启。

恢复材料保存在服务器 `/root/maintenance-backups/2026-10-14-website-only/`，目录权限 0700，包括配置归档、原软件版本与手动安装清单、原服务/防火墙/cron 状态、卸载清单、执行日志和 `verification.json`。恢复已卸载的软件需要重新安装对应包，再按归档恢复配置。

## 网页相关组件

| 组件 | 实际作用 | 当前状态 |
| --- | --- | --- |
| void-island Node 进程 | production 模式下运行 Next.js、Express、Socket.io 与 SQLite 功能 | 保留，端口 3000 |
| site-tunnel | 将 void-island.com 与 www 子域连接到网页 | 保留 |
| PM2 | 管理网站与两个 tunnel 进程 | 保留 |
| void-island-webhook.service | 验证 GitHub 签名，push 事件触发部署脚本 | 保留，端口 5000 |
| webhook-tunnel | 将 webhook 子域连接到部署服务 | 保留 |

网站包含交互与数据功能。其后台代码中发现每 24 小时清理过期用户，以及房间为空后延时清理；这次检查的服务端目录未发现持续调用模型或高频定时任务。网页 RSS 初次采样约 102 MiB，后续约 63 MiB，采样差异与进程驻留页变化有关。

## 两份 webhook 的原因与处理

两份配置启动相同的业务处理逻辑：

- `github-webhook.service` 直接执行 `/usr/local/bin/void-island-webhook.py`，调用 Flask 自带启动器。
- `void-island-webhook.service` 执行 `/usr/local/bin/void-island-webhook-systemd.py`，该启动器导入上面的处理脚本，再使用 WSGI 服务承载同一个 Flask app。

两者都监听 5000。旧服务已从 7 月 19 日起处于 failed，仍被设置为 enabled；当前重跑旧启动器复现 `Address already in use / Port 5000 is in use`。新服务正常运行，签名 ping 返回 HTTP 200 / Ignored。

已完成：旧服务 stop/disable，旧 unit 与历史备份移出 systemd 目录，daemon-reload 并清除旧失败状态。现在 unit 列表中只剩 `void-island-webhook.service`，状态为 active/enabled。共享处理脚本和 WSGI 启动器都保留，新服务依赖两者。

配置恢复点在服务器 `/root/maintenance-backups/2026-10-14-webhook-logs/`，目录权限 0700。

验收使用非 push 的签名 ping，验证认证和路由；实际 GitHub push 部署链路沿用原实现。本次没有触发代码构建或网站重启。

## 日志清理结果

| 项目 | 清理前 | 清理后 |
| --- | ---: | ---: |
| /var/log | 约 2.5 GiB | 201 MiB |
| journal | 约 2.2 GiB | 168 MiB |
| 根盘可用空间 | 约 5.3 GiB | 约 7.5 GiB |
| 根盘使用率 | 76% | 66% |

清除了 121 个轮转日志，约 98 MiB；截断 auth.log、syslog、kern.log 与 ufw.log，约 38 MiB。journal 通过系统自身的容量管理清理，保留近期记录。

新增 `/etc/systemd/journald.conf.d/20-log-size-limit.conf`：`SystemMaxUse=200M`、`SystemMaxFileSize=32M`，重启 journald 并确认生效。journal 的文件分配粒度和活动文件会使实际占用略有波动。

清理后，网站原进程和 webhook 原进程继续运行。网站本地与公网请求均为 HTTP 200；webhook 未签名请求 HTTP 403，签名 ping HTTP 200。

## 其余冗余候选

以下是前期调查时的状态与判断。后续用户授权的实际处置见开头交付结果。

| 项目 | 证据 | 判断 |
| --- | --- | --- |
| multipathd | RSS 约 26 MiB；只有单个 vda 虚拟磁盘；multipath -ll 无映射 | 当前磁盘拓扑下可优先停用 |
| ModemManager、upower、udisks2 | 云服务器仍运行调制解调器、电源和桌面磁盘管理组件 | 与网页用途无直接关系，可做依赖核对后停用 |
| PackageKit、fwupd 和更新提示任务 | 仍保留桌面包管理、固件刷新、更新提醒 | 可精简；保留正常系统安全更新 |
| cloud-init-log-reader | 开机后长期运行 less，读取 cloud-init.log 到 TTY | 安装诊断遗留，可停用 |
| LXD / Snap | LXD daemon inactive；容器与虚拟机本地目录为空；snapd 常驻约 17 MiB | 若无容器需求，可整体卸载；snap 文件约 602 MiB |
| Chrome | 安装占用约 434 MiB，检查时无浏览器进程 | 当前属于磁盘占用，后续浏览器用途确定后再处理 |
| certbot.timer | 本机证书已过期，Nginx inactive，当前公网网页经 Tunnel 访问 | 当前入口与本机续期任务脱节，可核对后停用 |
| ReachFlow Unipile 代理 | tinyproxy 常驻，3128 公网允许，配置有认证 | 独立项目功能；网页运行不依赖它 |
| Codex app-server | 从 8 月 14 日起运行，Unix socket 监听，RSS 合计约 6 MiB | 常驻管理端开销小；执行任务时资源需求另计，网页不依赖它 |
| watchdog | 常驻；配置仅启用 realtime 与 priority，未声明具体探活目标 | 需要核实其实际保活价值 |

停用上述设备管理和安装诊断组件可减少几十 MiB 的常驻开销。释放的真实内存需以 available 变化衡量，RSS 含共享页且部分数据已交换，不能直接相加当作精确收益。

## 进一步核实组件用途

用户要求先了解实际作用再决定。以下补充来自第二轮只读检查；随后已按授权进行精简。

| 组件 | 本来负责什么 | 这台服务器现在实际做什么 | 停用影响判断 |
| --- | --- | --- | --- |
| multipathd | 把同一存储设备的多条连接合并，提供存储路径切换 | 扫描单个 VirtIO 磁盘；无 multipath 映射，仍常驻 | 当前存储拓扑下可停用；同时处理其 socket 激活 |
| ModemManager | 管理移动网络调制解调器 | mmcli 查询结果为 No modems were found | 与当前网页和网络接口无依赖，可停用 |
| UPower | 提供电池与电源状态 | 只有合成 DisplayDevice，未列出实际电池 | 云服务器网页用途可停用 |
| UDisks2 | 向桌面程序提供磁盘枚举、挂载与弹出服务 | 枚举 vda 和虚拟 DVD；反向依赖只列 graphical.target | 根盘由系统启动挂载，网页对该桌面接口无依赖 |
| PackageKit | 为桌面软件中心提供系统包安装与更新接口 | 无已列出的历史事务；当前等待请求 | 网页部署使用 npm/git，与该接口分离；停用可保留 apt 安全更新 |
| Snap / LXD | 管理 Snap 应用与容器/虚拟机 | LXD daemon inactive，实例目录为空；Snap 每日四个随机窗口检查 core20/core22/lxd/snapd 更新，并清理下载缓存 | 若继续只托管现有网页，可卸载这套机制；网页、tunnel 与 webhook 均通过其他方式安装运行 |
| cloud-init-log-reader | 把首次初始化日志显示到虚拟控制台 | 一个长期运行的 less 读取 cloud-init.log | 属于安装诊断遗留，可停用 |
| watchdog | 根据硬件狗或检查项检测异常，触发恢复 | 无 /dev/watchdog、无 watchdog 硬件；配置仅 realtime/priority，未声明探活项；进程持有三个 /dev/null 和一个 socket | 现配置缺少明确保护用途，停用价值可评估；与网站自恢复分开处理 |
| Certbot | 自动续签本机 HTTPS 证书 | 证书 5 月已过期；仍使用 nginx authenticator/installer。10 月 14 日上海时间 12:41–12:47 的尝试耗时约 5 分 24 秒，因 ACME challenge 返回 404 失败 | 当前网页入口使用 Tunnel，可停止这套失败续期；保留或移除证书文件可单独决定 |
| fwupd-refresh | 下载固件升级元数据 | 定时运行 fwupdmgr refresh，最近一次退出状态为 2 | 当前 VPS 可精简该任务 |
| Chrome | 提供浏览器运行能力 | 已安装约 434 MiB，检查时无浏览器进程；保留浏览器包维护项 | 主要占磁盘，后续远程浏览器用途确定后再取舍 |
| 月度 Cloudflare 防火墙脚本 | 下载 Cloudflare IP 列表，为 80/443 添入站规则 | root cron 每月调用 update-cloudflare-ufw.sh；现有网站通过出站 Tunnel 工作，80/443 未监听 | 属于旧入口的维护机制，可与旧 Nginx/Certbot 一并整理 |

### ReachFlow 代理的业务位置

在本机找到部署脚本：`/Users/cyan/Documents/客户触达系统/TradeFlow/scripts/unipile_proxy.sh`。其默认目标正是 `void-island-site:3128`，它安装独立 tinyproxy 服务，并要求把 HTTP 代理参数填入 Unipile。

结合脚本与 Unipile 官方代理机制，预期链路为：

```text
ReachFlow 调用 Unipile API
    → Unipile 按账号代理配置访问外部平台
    → 这台 VPS 的 tinyproxy
    → LinkedIn 等平台
```

用途是提供可指定的 VPS 网络出口；业务调度和账号状态由 ReachFlow/Unipile 管理。实际 Unipile 账号是否仍绑定此 VPS，需要查看该账号当前配置。[Unipile 代理机制](https://developer.unipile.com/v2.0/docs/proxys)

服务器配置：监听 `0.0.0.0:3128`，BasicAuth 已配置，最多 32 个客户端，空闲连接超时 600 秒，HTTPS CONNECT 目标端口允许 80/443。无目标域名白名单，认证客户端可以选择转发目标。HTTPS 通过 CONNECT 承载。[Tinyproxy 配置说明](https://tinyproxy.github.io/)

检查期间连接数为 0。读取其进程内统计时，唯一 open connection 是本次统计请求；累计 requests 为 6,618、bad connections 为 1,394、denied connections 为 5,519、因负载拒绝为 0。计数语义不同且可能重叠，不能相减得到业务成功次数。LogLevel Critical 仅记录严重错误，正常目标和请求历史无法从日志复原。

资源开销很小：进程 RSS 约 1 MiB，服务 cgroup 内存约 0.6 MiB；本次读取的累计 CPU 时间约 6.8 秒。公网防火墙允许 3128，作用是供配置该代理的远端调用方连接。

停用该服务与网页及 webhook 链路分离。如果某个 Unipile 账号仍使用该 custom proxy，代理失效会让其进入 Service Interruption 并重试；从账号配置移除自定义代理后，支持自动代理的平台会重新使用 Unipile 的自动代理。建议核对或切换账号配置后，再停服务、关闭 3128 的入站规则，并保留恢复所需配置。[Unipile 的错误与切换语义](https://developer.unipile.com/v2.0/docs/proxys)

SSH、网络配置、DNS、时间同步、系统日志与安全更新属于合理系统基础功能。此轮检查没有发现 CPU 持续满载；短采样出现过 I/O wait，后续磁盘统计空闲，存在间歇等待而非持续写入。

## 频繁远程访问

检查时前一小时有约 443 次同一来源的 root 公钥成功登录，以及 72 条失败密码或无效用户记录。当前同时存在的登录会话只有 3 个，表现为频繁短连接。

本机同时存在由 Codex/ChatGPT 程序启动的 SSH 进程；这与远程工具轮询相符，但尚未逐次对应服务器登录来源。成功登录数量说明日志增长不能全部归因于公网扫描。若进一步减少后台行为，应在客户端核对远程状态轮询频率，同时保留必要的远程管理。

## Codex 远程工作的后续方向

可以让网站保存持久任务与展示状态，VPS 承担队列和协调，常开电脑承担 Codex 执行，通过 Tailscale 所连接的网络通信。执行设备领取任务、登记心跳、写回结果；网页关闭后任务仍由服务端保存，执行设备离线时显示等待。

这个方向将模型执行、构建与测试的资源需求放到更合适的机器。起步可以只接一个执行设备、一次一个任务，先验证断线恢复和结果回传，再考虑多设备。用户已将其列为后置支线，本次仅保留设计方向。
