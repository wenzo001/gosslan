# macOS Share Extension（系统分享目标的写入端）

> 状态：**源码齐了，没编译、没打包、没真机验收（NOT RUN）**。
> 本仓的构建链（Tauri + Cargo）**产不出**这个 target —— 它需要 Xcode 的 App Extension target。
> 这里给的是可直接粘进 Xcode 的三个文件 + 步骤；协议见
> [`docs/notes/system-share-target-design-2026-11-15.md`](../../docs/notes/system-share-target-design-2026-11-15.md)。

## 1. 这三个文件各管什么

| 文件 | 作用 |
|---|---|
| `ShareViewController.swift` | 扩展主体：把分享内容写成一份落地区文件，然后结束扩展 |
| `Info.plist` | 扩展点声明（`com.apple.share-services`）+ 激活规则（链接 / 纯文本） |
| `GosslanShareExtension.entitlements` | **App Group**（扩展与主应用唯一共有的通道） |

## 2. 接到 Xcode 里的步骤

1. 打开主应用的 Xcode 工程（`tauri build` 会生成一个可打开的工程；或用 Xcode 的
   Tauri 模板新建）。
2. **File → New → Target… → Share Extension**，产品名 `GosslanShareExtension`，
   Bundle ID 必须是主应用的**子标识**（如 `com.gosslan.app.ShareExtension`）。
3. 把上面三个文件加进新 target：
   - `ShareViewController.swift` ⇒ Sources；
   - `Info.plist` ⇒ target 的 Info.plist（或按 Xcode 的 "Using the provided Info.plist"）；
   - `GosslanShareExtension.entitlements` ⇒ Signing & Capabilities 的 App Group。
4. **App Group 两边都要开**：
   - 扩展 target 的 entitlements：`group.com.gosslan.app`；
   - **主应用 target 的 entitlements 也要加同一个 group**（否则主应用读不到文件）。
   - Team ID 换成你自己的（`<你的 Team ID>.group.com.gosslan.app`），
     并在 Apple Developer 后台先把这个 group 建好（免费账号也能建）。
5. `ShareViewController.swift` 里的 `appGroupIdentifier` 改成同一个字符串。
6. **签名**：用 **Apple Development** 证书就够本机/内测（免费，Team ID 稳定）；
   分发给别的 Mac 需要付费的 Developer Program（公证）。
7. 打包：`tauri build` 之外，还要让 Xcode 打出扩展并嵌进 `.app` 的 `PlugIns/`。

## 3. 怎么验

- 在别的应用里（Safari / 备忘录）选中一段文字 → 分享菜单里应出现「小院儿」。
- 分享后切回本应用 ⇒ **面板自动弹出**（读取端在应用启动与窗口重新获得焦点时扫落地区）。
- 落地区里应出现一个 `incoming-<32 位十六进制>.json`（路径见协议 §3.1）。
- **没弹面板**先查三件事：① App Group 两边是否一致；② 扩展是否真的被调起
  （扩展里打一行 log）；③ 文件是否写到了主应用读的那个目录。

## 4. 已知边界

- 扩展**不联网**：内容只经由 App Group 落到本机。
- 应用完全藏在托盘、用户不切回来的那段时间里，分享会**晚一点**才被看到
  （落地区文件 30 分钟内一直有效，切回来就能捡到）。
- 想「后台即时到达」需要平台侧通知通道（`NSDistributedNotification`）——
  那是原生代码，本仓做不了。
- Windows 那半边（MSIX `shareTarget`）见 `../windows-share-target/`。
