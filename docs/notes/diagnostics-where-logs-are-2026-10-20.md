# 日志在哪里 · 崩溃后怎么收集

面向用户的一页说明。不需要开发者工具、不需要开发者模式：所有条目都来自生产构建（release）实际写在磁盘上的东西。

## 1. 日志目录

| 平台 | 路径 | 本轮状态 |
|---|---|---|
| macOS（**安装版**，App Sandbox） | `~/Library/Containers/com.gosslan.app/Data/Library/Application Support/com.gosslan.app/logs/` | 未在本轮重装验证（DEFERRED：本轮不重装安装包）；沙箱容器化这一条来自 `src-tauri/tauri.conf.json` 的 `app.macOSPrivateApi`/沙箱配置与既有安装版读数 |
| macOS（**开发/裸二进制**，未沙箱） | `~/Library/Application Support/com.gosslan.app/logs/` | **PASS**：2026-10-20 用 `target/release/gosslan`（5.0.36）+ 隔离 `HOME` 实跑，产出 `gosslan.log` 与 `gosslan-crash.log`。**现读权限（5.0.36 那次）**：日志文件 `-rw-------`、`com.gosslan.app` 目录 `drwx------`，但它下面的 `logs/` 本身是 `drwxr-xr-x`（0755）—— 别人读不到内容靠的是父目录那一层，不是 `logs` 自己；而 10-18 之后没人写过的 `gosslan-3.log` 还停在 `0644`。
  **5.0.37 修后（同一台机器、同一个 release 二进制跑完一轮 E2E 之后重读）**：`logs/` = `drwx------`，目录里**每一份** `.log`（含那份 `gosslan-3.log`）= `-rw-------`。新建目录时 `mkdir` 直接带 `0700`，启动时再补一次收紧（包括扫旧文件）。复跑：`ls -ldT "$HOME/Library/Application Support/com.gosslan.app/logs" && ls -lT 同一目录` |
| Windows | `%APPDATA%\com.gosslan.app\logs\gosslan.log` | **NOT RUN**（本轮无 Windows 设备/运行环境；路径取自 `docs/notes/windows-ble-diagnosis-2026-09-13.md`、崩溃现场文件见 `windows-crash-capture-2026-10-16.md`） |
| Linux | `~/.local/share/com.gosslan.app/logs/` | **NOT RUN**（按 `app.path().app_data_dir()` 的 `com.gosslan.app` 推得；本轮无 Linux 运行环境） |
| Android | 应用目录下的同一份日志 + **logcat 镜像**：`adb logcat -s gosslan` | **NOT RUN**（镜像写码在 `src-tauri/src/logging.rs` 的 `logcat` 模块，本轮未上真机；这是"闪退时拿不到文件"的那条兜底通道） |
| iOS | 代码里没有 iOS 专属日志路径分支 | **NOT RUN / 不可用**（本轮未验证；如需要，只能走系统级诊断，不在本轮范围） |

多开实例时文件名带实例号：`gosslan.log` / `gosslan-1.log` / `gosslan-2.log`…（`GOSSLAN_INSTANCE`）。

## 2. 目录里为什么有三个文件

- `gosslan.log` —— 当前这一代，单文件超过 512 KB 就整体挪到下一个名字，所以**很早的行会不在这里**。
- `gosslan.old.log` —— 上一代。**只有一份**：再轮转时它会被覆盖（磁盘上界约 1 MB/实例，故意不留很多份）。
- `gosslan-crash.log` —— 崩溃/启动路标文件，**不参与轮转**。里面是三行一类的记号：
  `----- 启动 …`、`----- 正常退出 …`、`===== 崩溃现场 …`（外加崩溃前最多 300 条运行日志）。

## 3. 崩过一次之后，先读哪一句

下一轮启动时应用会自己判一次，并把结论**写进 `gosslan.log`**（这样只发文件的人也看得到）：

```
[boot] 上次收尾判定：正常退出（有退出路标）
[boot] 上次收尾判定：panic 现场（见上面的崩溃现场块）
[boot] 上次收尾判定：异常终止 —— 只有启动路标，既无正常退出路标也无崩溃现场。…
```

三条各自的含义与**边界**（不要读过头）：

- **正常退出**：走到了应用内的收尾（托盘「退出」/`app.exit`）。
- **panic 现场**：Rust panic 或分配失败，现场块里有 panic 位置与崩之前若干条。
- **异常终止**：这一条只能证明"没留下收尾也没留下崩溃现场"。它**包含** `kill -9`、系统强杀、掉电、被 OOM 杀掉，也包含某些原生层直接终止进程的死法 —— 这几类**在进程内部不可能留痕**，所以只能按"缺席"归类，不能细分成哪一种。
- 界面卡死但进程还在（WebView 侧卡住）**不会**出现在这三条里 —— 那属于"没退出"，不是"退出了但没标记"。

## 4. 在应用里看

侧栏「更多」→「运行日志」：可以按时间窗/关键词筛、看级别、一键**复制全部**。
两点要如实说清楚：

1. 那个窗口显示的是**内存环**（最近 500 条）与上一轮启动时读回来的尾巴，
   它**不读磁盘上的 `.old.log` 与 `-crash.log`**；要那两份就直接发文件。
2. **界面里还没有「导出诊断包」这个按钮**（5.0.37 只交付到后端出口，见下面「剩余接口」）。
   两条命令已经注册可用：`get_log_locations`（三条真实路径，给"复制路径"用）与
   `export_diagnostics_bundle(destination)`（读那三份 → 逐行脱敏 → 写到用户选好的路径）。
   **现在可用的替代路径就是上面那张表里的目录**：用系统文件管理器打开它，把那三份文件原样发出即可
   （不需要打包整个目录，理由见第 5 节）。

### 剩余接口与验收条件（归属：当前负责前端的会话）

本轮不改别人的在飞文件，所以按钮、语言包与 api 包装这三样留在那里收口。要做的四件：

1. `src/api/index.ts` 加两条包装与两个返回类型：
   `getLogLocations()` → `LogLocations{dir,current,crash}`；
   `exportDiagnosticsBundle(destination: string)` → `BundleSummary{bytes,files,redactions,path}`。
   落点由 `plugin-dialog` 的 `save()` 给（能力表里 `dialog:allow-save` 已经开了）——
   **Rust 不替用户决定写到哪**，所以前端必须传一个真实路径，不能传空串（空串会被命令判成错误）。
2. 至少一个真实调用点（本仓的契约判据 `src/utils/mapContract.test.ts` 第三段就是钉这一格的：
   门面里加了包装而全仓没人引用 ⇒ 判红）。放哪由前端定，形状上是日志窗工具栏或设置「关于/存储」那一节：
   「复制日志路径」+「导出诊断包」两个动作。
3. 两份语言包各补相应键名。
4. 「在文件夹中显示」这一格要先拍一个板：`commands::open_local_path` 现在**刻意**只肯打开托管目录里的
   文件（见 `commands/files.rs` 里那条拒绝），日志目录不在其中；要么给它加一条"日志目录"分支，
   要么由前端走 `opener` 的 reveal —— 能力表里现读只有 `opener:default`，reveal 需要单独确认。

验收条件（每条都能复跑，不靠口头）：

- `node --test src/utils/mapContract.test.ts` 绿：新命令既在 `generate_handler!` 里、也上了契约图的
  IPC 表，且包装在 `src/` 里有真实引用。
- 真机点一次导出，然后 `grep -c "$HOME" <导出的文件>` 与 `grep -c "192\\.168\\." <同一文件>` 都必须是 **0**
  （这两条是"包真的脱过敏"的正面读数，不是"命令返回了成功"）。
- 生产构建（release）里点的那一次才算数：开发模式跑通不证明界面在打包后可用。


## 5. 发日志出去之前

- 日志层按规范**不写**消息正文、密钥、会话密钥、文件名这些内容（模块头那份规范是判据盯着的），
  所以直接发文件通常是安全的；但**同一目录里还有数据库和收到的文件**，别把整个目录打包发出去。
- 落盘写不进去时（磁盘满/权限），日志里会出现一行
  `error [log] 日志落盘已降级…`，并且这条只进内存 —— 如果用户那边"日志里什么都没有"，
  先看有没有这句，它能把"没发生"和"没写进去"分开。
- 崩溃排查最少需要：`gosslan.log` + `gosslan.old.log` + `gosslan-crash.log`，
  外加一句"大概几点几分崩的"（日志时间戳是 UTC）。
