# Android 签名：两把钥匙与 CI 配置（2026-10-21）

> 背景：CI 之前**每次构建都现生成一把 release keystore**（`scripts/android/keystore/` 在
> .gitignore 里，CI 上不存在 ⇒ 走"现生成"那条路）⇒ **每次跑出来的 APK 签名都不一样**
> ⇒ 用户覆盖安装必失败（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），已发出去的包也再也升不上。
> 现在把签名分成两把**固定**的钥匙，发行版进 GitHub Secrets（别人看不到），开发版入库（公开但固定）。

## 两把钥匙

| | 发行版（release） | 开发版（dev） |
|---|---|---|
| 位置 | **GitHub Actions Secrets**（`ANDROID_KEYSTORE_BASE64` 等 4 个）；本机留一份 `scripts/android/keystore/gosslan-release.keystore`（**不入库**） | **入库**：`scripts/android/keystore/gosslan-dev.keystore` |
| 谁能用 | 只有能改 Actions 的你；**含 fork 的 PR 也读不到** | 任何人（它是公开钥匙） |
| 用途 | 正式对外发版（tag 触发的 Release） | CI 的日常构建、开发者本地构建 |
| 凭据 | 你自己定（别用仓库里的默认值） | alias `gosslan` / 密码 `gosslan-dev`（**故意公开**） |

> ⚠️ **正式发版只能用发行版钥匙**：公开钥匙签的包，任何人都能伪造一个同签名的"升级包"
> 顶替你的应用（Android 只认签名、不认发布者）。CI 的发布 job 有守卫：
> 没有 `ANDROID_KEYSTORE_BASE64` 就**拒绝发布**（不是 warning）。

## 你要做的三步（一次性）

1. **准备发行版 keystore**（如果还没有，就用本机那份）：

   ```bash
   cd <仓库根>
   ls -l scripts/android/keystore/gosslan-release.keystore   # 不存在就见下一段
   ```

   没有就生成一把（**之后不要删**）：

   ```bash
   keytool -genkeypair -keystore scripts/android/keystore/gosslan-release.keystore \
     -alias gosslan -keyalg RSA -keysize 2048 -validity 10950 \
     -storepass '<你的发行版密码>' -keypass '<你的发行版密码>' \
     -dname "CN=Gosslan, O=Gosslan, C=CN"
   ```

2. **把它变成 base64**（一行，别换行）：

   ```bash
   base64 -i scripts/android/keystore/gosslan-release.keystore | tr -d '\n' > /tmp/gosslan-ks.b64
   wc -c /tmp/gosslan-ks.b64   # 记下这个大小，配 secret 时用得上
   ```

3. **在 GitHub 配 4 个 Secret**（仓库 → Settings → Secrets and variables → Actions → New repository secret）：

   | Secret 名 | 值 |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | 第 2 步那个 base64 全文（**单行**） |
   | `ANDROID_KEYSTORE_PASSWORD` | 你的 keystore 密码 |
   | `ANDROID_KEY_ALIAS` | `gosslan` |
   | `ANDROID_KEY_PASSWORD` | 你的 key 密码（与 store 相同就填同一个） |

   配完不用改代码：CI 的构建步骤已经读这 4 个变量（见 `.github/workflows/build-android.yml`）。

## CI 现在的行为

- **没配 secret**（日常 push）：用**入库的开发版钥匙** ⇒ 签名固定、可覆盖安装。
- **配了 secret**：用**发行版钥匙** ⇒ 签名固定、且别人看不到钥匙。
- **正式发版（tag → Release）**：**必须**有 `ANDROID_KEYSTORE_BASE64`，否则发布 job 直接失败
  （守卫在 `build-android.yml` 的「发行版签名守卫」那一步 + 脚本的 `--require-release-signing` 双保险）。

## 用户侧的一次性代价（重要）

**之前发的那些 APK 是用"每次现生成"的钥匙签的** ⇒ 它们之间签名互不相同。
所以从这一版起，用户要升级到新包时，手机上那份旧包**必须先卸载再装**
（否则报"安装包与已安装应用签名不一致"）。装上这一版之后，后续升级就都能直接覆盖安装了
（前提是这一版和以后都用**同一把发行版钥匙**）。

## 私钥保管

- 发行版 keystore = 应用身份，**丢了就没法再给已装用户推升级**（只能让他们卸载重装）。
- 建议：存一份在密码管理器或离线介质里；**不要**提交进仓库（现在 .gitignore 只放行 dev 那把）。
- `gosslan-dev.keystore` 是公开钥匙，**不要**用它发正式版。
