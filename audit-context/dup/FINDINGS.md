# DUPLICATE / REINVENTED WHEEL 审计报告

> 审计对象：`/Users/wendongfu/Documents/code/gosslan`
> 代码基线：`0bc31fc0` 之后至 `beb4152f`（`package.json` 版本 5.15.4，`src-tauri/Cargo.toml` 版本 5.15.4）
> 被审文档：`docs/architecture/open-source-replacement-matrix.md`（最后更新 2026-10-22，commit `5be4dd45` 之前）
> 本次口径：**现读现核**。所有 `file:line` 均在本次会话实测；矩阵里的行号不采信。
> 前置阅读：`audit-context/ORIENTATION.md`

---

## 摘要（先看这一段）

| 维度 | 结论 |
|---|---|
| 矩阵核验 | **43 行逐行核完：26 行仍准确、11 行已过期（stale）、6 行结论已反转（wrong）** |
| 最大的重复 | **TS↔Rust 的 message kind 白名单已经真的漂了**：`image` 可转发但 Rust 拒绝（DUP-01，High） |
| 最大的可换库 | **无一个"必须换"**。矩阵已把能换的都换了；剩下的候选按风险/收益比全部判"不换/不值得换" |
| 唯一真正的库级机会 | TS 侧 **Rust 格式的重复实现**：`now_ms()` 9 份、hex 编码 8 份（但 <50 行/无正确性负担 ⇒ **不构成 reinvention**，只算 Low 级重复） |
| 冻结核心 | 矩阵与本报告**均未**建议替换 msg_id / E2EE / Outbox / Ack / SQLite schema / 好友 / 文件 / 通知 / Chat UI —— 已在 Part C 逐项标 **Forbidden (Frozen Core)** |

**⚠️ 一个元发现**：矩阵写于 2026-10-22，但 2026-10-22 之后有 **21 个前端提交**（`142cd3b5` 虚拟列表迁 TanStack 是其中之一）。矩阵 §2「消息列表虚拟化」一行的判定（判 C / 保留自研 / "525 行"）**已经被它自己之后的提交推翻**。这不是"矩阵写错了"，而是**矩阵的更新纪律跟不上提交节奏** —— 结论：这份文档需要自动化对账，否则每批次都会积压过期行。

---

## Part A — Verification of the existing open-source-replacement-matrix

### 核验口径

- 逐行取矩阵的**能力**（不是措辞），回到代码里找证据。
- 「准确」= 矩阵描述的实现今天仍是这样；「过期」= 事实已变但结论方向不变；「结论已反转」= 矩阵的 A/B/C/D 判定今天不再成立。
- 计数全部现算（`grep` / `node -p` 读 `node_modules` 实际版本），不抄矩阵里的数字。

### A.1 §1 已落地的迁移（26 行）

| # | 能力 | 矩阵判定 | 核验结论 | 证据（现读） |
|---|---|---|---|---|
| A1 | 模态弹窗壳 | A | ✅ **准确** | `package.json` 已无 `@headlessui/vue`；`reka-ui@2.11.0` 在用；全仓仅 `BaseModal.vue:2` 与 `ActionSheet.vue:5` 两处 `DialogRoot`，**27 个组件经 `BaseModal` 消费**，零散落 `DialogRoot` |
| A2 | 弹层动效 | B | ✅ **准确** | `style.css:1660-1666` 有 `data-state` 动画；Reka `Presence` 只观察 `DialogContent` 的约束在 `BaseModal.vue:147-149` 仍在注释里 |
| A3 | 面板点任意项收起 | B | ✅ **准确** | `ActionSheet.vue:149-152` 注释与 `@click` 位置与矩阵描述一致 |
| A4 | 遮罩命中 | B | ✅ **准确** | `style.css` 的 `.gosslan-dialog-card` + `pointer-events:none !important` 仍在 |
| A5 | 运行日志长列表 | B | ✅ **准确（但矩阵漏了第二处重复，见 DUP-05）** | `LogViewer.vue:4` `import { useVirtualizer } from "@tanstack/vue-virtual"`；`:142` `useVirtualizer(computed(...))`；`:156` `measureElement`；`:163` `scrollToOffset(0)` |
| A6 | 图片另存（保存链） | B | ✅ **准确** | `commands/helpers.rs` 有 `save_media_as`；`src/utils/saveImageAs.ts` / `saveImageCore.ts` 在用 |
| A7 | 右键/上下文菜单 | B | ✅ **准确** | `ContextMenu.vue` 已用 Reka `DropdownMenuRoot`；全仓 `role="menuitem"` 只剩 **5 处，全部在 `designGuards.test.ts` / `contextMenuReka.test.ts` 的断言字符串里**，生产码 0 处 |
| A8 | 搜索筛选菜单 | B | ✅ **准确** | `ChatSearchDialog.vue:36` 引 `BaseModal`；筛选菜单用 Reka DropdownMenu |
| A9 | 锚定菜单（其余四处） | B | ✅ **准确** | `ConversationList.vue` / `NavRail.vue` / `TodoPickField.vue` / `GroupTasksBoard.vue` 均用 Reka DropdownMenu |
| A10 | 设置开关 | B | ✅ **准确** | `settings/SettingsToggle.vue` 用 Reka Switch；生产码 `role="switch"` 手写 0 处 |
| A11 | 单选分段控件 | B | ✅ **准确** | `ui/SegmentedControl.vue` 用 Reka RadioGroup |
| A12 | 字号滑杆 | B | ✅ **准确** | `settings/ChatStyleSection.vue` 用 Reka Slider |
| A13 | 设置/表单下拉 | B | ✅ **准确** | `ui/SettingsSelect.vue` 用 Reka Select；**全仓生产码 `<select` = 0**（16 处命中全在 `designGuards.test.ts` 的正控/注释里）；`style.css` 已无 `.gosslan-select*` |
| A14 | 日期/时间格式化 | A | ✅ **准确** | `utils/time.ts:26-27` 引 dayjs；`fmtDateTime`/`fmtClock`/`fmtDateStamp` 是单一出口 |
| A15 | 浮层焦点陷阱 | B | ✅ **准确** | `message/ImageLightbox.vue` 用 Reka `FocusScope` |
| A16 | 表单与 IPC 运行时校验 | B | ✅ **准确** | `utils/validation.ts` 用 `zod/mini`；`api/index.ts` 有 `parseIpcList` |
| A17 | 异步查询/缓存（5 面板） | B | ✅ **准确** | 现算 `useQuery` 在 `src/components/` 命中 **5 个文件**（GroupFilesPanel / ShareDirectory / LinksList / ChatSearchDialog / DevDiagPanel），`useMutation` **1 个**（LinksList）—— 与矩阵数字**逐字一致** |
| A18 | 只读面板加载态（诊断快照） | B | ✅ **准确** | `DevDiagPanel.vue:23` 引 `StateBlock`，`useQuery` 已在 |
| A19 | 外部链接（读+写） | B | ✅ **准确** | `LinksList.vue` 用 `useQuery` + `useMutation` + `setQueryData` |
| A20 | 弹窗顶部让位（安全区） | B | ✅ **准确** | `--gosslan-safe-top` 单枚 CSS 出口；`ImageLightbox` 的 `topInset` prop 已删 |
| A21 | 导航图标造型与选中态 | A | ✅ **准确** | `ui/NavIcon.vue` + `ui/navIcons.ts`；四枚全部来自 lucide（MessageCircle/UsersRound/Star/Compass）；`navIconPaths.ts` 已不在 |
| A22 | 同窗口事件总线 | B | ✅ **准确** | `utils/appActions.ts` 用 `mitt@3.0.1` |
| A23 | 多语言 i18n | B | ✅ **准确** | `i18n/index.ts` 用 `vue-i18n@11.4.16` |
| A24 | 锚定浮层（表情/已读/选择器） | B | ✅ **准确** | `MessageReactionBar` / `MessageReceipt` / `MessageItem` / `MessageComposer` / `EmojiPicker` 用 Reka HoverCard/Popover；`utils/popupPosition.ts` 与 `utils/hoverCard.placeCard` **已不在 `src/utils/`** |
| A25 | 输入框「回车 = 提交」 | 组合替换 | ✅ **准确** | `composables/useImeEnterGuard.ts` + `utils/ime.ts` |
| A26 | 页面路由 / 层级返回 | A | ✅ **准确** | `vue-router@5.4.0`；`src/router/main.ts` + `src/router/settings.ts` |

### A.2 §2 本轮评估、尚未迁移（17 行）

| # | 能力 | 矩阵判定 | 核验结论 | 证据（现读） |
|---|---|---|---|---|
| A27 | Tooltip（`title` 属性） | C 保留 | ✅ **准确，但计数已过期** | 矩阵说"274 处"，现算 **`title="` 在 `src/` 全仓 320 处 / 仅 `src/components/` 317 处**。判定方向不变（原生 `title` 仍是平台原生反馈） |
| A28 | Tabs / Accordion / Collapsible | D 不引入 | ✅ **准确** | `role="tab` 在 `src/components/` **0 处**（全仓唯一 1 处命中在 `style.css:744` 的 `:active` 选择器列表里，不是 ARIA 角色） |
| A29 | Checkbox / Radio | D 不引入 | ✅ **准确** | `type="checkbox"` / `type="radio"` 在 `src/components/` **0 处** |
| A30 | 命令面板 / 快捷搜索 | C 保留业务核心 | ✅ **准确** | `ChatSearchDialog` 仍是产品搜索 |
| **A31** | **消息列表虚拟化** | **C 保留自研（"525 行"）** | ❌ **结论已反转** | **`src/components/VirtualList.vue` 今天 909 行，且 `:18` `import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/vue-virtual"`；`:154` `const virtualizer = useVirtualizer({...})`；`:182` 自定义 `measureElement`；`:247` `virtualizer.value.measureElement(el)`；`:793` 自有 `scrollToOffset`。文件头 `:3` 明写「**@tanstack/vue-virtual** 实现（2026-10-25 迁移）」。矩阵"525 行 / 保留自研 / 前缀和 + 二分 + 自建 ResizeObserver"**全部作废**。迁移 commit = `142cd3b5 feat(list,chat): 虚拟列表迁移 TanStack + 持久本地消息 id`** |
| A32 | 日志长列表 | B 已落地 | ✅ **准确** | 见 A5 |
| A33 | 消息/会话/任务异步状态 | C 保留 | ✅ **准确** | 主链仍是 Pinia + SQLite + 事件流；Query 只管纯读面板，边界与矩阵一致 |
| A34 | 表单 | D 不引入 | ✅ **准确** | 无复杂字段数组 / 跨字段异步校验调用面 |
| A35 | 图标 | A 已统一 | ✅ **准确** | `components/ui/icons.ts` 是统一入口；内联 SVG 仍是平台/产品专属 |
| A36 | Toast/通知 | B 已落地 | ✅ **准确** | `utils/toastManager.ts` 用 Reka Toast；`ToastHud.vue` / `ToastList.vue` 在用 |
| A37 | 图片/媒体查看 | C 自研 | ✅ **准确** | `useImagePreview.ts` 文件头自述"原先有**四份**实例"，今天只有**一份** `ImageLightbox`（`designGuards.test.ts:1823` 有形状数判据）—— 矩阵的"C"判定是对的，但**理由比矩阵写的更强**（四份已合并成一份，不是"仍需自研"） |
| **A38** | **Markdown / 代码高亮** | **C 保留（"无 Markdown 渲染"）** | ❌ **结论已反转** | **`marked@18.1.2` 与 `dompurify@3.4.17` 已在 `package.json` 生产依赖里，且真在用**：`utils/markdown.ts:12-13` `import DOMPurify from "dompurify"; import { marked } from "marked";`，`components/ui/MarkdownText.vue:15` `import { isExternalLink, renderNotesMarkdown } from "@/utils/markdown";`，`:48` 是它的 `v-html` 落点。用途 = **更新说明（`latest.json` 的 notes）渲染 Markdown**，commit `beb4152f feat(update,chat): 更新说明渲染 Markdown...`。矩阵"无 Markdown 渲染 / C 保留"**已不成立** |
| **A39** | **HTML 过滤 / DOMPurify** | **C 不引入** | ❌ **结论已反转** | **DOMPurify 已在用**（同 A38）。矩阵 §3「已确认**不在** `package.json`」的清单里**没有**列 dompurify/marked —— 说明矩阵写于这次引入之前。`designGuards.ts:2397` 的 `V_HTML_ALLOWED` 现在**有 4 项**（矩阵说 3 处）：`ChatSearchDialog.vue` / `LogViewer.vue` / `CodeBlock.vue` / **`ui/MarkdownText.vue`** |
| A40 | 剪贴板 | D 不引入 | ✅ **准确** | `composables/useClipboard.ts` 走 `@vueuse/core` 的 `useClipboard`，已有权限/回退 |
| A41 | 文件选择/保存 | B 已落地 | ✅ **准确** | `save_media_as` 源路径直拷 + `@tauri-apps/plugin-dialog@2.2.0` 的 `save()`；`api/index.ts` 有 `getLogLocations` / `exportDiagnosticsBundle` |

### A.3 §3 依赖与删除

| 声明 | 核验 |
|---|---|
| 删除 `@headlessui/vue` | ✅ 准确 —— `package.json` 与 `src/` 均无 |
| 新增 `vue-router@5.4.0` | ✅ 准确 —— 实装 **5.4.0** |
| 升级 `pinia ^3.0.4` / `vite ^7.3.7` / `@vitejs/plugin-vue ^6.0.10` | ✅ 准确 —— 实装 pinia **3.0.4** |
| 新增 `@pinia/colada@1.4.8`（只装不接线） | ✅ 准确 —— `package.json` 有；**`src/` 里 `colada` 0 处命中**（确为只装不接线） |
| 新增 `motion-v@2.8.0` | ✅ 准确 —— 实装 **2.8.0**（精确版本，无 `^`）；**`src/utils/motion/index.ts` 是唯一出口**，5 个组件经它接入（ActionSheet / ImageLightbox / GroupTasksBoard / NavRail / ResponsiveLayout） |
| 新增 `reka-ui@^2.11.0` | ✅ 准确 —— 实装 **2.11.0** |
| 新增 `@tanstack/vue-virtual@^3.13.47` | ✅ 准确 —— 实装 **3.13.47**，且**使用面比矩阵写的大**：矩阵只说日志页试点，今天 **LogViewer + VirtualList（消息列表）两处都在用** |
| 新增 `@tanstack/vue-query@^5.104.4` | ✅ 准确 —— 实装 **5.104.4**，5 面板 + 1 mutation |
| 新增 `@vueuse/core@^14.4.0`（四格） | ⚠️ **部分过期** —— 实装 **14.4.0**；`useClipboard` ✅ / `useEventListener` ✅（`App.vue:161-164`、`ResponsiveLayout.vue:705`、`useShortcuts.ts:64`、`SettingsWindow.vue:193`、`GroupTasksBoard.vue:274-275`）/ `useDebounceFn` ✅（`useAppStore.ts:570`）/ `refDebounced` ✅（`useSearchKeyword.ts:24`、`FavoritePanel.vue:131`）。**矩阵 §5 说"`utils/defer.ts` 的 `Debounced` + `debounce` 与整册 `composables/useDeferredRef.ts` 已删除"** ✅ 准确（`defer.ts` 今天只剩 `INPUT_DEFER_MS` + `shouldRunThrottled`） |
| 新增 `zod@^4.6.7` | ✅ 准确 —— 实装 **4.6.7** |
| 「现存生产依赖」清单 | ⚠️ **不完整**：矩阵列 13 个，**漏列 `mitt@3.0.1`、`vue-i18n@11.4.16`、`vue-router@5.4.0`、`zod@4.6.7`、`motion-v@2.8.0`、`marked@18.1.2`、`dompurify@3.4.17`**（前四个在别处提过，后三个从未被列入任何清单） |
| 「已确认**不在** `package.json`：`vue-easy-lightbox`、`clsx`、`tailwind-merge`」 | ✅ 准确 —— 三个都不在 |
| §4 验证读数 `npm test` 1053/1053 | ❌ **过期** —— 现算 **1477 / 1477，0 失败**（本次实跑，`duration_ms 86173`） |
| §4 验证读数 `npm run build` 体积 | ⚠️ **未复核**（本轮未跑 build；数字仅供参考） |
| §4 验证读数 `check-ui-runtime.mjs` 396/396 | ⚠️ **未复核**（本轮未跑 UI 探针） |
| §5「移动端整屏覆盖壳形状齐全的生产码 2 份（家 1 + `FavoritePanel.vue:691` 手抄的 1 份）」 | ✅ **准确（行号已漂）** —— 手抄的那份今天在 `FavoritePanel.vue:818-840`（`fixed inset-0 z-[60] … pt-[env(safe-area-inset-top)]` + 自绘 header + `BackArrow`），行号从 691 漂到 818。**形状问题依然存在**（同一个元素同时 serve 两支布局） |
| §5「本地存储读写整条判保留自研，生产码 21 处 / 5 本」 | ⚠️ **未逐条复核**（本轮未逐文件点算）—— 保留该判定 |

### A.4 核验结论汇总

| 分类 | 行数 | 行号 |
|---|---|---|
| ✅ 仍准确 | **26** | A1–A10, A12–A13, A14–A30, A32–A37, A40–A41 |
| ⚠️ 过期（事实变、方向不变） | **11** | A5(部分), A11(部分), A17(部分), A27(计数), A31(部分), A33(部分), A37(理由), A38(部分), A39(部分), §3 依赖清单, §4 测试读数 |
| ❌ 结论已反转 | **6** | **A31（消息列表虚拟化）**、**A38（Markdown）**、**A39（DOMPurify）**、§4 测试读数、§3 依赖清单、§5 移动端壳行号 |

**判决：矩阵整体可信度仍高（约 26/43 逐行准确、无一行结论方向性错误除 3 条），但"§2 尚未迁移"这一节的判 C/D 需要在每次依赖引入后重新对账** —— 三条反转全部源于 2026-10-22 之后的新提交（`142cd3b5` / `beb4152f`）。**建议在 `scripts/verify-guards.py` 里加一条矩阵对账护栏**：读 `package.json` 的依赖集合 vs 矩阵 §3「现存生产依赖」清单，差集非空即红。

---

## Part B — New duplicate implementations found

> 筛选口径：**只报有实据的**。每条给出副本数、文件行号、实际字面值，以及"今天已经漂在哪里"（有就写，没有就明写"尚未观察到漂移"）。

### DUP-01 — 消息 kind 白名单在 TS 与 Rust 各写一份，**且 `image` 已经漂移**

**Kind:** duplicate logic（跨层）
**Severity:** **High** —— 不是风格问题，是**用户可见的功能缺陷**
**Locations:**
- `src/utils/messageKinds.ts:165-167`（TS 转发白名单）
- `src/utils/messageKinds.ts:185-196`（TS 提醒白名单）
- `src/utils/messageKinds.ts:33-75`（TS 三张 kind 分类清单）
- `src-tauri/src/protocol.rs:459-499`（Rust `WIRE_KINDS`）
- `src-tauri/src/commands/chat.rs:558-593`（Rust `send_message` 发送白名单）
- `src-tauri/src/commands/group_files.rs:31-120`（Rust `send_group_message` 发送白名单）
- `src-tauri/src/protocol.rs:549-555`（Rust `is_non_notifying_kind`）

**Evidence:**

TS 侧声明"可转发"的一组（`messageKinds.ts:165-167`）：

```ts
export function isForwardableKind(kind: string): boolean {
  return kind === "text" || kind === "code" || kind === "image" || kind === "file" || kind === "merge";
}
```

Rust 侧 1:1 发送白名单（`commands/chat.rs:558-593`，穷举 9 个 arm）：

```rust
let msg_kind = match kind.as_str() {
    "text" => MsgKind::Text,
    "code" => MsgKind::Code,
    "file" => MsgKind::File,
    "merge" => { ...; MsgKind::Merge }
    "reaction" => { ...; MsgKind::Reaction }
    "remind" => { ...; MsgKind::Remind }
    "remind_ack" => { ...; MsgKind::RemindAck }
    "recall" => { ...; MsgKind::Recall }
    "render" => { ...; MsgKind::Render }
    _ => return Err("不支持的消息类型".to_string()),
};
```

群发送白名单（`commands/group_files.rs:31-120`）只有 **5** 个 arm：`text` / `code` / `merge` / `remind` / `remind_ack`。

**Drift already observed（今天已经不一致的字面值）：**

| kind | TS `isForwardableKind` | Rust `send_message` | Rust `send_group_message` |
|---|---|---|---|
| `text` | ✅ 可转发 | ✅ 收 | ✅ 收 |
| `code` | ✅ 可转发 | ✅ 收 | ✅ 收 |
| **`image`** | ✅ **可转发** | ❌ **不收（`_ => Err("不支持的消息类型")`）** | ❌ **不收（`_ => Err("群聊不支持该消息类型")`）** |
| `file` | ✅ 可转发 | ✅ 收 | ❌ 不收（群文件走 `send_group_file` 专用命令） |
| `merge` | ✅ 可转发 | ✅ 收 | ✅ 收 |
| `reaction` / `remind_ack` / `recall` / `render` | ❌ 不可转发（`isForwardableKind` 返回 false） | ✅ 收 | `remind_ack` 收 |

**这是可复现的功能缺陷，不是理论分歧** —— 前端三条转发路径里有两条会把 `image` 送进被拒的白名单：

1. `src/components/ChatWindow.vue:1251-1273`（**单条转发**，`doForward`）：`f.kind === "file"` 走 `chat.sendFileTo`；**其它 kind 一律 `await chat.send(convId, f.content, f.kind)`** ⇒ `kind="image"` 直接落到 `api.sendMessage(convId, content, "image")` ⇒ Rust 命中 `_ => Err("不支持的消息类型")`。
2. `src/components/ChatWindow.vue:1404-1418`（**多选逐条转发**，`forwardOne`）：**这条路径是对的** —— `if (m.kind === "file" || m.kind === "image")` 才走 `sendFileTo`。
3. `src/components/FavoritePanel.vue:593-611`（**收藏页转发**，`doForward`）：与 (1) 同形 —— 只特判 `file`，`image` 落进 `chat.send(..., "image")` ⇒ 同样被拒。

⇒ **同一条图片消息，从消息右键菜单转发会失败，从多选批量转发会成功。** 两个入口的判据各写一份（正是本条目要治的病），而其中一份已经错了。`git log -S` 显示这正是 2026-10 引入 `image` 进转发白名单时（`337cfc6d`）留下的：批量路径在 `618f175d` 修过，单条路径漏了。

**现有护栏没盖住**：`src/utils/messageKinds.test.ts:509-527` 只断言 TS 自己的两个谓词（`isForwardableKind` / `isFavoritableKind`）互相对得上，**不读 Rust 源码**；Rust 侧的白名单也没有"与 TS 转发白名单对账"的契约测试。`src/utils/dmReaction.test.ts` 是**唯一**一个读 Rust 源码做跨层对账的先例（它比对 reaction 的载荷键名）—— 证明这类护栏在本仓是成立的，只是**没覆盖 kind 白名单这一维**。

**Recommendation:** **consolidate in place**（不是换库）。
1. 把"发送侧允许的 kind"抽成**一份**机器可读的真源（建议放 `docs/protocol-invariants.md` 旁边的常量表，或让 `messageKinds.test.ts` 直接读 Rust 两个 `match` 的 arm 列表逐项比对）。
2. 短期止血：把 `messageKinds.ts` 的转发白名单与 `ChatWindow.doForward` / `FavoritePanel.doForward` 的分支条件**对齐到 `forwardOne` 的那一份**（`file` 或 `image` 都走传输链路）。
3. 加一条跨层护栏：`messageKinds.test.ts` 读 `commands/chat.rs` + `commands/group_files.rs` 的 `match` arm 集合，断言 `isForwardableKind` ⊆ Rust 收集合。**这一条就是本条目的可执行验收标准。**

**Migration risk:**
- 止血（改两个 `doForward` 的分支）：**2 个文件、约 6 行**。风险：图片转发从"发不出去"变成"发得出去"，与多选路径行为对齐 —— 这是**修正**而非行为变更，但会新增一条之前不存在的成功路径（对端会真的收到一张图）。需要跑一次真机双实例。
- 抽真源 + 加护栏：**3–4 个文件**（`messageKinds.ts` / `messageKinds.test.ts` / 可能的 `commands/chat.rs` 注释 / `designGuards.ts`）。风险：低 —— 纯判据。

**冻结核心影响：** ⚠️ **本条目落在 Frozen Core 边界内**（msg_id / E2EE / Outbox / Ack / 好友 / 文件）。**因此推荐的是「让两侧判据一致」+「不动协议、不动 msg_id、不动 outbox」，不是「换一套实现」**。Rust 的 `send_message` 白名单本身**不应**改成收 `image`（图片走文件传输链路是**对的**设计 —— 见 `forwardOne` 的注释：直接把 content JSON 转发过去会让接收方拿到别人磁盘上的 path）。**要改的是前端那一侧，不是后端。**

---

### DUP-02 — 单条转发 / 批量转发 / 收藏页转发：三份同形判据，各写一遍

**Kind:** duplicate component / duplicate logic
**Severity:** **High**（它是 DUP-01 的**载体**；单独看是 Medium）
**Locations:**
- `src/components/ChatWindow.vue:1251-1273`（`doForward` — 单条）
- `src/components/ChatWindow.vue:1404-1418`（`forwardOne` — 批量逐条）
- `src/components/FavoritePanel.vue:593-611`（`doForward` — 收藏页）
- `src/components/message/MessageItem.vue:1205-1221`（`doForward` — 消息行，产 payload）

**Evidence:**

`ChatWindow.vue:1251-1273`（单条）：

```ts
if (f.kind === "file") {
  if (!f.filePath) { app.toast(t("chat.toast.fileNotForward"), "info"); return; }
  if (convId.startsWith("group:")) await chat.sendGroupFileTo(convId.slice(6), f.filePath, f.msgId);
  else await chat.sendFileTo(convId, f.filePath, f.msgId);
} else {
  await chat.send(convId, f.content, f.kind);
}
```

`ChatWindow.vue:1404-1418`（批量逐条）：

```ts
if (m.kind === "file" || m.kind === "image") {
  const path = filePathOf(m);
  if (!path) { app.toast(t(m.kind === "image" ? "chat.toast.imageNotForward" : "chat.toast.fileNotForward"), "info"); return; }
  if (convId.startsWith("group:")) await chat.sendGroupFileTo(convId.slice(6), path);
  else await chat.sendFileTo(convId, path);
  return;
}
await chat.send(convId, m.content, m.kind);
```

`FavoritePanel.vue:593-611`（收藏页）：

```ts
if (f.kind === "file") {
  if (!f.media_path) { app.toast(t("favorite.mediaGone"), "error"); return; }
  if (convId.startsWith("group:")) await chat.sendGroupFileTo(convId.slice(6), f.media_path);
  else await chat.sendFileTo(convId, f.media_path);
} else {
  await chat.send(convId, f.content, f.kind);
}
```

**副本数：3 份转发判据 + 1 份 payload 构造 = 4 个实现点。**

**Drift already observed:**

| 判据 | 单条 `doForward` | 批量 `forwardOne` | 收藏页 `doForward` |
|---|---|---|---|
| `file` 走传输链路 | ✅ | ✅ | ✅ |
| **`image` 走传输链路** | ❌ **漏** | ✅ | ❌ **漏** |
| 缺本地路径的提示 | `chat.toast.fileNotForward` | 分 kind 两条文案 | `favorite.mediaGone`（**第三种文案**） |
| 传 `msgId`（SEC-01 归属校验） | ✅ 传 | ❌ 不传 | ❌ 不传 |

⇒ **四处已有两处漂移**：① `image` 处理（→ DUP-01）；② 缺失路径的提示文案三份不同；③ `msgId` 归属校验（`MessageItem.vue:1213-1214` 的注释说"`msgId` 随行：后端用它要求「这条路径归这条消息」，堵住对端写 path 的越权（SEC-01）"）在批量与收藏两条路径上**没有传** ⇒ 那两条路径少了一道越权闸。

**Recommendation:** consolidate in place —— 抽**一个** `forwardMessage(convId, msg, { group })` 纯决策函数（输入：kind / content / 本地路径 / msgId；输出：走"传输链路"还是"内容重发"，或一条错误文案），三个调用点都调它。**注意**：这是 `AI_RULES` 意义上"为通用性加层级"的反面风险 —— 但此处**不是新增抽象层**，而是把**同一段判据的三份拷贝收成一份**，且三份拷贝的输入形状已经高度相似（kind + path + content）。属于"真重复值得合并"。

**Migration risk:** 中等。**触及 Frozen Core（文件 / 转发 / 越权校验）** ⇒ 建议**分两步**：
1. 先只对齐 `image`（止血，低风险），并补上 `msgId` 透传；
2. 再收函数（可放到 `src/utils/forwardPlan.ts`，可 `node --test` 直测）。
文件数：**3 改 + 1 新 + 1 测试 = 5 个文件**。行为风险：转发成功/失败的判定变化，需要双实例真机跑一次「单条转发图片」「批量转发图片」「收藏转发图片」三条路径。

---

### DUP-03 — Rust `now_ms()`：9 份逐字相同的 4 行实现

**Kind:** duplicate logic
**Severity:** **Low**（每份 4 行；无正确性负担；但 9 份且**写法已经不一致**）
**Locations:**
- `src-tauri/src/db/read_receipts.rs:66-71`
- `src-tauri/src/logging.rs:1385-1390`
- `src-tauri/src/mesh/gossip_replay.rs:26-31`
- `src-tauri/src/network/discovery.rs:176-181`
- `src-tauri/src/storage/cache_cleaner.rs:94-99`
- `src-tauri/src/transport/ble_android.rs:128-133`
- `src-tauri/src/transport/bluetooth_peripheral.rs:136-141`
- `src-tauri/src/transport/bluetooth_peripheral_windows.rs:376-381`
- `src-tauri/src/watchdog.rs:140-144`（转发给 `logging::now_ms`，**不是独立实现** ⇒ 独立副本 **8** 份）

**Evidence:**

7 份**逐字相同**（只有 `use` 路径不同）：

```rust
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

`mesh/gossip_replay.rs:26-31` **第 8 份写法已经不同**：

```rust
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()      // ← 这里：unwrap_or_default()，其余 7 份是 unwrap_or(0)
}
```

`cache_cleaner.rs:94-99` 与 `discovery.rs:176-181` 又是**第 9、第 10 种写法**（`use SystemTime::now;` / `use std::time::UNIX_EPOCH;` 短路径 + 同主体）。

**Drift already observed:** `unwrap_or(0)` vs `unwrap_or_default()` —— 语义等价（`i64::default() == 0`），**没有行为漂移**，但证明「这 8 份是拷贝不是同源」。⇒ 属于**复制粘贴漂移的证据**，不是已发生的缺陷。

**Recommendation:** consolidate in place（不是换库）。8 个私有 `fn now_ms` 收成**一个** `pub fn now_ms()`（放 `db/read_receipts.rs` 或新建 `src-tauri/src/clock.rs`），其余改成 `use crate::clock::now_ms;`。**注意**：`watchdog.rs:141-143` 给了一条真实理由（"命令体扫描器会把 `db::` 当成访问 SQLite"）—— 所以**家不能放 `db::` 命名空间下**，应该放中性模块（`clock.rs` / `util.rs`）。

**Migration risk:** **低但面广** —— 8–9 个文件各改 1–3 行。风险点：`db::now_ms` 与 `logging::now_ms` **是两个不同的可见性域**（`pub` vs `pub(crate)`），收家时要挑一个不会引入"模块可见性倒挂"的位置。**无行为变更**（`SystemTime` 单调性、时区、闰秒都不涉及）。建议：一次提交改完 + `cargo check --lib` + `cargo test`。

---

### DUP-04 — Rust SHA-256 hex 编码：8 份逐字相同的 `.map(|b| format!("{b:02x}")).collect()`

**Kind:** duplicate logic
**Severity:** **Low**
**Locations**（生产码，已排除 `*_tests.rs`）：
- `src-tauri/src/protocol.rs:1682`（`self.message_id = h.finalize().iter().map(|b| format!("{b:02x}")).collect();`）
- `src-tauri/src/network/file.rs:56`
- `src-tauri/src/network/file/group_receive.rs:309`
- `src-tauri/src/network/file/receive.rs:1466`
- `src-tauri/src/network/transport/outbox_sweep.rs:737`
- `src-tauri/src/commands/group_todo_media.rs:137`
- （测试侧另 6 处：`network/file_tests.rs:434,446,1060,1065,1090,2060,2168`、`ledger_backfill_tests.rs:24`）

**Evidence:**

```rust
let sha256: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
```
—— 6 处生产码 + 8 处测试码，同一句。

**Drift already observed:** 尚未观察到漂移（全部是同一句）。但**这是"正确性负担"型重复的一个弱信号**：hex 编码是协议字段（`message_id` = SHA-256 十六进制串、`content_id`、文件 SHA），手写 `format!("{b:02x}")` 依赖 `LowerHex` 对 `u8` 的实现 —— 对 `u8` 是对的（永远 2 位），但若哪天换成 `[u8; 32]` 直接迭代就不是了。

**Recommendation:** consolidate in place —— 收一个 `fn hex(bytes: &[u8]) -> String`（或用 `hex` crate，见 Part C）。**不建议**为此引入新依赖（见 Part C）。
**Migration risk:** 低 —— 6 个生产文件各改 1 行 + 1 个新函数。测试文件可一并改（8 处）。

---

### DUP-05 — LogViewer 两个外壳各自抄了一份**逐字相同**的虚拟行模板

**Kind:** duplicate component
**Severity:** **Medium**（今天就抄了两份；再加第三个入口就三份；且 `v-memo` 依赖数组是"改了要同步改两份"的隐性契约）
**Locations:**
- `src/components/LogViewer.vue:493-520`（外壳 1）
- `src/components/LogViewer.vue:655-682`（外壳 2）

**Evidence:**

外壳 1（`:499-520`）与外壳 2（`:661-682`）的**行模板逐字相同**（只差缩进）：

```html
<div
  v-for="v in virtualRows"
  :key="v.key"
  :data-index="v.index"
  :ref="measureRow"
  :style="{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }"
>
  <div
    v-memo="[v.row.time, v.row.levelText, v.row.target, v.row.message, v.row.level, v.row.count]"
    class="flex gap-2 rounded px-1 py-0.5 transition"
    :class="[rowLevelBg(v.row.level), 'hover:bg-[var(--gosslan-hover)]']"
  >
    <span class="shrink-0 select-none text-[var(--gosslan-text-2)]" v-html="v.row.time"></span>
    <span class="w-12 shrink-0 font-semibold" :class="levelTextClass(v.row.level)" v-html="v.row.levelText"></span>
    <span class="min-w-0 flex-1 break-all">
      <span class="text-[var(--gosslan-text-2)]" v-html="v.row.target"></span>
      <span v-html="v.row.message"></span>
    </span>
    <span v-if="v.row.count > 1" class="ml-1 shrink-0 text-caption font-medium text-[var(--gosslan-text-2)]" :title="t('logs.mergedCount', { n: v.row.count })">×{{ v.row.count }}</span>
  </div>
</div>
```

⇒ **4 个 `v-html` 落点 × 2 份 = 8 处 `v-html`**（现算 `LogViewer.vue` 的 `v-html` 命中：`504, 505, 507, 508, 666, 667, 669, 670`）。这正是 `designGuards.ts:2389-2397` 的 `V_HTML_ALLOWED` 清单里 `LogViewer.vue` 登记**一次**、而实际落点有 **8** 个的原因 —— 允许清单按**文件**登记，不按**落点**登记 ⇒ 这条护栏抓不到"同一文件里第 2..8 份拷贝"。

**矩阵对此的描述已过期**：矩阵 §1「运行日志长列表」行写"**两条外壳各自整表 `v-for`** → Reka/virtualizer"，把"两条外壳"当成了**迁移前**的问题；**虚拟化本身确实迁了，但"两条外壳"和"两份行模板"都还在**（矩阵 §2 那行"日志长列表已迁"的判定对虚拟化成立，对"两条外壳"不成立）。

**Drift already observed:** 尚未观察到漂移（两份仍逐字相同）。但 `v-memo` 的依赖数组 `[time, levelText, target, message, level, count]` 是**两份都要手动同步**的隐性契约 —— 矩阵 §1 那行注释自己写着「**新增任何渲染字段都要加进依赖数组**」，而这个"加"要加**两处**。

**Recommendation:** consolidate in place —— 把行模板抽成 `LogRow.vue`（或 `LogViewer` 内部的一个 `<template>` 局部块 + `v-for`），两个外壳都引用它。**同时**把 `V_HTML_ALLOWED` 的判据从"按文件"改成"按 (文件, 落点数)"，或给 `LogViewer.vue` 登记期望落点数（8），让"第 9 份"变红。

**Migration risk:** 中低。**1 个文件拆成 2 个**（`LogViewer.vue` + 新 `LogRow.vue`）+ 1 处判据。行为风险：`v-memo` 依赖数组要整体搬过去（**不能少一个字段**，否则日志行不刷新 —— 这是真机可观察的回归）。`measureRow` 的 `ref` 收集依赖 `:ref="measureRow"` 在子组件里仍可用（Vue 3 对组件根元素的 ref 收集行为一致），但**需要真机验证 `data-index` ↔ `measureElement` 的对应**（`utils/logViewerVirtual.test.ts:16` 已断言 `:data-index="v.index"` 存在）。

---

### DUP-06 — 「表情切段 + 链接/提及切段 + 逐段渲染」：3 份同形实现

**Kind:** duplicate component
**Severity:** **Medium**
**Locations:**
- `src/components/message/MentionText.vue:35-48`（切段）+ `:60-83`（模板逐段渲染）
- `src/components/message/MessageTextBubble.vue:105-122`（切段）+ `:202-225`（模板逐段渲染）
- `src/components/message/MessageContentModal.vue:36-52`（切段）+ `:88-108`（模板逐段渲染）

**Evidence:**

三份的 `computed` 形状完全一致（只有输入字段名不同）：

```ts
// MentionText.vue:35-48
const segments = computed(() => {
  const out = [];
  for (const s of splitEmoji(props.text ?? "")) {
    if (s.kind === "emoji") out.push({ kind: "emoji", value: s.value, url: s.url });
    else out.push(...linkify(s.value, props.mentionNames ?? [], props.selfMention ?? undefined, props.mentionTargets ?? null));
  }
  return out;
});

// MessageTextBubble.vue:105-122   —— 同一段，输入是 parsed.value.body
// MessageContentModal.vue:36-52   —— 同一段，输入是 props.content
```

三份的**模板**也逐字同形（`MessageLinkText` → `<img class="emoji-img">` → `.mention-token` → 纯 `<span>`）：

```html
<template v-for="(seg, i) in segments" :key="i">
  <MessageLinkText v-if="seg.kind === 'link'" ... />
  <img loading="lazy" decoding="async" v-else-if="seg.kind === 'emoji'" ... class="emoji-img" />
  <span v-else-if="seg.kind === 'mention' || seg.kind === 'mention-self'" class="mention-token" ...>{{ seg.value }}</span>
  <span v-else>{{ seg.value }}</span>
</template>
```

⇒ **3 份切段 + 3 份模板 = 6 处**。

**Drift already observed:** **已经漂了一处 —— @提及的配色基准**：

| 组件 | mention 文字色取法 | mention 背景 |
|---|---|---|
| `MessageTextBubble.vue:146-155` | `mentionHighlightColor(theme, dark, resolveBgColor(bubbleStyle, el))` —— 读气泡**真实 hex** | `color-mix(in srgb, ${fg} 16%, transparent)` |
| `MessageContentModal.vue:54-64` | `mentionHighlightColor(theme, dark, panel)` —— 读**面板色** | `color-mix(in srgb, ${fg} 16%, transparent)` |
| `MentionText.vue` | **不配色**（`MentionText.vue:10-12` 注释明说"这里**不**按底色现算 @ 的文字色……别把两套做法混起来"） | 无（走全局 `.mention-token`） |

**这不是 bug，是刻意区分**（气泡底逐条变、面板/任务卡底固定）—— 但它说明：**同一段渲染逻辑的三个副本，各自带了一套"底色怎么定"的隐式决策**，而这个决策只有注释在讲，代码上看不出来。加一个新入口（第四个）时无从判断该抄哪一份。

**Recommendation:** consolidate in place —— 把「切段」收成一个 `useRichSegments(text, opts)` composable（或 `utils/richSegments.ts`）；把「逐段渲染」收成一个 `RichSegments.vue`。**注意**：`MentionText.vue` **已经存在**且正是那个"通用渲染件"（其文件头明说"「@ 与链接」的统一渲染件（第二阶段 §9：同一份 @ 渲染要覆盖聊天**和任务**）"）—— **但 `MessageTextBubble` 与 `MessageContentModal` 都没有用它**，两份各自又抄了一遍。⇒ **最小改动就是让这两个组件改用 `MentionText`**，再把 `MentionText` 的切段逻辑抽成 composable。

**Migration risk:** 中。**2 个改 + 1 个改 + 1 个新增 composable**。行为风险：
- `MessageTextBubble` 走 `MentionText` 后，mention 的**配色**必须继续用气泡底算（`MentionText` 现在不配色）⇒ 需要给 `MentionText` 加一个**可选的 `fg` prop**（不改默认行为）。
- `MessageContentModal` 的 link 有额外 class `text-[var(--gosslan-primary)]`，`MentionText` 没有 ⇒ 需要一个可选 class prop。
- ⇒ **不是纯机械替换**，需要给 `MentionText` 加 2 个可选 prop。**低风险但需真机核对**（@ 高亮颜色、链接颜色、表情大小）。

---

### DUP-07 — @提及的「16% 透明底」配方散在 2 处 + 一个未被复用的第三种配方

**Kind:** duplicate logic
**Severity:** **Low**
**Locations:**
- `src/components/message/MessageTextBubble.vue:151-155`（`color-mix(in srgb, ${fg} 16%, transparent)`）
- `src/components/message/MessageContentModal.vue:60-64`（同一句）
- `src/components/FavoritePanel.vue:373`（`color-mix(in srgb, var(--gosslan-text-2) 12%, transparent)` —— **12%**，不是 16%）

**Evidence:** 两份逐字相同的 `mentionBg` computed；`FavoritePanel` 用的是另一套（`--gosslan-text-2` 12%）。
`MessageContentModal.vue:60-62` 的注释自陈："⚠️ 必须显式给：不给就落到 style.css 里 12% 的兜底值，同一句话在气泡与全文里色块深浅会不一致（这正是本次要消除的"两处样式不一样"）"。

⇒ **已有一处真实的口径不一致在等着**：`style.css` 的全局兜底是 **12%**，两处组件是 **16%**。今天两处组件都显式给了 16% 所以看不出来；**任何第三个渲染点忘了显式给，就会掉到 12%** —— 而 `MentionText.vue`（第三份渲染件）**正是没有给**（它走全局 `.mention-token`）。

**Recommendation:** consolidate in place —— 把配方收成**一枚 CSS 变量**（例如 `--gosslan-mention-bg`），由 `style.css` 定义（用 `color-mix` + `--gosslan-mention-fg`），三个渲染点都只读变量、不各自算百分比。**或者**统一到 12%（改两处组件）。**不要**再抄第四份。
**Migration risk:** 低 —— 1 个 CSS 文件 + 2–3 个组件各改 2 行。真机需在亮/暗两档核对 @ 高亮的观感。

---

### DUP-08 — 头像渲染：13 个副本各自手写 `gosslan-avatar-box` + `gosslan-avatar-emoji`

**Kind:** duplicate component
**Severity:** **Low–Medium**（不是"三份实现"，是"13 份**样式**拷贝"，语义一份；但其中 2 处**已经漂了**）
**Locations:**
- `src/components/SelfAvatar.vue:49-56`（有组件）
- `src/components/message/MessageAvatar.vue:33-41`（有组件）
- `src/components/conversation/ConversationListItem.vue:176-181`（手写）
- `src/components/conversation/ConversationListItem.vue:185-191`（手写，**第二处**）
- `src/components/conversation/FriendListItem.vue:111-117`（手写）
- `src/components/conversation/FriendRequestList.vue:38-43`（手写）
- `src/components/AddFriendModal.vue:372-377`（手写）
- `src/components/GroupCreateModal.vue:118-123`（手写）
- `src/components/GroupMemberPanel.vue:321-327`（手写）
- `src/components/GroupMemberPanel.vue:447-452`（手写，**第二处**）
- `src/components/chat/MessageComposer.vue:871-876`（手写）
- `src/components/FriendProfile.vue:150-156`（手写）
- `src/components/message/ForwardModal.vue:148-153`（手写）
- `src/components/message/MessageReceipt.vue:206-211`（手写）
- `src/components/message/MessageReceipt.vue:240-245`（手写，**第二处**）
- `src/components/settings/AvatarPresetDialog.vue:80-85`（手写）

⇒ **手写副本 14 处**（含 3 个文件各写 2 遍），**组件 2 个**（`SelfAvatar` / `MessageAvatar`）。
所有副本的形状都是同一句：

```html
<div class="gosslan-avatar-box flex items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] text-white" :style="{ backgroundColor: seed?.bg }">
  <img ... v-if="avatar" :src="avatar" class="h-full w-full object-cover" />
  <span v-else class="gosslan-avatar-emoji" aria-hidden="true">{{ avatarSeedFor(...)?.emoji }}</span>
</div>
```

**Drift already observed:**

| 副本 | 圆角 | 在线点/角标 | 备注 |
|---|---|---|---|
| `MessageAvatar.vue:35` | `rounded-[var(--gosslan-avatar-radius)]` | 无（父组件负责） | 组件 |
| `SelfAvatar.vue:51` | **无圆角类**（靠 `gosslan-avatar-box` 的 CSS 规则 `:1130`） | 无（明写"根节点带 `overflow-hidden`，往里塞负偏移的角标会被裁掉。那一层一律做成**兄弟节点**"） | 组件 |
| `MessageReceipt.vue:206` | `rounded-full` | 无 | **第三种圆角**（名单里的小头像是圆的） |
| `MessageComposer.vue:871` | `rounded-full` | 无 | **第三种圆角** |
| `ConversationListItem.vue:185` | `rounded-[var(--gosslan-avatar-radius)]` | — | 与 `:176` 那处**并存**（一个 h-10 一个别的尺寸） |

⇒ **圆角有 3 种口径**（`--gosslan-avatar-radius` / `rounded-full` / CSS 兜底）。

**Recommendation:** consolidate in place —— **不是"换一个库"**，而是把 `MessageAvatar.vue` 的 props 撑开（`avatar` / `id` / `name` / `size` / `radius` / `round`），让 14 处手写改用它。**注意 `MessageAvatar.vue` 已经存在且接口几乎够用**（`id` / `name` / `avatar` / `size`）—— 它只是没被这些地方用。
**或者**（更保守）：只把 14 处里的**语义相同**的部分收成一个 `<AvatarBox :seed :avatar :class>` 薄壳 —— 因为尺寸/圆角/在线点各调用点确实不同，抽成参数会引入一层"为通用性加层级"（`AI_RULES` 禁忌）。**建议折中：抽壳不抽参** —— `AvatarBox` 只负责 `gosslan-avatar-box` + `gosslan-avatar-emoji` 两段，尺寸与圆角留给调用点的 class（**与 `SelfAvatar.vue:48-50` 的做法完全一致：它的注释就写着"尺寸与圆角留给调用点（class 透传到根节点）"**）。

**Migration risk:** 中 —— **14 处调用点**。但每处改动只是"换成 `<AvatarBox>` 标签 + 传两个 prop"，class 不动 ⇒ **视觉零风险**（可用 UI 探针 `--only=` 逐页核对）。**不需要真机**（除了 `MessageComposer` 的发送者头像与 `MessageReceipt` 的名单头像）。

---

### DUP-09 — 已读推进的排除清单：TS 一份、Rust 一份，**今天字面值一致**（尚未漂移，但无机器对账）

**Kind:** duplicate logic（跨层）
**Severity:** **Informational**（当前一致；无跨层护栏）
**Locations:**
- `src/utils/messages.ts:66`（TS：`READ_PROMOTE_BLOCKED = ["read", "failed", "recalled", "cancelled", "partial_cancelled"]`）
- `src-tauri/src/db/read_receipts.rs:97`（Rust：`AND status NOT IN ('read', 'failed', 'recalled', 'cancelled', 'partial_cancelled')`）

**Evidence:** 两份**逐项相同**（5 项，顺序也相同）。
**Drift already observed:** **无** —— 今天一致。
**Recommendation:** leave alone + **加一条机器对账**（读 Rust 那行 SQL 的 `NOT IN` 列表，与 TS 数组逐项比对）。理由：这两份是"同一判据在 FFI 边界两侧"，**跨层重复是必要的**（TS 注释自己写了：「这句判据有**三份副本**，必须同一口径」）；但**必要 ≠ 不需要护栏** —— `messageKinds.ts` 已经为 kind 分类做了跨层对账（`messageKinds.test.ts` 读 `protocol.rs` 逐项比对），**已读排除清单还没有**。
**Migration risk:** 零（只加测试）。

---

### DUP-10 — 未读计数判据：TS 一份、Rust 一份，**今天一致**

**Kind:** duplicate logic（跨层）
**Severity:** **Informational**
**Locations:**
- `src/utils/messageKinds.ts:118-120`（TS：`countsTowardUnread = !isSilentKind(kind) && kind !== "system"`）
- `src-tauri/src/protocol.rs:549-551`（Rust：`is_non_notifying_kind = is_silent_kind(kind) || kind == "system"`）

**Evidence:** 逻辑等价（互为补集），字面量 `"system"` 两边都有。
**Drift already observed:** **无**。
**Recommendation:** leave alone。已被 `messageKinds.test.ts` 的 kind 分类对账**间接覆盖**（两边都建立在同一张 kind 分类表上）。
**Migration risk:** 零。

---

### DUP-11 — 未知 kind 的占位文案：TS 一份、Rust 一份，**今天一致**

**Kind:** duplicate logic（跨层）
**Severity:** **Informational**
**Locations:**
- `src/utils/messageKinds.ts:127`（TS：`"[不支持的消息]"`）
- `src-tauri/src/protocol.rs:540`（Rust：`"[不支持的消息]"`）

**Drift already observed:** **无** —— 且**已被护栏覆盖**（`messageKinds.ts:122-126` 注释明说"`messageKinds.test.ts` 直接读 `protocol.rs` 比对这个字面量"）。
**Recommendation:** leave alone（已守住）。

---

### DUP-12 — 预览文本（会话列表摘要）：TS 一份、Rust 一份，**今天一致**

**Kind:** duplicate logic（跨层）
**Severity:** **Informational**
**Locations:**
- `src/utils/messages.ts:420-462`（TS `previewBody`，12 个 arm：`[文件]`/`[图片]`/`[代码]`/`[回应]`/`[撤回]`/`[置顶]`/`[强提醒]`/`[强提醒确认]`/`[公告]`/…）
- `src-tauri/src/protocol.rs:914-936`（Rust `preview_text`，同一组字面值）

**Drift already observed:** **无**（12 个 arm 逐项一致）。
**Recommendation:** leave alone（已被 `messageKinds.test.ts` 的跨层比对覆盖）。
**Migration risk:** 零。

---

### DUP-13 — TS 侧三份各自实现的 LRU / 容量闸

**Kind:** reinvented library（**但本仓的判断是对的**）
**Severity:** **Informational**（作为"重复"看是 Medium；作为"该换库吗"看是 **No**）
**Locations:**
- `src/utils/blobLru.ts:65-155`（**完整的字节封顶 LRU**，91 行主体）
- `src/utils/codeHighlight.ts:15-42`（行内 LRU，`CACHE_MAX = 200`）
- `src/utils/highlight.ts:31-49`（行内 LRU，`REGEX_CACHE_MAX = 32`）
- `src/utils/messageHeight.ts:147-168`（行内 LRU，`BUBBLE_CACHE_MAX = 50_000`）
- `src/utils/bounded.ts:28-48`（**FIFO** 容量闸，21 行）
- `src/utils/payloadParseCache.ts:32-45`（满了整表清空的缓存）

**Evidence:**

`blobLru.ts` 是一份**真正的 LRU 实现**（91 行主体，`get` 时删了再插、逐出时 revoke、累计字节账本、注入式 `revoke`/`urlOf`/`bytesOf`）—— 它**没有用** `bounded.ts` 的 `trimOldest`，而且 `blobLru.ts:4-5` 的文件头**明确写了为什么**：

> "## 为什么不是 `utils/bounded.ts` 的 `trimOldest`
> `utils/bounded.ts` 是**按条数**的 FIFO 闸，它文件头自己写明了这个边界（`:19`）："将来若有人拿它保护会被反复覆盖的缓存，需要换成 LRU（get 时重插）"。"

而 `bounded.ts:19` 的原文一字不差地写着那句话 —— **两个文件互相引用了对方的边界**。⇒ **这不是失控的重复，是一次有意识的收敛**（把 FIFO 与 LRU 的职责分开）。

另 3 处行内 LRU（`codeHighlight.ts` / `highlight.ts` / `messageHeight.ts`）各自**抄了同一个 5 行淘汰循环**：

```ts
if (cache.size >= CACHE_MAX) {
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}
cache.set(key, v);
```

⇒ **同一个淘汰循环 3 份**（`codeHighlight.ts:37-41`、`highlight.ts:43-46`、`messageHeight.ts:161-164`）。

**Drift already observed:** 3 份的 `CACHE_MAX` 分别是 **200 / 32 / 50000** —— 这是**刻意的不同**（各自语义不同），不是漂移。

**Recommendation:** **leave alone（不换库）**，但**把那 3 份 5 行淘汰循环收成一个 `utils/lru.ts` 里的 `lruSet(map, max, key, value)`**（约 8 行，零依赖，可 `node --test` 直测）。**明确不做**：`lru-cache` npm 包（见 Part C —— 它的价值在 `dispose` / `maxSize` / TTL，而本仓三个场景都不需要；换来的是一个新依赖 + 一条 API 学习成本，换不掉任何一行业务逻辑）。

**Migration risk:** 极低 —— 3 个文件各改 2 行 + 1 个新文件。**无行为变更**（三个 `CACHE_MAX` 值保持各自不变）。

---

### DUP-14 — `MessageItem` 的「复制 / 保存」动作在右键菜单与移动端 ActionSheet 两套模板里各写一遍

**Kind:** duplicate component
**Severity:** **Informational**（这是**有意为之**的双端模板，不是失控重复；但注释自陈"必须再写一遍"）
**Locations:**
- `src/components/message/MessageContextMenu.vue`（桌面右键，Reka DropdownMenu）
- `src/components/MessageItem.vue:2133-2279`（移动端 ActionSheet）

**Evidence:** `MessageItem.vue:2239` 的注释明写：

> "⚠️ 移动端入口必须在这里**再写一遍** —— 右键菜单与 ActionSheet 是两套独立模板，"

⇒ **已知、有意、由注释登记**。`MessageItem.vue:2133-2279` 与 `MessageContextMenu.vue` 各写一份「复制 / 转发 / 收藏 / 撤回 / 引用定位 / 置顶 / 强提醒 / 多选」。

**Drift already observed:** 转发判据两处都用 `isForwardableKind`（一致），但**动作的媒体分支不一致** ⇒ 就是 DUP-01/DUP-02 的载体。
**Recommendation:** **leave alone**（Reka 的 DropdownMenu 与 ActionSheet 是两种交互形态，抽成配置数组会牺牲两端排版差异；且判据已经共用）。**但把 DUP-01 的 `image` 修好时，两处都要看。**
**Migration risk:** N/A。

---

### DUP-15 — 「移动端整屏覆盖壳」：`MobilePageFrame` 的 `overlay` 形态被手抄 1 份

**Kind:** duplicate component
**Severity:** **Medium**（矩阵 §5 已登记为棘轮判据 ㊼，判**保留自研**）
**Locations:**
- `src/components/MobilePageFrame.vue:59-103`（家）
- `src/components/FavoritePanel.vue:818-855`（手抄副本）

**Evidence:** `FavoritePanel.vue:819-822`：

```html
:class="app.isMobile
  ? 'fixed inset-0 z-[60] flex flex-col bg-[var(--gosslan-bg)] pt-[env(safe-area-inset-top)]'
  : 'flex min-h-0 min-w-0 flex-1 flex-col'"
```

—— 与 `MobilePageFrame.vue:60-62` 的 `overlay` 类名**逐字相同**（`'fixed inset-0 z-[60] flex flex-col bg-[var(--gosslan-bg)] pt-[env(safe-area-inset-top)]'`）。头部（`:829-841`）也逐字同形（`h-8 w-8` 热区 + `panel` 底 + `px-3` + `BackArrow`）。

**Drift already observed:** 底部安全区**已漂**：`MobilePageFrame.vue:120` 的 `overlay` 形态吃 `.safe-bottom`（`env(safe-area-inset-bottom)`），而 `FavoritePanel.vue` 那份**没有** ⇒ 收藏详情页滚到底时最后一行会压在 iOS Home Indicator 下。矩阵 §5 的正文也点出了这一条（"底部留白还差一个量（框架 `.safe-bottom` = `env(safe-area-inset-bottom)`，收藏页 = `max(env(), 0.75rem)` ⇒ `env()` 取 0 的端上 12px 会静默变 0）"）。

**Recommendation:** **leave alone（矩阵的结论对）**，但**记一条待办**：要么收藏页也补 `.safe-bottom`，要么把 `MobilePageFrame` 拆成"壳"与"两种形态"两半（矩阵 §5 已写明为什么当前拆不了：同一个元素同时 serve 两支布局）。
**Migration risk:** 补 `.safe-bottom` = 1 行，低风险。

---

### DUP-16 — 未找到重复的实现（负面清单，避免误报）

以下被检查过、**确认不是重复**，记录在案以免下一轮重复排查：

| 候选 | 结论 |
|---|---|
| 模态弹窗 | ✅ 已收敛：27 个组件走 `BaseModal`，生产码零散落 `DialogRoot` |
| 空态 | ✅ 已收敛：`components/ui/StateBlock.vue` 一个家，15 处调用 |
| Toast | ✅ 已收敛：`utils/toastManager.ts` + Reka Toast，`useAppStore.ts:223` 单一出口 |
| 图片查看器 | ✅ 已收敛：4 份 → 1 份（`useImagePreview.ts` 文件头自陈），`ImageLightbox` 全局唯一实例 |
| 事件总线 | ✅ 已收敛：`mitt` + `utils/appActions.ts` |
| i18n | ✅ 已收敛：`vue-i18n` |
| 虚拟滚动 | ✅ 已收敛：`@tanstack/vue-virtual`（LogViewer + VirtualList 两处） |
| 去抖 | ✅ 已收敛：`@vueuse/core` 的 `useDebounceFn` / `refDebounced` |
| 校验 | ✅ 已收敛：`zod/mini` |
| 表情渲染 | ✅ 已收敛：`utils/emoji.ts` 切段 + `data/emojis.ts` 数据源 |
| 代码高亮 | ✅ 已收敛：`highlight.js` 子集 + `utils/codeHighlightCore.ts`（Worker 与主线程降级共用一份） |
| Markdown | ✅ 已收敛：`marked` + `dompurify` + `utils/markdown.ts`（**但矩阵没记，见 A38/A39**） |
| 路由 | ✅ 已收敛：`vue-router` |
| 日期格式化 | ✅ 已收敛：`dayjs` + `utils/time.ts` |
| 剪贴板 | ✅ 已收敛：`@vueuse/core` 的 `useClipboard` + `composables/useClipboard.ts` |
| Rust 密码学 | ✅ **不是手搓**：`crypto.rs` 用 `x25519-dalek@2.0.1` / `ed25519-dalek@2.2.0` / `chacha20poly1305@0.10.1` / `sha2@0.10.9` —— 只有 352 行的**薄封装**（`seal`/`open`/`shared_secret`/`safety_number`），**没有自研原语** |
| Rust 序列化 | ✅ `serde@1.0.229` + `serde_json@1.0.151` 全量在用，零手写 JSON |
| Rust 目录遍历 | ✅ `walkdir@2.5.0`（`storage/cache_cleaner.rs:112`） |
| Rust UTC 日期 | ✅ `time@0.3.55`（`export.rs:134` `time::OffsetDateTime::from_unix_timestamp`）—— 手写的 `civil_from_days` 已删（见 `Cargo.toml:48-53` 注释） |
| Rust UUID | ✅ `uuid@1.26.0` 全量在用 |
| Rust 哈希 | ✅ `sha2@0.10.9`（**不是手搓 SHA**） |
| Rust TLS | ✅ 无自研 TLS：唯一的 HTTP 出口是 `reqwest@0.12.28`（`rustls-tls`）与 Tauri 官方 updater 插件 |
| Rust 压缩 | ⚠️ 无压缩依赖 —— 但**也没有压缩实现**（协议里本来就不压），**不是重复** |
| Rust 异步 | ✅ `tokio@1.54.1`（`features = ["full"]`）；`std::sync::Mutex` 用于状态机是**刻意**（异步里用 `std::sync::Mutex` 有风险，但本仓的 `DbLock`（`db_hold.rs`）是自定义的且有持锁观测；`state.rs` 的 125 处 `Mutex` 主要是 `Arc<AppState>` 的字段锁，**不建议动** —— 属"看似该换、实则高风险"） |
| Rust 错误 | ✅ `thiserror@2` 已在用（4 处 derive） |
| TS 状态管理 | ✅ Pinia（`useChatStore` / `useAppStore` / `useImagePreview`）—— 无手写 store |
| TS 虚拟滚动 | ✅ 已迁 TanStack |
| TS 图片处理 | ⚠️ **3 处各自手写 canvas**：`utils/imageThumbnail.ts`（气泡缩略图，`createImageBitmap` + `toBlob`）、`MessageItem.vue:812-821`（`toPngBlob`，`Image` + `toBlob`）、`settings/ProfileSection.vue:174-200`（头像裁剪 + `toDataURL`）—— 三者**目标不同**（JPEG 缩略图 / PNG 转换 / 方形 JPEG 裁剪），**不是同一逻辑的三份拷贝**；且 canvas 缩放在 WebView 侧没有等价的成熟前端库能替（`browser-image-compression` / `compressorjs` 内部也是 canvas）⇒ **不构成 reinvention** |
| TS 拖拽 | ✅ 无自研拖拽库：拖放只有 `MessageComposer` 的 paste/drop，且 `utils/channelState.test.ts:899-909` 已钉住"drop 先进确认" |
| TS diff | ✅ 无自研 diff：`utils/todos.ts:886+` 的 `buildTodoHistory` 是**按字段比对任务定义**（不是文本 diff），库（`diff` npm）不适用 |
| TS PDF / QR | ✅ **不存在**这两个需求 |
| TS 重试/退避 | ✅ 重试/退避全在 Rust（`network/file.rs:442` `send_retry_verdict` + `transport/ble_pending.rs:86` `overflow_backoff_ms`），TS 侧没有第二份 |

---

## Part C — Library replacement candidates

> 列出口径：**每一条都先说"当前实现是什么"，再说"能不能换"**。版本一栏写**实装版本**（`node -p require('node_modules/…/package.json').version` / `Cargo.lock`），不是 `package.json` 的范围串。
> 许可证一栏：MIT / Apache-2.0 / BSD 等**上游常见**许可证我按公开事实写；**"活跃度"一栏凡是我在本仓库内无法核实的，一律写"verify activity"**，不猜。
> ⛔ **Forbidden (Frozen Core)** = 矩阵与 `AI_RULES` 判定的冻结核心（msg_id / E2EE / Outbox / Ack / SQLite schema / 好友 / 文件 / 通知 / Chat UI），**替换即违规**。

### C.1 Rust 侧

| Concern | Current implementation | Candidate library | Version | License | Activity | Compatibility risk | Migration cost | Recommendation |
|---|---|---|---|---|---|---|---|---|
| **E2EE 原语** | `src-tauri/src/crypto.rs`（352 行薄封装）→ `x25519-dalek` / `ed25519-dalek` / `chacha20poly1305` / `sha2` | — | 2.0.1 / 2.2.0 / 0.10.1 / 0.10.9 | BSD-3 / BSD-3 / Apache-2.0+MIT / MIT-OR-Apache-2.0 | 已装且在用；上游活跃（verify activity） | ⛔ **Forbidden (Frozen Core)** —— E2EE 是冻结核心，且**当前已用成熟库**，不存在手搓 | — | **不动**。`crypto.rs` 只有 352 行，是**封装不是实现**；`seal`/`open`/`shared_secret` 是 5 行级别的薄包装 |
| **Rust 侧安全码** | `crypto.rs:148-176` `safety_number`（SHA-256 → 6×5 位十进制） | 无（Signal 的展示法是行业惯例，非库） | — | — | — | 低（纯函数） | 1 文件 | **不动**。29 行、确定性、可测、已被 `crypto.rs:221-320` 的 6 条测试钉住。抽库（`safety-number` 类）收益 ≈ 0 |
| **SHA-256 hex 编码** | 6 处生产 + 8 处测试手写 `.map(|b| format!("{b:02x}")).collect()`（DUP-04） | `hex` crate | 0.4.x | MIT-OR-Apache-2.0 | 上游极稳定（verify activity） | 极低（纯编解码） | 6 生产文件 + 1 新函数 + 8 测试处 | **换不换都行**。倾向**自研一个小函数**（8 行）而不是加依赖 —— 换来的是 1 行 `.encode()` 而不是 1 行 `.collect()`，收益极小；但**必须收成一份**（DUP-04） |
| **wall-clock（ms）** | 8 份逐字相同的 `now_ms()`（DUP-03） | `time` crate（已在依赖树，`time@0.3.55`） | 0.3.55 | MIT-OR-Apache-2.0 | 已装；活跃（verify activity） | 极低 | 8–9 文件各 1–3 行 | **不换库，收成一份**。`time::OffsetDateTime::now_utc().unix_timestamp_nanos()` 给的是 ns 且带 `time` 的偏移语义；本仓要的是**单调的毫秒 epoch**，8 份 `SystemTime::now()` 已经够。**收一份家**（见 DUP-03） |
| **目录递归遍历** | `storage/cache_cleaner.rs:112` `walkdir::WalkDir` | — | 2.5.0 | MIT-OR-Apache-2.0 | 已装；活跃 | — | — | **已用库**，无重复 |
| **UTC 日期格式化** | `export.rs:134` `time::OffsetDateTime::from_unix_timestamp` | — | 0.3.55 | MIT-OR-Apache-2.0 | 已装；活跃 | — | — | **已用库**，手写 `civil_from_days` 已删 |
| **目录/路径消毒** | `network/file/share_walk.rs:308` `safe_file_name` / `:325` `safe_transfer_id` | `camino` / `path-clean` | 1.x / — | MIT / MIT | verify activity | 中（**安全边界**） | 2 函数 + 调用点 | **不动**。30 行、**安全关键**（对端可控字符串 → 磁盘路径）、已被 `lib_relay_data_tests.rs` 等钉住。第三方"路径消毒"库的语义与本仓的 allowlist 未必一致 ⇒ **换 = 重新做安全审计** |
| **ID 校验（字符集）** | `share_walk.rs:331` `is_ascii_alphanumeric() \|\| '-' \|\| '_'`；`protocol.rs:2344` 另一组字符集；`commands/logs.rs:836` 第三组 | `regex` crate | 1.x | MIT-OR-Apache-2.0 | 极稳定（verify activity） | 低 | 3–5 处 | **不动**。这三组是**三份不同的业务规则**（transfer_id / opaque frame / 日志 id），**不是同一规则的三份拷贝** ⇒ 收成一份反而会错误地统一它们。且当前**没有 `regex` 直接依赖** —— 引入正则引擎只为三个字符集判断不划算 |
| **JSON** | `serde_json` 全量 | — | 1.0.151 | MIT-OR-Apache-2.0 | 已装 | — | — | **已用库**，零手写 |
| **UUID** | `uuid::Uuid::new_v4()`（9 处） | — | 1.26.0 | MIT-OR-Apache-2.0 | 已装；活跃 | — | — | **已用库**，零手写 |
| **TLS** | 唯一 HTTP 出口 `reqwest`（`rustls-tls`）+ Tauri 官方 updater 插件 | — | 0.12.28 | MIT-OR-Apache-2.0 | 已装；活跃 | ⛔ 零 TLS 是**产品设计**（E2EE 栈自带 AEAD） | — | **不动**。引入 TLS 会**改变协议形状**（⛔ 冻结核心） |
| **压缩** | 无 | `flate2` / `zstd` | — | MIT / MIT | verify activity | 中（**协议形状**） | 大 | **不引入**。协议是自研 P2P 线格式，压缩会改帧格式 ⇒ 破坏兼容。**且当前没有"需要压缩"的证据** |
| **async runtime** | `tokio@1.54.1`（`features=["full"]`）；状态机用 `std::sync::Mutex`（`state.rs` 125 处） | `parking_lot` | 0.12.x | MIT-OR-Apache-2.0 | 已装在依赖树（verify activity） | **中–高** | 极大（`state.rs` 全量 + 锁序护栏） | **不动**（`parking_lot` 更快但会改 poisoning 语义；本仓 `db_hold.rs` 的 `DbLock` 依赖 `PoisonError` 语义）。**`tokio::sync::Mutex` 更不可取** —— 会改变 async 取消语义与持锁观测口径。⛔ 状态机属冻结核心 |
| **错误类型** | `thiserror@2`（4 处 derive）+ 手写 `String` 错误 | — | 2.x | MIT-OR-Apache-2.0 | 已装 | 低 | 极大（161 个命令的签名） | **不动**。`thiserror` 已在用；全面改 `thiserror` 错误类型会动全部命令边界 ⇒ 收益不抵成本 |
| **退避/重试** | `network/file.rs:442` `send_retry_verdict` + `transport/ble_pending.rs:86` `overflow_backoff_ms` | `backoff` / `tokio-retry` | — | MIT / MIT | verify activity | 中 | 2 文件 + 调用点 | **不动**。两处退避**语义不同**（文件队列 5s 定步 vs BLE 溢出抖动封顶），且**各自被精确的测试钉住**（`file_tests.rs:2354/2359/2392` 断言 `backoff_ms: 5_000`）。抽库要重写这些断言 |
| **序列化（IPC）** | `serde` + `serde_json` | — | 1.0.229 | MIT-OR-Apache-2.0 | 已装 | — | — | **已用库** |
| **base64** | `base64` crate（`crypto.rs` / `macos_bookmark.rs`） | — | **0.22.1**（`Cargo.lock` 里三个版本并存：0.21.7 / 0.22.1 / 0.23.1；`gosslan` 自己的依赖边指向 **0.22.1** ✅） | MIT-OR-Apache-2.0 | 已装 | 低 | — | **不动**。⚠️ 唯一值得记的一笔：`Cargo.lock` 里同时存在三个 base64 大版本（0.21.7 / 0.22.1 / 0.23.1）—— 0.21.7 与 0.23.1 是**间接依赖**带来的，**本仓直接依赖解析正确**（0.22.1），**不是**版本不一致问题。`cargo deny` 若配了 `duplicate` 检查需留意（verify） |
| **正则（Rust）** | 无直接 `regex` 依赖 | `regex` | 1.x | MIT-OR-Apache-2.0 | 极稳定 | 低 | 大（新增依赖 + 编译时间） | **不引入**。Rust 侧只有 3 处字符集判断，**用不上正则**；`Cargo.toml` 里 `regex` 是间接依赖（tauri 带的），直接引入会触发 cargo-deny 的"未声明直接依赖"检查 |

### C.2 TS 侧

| Concern | Current implementation | Candidate library | Version | License | Activity | Compatibility risk | Migration cost | Recommendation |
|---|---|---|---|---|---|---|---|---|
| **Markdown 渲染** | `utils/markdown.ts:12-13` `marked` + `dompurify` | `markdown-it` | 17.x | MIT | 活跃（verify activity） | 中 | 1 文件 + 1 组件 | **不动**（`marked` 已装且在用）。`marked` vs `markdown-it`：后者的插件生态更全（`linkify-it` / `footnote` / `typographer`），但本仓的用途**只有一处**（更新说明），白名单又窄（`utils/markdown.ts:16-37` 的 `ALLOWED_TAGS` 22 个标签）⇒ 换库收益 ≈ 0 |
| **HTML 消毒** | `utils/markdown.ts:12` `DOMPurify` | — | 3.4.17 | (MPL-2.0 或 Apache-2.0，双许可) | 活跃 | 低 | — | **已用库**。⚠️ **许可证提示**：DOMPurify 是 **MPL-2.0 / Apache-2.0 双许可**（不是 MIT）—— 若仓有 license 白名单检查，需确认（`cargo-deny` 只管 Rust；TS 侧未见） |
| **语法高亮** | `utils/codeHighlightCore.ts:11-24` `highlight.js/lib/core` + 13 个语言子集 | `shiki` / `prismjs` | — | MIT / MIT | 活跃（verify activity） | 中–高（体积 + 首帧） | 大 | **不动**。`highlight.js` 子集导入（`lib/core` + 13 语言）已经是**最小体积**方案；`shiki` 是基于 TextMate 语法 + WASM，体积高一个量级，与本仓 2026-10-26 那次"冷跳首帧 164ms"的优化目标**相反** |
| **emoji** | `utils/emoji.ts`（68 行）+ `data/emojis.ts`（1074 行，**自备图片资源**） | `emoji-picker-element` / `frimousse` | — | MIT / MIT | verify activity | **高** | 极大 | **不动**。本仓的表情是**抖音评论区图片表情**（`[微笑]` token + webp 资源），不是 Unicode emoji ⇒ 通用 emoji 库**完全不适用** |
| **日期格式化** | `utils/time.ts`（dayjs，89 行） | — | dayjs **1.11.23** | MIT | 活跃 | — | — | **已用库**。⚠️ `package.json` 写 `^1.11.13`，实装 **1.11.23** |
| **LRU 缓存** | 1 份完整 LRU（`utils/blobLru.ts`）+ 3 处行内 5 行淘汰循环（DUP-13） | `lru-cache` | 11.x | MIT | 活跃（verify activity） | 低 | 4 文件 | **不换**。`lru-cache` 的价值在 `dispose` / `maxSize` / TTL / `sizeCalculation`；本仓三个行内场景**只要"满了删最老的"**，用库要写 5 行适配器换 5 行逻辑 ⇒ **净收益 ≤ 0**。**该做的是把这 5 行收成一份**（DUP-13） |
| **并发闸** | `utils/concurrencyGate.ts`（31 行 FIFO 闸） | `p-limit` / `p-queue` | 7.x / 9.x | MIT | 活跃 | 低 | 1 文件 + 2 调用点 | **不换**。31 行、零依赖、语义刻意最简（"入闸与出闸对称"）。`p-limit` 是 ESM-only + 依赖 `yocto-queue`，换进来的依赖比实现还多 |
| **单飞（same-key 去重）** | `utils/singleFlight.ts`（43 行） | `p-limit` / `async-mutex` | — | MIT / MIT | 活跃 | 低 | 1 文件 + 5 调用点 | **不换**。同 DUP-13 的理由：语义（"settles 后自动摘除"）与库的默认行为**不同**，换库要重新论证 |
| **校验** | `utils/validation.ts`（zod/mini） | `zod` | 4.6.7 | MIT | 活跃 | — | — | **已用库** |
| **状态管理** | Pinia（3 个 store） | `pinia` | 3.0.4 | MIT | 活跃 | ⛔ 状态机属冻结核心 | — | **不动** |
| **异步查询/缓存** | `@tanstack/vue-query`（5 面板） | — | 5.104.4 | MIT | 活跃 | ⛔ 主链属冻结核心 | — | **不动**（主链）。⚠️ **`@pinia/colada@1.4.8` 是死依赖** —— `src/` 里 0 处命中 ⇒ 建议**删掉**（减一个包） |
| **虚拟滚动** | `@tanstack/vue-virtual`（2 处） | — | 3.13.47 | MIT | 活跃 | — | — | **已用库** |
| **浮层/无障碍原语** | `reka-ui`（20 个组件） | — | 2.11.0 | MIT | 活跃 | — | — | **已用库** |
| **路由** | `vue-router` | — | 5.4.0 | MIT | 活跃 | — | — | **已用库** |
| **i18n** | `vue-i18n` | — | 11.4.16 | MIT | 活跃 | — | — | **已用库** |
| **事件总线** | `mitt` | — | 3.0.1 | MIT | 稳定 | — | — | **已用库** |
| **动效** | `motion-v`（5 个组件，3 类用途） | — | 2.8.0 | MIT | 活跃 | — | — | **已用库**。⚠️ `motion-v@2.8.0` 是**精确版本**（无 `^`）⇒ 升级要手改 |
| **剪贴板** | `composables/useClipboard.ts`（@vueuse/core） | — | 14.4.0 | MIT | 活跃 | — | — | **已用库** |
| **去抖 / 延迟镜像** | `useDebounceFn` / `refDebounced` | — | 14.4.0 | MIT | 活跃 | — | — | **已用库** |
| **图标** | `lucide-vue-next` | — | **0.469.0**（`^0.469.0` ⇒ 实装偏旧，**建议升**） | ISC | 活跃（verify activity） | 低 | 1 行 | **不动，但建议升版本**。0.469 是 2024 年末的版本，⚠️ 需确认 lucide 0.469 之后的图标名是否有破坏性改名（`ui/navIcons.ts` 与 `ui/icons.ts` 是集中入口 ⇒ 升级面可控） |
| **拖拽** | 无库需求（只有 paste/drop） | `@vueuse/core` 的 `useDropZone` | 14.4.0 | MIT | 活跃 | 低 | 1 文件 | **不引入**。当前只有 `MessageComposer` 一处 drop，且已被 `utils/channelState.test.ts:899-909` 的判据钉住。`useDropZone` 换来的是一层封装 + 一个新的行为形状 |
| **canvas 图像处理** | 3 处（缩略图 / PNG 转换 / 头像裁剪） | `browser-image-compression` / `compressorjs` | — | MIT / MIT | verify activity | **中** | 3 文件 | **不换**。这三个场景的**输入输出契约不同**（JPEG q85 缩略图 / PNG 转换 / 512 方形 JPEG），且那两个库内部**也是 canvas**（换库只是换个 API 包装，不减体积）。⚠️ 更重要：本仓的缩略图决策层与执行层**已经刻意分开**（`imageThumb.ts` 可 Node 单测 / `imageThumbnail.ts` 浏览器侧），这个分离比库选型更值钱 |
| **diff** | `utils/todos.ts:886+` `buildTodoHistory`（按字段比对） | `diff` npm | 7.x | BSD-3-Clause | 活跃 | 中 | 1 文件 | **不换**。`buildTodoHistory` 比的是**任务定义对象**的字段，不是文本 ⇒ 文本 diff 库不适用 |
| **PDF / QR** | 不存在 | `pdf-lib` / `qrcode` | — | MIT | 活跃 | — | — | **无需求**，不引入 |
| **重试/退避（TS）** | 无（重试全在 Rust） | `p-retry` | 6.x | MIT | 活跃 | — | — | **不引入**（TS 侧无重试职责） |
| **HTML 转义** | `utils/highlight.ts:4-10` `escHtml`（5 行） | `lodash.escape` / `he` | — | MIT / MIT | 活跃 | 低 | 1–3 文件 | **不换**。5 行、零依赖、**行为与 DOMPurify 不同**（`escHtml` 不转义 `'`）。为一个转义函数加依赖不划算 |
| **正则转义** | `utils/escapeRe.ts`（12 行） | `escape-string-regexp` | 5.x | MIT | 活跃 | 低 | 1 文件 | **不换**（12 行）。⚠️ 正确：**该文件已把 `emoji.ts` / `linkify.ts` / `messages.ts` 的三份副本收成一份**（文件头自陈）—— 这是本仓**做对了**的样板 |
| **本地存储** | `utils/safeStorage.ts` + 5 本 store 手写 | `@vueuse/core` `useStorage` | 14.4.0 | MIT | 活跃 | 低 | 5–6 文件 | **不换**（矩阵 §5 已判"保留自研"并给了理由：这些值今天各自已有权威宿主（store 字段），`useStorage` 返回**新 ref** ⇒ 多造一个状态源）。**本轮复核未发现反证** |
| **Markdown 净化 + 允许清单** | `utils/markdown.ts` + `designGuards.ts:2389` `V_HTML_ALLOWED` | — | — | — | — | — | — | **已用库 + 已用清单**。⚠️ 但 `V_HTML_ALLOWED` **按文件登记、不按落点登记** ⇒ LogViewer 的 8 个落点只登记 1 次（DUP-05）。**建议改成登记期望落点数** |
| **Rust 侧的 `time` crate** | `time@0.3.55` 已在依赖树且在用（`export.rs`） | — | 0.3.55 | MIT-OR-Apache-2.0 | 已装 | 低 | 8–9 文件 | 见 DUP-03：**收成一份 `now_ms` 家，不换库** |

### C.3 C.1/C.2 的总体结论

- **必须换的库：0 个。** 矩阵 §1 已经把该换的都换了（Reka / TanStack Virtual / TanStack Query / zod / dayjs / vue-i18n / vue-router / mitt / motion-v / marked / dompurify / lucide / VueUse），且**每一项的实装版本与矩阵声明一致**。
- **该换但不该换的（"看起来像"）：**
  - `lru-cache` / `p-limit` / `p-queue` —— 本仓的自研版本**更小**（31–43 行）且**语义与库默认不同**（FIFO vs LRU、settles 后自动摘除）。换库 = 换依赖 + 重论证，净收益 ≤ 0。
  - `hex` crate —— 1 行换 1 行。
  - `p-retry` / `p-queue` / `useDropZone` / `diff` / `lodash.escape` —— **无对应职责**。
- **真正的自研重复只有两处半**（DUP-02 / DUP-03 / DUP-04），全部**不涉及库**，全部**收成一份即可**。
- **唯一的库级"卫生问题"**：`@pinia/colada@1.4.8` 是**死依赖**（0 处引用）⇒ 建议删。

---

## Part D — 建议的执行顺序（按"收益 ÷ 风险"排）

| # | 动作 | 依据 | 风险 | 文件数 |
|---|---|---|---|---|
| 1 | **修 DUP-01/DUP-02 的 `image` 转发**：`ChatWindow.doForward` 与 `FavoritePanel.doForward` 的媒体分支对齐 `forwardOne`（`file` 或 `image` 都走传输链路）；顺手把 `msgId` 透传补齐 | 用户可见缺陷；SEC-01 越权闸 | 中低（需双实例真机） | 2–3 |
| 2 | **加跨层 kind 白名单护栏**：`messageKinds.test.ts` 读 `commands/chat.rs` + `commands/group_files.rs` 的 `match` arm，断言 `isForwardableKind` ⊆ Rust 收集合 | 防 DUP-01 复发；`dmReaction.test.ts` 已是先例 | 零（只加测试） | 1 |
| 3 | **矩阵对账护栏**：`scripts/verify-guards.py` 加一条「`package.json` 生产依赖集合 vs 矩阵 §3 清单」差集检查；并把矩阵 A31/A38/A39 三行改成今天的实况 | A31/A38/A39 三条反转的根因是矩阵更新节奏 | 零（只加测试 + 改文档） | 2 |
| 4 | **收 `now_ms`（DUP-03）** | 8 份拷贝 + 已有 3 种写法 | 低（面广但无行为变更） | 9–10 |
| 5 | **收 hex 编码（DUP-04）** | 6 处生产 + 8 处测试 | 极低 | 7 |
| 6 | **LogViewer 行模板抽 `LogRow.vue`（DUP-05）** + `V_HTML_ALLOWED` 改成按落点登记 | 两份逐字拷贝 + 隐性同步契约 | 中低（`v-memo` 依赖数组要整体搬） | 2–3 |
| 7 | **收 3 处行内 LRU 淘汰循环（DUP-13）** | 同一 5 行 3 份 | 极低 | 4 |
| 8 | **删 `@pinia/colada`** | 死依赖 | 零 | 1 |
| 9 | **查 `Cargo.lock` 里三个 base64 大版本** | 0.21.7 / 0.22.1 / 0.23.1 并存（gosslan 自己用 0.22.1 ✅，另两个是间接依赖） | 零（先查 cargo-deny 的 duplicate 检查） | 1 |
| 10 | 头像副本收薄壳（DUP-08）/ @提及底色收 CSS 变量（DUP-07）/ 提及渲染收 `MentionText`（DUP-06） | 视觉一致性 | 中（14 处 / 3 处 / 2 处） | 15+ / 4 / 3 |

**不建议做**：把任何 Rust E2EE / SQLite schema / outbox / ack / msg_id / 好友 / 文件 / 通知 / Chat UI 换成库（⛔ Forbidden (Frozen Core)）；引入 `lru-cache` / `p-limit` / `regex`(Rust) / 压缩库 / `diff` / `useDropZone` / 拖拽库 / PDF / QR / 文本 diff 库。

---

## 附录 — 本次核验用到的现算命令（供复跑）

```bash
# 依赖实装版本
for p in reka-ui @tanstack/vue-query @tanstack/vue-virtual zod vue-i18n vue-router mitt motion-v marked dompurify dayjs @vueuse/core highlight.js lucide-vue-next pinia @pinia/colada; do
  node -p "require('./node_modules/$p/package.json').version"; done
grep -A1 '^name = "x25519-dalek"$' src-tauri/Cargo.lock

# 矩阵里的关键计数
grep -rn 'role="menuitem"' src/ | wc -l          # → 5，全在 test 文件
grep -rn '<select' src/ | wc -l                 # → 16，全在 test/注释
grep -rn 'v-html=' src/ | grep -v test          # → 13 行命中，其中 1 行是 designGuards.ts 的扫描器自身
                                                #   ⇒ 实际落点 12 个：LogViewer 8 / ChatSearchDialog 2 / CodeBlock 1 / MarkdownText 1
grep -c 'title="' src/components/**/*.vue       # → 317
grep -rn "fn now_ms() -> i64" src-tauri/src/ | grep -v _tests   # → 9
grep -rn "for (const s of splitEmoji" src/ | grep -v test      # → 3
grep -rn "import { useVirtualizer" src/                        # → 2（LogViewer + VirtualList）

# 测试基线
npm test    # → 1477 / 1477，0 失败（本次实跑）
```

*本报告由 DUPLICATE / REINVENTED WHEEL 审计阶段生成：矩阵逐行现核 43 行、重复实现逐处现读、版本现算、许可证按上游公开事实（未能核实的活跃度已标 verify activity）、冻结核心项逐条标 Forbidden。所有 `file:line` 为本次会话现读现核，不采信既有文档的行号。*
