## REQ-INV-P23 — BLE 分片预算：常量与换算只有一个家

> "**输入语义可以不同，但常量与换算必须只有一份**：唯一定义点在
> `transport/ble_framing.rs`，由 `scripts/check-ble-constants.mjs` 守门（判据 A：六个规范名字
> 各有且仅有一处定义；判据 B：BLE 领域内不许用匿名常量重述受保护字面量）。
> 约束：
> ```
> 每片载荷 = min(该链路的载荷预算, GATT_MAX_ATTR_LEN = 512)
>     central 侧：  载荷预算 = 协商 MTU − ATT_HEADER_LEN(3)
>     peripheral 侧：载荷预算 = 对端声明的通知长度（**不再减** ATT 头）
> 非法/过小输入（装不下 6 字节分片头）→ 退回 DEFAULT_PAYLOAD_BUDGET(20)，**绝不返回 0**
> 单条消息         ≤ MAX_BLE_MESSAGE_BYTES (512 KiB)
> 单条消息的分片数 ≤ MAX_BLE_CHUNKS_PER_MESSAGE (8192)
> 同时进行的未完成消息 ≤ MAX_INFLIGHT_MESSAGES (8)
> 未完成消息 TTL    = PARTIAL_TTL_MS (30s)
> ```
> **两侧必须能互相推回去**（`both_sides_agree_on_the_same_link_budget`）：
> ```
> 协商 MTU m --att_payload_budget--> 载荷 b --告知对端--> notify_payload_budget(b) == b
> ```"
> — docs/protocol-invariants.md §23. BLE Fragmentation Budget / INV-P23, line 813

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** BLE 的四个受保护常量与两个换算函数在全仓只有一份定义；central 侧与 peripheral 侧的输入语义可以不同（前者是 MTU、要减 ATT 头；后者已是载荷、不减），但两侧对同一条链路必须推出同一个载荷；非法输入退回默认 20 且**绝不返回 0**；四个规模上限按文档的数值执行。

**Where enforcement lives:**

唯一定义点：

```rust
// src-tauri/src/transport/ble_framing.rs:99-135
pub const BLE_DEFAULT_MTU: u16 = 23;
pub const ATT_HEADER_LEN: usize = 3;
pub const GATT_MAX_ATTR_LEN: usize = 512;
pub const DEFAULT_PAYLOAD_BUDGET: usize = BLE_DEFAULT_MTU as usize - ATT_HEADER_LEN;

// src-tauri/src/transport/ble_framing.rs:133-141（central 侧）
pub fn att_payload_budget(negotiated: u16) -> usize {
    if (negotiated as usize) <= ATT_HEADER_LEN {
        return DEFAULT_PAYLOAD_BUDGET;
    }
    (negotiated as usize - ATT_HEADER_LEN).min(GATT_MAX_ATTR_LEN)
}

// src-tauri/src/transport/ble_framing.rs:153-161（peripheral 侧）
pub fn notify_payload_budget(max_update_value_length: usize) -> usize {
    let min = BLE_CHUNK_HEADER_LEN + 1; // 至少装得下"分片头 + 1 字节"
    if max_update_value_length < min {
        DEFAULT_PAYLOAD_BUDGET
    } else {
        max_update_value_length.min(GATT_MAX_ATTR_LEN)
    }
}
```

- What it checks, and against what：
  - `att_payload_budget` = `min(MTU - 3, 512)`，MTU ≤ 3（装不下 ATT 头）⇒ 退回 20 ⇒ **永不返回 0**（`min` 里 `512` 是上界，而 `MTU - 3` 在 `negotiated > 3` 时 ≥ 1；`negotiated <= 3` 走早退分支返回 20）。
  - `notify_payload_budget` = `min(声明长度, 512)`，声明长度 < 7（装不下 6 字节分片头 + 1）⇒ 退回 20 ⇒ **永不返回 0**。
  - **两侧不互相减**：peripheral 侧不减 ATT 头（`:153-161` 注释 `:139-142` 明写"这个值本身已经是 ATT 有效载荷"）；central 侧减（`:133-141`）。
  - 四个规模上限（`:167/:174/:180/:186`）：`MAX_BLE_MESSAGE_BYTES = 512 * 1024`、`MAX_BLE_CHUNKS_PER_MESSAGE = 8192`、`MAX_INFLIGHT_MESSAGES = 8`、`PARTIAL_TTL_MS = 30_000` —— 数值与文档一致。

守卫脚本（三个判据）：

```js
// scripts/check-ble-constants.mjs:164-186（判据 A：唯一具名定义点）
for (const [name, home] of Object.entries(CANONICAL)) {
  const found = [];
  for (const f of files) { ... definitionsOf(src, name) ... }
  if (found.length === 0) { ok = false; ... }
  else if (found.length > 1) { ok = false; ... }
  else if (found[0].rel !== home) { ok = false; ... }
}
```

```js
// scripts/check-ble-constants.mjs:264-296（判据 C：三个外设平台必须委托）
const PERIPHERALS = [
  "transport/bluetooth_peripheral.rs",
  "transport/bluetooth_peripheral_windows.rs",
  "transport/ble_android.rs",
];
const CANONICAL_CALLS = ["att_payload_budget(", "notify_payload_budget("];
```

实测 `node scripts/check-ble-constants.mjs` 输出：判据 A 六项全 ✓（`BLE_DEFAULT_MTU` / `ATT_HEADER_LEN` / `GATT_MAX_ATTR_LEN` / `DEFAULT_PAYLOAD_BUDGET` / `att_payload_budget` / `notify_payload_budget` 全部"唯一，位于 transport/ble_framing.rs"）；判据 B "BLE 领域的 51 个文件里没有匿名重述"；判据 C "3 个外设平台都已委托"。

**Paths walked:**
- central 侧 → `transport/bluetooth.rs:134-136` `payload_mtu(negotiated)` = `ble_framing::att_payload_budget(negotiated)` ⇒ 单一事实源 ✓。调用点 `network/ble/central.rs:470` `driver::payload_mtu(mtu)` 与 `:502` `writer.payload_mtu()`。
- peripheral macOS → `transport/bluetooth_peripheral.rs:97` `ble_framing::notify_payload_budget(max_update_value_length)` ✓
- peripheral Windows → `transport/bluetooth_peripheral_windows.rs:558` `ble_framing::att_payload_budget(max)` ✓（Windows 侧走 `att_payload_budget` 是因为它拿到的 `MaxNotificationSize` **含** ATT 头，见 `:544-546` 的对照表）
- peripheral Android → `transport/ble_android.rs:236` `ble_framing::notify_payload_budget(usize::try_from(raw).unwrap_or(0))` ⇒ **非法输入（0）退回默认 20**，不返回 0 ✓
- 分片切分 → `ble_framing.rs:196-224` `fragment(payload, mtu, msg_id)`：`mtu <= BLE_CHUNK_HEADER_LEN` ⇒ `None`（拒绝切分，不是切出坏片）；`count > MAX_BLE_CHUNKS_PER_MESSAGE` ⇒ `None`；`payload.len() > MAX_BLE_MESSAGE_BYTES` ⇒ `None` ⇒ 四个上限都真的执行 ✓
- 重组侧 → `BleReassembler`（`ble_framing.rs:235+`）按 `count` 惰性存 map（不按对端声明的 count 预分配），并有字节与条数上限

**Searched:**
- `GATT_MAX_ATTR_LEN` / `ATT_HEADER_LEN` / `BLE_DEFAULT_MTU` / `DEFAULT_PAYLOAD_BUDGET` → 判据 A 实测每个"唯一，位于 transport/ble_framing.rs"；生产代码引用点：`transport/bluetooth_peripheral.rs:97`、`transport/bluetooth_peripheral_windows.rs:558/676-712`、`transport/ble_android.rs:236`、`transport/bluetooth.rs:135`
- `att_payload_budget` / `notify_payload_budget` → 生产调用 4 处（上面四个平台）+ `ble_framing.rs` 内用例（`:422-458`、`:674-712`）。**没有第二个实现** ✓
- 匿名常量重述（`const X: usize = 512` / `= 20` / `= 23` / `= 3`）→ 判据 B 扫 51 个文件命中 0。人工复核：`transport/bluetooth_peripheral.rs`、`transport/bluetooth_peripheral_windows.rs`、`transport/ble_android.rs` 三册里都**没有**自己写的 `const DEFAULT = 20` / `const MAX = 512`（那是 2026-09-16 修掉的旧形状）。
- `MTU - 3` / `- ATT_HEADER_LEN` 散写 → 判据 B 覆盖（受保护字面量 3）。
- `payload_mtu` → 4 个定义（`transport/bluetooth.rs:134` central、`transport/bluetooth.rs:468`、`transport/bluetooth_peripheral.rs:204`、`transport/bluetooth_peripheral_windows.rs:551`、`transport/ble_android.rs:234`）—— 每个都只是**转调**规范换算，没有自己算 ✓
- `MAX_BLE_MESSAGE_BYTES` / `MAX_BLE_CHUNKS_PER_MESSAGE` / `MAX_INFLIGHT_MESSAGES` / `PARTIAL_TTL_MS` → 只在 `ble_framing.rs` 定义（`:167/:174/:180/:186`），数值与文档一致（512 KiB / 8192 / 8 / 30 000 ms）
- `check-ble-constants.mjs` 是否接进门禁 → `scripts/verify.mjs` 含该文件名 ⇒ 已接线 ✓

**Hook verification:**
- `scripts/check-ble-constants.mjs` — **存在**（306 行），**已接进门禁**，实测退出码 0 ✓
- `transport::ble_framing::tests::both_sides_agree_on_the_same_link_budget` — **存在**：`src-tauri/src/transport/ble_framing.rs:422`。断言 `notify_payload_budget(att_payload_budget(mtu)) == att_payload_budget(mtu)`，对 `mtu ∈ {23, 185, 517, 1024}` 四个值逐个验证 ✓（这一条正是"两侧必须能互相推回去"的机器形式）
- `transport::ble_framing::tests::notify_payload_budget_clamps_and_never_returns_zero` — **存在**：`ble_framing.rs:435`。四条断言：20 → 20、182 → 182、512 → 512、4096 → 512（收敛到 AOSP 上限）、`{0, 1, 6}` → `DEFAULT_PAYLOAD_BUDGET`（装不下分片头 ⇒ 退回默认而非返回 0）、`7` → 7（刚好装下头+1 算合法）✓
- 三条全部存在，且两条 Rust 用例在基线中登记 ⇒ 注册到本平台基线 ✓

**How the verdict was reached:** 文档点名的六个名字由 `scripts/check-ble-constants.mjs` 判据 A 逐个验证"唯一且在 `transport/ble_framing.rs`"（实测输出六项全 ✓），判据 B 扫 51 个 BLE 文件确认没有匿名重述，判据 C 确认三个外设平台都委托给规范换算。文档的换算公式逐字对上代码：`att_payload_budget` 减 3 且 `.min(512)`、`notify_payload_budget` **不减**、两者非法输入都退回 20 且都永不返回 0。四个规模上限数值与文档一致且在 `fragment` 与重组器里真的执行。两侧互推由 `both_sides_agree_on_the_same_link_budget` 直接钉住。定为 `implemented`：判据与实现都在，且判据覆盖了 2026-09-16 真实漏掉的三种绕过方式（重复定义常量 / 匿名重述 / 内联换算）。

**Open questions:**
- 判据 A 只认**名字**（`const NAME` / `fn NAME` 的定义点），因此"把 `att_payload_budget` 的体复制到一个新名字下再调用"不会被它抓住 —— 脚本自己在 `:301` 写着"已知边界：拦不住把换算内联成表达式，那类只能靠 review"。
- `transport/bluetooth.rs:468` 的另一个 `payload_mtu(&self)`（实例方法）与 `:134` 的静态 `payload_mtu(negotiated)` 同名不同签名；Windows 侧（`:551`）也有一个同名方法。判据 C 只查"这个文件里出现 `att_payload_budget(` 或 `notify_payload_budget(`"，不区分哪个入口 ⇒ 若某个 `payload_mtu` 变成自己算而另一个仍委托，这条判据不会红。
