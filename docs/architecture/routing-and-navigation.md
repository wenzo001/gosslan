# 路由与导航层级规范

> 状态：已落地（2026-10-22）  
> 范围：主窗口、设置独立窗口、移动端底部导航；浮层（弹窗 / 菜单 / 灯箱）继续走手工返回栈  
> 关联：`docs/design-guidelines.md` §12、`docs/architecture/frontend-performance-antipatterns.md`

本文件是导航层级、返回语义与路由落点的唯一规范。路由条数以源码现算，不在文档里留第二份手抄：

```bash
grep -c '^    name:' src/router/main.ts
grep -c '^  "' src/router/settings.ts
```

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
| 日志 / 群任务 / 预览 | 单页入口 | 不需要 | — |

跨窗口跳转继续走 `launchAuxWindow` 的 IPC；router 不跨窗口。

## 3. 主窗口路由表

| 路由名 | 路径 | 参数 / query | 目标 | 平台 | meta |
|---|---|---|---|---|---|
| `chats` | `/chats` | — | 会话列表 + 空态 | 双端 | `pane: list` |
| `conversation` | `/chats/:convId` | `msgId`（深链定位） | `ChatWindow` | 双端 | `pane: detail` |
| `contacts` | `/contacts` | — | 通讯录列表 | 双端 | `pane: list` |
| `requests` | `/contacts/requests` | — | `FriendRequestList` | 双端 | `pane: detail` |
| `friend` | `/contacts/:friendId` | — | `FriendProfile` | 双端 | `pane: detail` |
| `favorites` | `/favorites` | — | `FavoritePanel` 列表态 | 双端 | `pane: detail` |
| `favorite` | `/favorites/:favId` | — | 收藏详情（预留给深链） | 双端 | `pane: detail` |
| `links` | `/links` | — | `LinksList` | 双端 | `pane: detail` |
| `me` | `/me` | — | 「我的」页 | 仅移动 | `pane: detail` |
| `profile` | `/profile` | — | `ProfileSection` + `MobilePageFrame` | 仅移动 | `overlay` |
| `settings` | `/settings` | — | 设置一级 | 仅移动 | `overlay` |
| `settings-section` | `/settings/:key` | `key` | 对应分区 | 仅移动 | `overlay`, `depth: 2` |
| `logs` | `/logs` | — | `LogViewer`（非 standalone） | 仅移动 | `overlay` |
| `search` | `/search` | `q` | `ChatSearchDialog` | 双端 | `overlay` |

设置窗口的路由是 `#/settings/:key`，分区清单在 `src/router/settings.ts` 的 `SETTINGS_SECTIONS`。

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

**页面级返回层退役**：`ResponsiveLayout` 不再为聊天页 / 我的页 / 资料页注册 `useBackLayer`。页面层级由路由历史承载；只有浮层（`BaseModal`、`ImageLightbox`、`SettingsPanel` 的二级页等）继续用 `useBackLayer`。两套都听 `popstate` 的顺序已在 Chromium 实测：打开弹窗 → `history.back()` → 弹窗关闭且路由不变。

## 5. 返回与层级规范（R1–R7）

- **R1 逐级下钻、逐级返回。** 返回目标 = 进入来源（`router.back()`），不是硬编码页面；没有历史条目时才走 fallback。
- **R2 上层界面一定能返回。** 路由树里除根节点外，每个节点必须有至少一条返回路径：页内返回控件 / `Esc` / `⌘[` / `Ctrl+[` / `Alt+←` / Android 物理返回。
- **R3 桌面端也要有「上一级」。** 好友资料页与收藏页在桌面端也显示显式返回控件（修 D-B、D-C）。
- **R4 模态与下钻区分。** 模态用「完成 / 取消 / 关闭」，不占用路由返回语义；下钻页用「返回」。
- **R5 不跨级跳转；标题由路由 meta 提供。** 移动端 `MobilePageFrame` 的标题不再由每个挂载点手传字面量。
- **R6 返回时恢复到离开时的状态。** 每会话滚动位置、输入草稿、焦点；见 §6。
- **R7 平台差异显式声明。** iOS 边缘侧滑仍未接管（靠页内返回）；Android 物理返回必须能一路退到退出应用。根路由在启动时用 replace 落位，不会多出一条「退到 index.html」的历史。

**键盘返回**：`ResponsiveLayout` 的 `onBackKey` 处理 `Esc` / `⌘[` / `Ctrl+[` / `Alt+←`；有 `role=dialog` / `role=menu` / Reka popper 打开时让浮层先处理，不抢 `Esc`。

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
| D-A | 移动端收藏列表按系统返回无反应，且 `backStack` 吃掉「退出应用」兜底 | 收藏是 `/favorites` 路由；返回由路由处理 |
| D-B | 桌面好友资料页无返回入口；点 rail「通讯录」不重置资料 | 资料页始终显示返回条；`/contacts` 会清 `profileFriend` |
| D-C | 桌面收藏页无头部 / 关闭按钮 | 收藏页左栏加返回 + 标题 |
| D-D | 移动端「新的朋友」返回只改 `mobileView`，不清 `showRequests` | `requests` 是路由；离开即清 |
| D-E | `navState === 'me'` 在桌面不可达 | 桌面深链 `/me`、`/profile`、`/logs` 重定向到 `/chats` |
| D-F | 没有返回快捷键 | `Esc` / `⌘[` / `Ctrl+[` / `Alt+←` |

## 8. 验证记录

浏览器（Chromium / Playwright，2026-10-22）实测：

| 项 | 结果 |
|---|---|
| 启动重定向 | `/` → `/chats`，无多余历史条目 |
| 一级导航 | 点 rail 通讯录 / 收藏，URL 分别变为 `/contacts`、`/favorites` |
| 路由返回 | `/favorites` → `history.back()` → `/contacts` |
| 移动端我的 | `/me` 主面板可见，底栏「我的」高亮 |
| 覆盖层 | `/me` → 设置 → `/settings`；返回 → `/me` |
| 两套历史共存 | 打开添加好友弹窗 → `history.back()` → 弹窗关闭、URL 仍为 `/contacts` |
| 设置窗口 | `settings.html#/settings/profile` 深链；点「外观」→ `#/settings/appearance`；返回 → `#/settings/profile` |

**未验证**：真实 Tauri WebView（`tauri://` 与 `http://tauri.localhost`）下的 `pushState` / `popstate` 行为、Android 物理返回、iOS 边缘滑动。纯浏览器环境没有 Tauri IPC，本次只验证路由与返回栈本身；真机项必须按 `docs/design-guidelines.md` §11.5 的口径登记为 NOT RUN。

> 2026-10-22 用户裁决：统一走 web history（含 `tauri:` / `asset:`）；只有 `pushState` 真抛错才退 hash。
> 真机仍需复核：自定义协议下刷新不会 404、物理返回能一路退到退出应用。

## 9. 回归命令

```bash
npm test
npm run build
node scripts/verify.mjs --list
npm run verify
```

本地开发不跑 `verify:full`（用户 2026-10-22 的约束）；发版 / CI 再跑全量。
