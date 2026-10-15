# Windows / X-Lite 局域网连通性：最小权限方案与现场分型

生成：2026-10-15 全链路稳定性审计（问题 B 这一族）。
适用：Gosslan 桌面版 Windows 构建（含精简系统镜像，例如各种 "X-Lite"）。

这份文档只做两件事：① 用**系统检测结果**证明某项能力在不在，而不是凭"系统被精简过"下结论；
② 给一条**不关闭防火墙、不卸载安全软件、不改系统安全策略**的可验证放行方案。

---

## 一、先分型：五种"连不上"在现场是五条不同的路

指令 §四.1 要求把「发现失败 / TCP 建连失败 / 协议握手失败 / 身份校验失败 / 消息发送失败 / 接收确认失败」
分开。下面每一格都给了**应用日志里现存的检索键**（键名直接取自 `log_throttled("…")` 的第一个参数，
复算：`grep -rho 'log_throttled("[a-z_]*"' src-tauri/src/network | sort -u`）。

| 阶段 | 现场看到 | 判据（日志键 / 检索文本） | 本机能证到哪 |
| --- | --- | --- | --- |
| 发现失败 | 对端根本不出现在节点列表 | 本机侧：列表由 UDP 59991 收包驱动 ⇒ 先跑 §二 的端口监听检测 | 已知：组播出口 / limited broadcast / 虚拟网卡评分这些形状在 4.2x 已修，但**没有 Windows 读数** |
| TCP 建连失败（我拨不出去） | 列表里有，点连接无果 | `lan_dial_fail` | 有（4.39.x 补的留痕） |
| TCP 建连失败（对方进不来） | 对端能拨到我这里、我不应答 | `accept_failed`（带 `kind` 与 `raw_os_error`）、`inbound_full`（带被拒地址与剩余许可数） | 有（本轮 4.40.7 补）。Windows 上句柄耗尽的原始码**预期** 10024（WSAEMFILE），但必须由这条日志在现场证实，不许由"精简系统"推定 |
| 协议握手失败 | TCP 连上了、链路登记不上 | `unknown_frame`、`relay_deny`、`relay_drop` | 部分：`negotiate_times_out_when_peer_never_speaks` 钉的是超时那一支 |
| 消息发送失败 | 气泡停在 pending | `writer_dead`、`inbound_head_of_line` | 有 |
| 接收确认失败 | 发送端长期 `sending` | 群侧 `GroupFileCompleteAck` 与 `group_file` 类目 | 单聊 / 群聊两家的终态写在 4.40.8 已收进同一事务 |

> 拿日志时**不要只截一段**：现场排障要看从应用启动开始的完整文件（`记录 → 日志`里那条路径），
> 因为节流键每 10 秒最多一条，节选极易把"有留痕"读成"没留痕"。日志按 512 KB 轮转
> （`src-tauri/src/logging.rs`），所以"最近一次"往往不在当前文件而在 `-1` 那份里。

---

## 二、检测：先证明能力在不在（全部只读，不需要管理员）

在**出问题那台** Windows 上用 PowerShell（普通权限）逐条跑，把输出整段存下来。

```powershell
# 1) 防火墙服务本身在不在（精简系统可能把 mpsvc 裁掉 —— 这一条是"在/不在"的检测，不是结论）
Get-Service -Name mpsvc | Select-Object Name,Status,StartType

# 2) 当前网卡配置文件（Public 与 Private 的默认入站策略不同）
Get-NetConnectionProfile | Select-Object Name,InterfaceAlias,NetworkCategory

# 3) 本机是否在听业务端口（TCP 59992）与发现端口（UDP 59991）
Get-NetTCPConnection -LocalPort 59992 -State Listen -ErrorAction SilentlyContinue
Get-NetUDPEndpoint   -LocalPort 59991 -ErrorAction SilentlyContinue

# 4) 防火墙是否已有 Gosslan 的放行规则（含"规则存在但被禁用"这种形状）
Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -like '*gosslan*' } |
  Get-NetFirewallRule | Select-Object DisplayName,Enabled,Direction,Action,Profile

# 5) 路由与地址（多网卡 / VPN / 虚拟网卡会让"选哪个源地址"变成变量）
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress,PrefixOrigin,SkipDestination
Find-NetRoute -RemoteIPAddress 192.168.1.1   # 换成对端实际 IP

# 6) 到对端业务端口的 TCP 可达性（不依赖 ICMP —— 很多精简系统禁 ping，禁 ping ≠ 断网）
Test-NetConnection -ComputerName <对端 IP> -Port 59992 |
  Select-Object RemoteAddress,TcpTestSucceeded,PingSucceeded
```

判读规则（重要）：

- 第 1 条**报错**（找不到服务）才叫"防火墙组件缺失"；第 1 条返回 `Stopped` 只说明服务没起，两种形状的处理不同。
- 第 3 条空 ⇒ 应用没在听（应用侧问题，先查 `accept_failed`），不是"系统不让听"。
- 第 6 条 `TcpTestSucceeded=False` 而第 3 条对端在听 ⇒ 中间被拦（防火墙/安全软件/AP 隔离），
  这时才需要 §三 的放行；`PingSucceeded=False` 单独出现**不作证据**。
- X-Lite 缺组件的说法，必须由第 1/2/4 条里某一条的具体报错文本来支撑，写进工单时要带原文。

---

## 三、最小权限放行（管理员 PowerShell；不关防火墙）

原则：**只放行 Gosslan 这一个程序**、**只放行局域网地址段**、**不改 Profile 的默认阻断策略**。

```powershell
$exe = "C:\Program Files\Gosslan\Gosslan.exe"   # productName = "Gosslan"（tauri.conf.json）；装到别处就换成实际路径

# 入站：业务 TCP（对端拨进来收文件/收消息）
New-NetFirewallRule -DisplayName "gosslan LAN tcp 59992" `
  -Direction Inbound -Action Allow -Enabled True `
  -Program $exe -Protocol TCP -LocalPort 59992 -RemoteAddress LocalSubnet `
  -Profile Any

# 入站：发现 UDP（单播回包）
New-NetFirewallRule -DisplayName "gosslan LAN udp 59991" `
  -Direction Inbound -Action Allow -Enabled True `
  -Program $exe -Protocol UDP -LocalPort 59991 -RemoteAddress LocalSubnet `
  -Profile Any

# 入站：组播发现（239.255.42.99:59991）—— LocalSubnet 不覆盖组播，需要显式放这一条
New-NetFirewallRule -DisplayName "gosslan LAN multicast discover" `
  -Direction Inbound -Action Allow -Enabled True `
  -Program $exe -Protocol UDP -LocalPort 59991 -RemoteAddress 239.255.42.99 `
  -Profile Any
```

为什么这就是"最小"：

- `-Program` 限定到单个可执行文件 ⇒ 不是"开放端口给所有程序"；
- `-RemoteAddress LocalSubnet` ⇒ 只对本机所在子网放行，不对公网放行；
- 三条都是 `Action Allow` 的**附加规则**，Profile 的默认入站策略一个字没改；
- 出站方向不需要动（默认允许出站；若现场确实配了阻断出站，那要用 §二.6 的读数证明，再按同样形状加
  `-Direction Outbound` 的两条，不要改成"允许全部出站"）。

复算端口与组播地址（这两个数会随版本变，别信文档）：

```bash
grep -nE 'const (UDP_PORT|TCP_PORT)' src-tauri/src/protocol.rs   # 当前读数：59991 / 59992
grep -n '239\.255\.42\.99' src-tauri/src/network/discovery.rs | head -2
```

验证规则生效（还是只读）：

```powershell
Get-NetFirewallRule -DisplayGroup '*' -Name '*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'gosslan*' } |
  Select-Object DisplayName,Enabled,Direction,Action
```

回滚（删掉这三条，不留注册表残渣）：

```powershell
Get-NetFirewallRule | Where-Object { $_.DisplayName -like 'gosslan LAN *' } | Remove-NetFirewallRule
```

---

## 四、这份文档**没有**主张的事

- 不主张"问题 B 由 X-Lite 缺组件造成"。目前本机侧唯一被量到的、必须重启才恢复的形状是：句柄/描述符耗尽时
  `accept()` 失败会**吃掉队列里一条已建好的连接**（macOS 实测 errno 24 → 之后 EAGAIN），而这一格此前
  在日志里没有任何留痕 —— 4.40.7 补的 `accept_failed` 就是为了在现场把它和"防火墙拦"分开。
- 不主张放行之后连接问题即已修复。**Windows 侧的六条判据至今没有一条来自真机读数**：§4.4 那张
  「正常 Win ↔ X-Lite Win ↔ macOS ↔ Android」矩阵必须由使用者跑，缺任何一格就写"未跑"。
- 不主张 ICMP 可用；不主张"重启路由器/关闭安全软件"这类不可验证的操作。
