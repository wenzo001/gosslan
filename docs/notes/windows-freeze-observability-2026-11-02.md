# Windows 假死取证：新增读数与日志（2026-11-02）

> 只加观测，不改行为、不改超时语义、不新增协议。日志量有界：心跳 1 条/秒；
> `IPC_BACKLOG` 最多 1 条/30 秒；HANG 行沿用既有的先密后疏（20 条后转 5 分钟一条）。

## 新加在 HANG 现场行里的字段

`logs/gosslan-crash.log` 的 `>>> code=HANG ...` 现在额外带：

| 字段 | 含义 |
|---|---|
| `hb_age_ms` | 前端心跳距今毫秒；`-1` = 本轮还没收到心跳 |
| `active` | 心跳时窗口是否前台可见 |
| `inflight` | 前端在途 IPC 数 |
| `inflight_oldest_ms` | 最老一条在途 IPC 已等待毫秒 |
| `focused` / `focus_age_s` | 主窗口最近一次 focus 的状态与距今秒数 |
| `resize_age_s` | 主窗口最近一次 resize 距今秒数 |
| `db_hold` | 最近一次慢持锁摘要（无则 `none`，空白压成 `_`，截 160 字符） |

原有的 `last_op` / `last_op_age_s` 与 `mem_diag` 行保持不变。

## 新增日志码

- `code=IPC_BACKLOG inflight=N oldest_ms=N active=… last_op=…`
  - 触发：`inflight >= 8` 或最老一条 `>= 2s`，且窗口前台可见；
  - 节流：30 秒最多一条；
  - 位置：运行日志 `logs/gosslan.log`（不是 crash 文件）。
- `code=SLOW_OP cmd=longtask:<name> ms=N`
  - 触发：浏览器 `longtask` >= 2s；同窗口 5 秒最多一条；
  - 不支持 `longtask` 的 WebView 静默跳过，不影响界面。

## 采集位置（Windows）

1. 崩溃/假死现场：`%APPDATA%\com.gosslan.app\logs\gosslan-crash.log`
   - 多实例：`gosslan-1-crash.log` 等。
2. 运行日志：同目录 `gosslan.log`（轮转后 `gosslan.old.log`）。
3. 诊断包：应用内「运行日志」窗口导出；它读的是同一目录。

## 边界

这些字段只在**下一次**假死时提供归因线索，不会自动恢复界面，也不会改变看门狗
的 2s/3s/10s 阈值。Windows WebView2 没有直接暴露渲染进程事件，本补丁用主窗口
focus/resize 时间戳作为可观测代理。
