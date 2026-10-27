// WKWebView 宿主：把 `perf/wk-check.html`（或任何本地页面）放进**真正的 WKWebView** 里跑，
// 页面自己驱动、自己用 Image 信标回传读数 —— 宿主不读 JS、不加钩子，只负责"给它一个能跑 rAF 的窗口"。
//
// 为什么需要它（2026-10-27 实测）：
//   · Safari 开了「仅限 HTTPS」⇒ `http://127.0.0.1:...` 直接被 WebKitErrorDomain:305 拦掉；
//     换成 `localhost` 只放行到「此连接不安全」对话框，要人点一次「继续」；
//   · `safaridriver` 要人在 Safari 设置里勾一次「允许远程自动化」；
//   · 而 **WKWebView 是出货环境**（wry 用的就是它），它既不套用 Safari 的 HTTPS-Only，也不需要任何授权。
//
// 编译与用法：
//   swiftc -O -o /tmp/wk-host perf/wk-host.swift -framework Cocoa -framework WebKit
//   /tmp/wk-host 'http://127.0.0.1:5398/perf/wk-check.html?report=...' 60 1280x900
//
// 退码：0 = 页面加载完成并活到超时/被外部结束（读数走信标，不在这里）；
//       2 = 参数不对；3 = 超时（页面没跑完）；4 = 导航失败（把失败原因打到 stderr）。
import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 2, let url = URL(string: args[1]) else {
    FileHandle.standardError.write("usage: wk-host <url> [timeoutSec]\n".data(using: .utf8)!)
    exit(2)
}
let timeoutSec = args.count >= 3 ? (Double(args[2]) ?? 60) : 60
// 第 5 个参数：要在 `didFinish` 之后注入的 JS 文件（一次 `evaluateJavaScript`，页面自己回传读数）。
let scriptPath = args.count >= 5 ? args[4] : nil
// 第 4 个参数：窗口尺寸 `1024x720`（默认 1000x760）。**几何会影响这个夹具能不能复现夹取**
// （2026-10-27 实测：同一份 5.14.7 代码在 1000x760 下通过，在 Safari 那档窗口里不通过 ⇒ 尺寸必须能钉）。
var size = NSSize(width: 1000, height: 760)
if args.count >= 4 {
    let parts = args[3].lowercased().split(separator: "x")
    if parts.count == 2, let w = Double(parts[0]), let h = Double(parts[1]), w > 200, h > 200 {
        size = NSSize(width: w, height: h)
    }
}

final class Host: NSObject, WKNavigationDelegate {
    var failed = false
    var scriptPath: String? = nil
    var scriptDelaySec: Double = 2.0
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed = true
        FileHandle.standardError.write("导航失败：\(error)\n".data(using: .utf8)!)
        exit(4)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 只报告"页面起来了"；读数由页面自己回传。
        print("loaded: \(webView.url?.absoluteString ?? "?")")
        fflush(stdout)
        guard let path = scriptPath else { return }
        // 延迟一点再注入：vite 现编译依赖要时间；注入太早会 import 到半成品模块。
        DispatchQueue.main.asyncAfter(deadline: .now() + scriptDelaySec) {
            do {
                let src = try String(contentsOfFile: path, encoding: .utf8)
                webView.evaluateJavaScript(src) { _, err in
                    if let err = err {
                        FileHandle.standardError.write("注入脚本报错：\(err)\n".data(using: .utf8)!)
                    }
                }
            } catch {
                FileHandle.standardError.write("读不到注入脚本 \(path)：\(error)\n".data(using: .utf8)!)
            }
        }
    }
}

let app = NSApplication.shared
// .accessory：不占 Dock/菜单栏，但窗口会被真实绘制（否则 WKWebView 不跑 rAF，逐帧推进就永远走不完）。
app.setActivationPolicy(.accessory)

let cfg = WKWebViewConfiguration()
cfg.websiteDataStore = .nonPersistent()  // 每次从冷态开始，别让上一次的缓存混进来
let host = Host()
host.scriptPath = scriptPath
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: size.width, height: size.height), configuration: cfg)
web.navigationDelegate = host

let win = NSWindow(
    contentRect: NSRect(x: 80, y: 80, width: size.width, height: size.height),
    styleMask: [.titled, .closable],
    backing: .buffered,
    defer: false
)
win.title = "gosslan wk-check host"
win.contentView = web
win.orderFrontRegardless()

web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSec) {
    FileHandle.standardError.write("超时：页面在 \(Int(timeoutSec))s 内没结束（读数是否已回传，看接收端）\n".data(using: .utf8)!)
    exit(3)
}
app.run()
