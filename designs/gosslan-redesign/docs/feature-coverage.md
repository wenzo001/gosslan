# 功能覆盖矩阵

> v2「Pulse」在此基础上重新设计了核心 5 屏，并补齐图片预览窗、启动错误窗、整页发现、个性化、好友申请冷却态。闭环与缺口审计见 [product-gaps.md](product-gaps.md)，v2 范围见 [redesign-v2-brief.md](redesign-v2-brief.md)。

目标：证明设计覆盖了**现有完整功能**，而不是只挑了首页与聊天页。

- **画板** = 该功能有专门的高保真图或组件预览。
- **复用** = 使用同一组件模式，不单独出图，但交互与状态已在规范中定义。
- **不设计** = 开发者内部界面或刻意不带 app chrome 的窗口；只继承 token，不重绘。
- 功能来源：`src/` 全量组件、`src/i18n/locales/*`、`src/utils/settingsManifest.ts`、`src-tauri/tauri.conf.json`。

---

## 1. 主界面、导航与窗口

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 1000×680 主窗口、无边框标题栏 | `tauri.conf.json`；`TitleBar.vue` | `Layout`、`DesktopChats` | 画板 |
| 64px rail、5 个入口、头像、主题/更多 | `NavRail.vue:114-247` | `DesktopChats` | 画板 |
| 列表 200–420 可拖拽 | `ResponsiveLayout.vue:786-821` | `Layout`（280–400） | 规范 |
| 三栏 / 单栏断点、移动判定 | `platform.ts:84-101` | `Layout` | 画板 |
| 移动 4 项底栏、隐藏规则 | `ResponsiveLayout.vue:1122-1209` | `MobileChats`、`MobileMe` | 画板 |
| 标题栏连接状态 | `TitleBar.vue` | `DesktopChats` 右上 | 画板 |
| 设置窗口 780×600 | `SettingsWindow.vue` | `DesktopSettings` | 画板 |
| 群任务窗口 780×620 | `GroupTodosWindow.vue` | `DesktopGroupTasks` | 画板 |
| 日志窗口 760×560 | `LogViewer.vue` | `DesktopLogs` | 画板 |
| 图片预览窗 1120×820 | `PreviewWindow.vue` | `DesktopModals` | 画板 |
| 外部链接窗（无 app chrome） | capabilities | `DesktopLinks` 说明 | 不设计（刻意） |
| 启动错误窗 560×400 | `startup_error.rs` | `MobileStates` 错误态 + 规范 | 复用 |
| 启动骨架 | `index.html` | `MobileStates` 加载态 | 复用 |
| 崩溃/卡顿/恢复/版本不匹配横幅 | `CrashNotice.vue` 等 | `MobileStates`、`audit` | 复用 |

---

## 2. 聊天 — 消息类型

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 文本、@提及、链接、表情 token | `MessageTextBubble.vue` | `DesktopOneToOne`、`DesktopGroupChat`、`MobileOneToOne` | 画板 |
| 引用 | `MessageTextBubble.vue` | `DesktopOneToOne`；设计系统 `Message` | 画板 |
| 代码块（语法高亮、语言切换） | `MessageCodeBubble.vue`、`CodeLangMenu.vue` | `DesktopOneToOne` 输入栏代码模式 + `Message` 规范 | 复用 |
| 图片（含灯箱、保存、缩放） | `MessageImageBubble.vue`、`ImageLightbox.vue` | `DesktopOneToOne` 图片气泡；`DesktopModals` 灯箱 | 画板 |
| 文件（大小、进度、取消、重新获取） | `MessageFileBubble.vue` | `DesktopOneToOne` 文件卡；`DesktopTasks` 传输态 | 画板 |
| 合并转发卡 + 详情 | `MergeCard.vue`、`MergeCardModal.vue` | `DesktopModals`；`Message` 规范 | 画板 |
| 群任务卡 | `TodoCardBubble.vue` | `DesktopGroupChat`、`MobileGroupChat` | 画板 |
| 系统/撤回提示 | `messageKinds.ts` | `Message` 规范 | 复用 |
| 不支持类型（原始内容） | `UnsupportedKindBubble.vue` | `MobileStates` 错误/降级说明 | 复用 |
| 消息多选、批量操作 | `MessageItem.vue` | `PrototypeDesktop`（选择态） | 原型 |
| 长文本 5 行折叠/展开 | `MessageTextBubble.vue:213-233` | `Message` 规范 | 复用 |
| 文本↔代码渲染切换 | `MessageCodeBubble.vue` | `DesktopModals` 说明 | 复用 |

## 3. 聊天 — 操作与状态

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 发送中/已发送/已读/失败/取消/部分送达 | `MessageReceipt.vue`、`MessageItem.vue` | `DesktopOneToOne`、`DesktopGroupChat`、`MobileStates` | 画板 |
| 逐人已读、已读头像 | `MessageReceipt.vue` | `DesktopGroupChat` | 画板 |
| 表情回应聚合、悬停名单 | `MessageReactionBar.vue` | `DesktopOneToOne`、`PrototypeMobile` | 画板+原型 |
| 置顶（群） | `ChatWindow.vue` | `DesktopGroupChat` 置顶条 | 画板 |
| 撤回（作者 5 分钟 / 群主随时） | `MessageItem.vue:923-942` | `DesktopModals` 确认框 | 画板 |
| 强提醒 + 受众选择 + 收到确认 | `RemindAudienceDialog.vue` | `DesktopModals` | 画板 |
| 窗口抖动（单聊） | `MessageComposer.vue` | `DesktopModals` 说明 | 复用 |
| 转发（单条/多条/合并） | `ForwardModal.vue` | `DesktopModals` | 画板 |
| 收藏消息 | `MessageContextMenu.vue` | `DesktopModals` 菜单 | 画板 |
| 复制、回复、删除 | `MessageContextMenu.vue` | 设计系统 `Overlay` | 画板 |
| 拖拽发送 + 确认 | `DropSendConfirm.vue` | `DesktopOneToOne` 说明；`MobileStates` | 复用 |
| 粘贴图片暂存 | `MessageComposer.vue` | `DesktopOneToOne` 输入栏 | 复用 |
| 草稿持久化 | `MessageComposer.vue` | `DesktopOneToOne` | 复用 |
| 表情选择器（常用行） | `EmojiPicker.vue` | `DesktopModals` | 画板 |
| 代码模式 | `MessageComposer.vue` | `DesktopOneToOne` 工具栏 | 画板 |
| 提醒/群公告/撤回菜单 | `ChatHeader.vue`、`MessageContextMenu.vue` | `DesktopModals` | 画板 |
| 回到底部、未读分隔、时间分隔 | `BackToLatestButton.vue`、`ChatWindow.vue` | `DesktopOneToOne` | 画板 |
| 分页加载/失败重试 | `ChatWindow.vue` | `MobileStates` 加载/错误 | 复用 |
| 群历史补齐进度/失败/取消 | `ChatWindow.vue` | `DesktopGroupInfo`、`DesktopTasks` | 画板 |
| 密钥轮换提示 | `ChatWindow.vue` | `DesktopGroupInfo` / `MobileStates` 说明 | 复用 |
| 公告查看 | `ChatWindow.vue` | `DesktopGroupInfo` | 画板 |

---

## 4. 通讯录 / 好友 / 发现

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 好友列表、字母分组、搜索 | `ConversationList.vue` contacts 模式 | `DesktopContacts`、`MobileContacts` | 画板 |
| 在线/离线点、链路类型、跳数 | `LinkIcon.vue`、`FriendListItem.vue` | `DesktopContacts`、`MobileContacts` | 画板 |
| 新的朋友入口 + 未读数 | `ConversationList.vue` | `DesktopContacts`、`DesktopChats` | 画板 |
| 好友资料：设备、版本、IP:port、安全码、E2EE、删除 | `FriendProfile.vue` | `DesktopContacts` 右栏、`MobileFriend` | 画板 |
| 发起聊天 | `FriendProfile.vue` | `DesktopContacts`、`MobileFriend` | 画板 |
| 好友申请：收到/发出/等待/撤回/冷却 | `FriendRequestList.vue` | `DesktopRequests`、`MobileRequests` | 画板 |
| 添加好友：局域网发现、蓝牙、通道切换、扫码邀请、状态 | `AddFriendModal.vue` | `DesktopRequests`、`DesktopModals` | 画板 |
| 跨网状态（routed/relay） | `AddFriendModal.vue` | `DesktopContacts` 说明 | 复用 |
| 蓝牙不可用/无适配器/慢速警示 | `AddFriendModal.vue`、`ChatWindow.vue` | `MobileStates` 说明 | 复用 |
| 复制邀请、重扫 | `AddFriendModal.vue` | `DesktopRequests` | 画板 |

---

## 5. 群组

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 创建群（名称 + 好友选择） | `GroupCreateModal.vue` | `DesktopModals` | 画板 |
| 群头像 2×2、成员数、在线数 | `ChatHeader.vue` | `DesktopGroupChat` | 画板 |
| 群资料/成员列表/角色 | `GroupMemberPanel.vue` | `DesktopGroupInfo` | 画板 |
| 改名、公告发布/编辑/删除 | `GroupMemberPanel.vue` | `DesktopGroupInfo` | 画板 |
| 添加/移除成员、转让群主、退群 | `GroupMemberPanel.vue` | `DesktopGroupInfo` | 画板 |
| 群文件（类型/大小/发送者/时间/逐人送达/重取/取消） | `GroupFilesPanel.vue` | `DesktopGroupInfo` | 画板 |
| 群任务入口 | `GroupTasksPanel.vue` | `DesktopGroupChat`、`DesktopGroupInfo` | 画板 |
| 群任务看板（全部/我的/我创建/归档） | `GroupTasksBoard.vue` | `DesktopGroupTasks` | 画板 |
| 任务状态（待办/进行中/延期/做不了/完成） | `GroupTasksBoard.vue` | `DesktopGroupTasks` | 画板 |
| 任务字段：标题/优先级/类型/负责人/日期/标签/描述/图片 | `Todo*Field.vue` | `DesktopGroupTasks` | 画板 |
| 任务详情、历史、认领、归档/恢复/删除 | `TodoDetailDialog.vue` | `DesktopGroupTasks` | 画板 |
| 自动归档倒计时 | `GroupTasksBoard.vue` | `DesktopGroupTasks` | 画板 |
| 群公告 | `ChatWindow.vue` | `DesktopGroupInfo` | 画板 |
| 群历史补齐 | `ChatWindow.vue` | `DesktopGroupInfo`、`DesktopTasks` | 画板 |

---

## 6. 收藏 / 链接 / 共享 / 任务中心

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 收藏列表、搜索、类型筛选（全部/文本/图片/文件/卡片） | `FavoritePanel.vue` | `DesktopFavorites`、`MobileFavorites` | 画板 |
| 收藏详情：复制/转发/查看/另存/定位/删除 | `FavoritePanel.vue` | `DesktopFavorites` | 画板 |
| 收藏容量 1000、本地存储 | `FavoritePanel.vue` | `DesktopFavorites` 说明 | 复用 |
| 链接列表、添加/编辑/删除 | `LinksList.vue` | `DesktopLinks` | 画板 |
| 链接导入（JSON/URL）预览、导出、刷新源 | `LinksList.vue` | `DesktopLinks` | 画板 |
| 外部链接打开（桌面独立窗 / 移动浏览器） | `open_link_window` | `DesktopLinks` 说明 | 不设计（刻意） |
| 共享目录浏览/下载/截断提示 | `ShareDirectory.vue` | `DesktopLinks` | 画板 |
| 任务中心：传输/获取/待发送/群历史同步 | `TaskCenter.vue` | `DesktopTasks` | 画板 |
| 取消/重试/重发/同步/打开会话 | `TaskCenter.vue` | `DesktopTasks` | 画板 |

---

## 7. 搜索

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 全局消息搜索 | `ChatSearchDialog.vue` | `DesktopSearch`、`MobileSearch` | 画板 |
| 搜索中/空/错误/剩余命中 | `ChatSearchDialog.vue` | `DesktopSearch` | 画板 |
| 发送者/日期筛选 | `ChatSearchDialog.vue` | `DesktopSearch` | 画板 |
| 结果跳转到会话 | `ChatSearchDialog.vue` | `DesktopSearch`、`PrototypeDesktop` | 画板+原型 |
| 列表搜索回车进入全局搜索 | `ConversationList.vue:265-273` | `DesktopChats` | 画板 |

---

## 8. 设置 / 资料 / 通知 / 日志

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 个人资料：昵称自动保存、头像上传/预设 | `ProfileSection.vue` | `DesktopSettings`、`MobileMe` | 画板 |
| 语言与地区 | `GeneralSection.vue` | `DesktopSettings` | 画板 |
| 外观：跟随系统/浅/深、主题色、字体 | `AppearanceSection.vue` | `DesktopSettings`、`MobileSettingsSection` | 画板 |
| 聊天样式：字号 5 档、气泡配色 6 套、环境动效、减少透明度 | `ChatStyleSection.vue` | `DesktopSettings`、`MobileSettingsSection` | 画板 |
| 通知：开关、内容隐私、测试 | `NotificationSection.vue` | `DesktopSettings`、`MobileSettings` | 画板 |
| 网络：局域网/蓝牙开关、重连、routed、relay 策略/白名单/自建服务器 | `NetworkSection.vue` | `DesktopSettings`、`MobileSettings` | 画板 |
| 存储：保留/配额/目录/导出/清理/统计 | `StorageSection.vue` | `DesktopSettings`、`MobileSettings` | 画板 |
| 文件：接收目录、共享目录 | `FilesSection.vue` | `DesktopSettings` | 画板 |
| 关于：安全声明、设备指纹、更新 | `AboutSection.vue`、`UpdatePanel.vue` | `DesktopSettings`、`MobileSettings` | 画板 |
| 重置：恢复默认、清空数据（保留好友） | `ResetSection.vue` | `DesktopSettings`、`MobileSettings` | 画板 |
| 日志：级别、时间窗、合并重复、过滤、复制、导出、清理 | `LogViewer.vue` | `DesktopLogs` | 画板 |
| 隐藏诊断面板（7 击指纹） | `DevDiagPanel.vue` | 文档说明 | 不设计（内部） |
| 通知去抖/当前会话抑制/隐私/Dock 徽标 | `stores/chat/notifications.ts` | `DesktopSettings` 通知分区 | 规范 |
| 移动「我的」：头像、昵称、设备、设置/链接/日志 | `ResponsiveLayout.vue:970-1014` | `MobileMe` | 画板 |
| 移动资料页 | `ProfileSection.vue` + `MobilePageFrame` | `MobileMe` | 画板 |

---

## 9. 异常 / 权限 / 边界

| 功能 | 证据 | 设计位置 | 覆盖 |
| --- | --- | --- | --- |
| 启动骨架、启动错误 | `index.html`、`startup_error.rs` | `MobileStates` | 复用 |
| 列表加载/空/失败 ≠ 空/重试 | 多组件 | `MobileStates` | 画板 |
| 聊天加载/分页/失败 | `ChatWindow.vue` | `MobileStates` | 复用 |
| 离线/重连 | 全局 | `MobileStates`、`DesktopOneToOne` 头部 | 画板 |
| 发送失败/重试/取消 | `MessageItem.vue` | `DesktopOneToOne`、`MobileStates` | 画板 |
| 传输 queued/进度/停滞/失败/取消/缺失 | `MessageFileBubble.vue`、`TaskCenter.vue` | `DesktopTasks`、`MobileStates` | 画板 |
| 蓝牙慢速警示 | `ChatWindow.vue` | `MobileStates` | 复用 |
| 版本不匹配、新版本对端 | `VersionMismatchNotice.vue` | `DesktopSettings` 关于、`MobileStates` | 复用 |
| 通知权限被拒 | `NotificationSection.vue` | `DesktopSettings` | 复用 |
| Android 未知来源安装 | `AndroidUpdatePanel.vue` | `MobileSettings` | 复用 |
| 破坏性确认（删会话/好友/撤回/清数据/退群/移成员/转让/删公告/删任务） | 各组件 | `Overlay` 组件、`DesktopGroupInfo`、`DesktopGroupTasks` | 画板+规范 |
| 角色权限（群主/成员/创建者/负责人） | `types.ts:258-263` | `DesktopGroupInfo`、`DesktopGroupTasks` | 画板 |
| 输入法/键盘/Esc 层级/⌘Enter | 多组件 | `Layout` 规范 | 规范 |

---

## 10. 明确不设计的内容

| 内容 | 原因 |
| --- | --- |
| `DevDiagPanel` 内部诊断面板 | 开发者工具，不面向用户；建议保留功能，仅跟随 token 调整颜色 |
| 外部链接窗口的 app chrome | 现有安全模型刻意不给 capabilities，加 chrome 会破坏隔离 |
| 启动错误窗的独立品牌页 | 复用 `State` 的错误解剖即可，不需要单独视觉 |
| 窗口最小化/最大化/还原的手绘字形 | 平台窗口控制，不进入图标系统；设计稿中以中性圆点占位 |
| 任何不存在的功能 | 见 `decisions.md` 决策 11 |

---

## 11. 画板 → 功能反向索引

| 画板 | 主要覆盖 |
| --- | --- |
| `Foundations` | 颜色、字体、间距、圆角、阴影、图标刻度 |
| `Layout` | 三栏、断点、窗口尺寸、移动规则 |
| `DesktopChats` | 主界面、rail、列表、空态、任务中心入口 |
| `DesktopOneToOne` | 文本/引用/图片/文件/回执/未读/回到底部/输入栏 |
| `DesktopGroupChat` | 群身份、置顶、@、群任务卡、逐人已读、群头 |
| `DesktopContacts` | 好友列表、在线/链路、资料、发起聊天 |
| `DesktopRequests` | 好友申请、添加好友 |
| `DesktopGroupInfo` | 成员、公告、文件、任务入口、退群/转让 |
| `DesktopFavorites` | 收藏列表/详情/筛选/空态 |
| `DesktopLinks` | 链接、导入导出、独立窗口打开 |
| `DesktopShare` | 共享目录、截断、下载 |
| `DesktopTasks` | 传输/获取/待发送/群历史同步 |
| `DesktopSearch` | 全局搜索、筛选、结果 |
| `DesktopSettings` | 9 个设置分区 |
| `DesktopGroupTasks` | 看板、任务详情、角色 |
| `DesktopLogs` | 日志 |
| `DesktopModals` | 添加好友、建群、转发、撤回、提醒、灯箱、表情 |
| `DesktopDark` | 深色层级验证 |
| `MobileChats` | 移动列表、底栏、未读 |
| `MobileOneToOne` | 移动单聊 |
| `MobileGroupChat` | 移动群聊 |
| `MobileContacts` | 移动通讯录 |
| `MobileFriend` | 好友资料/安全码 |
| `MobileRequests` | 好友申请 |
| `MobileFavorites` | 收藏 |
| `MobileMe` | 我的/资料 |
| `MobileSettings` | 设置首页 |
| `MobileSettingsSection` | 外观/聊天样式 |
| `MobileSearch` | 搜索 |
| `MobileDark` | 深色移动 |
| `MobileStates` | 离线/失败/重试/传输暂停与失败 |
| `MobileEmpty` | 首次运行空态、局域网发现 |
| `State` 组件 | 空/错误/加载三态的完整解剖 |
| `DesktopEdgeCases` | 长名称/预览、99+、长 URL、长文件、IPv6/安全码、搜索/设置、Toast/对话框 |
| `MobileEdgeCases` | 长标题、长会话名、78% 气泡、长 URL、文件卡、长草稿、Toast |
| `BrandMascot` | 小院标记/吉祥物、尺寸、状态、App 图标、字标 |
| `IconSet` | Rounded 2.0 图标表与尺寸 |
| `PrototypeDesktop` | 列表→会话→菜单→toast→搜索→添加好友→个性化 |
| `PrototypeMobile` | 底栏→顶栏「+」→会话→发送→回应→返回 |
