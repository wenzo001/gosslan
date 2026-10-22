# 自动更新（Tauri Updater + GitHub Releases）

> 方案：**Tauri 官方 updater 插件 + GitHub Releases 静态清单**。不建更新服务器、不买域名；
> 清单固定为 `https://github.com/wenzo001/gosslan/releases/latest/download/latest.json`。

## 1. 架构与平台范围

| 平台 | 分发渠道 | 应用内更新 | 状态 |
|---|---|---|---|
| Windows x64 / arm64 | GitHub Release（NSIS 基础档） | 官方 updater（NSIS） | 已接通/已配置；**真实安装重启未验** |
| Windows（内置 WebView2 档） | GitHub Release | 不进入更新清单 | 手动更新；见 §7 |
| macOS arm64 / x86_64 | GitHub Release（DMG + updater `.app.tar.gz`） | 官方 updater | 已接通/已配置；**真实安装重启、公证未验** |
| Linux | 无发布 workflow | 未配置 | 暂不支持（无发布产物/渠道） |
| Android | GitHub Release APK | 不支持桌面安装器更新 | 从发布页手动下载 APK |
| iOS | 无发布 workflow | 不支持 | 暂不支持 |

客户端流程（`src/updater/`）：

1. `entries/main.ts` 在**主窗口挂载后**延迟 8s 调一次 `check(false)`；失败静默回 idle，不弹窗、不重试。
2. 设置 → 关于 → 应用更新：手动检查、查看版本/说明/发布时间、下载、取消下载、安装并重启、稍后。
3. 同一窗口内检查/下载各单飞；Rust `UpdaterSession` 跨窗口也只允许一个下载任务。
4. 检查的硬上限 12s（Rust）+ 15s（前端兜底）；下载单次请求超时 **30 分钟**。
   ⚠️ 这个超时是 reqwest 的**整请求**上限，不是"多久没数据"：写 120s 会让手机热点 /
   跨网段下几十 MB 的包必然在 99% 失败，而重试多少次都一样。
5. 取消：Rust 侧用 `tokio::select!` drop 官方 `Update::download` future —— HTTP 读取停止、
   半包内存释放；没有落盘临时文件，也没有启动安装器。**不是只隐藏 loading**。
6. 安装前必须用户在「安装并重启」后再确认一次；安装器接管后 Windows 由 NSIS 重启
   （官方 `install` 内部会退出本进程），macOS/Linux 由 `AppHandle::restart()` 重启。
   解包/验签/复制放在 `spawn_blocking`，不占 tokio worker。
   **安装失败保留已下载字节**（不是先 `take()`）：验签/磁盘/占用任一环失败时用户可以直接重试，
   不必重新下载几十 MB。
7. `updater-manifest.yml` 由 **tag push** 触发（不是 `release: published`）：用 `GITHUB_TOKEN`
   创建的 Release 不会再启动新的 workflow run（GitHub 防递归），写在 release 事件上会让
   `latest.json` 永远不生成。它轮询等 Release 与四平台产物齐，再生成并校验清单。

## 2. 签名与密钥

- 客户端只内置**公钥**（`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`）。
- 私钥在当前开发机的 **仓库外**：
  - 私钥：`~/.tauri/gosslan-updater.key`（权限 600）
  - 密码：`~/.tauri/gosslan-updater.password`（权限 600）
- GitHub Actions 需要的 Secrets：
  - `TAURI_SIGNING_PRIVATE_KEY`：私钥文件的**完整内容**
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：密码文件的**完整内容**
- **绝不**提交私钥/密码；不要把内容打印进日志。当前仓库里只有公钥。
- 备份：把私钥与密码离线保存两份；丢失后已安装用户**无法**再验证新更新（只能手动重装）。
- 轮换/泄漏：如果私钥泄漏，必须发布一个**手动安装**的新版本换公钥；在旧公钥下的自动更新
  可能已被攻击者利用。没有无痛轮换机制 —— 这是更新签名的固有边界。
- 公钥/私钥均未覆盖任何既有密钥（仓库此前没有 updater 配置）。

## 3. 发布流程

1. `npm run version:minor`（或 patch）把版本提到目标版本（**本文件不抄具体号**，现读
   `npm run version:show`）；确认 `CHANGELOG.md` 有该版本小节。tag 必须与 `package.json`
   的版本逐字一致 —— 清单 workflow 会当场校验，不一致就拒绝生成 `latest.json`。
2. 确认 GitHub Secrets 已配好（上节）；缺 Secrets 时 tag 构建会**红**，不会静默出无签名包。
3. 推 `main` 与同名 tag（`v` + `package.json` 里的 version）。四个构建 workflow 分别在构建时：
   - macOS/Windows 基础档带 `--config src-tauri/tauri.updater.conf.json`（仅 tag）生成签名；
   - 上传 `.app.tar.gz`+`.sig` / `*.exe.sig`；
   - 现有 `publish-release-assets.sh` 把普通安装包和签名挂到同一个 Release。
4. `updater-manifest.yml` 在 Release 出现后等待四个平台产物齐（45 分钟上限），
   下载、生成并上传 `latest.json`，最后用公开 URL 校验 200 与四平台齐全。
5. 校验：
   `curl -fsSL https://github.com/wenzo001/gosslan/releases/latest/download/latest.json`
   应含 `darwin-aarch64` / `darwin-x86_64` / `windows-x86_64` / `windows-aarch64`，
   且 `version` 与 tag 一致。
6. 重复发布/版本冲突：`publish-release-assets.sh` 幂等创建/补附件；
   `latest.json` 上传用 `--clobber`；同版本重复发 tag 会覆盖旧资产，**不要**这么做。

### 3.1 发不出去时的三种真形状（2026-10-22 实测，都踩过）

| 现象 | 真实原因 | 现在怎么被挡住/自动处理 |
|---|---|---|
| 四条发布 job 全红，日志只说 `already exists`，而按 tag 查 Release 又是 404 | **网页上有人建了草稿 Release**：草稿对 `releases/tags/<tag>` 返回 404 | `publish-release-assets.sh` 用列表 API 兜底判"存在"，并在上传完成后 **`release edit --draft=false` 主动发布**（判据：`publishRelease.test.ts` 的 draft 场景） |
| tag 构建跑到签名那一步才红，日志只有 `exit code 1` | `TAURI_SIGNING_PRIVATE_KEY` **填成了文件路径**或被截断（本机同命令 + 本机 key 是能过的） | tag 构建开头的预检会 **base64 解码**并要求解出来以 `untrusted comment:` 开头；不是就**立刻具名报错**（两条腿同口径） |
| 重发同一个版本号 | tag 已存在且指向旧提交，新提交的修复**不会**被带上 | 换新版本号重发（`npm run version:patch` → 新 tag），不要复用旧 tag |

> 排查口诀：**先看公开侧**（`releases/latest` 指向哪个 tag、`latest.json` 是否 404、
> `releases.atom` 最新条目的作者是 `github-actions[bot]` 还是真人）—— 作者是真人
> 就说明那是人工草稿，跟构建无关。

## 4. 更新清单与产物一致性

`scripts/updater-manifest.mjs`：

- 只接受同时存在 `<artifact>.sig` 的产物；
- macOS 按 `arm64/aarch64` 与 `x64/x86_64` 分成两个平台键；
- Windows 只选基础 NSIS（排除 `webview2`），按 arch 分键；
- 任一平台缺失、签名空/过短、tag 与 `package.json` 版本不一致 ⇒ 直接红；
- `notes` 从 CHANGELOG 对应版本小节提取。
- 单元判据：`node --test scripts/updaterManifest.test.ts`。

## 5. 过渡版本与老用户

- **本文件不抄版本号**：线上最新版本读
  `https://github.com/wenzo001/gosslan/releases/latest`。它之前的所有版本**没有 updater**，
  不会自动收到任何更新。
- 第一个包含 updater 的版本必须让老用户**手动下载安装一次**；从此以后才进入自动更新。
- 在它的 `latest.json` 生成之前，客户端检查会 404/网络失败 → 静默（符合离线零打扰）。
- Windows 内置 WebView2 档（`-webview2-bundled.exe`）不进入清单：它接近 200MB，
  走官方 `Update::download` 会让客户端内存峰值过大；这一档用户需手动更新，或后续单开通道。

## 6. 已执行测试 / 未覆盖项

已跑（本地，2026-10-22）：

- `node --test src/utils/updater.test.ts`：**11/11**（无更新、发现更新、离线/网络失败、超时、
  单飞检查、下载进度、单飞下载、取消下载后可重试、下载失败、稍后、安装）。
- `node --test scripts/updaterManifest.test.ts`：**5/5**（四平台配对、webview2 排除、
  缺平台/tag 版本不一致/空签名、CHANGELOG notes 截取，外加**发布收尾等待名与两个构建矩阵
  label 的对账**）。
- `npm test`：**1230/1230**；`npm run build`（vue-tsc + vite）：通过。
- Brave 探针 `--only=updater`：**5/5**（发现更新、下载进度条、安装二次确认、移动端说明、390 宽不溢出）。
- `cargo fmt --check --all`：通过；`cargo clippy --features bluetooth -- -D warnings`：通过；
  `cargo check --features bluetooth`：通过。
- **Windows 目标交叉类型检查**：`cargo xwin check --target x86_64-pc-windows-msvc
  --features bluetooth` **exit 0、0 warning**（`llvm-rc` 取自 Android NDK；补掉 Windows 分支
  `app` 未使用告警后复跑）。这只证明 `#[cfg(windows)]` 分支能编过，**不是** Windows 安装验证。
- **本地按 tag 形状做了一次真实签名打包**（macOS arm64）：
  `TAURI_SIGNING_PRIVATE_KEY=… TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… npm run tauri -- build
  --target aarch64-apple-darwin --features bluetooth --bundles app
  --config src-tauri/tauri.updater.conf.json`
  → `Finished 1 updater signature at: …/bundle/macos/Gosslan.app.tar.gz.sig`（4m28s，最终代码重打）。
  产物 8.0MB、签名 404B；客户端内置公钥与 `gosslan-updater.key.pub` **逐字一致**
  （152 字符），不是只“签了”而没核对验签公钥。
- 用**真实签名的 mac 产物**加三个平台的占位产物跑清单脚本：生成的四平台 `latest.json`
  里 `darwin-aarch64.signature` 长度 = 404，URL 指向
  `…/releases/download/v5.4.1/Gosslan-arm64.app.tar.gz`。占位平台只验证文件名配对与
  平台映射，不代表 Windows 的真实签名已验。
- Android：`cargo check --target aarch64-linux-android` **编译 Finished**；但门禁要求 0 warning，
  当前工作树有 3 条来自**并行会话** `notifications.rs`（`slot_allows`/`acquire_click_waiter`/
  `ClickWaiterGuard` 未使用）的 warning ⇒ Android 门禁红，与本更新模块无关。

**门禁与共享工作树**（2026-10-22 现算）：

- 第 12 步领域图曾报 `src/updater/*` 无归属 —— 已把 `src/updater` 归入 presentation
  （前端状态机/适配器，IPC 仍走 `src/api` 门面）。
- Rust 单测曾报 `all_commands_src()` 漏登记 `commands/updater.rs`（漏登记 ⇒ 命令面守卫
  假绿）—— 已在 `src-tauri/src/lib_tests.rs` 补 `include_str!`；补后本模块那轮
  `cargo test --features bluetooth --lib` = **1094 passed / 0 failed / 1 ignored**。
- **发布收尾 workflow 修掉一处会空等 45 分钟的断链**：macOS 矩阵标签是 `x86_64`，产物名是
  `Gosslan-x86_64.app.tar.gz`，原等待串却写成 `Gosslan-x64.app.tar.gz`。已改对，并在
  `updaterManifest.test.ts` 加一条“等待名 = 矩阵 label”判据（先红后绿），防止下次漂移。
- `npm run verify:local`：**21/22 绿，仅第 22 步 Android 红**（并行会话 3 条告警）。
  该轮运行期间工作树被并行会话改动（前后 `git status` 哈希不同），所以不把它写成
  “stable-tree 整层绿”；各关键步的单独读数见上。
- 随后并行会话新增 `check_relay_server`，把 `worker_bound_heavy_commands_do_not_grow`
  棘轮顶到 51/50 ⇒ 当前树的 Rust 单测红，同样不属于本模块；未代改。
- Android 编译 **Finished**，但 0-warning 判据被并行会话 `notifications.rs` 的 3 条未使用
  告警顶红（`slot_allows` / `acquire_click_waiter` / `ClickWaiterGuard`），与本功能无关。

**未验**（必须明说）：

- 真实签名产物下载 → 签名校验 → NSIS/DMG 安装 → 重启后新版本启动（需要配 Secrets、
  发一个真实 tag/Release；本次按用户要求未发布、未推标签）。
- macOS 公证/签名链、Windows WebView2 档的更新路径。
- 真机（Tauri 窗口）内的更新入口与离线启动观感：浏览器探针只覆盖渲染与交互，
  不覆盖真实 IPC、下载与断网后的运行时观感。
- GitHub Actions 的 `updater-manifest.yml` 尚未在真实 Release 上跑过（没有可发布的版本）。

## 7. 风险与边界

- 官方 `Update::download` **把整包放内存**（不是流式落盘），取消时随 future drop 释放；
  因此更新清单只指向基础 NSIS / `.app.tar.gz`，不指向 190MB 的 WebView2 内置档。
- 检查失败静默；没有“网络恢复后自动重试”，只有用户手动检查（满足不轮询/不无限重试）。
- 服务器端只有 GitHub Releases；无自建服务、无域名、无数据库。
