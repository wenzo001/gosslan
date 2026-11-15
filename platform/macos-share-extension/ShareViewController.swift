import Cocoa
import UniformTypeIdentifiers

/// 小院儿（`Gosslan`）的 macOS Share Extension。
///
/// ## 职责只有一件
///
/// 把用户分享的内容**写成一份落地区文件**（协议见
/// `docs/notes/system-share-target-design-2026-11-15.md` §3），然后结束扩展。
///
/// 它**不联网、不解析、不联系主应用** —— 主应用会自己捡起这份文件
/// （读取端在 `src-tauri/src/incoming_share.rs`，触发点是应用启动与窗口重新获得焦点）。
///
/// ## 为什么必须走「写文件」
///
/// 扩展与主应用是**两个进程**，彼此不能直接通信；两边唯一共有的通道是
/// **App Group 容器**（扩展写、主应用读）。扩展去调主应用的 HTTP 端口是另一条路，
/// 但那等于给任意进程一个可探测的入口 —— 本仓是 P2P 客户端，不开本地端口（理由见
/// `src-tauri/src/share.rs` 的文件头注释）。
///
/// ## 四条红线（与深链同一条）
///
/// ① **不静默发消息**：写进去的内容只进面板，用户必须显式选会话并点发送；
/// ② **不联网**：扩展不请求任何 URL；
/// ③ **不信任自称来源**：落地区文件不带来源字段；
/// ④ **拿不到容器就放弃**：绝不写到别处去（那等于把用户内容泄漏到别处）。
final class ShareViewController: NSViewController {
    /// App Group 标识。**必须与主应用 target 的 entitlement 一致**，
    /// 否则扩展写的地方主应用读不到（症状：分享完什么也没发生）。
    /// 换成你自己的 Team ID：`<你的 Team ID>.group.com.gosslan.app`
    private static let appGroupIdentifier = "<你的 Team ID>.group.com.gosslan.app"

    /// 落地区目录名（与主应用读取端一致）。
    private static let dropFolderName = "incoming-shares"

    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await writeIncomingShareAndFinish() }
    }

    private func writeIncomingShareAndFinish() async {
        let item = extensionContext?.inputItems.first as? NSExtensionItem

        var url: String?
        var text: String?
        var title: String?

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
        title = item?.attributedContentText?.string

        // 三个字段至少要有一个非空 —— 否则这就不是一次分享（主应用会按同一条规则拒收）。
        if url == nil && (text?.isEmpty ?? true) && (title?.isEmpty ?? true) {
            complete()
            return
        }

        guard let directory = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier
        )?.appendingPathComponent(Self.dropFolderName, isDirectory: true) else {
            // 拿不到 App Group 容器 ⇒ **放弃**（不要退回别处：写到别处等于把内容泄漏出去）。
            complete()
            return
        }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // 文件名 = `incoming-<32 位小写十六进制>.json`；那 32 位就是这次分享的 id
        // （**文件名是唯一真源**，主应用会核对文件内容里的 id 与文件名一致）。
        let identifier = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        var body: [String: Any] = [
            "v": 1,
            "id": identifier,
            "receivedAtMs": Int(Date().timeIntervalSince1970 * 1000),
            "payload": [
                "url": url as Any,
                "title": title as Any,
                "text": text as Any,
            ],
        ]
        // `NSNull` 不能进 JSON —— 把 nil 字段去掉（主应用按「字段可缺，但至少一个非空」判定）。
        if let payload = body["payload"] as? [String: Any] {
            body["payload"] = payload.filter { !($0.value is NSNull) }
        }

        guard let data = try? JSONSerialization.data(withJSONObject: body) else {
            complete()
            return
        }
        try? data.write(to: directory.appendingPathComponent("incoming-\(identifier).json"))
        complete()
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: [])
    }
}
