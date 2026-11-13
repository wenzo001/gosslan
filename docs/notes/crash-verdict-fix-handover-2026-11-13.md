# 交接：上一轮收尾判定的三处缺陷（2026-11-13，5.22.0 真机报告）

本文写给**接手改代码的人**，不需要读过上一个会话。内容分两半：
前半是这次真机崩溃的取证结论（哪些已定、哪些没定），后半是**已经 review 过、可以直接落地**的三处修法，
含陷阱、验收夹具、门禁与不许扩大的半径。

- 取证日期：2026-11-13
- 取证时仓库 HEAD：`d76a0d07`，`node scripts/version.mjs show` → `5.22.2`
- 出事版本：`5.22.0`（windows-x86_64 · release · 设备 `dev:Win-lhcz-f`）
- 本文所有行号都是**取证当时工作树**现查的。`src-tauri/src/logging.rs` 当时无在途改动，行号与 HEAD 一致；
  `src-tauri/src/lib.rs` / `state.rs` / 两册 locale 有别人的在途改动，而且**那条会话正在 live 编辑**
  （取证中途行号移过），见 §5。接手时请重新现查、优先按符号名定位，别照抄行号。

---

## 0. 接手须知（先读这三条）

1. **要改的是"判定与报告"，不是崩溃本身。** 这次进程为什么消失，现有文件定不死（§1.3），
   需要机器上的 Windows 事件日志。别把"修好判定"当成"修好崩溃"汇报。
2. **工作树里有另一条在途改动（device_auth），而且正在 live 编辑**，已碰 13 个文件，其中
   `lib.rs` / `Cargo.toml` / **两册 locale** 与本次修法同文件。提交时只 stage 自己的 hunk，
   别把别人的活一起带走（§5）。
3. **三处修法必须一起落**，只修一处会让两侧结论继续打架。它们共用同一个切片函数，分开提交等于把
   同一个领域连打三次补丁（Change Budget 的重复犯案棘轮会拦）。

---

## 1. 现场与已确认事实

### 1.1 用户上报的弹窗原文

```text
Gosslan 上一轮运行报告 / previous run report
code: BOOT_PREV_SILENT_KILL
kind: silent_kill
started_at: 2026-11-13 08:27:14
last_seen: 2026-11-13 08:41:51
version: 5.22.0
```

附件（用户机器上导出的，不在仓库里，可能已不在）：
`~/Downloads/gosslan-crash.log`（现场文件，4618 行）、`~/Downloads/gosslan.log`（应用日志，636 行）。
下面把关键行逐字抄进来，附件丢了也能读。

### 1.2 时间线（全部来自附件，行号是附件里的行号）

| 时刻 | 来源 | 事实 |
|---|---|---|
| 08:04→08:14 | gosslan.log L104/165/227 | `avail_commit` 1784→1507→1181MiB，`load` 85→87% |
| 08:19:20 | crash.log L4599 | `>>> 重分配失败：请求 1048576 字节（对齐 1）… avail_commit=3MiB … ⇒ 分配器即将 abort` |
| 08:26:16 | crash.log L4600-4603 | 新进程 `pid=60332`，运行 `cf59df` 启动；`avail_commit=404MiB` |
| 08:26:42 | crash.log L4606 | `>>> 分配失败：请求 152483 字节（对齐 1）… avail_commit=0MiB … ⇒ 分配器即将 abort` |
| 08:27:13 | crash.log L4607-4610 | 新进程 `pid=35276`，运行 `1ae936` 启动（**就是弹窗报的那一轮**） |
| 08:32:14 / 08:37:14 | crash.log L4612-4613 | `1ae936` 的 `RUNTIME_MEM`：本机 `ws=72MiB commit=26MiB`，`avail_commit=1165MiB` |
| 08:41:42 | gosslan.log L568 | `1ae936` 的应用日志最后一行（只有 gossip 噪声，无错误、无 HANG） |
| 08:41:51 | crash.log L4614-4615 | 新进程 `pid=37464` 的 `>>> 启动尝试` + `BOOT_WINDOW_BUILD_START` |
| 08:41:52 | crash.log L4616 / gosslan.log L569 | 运行 `8324f8` 启动；日志写 `code=BOOT_PREV_ABORT` |

`1ae936` 那一轮的切片里**没有**任何收尾证据：无 `----- 正常退出`、无 `===== 崩溃现场`、
无 `>>> panic @`、无 `code=SIGTERM_RECEIVED`、无安装器路标、无分配失败行、无 `code=HANG`。
死亡窗口 = 08:41:42～08:41:51，**不超过 9 秒**。

同一份现场文件里，日志侧与弹窗侧对这一轮给出了**相反结论**：

```text
gosslan.log L569:
[dev:Win-lhcz-f] 2026-11-13 08:41:52 warn [boot] 上次收尾判定：分配器 abort（见上面的「重分配失败」行；
请求字节数就写在里面）（最后记录到 2026-11-13 08:41:51，此后没有任何路标） code=BOOT_PREV_ABORT
```

弹窗说 `silent_kill`，日志说 `abort`。这不是"两个来源之一记错了"，是**两条判定路径喂了不同的行窗口**（§2.1）。

### 1.3 死因：已定的部分与没定的部分

**已定**：这台机器当时处在系统提交内存（commit）见底的状态，而且 Gosslan 不是吃内存的那个。

- 全机 `total_commit=40711MiB`，`load` 87～91%；
- Gosslan 主进程 `commit=26MiB`、`ws=72MiB`，整棵 WebView2 子树 `tree_commit≈889MiB` ⇒ 约占全机 2%；
- 紧挨着的前两轮都留下了分配器 abort 行，请求的分别是 1MiB 和 149KB —— 连这点都提交不出来；
- 全仓现场文件里这类行一共 4 笔：2026-10-21、2026-10-29、2026-11-13×2，同一台机器。

**没定**：`1ae936` 这一轮为什么连一行 abort 都没留下。两种解释都与现有证据相容，**文件本身分不开**：

1. 失败的分配来自原生分配器（WebView2/Chromium 自己的 malloc），不经过本仓的
   `NotingAlloc`（`src-tauri/src/lib.rs:200`）⇒ 钩子根本没被调用；
2. `avail_commit≈0` 时，`note_alloc_failure`（`src-tauri/src/lib.rs:233`）里那条
   `format!` / `fresh.line()` **自己也要申请内存** ⇒ 先 abort，一行写不出来。
   再入闸 `NOTE_IN_PROGRESS`（`src-tauri/src/logging.rs:464`）在这种情况下也只是丢弃。

**证伪需要的下一手证据（在出事那台 Windows 上取，我这边取不到）**：

```powershell
# ① 应用错误 / WER：看异常码。0xc0000409 ⇒ fastfail（panic 或 handle_alloc_error，内存一族）
#    0xc0000005 ⇒ 访问违规（真代码 bug）；查不到事件 ⇒ 外部结束 / 断电
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime='2026-11-13 08:35'; EndTime='2026-11-13 08:50'} |
  Where-Object { $_.Message -match 'Gosslan' } | Format-List TimeCreated, Id, ProviderName, Message

# ② 资源耗尽登记（系统级）
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime='2026-11-13 08:00'; EndTime='2026-11-13 09:00'} |
  Where-Object { $_.Id -in 2004,2005,41,6008 } | Format-List TimeCreated, Id, Message
```

还要一句人话证据：08:41:51 那次启动是**用户自己双击**的，还是系统拉起的。
本仓没有崩溃自拉起路径（`restart_app` 只由界面按钮触发，`src-tauri/src/commands/logs.rs:22`），
9 秒的间隔更像用户看着窗口消失后立刻重开，但这一条没取证，别当结论写。

**采样盲区（本次真实发生，属于观测缺口不是崩溃原因）**：`RUNTIME_MEM` 与 `COMMIT_PRESSURE`
都挂在 5 分钟那一格上（`src-tauri/src/state.rs` 里 `let mem = crate::mem_diag::sample()` 起、
到 `code=COMMIT_PRESSURE` 那两行止；取证当时工作树 3140-3154，HEAD 对应 3136-3150。
阈值 512MiB 见 `src-tauri/src/mem_diag.rs:580`）。
08:37:14 那一格还正常，下一格 08:42:14 没跑成 ⇒ **临界那 4 分钟零读数**。
同一块里那句"崩之前那 20 分钟的走势"的注释（工作树 `state.rs:3147`）想要的东西这次没兜住。
改法见 §6（不在本次范围）。

---

## 2. 三处缺陷与修法（已 review，可直接落地）

三处都在 `src-tauri/src/logging.rs`，共用 `last_run_slice` / `classify_previous_exit` 这两个函数。

### 2.1 (a) 两侧判定喂了不同的行窗口 ⇒ 同一轮两个结论

**根因**：

- 报告侧（弹窗）：`build_previous_run_report_with` 先 `last_run_slice(raw)` 切到**上一轮**，再分类
  （`src-tauri/src/logging.rs:1076`-`1082`）。
- 日志侧：把现场文件尾部**最近 40 条原生行**整段喂进同一个分类器，**跨多轮**
  （`src-tauri/src/logging.rs:2027`-`2069`；`PREV_CRASH_MAX_LINES = 40` 在 `src-tauri/src/logging.rs:157`，
  尾窗 64KiB 在 `src-tauri/src/logging.rs:155`）。
- 而分类器里 `===== 崩溃现场` 与 `>>> 重分配失败` 这两条 `any()`
  （`src-tauri/src/logging.rs:1259`-`1266`）**不像** `panic @` / `SIGTERM` / `BOOT_FAILED` / 安装器路标那样
  限定"最后一次启动之后"⇒ 更早轮次的证据会被按到上一轮头上。

本次就是这样：08:19:20 那笔 abort 落在 40 行窗口里，于是 `1ae936` 被判成 `BOOT_PREV_ABORT`。
`src-tauri/src/logging.rs:2067` 的注释要求"两处必须用同一个 `effective_previous_exit`"——
**函数统一了，输入没统一**，所以那条保证是空的。

**修法**（窗口只许有一个家）：

1. 抽一个私有 helper，例如 `fn previous_run_native(raw: &[String]) -> Vec<String>`
   = `last_run_slice(raw)` + `is_crash_native_line` 过滤；
   `build_previous_run_report_with` 与 `seed_previous_run` **都调它**，各自把结果交给
   `effective_previous_exit`。分类器是纯函数，同输入必同输出。
2. `src-tauri/src/logging.rs:2069` 的 `&native` 换成这个 helper 的输出。
3. 顺带同一污染面的两处（都在同一个 `if` 块里，别漏）：
   - `has_block`（`src-tauri/src/logging.rs:2064`）也扫的是跨轮窗口 ⇒ 更早一轮 panic 会把本轮内存环条目
     抬成 Error 级。改成扫同一切片。
   - dump 的标题写的是"—— 上一轮崩溃现场/路标（截自 … 尾部）——"
     （`src-tauri/src/logging.rs:2053`），而它 dump 的确实是跨轮窗口。
     **保留跨轮 dump**（本次取证正是靠它看到 08:19 那笔），但标题要改成"最近 N 条现场路标（可能跨多轮）"
     这个意思，别让读者以为上面每一行都属于上一轮。

**⚠️ 陷阱（我第一版就踩了，模拟跑出来才发现）**：
日志侧现有代码会先 `native.pop()` 掉本轮的 `----- 启动` 行（`src-tauri/src/logging.rs:2032`-`2038`）。
**先 pop 再调 `last_run_slice` 会整体错一轮** —— `last_run_slice` 靠"最后一条启动行"定位本轮，
pop 掉之后它把**上一轮**当成了本轮，切出来的是上上轮。必须在 pop **之前**切片，
或者干脆按上面第 1 条从 `raw` 切。

**反例自证（必须新增，否则这个洞会静默回来）**：
一条跨侧一致性判据。构造现场文件：

```text
----- 启动 A 版本 1.0.0
>>> 重分配失败：请求 1048576 字节（对齐 1）⇒ 分配器即将 abort（不是 panic，钩子不会跑）
----- 启动 B 版本 1.0.0
>>> code=BOOT_WINDOW_READY 主窗口与 WebView2 已创建
----- 启动 C 版本 1.0.0
```

走 `Logger::new` + `seed_previous_run`（照 `src-tauri/src/logging.rs:3229` 那条既有用例的形状），
断言**写进日志文件的 `code=` 与 `previous_report.code` 逐字相等**，且都等于 `BOOT_PREV_SILENT_KILL`
（B 轮自己没有任何 abort 证据）。把 helper 换回 `&native` 这条必须红。
只断言"两侧都非空"或"两侧都能判出东西"都不算自证。

### 2.2 (b) abort 前缀只认三个里的一个

**根因**：写入侧有三种前缀，读判只认一种。

- 写入：`note_alloc_failure("分配", …)` / `("重分配", …)` / `("分配(清零)", …)`
  （`src-tauri/src/lib.rs:206` / `:216` / `:223`），行体由 `src-tauri/src/lib.rs:233` 拼成
  `{what}失败：请求 {size} 字节（对齐 {align}）{读数} ⇒ 分配器即将 abort（不是 panic，钩子不会跑）`。
- 读判：`l.starts_with(">>> 重分配失败")`（`src-tauri/src/logging.rs:1265`）。

**实证就在附件里**：`cf59df` 那一轮（08:26:17→08:26:42）的切片里明明白白写着
`>>> 分配失败：请求 152483 字节（对齐 1）… avail_commit=0MiB … ⇒ 分配器即将 abort`，
判定却是 `silent_kill`。也就是说**有现场的内存耗尽被说成了"可能被强杀/断电"**。

**为什么门禁一直是绿的**：喂给分类器与报告侧的夹具清一色只有 `重分配失败`
（`src-tauri/src/logging.rs:2816` / `:3080` / `:3200` / `:3209` / `:3220`）。
这正是 AGENTS.md 说的"检查还在跑、但已查不到东西"——判据只测自己写的形状。

**修法**（常量单一事实来源 + 接线判据，不许手抄字面量）：

1. 在 `logging.rs` 定义三个具名常量与一张清单，例如
   `ALLOC_FAIL_ALLOC` / `ALLOC_FAIL_REALLOC` / `ALLOC_FAIL_ZEROED` 与 `ALLOC_FAIL_KINDS: &[&str]`；
2. `lib.rs` 那三个调用点改用常量（编译期就不可能漂）；
3. 分类器遍历 `ALLOC_FAIL_KINDS` 判前缀，替掉 `src-tauri/src/logging.rs:1265` 那一行；
4. **接线判据**：源码扫描断言 `lib.rs` 里 `note_alloc_failure("` 这种**字面量调用出现 0 次**
   （按出现次数判，不是"存在即通过"），并且 `ALLOC_FAIL_KINDS` 真的被分类器用上。
   形状照 `src-tauri/src/lib_source_view_tests.rs` 里既有的源码扫描用例。

**必须连带改的文案（漏了就是"判定修好了、界面继续误导"）**：

- `src-tauri/src/logging.rs:2087` 的判定文本写死了「见上面的「重分配失败」行」；
- `src-tauri/src/logging.rs:793` 与 `:1262`-`:1264` 的文档注释同样只提 `重分配失败`；
- **i18n 两册**：`crash.abort` 在 `src/i18n/locales/zh-cn.ts:358` 写着
  "详情在日志的「重分配失败」那一行"；`src/i18n/locales/en-us.ts:361` 同形
  （"The requested size is in the reallocation-failure line of the log."）。
  两册都改成不点名具体前缀的说法（例如"详情在日志里那条『分配失败/重分配失败』行"）。
  两册必须同步改，且要过 i18n 语气判据（不喊口号、不写占位话）。

**反例自证**：新增用例把**真机那一行逐字**喂进去（带 `ws=… avail_commit=0MiB …` 那段读数后缀，
不要只喂简化形），断言 `Abort`；`分配(清零)失败` 同样一条。
把清单缩回只剩 `重分配` 时这两条必须红。既有夹具不许改形状（它们钉的是优先级与映射）。

### 2.3 (c) `last_seen` 读到的是本轮自己的行

**根因**：切片边界停在 `----- 启动`，而本轮 bootstrap 期的两条行写在它**之前**：

```text
----- 启动 2026-11-13 08:27:14 … 运行 1ae936 -----     ← 上一轮起点
>>> >>> code=BOOT_WINDOW_READY …            @08:27:14
>>> >>> code=RUNTIME_MEM …                  @08:32:14
>>> >>> code=RUNTIME_MEM …                  @08:37:14   ← 上一轮真实的最后记录
>>> 启动尝试：… pid=37464                    @08:41:51   ← 本轮
>>> >>> code=BOOT_WINDOW_BUILD_START …       @08:41:51   ← 本轮
----- 启动 2026-11-13 08:41:52 … 运行 8324f8 -----     ← 本轮起点（切片右边界）
```

`last_seen_at` 只剔 `>>> 启动尝试`（`src-tauri/src/logging.rs:1119`-`1124`），
`BOOT_WINDOW_BUILD_START` 留着 ⇒ 报出 `08:41:51`，把"死了约 4 分钟才被重启"说成"同一秒无缝重启"。

**为什么既有用例没拦住**：`src-tauri/src/logging.rs:3164` 那条夹具里，
`BUILD_START` 在 `启动尝试` **之前**（属于上一轮），而真机是**之后**（属于本轮）。
夹具没覆盖真机形状 —— 又一个"判据只测自己写的形状"。

**修法**：在 `last_run_slice`（`src-tauri/src/logging.rs:1017`）里，
**仅当 `prev.is_some()`** 时，从切片尾部剥掉连续的"bootstrap 期"行
（`启动尝试` / `code=BOOT_WINDOW_BUILD_START`）。放在这个函数里，报告侧与日志侧自动同时受益。

**两个必须遵守的细节**：

1. **判定前缀要用 `strip_note_prefix`**（`src-tauri/src/logging.rs:900`）。
   真文件里 `BUILD_START` 是 `>>> >>> code=…`（**双层** `>>>`）：
   `lib.rs:1021` 传的文本自带 `>>> `，`crash_note_to` 又加一层（`src-tauri/src/logging.rs:493`）。
   而 `启动尝试` 与分配失败行是单层。直接 `starts_with(">>> code=BOOT_WINDOW_BUILD_START")`
   在真机文件上**永远不命中**，改完看着像修了其实空转。
   （既有夹具用的是单层，所以只跑夹具也发现不了。）
2. **`prev.is_none()` 那条腿一个字都不许动**。那是 A5 全新安装 / 单实例交接的判定
   （`src-tauri/src/logging.rs:1026`-`1047`），剥掉尾部 bootstrap 行会把
   `single_instance` 打成 `no_history`，等于把"死在 logger 之前"的检测能力关掉。

**反例自证**：新增一条真机形状夹具（`BUILD_START` 在 `启动尝试` **之后**，且带双层 `>>>`），
断言 `last_seen_at` = 上一轮最后一条自有记录、`kind` 不变。
把 `strip_note_prefix` 换成裸 `starts_with` 这条必须红。
既有三条夹具（`src-tauri/src/logging.rs:3110` 的三格、`:3164` 的 last_seen）必须原样绿。

**已知残留（本次不修，写出来免得接手人以为漏了）**：本轮在 `Logger::new` 之前写下的
`>>> panic @` / 分配失败行，仍会落进上一轮切片被误归。这是切片边界的既有模糊处，
与本次三处缺陷同源但影响面不同，单独一轮再处理。

---

## 3. 修法已在真机文件上模拟验证过

用一份按源码口径复刻的模拟器（**不是跑真 Rust**，是复刻 `last_run_slice` / `classify_previous_exit`
的判定顺序与谓词）跑真机现场文件与既有夹具，结果：

| 输入 | 日志侧 修前→修后 | 弹窗侧 修前→修后 | last_seen 修前→修后 |
|---|---|---|---|
| 真机 08:41:52 那次启动（判 `1ae936`） | Abort → **SilentKill** | SilentKill → SilentKill | 08:41:51 → **08:37:14** |
| 真机 08:27:14 那次启动（判 `cf59df`） | Abort → Abort | SilentKill → **Abort** | 08:27:13 → **08:26:42** |
| 既有夹具 last_seen（`logging.rs:3164`） | SilentKill → SilentKill | 同 | 02:53:01 → 02:53:01（不变） |
| 既有夹具 single_instance（`logging.rs:3135`） | SingleInstance → 同 | 同 | — |
| 既有夹具 全新安装（`logging.rs:3118`） | 见下注 | NoHistory → NoHistory | — |

两点解读：

- 第一行修完两侧一致，且 `last_seen` 回到那一轮真实的最后记录。**注意 `1ae936` 修完仍是 `silent_kill`**——
  它自己确实没留下任何收尾证据，这是诚实的结论，不是"修好了崩溃"。
- 第二行是 (b) 的收益：`cf59df` 真的死于分配器 abort，修完弹窗终于说对话，
  `last_seen` 也正好落在 abort 那一刻（08:26:42）。
- 注：全新安装那一格，真实日志侧走 `only_this_runs_bootstrap` 整块跳过、根本不写判定行
  （`src-tauri/src/logging.rs:2045`-`2048`）；模拟器没复刻这个跳过，所以表里那一格不用读。
  报告侧 `no_history` 不变才是要点。

模拟器与截断好的现场文件在 `/tmp/gosslan-replay/`（`replay.mjs` 复刻修前、`fix-sim.mjs` 模拟修后）。
**/tmp 会被清掉**，它只是取证 convenience，不是判据；真正的验收靠 §2 各条新增的 Rust 用例。

---

## 4. 落地顺序与门禁

### 4.1 顺序

1. 先写 §2 各条的**反例自证用例**，跑一次确认它们在当前代码上**是红的**（先红后绿）。
2. 落 (c)（改 `last_run_slice`）→ 落 (b)（常量 + 分类器 + 三处文案 + i18n 两册）→ 落 (a)（helper + 两个调用点 + `has_block` + dump 标题）。
   这个顺序让每一步都能单独跑绿，(a) 放最后是因为它依赖前两步的判定已经正确。
3. 三处一起提交（同一领域连打三次补丁会被 Change Budget 拦）。

### 4.2 必跑的门禁（改了 `src-tauri/**` ⇒ 全量层）

```bash
npm run verify:full > /tmp/verify-full.log 2>&1; echo "EXIT=$?"
```

- **退码不许经过管道**。上面这种写法才拿得到真退码；`| tail` 会让 `❌` 印在屏幕上而退码是 0。
- 跑门禁期间不许改判据或夹具，否则那一跑只能算行为探针，改完必须重跑。
- 红了先把整条日志读完再撤，别看头几行就回滚。

新增/改名 Rust 用例 ⇒ 测试清单基线要跟着动（基线在 `src-tauri/test-baseline.macos.txt`
与 `src-tauri/test-baseline.windows.txt`）：

```bash
node scripts/check-test-manifest.mjs --only rust --update        # 只重写本平台
node scripts/check-test-manifest.mjs --sync-baselines            # 按源码门控推其它平台
node scripts/check-test-manifest.mjs --only rust                 # 复核
```

`--sync-baselines` **只增不删**：本次是新增用例，正常够用；若顺手改名或挪了模块，
必须手工清掉旧名那条腿，否则判据会报"本平台比并集少一条"并把错的腿指成对的腿。

前端只动了 i18n 两册（可能还有 `src/utils/crashReport.ts`，见 §6）⇒ 快速层也要绿：

```bash
npm run verify > /tmp/verify.log 2>&1; echo "EXIT=$?"
```

i18n 两册键集合必须一致；本次是改值不是增删键，死键基线不用动。
前端断言在中英两种 locale 下都要成立（全量层里有英文复跑那一格）。

### 4.3 版本与提交标记

动了应用码 ⇒ 同一提交里 `Version-Bump:` + 五处版本清单齐：

```bash
node scripts/version.mjs patch        # 一次写五处：package.json / package-lock.json /
                                      # src-tauri/Cargo.toml / src-tauri/Cargo.lock / src-tauri/tauri.conf.json
node scripts/version.mjs show
npm run version:check
node scripts/check-change-budget.mjs --staged     # 现算档位，别照抄本文的估计
```

档位估计（**以现算为准**）：计入预算的文件约 4～6 个（`logging.rs`、`lib.rs`、两册 locale，
可能加 `crashReport.ts` / `types.ts`；`.md` 与 `scripts/` 豁免，五处版本清单不计数），
大概率 L2 ⇒ 标题带 `[plan]`；若现算判成 L3 就带 `[impact]`。
`logging.rs` 不在敏感文件清单里（敏感只有 `protocol.rs` / `crypto.rs`）。

提交前硬闸（已装 hook，标题缺标记直接 exit 1）：

```bash
node scripts/check-change-budget.mjs --staged --commit-msg-file .git/COMMIT_EDITMSG
```

CHANGELOG 写进 `[Unreleased]`，与代码同一笔。文档里的硬数字不许手抄门禁步数/取锁点条数
（`scripts/check-doc-numbers.mjs` 会现算对账）。

### 4.4 汇报口径

每一句"已修"都要挂可复跑命令 + 实测读数。本次三处缺陷的验收读数应该是：

- 新增的反例自证用例：改坏即红、恢复即绿（两趟都要真跑，把输出贴出来）；
- `npm run verify:full` 的 `EXIT=0`；
- 真机文件复算：§3 那张表的修后列（用新增的 Rust 用例钉住，而不是靠 /tmp 里的模拟器）。

没跑的层明写"没跑，因为 X"。`npm run verify:e2e` 与 `verify:release` 本次**不需要**
（没有跨进程/传输/群/文件链的行为改动），但别把它们写成绿。

---

## 5. 在途改动的隔离（动手前必看）

**这条会话正在 live 编辑同一棵工作树**：取证过程中 `git diff --stat` 从 7 个文件涨到 13 个，
`state.rs` 的行号在两次读取之间移了 4 行。所以本文行号只作定位起点，**动手前一律现查**，
优先按符号名（函数 / 常量 / 键名）找位置。下面这份清单是快照，接手第一件事是自己跑一遍：

```bash
git status --porcelain
git diff --stat
```

取证当时 `git status --porcelain` 的在途内容（**别人的活，以 device_auth 为主**）：

```text
 M src-tauri/Cargo.toml              （time crate 加了 parsing/formatting feature）
 M src-tauri/src/commands.rs
 M src-tauri/src/db.rs
 M src-tauri/src/error_codes.rs
 M src-tauri/src/lib.rs              （+2 行 mod 声明、+6 行 run() 里的接线）
 M src-tauri/src/state.rs            （AppState 字段 + 一处接线）
 M src/App.vue
 M src/api/index.ts
 M src/components/SettingsPanel.vue
 M src/components/SettingsWindow.vue
 M src/i18n/locales/en-us.ts         （+44 行）
 M src/i18n/locales/zh-cn.ts         （+44 行）
 M src/types.ts
?? src-tauri/src/commands/device_auth.rs
?? src-tauri/src/db/device_auth.rs
?? src-tauri/src/device_auth.rs
?? src-tauri/src/device_auth/
?? docs/notes/external-app-device-auth-design-2026-11-13.md
?? docs/notes/full-project-audit-2026-11-13.md
```

后果与处置：

- **同文件碰撞有三处**：`lib.rs`（(b) 要改三个调用点）、`Cargo.toml`（版本 bump 要改）、
  **两册 locale**（(b) 要改 `crash.abort`）。目前 device_auth 的两册新增键落在
  `zh-cn.ts` 939 行之后与 1261 行之后，都在 `crash.abort`（358 行）**之后**，所以暂时不重叠；
  但提交时必须只 stage 自己的 hunk（`git add -p`），**不许** `git add -A`。
- 先确认 device_auth 是否已落地。没落地就与那条会话协调顺序，别两边同时改同一册词典。
- `npm run verify:full` 会编译在途的 device_auth 代码。它若没写完，门禁会因为**与本次无关的原因**红。
  遇到这种红先归因，别顺手去改别人的模块。
- `src-tauri/src/logging.rs` 取证当时**无在途改动**（`git diff --name-only` 对它返回 0 条），
  所以本文所有 `logging.rs` 行号与 HEAD 一致，可以放心用。
- `lib.rs` 的行号是工作树的，HEAD 对应行号**减 2**（在途 hunk 在第 37 行与第 980 行）。

---

## 6. 明确不在本次范围（防止半径扩大）

以下三件都是本次取证顺带发现的真实缺口，**各自单独一轮**，别塞进这次提交：

1. **临界几分钟的采样盲区**（§1.3）。5 分钟一格 ⇒ 崩前最后 4 分钟零读数。
   最小提案：在既有那一格里，当 `avail_commit` 低于某个比 512MiB 宽得多的水位（例如 2GiB）时
   额外留一行走势；或按压力自适应缩短周期。要配接线判据（调用点只 1 处、由既有 tick 驱动、
   按出现次数而不是存在性断言）。
2. **"复制详情"不带分配失败读数**。`formatCrashReport`（`src/utils/crashReport.ts:9`）只输出
   code/kind/时间/版本/panic/hang，**没有**请求字节数与 `avail_commit`。
   而 `crash.abort` 文案却让用户"去看日志里那一行"。用户的工作流是把复制文本发过来 ⇒
   把那一行的关键读数带进报告，下次内存耗尽一步就能定因。
   代价：`PreviousRunReport` 加字段 ⇒ `src/types.ts` 同步、可序列化类型不许带密钥（INV-P18 那道守卫）。
3. **本轮 logger 之前的 panic/abort 被归到上一轮**（§2.3 末尾的已知残留）。

另外：**死因本身**（§1.3 的两种解释）等 Windows 事件日志到手再定，别在本次提交里写"已修复崩溃"。

---

## 7. 复算方式（可复跑）

取证当时跑过的、接手人可以重跑的：

```bash
# 现场文件里这类行的历史分布（4 笔：10-21 / 10-29 / 11-13×2）
grep -E "^>>> (重)?分配(\(清零\))?失败" ~/Downloads/gosslan-crash.log \
  | grep -oE "@[0-9-]+ [0-9:]+" | cut -c2-12 | sort | uniq -c

# 两侧结论打架的原始证据
grep -nE "BOOT_PREV_(ABORT|SILENT_KILL)" ~/Downloads/gosslan.log

# 内存走势（本机很小、全机很紧）
grep -n "RUNTIME_SNAPSHOT" ~/Downloads/gosslan.log
```

附件若已不在，§1.2 抄录的行足以复述结论；要重跑上面三条命令则需要用户再导一次日志。
