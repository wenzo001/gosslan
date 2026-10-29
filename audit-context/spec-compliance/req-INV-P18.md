## REQ-INV-P18 — 私钥不得跨过 UI 边界

> "禁止：
> ```
> Rust private key
> → Tauri invoke result
> → JS
> ```
> 前端只能获得完成 UI 所需的公开信息或状态。
> - 钩子：`scripts/check-key-boundary.mjs` `guards:私钥边界：给 Identity 补一行 derive`
>   —— 判据 A 钉住"任何可序列化类型都不许带密钥字段"（命令返回值与 emit 载荷都要求 `Serialize`，
>   所以一条判据同时盖住两个出口）；判据 B 钉住"命令不许把密钥放在交出值的位置"，并要求
>   `generate_handler!` 里每条命令都能被扫到。⚠️ 残余：**两步搬运**（先 `let k = …to_bytes()`
>   再 `Ok(encode(k))`）文本判据抓不住，彻底封死要把 `Identity` 的私钥字段改成私有、
>   只暴露 `sign()` / `dh()`（登记为 B-1a 的后续项）。"
> — docs/protocol-invariants.md §18. Security Boundary / INV-P18, line 604

**Verdict:** partial · confidence: high

**What this demands of an implementation:** 私钥（长期身份的 x25519 / ed25519 私钥）不得以任何形式出现在 Tauri 命令返回值或事件载荷里 —— 也就是不得出现在任何可 `Serialize` 的类型里，也不得出现在命令体的"交出值位置"。

**Where enforcement lives:**

判据本体是一个脚本（两半）：

```js
// scripts/check-key-boundary.mjs:62-63（判据 A 的词表）
const KEY_NAME = /(^|_)(secret|secret_key|private_key|privkey|signing|seed|keypair|key_pair|sk)(_|$)/;
const KEY_TYPE = /\b(StaticSecret|EphemeralSecret|SharedSecret|SigningKey|KeyPair|Zeroizing)\b/;

// scripts/check-key-boundary.mjs:133-134（判据 B 的词表与交出位置）
const KEY_IDENT = /\b(x25519_secret|ed25519_signing|secret_key|private_key|signing_key|StaticSecret|EphemeralSecret|SigningKey|keypair|\.secret)\b/;
const OUTBOUND = /(return\b|\bOk\s*\(|\bemit\b|\.emit(?:_filter)?\s*\(|\.to\s*\()/;
```

判据 A 扫所有 `derive(... Serialize ...)` 的类型字段（`:105-135`）；判据 B 扫所有 `#[tauri::command]` 函数体里"会把值交出去的那些语句"（`:137-165`），并与 `lib.rs` 的 `generate_handler!` 注册表**逐条对账**（`:167-179`、`:183-210`）。

被测对象本身：

```rust
// src-tauri/src/crypto.rs:19-23
/// 节点身份：X25519 私钥（ECDH）+ Ed25519 私钥（签名）。
pub struct Identity {
    pub x25519_secret: StaticSecret,
    pub ed25519_signing: SigningKey,
}
```

`Identity` **没有** `#[derive(Serialize)]` ⇒ 序列化不到 JSON ⇒ 到不了前端。这正是判据 A 保护的不变量。实测 `node scripts/check-key-boundary.mjs` 输出：`✓ 私钥边界：96 个可序列化类型无密钥字段（判据 A） · 169 条命令体无密钥触碰且与注册表逐条对上（判据 B）`。

- What it checks, and against what：判据 A 对**任何** derive 了 `Serialize` 的类型，字段名命中 `secret|private_key|signing|seed|keypair|sk`（整词/下划线边界）或字段类型命中 `StaticSecret|SigningKey|…` ⇒ 红。判据 B 对**任何** `#[tauri::command]` 函数体，把函数体按 `;` 切句，句子里同时出现"交出动作"（`return` / `Ok(` / `emit` / `.to(`）与"密钥标识符" ⇒ 红。
- Which paths reach it, and which do not：覆盖 96 个可序列化类型 + 169 个命令函数体；注册表对账保证"注册了但没扫到"也是红。

**Paths walked:**
- `commands/chat.rs::send_message` → 体内局部读 `state.identity.x25519_secret` 做 ECDH，返回密文：判据 B 判绿（局部使用不是交出）✓ —— 这一条有反例夹具证明（`scripts/check-key-boundary.mjs:225-233` 的"反例：命令内部用私钥做 ECDH，只返回密文"）。
- `crypto.rs::Identity::x25519_secret_b64` / `ed25519_secret_b64`（`:48-54`）：这两个方法**把私钥编码成 base64 返回**。它们**不是** `#[tauri::command]`，也不在任何 `Serialize` 类型里 ⇒ 判据 A/B 都看不见。这是判据 B 的**已知残余**（脚本注释 `:145-152` 自己写着"两步搬运文本判据抓不住"），但这里比"两步搬运"更直接：**方法本身就是一把钥匙导出器**。
- 任何命令若写成 `Ok(STANDARD.encode(id.x25519_secret.to_bytes()))` ⇒ 判据 B 红（`Ok(` 与 `x25519_secret` 同行同句）。夹具 `scripts/check-key-boundary.mjs:212-220` 证明这一半抓得住。

**Paths walked (continued) — 谁在调用那两个导出方法:**
- `grep -rn "x25519_secret_b64\|ed25519_secret_b64" src-tauri/src/` → 命中 `crypto.rs:48/52`（定义）、`state.rs` 持久化路径（写进 `settings` 表，非 UI 出口）、以及 `db` 层的密钥备份/恢复路径。**没有** `#[tauri::command]` 直接返回它。
- 但 `Identity` 的私钥字段是 `pub` ⇒ 任何命令体都可以 `state.identity.x25519_secret.to_bytes()` 再返回；判据 B 只能抓住"同一语句里同时出现交出与密钥标识符"的写法。

**Searched:**
- `private_key` / `secret_key` → 命中仅在 `scripts/check-key-boundary.mjs` 的词表定义里（`:62`、`:134`），生产码 0 处
- `x25519_secret` / `ed25519_signing` → 生产码命中集中在 `crypto.rs`（定义与 `sign_b64`/`x25519_public`）、`state.rs`（持久化）。**`commands/` 与 `network/` 下 0 命中**（`grep -rn "x25519_secret\|ed25519_signing" src-tauri/src/commands/ src-tauri/src/network/ --include="*.rs"` ⇒ 0 行）
- `Serialize` + `Identity` → `Identity` 无 `Serialize` derive（`crypto.rs:20` 无 derive 行）
- `derive(.*Serialize` → 全仓大量命中（96 个类型被扫），无一带密钥字段
- `EphKeypair` → 脚本头注释（`scripts/check-key-boundary.mjs:12`）点名它同样没有 `Serialize`
- `两步搬运` / `to_bytes()` + `encode` → `crypto.rs:49/53`（`x25519_secret_b64` / `ed25519_secret_b64`）是唯一一处把私钥字节转成可传字符串的地方；这两处是**导出器**，判据看不见它们，因为它们不 `return` 到命令出口。
- `sign(` / `dh(` → `crypto.rs` 提供 `sign_b64`（`:69`）与 `shared_secret`（`:75`），**没有**暴露 `dh()` 命名 ⇒ 文档建议的"改成私有字段 + 只暴露 sign()/dh()"这一步**尚未做**（字段仍是 `pub`）。

**Hook verification:**
- `scripts/check-key-boundary.mjs` — **存在**（336 行）。**已接进门禁**：`scripts/verify.mjs:282` 有 `"name": "私钥边界守卫"` 条目 ⇒ 脚本的 `resolveHook` 的"wired"检查（`scripts/check-invariant-hooks.mjs:120-122`，要求 `verify.mjs` 或 `package.json` 里能搜到文件名）通过 ✓。实测 `node scripts/check-key-boundary.mjs` 退出码 0。
- `guards:私钥边界：给 Identity 补一行 derive` — **存在**：`scripts/guard_cases/desktop_misc.py:472-492`。注入 `#[derive(Clone, Debug, serde::Serialize)]` 到 `pub struct Identity {`，跑 `node scripts/check-key-boundary.mjs`，期望失败信息含"可序列化类型 Identity 带密钥字段"。实测该 name 命中 1 次 ✓

**How the verdict was reached:** 不是 `implemented`：文档自己在同一条里标了"⚠️ 残余：两步搬运抓不住，彻底封死要把 `Identity` 的私钥字段改成私有"，而代码里这个残余**比文档描述的更宽** —— `Identity` 的两个私钥字段仍是 `pub`（`crypto.rs:21-22`），且 `x25519_secret_b64()` / `ed25519_secret_b64()`（`crypto.rs:48-54`）是两条现成的私钥导出器，判据 A/B 都看不见它们（它们不是 `Serialize` 类型、不是命令）。文档点名的补救动作（"把 `Identity` 的私钥字段改成私有、只暴露 `sign()` / `dh()`"）在代码里**没有发生**：字段仍是 `pub`，没有 `dh()` 这一名字。也正因如此，`x25519_secret_b64` 这个导出器是可以被任何命令调用的 —— 今天没有命令调它，但那是"没人写"而不是"写不了"。不是 `absent`：判据 A 与 B 真实存在、已接进门禁、覆盖 96 个可序列化类型与 169 条命令体、且有变异注入用例证明两半都抓得住、覆盖面与 `generate_handler!` 注册表逐条对账。定为 `partial`：当前状态下私钥**确实**没有跨过 UI 边界（实测 169 条命令体 0 处触碰），但封死是靠"没人写那一行"而不是靠构造。

**Open questions:**
- `x25519_secret_b64()` / `ed25519_secret_b64()` 是否应该被搬进一个只有持久化路径能用的模块（现在是 `crypto` 的 `pub` 方法，任何模块都能调）？
- 文档说的 B-1a 后续项在 `docs/stability-roadmap.md` 里的登记状态是什么？本条判据是否已被有意接受为"构造上够用 + 构造缺口单独登记"？
- `EphKeypair`（`transport/relay_seal.rs`）当前是否仍无 `Serialize`？判据 A 已覆盖它，但需要确认它在判据的扫描面内（`scripts/check-key-boundary.mjs` 扫全 `src-tauri/src`）—— 实测扫描面是全目录，命中。
