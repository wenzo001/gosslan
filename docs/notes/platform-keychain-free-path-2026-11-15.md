# 平台密钥库：免费路径与三平台成本表（2026-11-15）

> 状态：**Windows（DPAPI）与 Android（Keystore）已实现**（2026-11-15）；**macOS 暂缓**（等签名）。
> 本文给出三平台的真实成本、macOS 弹框的机制、免费证书的可复现步骤与迁移约束。
> 实现见 `src-tauri/src/rp_key_store.rs`（信封格式与编排）、`rp_key_store/dpapi.rs`、
> `rp_key_store/keystore_android.rs`（Kotlin 侧 `gen/android/.../KeyVault.kt`）。

## 1. 先纠正一句口径

上一轮我说「卡在开发者证书上」，说得不准。准确的说法是：

> **只有 macOS 一处需要签名，而且免费证书就够；Windows 与 Android 本来就不需要。**

需要付费的是 **Apple Developer Program（$99/年）**，它买的是**公证与分发**，
不是「Keychain 能不能用」。这两件事被混成一件了。

## 2. 三平台成本表

| 平台 | 密钥库 | 需要代码签名吗 | 零成本做法 | 付费才有的 |
|---|---|---|---|---|
| **macOS** | Keychain | **需要**（否则每次读都弹授权框） | **Apple Development 证书**（免费） | Developer ID + 公证 ⇒ 分发给别的 Mac |
| **Windows** | 凭据管理器（DPAPI） | **不需要** | 直接做 | EV/OV 证书只影响 SmartScreen 提示，与密钥保护无关 |
| **Android** | Android Keystore（TEE） | 不需要 | 直接做 | — |

「为什么 macOS 特殊」：Keychain 的访问控制是**按签名身份记的 designated requirement（DR）**，
不是按路径或按用户。签名身份稳定 ⇒ DR 稳定 ⇒ 后续版本自动放行；**身份不稳定或没签名 ⇒ 每次都弹框**。

- 已实测（2026-11-15，本机，未签名构建）：同一 Keychain 项，写入后**重编译再读会阻塞**
  （25 秒超时，`exit=124`）—— 卡在系统授权框上。
- 本应用有**开机自启**与**更新后自动重启** ⇒ 那两处没人点「允许」就是**卡死**，
  比现在「密钥在 0600 的本地库里」更糟。这是当时判断「不能上」的全部理由。
- 签名 ⇒ DR 稳定 ⇒ 不再弹框 ⇒ 这个理由消失。**这才是解法，不是等付费。**

## 3. macOS 免费路径（可复现步骤）

### 3.1 创建免费签名身份

1. 装 Xcode（App Store，免费）。
2. Xcode → Settings → Accounts → 登录一个**普通 Apple ID**（无需加入 Developer Program）。
3. Manage Certificates → 左下「+」→ **Apple Development**（免费，1 年有效，个人 Team ID 稳定）。
4. 证书自动装进系统钥匙串。

### 3.2 打包时用它签名

本仓已装 tauri-cli，`tauri build` 自己会签（不需要另写一步 `codesign`）：

```bash
# 方式一：环境变量（不改仓库配置）
APPLE_SIGNING_IDENTITY="Apple Development: <你的名字> (<TEAMID>)" \
  npm run tauri build -- --bundles dmg

# 方式二：配置文件（bundle > macOS > signingIdentity）
```

验签（应当看到 Authority 行，且不是 ad-hoc）：

```bash
codesign -dv --verbose=4 "src-tauri/target/release/bundle/macos/Gosslan.app" 2>&1 | head
```

### 3.3 必须知道的两个限制

| 限制 | 后果 | 绕法 |
|---|---|---|
| Apple Development 证书**不能公证** | 装到**别的** Mac 会被 Gatekeeper 拦 | 本机自用 / 内测可接受；分发给别人才需要付费 Program |
| Team ID 换 Apple ID 就变 | Keychain 项还在，但 ACL 不匹配 ⇒ 又弹一次框 | 用户点一次「始终允许」即可；换 ID 是罕见操作 |

### 3.4 如果不想碰签名，还有两条零成本路

| 方案 | 做法 | 安全性 | 代价 |
|---|---|---|---|
| **B. 维持现状 + 导出/恢复** | 不动存储层；上一轮已实现的**口令加密导出包**就是迁移路径 | 密钥在磁盘上，受用户账户权限保护 | 弱一档，但零风险零改动 |
| **C. 用户口令派生加密文件** | seed 用 Argon2id + 口令加密后落盘 | 强度取决于口令，不依赖系统 | 口令丢了就永久失绑（导出包已是这个模型的现成实现） |

**推荐**：先做 Windows + Android（零成本、零阻塞），macOS 走 A；
若暂时不想动签名，就选 B（保持现状，导出/恢复已能覆盖换机场景）。

## 4. 迁移的硬约束（无论选哪条）

1. **三步顺序**：写入新位置 → **用新位置签一次并验签成功** → 才删 SQLite 里的旧 seed。
   任何一步失败都停在旧位置，**绝不先删后写**。
2. **密钥库不可用时拒绝签名**，**绝不回落到明文**。
   （回落到明文 = 迁移失败变成静默降级，用户以为迁完了其实没迁。）
3. **迁移是一次性的、可重入的**：中途崩溃 ⇒ 下次启动识别到半迁移状态 ⇒ 继续或回退，**不能两条都有**。
4. 导出/恢复能力**必须已经可用**（已实现，5.30.0）—— 它是迁移失败时的兜底。
5. **不迁 P2P 身份密钥**：那是「你是你」的根，与 RP 绑定密钥不是一回事。

## 5. 三个平台各自要做什么

| 平台 | 后端 | 依赖 | 状态 |
|---|---|---|---|
| macOS | Keychain | `keyring`（apple-native） | **待做**：挂 macOS 目标段（跨平台纯逻辑会 E0433）；等签名身份 |
| Windows | 凭据管理器（DPAPI） | `windows-sys` 的 `Win32_Security_Cryptography`（**无新依赖**） | **已做**（`rp_key_store/dpapi.rs`） |
| Android | Android Keystore | `jni`（已在依赖树里）+ Kotlin 侧 `KeyVault.kt` | **已做**（`rp_key_store/keystore_android.rs`；真机验收 NOT RUN） |
| 跨平台 | **统一的存取抽象 + 纯逻辑** | — | **已做**（`rp_key_store.rs`：信封格式、封/开编排、升级顺序） |

### 5.1 落地形状（2026-11-15 已实现）

私钥**仍然只有一处**：`rp_device_bindings.secret_key` 那一列。有密钥库的系统上，那列写的是
**信封** `gsk1.<后端>.<base64url 载荷>`：

- **落库前封**（`insert_binding`）、**读库后开**（`get_binding` / `list_bindings_with_secrets`）；
- **不回落明文**：信封解不开 ⇒ 报错上抛（`ForeignBackend` / `Backend` / `Malformed` 三族）；
- **升级顺序**：旧格式（明文）行在第一次被读到时升级，顺序是「封 → 开回来逐字比对 → 才写回」；
- **导出仍是明文**：导出包自己用用户口令加密（换机要能迁移，而 DPAPI 绑机器、Keystore 绑设备）。

## 6. 待办与验收

- [x] 跨平台的存取抽象与迁移编排（纯逻辑，可单测，不碰平台 API）。
- [x] 接 Windows（DPAPI，`windows-sys`，**无新依赖**）。
- [ ] 接 macOS（需先建好免费签名身份）。
- [x] 接 Android（Kotlin 侧 `KeyVault.kt` + Rust 侧 JNI 桥；**真机验收 NOT RUN**）。
- 验收判据：
  1. 写入新位置 → 用新位置签名成功 → 旧 seed 被删，**三步顺序可被源码判据钉住**。
     ✅（升级写在 `db/device_auth.rs::upgrade_and_open`，顺序即代码顺序）
  2. 密钥库不可用时**拒绝签名**，错误可读，**不回落明文**。
     ✅（`rp_key_store::open_secret` 的三族错误；判据在 `rp_key_store/tests.rs`）
  3. 迁移中途崩溃后重启：要么完成、要么完整回退，**不出现两条并存**。
     ✅（写回前先逐字校验；崩溃时库里仍是旧值，下次启动重试）
  4. 导出/恢复在迁移前后都能用（兜底仍在）。
     ✅（导出走 `list_bindings_with_secrets` ⇒ 装的是明文，换机可恢复）
  5. 跨平台：同一份绑定在 macOS 导出 → Windows 恢复成功（格式与平台无关）。
     ⏳ **NOT RUN**（导出包格式与平台无关有源码判据，但跨机实跑未做）。

### 6.1 macOS 那一半还差什么

只剩「Keychain 后端」这一步：macOS 侧照 Windows 的形状加一个 `rp_key_store/keychain.rs`
（`security-framework` 已在依赖树里，可零新依赖），并把 `Backend` 加一个 `AppleKeychain` 变体。
**前置条件仍是签名身份**（见 §3）：没签名就读一次弹一次框 ⇒ 与开机自启/自动重启冲突。

## 7. 相关文件

- 导出/恢复设计稿（迁移的兜底与顺序约束）：[`rp-key-export-recovery-design-2026-11-15.md`](rp-key-export-recovery-design-2026-11-15.md)
- 活契约 §5（密钥保护）：[`external-auth-integration-contract-2026-11-14.md`](external-auth-integration-contract-2026-11-14.md)
- 签名就绪读数：`node scripts/sign-readiness.mjs`（本机现读，不抄本文）
