# 运行档位（插电 / 电池 / 锁屏 三级节奏）

> 一句话：**插电全速跑，电池降一档，锁屏只留保活与收包**。
> 入口 `src-tauri/src/runtime_profile.rs`（档位与节拍器）与 `src-tauri/src/power/`（探针）。

## 1. 为什么做

长期挂机的桌面端有两个真实抱怨：笔记本电池掉得快、机器温热。而这两件事的元凶不是
消息收发本身，是**在没人看的时候仍然全速做的那些事**：局域网广播、BLE 扫描、打洞会合、
心跳、outbox 对账。

关键判断：这些循环的价值**高度依赖"用户是否在机器前"**，而这个信息以前没人用。
仓库里已有的两处自适应（`discovery` 的按节点数调周期、`ble` 的按前后台调扫描）说明
"降频"这件事本身不新 —— 缺的是**判据**。

## 2. 三个档位

| 档位 | 判据 | 含义 |
|---|---|---|
| `active` | 插电 + 前台 + 未锁屏 | 完全维持现状 |
| `saver` | 电池（或窗口在后台） | 周期 ×3 |
| `dormant` | 锁屏 | 主动行为近似停，只留保活与收包 |

判据合成是**纯函数**（`compose`），优先级为：锁屏 > 前台+插电 > 其余。

⚠️ 锁屏必须优先判：锁屏时窗口在多数平台**仍然是"前台"**，若让 `app_active` 先判，
锁屏会被当成 active —— 而"人不在跟前"恰恰是最该省电的时刻。

## 3. 倍数表（唯一事实来源）

`multiplier(kind, profile)`。任何循环**都不许**自己写死倍数，否则同一个档位下
"降一档"的含义会分叉。

| 节拍类 | active | saver | dormant | 消费者 |
|---|---|---|---|---|
| `Keepalive` | 1× | 3× | 12× | 心跳（5s → 15s → 60s） |
| `Proactive` | 1× | 3× | 60× | 局域网广播、BLE 扫描、打洞会合 |
| `Delivery` | 1× | **1×** | 20× | outbox 对账 / ACK 重放（30s → 30s → 600s） |

`Delivery` 单独一档的理由：它是"消息发出去了没有"的唯一收敛出口。电池下把它 ×3
（30s→90s），用户会觉得"电池模式下发消息一直转圈"，省下的电远不值这个体感损失。
**电池供电不得拖慢送达**，只有锁屏才允许放慢。

同一张表也解释了"为什么锁屏不算完全冻结"：
- 心跳 60s 仍然在（断连能被发现）；
- `Delivery` 600s 仍然在（解锁后 `Cadence` 会立刻补一轮，见下）；
- TCP 连接不动、收包不停 ⇒ 对方发来的消息照收、照落库、照回 Ack。

## 4. 三件保证"用户无感知"的事

1. **只改"下一轮等多久"**：`Cadence` 决定某一轮做不做，不改任何协议语义。
2. **切换带防抖**：`ProfileGate` 要求目标档位稳定 3s 才生效（插拔电源、合盖再开
   都会在 1~2s 内抖出相反读数）。同向重复幂等、翻回已生效态即取消。
3. **恢复立刻补一次**：`set_profile` 抬一次代际（`generation`），各 `Cadence` 看见
   代际变化就立刻跑一轮 —— 解锁/插电后心跳、对账、广播马上到位，不用等一个被拉长的周期。
   对 `sleep_until` 型循环（局域网广播），`applied_notify()` 会把它从长睡里叫醒重算。

另外：**窗口焦点切换**直接调 `power::recompute_now`（焦点本身已有 2s 防抖），
不等 15s 采样周期 —— 否则用户切回前台要干等一轮才恢复全速。

## 5. 平台覆盖（如实）

| 平台 | 电源 | 锁屏 | 验证方式 |
|---|---|---|---|
| macOS | IOKit `IOPSGetProvidingPowerSourceType` | `CGSessionCopyCurrentDictionary` 的 `CGSSessionScreenIsLocked` | 本机实测（`cargo test --lib power`） |
| Windows | `GetSystemPowerStatus` | `WTSQuerySessionInformationW` 的 `SessionFlags` | 判定语义抽纯函数单测；FFI 由独立 scratch crate 交叉 `cargo check --target x86_64-pc-windows-msvc` + Windows CI 编译 |
| 其它桌面 | — | — | `other.rs` 一律返回"插电+未锁屏"⇒ 恒 active，行为与改造前完全一致 |
| 移动端 | — | — | 模块不编译；`spawn_power_profile` 返回永不完成的 future（看门狗看到"活着"，实际零开销） |

Windows 的两个坑（都已在代码里注释）：
- `WTS_SESSIONSTATE_LOCK = 0`、`UNLOCK = 1` —— **取值是反的**，不能拿 0 当"未设置"；
- `ACLineStatus = 255` 是"未知"（老机器/虚拟机常见），必须当作插电，否则会被莫名降档。

## 6. 采样与开销

`power::spawn_monitor` 是受监督的常驻 worker（名字 `power_profile`，见
`worker_supervisor::RESIDENT_WORKERS`）—— 它死了就再也没有降档，所以必须能被发现与拉起。

采样周期：非锁屏 15s、锁屏 60s。采样是几个只读系统调用（微秒级），不持任何业务锁、
不做 IO。锁屏后最长 15s 才降档，这段延迟换来的是"绝不在用户面前误降档"。

## 7. 怎么自查

```bash
# 档位逻辑与倍数的单测
cd src-tauri && cargo test --lib runtime_profile

# 探针在本机是否真的读到了（会打印 on_ac / locked）
cargo test --lib power::macos::tests::probe_runs_without_panic -- --nocapture
```

生产日志里切档只写一行：`code=PROFILE_SWITCH profile=saver on_ac=false locked=false app_active=true`
（`logger` 频道 `power`）。查"省电到底生效没"就看这一行有没有在预期时刻出现。

## 8. 已知边界

- **Linux 未接**：`/sys/class/power_supply` 的命名因厂商而异（`AC`/`ACAD`/`ADP1`…），
  "读不到"与"没插电"无法区分；锁屏要 D-Bus。接口已在 `other.rs` 定型，接的时候只换读数。
- **休眠不单独判**：休眠时进程被系统挂起，本来就不耗 CPU；唤醒后 tokio 定时器按
  `MissedTickBehavior::Delay` 收敛，不会补一堆 tick。真正需要感知的是锁屏。
- **Windows 锁屏走轮询而非会话通知**：`WTSRegisterSessionNotification` 要绑 `HWND` 生命周期，
  而本仓窗口会被 tauri 重建；对一个省电功能来说，可靠性优先于实时性。
