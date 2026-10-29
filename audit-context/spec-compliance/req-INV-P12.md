## REQ-INV-P12 — Device Identity Persistence

> "重启不能随机产生新身份。
>
> 身份数据：
>
> ```text
> device_id
> identity private key
> identity public key
> ```
>
> 必须保持一致，除非用户显式重置身份。"
> — docs/protocol-invariants.md §INV-P12, line 435-445

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 三样身份数据（`device_id`、X25519 私钥、Ed25519 私钥/公钥）必须**持久化**并在重启后**逐字节一致**；只有用户显式重置身份才能换。派生规则必须是"**只认持久化值**"，绝不能每次启动重算。

**Where enforcement lives:**

1) **两条私钥的持久化与加载**：

```rust
// src-tauri/src/state.rs:1689-L1721
/// 加载持久化身份；**只在空库首次安装时**生成一次。
/// 返回 `(identity, generated)`：`generated=false` 表示来自已存密钥。
/// 任何"看起来像损坏/读失败"的形状都返回错误，绝不落新密钥。
fn load_or_create_identity(conn: &Connection, existing_install: bool) -> Result<(Identity, bool), StartupError> {
    let xs = db::get_setting_checked(conn, "x25519_secret").map_err(|source| StartupError::IdentityRead { source })?;
    let es = db::get_setting_checked(conn, "ed25519_secret").map_err(|source| StartupError::IdentityRead { source })?;
    match (xs, es) {
        (Some(xs), Some(es)) => Identity::from_secrets(&xs, &es).map(|id| (id, false)).ok_or(StartupError::IdentityCorrupt),
        (None, None) if !existing_install => { let id = Identity::generate(); persist_identity(conn, &id)?; Ok((id, true)) }
        (None, None) => Err(StartupError::IdentityIncomplete { detail: "两条私钥都不存在（库中已有业务数据，拒绝按首次安装处理）".to_string() }),
        (x, e) => Err(StartupError::IdentityIncomplete { detail: format!("只有一条私钥存在（x25519={}, ed25519={}）——部分写入或损坏", x.is_some(), e.is_some()) }),
    }
}
```
⇒ **四条分支**：都有 → 加载；都没有且是空库 → 生成一次；都没有但库里有业务数据 → **拒启**（不生成）；只有一条 → **拒启**（不补另一条、不覆盖）。

2) **两条私钥同事务写入**：

```rust
// src-tauri/src/state.rs:1723-L1736
/// 两条私钥的写入必须在**同一事务**里：否则中途失败会留下"只有一条"的形状，
/// 下次启动会被判成损坏（比现在更糟的是用它去覆盖另一条）。
fn persist_identity(conn: &Connection, id: &Identity) -> Result<(), StartupError> {
    let tx = conn.unchecked_transaction().map_err(...)?;
    db::set_setting(&tx, "x25519_secret", &id.x25519_secret_b64()).map_err(...)?;
    db::set_setting(&tx, "ed25519_secret", &id.ed25519_secret_b64()).map_err(...)?;
    tx.commit().map_err(...)?;
    Ok(())
}
```

3) **`device_id` 的持久化与"只认持久化值"**：

```rust
// src-tauri/src/state.rs:2017-L2032
Ok(None) if !existing_install => {
    let fresh = generate_device_id(&collect_device_attrs());
    if let Err(source) = db::set_setting(&conn, "device_id", &fresh) {
        logger.error("identity", format!("code=DEVICE_ID_PERSIST_FAILED err={source} —— 停止启动，避免每次启动换身份"));
        crate::logging::crash_note(&format!("code=DEVICE_ID_PERSIST_FAILED 设备标识写入失败，停止启动：{source}（未生成新身份/标识）"));
        return Err(Box::new(StartupError::DeviceIdPersist { source }));
    }
    fresh
}
```
（`Ok(Some(stored))` 分支即"只认持久化值"，`:2014`。）派生函数 `generate_device_id`（`device.rs:104-L127`）**只在首次安装**被调；其注释 `device.rs:19-L20` 明写"稳定性由'只认持久化值'保证：只在第一次启动生成一次，此后绝不重新派生 —— 换网卡、开随机 MAC、升级系统都不会悄悄改掉身份"。

4) **公钥是私钥的函数，不是独立持久化的**：`Identity::x25519_public_b64`（`crypto.rs:56-L58`）/ `ed25519_public_b64`（`:60-L62`）从私钥现算 ⇒ 公钥必然与私钥一致，不存在"公钥单独漂移"。

5) **失败即中止启动，绝不用新身份覆盖**：`state.rs:2132-L2145` —— `load_or_create_identity` 返 Err ⇒ 记 `code=<StartupError::code()>` + `crash_note` + `return Err(...)` ⇒ 进程不启动。

6) **"库里有业务数据" 的判据**：`looks_like_existing_install(messages, friends, conversations, groups)`（`state.rs:1858-L1859`），数据源是 `db::boot_data_counts`（`state.rs:1841`）—— **只看真实业务行数**，不看"文件非空"。

7) **迁移链保留身份**：`db.rs` 的迁移链从不删 `settings` 表的行；`migration_tests::migration_preserves_identity_data` 钉住。

**Paths walked:**
- 首次安装（空库）→ 生成两把私钥 + 一个 `device_id` → 同事务写入 `settings` ✓
- 正常重启 → `load_or_create_identity` 走 `(Some, Some)` 分支 → `Identity::from_secrets` 还原 ⇒ **逐字节一致** ✓
- 正常重启（库里有业务数据、无 `device_id`）→ `Ok(None)` 分支（不是 `!existing_install`）⇒ 走 `Ok(None) => { ... }` 的另一分支（`state.rs:2034` 一带，报错/迁移），**不生成** ✓
- `device_id` 缺失但业务数据为空 → `!existing_install` ⇒ 生成一次并写库；写失败 ⇒ **中止启动** ✓
- 只有一条私钥（部分写入/损坏）→ `IdentityIncomplete` ⇒ **中止启动**，不覆盖残留的那条 ✓（钩子 `existing_install_never_regenerates_missing_or_partial_keys`）
- 两条私钥是坏 base64 → `Identity::from_secrets` 返 None ⇒ `IdentityCorrupt` ⇒ **中止启动**，保留原值 ✓（钩子 `corrupt_keys_abort_without_overwriting_them`）
- `settings` 表读不出来（表不存在）→ `get_setting_checked` 返 Err ⇒ `IdentityRead` ⇒ **中止启动**，**不**当成"键不存在 ⇒ 生成新身份" ✓（钩子 `read_failure_is_not_mistaken_for_a_first_install`）
- 写库失败（trigger 阻断）→ `persist_identity` 返 Err ⇒ 中止启动，**不留半套密钥** ✓（钩子 `persist_failure_aborts_instead_of_running_with_an_ephemeral_identity`）
- 身份加载失败 ⇒ 数据库文件**逐字节不变** ✓（钩子 `identity_failure_leaves_the_database_file_byte_for_byte_unchanged`）
- 换网卡 / 开随机 MAC / 升级系统 ⇒ `device_id` 不变（只认持久化值）✓
- 用户显式重置身份 → spec 允许的例外。代码里 `commands/settings.rs:380` 的 `reset_settings` **保留** `device_id`、两条私钥、好友列表、聊天记录（只重置偏好设置）⇒ **没有"重置身份"的入口** ⇒ 例外路径实际上不存在（更保守，不违反 spec）。

**Searched:**
- `x25519_secret` → 命中：`state.rs:1697`（读）、`:1729`（写）、`crypto.rs:48`（`x25519_secret_b64`）、`db/settings.rs:181-L198`（测试）、`db/migration_tests.rs:222`/`:251`/`:2030`（迁移测试）
- `ed25519_secret` → 命中：`state.rs:1699`、`:1731`
- `device_id` 设置键 → 命中：`state.rs:2022`（`db::set_setting(&conn, "device_id", &fresh)`）、`:2014`（只认持久化值）、`state.rs:3121`/`:3149`（测试）
- `generate_device_id(` → 2 hits：`device.rs:104`（定义）、`state.rs:2021`（**唯一**生产调用点，在 `!existing_install` 分支内）
- `Identity::generate()` → 2 hits：`crypto.rs:27`（定义）、`state.rs:1706`（**唯一**生产调用点，在 `(None, None) if !existing_install` 分支内）
- `Identity::from_secrets(` → 2 hits：`crypto.rs:37`（定义）、`state.rs:1702`（**唯一**生产调用点）
- `random` / `OsRng` 与身份派生相关 → `device.rs:106`（`rand_core::OsRng.fill_bytes(&mut nonce)`，仅在首次安装路径）、`crypto.rs:28-L29`（`Identity::generate`，仅在首次安装路径）
- 每次启动重新派生 device_id 的形态 → **0 hits**
- `recover_orphan_sending_messages` 触及 `settings` → 0 hits（它只改 `messages.status`）
- 迁移链里删 `settings` 行的语句 → **0 hits**（`db.rs` 的 `MIGRATIONS` 只做加列/加表/加索引）
- `clear_all_data` → `commands/favorites.rs:526` 一带；**需要确认它是否删身份**（见 Open questions）

**Hook verification:**
- `db::migration_tests::migration_preserves_identity_data` → `src-tauri/src/db/migration_tests.rs:200`；两平台基线在册 ✓（造一个含 `device_id` + 两条私钥的旧库 → `init` → 三者都还在）
- `mesh::manager::tests::forget_identity_clears_keys_but_keeps_the_connection` → `src-tauri/src/mesh/manager.rs:378`；两平台基线在册 ✓ —— **注意它判的是「对端身份绑定」（`PeerManager` 里的 peer identity），不是本机身份持久化**；`PeerManager::forget_identity` 清的是内存里某个 peer 的公钥绑定（`mesh/manager.rs:392`），与"本机重启后身份不变"是不同的事
- `db::tests::friend_add_and_pubkey_persistence` → `src-tauri/src/db/favorites_tests.rs:147`；两平台基线在册 ✓ —— 判的是**好友公钥**的持久化，不是本机身份
- 真正覆盖本机身份持久性的在册用例（spec 未点名）：
  - `state::tests::first_install_generates_identity_once_and_later_loads_the_same_keys`（`state.rs:2998`）—— 断言两次加载拿回**同一套**密钥
  - `state::tests::existing_install_never_regenerates_missing_or_partial_keys`（`state.rs:3016`）
  - `state::tests::corrupt_keys_abort_without_overwriting_them`（`state.rs:3043`）
  - `state::tests::read_failure_is_not_mistaken_for_a_first_install`（`state.rs:3065`）
  - `state::tests::persist_failure_aborts_instead_of_running_with_an_ephemeral_identity`（`state.rs:3082`）
  - `state::tests::identity_failure_leaves_the_database_file_byte_for_byte_unchanged`（`state.rs:3107`）
  - `device::tests::generated_id_keeps_the_one_prefix_and_length`（`device.rs:153`）、`device::tests::identical_attributes_still_produce_different_ids`（`:185`）、`device::tests::strip_legacy_dev_prefix_is_stripped_exactly_once`（`:220`）

**How the verdict was reached:** 三样身份数据各有确凿的持久化与"只认持久化值"的执行点（`state.rs:1693-L1721` 与 `:2017-L2032`），且失败路径一律**中止启动**而不是"生成新的凑合用"。代码比 spec 更强的地方（缺一条私钥 ⇒ 拒启而不是补一条；读失败 ⇒ 拒启而不是当成"没有"）是 spec 的 "不能随机产生新身份" 的自然推论，不构成 spec 之外的额外要求。所以判 `implemented`。

**Open questions:**
- **spec 点的两条钩子都不是本机身份持久化**：`mesh::manager::tests::forget_identity_clears_keys_but_keeps_the_connection` 判的是**对端** peer 身份绑定（`PeerManager::forget_identity`），`db::tests::friend_add_and_pubkey_persistence` 判的是**好友**公钥持久化。本机身份持久化的真正判据是 `state::tests::*` 那六条（在册，**未被 spec 点名**）。**需要确认 spec 的钩子清单是否指错了对象。**
- **spec 的"除非用户显式重置身份"这条例外在代码里没有对应入口**：`commands/settings.rs:380` 的 `reset_settings` 明确**保留** `device_id` / `x25519_secret` / `ed25519_secret` / 好友列表 / 聊天记录。⇒ 代码比 spec 更保守（没有"重置身份"这个动作）。**需要确认这是有意为之（没有重置入口）还是缺一个功能。**
- **`clear_all_data`（`commands/favorites.rs:526` 一带，"全量删除 DB + 目录"）是否删身份数据需要确认** —— 若它删掉 `settings` 里的身份行，那下次启动就会走"空库 ⇒ 生成新身份"路径 ⇒ 等价于一次隐式的"重置身份"。**需要读该命令的实现确认它是否排除 `settings` 的身份行。**
- `state.rs` 里 `AppState` 的 `pub app: AppHandle` 是具体 `AppHandle<Wry>`（`:1060-L1061`），且 `AppState::init` 是唯一构造器（`:1753`）—— 这与 spec line 93 的说法一致，但 spec 引用的行号（`state.rs:873-874` / `:1173`）与今天不符（见 INV-P03 的 Open questions）。另外 spec 说"`Cargo.toml` 里没有 `[dev-dependencies]`"也**已过期**（`src-tauri/Cargo.toml:194-L196` 现在有 `tempfile`）。
