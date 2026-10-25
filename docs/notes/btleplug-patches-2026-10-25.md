# vendored btleplug CoreBluetooth 补丁索引（2026-10-25）

这份文件是**升级 btleplug 时的重放清单**：`src-tauri/vendor/btleplug` 不是上游原样，
里面有若干 `// GOSSLAN PATCH` 标注的改动。重新 vendor / 升级版本时逐条对照；
`node scripts/check-panic-sites.mjs` 会在 vendor 生产块出现任何
`panic!` / `.expect(` / 非锁 `.unwrap()` 时直接判红。

版本基线：`btleplug 0.13.0`（macOS 走 `corebluetooth` 后端）。

## 为什么必须打这些补丁

release 是 `panic = "abort"`（安卓入口宏的硬约束，见 `src-tauri/Cargo.toml`）。
CoreBluetooth 会在首轮服务发现/连接完成之后继续投**迟到/重复回调**；上游在这些
回调里用 `panic!` / `unwrap` 表示"不可能发生"，而对我们就是整进程消失。
2026-10-25 macOS v5.10.1 连续 9 次 SIGABRT 全部来自其中一处。

原则：**迟到回执一律当"这次操作失败/过期"**，记日志或返回 `Err`，绝不让整个
进程为一条过期回调陪葬。

## 第一批（`ffcc5e60`）

| 文件 | 位置 | 原行为 | 现行为 |
|---|---|---|---|
| `internal.rs` | `check_discovered` | 全部服务已发现但没有等待者 ⇒ `panic!` | 记 `trace!` 并返回（结果已交付，不补发） |
| `central_delegate.rs` | 写入/通知状态/描述符读写成功分支 | `characteristic.service()` / `descriptor.characteristic()` 为空 ⇒ `unwrap` | `let Some(...) else { warn!; return; }` |

## 第二批（本批）

| 文件 | 位置 | 原行为 | 现行为 |
|---|---|---|---|
| `adapter.rs` | `adapter_state` | 非 `AdapterState` 回执 ⇒ `panic!` | 返回 `Err(RuntimeError)` |
| `peripheral.rs` | `is_connected` / `connect` / `discover_services` / `write` / `read` / `subscribe` / `unsubscribe` / `read_rssi` | 意外回执 ⇒ `panic!` | 返回 `Err(RuntimeError)`（调用方拿到失败） |
| `central_delegate.rs` | 发现外围设备 | `Retained::retain` 为空 ⇒ `unwrap` | `let Some(...) else { warn!; return; }` |
| `central_delegate.rs` | manufacturer data / service data / TxPower | `downcast` / `try_into` / `objectForKey` ⇒ `unwrap` | 跳过该字段或整条广播，记 `warn!` |
| `central_delegate.rs` | 描述符值 `get_descriptor_value` | `downcast` ⇒ `unwrap` | `map(...).unwrap_or_default()`（未知类型给空字节） |
| `internal.rs` | `set_services` 的 `services_discovered_future_state.take()` | 无等待者 ⇒ `unwrap` | `if let Some(state)`，否则丢弃回执 |
| `internal.rs` | `on_peripheral_connect` / `connection_failed` / `disconnect` / `on_adapter_powered_off` | 回调之间表被清理 ⇒ `expect` | `if let Some(peripheral)`，缺失就跳过 |
| `internal.rs` | 读回执 `read_future_state.pop_front()` | 队列空 ⇒ `unwrap` | `if let Some(state)`，否则当通知/过期回执 |
| `internal.rs` | `retrievePeripherals` 的 `NSUUID::from_string` | 转换失败 ⇒ `unwrap` | `filter_map` 跳过这一条 |
| `internal.rs` | CoreBluetooth 线程建 tokio runtime | 建失败 ⇒ `unwrap` | 记 `error!` 并结束该线程（不 abort 进程） |
| `internal.rs` | `CString::new("CBqueue")` | `unwrap` | 改用 `c"CBqueue"` 字面量 |
| `future.rs` | `poll` 的 `reply_msg.take().unwrap()` | 先判 `is_some` 再 `unwrap` | `if let Some(msg)` |

## 明确保留

- `.lock().unwrap()`（Mutex 中毒）：首次 panic 已经 abort，中毒态不可达；
  `check-panic-sites.mjs` 把这一形态列为允许。
- 测试模块里的 `panic!` / `unwrap`：测试块会被脚本剔除。

## 升级时怎么做

1. 重新 vendor 后先跑 `node scripts/check-panic-sites.mjs` —— vendor 生产块必须仍是 0 站点。
2. 按上表逐条对照 `// GOSSLAN PATCH`；上游若已自行修好（行为等价），删掉我们的分支并在此处记录。
3. 新增补丁必须：带 `// GOSSLAN PATCH (日期)` 注释、解释"哪种迟到回调会踩到"、并更新本表。
4. 跑 `cargo clippy --features bluetooth --all-targets -- -D warnings` 与 macOS 真机蓝牙冒烟：
   开关蓝牙、前后台切换、扫描中移除设备、合盖唤醒各 3 轮，确认 `*-crash.log` 没有新增
   `>>> panic`。
