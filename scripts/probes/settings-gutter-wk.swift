// 设置窗口滚动几何探针 —— 跑在**真实 WKWebView**（就是 Tauri 在 macOS 上用的那套引擎）。
//
// 为什么需要它：`scrollbar-gutter: stable both-edges` 的行为在 Chromium 与 WKWebView 上不一致。
// WKWebView **只在真的出现滚动条时**才兑现两侧 gutter；内容不溢出时一个像素都不留。
// 于是"不滚的分区（关于）"比"会滚的分区（网络/存储）"卡片各宽 8px、标题竖线对不齐，
// 而 Chromium 一切正常 —— 这就是这条缺陷连续几轮"本地全绿、用户仍然看到"的原因。
//
// 用法（macOS，需要 dev server 在跑）：
//   swift scripts/probes/settings-gutter-wk.swift --port 1423
//   swift scripts/probes/settings-gutter-wk.swift --port 1423 --theme dark --shot /tmp/shots
//
// 退出码：0 = 两类分区卡片左/右缘逐像素相等；1 = 不等（打印差值）；2 = 页面没加载起来。
//
// 注意：这个 swift 壳子里的 WKWebView 拿不到正常的 rAF 节奏，Vue 的过渡会停在 enter-from
// （旧面板绝对定位叠着、新面板 opacity 0）。所以量之前先把过渡残渣清掉，得到"用户最终看到"
// 的那一帧；这不是产品行为，只是探针的取样方式。

import Cocoa
import WebKit

struct Opt {
    var port = 1423
    var width = 780
    var height = 600
    var theme = "light"
    var shot: String? = nil
}

var opt = Opt()
var argv = CommandLine.arguments.dropFirst().makeIterator()
while let a = argv.next() {
    switch a {
    case "--port": if let v = argv.next(), let n = Int(v) { opt.port = n }
    case "--width": if let v = argv.next(), let n = Int(v) { opt.width = n }
    case "--height": if let v = argv.next(), let n = Int(v) { opt.height = n }
    case "--theme": if let v = argv.next() { opt.theme = v }
    case "--shot": if let v = argv.next() { opt.shot = v }
    default: break
    }
}

// 会滚的分区（默认窗口高度下内容溢出） / 不滚的分区（用户报的「关于」） / 另一档
let sections = ["network", "about", "appearance"]

final class Nav: NSObject, WKNavigationDelegate {
    var done = false
    var error: String?
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { done = true }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { error = "\(e)"; done = true }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { error = "\(e)"; done = true }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let W = CGFloat(opt.width), H = CGFloat(opt.height)

let CLEAN = """
(() => {
  for (const el of [...document.querySelectorAll('[class*="settings-swap-leave"]')]) el.remove();
  for (const el of [...document.querySelectorAll('[class*="settings-swap-enter"]')]) {
    el.classList.remove('settings-swap-enter-from', 'settings-swap-enter-active', 'settings-swap-enter-to');
  }
  return true;
})()
"""

let READ = """
(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { left: +b.left.toFixed(2), right: +b.right.toFixed(2), width: +b.width.toFixed(2) }; };
  const sc = document.querySelector('.gosslan-scroll');
  if (!sc) return null;
  const cs = getComputedStyle(sc);
  const cards = [...document.querySelectorAll('[data-settings-rows]')].filter((el) => el.getClientRects().length);
  return {
    heading: (document.querySelector('header h2') || {}).textContent,
    scroll: {
      ...r(sc), clientW: sc.clientWidth, offsetW: sc.offsetWidth,
      barW: +(sc.offsetWidth - sc.clientWidth).toFixed(2),
      scrollH: sc.scrollHeight, clientH: sc.clientHeight,
      canScroll: sc.scrollHeight > sc.clientHeight + 1,
      padL: cs.paddingLeft, padR: cs.paddingRight,
      gutter: cs.scrollbarGutter, overflowY: cs.overflowY,
    },
    card: r(cards[0]),
    header: r(document.querySelector('header h2')),
  };
})()
"""

var rows: [(String, [String: Any])] = []
var failed = false

for section in sections {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.addUserScript(WKUserScript(
        source: "try{localStorage.setItem('gosslan.appearance','\(opt.theme)')}catch(e){}",
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: W, height: H), configuration: config)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: W, height: H),
                          styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = webView
    window.orderFrontRegardless()
    let nav = Nav()
    webView.navigationDelegate = nav
    webView.load(URLRequest(url: URL(string: "http://localhost:\(opt.port)/settings.html#/settings/\(section)")!))

    let deadline = Date().addingTimeInterval(40)
    while !nav.done && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    if let e = nav.error { print("LOAD_ERROR \(section): \(e)"); exit(2) }
    for _ in 0..<40 { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    webView.evaluateJavaScript(CLEAN) { _, _ in }
    for _ in 0..<6 { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }

    var json: [String: Any] = [:]
    webView.evaluateJavaScript("JSON.stringify(\(READ))") { result, error in
        if let e = error { print("JS_ERROR \(section): \(e)"); exit(2) }
        if let s = result as? String, let d = s.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            json = obj
        }
    }
    RunLoop.current.run(until: Date().addingTimeInterval(2))

    if let raw = try? JSONSerialization.data(withJSONObject: json),
       let line = String(data: raw, encoding: .utf8) {
        print("  \(section): \(line)")
    } else {
        print("  \(section): <no data>")
        failed = true
    }
    rows.append((section, json))

    if let shotDir = opt.shot {
        try? FileManager.default.createDirectory(atPath: shotDir, withIntermediateDirectories: true)
        let cfg = WKSnapshotConfiguration()
        cfg.rect = NSRect(x: 0, y: 0, width: W, height: H)
        var done = false
        webView.takeSnapshot(with: cfg) { image, _ in
            if let img = image, let tiff = img.tiffRepresentation,
               let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "\(shotDir)/\(opt.theme)-\(section).png"))
            }
            done = true
        }
        while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    }

    window.close()
}

// ---- 断言：卡片左/右缘必须与标题竖线、以及跨分区逐像素相等（阈值 0）----
var base: (String, Double, Double)?
for (name, d) in rows {
    guard let card = d["card"] as? [String: Any],
          let header = d["header"] as? [String: Any],
          let left = card["left"] as? Double, let right = card["right"] as? Double,
          let hl = header["left"] as? Double, let hr = header["right"] as? Double else {
        print("ASSERT_FAIL \(name): 缺 card/header 读数")
        failed = true
        continue
    }
    if left != hl || right != hr {
        print("ASSERT_FAIL \(name): card \(left)..\(right) ≠ header \(hl)..\(hr)（差 \(hl - left) / \(hr - right)）")
        failed = true
    }
    if let b = base {
        if b.1 != left || b.2 != right {
            print("ASSERT_FAIL \(name) vs \(b.0): card \(left)..\(right) ≠ \(b.1)..\(b.2)")
            failed = true
        }
    } else {
        base = (name, left, right)
    }
}

if failed {
    print("✗ 设置窗口滚动几何不一致（阈值 0）")
    exit(1)
}
if let b = base {
    print("✓ 卡片左/右缘与标题竖线逐像素相等：\(b.1)..\(b.2)（\(sections.count) 个分区一致）")
}
exit(0)
