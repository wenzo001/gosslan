# ⑨ 社区仓库复看结论（bitchat / tauri / lencx-ChatGPT / clash-verge-rev）

- Date: 2026-09-12
- 用户要求：「参考用户给的社区仓库代码（bitchat/tauri/lencx-ChatGPT/clash-verge-rev）**重新审视架构并说明结论**」。
- 本文是**四个仓库的总览与结论**（每个都写清：看了什么 → 采纳什么 → 拒绝什么 + 理由）；
  BitChat 的细节另见 `docs/notes/bitchat-comparison.md`，窗口架构的规范另见 `docs/adr/0018-window-architecture.md`。
- 证据标注：【克隆】= 本机 `git clone --depth 1` 到 `/tmp` 后读源码；【依赖】= 本仓库
  `target/cargo-home/registry/src/…` 里的依赖源码；【本仓库】= 我们自己的代码行号。

---

## 0. 一览

| 仓库 | 我们看的是 | 采纳 | 拒绝 / 我们做得不同的地方 |
|---|---|---|---|
| **bitchat** | 手机上的 `com.bitchat.droid` **1.7.4**（dex+manifest）+ 上游 HEAD（2.0.2）源码 | 多通道编排方向、中继不解析载荷、有界去重、有界分片 | 不兼容它的协议/UUID；它把身份塞进广播 service data 与全局分片字节上限**值得抄**（见对照文档 §4.2） |
| **tauri 2.11.5** | 我们实际解析到的版本源码 | `emit_filter` + `EventTarget::AnyLabel` 做「带载荷 + 排除发起窗口」的事件（ADR-0018） | 不启用 `unstable`（多 webview 在它后面）；不为多窗口引入共享文档 |
| **lencx-ChatGPT** | 上游 HEAD：Tauri 2.0.0-beta + `unstable` 多 webview + Rust 建窗 | 「配置里 `windows: []`、窗口全由 Rust 建」（与我们一致）；多 webview 作为**已知替代方案**记录 | 一个窗口里塞 3 个 webview（titlebar/main/ask）带来的平台 `cfg` 布局代码；`open_settings` 的 check-then-build（我们护栏 #34 明令禁止）；多个窗口共用一个 `index.html`（我们 ADR-0018 拒绝的入口反例） |
| **clash-verge-rev** | 由 ADR-0018 记录（单 `index.html` 服务所有窗口 + Rust `emit_to_window`） | 「后端为真相源 + 事件定向发」 | 「一个文档服务所有窗口」：我们三个窗口骨架差异极大（聊天三栏/设置分区/日志表格），共用一个文档会让每个窗口背别人的首帧成本 |

## 1. tauri 2.11.5：为什么「事件带载荷 + 排除发起窗口」是对的地基

- 【依赖】`tauri-2.11.5/src/webview/mod.rs`：`Window::add_child`（把多个 webview 挂进同一个
  OS 窗口 = 多 webview）的文档示例**整体挂在 `#[cfg_attr(feature = "unstable", doc = …)]` 下**
  ⇒ 这是**不稳定特性**；
- 【本仓库】`src-tauri/Cargo.toml:27` 只开 `features = ["tray-icon"]` ⇒ 我们**没有**引用不稳定 API，
  release 升级不会被它卡住；三个窗口各是独立 OS 窗口 + 独立文档（ADR-0018 §2.1）。
- 我们依赖的是**稳定**能力：`Emitter::emit_filter(event, payload, filter)` +
  JS `listen()` 注册成 `EventTarget::AnyLabel{label}` ⇒ 一次 emit 能精确送给「除发起窗口外的所有窗口」。
  这条是 ①（`settings-changed` 带补丁不回灌）与 ②（运行状态单快照单事件）能成立的前提。

**结论**：Tauri 侧没有新的、比现在更好的稳定机制；多窗口状态同步仍是「后端真相源 + 定向事件」最省心。

## 2. lencx-ChatGPT：三种「我们已经踩过 / 已经修过」的坑，反证我们的取舍

【克隆】`/tmp/lencx-chatgpt`（上游 HEAD，Tauri `2.0.0-beta`，`features = ["unstable","devtools"]`）：

1. **窗口全由 Rust 建**（`src-tauri/tauri.conf.json` 里 `"windows": []`，
   `src-tauri/src/core/setup.rs:31-48` 用 `WindowBuilder::new(&handle, "core")` 在
   `tauri::async_runtime::spawn` 里建）——**与我们一致**（我们同样只留骨架、窗口由 Rust 建单例）。
   这反过来验证了 ADR-0018 的「一窗一入口 + 后端建窗」方向。
2. **单窗口内多 webview**：`setup.rs:56-104` 建了 `main`/`titlebar`/`ask` 三个 `WebviewBuilder`，
   `setup.rs:115-130` 用 `win.add_child(..., LogicalPosition, PhysicalSize)` 手工摆位置，
   而且**只有 macOS 分支才加 titlebar/ask**（`#[cfg(target_os = "macos")]`），
   为了跨线程持有窗口还用了 `Arc<Mutex<Window>>`（`setup.rs:53-54`）。
   ⇒ 这是「一个 OS 窗口 + 多个 webview」的代价：**布局变成 Rust 手写坐标 + 平台分支**。
   我们不需要它（设置/日志是独立 OS 窗口，尺寸与生命周期本来就不同），
   所以**记录为替代方案、不采纳**；好处（省一个进程/共享外框）我们暂时用不上。
3. **打开设置 = 先查再建**（`src-tauri/src/core/window.rs:6-16`：`get_webview_window(label)`
   有就 show、没有就 `WebviewWindowBuilder::new(...).build()`）——正是我们**护栏 #34**
   拦住的那个 TOCTOU：连点两下时两次调用可能都查到 None，于是开出两个窗口
   （我们用户实测过「连点会开出第二个窗口」，修法是统一走 `ensure_aux_window`：单例 + 串行）。
4. **多个窗口共用一个 `index.html`**（`window.rs:12`）——正是引号里那条真实事故
   「第二次打开设置，窗口先刷成主聊天窗口、又立马变成设置界面」的成因；
   我们已改成「一个窗口一个 HTML 入口」，并有护栏 #33（窗口入口）+ #35（窗口骨架）盯着。

**结论**：lencx-ChatGPT 是**反例集合**：它的每一条「省事」做法，我们都恰好因为用户实测的
卡死/白屏/双窗口而反向修掉了。没有新东西要抄；它的多 webview 方案列为将来若需要
「同一窗口里嵌一块独立面板」时的备选（前提是接受 `unstable` 与平台分支）。

## 3. clash-verge-rev 与 bitchat

- **clash-verge-rev**：ADR-0018 §2.5 已记录——它「一个 `index.html` 服务所有窗口 + Rust
  `emit_to_window` 定向发」。我们**采纳**「后端真相源 + 定向发事件」，**拒绝**「一个文档服务所有窗口」
  （理由：三个窗口骨架差异大，共用一个文档会让每个窗口背别人的首帧成本）。
- **bitchat**：见 `docs/notes/bitchat-comparison.md`。核心三条：
  ① 中继语义我们已具备（`OpaqueExternal`，不解析载荷）；
  ② 真当中继需**双栈 BLE 外设**（它只认自己的 UUID），是加通道不是改协议 ⇒ 待用户决定；
  ③ 两条可抄：**广播里带 peerID**（扫描方不连接就知道对面是谁 ⇒ 去重键 + 广播层决定拨不拨）、
  **跨消息全局分片字节上限**。

## 4. 这四个仓库合起来说明了什么

1. **多窗口/多进程的状态同步没有捷径**：clash-verge-rev 用单文档 + Rust 定向发，
   lencx-ChatGPT 用多 webview + 平台分支，我们选独立窗口 + 独立文档 + 带载荷定向事件。
   三者共同点只有一条 —— **真相在后端、同步靠事件**；这正是 ADR-0018 定的规范。
2. **不稳定 API 是隐性成本**：lencx 为了多 webview 开了 `unstable`；我们不开，
   代价是我们得自己管窗口单例与首帧（已经用 `ensure_aux_window` + 每窗独立骨架解决）。
3. **BitChat 这类「邻居实现」值得抄的是传输层工程细节，不是产品形态**：
   广播带身份、全局资源上限、TTL 与签名解耦、TTL 分档 —— 都可直接落到我们的 BLE 代码里。

## 5. 未做 / 待用户决定

- **双栈 BLE 外设**（真的给 BitChat 当中继）：待决定；我建议默认关、设置里显式开。
- **广播带 peerID**、**全局分片字节上限**：建议做（改动小、命中当前 BLE 稳定性痛点），本轮未动。
- 本文只覆盖用户点名的四个仓库；iOS 端不涉及（本项目已停做 iOS）。
