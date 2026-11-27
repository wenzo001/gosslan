# 自动更新（Tauri Updater + Gitee 固定清单 / GitHub 备份）

> 方案：**Tauri 官方 updater 插件 + Gitee 固定静态清单 + GitHub Release 备份**。不建更新服务器、不买域名。
> 客户端同时写两条地址：
>
> 1. `https://gitee.com/fwdq/gosslan-releases/raw/master/updates/latest.json`
> 2. `https://github.com/wenzo001/gosslan/releases/latest/download/latest.json`
>
> ⚠️ **怎么用这两条（2026-11-27 起）**：默认是「**自动**」—— 两个端点**并发**查，
> **等两边都有结论**后再裁决：有可升级版本者胜，多个候选取**版本最高**的，同版本取先回的；
> 没有任何候选、但至少一家明确说「已是最新」⇒ 无更新；两家都失败才报错。
> 旧行为是「第一个回 `Ok` 的赢」，而 `Ok(None)` 也会立刻赢 ⇒ Gitee 镜像延迟窗口里
> 自动模式会误报「已是最新」，永远等不到 GitHub 的新版本。
>
> 用户在设置页**显式**选了 Gitee 或 GitHub 之后，那个选择会被**记住**
> （`settings` 里的 `update_source_pref`），下次打开应用默认就走他选的那条；
> 没选过 / 选回「自动」 ⇒ 回到上面的双源裁决。
> **显式选源严格按那一个源查**：失败如实报错，不再静默改查另一家。
> 下载失败也**不自动换源**：界面给「换到另一源重试」按钮，由用户决定（网络抖动不该改选择）。
>
> ⚠️ Gitee 镜像是**发布后延迟传播**的（约 30–35 分钟）；现在它只影响 Gitee 自己的清单，
> 不会再让自动模式错过 GitHub 的新版本。

## 1. 架构与平台范围

| 平台 | 分发渠道 | 应用内更新 | 状态 |
|---|---|---|---|
| Windows x64 / arm64 | Gitee Release（镜像）+ GitHub Release（备份） | 官方 updater（NSIS）；自动模式双源并发取版本最高 | 已配置；**真实安装重启未验** |
| Windows（内置 WebView2 档） | GitHub Release（**按策略 Gitee 不镜像**，177–189MB） | 不进入更新清单 | 手动更新；需从 GitHub 下载；见 §7 |
| macOS arm64 / x86_64 | Gitee Release（镜像）+ GitHub Release（备份） | 官方 updater；自动模式双源并发取版本最高 | 已配置；**真实安装重启、公证未验** |
| Linux | 无发布 workflow | 未配置 | 暂不支持（无发布产物/渠道） |
| Android | Gitee Release（镜像）+ GitHub Release（备份） | 应用内更新先读 Gitee 固定清单，失败/清单过期退 GitHub API | 已配置；**真机安装未验** |
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
   **整包移动而不是 clone**（PERF-01）：`update`/`bytes` 先 `take()` 出来交给安装器，
   失败时原样放回会话 ⇒ 峰值从 2× 包体降到 1×，且验签/磁盘/占用任一环失败都能直接重试，
   不必重新下载几十 MB。
   安装阶段有 Drop 守卫：命令 future 被丢弃（窗口关闭/退出）时相位落 `failed` 并记
   `code=UPDATER_INSTALL_ABORTED`，不会永久停在 `installing`。
7. **禁止降级**（2026-10-24 产品裁决）：`updater_check` 用自己的 semver 判据再比一次 ——
   清单版本必须**严格高于**当前版本。不高于当前版本直接拒绝，记
   `code=UPDATER_DOWNGRADE_BLOCKED`（带双方版本号），且**不把这份 `Update` 放进会话**
   （否则用户还能点"下载"装回旧版）；版本号解析失败按失败关闭。界面显示
   "更新清单指向更旧的版本，已拒绝安装"。要回退旧版本只能手动下载安装。
8. `updater-manifest.yml` 由 **tag push** 触发（不是 `release: published`）：用 `GITHUB_TOKEN`
   创建的 Release 不会再启动新的 workflow run（GitHub 防递归），写在 release 事件上会让
   `latest.json` 永远不生成。它轮询等 Release 与四平台产物齐，再生成并校验清单。
   发布完成后，同一个 workflow 末尾的 `sync-gitee` job 调用 `sync-gitee.yml` 把资产与
   固定清单镜像到 Gitee；**这一步失败会让整条发布 workflow 红**，不是可选项。
   手工补跑用 `workflow_dispatch` 直接跑 `sync-gitee.yml`（指定已发布 tag），不会重跑
   GitHub 清单生成、不会动已发布的 GitHub Release。

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
   - `publish-release-assets.sh` 把普通安装包和签名挂到同一个 Release，但**只建/补草稿**
     （draft-until-complete：四条腿谁先跑完都不能把半个 Release 对外公开）。
4. `updater-manifest.yml` 等 Release 里四类资产齐（桌面 updater / 内置 WebView2 档 /
   Android APK / macOS dmg，45 分钟上限），下载、生成并上传 `latest.json`，
   然后才 `--draft=false` 发布，最后用公开 URL 校验 200 与四平台齐全。
   草稿对 `releases/tags/<tag>` 会 404，所以这一步全程用列表 API 按 release id 读写。
5. **Gitee 镜像**（`updater-manifest.yml` → `sync-gitee` job，或手工 `sync-gitee.yml`）：
   - 只承载 **Windows/macOS 正常版（≤10MB）与 Android APK（≤20MB）**；WebView2 内置包
     （177–189MB）与 Linux 包（AppImage/deb）**只走 GitHub**，减少 Gitee 存储与上传压力；
   - 从 GitHub Release 只下载白名单内的资产（`sync-gitee.mjs::skipReason` 单点定义，
     下载预筛与上传共用同一份判据）；
   - 在 `fwdq/gosslan-releases` 建同名 tag/release 并上传附件（幂等：同名旧附件先删再传）；
   - 用 GitHub 的 `latest.json` 重写四个桌面 URL 为 Gitee 下载地址，签名原样复用；
   - Android 平台**可选**：APK 已镜像才追加 `android-aarch64` / `android-armv7`（带
     `url + size + sha256`）；没镜像就不写，Android 客户端回退 GitHub API；
   - **先校验、后提交**：逐个文件核对 Gitee 附件（同名 + 同大小）与平台 URL 匿名可达，
     全部通过才把结果提交到固定路径 `updates/latest.json`（`master` 分支）；
     校验失败保留上一版清单，客户端最多「暂无更新」，不会拿到 404；
   - 完整下载一个桌面产物与一个 APK 并比对 sha256；
   - 清理更早的 Gitee release，只保留最近 `keep` 个（默认 3），**当前 tag 永不删**。
6. 校验：
   ```bash
   curl -fsSL https://gitee.com/fwdq/gosslan-releases/raw/master/updates/latest.json
   curl -fsSL https://github.com/wenzo001/gosslan/releases/latest/download/latest.json
   ```
   两份清单应含 `darwin-aarch64` / `darwin-x86_64` / `windows-x86_64` / `windows-aarch64`，
   `version` 与 tag 一致；Gitee 版额外含两个 Android 平台。
7. 重复发布/版本冲突：`publish-release-assets.sh` 幂等创建/补附件；
   `latest.json` 重传先按资产 id 删除再上传（等价 `--clobber`）；同版本重复发 tag 会覆盖旧资产，**不要**这么做。
   Gitee 侧同样幂等：release 存在就更新，同名附件先删再传，固定清单用 Contents API 覆盖提交。

### 3.1 发不出去时的三种真形状（2026-10-22 实测，都踩过）

| 现象 | 真实原因 | 现在怎么被挡住/自动处理 |
|---|---|---|
| 四条发布 job 全红，日志只说 `already exists`，而按 tag 查 Release 又是 404 | **网页上有人建了草稿 Release**：草稿对 `releases/tags/<tag>` 返回 404 | `publish-release-assets.sh` 用列表 API 兜底判"存在"；现在四条腿本来就只建/补草稿，发布由 `updater-manifest.yml` 在四类资产齐了之后统一做（判据：`publishRelease.test.ts`） |
| tag 构建跑到签名那一步才红，日志只有 `exit code 1` | `TAURI_SIGNING_PRIVATE_KEY` **填成了文件路径**或被截断（本机同命令 + 本机 key 是能过的） | tag 构建开头的预检会 **base64 解码**并要求解出来以 `untrusted comment:` 开头；不是就**立刻具名报错**（两条腿同口径） |
| 私钥预检通过、仍然红在签名步 | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 粘贴带了行尾空白（密码文件本身含结尾换行，正文没有） | 预检现在**真的签一次临时文件**，不配套时 5 秒内具名报出私钥/密码各自的字符数；构建前统一去掉行尾空白 |
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

Gitee 侧的 `scripts/sync-gitee.mjs` 不重新生成桌面清单，而是**复用 GitHub 的 `latest.json`**：

- 四个桌面平台只改 `url` 的基地址，`signature` 原样保留（不重签）；
- 追加两个 Android 平台（`url` + `size` + `sha256`），签名字段留空是刻意的：
  Android 走 sha256 校验，不用 minisign；
- 版本号必须与 tag 逐字一致；缺任一桌面平台、缺任一 Android 平台直接红；
- `latest.json` 本身不重复上传为 release 附件，只提交固定路径；
- 单元判据：`node --test scripts/sync-gitee.test.ts`。

执行结构是 `prepare` → `upload`×5（matrix，每个分片一个独立 runner IP，片内 3 路并发）→
`finalize`。原因：现场实测 GitHub runner 到 Gitee 上传被限速在 ~10KB/s，单 job 串行 74MB
要两个多小时，必定超过 job 超时。`GET/DELETE/PATCH` 遇 TLS 中断或 502-504 会重试 3 次；
重跑时先匿名 HEAD 比对 `content-length`，已完整的附件直接跳过，不会把整包重传一遍。

## 4.1 Gitee 配额、清理与边界

- **单附件 100MB / 仓库附件总量 1G**（Gitee Help）。白名单收紧后单版约 **75MB**
  （Win/Mac 正常版约 43.5MB + Android APK 约 31MB），默认保留最近 3 个约 225MB，
  远低于 1G；GitHub 全量保留。
- 清理前会打印完整 dry-run 计划；当前 tag 的 release 被硬编码排除，固定清单在仓库分支上，
  不在 release 附件里，所以清理不会碰 `latest.json`。
- `workflow_dispatch` 默认 `dry_run=true`：**只跳过清理**，镜像、上传与清单提交照常执行；
  要真正删旧 release 时必须显式传 `dry_run=false`，并先看一遍 dry-run 打印的删除计划。
- **只走 GitHub、Gitee 不承载**：WebView2 内置档（`*-webview2-bundled.exe`，177–189MB）、
  Linux AppImage/deb、以及任何超过白名单上限（桌面 10MB / APK 20MB）的包。
  它们本来也不进入桌面更新清单；WebView2 档用户需手动从 GitHub 更新。

## 5. 过渡版本与老用户

- **本文件不抄版本号**：线上最新版本读
  `https://github.com/wenzo001/gosslan/releases/latest`。它之前的所有版本**没有 updater**，
  不会自动收到任何更新。
- 第一个包含 updater 的版本必须让老用户**手动下载安装一次**；从此以后才进入自动更新。
- 在它的 `latest.json` 生成之前，客户端检查会 404/网络失败 → 静默（符合离线零打扰）。
- Windows 内置 WebView2 档（`-webview2-bundled.exe`）不进入清单：它接近 200MB，
  走官方 `Update::download` 会让客户端内存峰值过大；这一档用户需手动更新，或后续单开通道。
  它按策略**只从 GitHub Release 下载**，Gitee 不镜像。

### 5.1 双源并发与「Gitee 优先」的作废

2026-11-27 起自动模式**同时查两个端点**，等两边都有结论后按「可升级 + 版本最高 + 同版本取
先回」裁决，所以：

- 不再有「Gitee 优先」的过渡期，也不需要把 GitHub 从 `tauri.conf.json` 的 `endpoints`
  里摘掉 —— 两条都留着，谁有更新的清单就用谁；GitHub Release 同时是归档与 WebView2 下载
  渠道。
- Gitee 同步失败不再是「用户看不到新版本」的单点故障：它手里那份旧清单只会输给 GitHub 的
  新清单；只有两家都失败才会报错。
- 显式选源的语义相反：用户选了谁就只查谁，失败如实报错、由界面给「换到另一源重试」，
  不静默改源。
- 唯一仍需要「立刻修」的场景：Gitee 与 GitHub **同时**没有可升级清单（例如发布流程整体
  失败）。这时客户端会停在旧版本，属于发布侧事故而不是线路抖动。

## 6. 已执行测试 / 未覆盖项

已跑（本地，2026-10-22）：

- `node --test src/utils/updater.test.ts`：**11/11**（无更新、发现更新、离线/网络失败、超时、
  单飞检查、下载进度、单飞下载、取消下载后可重试、下载失败、稍后、安装）。
- `node --test scripts/updaterManifest.test.ts`：**5/5**（四平台配对、webview2 排除、
  缺平台/tag 版本不一致/空签名、CHANGELOG notes 截取，外加**发布收尾等待名与两个构建矩阵
  label 的对账**）。
- `npm test`：**1230/1230**（2026-10-22 当时读数）；`npm run build`（vue-tsc + vite）：通过。
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

- **2026-10-24 复核（本轮审计修复后）**：
  `cargo clippy --features bluetooth --all-targets -- -D warnings` **0 红**；
  `cargo test --features bluetooth --lib` **1185 passed / 0 failed / 1 ignored**；
  `npm test` **1368 passed / 0 failed**；`npm run build` 通过。
  updater 新增禁止降级判据（前端 `downgrade` 错误格 1 条 + Rust 六向对照 + 闸门位置守卫），
  本轮**未重跑**真实签名打包（与上一段 2026-10-22 的打包结论不冲突，那次的签名链路仍然有效）。

- **2026-11-07 Gitee 优先改造（本轮）**：
  - `node --test scripts/sync-gitee.test.ts`：**7/7**（桌面 URL 重写、Android 条目、
    跳过策略、保留排序/当前 tag 保护、URL 解码、令牌打码）。
  - `cargo test --lib android_update_core`：**9/9**（新增固定清单解析：只取 Android 平台、
    缺版本/缺 Android 条目报错、缺 sha256 留给后续校验）。
  - `cargo check --target aarch64-linux-android --lib`：**Finished**（Android 分支编译通过；
    仅剩并行会话既有 `EVENT_PREVIEW_CLOSED` 未使用告警）。
  - 真实 Gitee 演练结果见 §6.1；**真机安装与桌面真实签名校验仍未验**。

### 6.1 Gitee 端到端演练（2026-11-07，tag v5.18.78）

> 历史记录：当时的承载策略是「≤100MB 全传、只跳过 WebView2」。2026-11-27 已收紧为
> 「Win/Mac 正常版 ≤10MB + Android APK ≤20MB，其余只走 GitHub」，下面的资产数量与
> 分片数只反映当时现场。

用 `workflow_dispatch` 直接跑 `sync-gitee.yml`
（[run 42395461687](https://github.com/wenzo001/gosslan/actions/runs/42395461687)），
只读 GitHub 已发布资产，不重跑发布、不动已发布 Release：

- 空仓库初始化：`README.md` 占位提交 → `master` 分支 → tag/release；
- 上传 14 个资产，跳过 1 个（`latest.json` 走固定路径）与 2 个 WebView2 内置包（>100MB）；
- 固定清单匿名可读：HTTP 200、`version 5.18.78`、四桌面 + 两 Android 平台齐全；
- 14 个附件全部从 Gitee 匿名完整下载，sha256 与 GitHub 原件**逐字节一致**；
  `.sig` 也一致 ⇒ 签名没被改动，客户端用原公钥即可校验；
- 清理 dry-run：0 个可删（当时只有 1 个 release），当前 tag 未被误删；
- 演练暴露的真实约束：GitHub runner → Gitee 上传被限速在 ~10KB/s，单 job 串行 74MB 会超时，
  所以拆成 5 个分片 job（每片 3 路并发）；跨洋链路偶发 `fetch failed`，API 已加 3 次重试，
  重跑时用匿名 HEAD 比大小跳过已完整附件。

> 未验：桌面客户端在真机上点“检查更新”走 Gitee 清单的完整链路（需打包后实测）；
> Android 真机安装同样未验。命令与原文输出记录在本次交付说明中。

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
- 服务器端是 Gitee Release + GitHub Release 两份静态资产；无自建服务、无域名、无数据库。
- Gitee 配额：单附件 100MB、仓库总量 1G ⇒ WebView2 档不镜像，旧 release 只保留 8 个；
  配额逼近时同步 job 会先红，不要靠“传上去再说”。
- Gitee raw 清单有约 60 秒 CDN 缓存；发布后最多一分钟内客户端仍可能读到上一版清单。
- 桌面端 Gitee 返回 200 的旧清单不会回退 GitHub；Android 端额外做了“低于当前版本判过期”
  并退 GitHub 的兜底，但两端都以“同步 job 必须绿”为最终保障。
