# 三机实测清单 — 5.17.52 正式包（2026-11-04）

包：正式 release <https://github.com/wenzo001/gosslan/releases/tag/v5.17.52>
（已 publish、已建 tag，`latest.json` 已指向 5.17.52；所有已装用户会收到应用内更新）

**版本 ↔ 包对照**：`5.17.22`、`5.17.36` 旧包已撤（draft 已删）；`5.17.52` 为当前唯一正式包。
用户此前在 Win11 装的是 `5.17.36`（`ProductVersion=5.17.36`，RSS 65 MB、CPU 2.94s），
升级到 5.17.52 后按本清单复测。

**用户当前进度**（2026-11-04）：Win11 原地升级五步已完成；以下项**尚未测**：
Android BLE 外设（第 1 节）、公网中继（第 3 节）、桥接三机（第 4 节）、BLE 多跳（第 5 节）。
用户要求先由我方完成剩余自测并发一版正式 release；`5.17.52` 已正式发布，他随后按本清单慢测。

- Windows x64：`Gosslan_5.17.52_x64-setup.exe`，6,050,068 B，
  sha256 `4f69030208faf5283b9a42d37e37ffcb153d1dc56f09e9edc20c350ef7733f80`
- Windows arm64：`Gosslan_5.17.52_arm64-setup.exe`，5,604,314 B，
  sha256 `b70e907384575f5d8282b6aa8f9d27fa377650020fa23f1e72c2dd355a87de63`
- macOS arm64：`Gosslan_5.17.52_aarch64.dmg`，9,197,486 B，
  sha256 `89f8221ba6860967bbbae4c49d8eafa4acfd5ca126d090ceeb7bca772ce03b40`
- macOS x64：`Gosslan_5.17.52_x64.dmg`，9,779,057 B，
  sha256 `12e12b8c449ba08d2112082f9e4638181b58567e480f746de157990710af0503`
- Android arm64-v8a：`gosslan-5.17.52-arm64-v8a-release.apk`，17,706,058 B，
  sha256 `429c499ec28eac6e3b596774c7edb9df1da656d3e0b9b9789e7a778c495af7c5`
- Android armeabi-v7a：`gosslan-5.17.52-armeabi-v7a-release.apk`，13,366,684 B，
  sha256 `056829a2ba0a171e1eb330130b8d569449bb29e1f1975e66ebf60caeff191fcf`

（另有 Windows 内置 WebView2 档 `Gosslan_5.17.52_x64-setup-webview2-bundled.exe` /
`Gosslan_5.17.52_arm64-setup-webview2-bundled.exe`，给装不上 WebView2 运行时的机器。）

版本核对：Windows 由产物文件名 `5.17.52` + `tauri.conf.json` 的 `version`（三处均为 5.17.52）；
macOS 挂载 dmg 后读 `CFBundleShortVersionString`。以上字节数与 sha256 来自
`gh release view v5.17.52 --json assets` 的现读值。

> 本包相对 5.17.36 的用户可感知变更：Android「我的 → 链接」改走系统浏览器（不再报「操作失败」）；
> 蓝牙镜像退让只在存在健康链路时生效、退让名单 120s 过期；拨号全局预算（在途 ≤4、间隔 ≥500ms、
> RSSI < -90 跳过）。BLE 两项只过了决策层单测，两设备真机效果仍按本清单复测。

> 总时长：必做 ≈ 13 分钟；可选（BLE 多跳）≈ 4 分钟。每条"不对就发我"统一指：
> 截图（标出位置）+ 两端日志最后 30 行里带 `code=` 的行。Windows 日志在
> `%APPDATA%\com.gosslan.app\logs\gosslan.log`；Android 用 `adb logcat -s gosslan-logcat`。

## 0. Win11 原地升级五步（必做，2 分钟）

前置：机器上已装一个旧版（v5.16.74 或更早）并至少启动过一次；托盘退出应用。

1. 设置 → 关于，记下旧版本号。
2. 托盘右键 → 退出（任务管理器里确认无 `gosslan.exe`）。
3. 双击 `Gosslan_5.17.52_x64-setup.exe` → 下一步 → 安装（同目录原地升级，不应要求先卸载）。
4. 打开应用 → 设置 → 关于，应显示 `5.17.52`。
5. 打开一个旧会话 + 好友列表，历史消息与好友都还在。

PowerShell 三行（整段粘贴即可）：

```powershell
@("$env:LOCALAPPDATA\Gosslan\gosslan.exe","$env:LOCALAPPDATA\Programs\Gosslan\gosslan.exe") | % { if (Test-Path $_) { (Get-Item $_).VersionInfo.ProductVersion } }
Get-Process gosslan -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet
Get-Content "$env:APPDATA\com.gosslan.app\logs\gosslan.log" -Tail 20
```

看什么：第 1 行输出 `5.17.52`；第 2 行只有 1 个进程；第 3 行末尾没有 `code=E_`。
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

## 6. 跨网段凭设备 ID 找人（必做，2 分钟）

前置：A、B 在不同网段、**还不是好友**；两端都已按第 3 节或第 4 节配好
（同一公网中继并已建立电路，或填了同一个桥接机的「跨网段连接」地址）；两端都是 5.17.52。

点击：B → 设置 → 关于 → 复制设备 ID 发给 A；A → 添加好友 → 粘贴到搜索框 → 等 2~3 秒。

看什么：列表里出现 B 那一行（链路可能显示「经 N 跳」）；点加好友 → B 同意 → A 发一条能到。
不对就发我：A 搜索框（含粘贴的 ID）+ 列表截图 + 两端日志 `code=` 行。

---

## 已知缺口（测试时不必当 bug 重报）

1. 没有目录服务：只能发现「已配置 routed 端点 / 已建中继电路」可达范围内的设备；
   完全陌生、双方无任何连接路径的设备，凭设备 ID 仍搜不到（这是隐私上的取舍，不是 bug）。
2. 已修（5.17.22）：复制邀请按钮常驻、文案改为「发给对方，对方添加后即可跨网段互见」；
   「可能离线」改为整行灰显（只降透明度，仍可点击）。
