# 三机实测清单 — 5.18.34 正式包（2026-11-06）

包：正式 release <https://github.com/wenzo001/gosslan/releases/tag/v5.18.34>
（已 publish、已建 tag，`latest.json` 已指向 5.18.34；所有已装用户会收到应用内更新）

**版本 ↔ 包对照**：`5.17.22`、`5.17.36` 旧包已撤（draft 已删）；`5.18.30` 为上一版正式包，
`5.18.34` 为当前正式包（5.18.31 / 5.18.32 / 5.18.33 未单独发 Release，随本包一起到位）。
用户此前在 Win11 装的是 `5.17.36`（`ProductVersion=5.17.36`，RSS 65 MB、CPU 2.94s），
已在 5.17.52 完成原地升级五步；本轮按 5.18.34 复测。

**用户当前进度**（2026-11-06）：Win11 原地升级五步在 5.17.52 上已完成；以下项**尚未测**：
Android BLE 外设（第 1 节）、公网中继（第 3 节）、桥接三机（第 4 节）、BLE 多跳（第 5 节）。
`5.18.34` 已正式发布，按本清单逐项慢测。

- Windows x64：`Gosslan_5.18.34_x64-setup.exe`，6,099,463 B，
  sha256 `61fa94ddfdf0504f87ffd0241f52c529cbfa9b54d0d7618dadfe876d39fcd449`
- Windows arm64：`Gosslan_5.18.34_arm64-setup.exe`，5,651,491 B，
  sha256 `c35146935802fc1211c3b3a2b24a5c5f51eedb27b20529230c1484b3964ac2cc`
- macOS arm64：`Gosslan_5.18.34_aarch64.dmg`，9,304,304 B，
  sha256 `527a82115eb67d881d6c56567155e230e4820156405d6625d916f928e4e34126`
- macOS x64：`Gosslan_5.18.34_x64.dmg`，9,862,038 B，
  sha256 `79705e0cbb3a7efceacaf6559a013435012085e7caf7b1dbe43facab6359ca88`
- Android arm64-v8a：`gosslan-5.18.34-arm64-v8a-release.apk`，17,984,570 B，
  sha256 `8b61ea67e3899064c2e8692320ae01065f6b96f141ad3d938ebede2a5eb364d3`
- Android armeabi-v7a：`gosslan-5.18.34-armeabi-v7a-release.apk`，13,539,068 B，
  sha256 `8e47bee51f21000a4b80000b6efa5086e8e74802c744ce44b56fe6c0f252e3f8`

（另有 Windows 内置 WebView2 档 `Gosslan_5.18.34_x64-setup-webview2-bundled.exe` /
`Gosslan_5.18.34_arm64-setup-webview2-bundled.exe`，给装不上 WebView2 运行时的机器。）

`latest.json`（13,058 B，sha256 `df0a957756d38676f2eabb39e2d2d36c23745bf2a0fcceb02793a7744580fb6b`）
的 `version` 为 `5.18.34`，`platforms` 四键齐全：`darwin-aarch64`、`darwin-x86_64`、
`windows-x86_64`、`windows-aarch64`；四条 signature 与对应 `.sig` 资产解码后逐字一致。

版本核对：Windows 由产物文件名 `5.18.34` + `tauri.conf.json` 的 `version`（五处均为 5.18.34）；
macOS 挂载 dmg 后读 `CFBundleShortVersionString`。以上字节数与 sha256 来自
`gh release view v5.18.34 --json assets` 的现读值。

> 本包相对 5.18.30 的用户可感知变更：群任务图片补拉改走群文件帧（群里发的图不再冒到单聊）；
> 群任务属性统一（关联时间 / 任务类型 / 任务标签同一套控件）并新增多选任务标签（支持历史候选、
> 大小写不敏感去重）；自己的文本气泡与尾巴合并为一条闭合路径（消除 0.5px 浅色缝）；
> 桌面图片预览统一为应用内覆盖层，删除独立预览窗口（一次只看一张，并排对比能力按拍板舍弃）。
> 5.18.31–5.18.34 均未单独发 Release，功能随本包一起到位。

> 总时长：必做 ≈ 13 分钟；可选（BLE 多跳）≈ 4 分钟。每条"不对就发我"统一指：
> 截图（标出位置）+ 两端日志最后 30 行里带 `code=` 的行。Windows 日志在
> `%APPDATA%\com.gosslan.app\logs\gosslan.log`；Android 用 `adb logcat -s gosslan-logcat`。

## 0. Win11 原地升级五步（必做，2 分钟）

前置：机器上已装一个旧版（v5.16.74 或更早）并至少启动过一次；托盘退出应用。

1. 设置 → 关于，记下旧版本号。
2. 托盘右键 → 退出（任务管理器里确认无 `gosslan.exe`）。
3. 双击 `Gosslan_5.18.34_x64-setup.exe` → 下一步 → 安装（同目录原地升级，不应要求先卸载）。
4. 打开应用 → 设置 → 关于，应显示 `5.18.34`。
5. 打开一个旧会话 + 好友列表，历史消息与好友都还在。

PowerShell 三行（整段粘贴即可）：

```powershell
@("$env:LOCALAPPDATA\Gosslan\gosslan.exe","$env:LOCALAPPDATA\Programs\Gosslan\gosslan.exe") | % { if (Test-Path $_) { (Get-Item $_).VersionInfo.ProductVersion } }
Get-Process gosslan -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet
Get-Content "$env:APPDATA\com.gosslan.app\logs\gosslan.log" -Tail 20
```

看什么：第 1 行输出 `5.18.34`；第 2 行只有 1 个进程；第 3 行末尾没有 `code=E_`。
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
（同一公网中继并已建立电路，或填了同一个桥接机的「跨网段连接」地址）；两端都是 5.18.34。

点击：B → 设置 → 关于 → 复制设备 ID 发给 A；A → 添加好友 → 粘贴到搜索框 → 等 2~3 秒。

看什么：列表里出现 B 那一行（链路可能显示「经 N 跳」）；点加好友 → B 同意 → A 发一条能到。
不对就发我：A 搜索框（含粘贴的 ID）+ 列表截图 + 两端日志 `code=` 行。

---

## 已知缺口（测试时不必当 bug 重报）

1. 没有目录服务：只能发现「已配置 routed 端点 / 已建中继电路」可达范围内的设备；
   完全陌生、双方无任何连接路径的设备，凭设备 ID 仍搜不到（这是隐私上的取舍，不是 bug）。
2. 已修（5.17.22）：复制邀请按钮常驻、文案改为「发给对方，对方添加后即可跨网段互见」；
   「可能离线」改为整行灰显（只降透明度，仍可点击）。
