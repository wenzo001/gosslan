# Windows 闪退现场取证（2026-10-16）

**为什么先写这份**：用户报的形状是 —— 整晚只开着、不发消息也不操作，**不崩**；崩发生在
**收/发消息时**，或者**他在操作别的应用时**，而且**可能连带把别家 WebView2 应用一起搞崩**。
这个形状在 macOS 上无法复现，也没法靠读码定根因：Release 构建是
`[profile.release] panic = "abort"`（全平台生效）+ `main.rs:2` 关掉控制台 + `strip = true`，
所以进程是"直接消失"，不留 Windows 默认那种可读痕迹。

**这份文档只取证，不预设根因。** 四条读数拿到之后才谈得上分。

---

## 0. 一句话版（只想花 3 分钟的话）

崩一次之后，立刻做第 1 步（复制日志）+ 第 2 步（读事件日志三条）。
**第 1 步有 30 分钟窗口**，别拖 —— 日志文件只留一代（512 KiB 轮转覆盖 `.old.log`，磁盘上界约 1 MB），
崩完继续用一会儿，那条现场就被冲掉了。

---

## 1. 先把应用自己的日志抢下来（最重要，也最容易过期）

日志落盘位置（`identifier = com.gosslan.app`，`state.rs` 里 `Logger::new(app_data/logs, …)`）：

```powershell
$dir = "$env:APPDATA\com.gosslan.app\logs"
dir $dir                       # gosslan.log / gosslan.old.log（多开测试时是 gosslan-1.log 等）
Copy-Item "$dir\gosslan*.log" "$env:USERPROFILE\Desktop\gosslan-logs\" -Force
```

行格式（`logging.rs:314`，逐字）：

```
[dev:Win-7f3a] 2026-10-16T00:12:33.123Z ERROR [panic] panic @ src/network/transport/…: <消息>
 ^指纹          ^UTC                    ^级别   ^通道   ^正文
```

**要 grep 的就是这三样**（都在这份文件里，不在应用内那个"运行日志"窗口 —— 那个是节选）：

```powershell
Select-String -Path "$dir\gosslan*.log" -Pattern '\[panic\]'          # ① 有没有 panic
Select-String -Path "$dir\gosslan*.log" -Pattern 'ERROR \[(file|group_file|relay|chat|group)\]' | Select -Last 40   # ② 崩溃前最后几条错误
Select-String -Path "$dir\gosslan*.log" -Pattern '\[boot\]'           # ③ 当次启动是从哪条路标开始的
Select-String -Path "$dir\gosslan*.log" -Pattern '群文件台账补账'      # ④ 一次性补账跑没跑、补了几条、跳过几条（4.40.9 起才有；这一族的 target 是 [file]）
```

怎么读：

| 读数 | 含义 | 下一步 |
|---|---|---|
| 崩点附近有 `[panic]` 行 | 根因就是某处 panic，**文件与行号已经在里面** | 把那一行原样贴回来，不用再做第 3 步 |
| 没有 `[panic]`，但崩前有 `ERROR [file/group_file/relay]` | 不是 panic，是被外部拿走的（资源/驱动侧） | 做第 2、3 步 |
| 什么新行都没有（最后一条是很久以前的） | 日志线程本身被一起带走了，或根本没走到我们代码 | 做第 2 步看是哪种退出 |
| `群文件台账补账跑完：候选 0、补上 0、跳过 0、对不回身份的卡片 0` | 这一台**没有缺账**（正常态） | 不用管；它同时证明作业确实跑过 |
| 同一行里 `补上 N`（N>0） | 这台曾经坏过、现在被补上了 | 把那一行原样贴回来 —— 这是「线上到底坏没坏」的第一个真读数（本轮只有单测判据、没有装机读数） |
| `跳过 transfer=… 哈希对不上（声明 … ≠ 实测 …）` | 盘上那个同名文件**不是**那份内容 ⇒ 设计上就**不许补** | 也贴回来；这一条是补账不会把台账写错的那道闸在起作用，不是故障 |
| 整条都没有（连 `候选 0` 都没有） | 这台跑的还是 4.40.9 之前的版本（那一格作业还不存在） | 先钉装机 exe 的版本，别把它当成「补账没生效」 |

> ⚠️ 第 ④ 条那一行**不是开机就有**：这一格作业刻意排在启动后 20 秒才开始（让首屏、局域网自启、`.part` 清扫先跑），
> 而且**跑过就只跑一次**（settings 里落了完成标记）。所以「窗口刚打开那会儿查不到」和「第二次启动查不到」都是正常态，
> 不能当成「补账没生效」——真要确认它跑过，找那条 `跑完：候选 …` 的历史行，它在旧日志里也在。
> ⚠️ 边界要说清：`panic = "abort"` 时 hook（`lib.rs:154-175`）仍会先被调用，所以**理论上 panic 一定留得下**。
> 反过来说，"日志里没有 panic 行"是**有力的否证**，而"有 panic 行"是直接命中 —— 这条判据两头都能用。

---

## 2. 让 Windows 自己留证据（一次开，之后每次崩都自动留）

### 2a. 崩溃 dump（管理员 PowerShell，一次性的开关）

```powershell
$kd = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps"
New-Item -Force -Path $kd | Out-Null
New-ItemProperty -Force -Path $kd -Name DumpFolder   -PropertyType ExpandString -Value "%LOCALAPPDATA%\CrashDumps\gosslan"
New-ItemProperty -Force -Path $kd -Name DumpType     -PropertyType DWord -Value 2      # 2 = 完整 dump
New-ItemProperty -Force -Path $kd -Name DumpCount    -PropertyType DWord -Value 6
```

（`DumpType 2` 会写整份内存，磁盘要留够；只想要轻一点就填 `1` 迷你堆 dump。）

### 2b. 事件日志三条 —— 这三条能把"我们自己崩"和"被外部带走"分开

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application'; Provider='Application Error'}   -MaxEvents 20 |
  ? Message -match 'gosslan' | select TimeCreated, Id, @{n='m';e={$_.Message -replace "`r?`n"," | "}} | fl
Get-WinEvent -FilterHashtable @{LogName='Application'; Provider='Windows Error Reporting'} -MaxEvents 20 |
  ? Message -match 'gosslan' | select TimeCreated, Id, @{n='m';e={$_.Message -replace "`r?`n"," | "}} | fl
Get-WinEvent -FilterHashtable @{LogName='System'; Provider='Display'} -MaxEvents 40 |
  select TimeCreated, Id, @{n='m';e={$_.Message -replace "`r?`n"," | "}} | fl
```

**只看三个字段**：

| 来源 / 事件 ID | 看什么 | 读数 |
|---|---|---|
| `Application Error` 1000 | **故障模块名称** + 异常码 | 模块是 `gosslan.exe`/我们的 dll ⇒ 我们自己崩；是 `nvlddmkm`/`aticfx`/`nvwgf2umx` 之类 ⇒ 显卡侧；是 `unknown` + `0xc0000005` ⇒ 内存越界，要 dump |
| `WER` 1001 | P4/P5（故障模块与偏移） | 和 1000 互证 |
| `Display` 4101 | **TDR：显卡驱动重置后恢复** | 这条一旦命中，"别家 WebView2 也一起没了"就完全说得通 —— GPU 是整个会话共享的 |

> 异常码速查：`0xc0000005` 访问越界；`0xc0000409` 栈溢出/快速失败检查；`0xc0000374` 堆损坏；
> `0x800705aa`（E_OUTOFMEMORY 类）或退出码是干净 `0xC0000000` 之外的值 ⇒ 更偏资源侧。

---

## 3. 判"只增不减"这一类（托盘图标那条怀疑的判据）

这一条不需要崩，**平时用就能出结论**，所以最适合装在白天：

```powershell
$csv = "$env:USERPROFILE\Desktop\gosslan-handle-$(Get-Date -Format yyyyMMdd-HHmm).csv"
1..480 | % {
  Get-Process gosslan,msedgewebview2 -ErrorAction SilentlyContinue |
    select @{n='t';e={(Get-Date -Format s)}}, Name, Id,
           @{n='Handle';e={$_.HandleCount}},
           @{n='WS_MB';e={[int]($_.WorkingSet64/1MB)}},
           @{n='Commit_MB';e={[int]($_.PrivateMemorySize64/1MB)}} |
    Export-Csv $csv -Append -NoTypeInformation
  Start-Sleep 30
}
```

GDI / USER 对象数 `Get-Process` 不给，两条路选一：

* **Sysinternals Process Explorer**（最省事）：View → Select Columns → Process Performance 里勾
  **Handles / GUI Objects / User Objects**；按 GUI Objects 排序，盯 `gosslan.exe`。
* 或 PowerShell P/Invoke `GetGuiResources`（需要 `PROCESS_QUERY_INFORMATION`，脚本略 —— 不确定就直接用 Process Explorer，别拿一个自己没验过的计数器当证据）。

**怎么算命中**（重点是"活动期涨、静置不回落"）：

| 形状 | 结论 |
|---|---|
| 收发/切窗口期间 Handles 或 GUI Objects **单调上升**，停止活动后**不回落** | 就是资源泄漏型 —— 本轮改的托盘那条属于这一类，值得先看它降下来没有 |
| 上升后**能回落** | 不是泄漏，是瞬时峰值 ⇒ 转向"提交电荷/桌面堆配额被别家一起吃掉" |
| 全程平直，但照样崩 | **否证资源型**，回到第 2 步看故障模块（多半是 GPU/驱动或第三方模块） |
| 只崩一次、其余时间都平 | 更像一次性状态触发（特定消息/特定图片/特定文件），需要把崩点前后 30 行的 `[file]/[chat]/[group_file]` 贴回来 |

顺带：Windows 每进程默认 GDI/USER 对象上限各 **10,000**（注册表 `Win32k` 那套是**每会话共享的桌面堆**）——
这就是"我们崩、别家 WebView2 也被带走"在结构上**能同时成立**的唯一一族原因。

---

## 4. 这份文档没有主张的事

1. **没有主张根因是托盘图标**。本轮把"每次未读变化都重设图标"改成"只在有/无翻转时重设"，
   理由是那条是**当前唯一已知按消息数增长**的对象通道（`tray-icon` 的 `Shell_NotifyIconW` 早退路径在**外部 crate** 里，
   macOS 上连编译面都不在，本机无法证明它真的漏）。这是止血，不是结论。
2. **与 CSP、与 4.40.8 群收尾存量坏台账那两格无关**，别把它们当成本次崩溃的候选。
3. 第 2 步的注册表开关与第 3 步的采样脚本都是**读多写少但不本机验证**的东西：命令本身按 Windows 公开机制写，
   跑之前你自己看一眼；跑出来的读数请连同**安装包版本号**（`Gosslan_x.y.z`）一起给，
   不同版本形状不同，没钉住版本号的所有归因都不作数。
