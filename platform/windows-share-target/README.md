# Windows 分享目标（MSIX `shareTarget`）

> 状态：**源码齐了，没编译、没打包、没真机验收（NOT RUN）**。
> 本仓的构建链（Tauri + Cargo）产不出 MSIX 包 —— 需要 Windows 工程与证书。
> 协议见 [`docs/notes/system-share-target-design-2026-11-15.md`](../../docs/notes/system-share-target-design-2026-11-15.md)。

## 1. 与 macOS 侧的差别（重要）

Windows 的分享目标**不是独立进程**：它是主应用被系统唤起后，由
`DataTransferManager.DataRequested` 事件接住 ⇒ 这段 C# 代码要**跑在主应用进程里**
（Rust + Tauri ⇒ 需要一个很薄的 C#/WinRT 壳，或用 Tauri 插件承载）。

macOS 那边是**独立的 Share Extension 进程**，两边唯一共有的通道是
「**写文件 → 主应用读文件**」，所以协议必须落在这个形状上。

## 2. 三个文件

| 文件 | 作用 |
|---|---|
| `Package.appxmanifest.fragment.xml` | MSIX 清单里的 `windows.shareTarget` 扩展声明 |
| `ShareTarget.cs` | 接线：接住 `DataRequested`，把内容写成落地区文件 |
| 本文件 | 步骤与验收 |

## 3. 步骤

1. 准备一个 MSIX 包（打包桌面应用），把 `Package.appxmanifest.fragment.xml` 的内容
   贴进主应用清单的 `<Extensions>`。
2. 在主应用进程里挂上分享处理（`ShareTarget.Register(DataTransferManager.GetForCurrentView())`），
   并把 `ShareTarget.cs` 的 `PackageIdentityName()` 改成与读取端一致的目录名
   （读取端按 `app_local_data_dir()/incoming-shares` 读）。
3. 签名：MSIX 需要证书（自签或商店证书）。**与密钥库无关** —— DPAPI 不需要代码签名。
4. 打包后安装，在别的应用里分享一段文字 ⇒ 应用被唤起 ⇒ 落地区出现
   `incoming-<32 位十六进制>.json` ⇒ 切回应用时面板弹出。

## 3.5 ⚠️ payload 字段名必须小写（2026-11-16 修）

`Payload` 的 C# 属性是 PascalCase（`Url/Title/Text`），但 `System.Text.Json`
**默认按属性名原样输出** PascalCase —— 而读取端（`src-tauri/src/incoming_share.rs`
的 `IncomingPayload`）带 `#[serde(rename_all = "camelCase")]`，只认 `url/title/text`。
两边对不上的话，文件会被判成「三个字段都缺」**直接拒收**。

现在三个属性都显式标了 `[JsonPropertyName("url"|"title"|"text")]` ⇒ 不依赖序列化器默认。
判据在 `src/utils/incomingShareWiring.test.ts`：去掉任一注解当场红。

## 4. 已知边界

- 只收链接与纯文本（与 macOS 侧同口径）；图片/文件暂不支持。
- 应用被唤起但用户不切回来 ⇒ 内容留在落地区（30 分钟内有效），切回来就能捡到。
- 真机验收 **NOT RUN**：本机没有 Windows 打包链与证书。
