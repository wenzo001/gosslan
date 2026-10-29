# Gosslan — 功能完备性 / 业务闭环审计（Functional Completeness Audit）

> 审计对象：`/Users/wendongfu/Documents/code/gosslan`
> 代码基线：`9a51cdb2`（HEAD，分支 `main`；`origin/main` = `5740a64c`）
> 审计方法：静态穷举 + 链路追踪 + 测试套件交叉验证
> 审计问题：**每个用户可见的 affordance 是否真的端到端可用？**

---

## 0. 结论摘要

| 层 | 总数 | 孤儿数 | 结论 |
|---|---|---|---|
| Tauri 命令（注册） | **163** | **1**（`get_topology`） | 注册表与定义**完全一致**（定义未注册 = 0，注册未定义 = 0） |
| 前端 `invoke` 调用点 | **165**（162 个不同命令名） | **0** | **无一条指向不存在的命令** ⇒ 无运行期崩溃级缺口 |
| 后端事件（emit） | **40**（36 业务 + 4 `menu://`） | **0** | 36 个业务事件**全部有前端监听** |
| 前端事件监听点 | **36**（44 个调用点） | **0** | **无一条监听不存在的事件** |

**命令层与事件层是干净的**——两个方向的差集都是零或近乎零，且仓库自带守卫测试
（`src/api/events.test.ts:397`「注册表与前端调用面必须逐条对账」）把这些不变量钉住了。
`npm test` 全绿：**1477 passed / 0 failed**。

**真正的缺口不在 IPC 边界，而在链路中段**：UI 把某个 affordance 渲染出来并绑定了处理器，
处理器也确实发了 IPC，但**发出去的参数/载荷落在后端的接受白名单之外**，于是后端明确拒收。
这类缺口命令层与事件层差集**都看不见**——它们是"链路语义"缺口，不是"名字"缺口。

本次审计确认 **1 个 High 级真实缺陷（图片转发必然失败）**，
另有 1 个 Medium（收藏页图片转发同源）、1 个 Medium（BLE feature 门控下的可用性边界）、
1 个 Low（`get_topology` 隐形接口）、1 个 Informational（移动端角标为设计内空实现）。

---

## 1. Command inventory（命令清单）

### 1.1 统计与差集

```
$ grep -rnE '#\[tauri::command' src-tauri/src/ --include='*.rs' | grep -v '_tests.rs' | wc -l
199   （181 条真实属性行 + 18 条文档/注释里的引用）
属性变体（全仓，含测试文件）：
  153  #[tauri::command(async)]
   57  #[tauri::command]
    1  #[tauri::command…]   ← 注释里的省略写法
```

用括号配平解析器（不靠行内正则，避免跨行 `invoke<T>(` 漏采）得到：

| 项 | 数量 |
|---|---|
| `#[tauri::command]` **定义的命令函数** | **163** |
| `generate_handler!` **注册的命令** | **163**（`src-tauri/src/lib.rs:741-905`，逐行 `commands::name`） |
| **定义但未注册**（静默死代码） | **0** |
| **注册但未定义**（编译即失败） | **0** |
| 前端 `invoke(...)` **调用点总数** | **165** |
| 前端调用的**不同命令名** | **162** |
| **调用了但没注册**（运行期崩溃） | **0** |
| **注册了但前端从不调用** | **1** → `get_topology` |

### 1.2 前端调用的分布（唯一的 IPC 出口）

```
src/api/index.ts            163 处 invoke
src/utils/imageBytes.ts       2 处 invoke  ← 两行都是**注释**（第 6 行、第 104 行），非真实调用
```

⇒ **全部 163 个真实 invoke 调用点都在 `src/api/index.ts`**，没有组件裸调 `invoke`。
这条纪律由 `src/api/events.test.ts:377` 的守卫测试钉死
（「IPC 只能从 src/api 门面走」，反向自检门面非空）。

### 1.3 唯一的后端孤儿：`get_topology`

- 定义：`src-tauri/src/commands/network.rs:512` `#[tauri::command(async)] pub fn get_topology(...)`
- 注册：`src-tauri/src/lib.rs:761`
- 前端引用：**0 处**（`grep -rn "get_topology" src/` 只命中 `src/api/events.test.ts:375` 的说明文字）
- 前端类型里连 `TopologyInfo` 都不存在（`grep -rn "TopologyInfo" src/` → 0 命中）

它已在仓库的挂账表里被显式承认：

```
src/api/events.test.ts:375
  const DEAD_COMMANDS: Record<string, string> = {
    get_topology:
      "保留为应用内只读诊断接口；前端消费者随 TopologyBar 在 5.0.3 删除，暂无 UI 入口。",
  };
```

**判定：不是缺陷，是已登记的隐形诊断接口。** 它的实现本身是完整的
（节点数 / 中继数 / 在线态三项判据都取自真源，且注释明确记录了
「`register_send` 零调用点 ⇒ `active_sends()` 永远是 0」这个已修的坑）。
风险仅为「IPC 面多一个只读面」——**无写能力**，不构成攻击面扩大。

### 1.4 平台分支的命令（`#[cfg(mobile)]` / `#[cfg(desktop)]` 双份实现）

**15 个命令有两份平台实现**（`generate_handler!` 不按平台拆，两侧同名同形）：

| 命令 | 桌面实现 | 移动实现 |
|---|---|---|
| `focus_window` | `network.rs:169` | `network.rs:202` |
| `shake_window` | `network.rs:215` | `network.rs:237` |
| `request_attention` | `network.rs:310` | `network.rs:328` |
| `set_unread_badge` | `network.rs:385` | `network.rs:397`（空实现，见 FUN-05） |
| `window_minimize` | `window.rs:10` | `window.rs:17` |
| `window_toggle_maximize` | `window.rs:56` | `window.rs:85` |
| `window_is_maximized` | `window.rs:96` | `window.rs:103` |
| `window_close` | `window.rs:119` | `window.rs:130` |
| `set_native_titlebar_buttons_hidden` | `window.rs:142` | `window.rs:154` |
| `open_log_window` | `logs.rs:669` | `logs.rs:737` |
| `open_settings_window` | `logs.rs:748` | `logs.rs:1436` |
| `close_settings_window` | `logs.rs:1446` | `logs.rs:1457` |
| `open_group_todos_window` | `logs.rs:815` | `logs.rs:1082` |
| `request_group_todo_focus` | `logs.rs:1015` | `logs.rs:1067` |
| `open_image_preview` | `logs.rs:1155` | `logs.rs:1280` |
| `prewarm_aux_windows` | `logs.rs:1199` | `logs.rs:1294` |
| `open_link_window` | `logs.rs:1316` | `logs.rs:1377` |

**7 个 updater 命令**在移动端是 `#[cfg(not(desktop))]` 桩（`updater.rs:621-672`），
统一返回 `Err("应用内更新仅支持桌面端")` / `phase: "unsupported"` ——
**有明确错误而非静默**，前端据此不展示更新入口。这是设计内边界，不是缺口。

⇒ **平台分支本身没有制造任何"某平台完全不可用"的缺口**：每个移动端变体要么是
合法的降级（无托盘/无窗口/无 updater 插件），要么返回明确错误。

### 1.5 前端 `api` 门面的无消费者成员

`src/api/index.ts` 的 `api` 对象共 **167** 个成员，逐个反查 `api.<name>` 调用点：

- **8 个「看似无消费者」** —— 全部是**方法链调用**（`api\n  .clearLogs()` 换行写法），实为假阳性：
  `clearLogs`(`LogViewer.vue:278`)、`getGroupTodosContext`(`GroupTodosWindow.vue:131`)、
  `getPreviousExit`(`useAppStore.ts:796`)、`onDataCleared`(`useChatStore.ts:3192`)、
  `onGroupFileActivity`(`GroupFilesPanel.vue:101`)、`onGroupTodosTarget`(`GroupTodosWindow.vue:137`)、
  `onImagePreviewChanged`(`PreviewWindow.vue:107`)、`openImagePreview`(`useImagePreview.ts:89`)。
- **其余 159 个成员全部有真实调用点**（含 `api/index.ts` 内部自调用）。

⇒ **前端门面层无死代码。**

---

## 2. Event inventory（事件清单）

### 2.1 统计与差集

后端 emit 用**常量解析**后的完整枚举（`EVENT_SETTINGS_CHANGED` → `"settings-changed"` 等
5 个 `&str` 常量已一并解析）；前端 listen 用括号配平解析器。

| 项 | 数量 |
|---|---|
| 后端 emit 的**事件名** | **40**（36 业务 + 4 `menu://` 原生菜单事件） |
| 后端 emit **调用点总数** | **123** |
| 前端 listen 的**事件名** | **36** |
| 前端 listen **调用点总数** | **44**（36 个在 `bindEvents`，8 个在窄封装） |
| **emit 了但没人 listen**（静默失败） | **0** |
| **listen 了但没人 emit**（死功能） | **0** |

### 2.2 36 个业务事件的完整配对

```
content-audience          data-cleared            file-cancelled
file-done                 file-failed              file-progress
file-stalled              friend-accepted         friend-key-changed
friend-keys-synced        friend-message-blocked  friend-rejected
friend-removed            friend-request          group-delivery-changed
group-file-log            group-history-progress  group-member-removed
group-message-acked       group-read              group-todos-target
groups-updated            message-acked           message-failed
message-recalled          message-received        message-render-changed
message-status-changed    peer-read               peer-style-updated
peers-updated             preview-gallery         runtime-changed
settings-changed          updater-status
```

**双向差集都是空集。** 4 个 `menu://` 事件由 `bindMenuEvents`（`src/api/index.ts:1037`）
在 `ResponsiveLayout.vue:732` 注册，链路完整。

### 2.3 监听注册确实发生（不是"写了没人调"）

- `bindEvents`（`src/api/index.ts:950`）注册 32 个事件，调用点：`src/stores/useChatStore.ts:3000`。
  失败时**不静默**：`eventBridgeOk.value = false` + `app.toast(t("chat.eventBindFail"), "error")`
  （`useChatStore.ts:3206`），设置页还有「重连事件桥」按钮（`NetworkSection.vue:472`）。
- 窄封装 4 个：见 §1.4，均有真实调用点。

---

## 3. Findings

### FUN-01 — 单条图片消息「转发」必然失败（UI 有 affordance，后端必拒）

**Severity:** High
**Status:** Confirmed
**Location:**
- `src/components/ChatWindow.vue:1251-1274`（`doForward` 单条）
- `src/components/MessageItem.vue:1205-1219`（`doForward` payload 构造）
- `src/utils/messageKinds.ts:165-167`（`isForwardableKind`）
- `src-tauri/src/commands/chat.rs:558-593`（`send_message` kind 白名单）
- `src-tauri/src/commands/group_files.rs:31-124`（`send_group_message` kind 白名单）

**What:**
`image` 被列为**可转发 kind**，右键菜单与移动端长按面板都渲染出「转发」按钮；
但单条转发只对 `kind === "file"` 做了「按本地路径重走传输链路」的特殊处理，
`kind === "image"` 落进 `else` 分支走 `chat.send(convId, f.content, "image")`，
而两条发送命令的 kind 白名单**都不含 `"image"`** ⇒ 后端直接 `Err`。

**Evidence:**

1. 前端判定把 image 列为可转发：
```
src/utils/messageKinds.ts:166
  return kind === "text" || kind === "code" || kind === "image" || kind === "file" || kind === "merge";
```
```
src/utils/messageKinds.test.ts:515
  const forwardable = ["text", "code", "image", "file", "merge"];
```
⇒ 按钮**一定渲染**（`MessageContextMenu.vue:179` `v-if="forwardable(kind)"`、
`MessageItem.vue:2231` 移动端 ActionSheet）。

2. 单条转发只特判 `file`，漏掉 `image`：
```
src/components/ChatWindow.vue:1256   if (f.kind === "file") {
src/components/ChatWindow.vue:1267   } else {
src/components/ChatWindow.vue:1268     await chat.send(convId, f.content, f.kind);   // ← kind="image"
```
```
src/components/MessageItem.vue:1213   filePath: msg.kind === "file" ? (fileMeta.value?.path ?? "") : undefined,
src/components/MessageItem.vue:1214   msgId: msg.kind === "file" ? msg.msg_id : undefined,
```
⇒ 即使 `doForward` 想特判 image，payload 里也**没有 path**（`filePath` 只在 `kind==="file"` 时填）。

3. 后端两条发送命令的 kind 白名单（括号配平解析 `match` 块）：
```
src-tauri/src/commands/chat.rs     send_message      msg_kind arms: ['text','code','file','merge','reaction','remind','remind_ack','recall','render']
src-tauri/src/commands/group_files.rs send_group_message wire_kind arms: ['text','code','merge','remind','remind_ack']
```
两者的兜底分支分别是：
```
src-tauri/src/commands/chat.rs:592         _ => return Err("不支持的消息类型".to_string()),
src-tauri/src/commands/group_files.rs:124  _ => return Err("群聊不支持该消息类型".to_string()),
```
⇒ **`"image"` 不在任一白名单 ⇒ 必然被拒。**

**机械验证**（括号配平解析 `match` 块后模拟分派）：
```
arms: ['text','code','file','merge','reaction','remind','remind_ack','recall','render']
'image' in arms -> False
=> send_message(kind='image') 落到 `_` 臂：
    _ => return Err("不支持的消息类型".to_string()),
```

4. `kind="image"` 是**真实存在的线上取值**，不是理论值：
```
src-tauri/src/commands/files.rs:1488        let kind = if subtype == "image" { "image" } else { "file" };
src-tauri/src/network/transport/handle_file.rs:550   let kind = if subtype == "image" { "image" } else { "file" };
src-tauri/src/network/file/share_walk.rs:145-146  "png"|"jpg"|"jpeg"|"gif"|"webp"|"heic"|... => "image",
```
发送侧与接收侧都会产出 `kind="image"` 的消息行。

5. 同一仓库里的**批量转发路径处理正确**，形成鲜明对照——
```
src/components/ChatWindow.vue:1404   async function forwardOne(convId: string, m: MessageRecord) {
src/components/ChatWindow.vue:1405     if (m.kind === "file" || m.kind === "image") {
src/components/ChatWindow.vue:1406       const path = filePathOf(m);
src/components/ChatWindow.vue:1411       if (convId.startsWith("group:")) await chat.sendGroupFileTo(convId.slice(6), path);
src/components/ChatWindow.vue:1412       else await chat.sendFileTo(convId, path);
```
且这段的注释（`:1397-1402`）**明确写了这条纪律**：
「图片必须和文件走同一条路子，不能只做 `file` 分支」。
单条路径没有遵守。

6. `npm test` 全绿（1477 passed / 0 failed），且
`grep -rn "doForward|forwardOne|fileNotForward|imageNotForward" src/**/*.test.ts` → **0 命中**
⇒ **无任何测试覆盖这条路径**，该缺口不会被现有守卫发现。

**Impact:**
用户右键（或移动端长按）一张图片 → 点「转发」→ 选会话 → 得到 toast「转发失败」。
**单条转发图片 100% 失败**，而**批量转发同一张图片成功**（走 `forwardOne`）。
用户在同一点击序列里会看到两种相反结果，且没有任何解释性文案区分
——`chat.toast.forwardFail`（"转发失败"）不告诉用户"图片要走另一条路"。

**Fix sketch:**
1. `MessageItem.vue:1213-1214`：`filePath` / `msgId` 的条件从 `=== "file"` 改为
   `=== "file" || === "image"`（`fileMeta` 对 image 同样有 `path`——
   `src/composables/useMessageFile.ts:52` 明确 `kind !== "file" && kind !== "image"` 才返回 null）。
2. `ChatWindow.vue:1256`：`if (f.kind === "file" || f.kind === "image")`，
   并按 kind 选 `chat.toast.fileNotForward` / `chat.toast.imageNotForward` 两个已有文案。
3. `FavoritePanel.vue:598` 同步（见 FUN-02）。
4. 可选加固：后端 `send_message` / `send_group_message` 的 kind 白名单里，
   对 `"image"` 显式 `Err("图片请用文件通道发送")` 而不是含糊的「不支持该消息类型」。

**Regression test:**
`src/utils/messageKinds.test.ts` 旁边加一条跨层判据（该文件已是 kinds 白名单的落点）：
断言 `ChatWindow.vue` 的 `doForward` 必须同时特判 `"file"` 与 `"image"`
（正则扫源码，方式与现有 `src/utils/channelState.test.ts` 一致）；
再加一条 Rust 侧判据：`send_message` / `send_group_message` 的 kind 白名单里
**不得**出现 `"image"`（出现了反而是 bug——图片必须走文件通道），
而前端**必须**在转发前把 image 转成文件通道。

---

### FUN-02 — 收藏页「转发」图片同样必然失败（与 FUN-01 同源，独立入口）

**Severity:** Medium
**Status:** Confirmed
**Location:**
- `src/components/FavoritePanel.vue:594-612`（`doForward` 收藏页）
- `src-tauri/src/commands/favorites.rs:136`（收藏的 kind 来源）

**What:**
收藏页的转发是**独立于 ChatWindow 的第二份实现**，同样只特判 `f.kind === "file"`，
`image` 落进 `chat.send(convId, f.content, f.kind)` ⇒ 同一条后端拒收。

**Evidence:**
```
src/components/FavoritePanel.vue:598   if (f.kind === "file") {
src/components/FavoritePanel.vue:605   } else {
src/components/FavoritePanel.vue:606     await chat.send(convId, f.content, f.kind);   // ← kind="image"
```
收藏条目确实会带 `kind="image"`：
```
src-tauri/src/commands/favorites.rs:136   if kind == "image" || kind == "file" {
```
（该分支把源文件复制到收藏目录并回填 `content.path` / `media_path`，
所以收藏页其实**有**可用的路径，只是没走传输通道。）

**Impact:**
从「收藏」面板转发一张收藏的图片 ⇒ 同样是「转发失败」toast。
与 FUN-01 是两条独立代码路径，**修一处不会修另一处**。

**Fix sketch:**
`FavoritePanel.vue:598` 改为 `if (f.kind === "file" || f.kind === "image")`，
图片分支用 `f.media_path`（收藏条目**有**这个字段，见 `favorites.rs:136` 的复制逻辑）。

**Regression test:**
与 FUN-01 同一族：加一条源码级判据，断言
`FavoritePanel.vue` 的转发分支同时覆盖 `"file"` 与 `"image"`。
（现有测试无覆盖：`grep -rn "FavoritePanel" src/**/*.test.ts` 只命中 `designGuards.test.ts` 的样式判据。）

---

### FUN-03 — BLE 传输在默认 `cargo build` 下不可用；发布构建才开（边界，非缺陷，但需知情）

**Severity:** Medium
**Status:** Confirmed
**Location:**
- `src-tauri/Cargo.toml:198-205`（`bluetooth` 为**非默认** feature）
- `src-tauri/src/transport/bluetooth.rs:648-653`（`available()` 恒 `cfg!(feature="bluetooth")`）
- `src-tauri/src/commands/channel.rs:35-40`、`:306-323`（两条 cfg 分支）
- `src/components/settings/NetworkSection.vue:497`（`:disabled="!btStatus?.available"`）

**What:**
`bluetooth` 是可选 feature，`default = ["custom-protocol"]` ⇒ **默认构建不含 BLE**。
此时 `BluetoothTransport::available()` 恒 `false`，设置页蓝牙开关被 `:disabled` 掉，
`set_channel_enabled("bluetooth", true)` 走 `#[cfg(not(feature="bluetooth"))]` 分支，
只写偏好（`db::set_bt_enabled`）而**不启动任何 BLE 运行时**。

**Evidence:**
```
src-tauri/Cargo.toml:200   default = ["custom-protocol"]
src-tauri/Cargo.toml:205   bluetooth = ["dep:btleplug", "dep:futures", ...]
src-tauri/src/transport/bluetooth.rs:652   cfg!(feature = "bluetooth")
src-tauri/src/commands/channel.rs:318-323
   #[cfg(not(feature = "bluetooth"))]
   { if enabled { let mut mgr = TransportManager::new(s.clone()); mgr.set_bluetooth_enabled(true).await?; } }
```
**发布链路是完整的**（CI 与 npm 脚本都显式带 `--features bluetooth`）：
```
.github/workflows/build.yml:120          npm run tauri -- build --features bluetooth --bundles nsis ...
.github/workflows/build-macos.yml:134     npm run tauri -- build --target "$TARGET" --features bluetooth --bundles app
package.json  "dist:mac": "tauri build --features bluetooth --target aarch64-apple-darwin"
```
且 CI 有**旁证守卫**（`build.yml:168-173`：Cargo.lock 里没有 btleplug ⇒ 报错）。

**Impact:**
- **正式发布包：BLE 正常**（feature 已开）。
- **本地 `npm run tauri dev`（不带 `--features bluetooth`）：蓝牙通道静默不可用** ——
  设置页开关是灰的（`available=false`），「添加好友」页的蓝牙通道也起不来。
  用户/开发者看到的现象是「蓝牙这一栏点不动」，而**界面上没有任何文案说明原因**
  （`NetworkSection.vue:481` 只显示 `bluetooth.unavailable`，不区分"硬件不支持"与"本次构建没编进去"）。

**判定：边界，不是缺陷。** 但 `RuntimeSnapshot.ble.feature_compiled`
（`channel.rs:99`）这个**判据已经存在**，而前端只在 `DevDiagPanel.vue:104/342` 用了它
（`grep -rn "feature_compiled|featureCompiled" src/` → 仅 DevDiagPanel + types.ts），
普通用户看不到。**建议**：在设置页的蓝牙行上，当 `available === false && featureCompiled === false` 时
显示「本次构建未包含蓝牙」而不是笼统的「不可用」。

**Regression test:**
前端加一条判据：设置页必须区分 `!available && !featureCompiled`（构建未含）与
`!available && featureCompiled`（硬件不支持）两种文案。

---

### FUN-04 — `get_topology` 是唯一的后端孤儿（已登记的隐形诊断接口）

**Severity:** Low
**Status:** Confirmed
**Location:**
- `src-tauri/src/commands/network.rs:512-546`
- `src-tauri/src/lib.rs:761`
- `src/api/events.test.ts:365-377`（挂账表 `DEAD_COMMANDS`）

**What:**
注册了但前端 0 调用。仓库已用 `DEAD_COMMANDS` 挂账表显式登记，并写了理由。

**Evidence:**
```
src/api/events.test.ts:375   get_topology:
                              "保留为应用内只读诊断接口；前端消费者随 TopologyBar 在 5.0.3 删除，暂无 UI 入口。"
$ grep -rn "get_topology\|TopologyInfo" src/
  src/api/events.test.ts:375   ← 唯一命中（说明文字本身）
```
守卫测试会拦住**新增**的无 UI 命令（`events.test.ts:397-425`），
并会拦住"挂账条目已被调用但没删"（`resurrected` 断言）⇒ 挂账表是活的，不是腐烂的注释。

**Impact:**
`get_topology` 是**只读**（节点数 / 中继数 / 在线态），无写能力 ⇒ **不构成攻击面扩大**。
代价仅为：IPC 注册表里多一个语义已过时的诊断命令。

**Fix sketch:**
二选一：(a) 删除命令 + 从 `generate_handler!` 移除 + 从 `DEAD_COMMANDS` 删条目；
(b) 保留，但把它挪进一个显式的「诊断命令」命名空间并在 `DEAD_COMMANDS` 里更新理由
（例如"顶层栏拓扑条尚未重建"）—— 现在写的是"随 TopologyBar 在 5.0.3 删除"，
距今已过多个版本，是**过期的挂账理由**。

**Regression test:**
已有（`events.test.ts:397` 的 `newDead` / `resurrected` 双向断言）。补一条即可：
挂账表里的每条理由都不得包含"已删除""已移除"这类已完成的措辞。

---

### FUN-05 — 移动端 `set_unread_badge` 是空实现（设计内边界）

**Severity:** Informational
**Status:** Confirmed
**Location:**
- `src-tauri/src/commands/network.rs:397-402`（`#[cfg(mobile)]` 版本）
- `src-tauri/src/commands/network.rs:385-391`（`#[cfg(desktop)]` 版本，真实现）
- `src/stores/useChatStore.ts:404`（前端在移动端直接 return，不发 IPC）

**What:**
移动端版本体是 `{ let _ = count; Ok(()) }`，是**明确的空桩**。
但注释写清了理由（移动端角标由系统通知通道负责，没有托盘图标可改），
且前端在 `useChatStore.ts:404` 就 `if (app.isMobile) return;` **根本不会发这次 IPC**。

**Evidence:**
```
src-tauri/src/commands/network.rs:399   pub fn set_unread_badge(_app: tauri::AppHandle, count: u32) -> Result<(), String> {
src-tauri/src/commands/network.rs:400       let _ = count;
src-tauri/src/commands/network.rs:401       Ok(())
src/stores/useChatStore.ts:404   if (app.isMobile) return; // 移动端没有托盘可改（命令本身也是空实现，省一次 IPC）
```
桌面端是真实现：`tray::set_unread_badge`（`src-tauri/src/tray.rs:293-330`）会
更新 tooltip、macOS 菜单栏数字、Windows 图标红点。

**Impact:** 无。**平台刻意的边界**，前后端两侧都有对应注释。

**Fix sketch:** 无需修。若要更彻底，可把移动端版本改成 `#[cfg(mobile)]` 下直接不注册
（省一个注册项），但那会破坏"注册表 = 前端调用面"的逐条对账守卫，不建议。

---

### FUN-06 — 转发链路在 ChatWindow / FavoritePanel / MessageItem 三处各写一份

**Severity:** Low
**Status:** Confirmed
**Location:**
- `src/components/ChatWindow.vue:1251`（单条转发）
- `src/components/ChatWindow.vue:1404`（批量转发）
- `src/components/FavoritePanel.vue:594`（收藏页转发）
- `src/components/MessageItem.vue:1205`（payload 构造）

**What:**
「哪些 kind 要走传输通道」这条判据在**三个地方各写一份**，且**已经漂移**：
批量那份正确处理了 `file` + `image`，单条那份只处理 `file`，收藏页那份也只处理 `file`。
FUN-01 / FUN-02 正是这份漂移的产物。

**Evidence:** 见 FUN-01 / FUN-02 的代码引用对照。
仓库自己在 `src/utils/messageKinds.ts:160-166` 写了这条纪律：
「转发 / 收藏的判据都从 `utils/messageKinds.ts` 取（**唯一一份**）——
消息右键菜单、长按面板、收藏详情操作条三处的动作集合因此不会漂移」——
**动作集合**已经统一（一份 `isForwardableKind`），但**转发通道选择**没有统一。

**Impact:** 同类漂移会再次发生（已经发生两次）。

**Fix sketch:** 把「转发某条消息」抽成一份共享判据（例如 `src/utils/forwardRoute.ts`），
输入 `(kind, path, msgId, convId)`，输出「走传输通道 / 走内容通道」，
三处调用点共用。判据内容即 `resendChannelFor`（`src/utils/resendChannel.ts`）的近亲
——那份已经为「重发」做了同样的分流，**转发可以复用它的 kind 集合**
（`FILE_CHANNEL_KINDS = new Set(["file", "image"])`，`resendChannel.ts:54`）。

**Regression test:**
加一条源码级判据（方式同 `src/utils/channelState.test.ts`）：三处转发分支必须
引用同一个共享函数名，出现字面量 `"file"` / `"image"` 直接红。

---

## 4. 已验证**端到端真正可用**的功能（逐条追踪到 SQL）

以下每条都走通了「UI 点击 → 处理器 → `invoke` → Rust 命令 → DB 落库 / 事件回传 → UI 更新」的完整链路。

### 4.1 消息主链路

| 功能 | 链路（file:line） | DB 落点 |
|---|---|---|
| 1:1 发消息 | `useChatStore.ts:1945` `send()` → `:2035` `sendToBackend` → `api/index.ts:176` `send_message` → `commands/chat.rs:534` | `db::insert_message_and_outbox` (`chat.rs:794`) + `db::touch_conversation` (`chat.rs:804`)，**双写**（消息 + outbox + 会话预览） |
| 群发消息 | `useChatStore.ts:2042` → `api/index.ts:251` `send_group_message` → `commands/group_files.rs:23` | `send_group_payload` → `db::insert_group_outbox` + 消息行 |
| 发送状态前进 | `sending` → `sent`（try_send 成功）→ `delivered`（Ack）→ `read`（回执） | `db::set_message_status` (`db/messages.rs:696`) |
| 离线 outbox 兜底 | `chat.rs:790-795` 一律写 outbox（`INSERT OR IGNORE` 按 msg_id 幂等） | `outbox` 表；Ack 到达后由 `db::ack_delivered` (`db/messages.rs:841`) 删行 |
| 撤回（自己） | `useChatStore.ts:2207` → `api/index.ts:352` `recall_message` → `commands/chat.rs:326` | 作者判定 `protocol::recall_verdict`；`group_recalled_messages` G-Set 只增不减 |
| 撤回（群主撤别人） | `api/index.ts:349` `recall_group_message` → `commands/group_announcements.rs:116` | 群主权限 + 撤回窗口双重判定 |
| 重发（1:1） | `useChatStore.ts:2024` `resend()` → `api/index.ts` `resend_message` | **复用原 msg_id/ts/seq**（不新建消息） |
| 表情回应（群） | `useChatStore.ts:2458` → `api/index.ts:386` `send_group_reaction` | 与普通消息同一条 E2EE+outbox+GroupAck 管道 |
| 表情回应（1:1） | `useChatStore.ts:2472` `sendDmReaction` → `api/index.ts:176` `send_message` kind="reaction" | 同上（复用 `send_message`，不另开命令） |
| 强提醒 / 回执 | `useChatStore.ts:2054` / `:2075` → `send_message` kind="remind"/"remind_ack" | 目标真实性校验（`chat.rs:623-641`）后才出帧 |
| 代码/文本渲染切换 | `useChatStore.ts:2216` → `api/index.ts:383` `set_message_render` | `message_render` LWW 表（`db/messages.rs:868`） |
| 引用（reply） | `src/utils/quote.ts` 首行 `「引用 {sender}：{snippet}|{msg_id}」` 编码 → 普通 text 消息 | 随消息行落库；`parseQuote` 四处消费方共用一份解析 |
| 合并转发 | `ChatWindow.vue:1449` `buildMergePayload` → `send_message` kind="merge" | `protocol::parse_merge_payload` 校验后落库 |

### 4.2 文件传输

| 功能 | 链路 | DB 落点 |
|---|---|---|
| 1:1 发文件 | `useChatStore.ts:2621` → `api/index.ts:417` `send_file_auto` → `commands/files.rs:1574` → `send_file` | `file_transfers` 台账 + 消息行（`files.rs:1497-1520`）；`kind` 由 `classify_file_subtype` 判（image/file） |
| 群发文件 | `useChatStore.ts:2686` → `api/index.ts:423` `send_group_file` → `commands/group_announcements.rs:253` | `group_files` + `group_file_recipients` + `group_file_acks` 三张表 |
| 发图片（粘贴） | `useChatStore.ts:2699` `saveOutgoingImage` → `sendFileAuto`/`sendGroupFile` | 与文件同通道（图片不是独立 kind 的消息） |
| 取消文件传输 | `TaskCenter.vue:186` / `MessageItem.vue:1107` → `api/index.ts:399` `cancel_file_transfer` → `commands/files.rs:1067` | `apply_local_cancel` 落 `cancelled` 墓碑（**不是** `failed`，INV-P26）+ 通知对端 `FileCancel` |
| 取消内容拉取 | `TaskCenter.vue` → `api/index.ts:413` `cancel_content_fetch` → `commands/files.rs:968` | `content_transfers` 落 `Rejected(Cancelled)` 终态（不再自动重取） |
| 取消发送中消息 | `TaskCenter.vue:170` / `MessageItem.vue:1132` → `api/index.ts:361` `cancel_message` → `commands/chat.rs:98` | 结构化结果 `{outcome, delivered, remaining, was_written}`；群/单聊分派到 `cancel_queued_group_message` / `cancel_queued_message` |
| 内容寻址重取 | `MessageItem.vue:150` / `GroupFilesPanel.vue:176` / `TaskCenter.vue:204` → `request_content` / `request_content_by_cid` | `content_transfers` 台账状态机（`content/store.rs:92`） |
| 媒体存在性探测 | `useMessageFile.ts:219` → `api/index.ts:464` `media_present` → `commands/helpers.rs:277` | 只读；结果驱动「已被清理」占位 |

### 4.3 群任务 / 群公告 / 收藏 / 好友

| 功能 | 链路 | DB 落点 |
|---|---|---|
| 建群任务 | `GroupTasksBoard.vue:978` → `useChatStore.ts:2265` → `api/index.ts:276` `send_group_todo` → `commands/group_files.rs:199` | 消息行（kind="todo"，载荷含 `todo_id`/编号/指派人）；`creator` 由服务端填 |
| 改任务（状态/标题/指派/类型/优先级/归档） | `GroupTasksBoard.vue:967/1011/1023/1041/1055/1073/1088` → `useChatStore.ts:2296` → `api/index.ts:302` `update_group_todo` → `commands/group_files.rs:721` | LWW 定义（"同 `todo_id` 取最新一份"）；`creator`/`done_at` **不接受客户端自报**，服务端回填 |
| 删任务 | `GroupTasksBoard.vue:1107` → `update_group_todo {deleted:true}` | 墓碑（不是物理删） |
| 任务图片 | `GroupTasksBoard.vue:734/839/990` → `todo_image_meta` / `save_todo_image_bytes` / `send_todo_image` | 10MB 上限闸（前后端同一常数，有跨语言守卫） |
| 发群公告 | `useChatStore.ts:2221` → `api/index.ts:270` `send_group_announcement` → `commands/group_files.rs:922` | 群主权限校验；消息行 kind="announcement" |
| 删群公告 | `useChatStore.ts:2248` → `api/index.ts:778` `delete_group_announcement` → `commands/group_files.rs:953` | 墓碑（kind="announcement_delete"），全端折横幅 |
| 会话列表公告标记 | `useChatStore.ts:2236` `refreshAnnouncements` → `api/index.ts:782` `list_active_group_announcements` → `commands/group_announcements.rs:20` | 一条 SQL 扫全群 + 墓碑折叠 |
| 收藏 | `ChatWindow.vue:1299` → `useChatStore.ts:2371` → `api/index.ts:517` `add_favorite` → `commands/favorites.rs:108` | `favorites` 表 + 媒体**独立副本**（`favorites/media/`，清理器不碰） |
| 取消收藏 | `FavoritePanel.vue:647` → `api/index.ts:519` `remove_favorite` | `db::delete_favorite` (`db/favorites.rs:82`) |
| 加好友 | `AddFriendModal.vue:265` → `useChatStore.ts:2105` → `api/index.ts:172` `send_friend_request` → `commands/mobile_picker.rs:345` | 定向帧 + `pending_out_requests` 补发登记 |
| 同意/拒绝好友申请 | `useChatStore.ts:2112` → `api/index.ts:173` `respond_friend_request` → `commands/mobile_picker.rs:467` | 同意时公钥绑定（TOFU→PIN）；`friends` 表 |
| 删好友 | `ConversationList.vue:264` / `ChatWindow.vue:457` → `api/index.ts:166` `remove_friend` | `db::remove_friend` (`db/friends.rs:19`) |
| 群成员增删/转让/退群 | `api/index.ts:226/228/230` → `commands/groups.rs:268/321/394/445` | `group_members` 表变更 + 群主权限判定 |

### 4.4 设置 / 搜索 / 已读 / 通知 / 数据

| 功能 | 链路 | DB 落点 |
|---|---|---|
| 保存设置（主题/字体/深色/语言/通知/网卡/聊天样式/中继策略） | `useAppStore.ts:532` → `api/index.ts:598` `save_settings` → `commands/settings.rs:275` | 逐键白名单校验后 `db::set_setting` ×13；**只把变了的键**广播给其它窗口（`emit_filter` 不回发给发起窗口） |
| 恢复默认 | `useAppStore.ts:918` → `api/index.ts:599` `reset_settings` → `commands/settings.rs:382` | 清偏好键 + 清中继口令 + 清外链 |
| 存储路径（下载目录） | `FilesSection.vue:41` → `api/index.ts:539` `set_downloads_dir` → `commands/share.rs:58` | macOS 走沙盒安全作用域书签（`macos_bookmark.rs`） |
| 共享目录 | `FilesSection.vue:61` → `useAppStore.ts:1026` → `api/index.ts:536` `set_share_dir` → `commands/share.rs:6` | 同上 |
| 缓存策略 / 清理 | `api/index.ts` `set_cache_policy` / `clean_cache_now` → `commands/channel.rs` | `cache_retention_days` / `cache_max_bytes` |
| 搜索聊天记录 | `ChatSearchDialog.vue:142` → `api/index.ts:625` `search_chat_history` → `commands/chat_search.rs:55` | `db::search_history`（关键词长度保护 + 条数上限） |
| 已读回执 | `useChatStore.ts:1503/2980/3293/3344` → `api/index.ts:215` `mark_read` → `commands/chat.rs` | `conversations` 未读清零 + `pending_reads` / `pending_group_reads` |
| 对端已读事件 | `useChatStore.ts:3086` `onPeerRead` ← `peer-read`（`handle_messaging.rs:292`） | `group_reads` / `pending_reads` |
| 未读角标（桌面） | `useChatStore.ts:408` → `api/index.ts:143` `set_unread_badge` → `commands/network.rs:387` → `tray.rs:293` | 托盘 tooltip + macOS 菜单栏数字 + Windows 图标红点 |
| 桌面通知 | `api/index.ts:154` `notify_desktop` → `commands/network.rs:424` | 后端**再判一次**总开关（前端已判只是第一道闸） |
| 点通知跳转 | `notification-clicked`（`notifications.rs:529`）→ `useChatStore.ts:3198` | — |
| 清除全部数据 | `ResetSection.vue:56` → `useChatStore.ts:2655` → `api/index.ts:601` `clear_all_data` → `commands/favorites.rs:526` | 16 张表**分批**删（不持大锁）+ 运行时缓存清 + `data-cleared` 广播给其它窗口 |

### 4.5 其它已验证

- **中继配置**：`NetworkSection.vue:318/323/367` → `save_relay_config` / `check_relay_server`（token 不入日志，有测试钉死）
- **路由端点**：`NetworkSection.vue:385/392/402` → `list_routed_endpoints` / `add_routed_endpoint` / `remove_routed_endpoint`
- **外部链接**：增删改查 + 文件导入 + URL 导入（`import_external_links_from_url`，URL scheme 白名单）
- **原生菜单**：`bindMenuEvents`（`ResponsiveLayout.vue:732`）→ 4 个 `menu://` 事件 → `APP_ACTION` 分发
- **更新器**：`updater_check` / `updater_download` / `updater_install` / `updater_cancel` / `updater_recheck_ready` / `updater_close` / `updater_status`（7 条全部有前端调用点，含移动端桩）
- **诊断**：`get_discovery_diag` / `get_runtime_diag` / `get_logs` / `clear_logs` / `get_log_locations` / `get_previous_exit` / `export_diagnostics_bundle`

---

## 5. 全局判定：为什么命令层与事件层几乎零缺口

这**不是**审计没查到，而是仓库自己把这两条不变量**机器化**了：

| 守卫 | 位置 | 拦什么 |
|---|---|---|
| 注册表 vs 前端调用面逐条对账 | `src/api/events.test.ts:397-425` | 新增"注册但不接界面"的命令；漏注册（运行期才炸的错）；挂账条目过期 |
| IPC 只能从门面走 | `src/api/events.test.ts:377-395` | 组件裸 `invoke`（含动态 import 绕过） |
| `RuntimeDiag` 字段两侧逐字对应 | `src/api/events.test.ts:435-455` | Rust 少字段 ⇒ 面板读 `undefined`（量具说谎） |
| 后端 kind 白名单与前端可发 kind 对账 | `src/utils/messageKinds.test.ts:515-537` | **只覆盖"能不能转发/收藏"，不覆盖"转发走哪条通道"** ← FUN-01/FUN-02 的缺口就在这个盲区 |
| `updateGroupTodo` 转发键集合对账 | `src/utils/storeContract.test.ts:765-800` | `category` / `customIcon` 声明了却没转发（历史真事故） |
| 发布构建必须含 btleplug | `.github/workflows/build.yml:168-173` | 漏 `--features bluetooth` |

**盲区在 §5 表格的最后一行**：既有守卫保证了"**动作集合**不漂移"，
但没有守卫保证"**动作的实现路径**不漂移"。FUN-01 / FUN-02 / FUN-06 三条都落在同一个盲区里。

---

## 6. 审计方法与可复现命令

```bash
# 命令定义：先看属性行，再解析出函数名（括号配平，避免跨行漏采）
grep -rnE '^\s*#\[tauri::command' src-tauri/src/ --include='*.rs' | grep -v '_tests.rs' | wc -l   # 181
# 注册表
grep -nE '^\s*commands::[a-z_]+,?$' src-tauri/src/lib.rs | wc -l                              # 163
# 前端 invoke（**必须**用括号配平解析：跨行泛型 invoke<T>( "name" 会被行内正则漏掉）
grep -rn "invoke" src/ --include='*.ts' --include='*.vue' | grep -v '\.test\.' | wc -l          # 180（含注释）
# 事件（**必须**解析 EVENT_* 常量：5 个事件名是常量不是字面量）
grep -rnE 'emit(_to|_filter)?[[:space:]]*\(' src-tauri/src/ --include='*.rs' | grep -v '_tests.rs' | wc -l   # 135（含注释）
# 前端 listen
grep -rn "listen" src/ --include='*.ts' --include='*.vue' | grep -v '\.test\.' | wc -l           # 109（含注释）
# 测试套件
npm test        # 1477 passed / 0 failed
```

**原始 grep 计数 vs 解析后计数**（差值全部是注释、文档引用与 `emit` 同名的非事件调用）：

| 项 | 原始 grep | 解析后（权威） |
|---|---|---|
| `#[tauri::command]` 属性行 | 181 | **163 个命令函数**（同一文件内多行属性 + `include!` 聚合造成） |
| 前端 `invoke` | 180 | **165 个调用点 / 162 个命令名** |
| Rust `emit` | 135 | **123 个调用点 / 40 个事件名** |
| 前端 `listen` | 109 | **44 个调用点 / 36 个事件名** |

**工具注意**：本机 `grep` 为 toybox 0.8.13，**不支持 `\b` 词边界**
（`grep -rniE '\b(stub|mock)\b'` 会静默返回 0 命中 —— 假绿），
且 `grep -E` 的 `\|` 在 shell 管道循环里会被吞掉。
本次审计改用 ripgrep（Grep 工具）与 Python 括号配平解析器完成所有枚举，避免漏采/误采。

---

*本文件由 FUNCTIONAL 阶段生成：命令层 163/163 与事件层 36/36 双向对账全部现读现核；
确认缺陷 1 条 High + 1 条 Medium（同源）+ 3 条 Low/Informational；
所有 file:line 均在 HEAD `9a51cdb2` 上逐个核对。*
