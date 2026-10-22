# 前端性能反模式清单

> 状态：进行中（2026-10-22 首批已修）  
> 口径：每条都要能指到真实文件 / 行号与复跑命令；未测的写 NOT RUN，不写「应该没问题」

本文件只收**会直接让交互变慢或变卡**的模式。纯风格问题归 `docs/design-guidelines.md`。

## 1. 三条铁律

1. **模板里不调 O(n) 函数。** 列表行上的 `memberProfile(id)`、`nicknameOf(id)`、`rowTitle(f)` 这类调用，先在 `computed` 里算成行数据；`v-for` 里每行最多一次。
2. **长列表必须有上界或虚拟化。** 可变长集合要有 `MAX_*` 常量；虚拟列表行内**禁止**入场动画与改变布局的动画。
3. **IPC 不在 `watch` 的数组 getter 里。** `watch(() => [a, b, c])` 的依赖一变就发一次请求；把「消息条数」放进链路查询的依赖里，等于每条消息一次 IPC。

## 2. 已修（2026-10-22 首批）

| # | 模式 | 位置 | 改法 | 证据 |
|---|---|---|---|---|
| 1 | 长列表头像缺 `loading` / `decoding` | `src/components/conversation/ConversationListItem.vue`、`FriendListItem.vue`、`GroupMemberPanel.vue`、`EmojiPicker.vue` | 补 `loading="lazy" decoding="async"` | `grep -rn 'loading="lazy"' src/components` |
| 2 | 成员行每行 11 次资料解析（每次内部多次线性扫描） | `src/components/GroupMemberPanel.vue` | 新增 `memberRows` computed，每成员只解析一次 | 模板里 `memberProfile(` 只出现在 setup 的 `memberRows` |
| 3 | 链路查询把 `messages.length` 放进 watch 依赖 ⇒ 每条消息一次 IPC | `src/components/ChatWindow.vue` 的 `refreshLinkState` watch | 依赖收成 `activeConv + peerLink` | 同一 watch 源里不再有 `messages.value.length` |
| 4 | `addableFriends` 用 `members.includes`（O(好友×成员)） | `src/components/GroupMemberPanel.vue` | `Set.has` | 源码 `new Set(group.value?.members)` |
| 5 | `v-memo` 依赖里 `isOnline` 每次 O(F) 扫好友表 | `src/components/ConversationList.vue` | `friendById` Map + `get` | `isOnline` 走 `friendById.value.get` |
| 6 | 文件进度条用 `width` 驱动布局 | `src/components/message/MessageFileBubble.vue` | `transform: scaleX()`，只走合成层 | `origin-left ... transition-transform` |
| 7 | 消息回执状态硬切 | `src/components/message/MessageReceipt.vue` | Vue `<Transition name="receipt-swap">` | 状态切换有 120/200ms 过渡 |
| 8 | Toast / 未读徽标无进出场 | `src/components/ToastList.vue`、`UnreadBadge.vue`、`src/style.css` | `gosslan-toast` / `unread-badge` 动画 | 样式在 `src/style.css` |
| 9 | 公告每次消息变动扫整段历史 `JSON.parse` | `src/components/ChatWindow.vue` | 改读 store 的 `activeAnnouncements` 缓存（后端 SQL 已折公告+墓碑） | 旧 `m.kind !== "announcement"` 全量扫描已删 |
| 10 | 收藏行每行 8 次 `rowTitle`/`rowSubtitle`/`kindStyle`/`kindIcon`，且集合无上界 | `src/components/FavoritePanel.vue`、`src/stores/useChatStore.ts` | `rows` computed 一次算好；`MAX_FAVORITES` 上限 + 提示 | 行内只读 `row.*`；超限 toast |
| 11 | `vendor` 单块过大（motion-v 引入后 >500 KB） | `vite.config.ts` | `motion` 拆独立 chunk（motion-v / framer-motion / motion-dom / motion-utils / hey-listen） | 构建后 `motion` 独立 chunk；vendor 回到约 114 KB gzip |
| 12 | 滚动条时隐时现 / 内容因滚动条出现而横跳 | `src/style.css` | 原生 CSS 8px 细滚动条 + `scrollbar-gutter: stable`；居中内容 `.scrollbar-both` | 无 JS 滚动条；`offsetWidth-clientWidth` 可量 |

## 3. 未做（按收益 / 风险排序）

| # | 模式 | 位置 | 为什么先不做 |
|---|---|---|---|
| 1 | 按平台分档 `build.target`（今天 Linux/Android 也吃 `safari13` 降级） | `vite.config.ts` | 需要先出 metafile 与各平台真实字节差；只改 target 可能把兼容性一起改坏 |
| 2 | 收藏 `rowTitle` / `rowSubtitle` 的纯函数化与行为断言 | `src/components/FavoritePanel.vue` | 行数据已缓存；再拆纯函数属可维护性，不是当前卡顿的瓶颈 |
| 3 | `EmojiPicker` 的 `v-if` → `v-show` | `src/components/EmojiPicker.vue` | **不采纳**：面板有数百个 `<img>`，`v-show` 会在启动时就发请求；`v-if` + 懒加载更省 |

> 已确认不是缺口：`enforceMessageCacheBound` 已清 `pagesLoaded` / `loadSeqs` / `historyTops`；
> 缺的是**测试侧判据**，已登记在 §6。

## 4. 已确认的假问题（不许再当缺陷改）

- **`BUBBLE_CACHE_MAX` thrash**：产品上界是每会话固定条数，远低于缓存上限，不会触及淘汰。
- **`will-change`**：全仓没有滥用点，不需要为「性能」批量加。
- **lucide / highlight.js 全量引入**：产物里是按需 chunk，不是全量。
- **DOM 监听泄漏**：手写点有配对解绑；`useBackLayer` 的 `popstate` 由 `installed` 旗标保证全窗只挂一次。
- **`v-show` 只有一处**：不是缺陷，是当时的刻意选择。
- **`backdrop-filter` / `box-shadow` 在滚动行内**：不在滚动行内，且有 `prefers-reduced-transparency` 降级。
- **`setInterval` 未清理**：`LogViewer` 轮询有独立 WebView + 三重防护。
- **`@tanstack/vue-query` 配置错误**：现有配置（`retry: 1`、`retryDelay: 0`、`refetchOnWindowFocus: false`）是审计过的。
- **`100vh` / 安全区**：已收口到 `--gosslan-safe-top` 与 `--gosslan-window-safe-top`。

## 5. 依赖决策（2026-10-22 实测）

| 依赖 | 决定 | 实测 |
|---|---|---|
| `vue-router@5.4.0` | 采纳 | vendor gzip 从 104.92 → 114.15（同机 `npm run build`，2026-10-22）；换来真实历史条目与可深链 |
| `@pinia/colada@1.4.8` | 只装不接线 | 不进口，产物无增量；与 `@tanstack/vue-query` 职责重叠，迁移单独立项 |
| `motion-v@2.8.0` | **采纳（用户裁决）** | 2026-10-22 同机 `npm run build`：`motion` 独立 chunk gzip 51.02；vendor 114.56。只用于共享布局指示器、列表 FLIP、手势连续动画三类；图片缩略图不做 layout 补间（避免解码后从底部拉伸）；业务组件只能从 `src/utils/motion/` 导入 |

**口径**：动画默认纯 CSS；要引库必须先给出「哪个具体交互 CSS 做不到」+ 同机产物增量。一次只引一套。

## 6. 护栏落点

| 判据 | 位置 |
|---|---|
| `<img>` 必须同时有 `loading=` / `decoding=` | `src/utils/designGuards.test.ts` 的 `findImgTags` |
| 导航图标只能来自 `lucide-vue-next` 唯一出口 | `src/utils/designGuards.test.ts` 的「一级导航图标：全部走 lucide 唯一出口」 |
| 页面级返回层不得回到 `ResponsiveLayout` | `docs/architecture/routing-and-navigation.md` §4（复审项） |
| `motion-v` 只能从 `src/utils/motion/` 导入 | `src/utils/designGuards.test.ts` 的「motion-v 只能从统一封装层导入」 |
| 加载旋转只能在 `Spinner.vue` | `src/utils/designGuards.test.ts` 的「加载旋转只许在 Spinner.vue」 |
| 缓存上界 / 虚拟列表 | `enforceMessageCacheBound` 是 **store 函数**（`src/stores/useChatStore.ts`），会清 `pagesLoaded` / `loadSeqs` / `historyTops`；**测试侧判据缺失，登记为待补**。`VirtualList` 的判据见既有虚拟列表测试 |

## 7. 取数命令（禁止编造）

```bash
npm test
npm run build
node perf/run.mjs
node perf/latency.mjs
PERF_ONLY=mem node perf/run.mjs 20000
node perf/probe.mjs
node scripts/verify.mjs --list
```

产物体积以 `npm run build` 自己打印的 gzip 为准；改前改后必须同机、同 Node 版本。
