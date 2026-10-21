# 流畅 / 行为正确 / 更像原生 —— 代码级台账（2026-10-16）

只读审计产物。所有数都是本轮在同一份工作树上现算的（命令附在各条后面），不改代码、不编译、不跑 verify。
优先级口径：**稳定 > 流畅 > 正确 > 原生体验 > 安全 > 可维护 > 可扩展 > 新功能**；主要平台 Windows(WebView2)。

> 说明：任务里点名的 `docs/acceptance/native-polish-backlog.md` **在本仓不存在**（`ls docs/acceptance/` 现算 6 个文件）。
> 原生感待办的真实归属是 **`docs/stability-roadmap.md` §12.6.1 的 N1–N29 表**（现算 29 行：
> `grep -cE "^\|\s*(\*\*)?N[0-9]" docs/stability-roadmap.md` → **29**），
> 交付状态汇总在 `docs/acceptance/native-experience-round-1.md`（已交付 13 / 判为不动 4 / 半开 2 / 开着 10）。
> 本文第 4 节的"已登记"一律指这张表。

---

## 1. 首帧与滚动

### 1.1 启动链路（关键 CSS / 骨架屏 / 首屏条数 / 图片通道）

| 环节 | 证据 |
|---|---|
| 首帧决策早于样式 | `index.html:11-12` 两个占位 `<!-- GOSSLAN_THEME_BOOT -->` / `<!-- GOSSLAN_SKELETON_CSS -->`，由 `vite.config.ts` 的 `gosslan:inline-boot` 插件**内联**替换（`index.html:7-10` 注释写明"必须早于样式与模块脚本"）。三个窗口共用同一份 |
| 骨架屏 | 结构照抄真实布局的 HTML 骨架在 `index.html:18-77`（caption + rail + 6 行会话 + 5 个气泡 + 输入条），样式在 `src/boot/skeleton.css`（16.9 KB） |
| 骨架撤除 | `src/boot/boot.ts:93-107` `dismissBoot()`：按 `.boot-skeleton` 类枚举（`:96-102` 明确记录了"曾经按 id 枚举导致第 5 个窗口的骨架永久盖住整页"这个坑）。触发三条：入口挂载、`gosslan:app-ready`（`src/App.vue:98` 在 `app.init()`+`chat.init()` 的 **finally** 里派发）、**5000 ms 兜底定时器**（`boot.ts:111`） |
| 首屏取多少条 | `src/stores/useChatStore.ts:1216` `PAGE_SIZE = 100`；`:1349` `api.getLatestMessages(convId, PAGE_SIZE)` —— **冷加载一次 IPC**（原先 count+offset 两轮串行，`:1344-1348` 写明改因）。这条由 `src/utils/storeContract.test.ts:333,346` 钉住（禁止再出现第二页 IPC） |
| 消息缓存上界 | `useChatStore.ts:1217` `MAX_PAGES = 10`、`:1265` `MAX_CACHED_CONVS = 8` ⇒ 单会话 ≤1000 条、整表 ≤8 会话（`:892`、`:1254` 有账） |
| 图片通道 | **blob，不是 HTTP range**。`src/utils/filePreview.ts:3` "图片走原始字节 → Blob → objectURL（绝不把 Base64 塞进 Vue）"；字节来自 `invoke("read_file_preview")`（`src/api/index.ts:297`）+ 后端 `src-tauri/src/commands/helpers.rs:189-202`（`max_bytes` 上限 15 MiB，超限返回 `TOO_LARGE`）。气泡侧再压一层缩略图：`src/utils/imageThumb.ts:21` `THUMB_MAX_WIDTH = 416`、`:58` `THUMB_MIN_SOURCE_BYTES = 64 KiB`、GIF/SVG 豁免（`:43-50`） |
| blob 生命周期 | `filePreview.ts:7-13`：objectURL 归模块缓存所有，**消费者不许 revoke**（这条是真根因）；缓存按**累计字节**封顶 60 MiB（`:37`），不是按条数（`:15-26` 有实测理由） |

### 1.2 长列表渲染：只有聊天列表是虚拟的

`grep -rln "VirtualList.vue" src --include="*.vue"` → **1 个文件：`src/components/ChatWindow.vue`**（`:10` import，`:1391-1432` 使用）。

- 聊天区：`src/components/VirtualList.vue` —— 前缀和 + 二分（`:64-71`、`:104-120`）、`overscan=6`（`:30`）、滚动 rAF 节流 + passive（`:255-261`、`:508`）、`ResizeObserver` 实测高度覆盖估算（`:133-151`）、实测表 FIFO 上限 2000 条（`:49-50`）、容器尺寸 `ResizeObserver`（`:290-302`，N9 修的那一格）。
- DOM **有界**（聊天）：可见行 = 视口 + 2×overscan；`perf/probe.mjs` 在 N9 那格的读数：改前 `renderedRows=20000 / virtualizationOK=false`，改后 **12 行 / true**（`docs/stability-roadmap.md` N9 行）。
- DOM **无界**（其余全部列表）：`src/components/ConversationList.vue:452` `v-for="c in listConversations"`（无虚拟化、无 slice）、`:523`/`:544` 好友分组；`src/components/GroupMemberPanel.vue:274` `v-for="id in group.members"`；`src/components/FavoritePanel.vue`（5 处 v-for）；`src/components/LinksList.vue`；`src/components/search/ChatSearchDialog.vue`（4 处）。
  - 唯一被后端容量兜住的是日志：`src-tauri/src/logging.rs:126` `MAX_MEM_LOGS = 500`，所以 `LogViewer.vue:363,510` 的 `mergedRows` 最坏 500 行。会话/好友/群成员/收藏**没有等价的行上限**。
  - 补偿手段：会话行与好友行有 `v-memo`（`ConversationList.vue:454`、`:525`），聊天行**没有**（`grep -rn "v-memo" src` 只在 ConversationList 与一处测试命中）——`docs/stability-roadmap.md` N21 明写"`v-memo` 判为不做"，理由记录在案。

### 1.3 上拉 / 下拉 / 引用跳转 / 锚点定位

| 交互 | 位置 |
|---|---|
| 触顶翻页（上拉） | `VirtualList.vue:252` `if (el.scrollTop < 60) emit("loadMore")` → `ChatWindow.vue:1398 @load-more="onLoadMore"` → `useChatStore.ts:1369-1396` `loadMoreMessages`。两道闸（`loadingMore` 单飞 + `historyTops`）与"为什么必须是**并入在飞**而不是直接 return"写在 `:1370-1386` |
| prepend 锚定 | `VirtualList.vue:403-420`：按"旧首条 key"在新数组里的下标补偿同样高度，`flush: "post"` |
| 下拉刷新 | **未实现**（N8，`docs/stability-roadmap.md`：全仓无 `pullToRefresh`；判为"新增手势 = 新功能，按§十八不做"） |
| 引用跳转 | `ChatWindow.vue:763-793` `locateMessage()`：找不到就**循环翻页最多 20 次**（`:769-776`），翻页后两次 `nextTick` 再滚（`:784-787`） |
| 搜索/通知锚点 | `useChatStore.ts:1127` `locateMessageInConv`（循环上限 `MAX_PAGES`，`:1135`）+ `ChatWindow.vue:797` 监听 `chat.locateRequest` |
| 未读定位 | `ChatWindow.vue:638-649` 监听 `chat.unreadJump` → `scrollToIndex(index,"top")` + `setPinned(false)`；坐标系口径统一在 `:621-630`（用**过滤后**的下标） |
| 落定的"第二次才对" | `VirtualList.vue:328-395` `pendingJump` + `pollJump()`：**100 ms 轮询、最多 10 次 / 1.5 s 窗口**，按 **msg_id 而不是下标**找节点（`:363`）；卸载时显式清表（`:436-441`） |

### 1.4 「一次消息洪水触发多少全量重排」——现算账

先给好消息：**深度监听 0 处**。`grep -rn "deep: true" src | grep -v test | wc -l` → **0**。
入口也**不是**每条 IPC 一次渲染：`message-received` 每条一次（§2.2），但被 rAF 队列吃进 `useChatStore.ts:635-673`（`pending[]` + `scheduleFlush` `:647-664`，后台窗口退回 `setTimeout`，另有 1 s 强制冲刷安全网 `:658-660`）。所以洪水在一帧内塌成 **1 次 flush**。

代价被搬到了 flush 内部。一次 `applyIncoming(batch)` 固定要做下面这些**与整份缓存成正比、与 batch 大小几乎无关**的全表活：

| # | 全表遍历 | 证据 |
|---|---|---|
| 1 | 跨**所有**会话再扫一遍建 `curStatus` | `useChatStore.ts:679-681`（最坏 8×1000 = **8000 行**） |
| 2 | 跨**所有**会话再扫一遍建 `existingIdsByConv` | `:693-696` |
| 3 | 每个命中会话 `new Map(existing.map(...))` | `:731` |
| 4 | `mergeMessages` 内部第 3 次遍历 + 排序 | `:749` → `src/utils/messages.ts:15-27` |
| 5 | 缓存收缩 | `:753` `enforceMessageCacheBound()` |
| 6 | 任务行折叠 | `:710` `mergeIncomingTodoRows` |

然后在渲染侧，`chat.messages[convId]` 一旦被换引用，**7 个 computed 各自重跑一遍整表**
（`grep -n "chat.messages\[convId\]\|chat.messages\[chat.activeConv" src/components/ChatWindow.vue` → 10 处命中，其中 computed 7 处）：

| # | computed | 位置 | 每条要不要 `JSON.parse` |
|---|---|---|---|
| A | `messages`（时间线过滤） | `ChatWindow.vue:70-72` | 否 |
| B | `reactionMap` = `foldReactions` | `:376-380` | 是（`src/utils/reactions.ts:60` + `JSON.parse` 1 处） |
| C | `reminderMap` = `foldReminders` | `:386-390` | 是（`src/utils/reminders.ts:92,106`） |
| D | `todoLive` = `foldTodos`+`todoLiveMap` | `:424-428` | 是（`src/utils/todos.ts:548`） |
| E | `announcement`（手写全表扫 + 两处 parse） | `:437-465` | 是 |
| F | `pinnedIds` = `foldPinned` | `:530-534` | 是（`src/utils/pins.ts:33`） |
| G | `pinnedItems`（`.map(id ⇒ list.find(...))`） | `:537-544` | 否，但 **O(置顶数 × n)** |

**结论（一帧一次洪水的固定成本）**：≈ 3 次整表扫描（store）+ **7 次整表 O(n) 折叠**（组件），其中 **5 次逐行 `JSON.parse`**；
`grep -c "JSON.parse" src/components/ChatWindow.vue` → **6**，四个 fold helper 各 1 ⇒ 每条消息在每次消息变化时被解析 **约 5 次**，且**没有任何 payload 解析缓存**
（`grep -rn "payloadCache\|WeakMap" src/utils/*.ts` 非测试 → 0 命中）。100 条缓存 = 每帧 ≈ 500 次 `JSON.parse`；1000 条满页 = 每帧 ≈ 5000 次。

> 对照：图片相册那份列表**已经刻意改成命令式快照**，理由与读数写在 `ChatWindow.vue:248-259`（"原先是 computed ⇒ 每条消息都要付一次 O(n) 扫描 + 解析"）。
> 也就是说上面 B–G 六条是**同一条已知结论的未跟到位移**。

重排/重渲染链（一次 flush 内可重复的轮次）：
`items` 换引用 → `VirtualList.vue:403` watch（`findIndex` O(n)）+ `:447` watch（`scheduleRemeasure`）→ rAF 实测可见行（`:153-169`）→ `commitHeight` 每次 `>1 px` 偏差就 `heightVersion++`（`:97-100`）→ **`offsets` 整表前缀和重建 O(n)**（`:64-71`）→ `totalHeight` watch（`:483-490`）→ `nextTick` 再滚一次 → `ChatWindow.vue:656-694` 的 append watch → `scrollToBottom()` → 又一轮 `computeScrollState`。
图片加载期间这个"实测→前缀和→钉底"循环会**跑好几轮**。N10 已经把"整表前缀和每帧重算"量过毫秒并**判定不动**（`docs/stability-roadmap.md` N10，量具 `perf/run.mjs` / `perf/vlist.ts`）。

其它两处小形状：
- `VirtualList.vue:516` key 是 `msg_id ?? v.index` —— 正常消息有 msg_id，**兜底会退化成 index**。
- 全仓 `v-for` **73 处 / 39 个 `.vue`**（`grep -rn "v-for=" src --include="*.vue"`），其中**下标当 key 的 9 处**：
  `conversation/ConversationListItem.vue:213`、`settings/ChatStyleSection.vue:174`、`FavoritePanel.vue:747,785`、
  `message/MessageContentModal.vue:90`、`message/MessageTextBubble.vue:198`、`message/MergeCard.vue:59`、
  `message/MentionText.vue:60`、`message/MergeCardModal.vue:201`。这 9 处都是**段级/卡片级小列表**（表情段、linkify 段、合并卡片行），不是会话/消息主循环。

---

## 2. 卡顿面

### 2.1 渲染路径里的同步重活

| 项 | 读数 |
|---|---|
| `highlight.js` | **不是全量列表**，但每条代码气泡付两遍：`src/components/CodeBlock.vue:69-76` `detectedLang` 先 `hljs.highlightAuto(code, AUTO_LANGS)`（`AUTO_LANGS` **15 个语言**，`:64-67`），随后 `:86-94` `html` 再 `hljs.highlight(...)` 一遍。13 种语言在模块顶层**eager 注册**（`:4-17`、`:38-56`）。`MessageCodeBubble.vue:44-50` 的截断**只做在 CSS 容器上**（`overflow-hidden` + 固定 `CODE_CLAMP_HEIGHT`），送进 highlight 的仍是**整段原文** |
| linkify / emoji 再切分 | `src/components/message/MessageTextBubble.vue:101-115`：每条气泡 `splitEmoji` + 对每个文本段 `linkify`（正则）。`computed` 缓存**只在同一组件实例内有效**，而 VirtualList 会把滚出视口的行卸载 ⇒ 同一条消息每次回视口都重切一遍。同样的切分还在 `message/MentionText.vue:44`、`message/MessageContentModal.vue:40` |
| 每行模板里的函数调用 | `ChatWindow.vue:1407` 每个可见行调一次 `chat.groupReaderIds(activeGroupId, item.ts)` ⇒ `useChatStore.ts:1044-1053` 每次 `Object.entries(groupReads[gid])` + `filter` + `map`。一屏 ~30 行 × 群已读者数，每帧重建 N 个数组。空数组那侧已经收口成**共享冻结常量**（`useChatStore.ts:1050-1052` 的 `EMPTY_STRING_LIST`，理由与读数写在 `src/utils/emptyList.ts:10-11` 与 N21：**一帧 27.6 → 16.6 ms**） |
| 大数组 filter/map/sort 每次重建 | §1.4 那 7 个 computed；外加 `ConversationList.vue:96-100` `filteredFriends`（每次搜索词/好友表变就 `filter` + `toLowerCase`）、`:112` `friendGroups` 分组；`LogViewer.vue:38` `[...logs].reverse()` 每次整表拷贝 |
| 阴影/模糊导致滚动贵 | **本仓不成立**，已核过并登记（N24，`docs/stability-roadmap.md`）——不要再去"修"它 |

### 2.2 后端 emit 粒度

现算（`find src-tauri/src -name "*.rs" ! -name "*_tests.rs" -exec grep -oE "\.emit(_to\|_filter\|_all)?\(" {} +`）：

- **emit 调用点 = 101**（`emit(` 105 处含 `emit_filter` 3 处定义/调用差，去测试后 101）。分布最密的三个文件：`network/transport/relay_file.rs` **11**、`network/transport/gossip.rs` **6**、`network/file/send.rs` **6**、`commands/files.rs` **6**。
- **事件名种类 = 37**：29 个字面量名（`message-received`、`message-acked`、`group-message-acked`、`groups-updated`、`peers-updated`、`file-progress/done/failed/stalled/cancelled`、`friend-*` 6 条、`peer-read`、`peer-style-updated`、`content-audience`、`message-recalled/failed/status-changed`、`group-member-removed`、`group-key-received`、`group-file-log`、`group-todos-target`、`preview-gallery`）+ 4 个 const（`settings-changed`、`runtime-changed`、`data-cleared`、`notification-clicked`，定义在 `state.rs:151-162`、`notifications.rs:409`）+ 4 条 `menu://`（`menu.rs:32-35`）。
- **确有"每条消息一次 IPC"**：`grep -rn '"message-received"' src-tauri/src --include="*.rs" | grep -v _tests` → **11 个 emit 点**，每个都是单条记录：`network/transport/handle_messaging.rs:149`、`gossip.rs:899`、`group_file.rs:138,467`、`relay_file.rs:478`、`handle_file.rs:523`、`network/file/send.rs:82`、`commands/window.rs:306`、`commands/files.rs:715`、`commands/group_announcements.rs:372`、`commands/share.rs:229`。
  前端收口只有一处：`src/api/index.ts` 的 `listen<...>(` **37 个订阅点**（`grep -c "listen<\|listen(" src/api/index.ts` → 37；`grep -c "invoke<" ` → 132），`onMessage` → `useChatStore.ts:2444-2445` → `enqueueMessage` ⇒ **靠 rAF 队列而不是靠批处理事件**。这是"IPC 放大 + 前端去抖"的形状，不是"批处理"。
- 已经有节流的：**`file-progress` 每秒最多一条**（`state.rs:799-805` `last_progress_at`，用在 `relay_file.rs:111,203`、`handle_file.rs:259,387`、`file/send.rs:509,614` 等 10 个点）。
- 已经有比对去抖的：**`peers-updated`**（`useChatStore.ts:2402-2414`：`mergePeerList` 没变就不写表（`:2405`），注释直接写"这个事件最多每秒 3 次：不比对就直接换表 = 每 333 ms 把整屏消息行重画一遍"；拓扑刷新再节流 1 s（`:2414` `refreshTopologyThrottled`，实现 `:1082`））。
- 没有批处理的：**`groups-updated` 12 个 emit 点**（`grep` 计数最高的一条），每次都是"整表重来"语义；群多/成员操作密集时它是第二个放大器。

---

## 3. 输入正确性

| 行为 | 实现位置 | 测试（**核对断言，不看文件名**） |
|---|---|---|
| 中文 IME 组合输入 | `src/utils/ime.ts:42-59` 三条互补判据（自跟踪 `composing` / `isComposing`\|`keyCode 229` / **compositionend 后 80 ms 窗口内只对 Enter 生效**，`IME_COMMIT_WINDOW_MS=32→80`）；接线 `src/composables/useImeEnterGuard.ts:25-41`；调用点 `src/components/chat/MessageComposer.vue:222-243`（`imeKey(e)` 提前 return），模板 `:738-739` 挂 `@compositionstart/@compositionend` | **真判行为**：`src/utils/ime.test.ts` 7 条 `test()`，`:9-10` 判 composing、`:14-15` 判 229、`:18-27` **复现"WKWebView compositionend 先于 keydown"这条真实缺陷**、`:29-34` 判闭区间边界（`<= windowMs`）与自定义窗口、`:36-38` 判"从没组合过/很久之前"必须放行、`:41-51` 判 Backspace/a/ArrowUp/空格在窗口内**不许**被吞 |
| Enter 发送 / Shift+Enter 换行 | `MessageComposer.vue:275-284`：`Shift+Enter` → `document.execCommand("insertLineBreak")`（`:276-277` 写明为什么不用浏览器默认 `insertParagraph`）；纯 Enter → `send()` | **无组件级测试**。`grep -rn "Enter" src/**/*.test.ts` 只出现在 ime/shortcuts 的纯函数用例里 |
| **Ctrl+Enter 发送** | **未实现**（`matchAppShortcut` 甚至把 Enter 判为不处理：`src/utils/shortcuts.test.ts:36-40` 明确断言 `key:"Enter"` → `null`；`MessageComposer.vue:281` 只看 `shiftKey`）。也没有"Enter/Ctrl+Enter 可切换"的开关 —— 属新设置项，本轮不做 | — |
| Esc 关窗 / 关浮层 | 7 个入口：`ChatWindow.vue:917`（退多选，带 `e.defaultPrevented` 让位）、`MessageComposer.vue:268`（关 @ 选择器）、`EmojiPicker.vue:90`、`ConversationList.vue:156`（搜索框）、`NavRail.vue:65`、`ContextMenu.vue:69`、`message/ImageLightbox.vue:263`（关看图）、`SettingsWindow.vue:88`。应用内弹窗走 HeadlessUI `Dialog @close`（`BaseModal.vue:107`）自带 Esc | **判形状不判键盘**：`src/utils/designGuards.test.ts:2256-2357` 有 8 条针对 `findFloatingLayerWithoutEscape` 的用例（含"读不出就报"与两类假报回归 `:2317,2331`）。真正的键盘通路只在**运行时探针**里判（`scripts/check-ui-runtime.mjs --only=emoji/--only=search`，见 N1/N2）。**缺口：`LogViewer.vue`、`GroupTodosWindow.vue`、`window/AuxWindowShell.vue` 三个文件 `keydown`/`Escape` 零命中** ⇒ 日志窗与群任务窗按 Esc 不关 |
| 退格删除引用 | **未实现**。引用的取消入口只有一个 × 按钮：`MessageComposer.vue:693-707`（`@click="emit('close-quote')"` → `ChatWindow.vue:1519`）。全仓 `grep -rn "Backspace" src --include=*.vue --include=*.ts \| grep -v test` → **1 处**：`MessageComposer.vue:246`，判的是 **@ token 的联删**（`deleteMentionBeforeCaret`），与引用无关 | 无 |
| 剪贴板粘贴图片 | 分类纯函数 `src/utils/clipboard.ts:20-30`（优先级：**图片位图 > 真实文件路径 > 纯文本**；`:25-28` 写明 Windows 11 `Win+Shift+S` 会同时带一个 CF_HDROP 临时 PNG，判反了就是"截图有时发得出去有时发不出去"）；接线 `MessageComposer.vue:566-572+`；发送 `ChatWindow.vue:716-731`（`convId` 在任何 `await` **之前**取，`:717-719` 记着 4.1-5 那次"图片发给了另一个人"） | **真判分类**：`src/utils/clipboard.test.ts` 4 条：`:12-15` types 只有 `image/png` 无 Files 仍判图片、`:17-20` **items 为空、只经 files 暴露**（WKWebView）仍判图片、`:22-24` 纯文本、`:26-29` 图片**绝不**落文本分支 |
| 拖拽入窗 | `ChatWindow.vue:1121-1149`：`getCurrentWebview().onDragDropEvent`（注释 `:1097-1098` 写明 HTML5 drag 拿不到真实路径），`isOverChatArea` 按 DPR 换算命中（`:1105-1113`），卸载时 `dragDropDisposed` 补退订（`:1139-1148`）；提示层 `:1358-1367` + `pointer-events-none`。第二处订阅在 `GroupTasksBoard.vue:731-750`，两条靠 `app.boardDropActive` **互斥**（`ChatWindow.vue:1118` 读它；`:720-727` 写明不置起就是"同一份文件既进任务又被当聊天附件发出去"） | 形状测试：`src/utils/taskImageFlow.test.ts:86` 断言 `onDragDropEvent` 订阅不许被整段删掉。**没有命中区/互斥的行为测试** |
| 快捷键表 | 表 = `src/utils/shortcuts.ts:23-40`：`,`→设置、`f`/`k`→搜索、`n`→加好友；alt/shift/`isComposing` 一律放行；主修饰键 mac=⌘ 其余=Ctrl。执行 = `src/composables/useShortcuts.ts:36-62`，另在 `:41-50` 直接处理 `⌘/Ctrl + =` / `-` 调字号（三档上限见 `src/utils/chatStyle.ts:73-79`，实为 **5 档 xs/sm/md/lg/xl**；`useShortcuts.ts:21` 那句"三档"是过期注释） | **真判键位归属**：`src/utils/shortcuts.test.ts` 7 条：`:8-12` 命中的三个动作、`:14-17` 大写（CapsLock）、`:19-23` 无修饰键不许动、`:25-30` alt/shift 放行、`:32-34` 组合态放行、`:36-40` **逐个断言 `w/q/c/v/a/x/e/1/空格/Enter` 必须为 `null`**（这条才是"不抢系统编辑键"的真判据）、`:43-53` ⌘K 与 ⌘⇧K/⌘⌥K |
| 缺口 | `useShortcuts` 里 `⌘+/⌘-` 那两条是**硬编码在监听器里**（`useShortcuts.ts:41-50`），没进 `matchAppShortcut`，因此**没有单测**；`window.addEventListener("keydown", …)` 也无 `e.repeat` 判据 | — |

补充：`src/utils/` 下测试文件 **80 个**（`ls src/utils/*.test.ts | wc -l`）。其中相当一部分是**读源码正则的护栏**而不是行为断言（例：`src/utils/notifyAttentionFlow.test.ts:40-46` 用 `assert.match(..., /requestAttention: \(urgent: boolean\) => invoke<void>\("request_attention", \{ urgent \}\)/)`，`windowLaunch.test.ts:91-104` 数 `launchAuxWindow` 调用形状）。这类护栏能防"改回去"，但**不能证明运行时行为对**——引用它当"有测试"的时候要分清是哪一种。

---

## 4. 更像原生（不加新功能）

| 项 | 判定 | 证据 |
|---|---|---|
| 主窗口几何记忆 | **已实现**：`src-tauri/src/lib.rs:215-230` `tauri_plugin_window_state`，flags 只取 `SIZE\|POSITION\|MAXIMIZED\|FULLSCREEN`，**刻意排除 VISIBLE**（`:210-212` 理由：关闭=隐藏到托盘，记 visible 会记成隐藏态导致重启不显示）与 DECORATIONS |
| 辅助窗几何记忆 | **已实现（只记尺寸，位置恒定）**：`commands/logs.rs:419-433` `restore_aux_window_size` 只 `restore_state(SIZE)`，`:410-412` 明写用户口径"只用记住大小就行啊，不用记住位置"，且**以设计尺寸为上限**（`:440-445` `clamp_aux_size`）。调用点在预览窗 `logs.rs:1119` 与任务窗 `logs.rs:837`；**设置/日志/外链三扇不调**（关闭即销毁/只 `apply_aux_geometry`，`:621`/`:687`/`:1224`） |
| 多显示器边界（辅助窗） | **已实现**：`logs.rs:318-330`（为什么全程物理像素，含 tao `available_monitors().find_map` 选错屏的推导）、`:502-516` `aux_anchor_rect`（参照**主窗口所在屏**，退路：当前屏→主屏→`None` 且"宁可不钳"）、`:480-493` `clamp_pos_into_rect`、`:454-456` 只有预览窗改按显示器居中 |
| **多显示器边界（主窗口）** | **未实现 / 结构性风险**：`grep -rn "clamp_pos_into_rect" src-tauri/src --include=*.rs \| grep -v _tests` → 唯一使用点是 `logs.rs:544`（辅助窗重居中）。主窗口的 POSITION 由插件**原样还原**，拔屏后可能落在屏外；而 `decorations:false`（`tauri.conf.json` main 窗）⇒ 掉出去那一截**没有系统标题栏把手**。`tray.rs:312-318` `show_main_window` 只做 `unminimize + show + set_focus`，**不钳位置** ⇒ 托盘"显示主窗口"也救不回来。`logs.rs:477-478` 的注释本身就写着这个失效方向 |
| 任务栏与托盘 | **已实现**：托盘 `tray.rs:324-335` `setup`（建失败就**不拦关闭**，`:322-323` 明写理由）；菜单 4 项 `:342-359`（显示主窗口 / 勿扰=复用 `notify_enabled` 取反 / 重启 / 退出）；关闭到托盘 `:463-470`（`CloseRequested` → `prevent_close` + `hide`）；未读三信号 `:263-309`（Windows 托盘图标叠红点 `dot::with_unread_dot`，**刻意不用 `set_overlay_icon`** `:255-257`；macOS `set_badge_label` 数字；Linux `set_badge_count`）；任务栏闪烁 `commands/network.rs:256-264` `attention_request`（Windows `FLASHW_ALL\|FLASHW_TIMERNOFG` 一直闪到回前台；macOS 仅 `urgent` 才弹）——由 `src/utils/notifyAttentionFlow.test.ts:42-46` 与 `channelState.test.ts:364-368` 钉住调用点与注册 |
| Windows 数字角标 | **未实现（已登记 N4）**：`tray.rs:293` `#[cfg(not(target_os = "windows"))]` 整块不编译；缺的只是"不悬停就看得见的那个数"，需 Win 真机验收 |
| 通知点击回显已有窗口 | **已实现**：`notifications.rs:429-447` `on_notification_clicked` 先 `tray::show_main_window(app)`（**按 label 取已有窗**，`tray.rs:313` `get_webview_window`）再 `emit(EVENT_NOTIFICATION_CLICKED, ...)`；载荷与移动端 `extra` **同形**（`:411-413`）⇒ 前端共用一个路由 `useChatStore.ts:609-625`。第二个进程不建窗：`lib.rs:236-243` single-instance 回调同样是 `show_main_window` |
| 深浅色 + 跟随系统 | **已实现**：三态 `src/utils/appearance.ts:16,37-38`（`system/light/dark`，`resolveDark` 纯函数，有 `appearance.test.ts`）；首帧在 `src/boot/theme-boot.js:13-27` 读 `matchMedia("(prefers-color-scheme: dark)")` 并兼容旧布尔数据（`:23`）；**运行期跟随**在 `src/stores/useAppStore.ts:572-583`（`mq.addEventListener("change", …)`）；跨窗口一致靠 `<html class="dark">` + `composables/useDocumentDark.ts:12-26`（`MutationObserver`，日志窗那种无 store 的文档也跟得上）；窗口底色同步 `App.vue:36-40,115` 与 `commands/network.rs:162-176`（冷启动白闪修复） |
| 字体与字号 | **已实现**：字体栈是系统栈 `src/style.css:38` `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei"`；字号 5 档 `src/utils/chatStyle.ts:73-79`（12/13/14/16/18），`⌘/Ctrl + =/-` 微调 `useShortcuts.ts:41-50`；字号**参与高度估算** `ChatWindow.vue:244` → `utils/messageHeight.ts:111-122`（按 `fontSize|msg_id` 做 LRU 缓存） |
| 右键菜单 | **部分**：消息行 `MessageItem.vue:1304 @contextmenu.prevent`、会话行 `conversation/ConversationListItem.vue:199`、好友行 `FriendListItem.vue:142`、收藏行 `FavoritePanel.vue:640`；键盘可唤起 + Esc 可关 `ContextMenu.vue:17,69,129`；长按等价入口 `ConversationListItem.vue:115`、`FriendListItem.vue:70`。**缺**：代码块 / 群成员行 / 群文件行（**已登记 N6**，且要先定语义）。另外 `App.vue:68-72` 屏蔽 WebView 系统右键菜单时对"有非空选区"放行（`:64-67` 记录了"一刀切把系统复制也吃掉"这个真缺陷），但**这个监听器没有配对移除**（**已登记 N20**） |
| 窗口抖动 / 强提醒 | **已实现（两层）**：OS 层抖整扇窗 `commands/network.rs:199-216` `shake_window`（偏移序列 `[10,-10,10,-10,8,-8,0]` × 45 ms，末尾一定回到 `start`，`:192-193` 写明为什么必须在 Rust 而不是 CSS）；前端 CSS 层 `ChatWindow.vue:396-410` + `src/style.css:589-607`（`--gosslan-duration-shake: 520ms`，`shakeSignal` 驱动、`animationend` 只认根容器 `:407-410`）；协议 `shake` 标记 `protocol.rs:933-938`（"只抖不弹系统通知"）；发起入口 `ChatWindow.vue:735-743` / `useChatStore.ts:1634` |
| 图片预览缩放 | **已实现**：`message/ImageLightbox.vue:161-263`（wheel 缩放 `:183-188`、双指 pinch `:203-224`、放大后拖拽 `:413-414` `translate+scale`、`scale<=1` 才允许翻页手势 `:207,224`）；独立预览窗复用同一件（`window/PreviewWindow.vue:19` import）；手势判据有测试 `src/utils/lightboxGestures.test.ts` |
| **文件另存路径记忆** | **未实现**：`src/utils/localFile.ts:41` `await save({ defaultPath: name })` —— 只带**文件名**、不带目录，每次都是系统默认位置。`grep -rn "save_as\|defaultPath\|last_save" src-tauri/src/commands/*.rs src/utils/*.ts \| grep -v test` 除这一条外**零命中**；`saveDestination.ts` 只判"取消 vs 拿到路径" |

---

## 5. 窗口家族

清单来自 `grep -n "pub const WINDOW_" src-tauri/src/lib.rs`（`:72-104`）与 `commands/logs.rs`。
创建入口都汇到同一个工厂 **`ensure_aux_window`（`logs.rs:219-274`）**：快路径复用（`:234`）→ 创建锁内"再查一次 + build"（`:239-252`）→ **锁外** decorate/摆位（`:253-263`）。锁拆成 `build`/`placed` 两段的原因是 Windows 真机那次"点设置没窗、拖窗口没反应"（`:185-197`）。

| 窗口 | label | 谁创建 | 常驻? | 关闭语义 | 几何记忆 | 拉回前台 |
|---|---|---|---|---|---|---|
| 主聊天 | `main` | `tauri.conf.json` 唯一声明的窗（`app.windows` 现算 **1 项**），`visible:false` 由 `lib.rs:644` `show_main_window` 首显 | 常驻 | `tray.rs:463-470` CloseRequested→hide；前端 × 走 `window_close`（`commands/window.rs:140-146`，main 分支 `hide()`） | SIZE/POSITION/MAXIMIZED/FULLSCREEN（`lib.rs:216-222`） | 托盘 `tray.rs:312-318`、通知 `notifications.rs:438`、单实例 `lib.rs:240-242`。**都不钳位置（§4）** |
| 设置 | `settings` | `open_settings_window`（`logs.rs:644`） | **否**（`AUX_WINDOWS_RESIDENT=false` `logs.rs:36`） | 关闭即**销毁**（`logs.rs:26` 理由：每次要读最新网卡/共享目录/数据量）；在 window-state **denylist**（`lib.rs:228`） | 不记（每次 `aux_window_geometry` 重新居中 `logs.rs:654`） | `show_existing_aux_window`（`logs.rs:96-115`，含 `unminimize`） |
| 运行日志 | `logs` | `open_log_window`（`logs.rs:565`） | **否**（同上） | 关闭即销毁；`lib.rs:228` denylist | 不记（`logs.rs:580`） | 同上 |
| 群任务（"待办"） | `tasks` | `open_group_todos_window`/`ensure_tasks_window`（`logs.rs:711` / `:790`，HTML `todos.html`） | **是**（`AUX_TASKS_RESIDENT=true` `logs.rs:60`） | `install_hide_on_close`（`:123-131`：只 `prevent_close + hide`，不 await 不发 IPC）；**再次打开 = show + 换当前群**（后端写上下文 `logs.rs:751` → `:778` `set_task_window_group`，声明在 `AppState::task_window_group`） | 只记尺寸（`:837` `restore_aux_window_size`） | `unminimize+show+set_focus` + 按主窗重居中（`:107-113`） |
| 图片预览 | `preview` | `open_image_preview`→`ensure_preview_window`（`logs.rs:1017` / `:1075`），HTML `preview.html` | **是**（`AUX_PREVIEW_RESIDENT=true` `logs.rs:71`） | 关闭即隐藏；**资源释放放在前端** `window/PreviewWindow.vue:58-110` `releaseAlbum()` 挂 `onCloseRequested`（`:60-69` 写明"✕ 不再销毁 WebView，不清就是几十 MB 解码位图 + 下次先闪上一张"） | 只记尺寸（`:1119`）+ **唯一按显示器居中**（`:454-456`） | 同上；启动 **1.2 s 后预热**（`App.vue:16,103-107` → `logs.rs:1061-1068`，`reveal=false`） |
| 外链（"发现"） | `link` | `open_link_window`（`logs.rs:1178-1233`） | **是**（`AUX_LINK_RESIDENT=true` `logs.rs:41`） | 关闭即隐藏；复用时 `win.navigate(url)` + `set_title`（`:1229-1232`）；导航只放行 http/https（`:1212`） | 不记（只 `apply_aux_geometry` `:1224`，不调 `restore_aux_window_size`） | `show_existing_aux_window` |
| 应用内弹窗（回退形态） | — | `ChatWindow.vue:342-363`（移动端/开窗失败 → `tasksOpen`）、`GroupTasksPanel.vue`、`BaseModal.vue` | — | 走 HeadlessUI Dialog | — | — |

结构性风险（带证据）：

1. **"关了但没释放"集中在三扇常驻窗**（tasks / preview / link）。它们的 `CloseRequested` 只 `hide()`（`logs.rs:126-129`），WebView 与文档**永久活着**。
   目前**只有预览窗有前端自我清理**（`PreviewWindow.vue:79-89`）。`GroupTodosWindow.vue` 与任务看板没有任何 hide/`aux-hidden` 挂钩（`grep -n "onCloseRequested\|release\|dispose" src/components/GroupTodosWindow.vue src/components/window/AuxWindowShell.vue` → **0 命中**）；`logs.rs:64-69` 还专门更正过一段指向**根本不存在**的 `aux-hidden` 事件的旧注释——照着注释去 Rust 找"隐藏时的释放"是找不到的。
2. **"重复开实例"这条基本封死了，但留了两个口子**：(a) 前端单飞+防抖 + 后端 `ensure_aux_window` 单例 + `AUX_WINDOW_CREATE_LOCK`（`logs.rs:81`）+ 锁内二次检查（`:245`）+ 测试交叉核对（`lib_window_tests.rs:547`、`windowLaunch.test.ts:91-104`）；(b) 剩余口子是**跨进程**——`lib.rs:189-194` `allow_second_instance_launch` 只要 `GOSSLAN_INSTANCE` 有值**或** `GOSSLAN_AUTOSTART=1` 就放第二个进程进来，而 `:186-187` 明写那会是"第二扇主窗 + 第二个托盘 + 第二份 mesh 身份 + 同一条申请弹两次通知"。这是 e2e harness 的出口，但它靠**环境变量**，真机上被误设就是重复实例。
3. **群任务窗"一扇看一个群"是设计而非缺陷，但代价已写在代码里**：`lib.rs:79-84` 与 `logs.rs:790-800` 都记着"代价是任务栏里不再能分清这是哪个群的窗口"。⇒ 群 A 的窗被群 B 顶掉，用户在任务栏看不到"有两个群的上下文"。
4. **`commands/window.rs:137` 的注释与代码相反**：那里写"其余（设置/日志/**群任务**，均不常驻）直接销毁"，而 `AUX_TASKS_RESIDENT = true`（`logs.rs:60`）、`lib.rs:226` 也把群任务算进常驻。读注释判断关闭语义会得到错的答案（行为本身按常量走，是对的）。
5. **capability 清单是人工同步的**：`lib.rs:60-104` 解释过真实故障（capability 只写 `["main"]` ⇒ 设置窗"选共享目录"静默失败），靠 `capability_covers_every_window_label` 测试兜。`WINDOW_LINK` **故意不在清单里**（`:85-88`，另有 `link_window_is_not_capability_covered` 锁死）。
6. **`MessageItem` 行没有 `v-memo`，而会话行有**（`ConversationList.vue:454,525`）：聊天列表的补丁方式是"共享冻结空数组"（`utils/emptyList.ts`），并且那条补丁**可以被一次随手写回静默退回**，靠构建期护栏守着（`native-experience-round-1.md` §3、designGuards ㉚–㉝）。

---

## 6. 分栏：属不属于"当前稳定收口范围内该做的事"

### A 栏 —— 属于本轮范围（小刀、有判据、不改行为面、不引新依赖）

| 格 | 为什么属于 |
|---|---|
| §1.4 的 B–G 六个全表折叠（尤其 5 次逐行 `JSON.parse`） | 纯**同型改写**：`ChatWindow.vue:248-259` 已经把同类问题（相册列表）按"命令式快照/一次算完"处理过并写了理由；`messages.ts` 里 merge 已是同步主线程（`useChatStore.ts:627-632`）。不需要新框架、不动协议、不动 DOM |
| §5 风险 2 / 风险 4 的**两处文字与现实不符**（`commands/window.rs:137` 注释、`logs.rs:64-69` 已改对的那段可作为范本） | 只改注释，零行为风险；下一轮"照着注释找释放路径"的成本已经付过一次 |
| §3 的两个 Esc / 退格输入缺口里的**Esc 那一半**（`LogViewer.vue`、`GroupTodosWindow.vue` 无 `keydown`） | 已有 7 处同类实现可以照抄（`SettingsWindow.vue:87-93` 那三行就是现成形状），属"同一个应用内部不一致"，不是新功能 |

### B 栏 —— 不属于本轮（要么已被量过并判定、要么要真机、要么会扩大范围）

| 格 | 为什么不动 |
|---|---|
| N10 整表前缀和每帧重算（`VirtualList.vue:64-71`） | **已量过毫秒并判为不动**（`docs/stability-roadmap.md` N10，量具 `perf/run.mjs`）。重开要有新数，不是新意见 |
| N4（Win 数字角标）、N17、N18、N20 真机那一半、N27 真机、Smoke-11 | 只能 Windows/Android 真机，这台 Mac 造不出来，也不许把"读码认为对"写成 PASS |
| N5（macOS Dock 右键）、N6 右键语义定义、N8 下拉刷新/滑动回复 | N6 要先定语义（成员行=@他还是查看资料），N8 判为**新功能** |
| 给 `MessageItem` 加 `v-memo` | N21 **明确判为不做**；要做就是重新过三层门禁 + 出包证据 |
| 把辅助窗改成"多扇 / 每群一窗"、给另存加目录记忆、加 Ctrl+Enter 开关、给 `useShortcuts` 的 ⌘=/- 补测试 | 前两条要动产品口径；Ctrl+Enter 是**新设置项**；测试类属可维护（优先级第 7），本轮不排 |
| §4 主窗口拔屏回不来（`clamp_pos_into_rect` 不覆盖 main） | **属于本轮性质**（稳定、无新依赖），但它要动 `tauri_plugin_window_state` 的还原时序，是 §4 里唯一需要"先定方案再动手"的一格 ⇒ 单列，不夹带 |

### 本轮真该动手的（≤3 格）

1. **`ChatWindow.vue` 的 6 个全表折叠 computed**（`:376-380`、`:386-390`、`:424-428`、`:437-465`、`:530-534`、`:537-544`）：
   把 5 次逐行 `JSON.parse` 收成"每条消息每轮只解一次"（一次遍历出 4 张表，或给 parse 加按 `msg_id` 的缓存），
   并给 `pinnedItems` 的 `list.find`（`O(置顶 × n)`）换成 Map 查表。**照 `:248-259` 已验证过的方向做，不引任何新东西**。
   判据：`perf/run.mjs` / `perf/vlist.ts` 现成的帧耗时读数 + 现有 `reactions/reminders/todos/pins` 单测不许红。
2. **`commands/window.rs:137` 那句与 `AUX_TASKS_RESIDENT=true` 相反的注释**，按 `logs.rs:64-69` 的修法改成实写（哪扇常驻、关闭走 `install_hide_on_close` 还是销毁）。
   顺带在同一处补一句"隐藏时前端要释放什么"——因为 `logs.rs:66-69` 已经证明：**没有那条注释，下一个人找不到释放路径**（群任务窗现在就没有，§5 风险 1）。
   判据：`lib_window_tests.rs` / `window_maximizable_matches_builder` 一类交叉核对测试仍在位。
3. **`LogViewer.vue` 与 `GroupTodosWindow.vue` 补 Esc 关闭**（照 `SettingsWindow.vue:87-93` 那三行，含 `onUnmounted` 配对移除）。
   判据：`designGuards.test.ts:2256-2357` 那条"浮层必须有键盘出口"的静态尺子本来就抓不到这类窗口壳（`native-experience-round-1` 与 §12.6.1 末尾"试过并推翻的一条"记过为什么），所以验收只能落在 `scripts/check-ui-runtime.mjs` 的运行时层 —— 这一点要在动手前先认下来，别拿护栏绿代替。
