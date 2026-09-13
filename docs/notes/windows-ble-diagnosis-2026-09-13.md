# Windows ↔ Android 蓝牙互搜不到：真机诊断（2026-09-13）

- 现象（用户）：「我用之前 2.19 版本在 Mac 平台上打的安卓包，可以搜得到吗？现在我用你这个
  Windows 打的 Windows 包，和我之前的安卓包，蓝牙互相搜不到。就是你搜不到我，我也搜不到你。」
- 环境：Windows 包 = `Gosslan_4.2.19_x64-setup.exe`（本轮 73c9c43 构建，含 BLE central）；
  安卓包 = 用户在 Mac 上用「2.19 版本」打的（**分支/是否含 BLE 待确认**）
- 证据来源：`%APPDATA%\com.gosslan.app\logs\gosslan.log`（16:19–16:23 那一轮）
  + `gosslan.db`（settings / friends / messages）
- 方法：读真机日志 + 读 btleplug 0.13 `winrtble` 源码 + 读本仓库 BLE 接线

---

## 1. 先把「搜不到」纠正为事实

日志（每 13 秒一轮，共 59 行）：

```
[ble] BLE 扫描：收到 10 个广播，其中 1 个是本应用服务
[ble] [DISCOVERY] 候选可拨 id=50:A6:D8:AE:B2:69 ⇒ 开始连接（GATT central）
[ble] [DISCONNECT] 候选 50:A6:D8:AE:B2:69 未建立链路：连接失败：Not connected（已进入退避）
```

结论：**Windows 侧搜到了**（每轮 10~15 个广播，其中 **1 个就是本应用服务**），
也认出了那个对端 `50:A6:D8:AE:B2:69`。真正的失败是**发起 GATT 连接后立刻 `Not connected`**。

`gosslan.db` 佐证「从未连上过」：`friends` 0 条、`messages` 0 条、`conversations` 空
（`settings`：`bt_enabled=1`、`lan_enabled=0`、`device_id=gosslan-718562a258f7cf55`）。

所以「你搜不到我，我也搜不到你」实际上是**两个不同的问题**：

| # | 方向 | 真实现象 | 原因 |
|---|---|---|---|
| ① | Windows → 手机 | **搜得到，连不上**（`Not connected` 反复出现） | Windows 的 BLE 连接时序缺陷（见 §2） |
| ② | 手机 → Windows | **根本不可能搜到** | Windows 没有外设角色，**从不广播**（见 §3） |

## 2. 问题①：Windows 上 `connect()` 与 `discover_services()` 之间没有重试（旧代码就有的缺陷）

本仓库 `src-tauri/src/transport/bluetooth.rs::driver::connect`：

```rust
peripheral.connect().await.map_err(|e| format!("连接失败：{e}"))?;   // 这里就是 "Not connected"
peripheral.discover_services().await.map_err(|e| format!("发现 GATT 服务失败：{e}"))?;
```

btleplug 0.13 在 **Windows** 上的 `connect()` 实现（`winrtble/peripheral.rs:488`）是：

```rust
let device = BLEDevice::new(...).await?;
device.connect().await?;                    // 见下
```

而 `BLEDevice::connect()`（`winrtble/ble/device.rs:112`）：

```rust
pub async fn connect(&self) -> Result<()> {
    if self.is_connected().await? { return Ok(()); }
    let service_result = self.get_gatt_services(BluetoothCacheMode::Uncached).await?;
    let status = service_result.Status().map_err(|_| Error::DeviceNotFound)?;
    utils::to_error(status)          // GattCommunicationStatus::Unreachable → Error::NotConnected
}
```

也就是说：**Windows 上「连接」本身就是一次 `GetGattServicesAsync(Uncached)`**，
而 btleplug **一处重试都没有**。BLE 链路建立后到能读服务之间有延迟（几百 ms~数秒），
这个窗口里 WinRT 返回 `Unreachable`，btleplug 原样翻成 `NotConnected`。

日志形态完全吻合：`开始连接` → **2~3 秒后** `Not connected` → 退避 → 13 秒后又来一次，
从未出现过握手阶段的日志（`[SESSION]` / `对端首帧不是 Hello`）。

> 注意这不代表安卓/手机有问题 —— 是**Windows 这套 BLE 栈要求"连上之后再等一等"**，
> 而代码在 macOS/Android 上恰好不需要等，所以这个缺陷只在 Windows 现形。

## 3. 问题②：Windows 不能广播、不能被连（本轮只做 central 的直接后果）

`network/ble.rs` 里外设角色（GATT server）只在 macOS / Android 编译
（见 `docs/adr/0015-ble-transport.md` §7.9），而 `btleplug` **只做 central**（ADR-0015 §3.1）。

因此：

- Windows **不广播** ⇒ 手机扫描里永远没有 Windows（这正是「你搜不到我」）；
- Windows **不能接受入站连接** ⇒ 就算手机想办法拨过来也会失败；
- 叠加「大 id 拨、小 id 只接受」这条镜像护栏：Windows 的 `device_id` 是
  `gosslan-718562a258f7cf55`（`7` 很靠前，**大概率比手机 id 小**），
  规则判定「该由对端拨我」—— 而对端根本发现不了我 ⇒ **两侧都在等对方**。

我此前把它拆成「先 central、peripheral 下一轮」并认为「Windows ↔ 手机这条是通的」，
**那个判断错了**：它只在「手机 id 更小、由 Windows 主动拨」时才成立。
用户选的两步走方案无法覆盖"对方 id 更大"这一半，必须把外设角色做完。

## 4. 修法（三件，缺一不可）

1. **Windows 外设角色**：用 `windows` crate 的 WinRT `GattServiceProvider` 实现
   `transport/bluetooth_peripheral.rs` 的 Windows 版（与 macOS/Android **同形接口**：
   `start` / `PeripheralServer` / `PeripheralWriter` / `PeripheralEvent`），
   `network/ble.rs` 只需把平台门加上 `windows`，事件循环/握手/路由**零改动**。
   已核实 `windows-0.62.2`（btleplug 已依赖，**不必新增第三方 crate**）具备所需全部 API：
   `GattServiceProvider::CreateAsync` / `StartAdvertisingWithParameters` /
   `GattLocalCharacteristic::CreateCharacteristicAsync` / `WriteRequested` /
   `SubscribedClients` / `NotifyValueForSubscribedClientAsync`。
2. **连接重试**：在 `driver::connect()` 里加"连上后轮询 `is_connected()` + 重试
   `discover_services()`"的有界重试（Windows 必须；对 macOS/Android 只是更稳）。
3. **同源验证**：两侧用**同一分支**的包（当前 `next` @ 含本修复）。
   本机没有 JDK / Android SDK / android target，**打不了安卓包** —— 需要用户在 Mac 上
   用 `scripts/build-android-releases.sh`（已带 `--features bluetooth`）重打一个。

## 5. 复测判据

```
前置：两端都是 next 分支的包；关 Wi-Fi（lan_enabled=0）；只开蓝牙；两端各清一次数据
Windows 日志：%APPDATA%\com.gosslan.app\logs\gosslan.log
Android 日志：adb logcat -s gosslan:I
期望轨迹（两个方向都要能走通）：
  Windows: [DISCOVERY] 候选可拨 …（或 [SESSION] 已就绪（外设侧）…）
  Windows: [GATT] 已就绪 → [SESSION] 已就绪 peer=… → [SEND]/[RECV] → [ACK]
  Android: 蓝牙外设角色已启动（Android 广播中，等待对端连入）→ [SESSION] 已就绪（外设侧）…
失败排查顺序：
  1) Windows 一条 [DISCOVERY]/[GATT] 都没有 ⇒ 蓝牙开关/适配器/ACL 问题
  2) 有 [DISCOVERY] 但一直 Not connected ⇒ 重试逻辑没生效或对端 GATT server 未注册
  3) 手机侧有「GATT 服务注册失败（status=…）」⇒ 权限（ADVERTISE）或系统问题
```
