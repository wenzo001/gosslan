# 路由与导航层级规范

> 状态：已落地（2026-10-22）  
> 范围：主窗口、设置独立窗口、移动端底部导航；浮层（弹窗 / 菜单 / 灯箱）继续走手工返回栈  
> 关联：`docs/design-guidelines.md` §12、`docs/architecture/frontend-performance-antipatterns.md`

本文件是导航层级、返回语义与路由落点的唯一规范。路由条数以源码现算，不在文档里留第二份手抄：

```bash
grep -c '^    name:' src/router/mainRoutes.ts
grep -c '^  "' src/router/settings.ts
```

主窗口路由表是纯数据（`src/router/mainRoutes.ts`），不碰 `window`；`src/router/main.ts` 只负责
history 选择、导航方向与 router 实例。这样路由契约可以在 Node 里用 `createMemoryHistory` 直接解析测试。

## 1. 选型与历史模式

| 项 | 决定 | 理由 |
|---|---|---|
| 路由库 | `vue-router@5.4.0`（精确版本） | 体积小、Vue 官方维护；5.x 合并了 unplugin-vue-router，无破坏性变更 |
| 主窗口 history | `createWebHistory()` | 产生真实历史条目，保住 wry 的 Android 物理返回链（`canGoBack()`） |
| 兜底降级 | `createWebHashHistory()` | 用户 2026-10-22 裁决统一走 web history（`tauri:` / `asset:` 也走）；只有 `pushState` 真的抛错时才退 hash。两条都产生真实历史条目 |
| 设置窗口 | `createWebHashHistory()` | 窗口 URL 是 `settings.html`，path 模式刷新会落到不存在的文档路径 |
| 状态管理 | Pinia 继续做事实源 | 路由只承载「哪一层被打开」；会话 / 消息 / 传输状态仍在 store |

**没有采纳**：`createMemoryHistory()`。它不产生真实历史条目，Android 物理返回必须新增原生事件桥（要动 Kotlin），与「稳定优先」冲突。

## 2. 每个窗口一个 router

应用有 5 个独立 HTML 入口，每个入口是独立 Vue app + 独立 Pinia（`src/boot/boot.ts` 的 `createWindowApp`）。因此**不可能共享一个 router 实例**：

| 窗口 | 入口 | router | 路由范围 |
|---|---|---|---|
| 主窗口 | `index.html` / `src/entries/main.ts` | `src/router/main.ts` | 会话 / 通讯录 / 收藏 / 链接 / 我的 / 覆盖层 |
| 设置窗口 | `settings.html` / `src/entries/settings.ts` | `src/router/settings.ts` | `#/settings/:key`（10 个分区） |
| 日志 / 群任务 / 预览 | 单页入口 | **不需要** | 无可下钻的页面层级；筛选/任务详情是视图状态或浮层 |

跨窗口跳转继续走 `launchAuxWindow` 的 IPC；router 不跨窗口。

**为什么只有设置窗口需要 router**：它有 10 个可深链、可返回的分区；日志/群任务/预览都是单页工具，筛选与详情弹窗属于视图状态（R4），没有「整体换成一个新界面」的层级，强加路由只会制造空记录。

## 3. 主窗口路由表

| 路由名 | 路径 | 参数 / query | 目标 | 平台 | meta |
|---|---|---|---|---|---|
| `chats` | `/chats` | — | 会话列表 + 空态 | 双端 | `pane: list` |
| `conversation` | `/chats/:convId` | `msgId`（深链定位） | `ChatWindow` | 双端 | `pane: detail` |
| `contacts` | `/contacts` | — | 通讯录列表 | 双端 | `pane: list` |
| `requests` | `/contacts/requests` | — | `FriendRequestList` | 双端 | `pane: detail` |
| `friend` | `/contacts/:friendId` | — | `FriendProfile` | 双端 | `pane: detail` |
| `favorites` | `/favorites` | — | `FavoritePanel` 列表态（移动端普通一级 tab） | 双端 | `pane: list` |
| `favorite` | `/favorites/:favId` | — | 收藏详情（路由驱动，深链/返回） | 双端 | `pane: detail` |
| `links` | `/links` | — | `LinksList`（桌面 rail 一级） | 桌面；移动端兼容重定向到 `/me/links` | `pane: detail` |
| `me-links` | `/me/links` | — | `LinksList`（移动「我的」下钻，canonical） | 仅移动 | `pane: detail`, `depth: 2` |
| `me` | `/me` | — | 「我的」页 | 仅移动 | `pane: detail` |
| `profile` | `/me/profile` | — | `ProfileSection` + `MobilePageFrame` | 仅移动 | `overlay` |
| `settings` | `/me/settings` | — | 设置一级 | 仅移动 | `overlay` |
| `settings-section` | `/me/settings/:key` | `key` | 对应分区 | 仅移动 | `overlay`, `depth: 2` |
| `logs` | `/me/logs` | — | `LogViewer`（非 standalone） | 仅移动 | `overlay` |
| `search` | `/search` | `q` | `ChatSearchDialog` | 双端 | `overlay` |

设置窗口的路由是 `#/settings/:key`，分区清单在 `src/router/settings.ts` 的 `SETTINGS_SECTIONS`。

**旧路径兼容**（静态重定向，不允许掉进 catch-all）：

| 旧路径 | 落点 | 说明 |
|---|---|---|
| `/profile` | `/me/profile` | 桌面随后打开设置窗口（默认 profile 分区） |
| `/settings`（含 `/settings/:key`） | `/me/settings`（含 `/:key`） | 桌面打开设置窗口 |
| `/logs` | `/me/logs` | 桌面打开日志窗口 |
| 移动端 `/links` | `/me/links` | 运行期按平台归一；桌面保留 `/links` |

### 3.1 参数 / query / meta 契约

| 路由 | params | query | 消费方与语义 |
|---|---|---|---|
| `conversation` | `convId` | `msgId` | 会话身份；`msgId` 用于深链定位到具体消息，定位失败 toast，不改变 URL |
| `friend` | `friendId` | — | 好友身份；首轮好友表读过仍找不到 ⇒ toast + 回 `/contacts` |
| `favorite` | `favId` | — | 收藏身份；首轮收藏读过仍找不到 ⇒ toast + 回 `/favorites` |
| `settings-section` | `key` | — | 分区身份；未知 key ⇒ toast + 归一 `/me/settings` |
| `search` | — | `q` | 搜索词参与 URL；输入/回车用 `replace` 同步，刷新、分享、前进后退都恢复同一查询 |
| `favorites` | — | — | 搜索词与类型筛选是**临时 UI 状态**，刻意不进 URL（不是声明了不消费的假契约） |
| `chats` | — | — | `?at=` 未定义、未消费；出现也被忽略，不承诺行为 |

`meta` 只有四个字段：`pane`（移动端 list/detail）、`tab`（一级域高亮）、`depth`（转场方向）、
`overlay`（整页覆盖层继承底层 tab/面板）。新增路由必须四者齐全；`src/router/mainRoutes.test.ts`
逐个现算，缺一个就红。

### 3.2 无效参数策略

- **对象不存在**：等 `chat.initialized` / `FavoritePanel.loadedOnce` 后再判，避免启动早期误杀合法深链；
  确认不存在才 toast + `replace` 到父级，URL 不留在错误对象上。
- **加载失败 ≠ 不存在**：收藏读取失败保留重试入口，不重定向。
- **未知路由**：catch-all 回 `/chats`。
- **深链无上一跳**：`goBack` 用 `replace` 落安全目标，不再 `push`（否则安全目标再返回又回到深链）。
- **异步覆盖**：已经停在另一条会话 URL 上时，后台 `activeConv` 变化/启动恢复不得把界面切走。

**平台差异（刻意保留）**：

- 桌面 `/links` 是 rail 一级；移动端从「我的」进入用 `/me/links`（`/links` 仍可作兼容深链）。
- 桌面深链 `/me/settings`、`/me/logs`、`/me/profile` 不渲染移动页面，而是打开对应的独立窗口并回到 `/chats`；
  移动端这些是覆盖层路由。
- **已知限制**：独立设置窗口有自己的 hash router；桌面主窗口的 `/me/settings/:key` 能打开设置窗口，
  但不会把那个窗口的当前分区强推到 `:key`（两套 router 之间没有跨窗口导航通道）。`/me/profile`
  落在设置窗口默认的 profile 分区，因此资料深链是准的；日志深链打开日志窗口。
- 设置分区两端集合不同：移动端 `appearance` 与 `chatStyle` 分开（11 个 key），桌面设置窗口
  把两者合并在 `appearance`（10 个 key）。这是空间差异，不是配置缺失。
- 日志/群任务/预览是单页工具：筛选和任务详情是视图状态/浮层，不占页面路由。

**不进路由**：群任务的 `groupId` + `todoId` 仍走后端 `take_group_todo_focus`；图片预览图册走后端 `preview_gallery`；外链窗口加载远端 URL。

## 4. 状态派生（这是路由化最关键的一层）

路由只承担「层级」，不复制业务状态：

| 旧状态 | 现在 | 说明 |
|---|---|---|
| `navState`（组件内 ref） | `computed` 从 `route.name` 推导 | 一级 tab 高亮不再有第二个写者 |
| `mobileView`（store） | `computed` 从 `route.meta.pane` 推导，并同步回 store | 兼容仍在读 store 的组件；页面级写点已改为路由跳转 |
| `settingsOpen` / `logsOpen` / `profileOpen` / `searchOpen` | `computed` 从路由推导 | 覆盖层不再各有自己的布尔 |
| `showRequests` | `computed` 从 `route.name === "requests"` 推导 | 修 D-D：离开路由即清 |
| `profileFriend` | 路由参数 + 好友表解析 | 深链进入 `/contacts/:friendId` 也能恢复 |

**覆盖层继承底层**：`meta.overlay` 为真时，`navState` / `mobileView` 沿用进入前的值（`lastNav` / `lastPane`）。这样从聊天里打开设置、返回时仍回到聊天，而不是落到会话列表。

**页面级返回层退役**：`ResponsiveLayout` 不再为聊天页 / 我的页 / 资料页注册 `useBackLayer`。
页面层级由路由历史承载；只有真正的浮层（`BaseModal`、`ImageLightbox`、`ForwardModal`，以及没有 router 的探针挂载）
继续用 `useBackLayer`。以下页面组件在路由驱动时**明确不注册**返回层，避免一次返回退两层：

- `ChatSearchDialog` → `BaseModal :back-layer="!routeDriven"`
- `LogViewer` → `props.routeDriven` 为真时不压栈
- `LinksList` → `props.routeDriven` 为真时不压栈
- `FavoritePanel` → 有 router 时详情/列表返回走路由；手工栈只留给无 router 的挂载

返回优先级（从高到低）：**真实覆盖层（弹窗/菜单/灯箱）→ 页面详情 → 父级页面 → 主入口**。
一级 tab 切换用 `replace`，不写返回历史；列表→详情用 `push`，详情内换收藏用 `replace`。

## 5. 返回与层级规范（R1–R7）

- **R1 逐级下钻、逐级返回。** 返回目标 = 进入来源（`router.back()`），不是硬编码页面；没有历史条目时才走 fallback。
- **R2 上层界面一定能返回。** 路由树里除根节点外，每个节点必须有至少一条返回路径：页内返回控件 / `Esc` / `⌘[` / `Ctrl+[` / `Alt+←` / Android 物理返回。
- **R3 桌面端也要有「上一级」。** 好友资料页与收藏页在桌面端也显示显式返回控件（修 D-B、D-C）。
- **R4 模态与下钻区分。** 模态用「完成 / 取消 / 关闭」，不占用路由返回语义；下钻页用「返回」。
- **R5 不跨级跳转；标题由路由 meta 提供。** 移动端 `MobilePageFrame` 的标题不再由每个挂载点手传字面量。
- **R6 返回时恢复到离开时的状态。** 每会话滚动位置、输入草稿、焦点；见 §6。
- **R7 平台差异显式声明。** iOS 边缘侧滑仍未接管（靠页内返回）；Android 物理返回必须能一路退到退出应用。根路由在启动时用 replace 落位，不会多出一条「退到 index.html」的历史。

**键盘返回**：`ResponsiveLayout` 的 `onBackKey` 处理 `Esc` / `⌘[` / `Ctrl+[` / `Alt+←`；有 `role=dialog` / `role=menu` / Reka popper 打开时让浮层先处理，不抢 `Esc`。
没有历史时每条二级路由都有显式安全落点：会话→`/chats`、好友/申请→`/contacts`、收藏详情→`/favorites`、
搜索→`/chats`、「我的」子页/链接/设置/日志→`/me`。

### 5.1 搜索的单一历史

`/search` 是正式页面入口（桌面是卡片弹窗外观，移动端全屏），但**返回只由路由承担**：

- 从会话列表/会话进入时 `push`；同一关键词重复进入直接复用，不再加历史。
- 输入与提交用 `replace` 更新 `?q=`，刷新/分享/前进后退可恢复；筛选条件（发送人/日期）是临时状态，换关键词时重置。
- 结果「进入聊天」用 `router.replace('/chats/:id?msgId=…')`，不再同时 `emit('close')` 触发 `router.back()`（旧实现会与 replace 抢历史）。
- 直接打开 `/search`（无上一跳）关闭时 `replace('/chats')`，不会退出应用或形成往返循环。
- 搜索请求以关键词+筛选为 query key；旧响应不会覆盖新查询。防抖句柄在卸载时取消。

## 6. 状态保持

| 状态 | 实现 | 位置 |
|---|---|---|
| 输入草稿 | 模块级 `Map<convId, html>`，切走保存、切回恢复；发送成功即清 | `src/utils/composerDrafts.ts`、`src/components/chat/MessageComposer.vue` |
| 滚动位置 | `ChatWindow` 按会话保存 `scrollTop`；切回时等新消息到达后恢复，期间关闭 VirtualList 的 swap 贴底 | `src/components/ChatWindow.vue`、`src/components/VirtualList.vue` |
| 焦点 | 切会话后桌面端聚焦编辑器；弹窗关闭继续走 `BaseModal` 的焦点归还 | `MessageComposer.vue`、`BaseModal.vue` |

草稿存 `innerHTML` 但恢复前经过白名单净化（只保留文本、`<br>`/块边界、token span 的 `data-mention-*`），不把外部标记重新解析执行。

## 7. 已修复的导航死胡同

| 编号 | 原问题 | 修复 |
|---|---|---|
| D-A | 移动端收藏列表按系统返回无反应，且 `backStack` 吃掉「退出应用」兜底 | 收藏是 `/favorites` 路由；列表 `pane: list` 是普通一级 tab，详情才进 `pane: detail` 并隐藏底栏 |
| D-B | 桌面好友资料页无返回入口；点 rail「通讯录」不重置资料 | 资料页始终显示返回条；`/contacts` 会清 `profileFriend` |
| D-C | 桌面收藏页无头部 / 关闭按钮 | 收藏页左栏加返回 + 标题 |
| D-D | 移动端「新的朋友」返回只改 `mobileView`，不清 `showRequests` | `requests` 是路由；离开即清 |
| D-E | `navState === 'me'` 在桌面不可达 | 桌面深链 `/me` 回 `/chats`；`/me/profile`、`/me/settings`、`/me/logs` 打开对应独立窗口 |
| D-F | 没有返回快捷键 | `Esc` / `⌘[` / `Ctrl+[` / `Alt+←` |

## 8. 验证记录

### 8.1 路由契约单测（Node，2026-10-22）

`src/router/mainRoutes.test.ts`（memory history，不需要浏览器）：

| 项 | 结果 |
|---|---|
| 15 条正式路径 → 唯一 name | 通过 |
| `convId` / `friendId` / `favId` / `key` 原样保留 | 通过 |
| `/profile`、`/settings(/:key)`、`/logs` 旧深链重定向 | 通过 |
| 未知路径 → `chats` | 通过 |
| meta 四件套齐全、子页 depth 递增、同名 tab | 通过 |
| 覆盖层 `overlay` 继承底层 | 通过 |

`npm test` 全量：**1178 pass / 0 fail**（2026-10-22，本机）。
`npm run verify` 快速层：**17/17 步通过**（含 vue-tsc 与 vite build）。

### 8.2 UI 运行时探针（Brave，CDP）

`GOSSLAN_CHROME="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" node scripts/check-ui-runtime.mjs --only=favorites,settingsmobile,overlay`

结果：**55/55 条判据绿**。覆盖收藏列表/详情/筛选、移动端收藏全屏详情与返回、移动端设置一级/二级与返回、BaseModal 三种关闭路径与单次 back 只关一层。

### 8.3 浏览器与真机边界

**未验证**：真实 Tauri WebView（`tauri://` 与 `http://tauri.localhost`）下的 `pushState` / `popstate` 行为、
Android 物理返回、iOS 边缘滑动、桌面设置窗口的创建/复用/关闭（需真实 Tauri IPC）。
纯 Browser 环境没有 Tauri IPC，本次只验证路由、返回栈、页面布局与组件行为；
真机项必须按 `docs/design-guidelines.md` §11.5 的口径登记为 NOT RUN。

### 8.4 桌面 `/links` 布局

左列是链接列表（真实数据与增删改），右栏是解释性空态（「在左侧选择一个链接，将在独立窗口中打开」）。
链接没有本地详情页，主区不强行填内容；这是 list-only 的合理分工，不是列表/详情比例失衡。

### 8.5 历史记录（2026-10-22 早期浏览器实测）

| 项 | 结果 |
|---|---|
| 启动重定向 | `/` → `/chats`，无多余历史条目 |
| 一级导航 | 点 rail 通讯录 / 收藏，URL 分别变为 `/contacts`、`/favorites` |
| 路由返回 | `/favorites` → `history.back()` → `/contacts` |
| 移动端我的 | `/me` 主面板可见，底栏「我的」高亮 |
| 覆盖层 | `/me` → 设置 → `/me/settings` → 分区 `/me/settings/appearance`；两次返回 → `/me`，底栏可点 |
| 两套历史共存 | 打开添加好友弹窗 → `history.back()` → 弹窗关闭、URL 仍为 `/contacts` |
| 设置窗口 | `settings.html#/settings/profile` 深链；点「外观」→ `#/settings/appearance`；左侧「返回」与 `Alt+←` 回到 `#/settings/profile` |

> 2026-10-22 用户裁决：统一走 web history（含 `tauri:` / `asset:`）；只有 `pushState` 真抛错才退 hash。
> 真机仍需复核：自定义协议下刷新不会 404、物理返回能一路退到退出应用。

## 8.1 桌面 / 移动分开实现

桌面三栏（`NavRail` + 列表 + 主区）与移动抽屉/底栏是**显式的两条渲染分支**：
`NavRail` 只在桌面出现；移动底栏是根节点内的 `absolute` 层（不走 `fixed`，避免 WebView 键盘/视觉视口
造成的错位），列表↔详情用对称 `translate`，Tab 切换用 `paneAnimate` 关掉平移。
路由/状态是共享的，但交互层不共用桌面专属控件。

## 9. 回归命令

```bash
npm test
npm run build
node scripts/verify.mjs --list
npm run verify
```

本地开发不跑 `verify:full`（用户 2026-10-22 的约束）；发版 / CI 再跑全量。
