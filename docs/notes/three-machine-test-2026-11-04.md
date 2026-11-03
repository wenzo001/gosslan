# 三机实测清单 — 5.17.5 可测包（2026-11-04）

包：草稿 release <https://github.com/wenzo001/gosslan/releases/tag/untagged-04c587aff7e9d1bf27c8>
（需登录 GitHub；未 publish、未建 tag、未改 `latest.json`）

- Windows x64：`Gosslan_5.17.5_x64-setup.exe`，6,016,912 B，
  sha256 `5dd5c29dfa52facb3367ea50c330e245de93e34c6563ecdb2c5785b6a2c509a0`
- macOS arm64：`Gosslan_5.17.5_aarch64.dmg`，9,160,919 B，
  sha256 `966a9356dea7e17ea2d1ea3179027dc96283ca8cae92297ac0a2b02f633f6e63`
- macOS x64：`Gosslan_5.17.5_x64.dmg`，9,740,376 B，
  sha256 `dfc26a3c784ee82491dbea9eb5ed36e0170485fcbde67c9f4236e8df64d5070e`

版本核对：Windows 由产物文件名 `5.17.5` + `tauri.conf.json` 的 `version`；macOS 挂载 dmg 后
`CFBundleShortVersionString` 实读 `5.17.5`。

> 总时长：必做 ≈ 11 分钟；可选（BLE 多跳）≈ 4 分钟。每条"不对就发我"统一指：
> 截图（标出位置）+ 两端日志最后 30 行里带 `code=` 的行。Windows 日志在
> `%APPDATA%\com.gosslan.app\logs\gosslan.log`；Android 用 `adb logcat -s gosslan-logcat`。

## 0. Win11 原地升级五步（必做，2 分钟）

前置：机器上已装一个旧版（v5.16.74 或更早）并至少启动过一次；托盘退出应用。

1. 设置 → 关于，记下旧版本号。
2. 托盘右键 → 退出（任务管理器里确认无 `gosslan.exe`）。
3. 双击 `Gosslan_5.17.5_x64-setup.exe` → 下一步 → 安装（同目录原地升级，不应要求先卸载）。
4. 打开应用 → 设置 → 关于，应显示 `5.17.5`。
5. 打开一个旧会话 + 好友列表，历史消息与好友都还在。

PowerShell 三行（整段粘贴即可）：

```powershell
@("$env:LOCALAPPDATA\Gosslan\gosslan.exe","$env:LOCALAPPDATA\Programs\Gosslan\gosslan.exe") | % { if (Test-Path $_) { (Get-Item $_).VersionInfo.ProductVersion } }
Get-Process gosslan -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet
Get-Content "$env:APPDATA\com.gosslan.app\logs\gosslan.log" -Tail 20
```

看什么：第 1 行输出 `5.17.5`；第 2 行只有 1 个进程；第 3 行末尾没有 `code=E_`。
不对就发我：三行完整输出 + 关于页截图。

## 1. Android BLE 外设（必做，2 分钟）

前置：Android 装同版本 APK；Win/Mac 与手机蓝牙都打开；两端都进
设置 → 网络与连接 → 打开「蓝牙通道」（Android 默认开）。加好友页能看到「蓝牙通道 · 已开启」。

点击：Android → 添加好友 → 找到对方那行（应显示蓝牙/无 IP）→ 加好友 → 对方同意 → 发一条文字。

看什么：加好友行链路是「蓝牙直连」；聊天页头部也是「蓝牙直连」；消息 3 秒内到达；
对方列表里 Android 那行同样「蓝牙直连」。
不对就发我：两端加好友列表截图 + 聊天页头部截图 + 两端日志 `code=` 行。

## 2. Windows BLE 外设（必做，2 分钟）

前置：Windows A 打开「蓝牙通道」；B（Android 或 Mac）在蓝牙范围内；A 能扫到 B。

点击：A → 添加好友 → B 那行加好友 → B 同意 → A 发一条 → B 回一条。

看什么：A 侧该行「蓝牙直连」；双向消息 3 秒内到达；A 聊天页头部「蓝牙直连」。
不对就发我：A 的添加好友行截图 + 两端日志 `code=` 行。

## 3. 公网中继（两端均可，3 分钟）

前置：服务器已按部署说明起好中继（默认端口 59993）；A、B 在
设置 → 网络与连接 → 公网中转（自备服务器）填同一「服务器地址」+「访问口令」→ 保存。

点击：A 点「测一下」→ B 点「测一下」→ A 发消息给 B；然后反过来由 B 发一条给 A。

看什么：两端「测一下」都提示已连上（口令错会显示「服务器拒绝准入」）；两次消息都到达；
聊天页头部显示「经 1 跳中继」，不是 IP。
不对就发我：两端「测一下」结果截图 + 聊天头部截图 + 两端日志里含 `relay` 或 `code=` 的行。

## 4. 桥接三机（A/B 跨网段 + C 局域网，必做，2 分钟）

前置：A、B 在不同网段；C 同时能连 A、B。A 与 B 在
设置 → 网络与连接 → 跨网段连接，各自填 C 的地址；三台互为好友；三台中继范围保持默认「所有设备」。

点击：A 发消息给 B（A、B 无直连，必须经 C）；B 再回一条。

看什么：C 不弹这两条消息；A/B 聊天页头部「经 1 跳中继」；两条消息均到达。
不对就发我：三端聊天头部截图 + 三端日志 `hop`/`relay`/`code=` 行。

## 5. BLE 多跳三点（可选，4 分钟）

前置：A—B—C 依次蓝牙可达，A 与 C 超出彼此蓝牙范围；三台都开「蓝牙通道」；A、C 已是好友
（B 不需要是好友），B 的中继范围不要设「不中继」。

点击：A 发一条给 C。

看什么：A、C 聊天页头部「经 2 跳中继」（1 跳则记录实际数字）；消息到达；B 侧不显示该消息。
不对就发我：A/C 聊天头部截图 + 三端日志 `hop`/`relay`/`code=` 行。

---

## 已知缺口（测试时不必当 bug 重报）

1. 「复制邀请」文案说"搜索这个设备 ID，就能加我"，但添加好友的搜索框只过滤**本机已发现**的节点；
   未发现的跨网段设备无法凭设备 ID 搜到（`friend.add.crossNet.hint` 也写明：公网首次加好友需共同好友）。
2. 「可能离线」只把昵称变灰（`opacity-60`），整行不变灰。
