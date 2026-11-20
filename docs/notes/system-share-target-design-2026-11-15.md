# 系统分享目标（从别的应用分享到小院儿）—— 协议、读取端与平台骨架

> 日期：2026-11-15
> 状态：**读取端已实现；平台写入端（Share Extension / MSIX share target）未实现**，需要签名与
> 平台工程，本仓交不出可安装的包。本文给出协议、读取端与两份骨架，真机验收一律 `NOT RUN`。
> 边界与红线见 `docs/notes/external-auth-integration-contract-2026-11-14.md` §6。

## 1. 这件事是什么，有什么用

用户在别的应用里（浏览器、邮件、备忘录）选中一段内容 → 系统的「分享」菜单里出现
「小院儿」→ 内容进到小院儿的待处理面板 → 用户**自己选会话**、**自己点发送**。

**它不是什么**：不是网页可以静默调用本机的桥（同深链的红线，见 §5）。

## 2. 为什么协议是「写文件」

平台扩展与主应用是**两个进程**：

| 平台 | 扩展形态 | 扩展能不能直接跟主应用说话 |
|---|---|---|
| macOS | Share Extension（Xcode target，Swift） | 不能。能写的只有共享容器（App Group） |
| Windows | MSIX `shareTarget` 扩展（WinRT） | 不能。能写的只有共享目录 |

两边都做得到的唯一通道就是「**写文件 → 主应用读文件**」。所以协议必须落在这个形状上，
而不是「扩展去调主应用的 HTTP 端口」—— 本仓是 P2P 客户端，开一个本地 HTTP 端口等于给
任意进程一个可探测的入口（理由见 `src-tauri/src/share.rs` 的文件头注释）。

## 3. 协议 v1

### 3.1 落地区位置

| 平台 | 目录 |
|---|---|
| macOS | `<App Group 容器>/incoming-shares/`（**写入端骨架**，见下）；读取端当前只扫 `app_local_data_dir()/incoming-shares/` |
| Windows | `%LOCALAPPDATA%\<包标识>\incoming-shares\` |

读取端一律以 `app_local_data_dir()` 为基准（见 `src-tauri/src/incoming_share.rs` 的
`incoming_dir`）：**不是漫游目录** —— 分享是本机的事，不该跟着账号跑到别的机器上去。

> ⚠️ **2026-11-20 审计更正（未落地边界）**：macOS 系统分享扩展仍是**未完成的骨架**——
> `platform/macos-share-extension/ShareViewController.swift` 的 `appGroupIdentifier` 还是占位符
> `<你的 Team ID>.group.com.gosslan.app`（Team ID / App Group 都没配置），且它写入 App Group 容器，
> 而读取端 `scan_incoming_shares` 只读 `app_local_data_dir()`，**两者目录不一致**。也就是说 macOS
> 系统分享目前端到端不通，需在确定 Team ID 后：① 配好 App Group  entitlements；② 让读取端也扫
> App Group 容器（有则优先、无则退回 local）。修好真机验收前，不要对外声称 macOS 系统分享可用。

### 3.2 文件名

```
incoming-<32 位小写十六进制>.json
```

- 十六进制 ⇒ 不含路径分隔符、不含 `..` ⇒ **目录穿越在这一层就被堵死**；
- 前缀固定 ⇒ 落地区里其它用途的文件不会被误当成待处理分享；
- 后缀固定 ⇒ 扩展的临时文件（`.tmp`）不会被当成成品。

文件名里的 32 位十六进制就是这次分享的 id（**文件名是唯一真源**）。

### 3.3 文件内容

```json
{
  "v": 1,
  "id": "9f2c1ab0d4e5f60718293a4b5c6d7e8f",
  "receivedAtMs": 1763200000000,
  "payload": { "url": "https://example.com/a", "title": "标题", "text": "正文" }
}
```

- `v`：格式版本，读取端只认 `1`；
- `id`：必须与文件名里的 id **完全一致** —— 不一致说明有人把一个文件改名成另一个
  （那样会顶掉别人的待处理分享）；
- `receivedAtMs`：扩展写下文件的时刻（UTC 毫秒）；
- `payload`：三个字段都可缺，但**至少要有一个非空**。

### 3.4 限额与时效

| 项 | 值 | 为什么 |
|---|---|---|
| 单文件大小 | 64 KiB | 分享内容本身有更严的字段限额，这个只防「拿一个几百 MB 的文件喂给解析器」 |
| 一轮扫描文件数 | 32 | 落地区是**可写目录**，同机的另一个进程能塞上万个文件 ⇒ 一轮全读会拖慢分享主路。剩下的留给下一轮 |
| 存活时长 | 30 分钟 | 扩展写完到用户切回应用可能隔一会儿；但也不能留一天（第二天打开应用收到昨天的分享很怪） |
| 允许时钟超前 | 60 秒 | 扩展与主应用的系统时钟可能差几秒；差太多说明来路不正 |
| 标题 / 正文 / URL 长度 | 与深链同一套（`src-tauri/src/share.rs` 的 `MAX_*`） | **两条入口必须同一把尺子**，见 §4 |

## 4. 读取端（本仓已实现）

代码：`src-tauri/src/incoming_share.rs`（协议纯逻辑）+ `src-tauri/src/commands/external_share.rs`
的 `scan_incoming_shares`（扫盘 + 入队）。

读取端把落地区当**不可信输入**处理，逐文件过下列校验，任一步不过就丢掉那个文件并留日志
（`EXTERNAL_SHARE_INCOMING_INVALID` / `EXTERNAL_SHARE_INCOMING_UNREADABLE`）：

1. 文件名严格匹配（`is_valid_file_name`）；
2. 文件大小 ≤ 64 KiB；
3. 是合法 JSON，且 `v` 认识；
4. 正文 `id` 与文件名一致；
5. 时间戳没有超前过多，也没有过期到 TTL 之外；
6. **内容走 `share.rs` 的同一个构造入口** `payload_from_fields` —— 深链拦得住的
   （非 http(s) 链接、空内容、超长字段），落地区也必须拦得住。

### 4.1 入队与删除的顺序

**先入队、后删文件**：

- 入队失败（队列满）⇒ 文件留着，等用户处理完再扫一次；
- 删文件失败 ⇒ 下次会再入一次队，但 `share::admit` 按内容去重 ⇒ 不会刷屏。

反过来（先删后入队）会在中途崩溃时**丢分享**。

### 4.2 触发时机

| 触发 | 覆盖场景 |
|---|---|
| 应用启动（`SharePanel` 挂载时 `store.load()`） | 冷启动前到达的分享 |
| 窗口重新获得焦点 | 用户在别的应用分享完切回来的那一刻 |

选「焦点」而不是「定时轮询」：分享是低频动作，给一个常驻托盘的客户端挂一条永不停歇的
IPC 轮询不划算；而且用户切回来的那一刻，正是最该捡起这条分享的时刻。

**已知边界**：应用完全藏在托盘里、用户不切回来的窗口期里，分享会**晚一点**才被看到
（落地区文件 30 分钟内一直有效，切回来就能捡到）。要做到「后台即时到达」，需要平台侧的
通知通道（macOS 的 `NSDistributedNotification`、Windows 的 toast 激活），那是原生代码，
本仓做不了。

### 4.3 与深链的关系

两条入口**共用**同一个队列（`external_share_pending`）、同一个面板、同一套限额与错误码族。
用户看到的东西没有区别：都要自己选会话、自己点发送。

## 5. 红线（与深链同一条）

- **不静默发消息**：落地区里的内容只进面板，用户必须显式选会话并点发送。
- **不联网**：扩展与读取端都不请求任何 URL（没有 SSRF / 跟踪像素 / 内网探测面）。
- **不信任自称来源**：落地区不带来源字段，面板上不出现来源线索。
- **必须用户可见**：面板是模态的，关闭即什么都不发。

## 6. 平台写入端骨架

两份骨架都**未编译、未打包、未真机验收**。它们的唯一职责是「把内容写成 §3 的那份文件」。

> 2026-11-15：两份骨架已从本文**落到仓库里的源文件**（可粘进各自的平台工程）：
> - macOS：[`platform/macos-share-extension/`](../platform/macos-share-extension/README.md)
>   （`ShareViewController.swift` + `Info.plist` + App Group entitlement + 接线步骤）；
> - Windows：[`platform/windows-share-target/`](../platform/windows-share-target/README.md)
>   （`Package.appxmanifest.fragment.xml` 扩展声明 + `ShareTarget.cs` 接线 + 步骤）。
>
> ⚠️ Windows 那半边与 macOS 有个**结构性差别**：Windows 的分享目标**不是独立进程**，
> 而是主应用被唤起后由 `DataTransferManager.DataRequested` 接住 ⇒ C# 代码要跑在
> 主应用进程里（Rust + Tauri ⇒ 需要一个薄壳或 Tauri 插件承载）。

### 6.1 macOS Share Extension（Swift）

需要：Xcode target（`GosslanShareExtension`）、App Group 能力、签名证书。本仓的 Cargo/前端
构建链**产不出**这个 target，只能给骨架与配置说明。

```swift
// GosslanShareExtension/ShareViewController.swift
import Cocoa
import UniformTypeIdentifiers

/// 小院儿的 macOS Share Extension 骨架。
///
/// 职责只有一件：把用户分享的内容**写成一份落地区文件**（协议见
/// `docs/notes/system-share-target-design-2026-11-15.md` §3），然后结束扩展。
/// 它不联网、不解析、不联系主应用 —— 主应用会自己捡起这份文件。
final class ShareViewController: NSViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await writeIncomingShareAndFinish() }
    }

    private func writeIncomingShareAndFinish() async {
        let item = (extensionContext?.inputItems.first as? NSExtensionItem)
        var url: String?
        var text: String?
        if let provider = item?.attachments?.first {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let value = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) {
                url = (value as? URL)?.absoluteString
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
               let value = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) {
                text = value as? String
            }
        }
        // 写文件：文件名 = incoming-<32 位小写十六进制>.json，正文见 §3.3。
        // 目录取 App Group 容器（与主应用同一个），拿不到就放弃（不要退回别处）。
        if let dir = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: "<你的 Team ID>.group.com.gosslan.app"
        )?.appendingPathComponent("incoming-shares", isDirectory: true) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            var body: [String: Any] = [
                "v": 1,
                "id": id,
                "receivedAtMs": Int(Date().timeIntervalSince1970 * 1000),
                "payload": ["url": url as Any, "title": item?.attributedContentText?.string as Any, "text": text as Any],
            ]
            let data = try? JSONSerialization.data(withJSONObject: body)
            try? data?.write(to: dir.appendingPathComponent("incoming-\(id).json"))
        }
        extensionContext?.completeRequest(returningItems: [])
    }
}
```

配套还需要：`Info.plist` 里声明 `NSExtensionPointIdentifier = com.apple.share-services`、
`NSExtensionPrincipalClass` 指向上面这个类，以及 App Group 的 entitlement。

### 6.2 Windows MSIX share target（WinRT）

需要：MSIX 包、`windows.shareTarget` 扩展声明、签名证书。本仓的构建链同样产不出。

```xml
<!-- Package.appxmanifest 片段 -->
<Extensions>
  <uap:Extension Category="windows.shareTarget">
    <uap:ShareTarget>
      <uap:DataFormats>URI</uap:DataFormats>
      <uap:Title>小院儿</uap:Title>
    </uap:ShareTarget>
  </uap:Extension>
</Extensions>
```

写入端的实现要点与 macOS 侧完全一致：读 `Windows.ApplicationModel.DataTransfer` 的
`StandardDataFormats.Uri` / `Text`，写成同一份落地区文件（目录取
`%LOCALAPPDATA%\<包标识>\incoming-shares\`）。

## 7. 为什么平台写入端不在本仓

| 障碍 | 影响 |
|---|---|
| macOS Share Extension 要独立 Xcode target | 本仓的构建链（Tauri + Cargo）产不出，产物也无法在本仓签名 |
| Windows MSIX share target 要 MSIX 包与证书 | 同上；还要处理安装/升级时的包标识一致性 |
| 两条路都要**开发者证书** | 与「平台密钥库迁移」是同一个前置条件（见下） |

所以本项的**可交付边界**就是：协议 + 读取端 + 两份骨架。真正能用的包需要你的证书。

## 8. 与平台密钥库迁移的同一个前置条件

「平台密钥库迁移」与「系统分享目标」都卡在同一件事上：**没有代码签名的构建**。

- 密钥库：macOS Keychain 在未签名构建下每次读都要弹授权框，更新后自动重启时没人点「允许」
  ⇒ 表现是卡死（实测见 `docs/notes/rp-key-export-recovery-design-2026-11-15.md` 与本轮探针记录）。
- 分享目标：扩展与主应用都要签名才能装、才能写同一个 App Group 容器。

⇒ 拿到证书之前，这两项都只能停在「协议与骨架齐了、装不上」的状态。

## 9. 复跑与维护

```bash
# 协议纯逻辑的单测（文件名严格性、TTL、时钟偏移、内容限额）
cd src-tauri && cargo test --features bluetooth incoming_share

# 读取端接线判据（落地区 → 队列 → 面板）
node --experimental-strip-types --test src/utils/incomingShareWiring.test.ts
# ↑ 含**三端协议一致性**（2026-11-16 补）：Swift / C# 写入端的 payload 字段名、
#   目录名、文件名形状、格式版本、id 同源，逐项对着 Rust 读取端核对。
#   这一类漂移两端各自都能编译，只有三端放一起比才抓得到。
```

## 10. 已修的协议漂移（2026-11-16）

- **Windows 写入端的 payload 字段名**：C# 的 `Payload` 属性原来是 `Url/Title/Text`
  （PascalCase），`JsonSerializer.Serialize` 默认就输出 PascalCase，而读取端
  `IncomingPayload` 带 `#[serde(rename_all = "camelCase")]` ⇒ 文件会被当成
  「三个字段都缺」直接拒收。现已用 `[JsonPropertyName("url"|"title"|"text")]`
  显式钉住小写名（`ShareTarget.cs`），并由
  `incomingShareWiring.test.ts::三端一致` 判据钉住 —— 去掉任一注解即红。

**这仍是源码层修复**：没有签名证书，两个写入端依旧产不出可安装的包（见 §7/§8）。

改动实现时同步本文哪一节：协议字段改 §3、限额改 §3.4、读取端校验改 §4、
平台骨架改 §6、红线改 §5。
