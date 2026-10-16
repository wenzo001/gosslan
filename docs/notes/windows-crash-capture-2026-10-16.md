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

**2026-10-16 晚新增**：版本区间已经拿到（4.36.0 不崩 / 4.39.4 崩，见第 5 节）。
所以第 0 步现在是**先读上一次崩溃的事件日志**（不要钱、不用装任何东西），
再决定要不要装中间档 `v4.39.1`（4.4 MiB，一档就把 23 笔切成两半）。

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
   —— 版本号那一格 2026-10-16 晚已经拿到了（见下面第 5 节），**这条要求从"补充信息"变成"二分法的输入"**。

---

## 5. 版本区间（2026-10-16 晚：第一条真实二分证据）

**用户口述**：`Gosslan_4.36.0_x64-setup` **不崩**；`Gosslan_4.39.4_x64-setup` **会崩**。
这是本项目第一次拿到"同一个形状在两个已发版本上一个是绿的一个是红的"。

⚠️ **成立前提（还没钉）**：两次装机必须是**同一台 Windows 机器、同一份数据目录、同一套外设/显卡驱动**。
不同机器 ⇒ 这条区间只能算"两个样本"，不能算二分。

### 5a. 区间有多大、怎么分

`git rev-list --count v4.36.0..v4.39.4` = **23 笔**。这 23 笔全部发过版 ⇒ **每一档都有现成安装包**，
不需要构建（x64 版 `Gosslan_x_y_z_x64-setup.exe` 实测 **4.4 MiB**；`-webview2-bundled` 那支 187 MiB 用不上，
你机器上 WebView2 运行时已经在了）。

| 已发档位 | 区间内第几笔 | 比上一档多进去的应用码 |
|---|---|---|
| v4.36.0 | 0（**实测不崩**） | — |
| v4.37.0 | 2 | 一键同步 + 长弹窗顶部遮挡 |
| v4.37.1 | 3 | 图片预览缓存按字节封顶、objectURL 泄漏、窗口显示安全区 |
| v4.38.0 | 4 | 卡片三档点击、**内容服务不再堵入站**、群 Ack 落终态 |
| v4.38.1 / .2 | 9 / 10 | 名字判据收一个家、清扫 tick 不再整读大文件、自定义图标 |
| v4.39.0 | 11 | （同上批的收尾） |
| **v4.39.1** | **15** | **★ 分档点：不含单实例插件，也不含后面那两笔 Windows 改动** |
| v4.39.2 | 19 | **单实例守卫**（`81a9f12`，含 handshake/gossip/identity 去重那批） |
| **v4.39.4** | 23（**实测会崩**） | **Windows 大文件不卡 UI**（`6514179`）+ 评审补的三处（`1ad2866`） |

**只测 `v4.39.1` 一档就能把 23 笔切成两半**，且切口的两侧都很干净：
`git log --format='%h %s' v4.39.1..v4.39.4` 里**只有 3 笔动过应用码**
（`81a9f12`、`6514179`、`1ad2866`；其余 5 笔只碰文档/认知回写/护栏，退码面为零）。

- v4.39.1 **崩** ⇒ 根因在前 15 笔（`queue_policy.rs` +439、`outbox_sweep.rs` +554、`handle_share.rs` +159 那批 10-14 的大改）
- v4.39.1 **不崩** ⇒ 缩到 **3 笔**，可以逐笔回退各测一晚

### 5b. 这份区间里机器核对过的五件事（命令都挂在后面）

1. **整个区间只新增了一个依赖**：`tauri-plugin-single-instance 2.4.5`（带 `windows-sys 0.60.2`）。
   这是本区间**唯一新增的原生面**：它在 Windows 上建一扇常驻隐藏窗
   （`WS_OVERLAPPED` + 事后 `SetWindowLongPtrW(GWL_STYLE, WS_VISIBLE|WS_POPUP)`，尺寸 0×0，
   扩展样式 `NOACTIVATE|TRANSPARENT|LAYERED|TOOLWINDOW`），注册一个 Rust 写的 `WNDPROC`，
   第二实例用**跨进程同步** `SendMessageW(WM_COPYDATA)` 打进来 ⇒ 回调在**主线程的消息分发里**执行。
   上游注释自己写着那扇窗"必须 visible 才收得到 WM_PAINT，否则 resize 期间的事件投递不到"。
2. **`panic = "abort"` 是全平台 release 设置，且本区间一字未改**（`git diff v4.36.0..v4.39.4 -- src-tauri/Cargo.toml`
   里 `profile|panic|opt-level|lto|codegen` 那几条 `^[+-]` 为空）。
   ⇒ 本区间新增的**任何一次 panic** 的表现就是"进程直接消失"，而不是某个界面报错。这是"跳死"的机制侧解释。
3. **但区间新增的生产码行里，0 处 panic 可构造**：`.unwrap()` / `.expect(` / `panic!` / `assert` /
   `unreachable!` / `borrow_mut()` 全为 0（内联 `#[cfg(test)]` 段按边界排除）。
   尺子的可信度两条对照：① 逐文件新增行数与 `git diff --numstat` **23 个生产文件全部相符**；
   ② 同一把尺在同文件的测试段能找到 72 处（`outbox_sweep.rs`）与 34 处（`queue_policy.rs`）⇒ 不是空转。
   ⇒ 第 2 条和第 3 条合起来说明：**如果真是 panic 杀进程，panic 点要么本来就在（4.36.0 也带着），
   要么来自那个新增的原生窗/回调（不看 Rust 码就找不到）**。这条直接改变了下一步该找什么。
4. **区间新增生产码行里 0 处整读进内存**（`read_to_end` / `fs::read` / `.to_vec()` / `with_capacity` / `read_to_string`）
   ⇒ "几百 MB 一次读进内存把提交电荷耗光"这一条**在本区间没有新增来源**（`3b37269` 恰恰是把它删掉的那笔）。
5. **`DB_VERSION` 全程 = 11**（`v4.36.0` / `v4.39.1` / `v4.39.2` / `v4.39.4` 现读 `src-tauri/src/db.rs:20` 都是 11）
   ⇒ **往回装老版本不会撞"数据比程序新 ⇒ 拒绝启动"那道闸**（`lib.rs` 的 `InitError::Downgrade` 分支）。
   这一条是"能拿已发版本做二分"的前提；不成立的话第一次装机就会白等一晚。

### 5c. 测的时候两个坑（都会造出假读数）

- 插件的 `semver` feature **默认没开**（`[features]` 里只有 `deep-link` / `semver`，没有 `default =`）
  ⇒ mutex 名和窗口类名**只按 bundle id**，不带版本号。于是 **4.39.2 / 4.39.4 之间互斥**（后启动那个直接
  `std::process::exit(0)`，把已有那扇主窗叫到前台），但**与 4.36.0 / 4.39.1 之间不互斥**（那两个版本没有这扇窗）。
  ⇒ 混着装的时候**必须自己确认只有一份在跑**，否则两个托盘图标 + 两份 mesh 身份 + 同一条好友申请弹两次，
  那不是本次要找的崩溃，是装机姿势。
- 换档之间请把第 1 步（复制日志）和 **§2b 事件日志三条**跑一遍。**上一次崩溃的读数还在机器上** ——
  那是零成本的第一步，比装新档快。

复跑（macOS 本仓，全部只读）：

```bash
git rev-list --count v4.36.0..v4.39.4
git log --format='%h %s' v4.39.1..v4.39.4
git diff v4.36.0..v4.39.4 -- src-tauri/Cargo.lock | grep '^+name'
git diff v4.36.0..v4.39.4 -- src-tauri/Cargo.toml | grep -E '^[+-].*(profile|panic|opt-level|lto|codegen)'
for t in v4.36.0 v4.39.1 v4.39.2 v4.39.4; do git show "${t}:src-tauri/src/db.rs" | grep -n 'const DB_VERSION'; done
```

（第 3、4 条那两个"0 处"的结论是脚本按 `-U0` 逐 hunk 跟行号算的，脚本正文没进仓；
 要复核请照 5b③ 那两条对照自己重跑一遍，别把"0"当字面量抄进别的文档。）

---

## 6. 2026-10-16 晚：第一次拿到"真崩"的形状（用户现场读数）

采集方式＝本文档第 1/2 步那两条命令由用户在他的 Windows 机器上直接跑出、屏幕输出贴回来。下面每一条都是**读数**，不是推断。

### 6a. 崩溃形状：`0xc0000409`，故障模块就是我们自己

```
出错应用程序名称：gosslan.exe  版本：4.40.0.0
出错模块名称：    gosslan.exe  ← 不是 webview2/不是显卡 dll/不是 unknown
异常代码：        0xc0000409
错误偏移：        0x00000000004c6314（10-15 18:42 与 10-16 12:17 两次**同一个偏移**）
```

- `0xc0000409` = `STATUS_STACK_BUFFER_OVERRUN`，而它是**所有 `__fastfail` 的共用码**（具体原因在参数里，dump 里能读）。
  本仓 release 是 `[profile.release] panic = "abort"` ⇒ `abort()` 走 `__fastfail` ⇒ **这个码与"我们自己主动终止"一致**；
  随机内存被踩坏的那一族会是 `0xc0000005`。
- ⚠️ **不许把"两次同一偏移"读成"同一个 bug 点"**：一支二进制里的 abort 出口通常**只有一个**，
  所以同一偏移只证明"同一套终止机制"，不证明同一行源码。定位仍要靠 `channel="panic"` 那一行自带的 文件:行号。

### 6b. "带崩别的应用"成立：dump 目录自己排出时间线（LocalDumps 是全会话共用的）

| 北京时间 | 落下的 dump |
|---|---|
| 10-15 17:37:00 | `Trae CN.exe`（gosslan 在 17:36:58 有一次**另一种形状**：模块 `KERNELBASE.dll`、码 `0xe0000008` —— 那是"抛出"不是 fastfail，别与 6a 混成一条线索） |
| 10-15 18:42:23 / :25 | gosslan 事件 / `gosslan.exe.36936.dmp` |
| 10-15 18:42:28 / :31 / :36 | `pwsh.exe` ×2、`warp.exe` —— **13 秒内四支程序一起死** |
| 10-16 12:17:29 / :31 | gosslan 事件 / `gosslan.exe.27496.dmp` |
| 10-16 12:18:08 | `copyq.exe`（40 秒后） |

⇒ 这条把用户最初的口述从"猜测"升成"有登记"。§0 列的三条通路里 **显卡 TDR 已被否证**（`System` 日志 `Id=4101` 计数 **0**），
剩下两条：**桌面堆 / GDI·USER 配额** 与 **提交电荷耗尽** —— 两者都要"崩那一刻"的读数才能分开，而 dump 里正有。

### 6c. ★ 最重要的一格：4.40.9 **至今一次都没崩过**（用 CI 时刻钉的，不是靠猜）

事件里写着 `版本：4.40.0.0`，而他装的 exe 字符串版本是 `4.40.9`。这条含糊**不能靠版本字符串解**，改由 GitHub 的构建时刻解：

| 事实（现读 API 与本地 git） | 北京时间 |
|---|---|
| 我推 `a621a4d`（4.40.9 那笔） | 12:23:46 |
| `build-windows (x64)` 起 → 完 | 12:24:10 → **12:34:21** |
| 他那支 exe 的文件时间戳 | 12:33:56（落在这段构建窗口里） |
| **崩溃事件** | **12:17:29** |

⇒ 崩的时刻比"4.40.9 的 Windows 包存在"还早 **16 分钟**。所以 6a/6b 那几次崩**全部是 4.40.9 之前的构建**（含 10-15 那三次）。
**推论**：4.36.0↔4.39.4 那条区间依然成立（用户给的是 Releases 里的真实安装包名），但**今晚才是 4.40.9 的第一次测试**；
上一节说的"4.40.9 不崩不能读成修好了"现在要再加一句——**它连一次样本都还没有**。

⚠️ 遗留一格（等读数）：exe 的**数值版本第三位**（`FileBuildPart`）若真为 0，则 `4.40.0 / 4.40.9` 在 WER 里**长得一模一样**
⇒ 以后任何历史崩溃事件都归不到具体构建。修法与 6d 那两处同批：**把版本号与构建标识写进日志首行**（单行 panic 文件也带上它）。

**我自己在这格上犯的错要留档**：给你的核对命令里写了 `FilePatchPart` —— **这个属性不存在**（`FileVersionInfo` 的四个段是
Major/Minor/**Build**/Private），PowerShell 的 `fl` 对不存在的属性**静默不打印**，于是屏幕上"少一行"看起来像"读到 0"。
⇒ 凡是"某个字段没打印出来"的读数，先证这个字段名字真的存在。

### 6d. 为什么"崩了却没日志"：不是没打，是被刷掉了

- `gosslan.old.log` 实测 **524298 字节 = 512 KiB 上限**（`logging.rs:128` `MAX_LOG_FILE_BYTES`，只留一代，磁盘上界约 1 MB）。
- 当前 `gosslan.log` 尾部 20 行全是同一句 `diag/announce_verified`（`discovery.rs:614` 那一家），
  **同一秒内同一设备重复 5~6 条** ⇒ 512 KiB 撑不过几分钟 ⇒ **12:17 那条 `channel="panic"` 行结构上不可能还在盘上**。

这一格是本轮唯一"改代码就能把下一次读数保住"的口子，两处都很小：
① 崩溃那一行**单独落一个不轮转的文件**（一条百来字节，攒几百条也才几十 KB）；
② 那句局域网自检做**按设备按秒去重**（或降级不打盘）。

### 6e. 还欠的两格读数

1. `FileBuildPart` 现读（决定 6c 那格遗留是不是真缺陷）。
2. **把 4.39.4 那几次崩的事件条目捞出来**，看异常码与偏移是否与 4.40.0 那几次相同 —— 相同才谈得上"同一个 bug 一路活着"。
   上一条命令用 `MaxEvents 80` 只够回到最近这一小段，要按**时间窗**取：
   `Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error'; StartTime=(Get-Date).AddDays(-14)} | ?{$_.Message -match 'gosslan'}`

---

## 7. 2026-10-16 深夜：14 天窗口里七条崩溃条目 —— 第 5 节那条区间的**左端点现在不可靠了**

同一把尺（`StartTime` 取 14 天，不用 `MaxEvents`）实测：

| 北京时间 | 出错模块 | 版本 | 异常码 | 偏移 |
|---|---|---|---|---|
| 10-12 19:33:43 | gosslan.exe | **4.37.0.0** | `0xc0000409` | `0x4b86c4` |
| 10-13 13:01:36 | gosslan.exe | **4.37.0.0** | `0xc0000409` | `0x4b86c4` |
| 10-14 11:03:43 | gosslan.exe | **4.38.0.0** | `0xc0000409` | `0x4b8535` |
| 10-15 16:24:38 | gosslan.exe | **4.40.0.0** | `0xc0000409` | `0x4c6314` |
| 10-15 17:36:58 | **KERNELBASE.dll** | — | `0xe0000008` | `0xc408a` ← 另一种形状，不当同一条线 |
| 10-15 18:42:23 | gosslan.exe | 4.40.0.0 | `0xc0000409` | `0x4c6314` |
| 10-16 12:17:29 | gosslan.exe | 4.40.0.0 | `0xc0000409` | `0x4c6314` |

### 7a. 两条同时到手的否证

1. **6c 那格遗留作废**：他那支 4.40.9 的 exe 现读 `FileMajorPart=4 Minor=40 Build=9 Private=0` ⇒ 数值版本就是 **4.40.9.0**，
   版本资源没骗人。所以 12:17 那条 `4.40.0.0` **不可能**是这支 —— 与 §6c 用 CI 时刻推出的结论**互相独立地对上了**。
   ⇒ 以后每条崩溃事件自带版本，"崩的是哪一版"不再需要反推。
2. **区间左端点要重问**：`v4.36.0` 的 tag 打在 **10-12 10:37**，`v4.37.0` 打在 **14:43**（CI 产物 PE 时间戳 14:53），
   而**最早一条崩溃就在 10-12 19:33** ⇒ 4.36.0 从"能装"到"被 4.37.0 取代"只有 **4 小时**。
   他那句"4.36.0 一晚上不崩"如果指的是 10-12 之后某一晚，就与这张表冲突（那一晚装的应该已经是 4.37.x）。

### 7b. 如果"从 4.37.0 才开始崩"成立，第 5 节那 23 笔就塌成 1 笔

`git log v4.36.0..v4.37.0` = **2 笔**：`013fed5` 只动了一个验收文档（1 文件 +112 行，零应用码），
`3b73c22 feat(identity): 好友重装换密钥聊天内一键同步 + 修复长弹窗顶部遮挡` 是**唯一**的应用码差异。

⚠️ **但这条嫌疑我没能从码上立起来**：把尺子扩到之前没筛的那一族（下标/切片、除法取余、`remove/pop/from_utf8`）再扫一遍
`3b73c22` 的新增生产码行 —— 8 个命中**全是良构**（`HashMap::remove` 两处、`params![]` 宏、`#[derive]`/`#[tauri::command]`
属性被我的下标正则误伤）**没有一处会 panic 的下标或除零**。加上 §5b③ 早就测到的"区间新增生产码 0 处 unwrap/expect/assert"，
⇒ **这一笔里我找不到 abort 的来处**。
两种解释都还开着：① `0xc0000409` 不是 Rust panic，而是同一码族里的**另一支**（GS 栈溢出 / CRT abort / 依赖内 panic）——
只有 dump 里的 fastfail 参数能分；② 左端点其实更早（7a②），这张表看到的只是 14 天窗口的头一条。

### 7c. 现在最便宜的一步（零风险、一条命令）

把窗口拉到 60 天，看 4.36.0 之前那几晚有没有 gosslan 条目。**有** ⇒ 起点比 4.37.0 更早，§5 那整套分档重算；
**没有** ⇒ "10-12 之前不崩、之后每晚都有"这个形状成立，嫌疑就压到 `3b73c22` 那一笔 + 那一晚起的操作差异。

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error'; StartTime=(Get-Date).AddDays(-60)} -EA SilentlyContinue |
  ?{$_.Message -match 'gosslan'} | %{
    $m=($_.Message -split "`r?`n" | ?{ $_ -match '版本：|异常代码|错误偏移' }) -join ' / '
    "[$($_.TimeCreated.ToString('MM-dd HH:mm:ss'))] $m" }
```

### 7d. 顺带记一句本轮的归属边界

`3b73c22` 与 §6d 那两处待修（崩溃行单独落不轮转文件、自检按秒去重）都要动 `lib.rs` / `state.rs` / `logging.rs` / `discovery.rs`
—— 而 **2026-10-16 深夜这个工作树里另有会话正在写「群信息同步」**（`lib.rs`、`state.rs`、`network/mod.rs` 等 30 多个文件在飞、未提交）。
⇒ 同一文件并发改会把对方的在飞工作毁掉，所以本轮**只提交自己那一本文档**，那两处小修等对方落定后再开。

### 7e. §7c 那条已跑完：60 天与 14 天**返回同样 7 条**（10-16 深夜实测）

最早仍是 `10-12 19:33:43 / 4.37.0.0`。⚠️ 但这条"缺席"**现在还不能当证据** ——
`Application` 日志是滚动覆盖的，而本机已有过一次教训（"日志是节选 ⇒ 缺席不算证据"）。
要让它成立先证覆盖面，一条纯读命令：

```powershell
Get-WinEvent -LogName Application -Oldest -EA SilentlyContinue | Select -First 1 | %{ "日志最早一条：$($_.TimeCreated)" }
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application' -EA SilentlyContinue) |
  select MaxSize,Retention | Format-List
```

- 最早一条**早于 10-12 10:37**（`v4.36.0` 打 tag 的时刻）⇒ 缺席成立：**崩溃的历史起点就是 4.37.0**
  ⇒ §5 那 23 笔塌成 `3b73c22` 一笔，而 **4.40.9 带着它** ⇒ 今晚大概率还会崩（这不是坏消息，是能把样本拿满）。
- 最早一条**晚于那几天** ⇒ 窗口被截，"从 4.37.0 才开始"这句作废，起点仍未知。

### 7f. ★ 有一个不改代码就能抬起取证上限的开关

§7b 那条"找不到新 panic 点"指向一族很常见的解释：**触发形状是新的、panic 点是旧的**
⇒ 要拿的不是 diff，而是**那句 panic 文本本身**。它落盘会被 §6d 的洪水冲掉，能不能从 dump 拿回来取决于 dump 类型：

```powershell
# 管理员 PowerShell。Mini(1) 只带线程栈与模块清单、**不含堆**；
# 而我们那句格式化后的 panic 文本（lib.rs:166）和「内存里最后 500 条日志环」（logging.rs MAX_MEM_LOGS）都在堆上。
# Heap(2) 才带得上，体积仍是几十 MB 量级、发得出来。
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps' -Name DumpType -Value 2
```

⇒ 换完之后，**下一次崩溃的 dump 里同时带着 panic 那一句 + 最后 500 条日志（即使文件已被轮转冲掉）**。
这一格比 §6d 那两处代码修改更快生效，因为它**不需要装新版**。

（对已有的两个 Mini dump 做字符串抽取我**不看好**：没有堆内存，多半只捞得到栈上残留。想试也不贵，
但请把力气放在上面这条开关 + 今晚那一次。）

---

## 8. 崩溃现场机制已落地（commit `80b93ec`，只动 `src-tauri/src/logging.rs`）

用户 2026-10-16 深夜的诉求："写一套崩溃前保存错误的机制，能在某个文件里查看、发给你就能定位"。

**它是什么**：panic 钩子那条 `logger.error("panic", …)` 现在除了写主日志，还会**同步**把三样东西追加进一个
**不参与轮转**的文件 ——

```
%APPDATA%\com.gosslan.app\logs\gosslan-crash.log
```

1. `>>> panic @ 文件:行:列：消息`（直接就是定位点，不需要 dump、不需要 WinDbg）；
2. **崩之前最后 300 条运行日志**，取自内存环 `MAX_MEM_LOGS` 而不是文件 ⇒ 与 §6d 那股洪水**解耦**，
   哪怕 `gosslan.log`/`.old.log` 已经翻过好几代，这 300 条仍然完整；
3. 表头带 **版本号 + 平台 + debug/release + 设备指纹**（今天为"崩的是哪一版"只能拿 CI 时刻反推）。

磁盘上界 2 MiB：超了**整份重开**（它不轮转，不封顶就是永远只增）。此刻进程正要 `abort()` ⇒ 全程同步写、
写完即关（手里不留 BufWriter）、**任何失败一律静默**（诊断代码不许在临死前再抛一个 panic）。

**用法（下一次崩之后）**：

```powershell
# 一个块 = 表头 1 + panic 原文 1 + 分隔 1 + 上下文 300 ⇒ 取 310 行才够拿到完整最后一块。
# （`-Tail 120` 不够：`>>> panic` 那行在**块头**，取尾巴会正好把它切掉。）
Get-Content "$env:APPDATA\com.gosslan.app\logs\gosslan-crash.log" -Tail 310
```
把输出整段贴回来即可 —— 这一份不再需要"30 分钟内抢日志"，也不依赖事件日志。

**边界要说清（三条，别当成万能）**：
1. 只有 **panic** 会写它。被外部拿走（资源/驱动）或非 Rust 崩溃 ⇒ 文件里不会新增块，
   那种情况仍要看 §2b 的故障模块与 §7f 的 dump 类型。
2. 崩在 **logger 建立之前**（`lib.rs:199` 那个还没 state 的早期钩子）也没有块 —— 与 §5 那条"两种没有 panic 的成因"同源。
3. **判"这台装的是不是带机制的构建"**：最直接的证据是崩一次之后该文件存不存在（文件名唯一，旧版绝不会有）。
   不要靠文件名或版本串认 —— 这一版没提版本档（见下），产物仍叫 `Gosslan_4.40.9_x64-setup.exe`、
   数值版本仍是 `4.40.9.0`。**请从 `80b93ec` 那次 Actions 运行下载**，别看名字。

**验证（本地实测，数字现算）**：`cargo test --features bluetooth --lib logging::` → **7 passed / 0 failed**；
`cargo clippy --features bluetooth --lib -- -D warnings` → 退码 0；
两笔单点变异：摘掉 `if target == "panic"` 那一步 → **3 条判据全红**；表头去掉 `env!("CARGO_PKG_VERSION")` → 版本那条红 1 条；
还原后与原件逐字节一致。前置条件也被钉过：那条测试先把主日志**撑到必然已轮转**（断言 `.old.log` 存在），
否则"现场还在"可能只是因为日志还没翻 —— 那就是空转。

**这一轮补上的第二半（commit `2356c39`）：洪水本体被折在日志器里，`state.rs` 一行没动。**
去重的自然落点是 `state.rs:1895 push_diag_event`，而那个文件正被同工作树另一会话改着未提交 ⇒
现读核对 `diag/` 这个前缀在全仓**只有一个出生地**（`state.rs:1913` 的 `format!("diag/{kind}: {detail}")`），
于是规则放进 `Logger::log` 入口：`level == Info` 且整行以 `diag/` 开头时，
**同 target + 整行文本完全相同 + 同一个 epoch 秒**只留第一条（三条全同的重复不带新信息 ⇒ 不是"少记"，是"记一次"；跨秒必然重新记）。

两条刻意划死的反向边界，各有判据：

- **`warn` / `error` 永远不折**（`diag_warn_and_error_are_never_folded`，4+4 条逐条数）——
  本轮审计的主题就是"失败必须看得见"，把错误一起折掉就是倒退。
- **只管 `diag/` 这一族**（`non_diag_info_is_not_folded`）—— 非 diag 的 info 重复照旧各留一条。

折叠表 `≤ 512` 键、超了整表重开（键里带设备 id 与来源 IP，不封顶就是"永远只增"的内存洞），
且挂在 `Logger` 实例字段而不是全局 static ⇒ 多实例与单测互不污染。
五步判据 + 四笔单点变异**各红且只红对应那一条**（详见该笔提交说明）。

**还剩的一格（有意的，不是漏掉）**：CHANGELOG 条目与版本提档 —— `CHANGELOG.md` 与 `package.json`
此刻同样在那批在飞文件里 ⇒ 不占别人的文件。不提档会不会挡发版不是我猜的：
门禁**现判** `L1` 且判据 4「无声明」通过（`node scripts/check-change-budget.mjs --range HEAD~1..HEAD` 退码 0）；
新用例名也没整本重写基线，只把**我那 8 条**塞进索引（`macos 880→888`、`windows 868→876`），
因为判据口径是"**缺名 FAIL、多名只 WARN**"（`check-test-manifest.mjs:25-26`）——
把别人还没进 main 的用例名登记进去，反而会在 main 上造出一条真红。

---

## 9. 2026-10-16 傍晚：4.40.9 崩了 —— 但**这是第二种死法**，我们的机制接不住它

`Application Error` 里新出现一条 **17:53:42、版本 `4.40.9.0`** 的条目 ⇒ §6c/§7 那句"4.40.9 零样本"到此结束。
**可它的形状不是我们一直追的那一种**：

| | 形状 A（追了一路的那个） | **形状 B（这次这个）** |
|---|---|---|
| 出错模块 | `gosslan.exe`（我们自己） | **`KERNELBASE.dll`** |
| 异常码 | `0xc0000409` = `__fastfail`（abort/panic=abort 的出口） | **`0xe0000008`** |
| 偏移 | 每个构建一个值（4.37.0→`0x4b86c4`、4.38.0→`0x4b8535`、4.40.0→`0x4c6314`） | **`0xc408a`，两次完全相同**（因为它在系统 dll 里，不在我们二进制里） |
| 出现次数 | 5 条（10-12 19:33 → 10-16 12:17） | 2 条（**10-15 17:36:58** 与 10-16 17:53:42） |

- `0xE0000000` 那一段是**软件异常**（有人调 `RaiseException` 主动抛的），不是硬件 fault。
  ⚠️ 我没有 `0xe0000008` 的可信映射，**不猜**。公开可比的只有一例：Electron 应用崩溃里
  `RaiseException+69 in KERNELBASE.dll`，其上游是 `KERNELBASE!WaitForMultipleObjectsEx`
  （[Kong/insomnia#4331](https://github.com/Kong/insomnia/issues/4331)，那条还写着"内存涨到 3 GB 然后崩"）。
  两条 B 型事件都在 **2 秒内**跟着别的应用落 dump（10-15 那次 2 秒后是 `Trae CN.exe`）⇒ 与"别家一起死"的形状更贴。
- ★ **关键含义：§8 那套崩溃现场机制只接得住形状 A。** 它挂在 panic 钩子上，而 B 不是 Rust panic
  ⇒ 下一次崩如果是 B，`gosslan-crash.log` **不会新增块** —— 那不是机制坏了，是它管不着这种死法。
  B 只能靠**带堆的 dump**（`DumpType` 已改 2）与事件日志。
- **① 那段返回空 = 这台机器上一份 WER 文本报告都没有**（四个 `ReportQueue`/`ReportArchive` 根目录全空）。
  与他截图那句 `Error launching CrashSender.exe` 互相印证：**WER 的上报链路是断的**（助手起不起来），
  于是取证只剩两条腿：`Application Error` 事件 + `LocalDumps`。别指望 `Report.wer` 里的 Bucket。
- **我上一条命令自己有个错要认**：`DumpFolder` 我指到了 `%LOCALAPPDATA%\CrashDumps\gosslan`（**子目录**），
  而我给的读数命令是 `Get-ChildItem "$env:LOCALAPPDATA\CrashDumps" -Filter 'gosslan*'` 没加 `-Recurse`
  ⇒ 屏幕上那个 `gosslan 0 MB` 是**那个目录本身**，不是 dump。17:53 那次到底有没有落下带堆的 dump，
  这条命令**没看到**，读数作废，要用 `-Recurse` 重取。

### 9a. 于是下一步分成两问，别再混着问

1. **A 型（我们自己 abort 的那一族）**：装带机制的构建（tip `8236b1e`），崩了看 `gosslan-crash.log` 有没有块。
   有块 ⇒ 直接拿 `文件:行:列`。没块 ⇒ 说明这次是 B 型或"崩在 logger 之前"。
2. **B 型（KERNELBASE 抛出的那一族）**：只认 dump。先确认 17:53 那次有没有留下带堆的 dmp（`-Recurse`），
   有就报大小与时间戳；没有就再崩一次（`DumpType=2` 已生效）。
   两份 dump 的差别（Mini vs Heap）决定我能不能给你一段本机抽取脚本把栈和堆里的文本捞出来。
