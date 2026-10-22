# 前端全量盘点与替换清单（5.0 专项）

> 这份清单回答四个问题：**每个前端文件属于哪一类**、**每项通用能力交给了谁**、
> **哪些仍是自己写的、为什么**、**下一批做什么**。
>
> 维护口径：第 1 节由 `node scripts/frontend-inventory.mjs` **现算生成**（`--check` 会核对，
> 手改那一段数字没有意义）；第 2–5 节是人工结论，每条都必须挂真实文件路径。
> 结论档位只有六种：**直接替换 / 组合替换 / 局部复用 / 保留自研 / 暂缓替换 / 删除**。

## 0. 口径

- **生产码**：`git ls-files src` 里 `.ts/.vue/.js`，**不含** `src/assets/`（表情图 213 张）与 `src/**/*.test.ts`。
- **测试码分列**：`src/utils/*.test.ts` 等 95 份是判据，删掉它们不算业务简化（本专项第二节明确要求区分）。
- **判据类生产文件**：`src/utils/designGuards.ts`、`src/utils/a11yLabels.ts`、`src/utils/templateBranches.ts`
  只被测试与门禁读，**不进打包产物**（无人从应用码 import），但它们住在 `src/` 里 ⇒
  报"生产 LOC"时必须单列，否则"清理了多少"会被这些尺子撑大。
- **复跑**：`node scripts/frontend-inventory.mjs --check`、`npm test`、`npm run verify`。
- 本清单**不重复**已完成批次的取证细节，那些在 `refactor-5.0-report.md` §6.1–§6.30 与
  `open-source-replacement-matrix.md` 第 1–4 节。

## 1. 全量文件分类索引（机器现算）

<!-- BEGIN:generated (node scripts/frontend-inventory.mjs) -->

> 复跑：`node scripts/frontend-inventory.mjs`（本段与 `--check` 对账，手改本段数字没有意义）。
> 现读：`src/` 共 318 份源码 = 生产 217 份 / 44,390 行 + 测试 101 份 / 21,252 行（不含 `src/assets/` 里的 214 个表情图）。

### 1.1 按职责分类（生产码，机器现算）

| 类 | 文件 | 行 |
|---|---:|---:|
| D-业务组件 | 68 | 19,745 |
| B-utils | 77 | 10,124 |
| C-状态层 | 3 | 4,177 |
| B-国际化 | 5 | 2,459 |
| D-数据表 | 3 | 1,860 |
| A-公共UI | 22 | 1,769 |
| A-布局 | 2 | 1,169 |
| B-composables | 15 | 1,009 |
| E-IPC/事件 | 1 | 770 |
| E-平台适配 | 11 | 640 |
| E-入口/启动 | 7 | 450 |
| 其他 | 3 | 218 |
| **合计** | **217** | **44,390** |

### 1.2 已装库在生产码里的实际使用面（装了不等于用了）

| 依赖 | 生产文件 | 行 |
|---|---:|---:|
| `vue` | 93 | 27,554 |
| `lucide-vue-next` | 48 | 17,117 |
| `reka-ui` | 24 | 8,778 |
| `@vueuse/core` | 18 | 10,750 |
| `@tanstack/vue-query` | 9 | 1,961 |
| `vue-router` | 9 | 5,385 |
| `@tauri-apps/api` | 7 | 4,935 |
| `@tauri-apps/plugin-dialog` | 5 | 3,844 |
| `pinia` | 4 | 4,382 |
| `@tauri-apps/plugin-opener` | 3 | 462 |
| `@tauri-apps/plugin-notification` | 2 | 4,047 |
| `dayjs` | 2 | 202 |
| `zod` | 2 | 198 |
| `highlight.js` | 1 | 127 |
| `@tanstack/vue-virtual` | 1 | 674 |
| `vue-i18n` | 1 | 176 |
| `mitt` | 1 | 51 |
| `motion-v` | 1 | 20 |
| `@pinia/colada` | **0** | 0 ← 装了但生产码没用到，要么接上要么卸掉 |

### 1.3 全量生产文件索引

| 文件 | 类 | 行 | 直接用到的库 |
|---|---|---:|---|
| `src/api/index.ts` | E-IPC/事件 | 770 | `@tauri-apps/api` |
| `src/App.vue` | A-布局 | 132 | `@vueuse/core` `vue` |
| `src/boot/boot.ts` | E-入口/启动 | 205 | `@tanstack/vue-query` `pinia` `vue` |
| `src/boot/theme-boot.js` | E-入口/启动 | 111 | — |
| `src/components/ActionSheet.vue` | A-公共UI | 67 | `reka-ui` |
| `src/components/AddFriendModal.vue` | D-业务组件 | 434 | `@vueuse/core` `lucide-vue-next` `vue` |
| `src/components/BaseModal.vue` | A-公共UI | 231 | `reka-ui` `vue` |
| `src/components/chat/ChatHeader.vue` | D-业务组件 | 208 | `lucide-vue-next` `vue` |
| `src/components/chat/MessageComposer.vue` | D-业务组件 | 900 | `@vueuse/core` `lucide-vue-next` `reka-ui` `vue` |
| `src/components/ChatWindow.vue` | D-业务组件 | 1787 | `@tauri-apps/api` `@tauri-apps/plugin-dialog` `@vueuse/core` `lucide-vue-next` `vue` `vue-router` |
| `src/components/CodeBlock.vue` | D-业务组件 | 127 | `highlight.js` `vue` |
| `src/components/ContextMenu.vue` | A-公共UI | 92 | `reka-ui` `vue` |
| `src/components/conversation/ConversationContextMenu.vue` | D-业务组件 | 43 | `lucide-vue-next` `reka-ui` |
| `src/components/conversation/ConversationListItem.vue` | D-业务组件 | 270 | `lucide-vue-next` `vue` |
| `src/components/conversation/FriendContextMenu.vue` | D-业务组件 | 41 | `lucide-vue-next` `reka-ui` |
| `src/components/conversation/FriendListItem.vue` | D-业务组件 | 152 | `vue` |
| `src/components/conversation/FriendRequestList.vue` | D-业务组件 | 78 | — |
| `src/components/ConversationList.vue` | D-业务组件 | 603 | `@vueuse/core` `lucide-vue-next` `reka-ui` `vue` `vue-router` |
| `src/components/DevDiagPanel.vue` | D-业务组件 | 395 | `@tanstack/vue-query` `lucide-vue-next` `vue` |
| `src/components/EmojiPicker.vue` | D-业务组件 | 179 | `vue` |
| `src/components/FavoritePanel.vue` | D-业务组件 | 980 | `lucide-vue-next` `reka-ui` `vue` `vue-router` |
| `src/components/FriendProfile.vue` | D-业务组件 | 306 | `lucide-vue-next` `vue` `vue-router` |
| `src/components/GroupCreateModal.vue` | D-业务组件 | 122 | `vue` |
| `src/components/GroupFilesPanel.vue` | D-业务组件 | 297 | `@tanstack/vue-query` `lucide-vue-next` `vue` |
| `src/components/GroupMemberPanel.vue` | D-业务组件 | 510 | `lucide-vue-next` `vue` |
| `src/components/GroupTasksBoard.vue` | D-业务组件 | 1604 | `@tauri-apps/api` `@tauri-apps/plugin-dialog` `@vueuse/core` `lucide-vue-next` `reka-ui` `vue` |
| `src/components/GroupTasksPanel.vue` | D-业务组件 | 63 | `vue` |
| `src/components/GroupTodosWindow.vue` | D-业务组件 | 176 | `@tauri-apps/api` `vue` |
| `src/components/LinksList.vue` | D-业务组件 | 257 | `@tanstack/vue-query` `lucide-vue-next` `vue` |
| `src/components/LogViewer.vue` | D-业务组件 | 674 | `@tanstack/vue-virtual` `@vueuse/core` `lucide-vue-next` `vue` |
| `src/components/message/ForwardModal.vue` | D-业务组件 | 177 | `@vueuse/core` `vue` |
| `src/components/message/ImageLightbox.vue` | D-业务组件 | 489 | `@vueuse/core` `lucide-vue-next` `reka-ui` `vue` |
| `src/components/message/MentionText.vue` | D-业务组件 | 84 | `@tauri-apps/plugin-opener` `vue` |
| `src/components/message/MergeCard.vue` | D-业务组件 | 73 | `lucide-vue-next` `vue` |
| `src/components/message/MergeCardModal.vue` | D-业务组件 | 283 | `vue` |
| `src/components/message/MessageAvatar.vue` | D-业务组件 | 28 | `vue` |
| `src/components/message/MessageCodeBubble.vue` | D-业务组件 | 103 | `lucide-vue-next` `vue` |
| `src/components/message/MessageContentModal.vue` | D-业务组件 | 129 | `@tauri-apps/plugin-opener` `lucide-vue-next` `vue` |
| `src/components/message/MessageContextMenu.vue` | D-业务组件 | 180 | `lucide-vue-next` `reka-ui` `vue` |
| `src/components/message/MessageFileBubble.vue` | D-业务组件 | 144 | `lucide-vue-next` `vue` |
| `src/components/message/MessageImageBubble.vue` | D-业务组件 | 154 | `lucide-vue-next` `vue` |
| `src/components/message/MessageLinkText.vue` | D-业务组件 | 30 | `vue` |
| `src/components/message/MessageReactionBar.vue` | D-业务组件 | 263 | `reka-ui` `vue` |
| `src/components/message/MessageReceipt.vue` | D-业务组件 | 169 | `lucide-vue-next` `reka-ui` `vue` |
| `src/components/message/MessageTextBubble.vue` | D-业务组件 | 249 | `@tauri-apps/plugin-opener` `lucide-vue-next` `vue` |
| `src/components/message/UnsupportedKindBubble.vue` | D-业务组件 | 44 | `vue` |
| `src/components/MessageItem.vue` | D-业务组件 | 1652 | `lucide-vue-next` `reka-ui` `vue` |
| `src/components/MobilePageFrame.vue` | A-公共UI | 106 | — |
| `src/components/NavRail.vue` | D-业务组件 | 233 | `lucide-vue-next` `reka-ui` `vue` |
| `src/components/RemindAudienceDialog.vue` | D-业务组件 | 109 | `vue` |
| `src/components/search/ChatSearchDialog.vue` | D-业务组件 | 551 | `@tanstack/vue-query` `@vueuse/core` `lucide-vue-next` `reka-ui` `vue` |
| `src/components/SelfAvatar.vue` | D-业务组件 | 57 | `vue` |
| `src/components/settings/AboutSection.vue` | D-业务组件 | 86 | `vue` |
| `src/components/settings/AppearanceSection.vue` | D-业务组件 | 103 | `vue` |
| `src/components/settings/ChatStyleSection.vue` | D-业务组件 | 254 | `reka-ui` `vue` |
| `src/components/settings/FilesSection.vue` | D-业务组件 | 129 | `@tauri-apps/plugin-dialog` `lucide-vue-next` `vue` |
| `src/components/settings/GeneralSection.vue` | D-业务组件 | 52 | `vue` |
| `src/components/settings/NetworkSection.vue` | D-业务组件 | 527 | `vue` |
| `src/components/settings/NotificationSection.vue` | D-业务组件 | 95 | `lucide-vue-next` `vue` |
| `src/components/settings/ProfileSection.vue` | D-业务组件 | 237 | `lucide-vue-next` `vue` |
| `src/components/settings/ResetSection.vue` | D-业务组件 | 129 | `vue` |
| `src/components/settings/SecuritySection.vue` | D-业务组件 | 21 | `lucide-vue-next` |
| `src/components/settings/SettingsGroup.vue` | D-业务组件 | 19 | — |
| `src/components/settings/SettingsRow.vue` | D-业务组件 | 24 | — |
| `src/components/settings/SettingsToggle.vue` | D-业务组件 | 63 | `reka-ui` |
| `src/components/settings/StorageSection.vue` | D-业务组件 | 273 | `@tauri-apps/plugin-dialog` `lucide-vue-next` `vue` |
| `src/components/SettingsPanel.vue` | D-业务组件 | 243 | `lucide-vue-next` `vue` `vue-router` |
| `src/components/SettingsWindow.vue` | D-业务组件 | 218 | `@vueuse/core` `lucide-vue-next` `vue` `vue-router` |
| `src/components/ShareDirectory.vue` | D-业务组件 | 140 | `@tanstack/vue-query` `lucide-vue-next` `vue` |
| `src/components/TitleBar.vue` | A-公共UI | 402 | `@tauri-apps/api` `@vueuse/core` `vue` |
| `src/components/ToastHud.vue` | A-公共UI | 26 | `reka-ui` |
| `src/components/ToastList.vue` | A-公共UI | 39 | `lucide-vue-next` `reka-ui` |
| `src/components/TodoCardBubble.vue` | D-业务组件 | 303 | `lucide-vue-next` `vue` |
| `src/components/TodoDetailDialog.vue` | D-业务组件 | 453 | `lucide-vue-next` `vue` |
| `src/components/TodoIconPicker.vue` | D-业务组件 | 70 | — |
| `src/components/TodoImageThumb.vue` | D-业务组件 | 184 | `vue` |
| `src/components/TodoPickField.vue` | D-业务组件 | 112 | `lucide-vue-next` `reka-ui` `vue` |
| `src/components/ui/BackArrow.vue` | A-公共UI | 30 | `lucide-vue-next` |
| `src/components/ui/CharCounter.vue` | A-公共UI | 27 | `vue` |
| `src/components/ui/ConfirmDialog.vue` | A-公共UI | 72 | — |
| `src/components/ui/DangerBtn.vue` | A-公共UI | 45 | — |
| `src/components/ui/icons.ts` | A-公共UI | 15 | `lucide-vue-next` |
| `src/components/ui/LinkIcon.vue` | A-公共UI | 28 | `lucide-vue-next` |
| `src/components/ui/NavIcon.vue` | A-公共UI | 32 | — |
| `src/components/ui/navIcons.ts` | A-公共UI | 22 | `lucide-vue-next` |
| `src/components/ui/PrimaryBtn.vue` | A-公共UI | 42 | — |
| `src/components/ui/SegmentedControl.vue` | A-公共UI | 86 | `reka-ui` |
| `src/components/ui/SettingsSelect.vue` | A-公共UI | 73 | `lucide-vue-next` `reka-ui` `vue` |
| `src/components/ui/Spinner.vue` | A-公共UI | 35 | — |
| `src/components/ui/StateBlock.vue` | A-公共UI | 80 | `vue` |
| `src/components/UnreadBadge.vue` | D-业务组件 | 62 | — |
| `src/components/VirtualList.vue` | D-业务组件 | 541 | `@vueuse/core` `vue` |
| `src/components/window/AuxWindowShell.vue` | A-公共UI | 56 | `vue` |
| `src/components/window/PreviewWindow.vue` | A-公共UI | 163 | `@tauri-apps/api` `vue` |
| `src/composables/useBackLayer.ts` | B-composables | 102 | `vue` |
| `src/composables/useClipboard.ts` | B-composables | 43 | `@vueuse/core` `vue` |
| `src/composables/useDocumentDark.ts` | B-composables | 27 | `vue` |
| `src/composables/useErrorText.ts` | B-composables | 29 | — |
| `src/composables/useExclusivePopup.ts` | B-composables | 32 | `vue` |
| `src/composables/useImeEnterGuard.ts` | B-composables | 54 | `vue` |
| `src/composables/useMemberProfile.ts` | B-composables | 38 | `vue` |
| `src/composables/useMentionContext.ts` | B-composables | 57 | `vue` |
| `src/composables/useMessageDisplay.ts` | B-composables | 116 | `vue` |
| `src/composables/useMessageFile.ts` | B-composables | 242 | `vue` |
| `src/composables/usePressMenu.ts` | B-composables | 87 | `vue` |
| `src/composables/useSearchKeyword.ts` | B-composables | 26 | `@vueuse/core` `vue` |
| `src/composables/useShortcuts.ts` | B-composables | 65 | `@vueuse/core` |
| `src/composables/useSubmitGuard.ts` | B-composables | 24 | `vue` |
| `src/composables/useWindowLauncher.ts` | B-composables | 67 | `vue` |
| `src/data/emojis.ts` | D-数据表 | 1074 | — |
| `src/data/hanInitials.ts` | D-数据表 | 115 | — |
| `src/entries/logs.ts` | E-入口/启动 | 32 | `vue` |
| `src/entries/main.ts` | E-入口/启动 | 19 | — |
| `src/entries/preview.ts` | E-入口/启动 | 19 | — |
| `src/entries/settings.ts` | E-入口/启动 | 33 | `@tauri-apps/api` |
| `src/entries/todos.ts` | E-入口/启动 | 31 | — |
| `src/i18n/index.ts` | B-国际化 | 176 | `vue` `vue-i18n` |
| `src/i18n/locales.ts` | B-国际化 | 16 | — |
| `src/i18n/locales/dict.ts` | B-国际化 | 7 | — |
| `src/i18n/locales/en-us.ts` | B-国际化 | 1113 | — |
| `src/i18n/locales/zh-cn.ts` | B-国际化 | 1147 | — |
| `src/layouts/ResponsiveLayout.vue` | A-布局 | 1037 | `@vueuse/core` `lucide-vue-next` `vue` `vue-router` |
| `src/router/main.ts` | 其他 | 165 | `vue` `vue-router` |
| `src/router/settings.ts` | 其他 | 46 | `vue` `vue-router` |
| `src/stores/useAppStore.ts` | C-状态层 | 1067 | `@tauri-apps/plugin-notification` `@vueuse/core` `pinia` `vue` |
| `src/stores/useChatStore.ts` | C-状态层 | 2980 | `@tauri-apps/plugin-notification` `pinia` `vue` |
| `src/stores/useImagePreview.ts` | C-状态层 | 130 | `pinia` `vue` |
| `src/types.ts` | D-数据表 | 671 | — |
| `src/utils/a11yLabels.ts` | B-utils | 131 | — |
| `src/utils/announcementDismiss.ts` | B-utils | 73 | — |
| `src/utils/appActions.ts` | B-utils | 51 | `mitt` |
| `src/utils/appearance.ts` | B-utils | 57 | — |
| `src/utils/avatarImage.ts` | B-utils | 78 | — |
| `src/utils/avatarSeed.ts` | B-utils | 70 | — |
| `src/utils/backStack.ts` | B-utils | 95 | — |
| `src/utils/blobLru.ts` | B-utils | 155 | — |
| `src/utils/bounded.ts` | B-utils | 48 | — |
| `src/utils/cardText.ts` | B-utils | 61 | — |
| `src/utils/chatSearch.ts` | B-utils | 113 | `dayjs` |
| `src/utils/chatSearchQuery.ts` | B-utils | 50 | `@tanstack/vue-query` |
| `src/utils/chatStyle.ts` | B-utils | 211 | — |
| `src/utils/clipboard.ts` | E-平台适配 | 52 | — |
| `src/utils/color.ts` | B-utils | 128 | — |
| `src/utils/composerDrafts.ts` | B-utils | 47 | — |
| `src/utils/configBool.ts` | B-utils | 19 | — |
| `src/utils/defer.ts` | B-utils | 71 | — |
| `src/utils/designGuards.ts` | B-utils | 2045 | — |
| `src/utils/emoji.ts` | B-utils | 68 | — |
| `src/utils/emojiUsage.ts` | B-utils | 139 | — |
| `src/utils/emptyList.ts` | B-utils | 26 | — |
| `src/utils/errors.ts` | B-utils | 106 | — |
| `src/utils/escapeRe.ts` | B-utils | 13 | — |
| `src/utils/externalLinks.ts` | E-平台适配 | 66 | `zod` |
| `src/utils/favoritePreview.ts` | B-utils | 81 | — |
| `src/utils/fileKind.ts` | B-utils | 161 | `lucide-vue-next` `vue` |
| `src/utils/fileMeta.ts` | B-utils | 36 | — |
| `src/utils/filePreview.ts` | B-utils | 238 | — |
| `src/utils/format.ts` | B-utils | 12 | — |
| `src/utils/friendOnline.ts` | B-utils | 80 | — |
| `src/utils/friendRequests.ts` | B-utils | 18 | — |
| `src/utils/groupFilesQuery.ts` | B-utils | 25 | `@tanstack/vue-query` |
| `src/utils/haptics.ts` | E-平台适配 | 55 | — |
| `src/utils/highlight.ts` | B-utils | 31 | — |
| `src/utils/imageBytes.ts` | B-utils | 114 | — |
| `src/utils/imageMime.ts` | B-utils | 44 | — |
| `src/utils/imageThumb.ts` | B-utils | 128 | — |
| `src/utils/imageThumbnail.ts` | B-utils | 85 | — |
| `src/utils/ime.ts` | E-平台适配 | 60 | — |
| `src/utils/initScope.ts` | B-utils | 43 | — |
| `src/utils/lightboxGestures.ts` | B-utils | 81 | — |
| `src/utils/linkify.ts` | B-utils | 205 | — |
| `src/utils/localFile.ts` | E-平台适配 | 51 | `@tauri-apps/plugin-dialog` |
| `src/utils/logFilter.ts` | B-utils | 129 | — |
| `src/utils/longPress.ts` | B-utils | 84 | — |
| `src/utils/mediaAvailability.ts` | B-utils | 55 | — |
| `src/utils/memberName.ts` | B-utils | 81 | — |
| `src/utils/memberNameCache.ts` | B-utils | 109 | — |
| `src/utils/mergeCard.ts` | B-utils | 173 | — |
| `src/utils/messageHeight.ts` | B-utils | 201 | — |
| `src/utils/messageKinds.ts` | B-utils | 218 | — |
| `src/utils/messages.ts` | B-utils | 600 | — |
| `src/utils/motion/index.ts` | B-utils | 20 | `motion-v` |
| `src/utils/nameGroup.ts` | B-utils | 93 | — |
| `src/utils/notifications.ts` | E-平台适配 | 67 | — |
| `src/utils/notifyUrgency.ts` | E-平台适配 | 37 | — |
| `src/utils/panelQuery.ts` | B-utils | 41 | `@tanstack/vue-query` |
| `src/utils/peerConnectionInfo.ts` | B-utils | 123 | — |
| `src/utils/peerMerge.ts` | B-utils | 43 | — |
| `src/utils/pins.ts` | B-utils | 49 | — |
| `src/utils/platform.ts` | E-平台适配 | 150 | — |
| `src/utils/popupRegistry.ts` | B-utils | 47 | — |
| `src/utils/pressGesture.ts` | B-utils | 33 | — |
| `src/utils/previewGalleryState.ts` | B-utils | 79 | — |
| `src/utils/previewMetrics.ts` | B-utils | 194 | — |
| `src/utils/quote.ts` | B-utils | 61 | — |
| `src/utils/quoteStyle.ts` | B-utils | 14 | — |
| `src/utils/reactions.ts` | B-utils | 158 | — |
| `src/utils/reminders.ts` | B-utils | 199 | — |
| `src/utils/safeStorage.ts` | B-utils | 99 | — |
| `src/utils/saveDestination.ts` | B-utils | 39 | — |
| `src/utils/saveImageAs.ts` | E-平台适配 | 16 | — |
| `src/utils/saveImageCore.ts` | E-平台适配 | 57 | — |
| `src/utils/selfChat.ts` | B-utils | 34 | — |
| `src/utils/shareTreeQuery.ts` | B-utils | 28 | — |
| `src/utils/shortcuts.ts` | B-utils | 40 | — |
| `src/utils/singleFlight.ts` | B-utils | 42 | — |
| `src/utils/staleGuard.ts` | B-utils | 43 | — |
| `src/utils/templateBranches.ts` | B-utils | 174 | — |
| `src/utils/time.ts` | B-utils | 89 | `dayjs` |
| `src/utils/toastManager.ts` | B-utils | 27 | `reka-ui` |
| `src/utils/todoCustomIcons.ts` | B-utils | 53 | `lucide-vue-next` `vue` |
| `src/utils/todos.ts` | B-utils | 1008 | — |
| `src/utils/tokenContrast.ts` | B-utils | 226 | — |
| `src/utils/transferState.ts` | B-utils | 49 | — |
| `src/utils/validation.ts` | B-utils | 132 | `zod` |
| `src/utils/windowLaunch.ts` | E-平台适配 | 29 | — |
| `src/vite-env.d.ts` | 其他 | 7 | `vue` |

### 1.4 测试码（分列，不计进业务成果）

共 101 份 / 21,252 行；由 `npm test` 的清单自己打印条数。
<!-- END:generated -->

## 2. 能力域 × 替换结论

### A. 公共 UI 基础组件

| 能力 | 现在住在哪 | 库/依赖 | 结论 | 依据 |
|---|---|---|---|---|
| 浮层定位、外点关闭、Esc、焦点陷阱、滚动锁定 | `src/components/BaseModal.vue`（Reka Dialog）、`src/components/message/MessageReactionBar.vue`（HoverCard）、`src/components/message/MessageReceipt.vue`、`src/components/MessageItem.vue`、`src/components/chat/MessageComposer.vue`（Popover）、`src/components/message/MessageContextMenu.vue`、`src/components/ui/SettingsSelect.vue`（Select） | `reka-ui@2.11` | **组合替换（已完成）** | 自研那一套 `utils/hoverCard.ts`、`utils/popupPosition.ts`、`composables/useHoverCard.ts` 已在 `3de6dd9` **删除**（−286 行）；组件里只留业务语义与外观类 |
| 对话框 / ActionSheet / 移动端页面壳 | `BaseModal.vue`(225)、`ActionSheet.vue`(67)、`MobilePageFrame.vue`(106) | Reka `DialogPortal/Overlay/Content` + 自研返回栈 | **组合替换** | 模态、焦点归还、外点由库；返回键与两级视图是业务（`utils/backStack.ts`、`composables/useBackLayer.ts`） |
| Toast | `utils/toastManager.ts`(27)、`components/ToastList.vue`(39)、`components/ToastHud.vue`(26) | Reka `createToastManager` + `ToastProvider/Root/Viewport` | **组合替换** | 计时、堆叠、限流、live region 归库；三份合计只剩配色/图标/安全区定位。⚠️ `ToastList.vue` 里那条"不许 `@escape-key-down` preventDefault"是库语义踩过的坑，别改回去 |
| Tooltip | 全库用原生 `title=` | — | **不引入** | 现读 0 处自研 tooltip；Reka Tooltip 会带来焦点/延迟新语义，无实测缺陷支撑 |
| Drawer / Table / Tree / 分页 | Drawer、Table：0 处；树只有一个共享目录树（`components/ShareDirectory.vue` 113 行） | — | **不引入 / 保留自研** | TanStack Table 与抽屉此前已判过（矩阵第 1 节：无复杂表格）；树是"本机磁盘 + 协议目录"两种数据源的合并展示，库给不了 |
| 虚拟滚动（日志） | `components/LogViewer.vue` | `@tanstack/vue-virtual` `useVirtualizer` | **直接替换（已完成）** | 两条外壳已迁；实测读数在报告 §6.18 与矩阵第 2 节 |
| 虚拟滚动（消息列表） | `components/VirtualList.vue`(525) | 不用库 | **保留自研** | 它承担的不是"虚拟化"而是**业务锚定**：切会话定位未读、prepend 不跳位、`unreadJump`/`swap`、回收行后仍要能回填高度（`utils/messageHeight.ts`）。前一轮 P7 实测过替换代价（矩阵第 2 节 C 档），重做只会在无读数情况下换掉一条已验证的链路 |
| 图标 | `components/ui/icons.ts`（高频语义图标唯一入口）+ 其余直连 | `lucide-vue-next` | **局部复用** | 判据 ㊵ 从 `icons.ts` 现解析分母（报告 §6.28 修掉手抄清单漂移） |
| 代码高亮 | `utils/highlight.ts`(29) + `components/CodeBlock.vue`(130) | `highlight.js` | **组合替换** | 词法归库，映射/降级/主题自研 |
| 主题 / 暗色 | `boot/theme-boot.js`（首帧裸 JS）、`stores/useAppStore.ts`（`matchMedia` 两处监听）、`composables/useDocumentDark.ts`(27)、`utils/appearance.ts`(56) | 不用库 | **保留自研（已有机器等价判据，P0 复核完）** | 规则的家是 `utils/appearance.ts`（纯函数 + 单测）；第二份在 `src/boot/theme-boot.js` —— 它由 vite 的 inline-boot 插件内联成**裸脚本**、必须早于 bundle 执行，所以 import 不到本模块，复制是平台约束。两份是否等价由 `appearance.test.ts` 用替身环境**把那段脚本真跑一遍**逐例对照（不是注释提醒）。本轮另外做两件事：① 该脚本的注释把下一个人指向 `useAppStore.readLocalAppearance()`，而**那个符号全仓不存在** ⇒ 改成真名并说明为何必须有两份；② `appearance.ts` 头注释仍说第二份在 `index.html`（早已搬走）⇒ 一并改准；③ 新加一条判据：**注释里点名的符号必须真在导出里**，再指空就红 |
| 无障碍静态判据 | `utils/a11yLabels.ts`(131)、`utils/designGuards.ts`(2041) | — | **保留（工具码）** | 只被 `npm test`/门禁读，不进产物；不计进业务成果 |

### B. 公共逻辑与工具能力

| 能力 | 现在住在哪 | 库/依赖 | 结论 | 依据 |
|---|---|---|---|---|
| 日期时间格式化 | **单一出口 `utils/time.ts`**（`fmtDateTime` / `fmtClock` / `fmtDateStamp` / `fmtConversationTime` / `fmtTimeDivider`） | `dayjs` + `dayjs/locale/zh-cn.js` + `vue-i18n` | **已改完（P1 #1，报告 §6.31）** | 原来两个家：另一处在 `utils/chatStyle.ts` 的 `formatTimeDivider`（连同硬编码的 WEEKDAYS 一起删）；`useMessageDisplay` 里那句自写的固定时间也并进了 `fmtDateTime`。**§6.56 又抓到第三处**：`chatSearch.ts` 的日期筛选自己拆年/月/日求零点、再用 `N × 86_400_000` 求「N 天前」⇒ 夏令时地区差一小时（本仓的「昨天」在 `time.ts` 那里是日历法、在搜索里是固定毫秒 ⇒ 同一口径两种算法），现也走 `dayjs().startOf("day").subtract(N,"day")`。⚠️ 语言必须由调用点当参数传（`currentLocale()`）：第一版走 `dayjs.locale()` 全局态时，`locale` 段探针在真浏览器里读到「切回中文仍印 Fri 12:00」—— 全局态不是响应式源，computed 不会重算 |
| 运行时校验 | `utils/validation.ts`(89，zod/mini) + `utils/externalLinks.ts`(66，另一份 zod/mini) | `zod@4.6` | **组合替换（已完成，P1 #2c）** | schema 判据留在 `utils/validation.ts`（Zod），message 位置只放**词典键**；上屏在调用点 `t(issue.message, { max })`，`max` 与输入框的 `:maxlength` 用同一个导出常量 ⇒ 「上限 / 判长 / 提示里的数字」三份并成一份。⚠️ 可达性实测：两格输入框都带 `maxlength`（数 UTF-16 单元）⇒ 能进 schema 的长度永远 ≤40，`tooLong` 与 `GroupCreateModal` 的 `nameEmpty`（按钮 disabled 挡着、且无 Enter 通道）**当前在 UI 里走不到**，属防御分支；只有 `ProfileSection` 昵称格的「空」那条真会响（挂着 `@keydown` 回车即存）。两格不是一件事 ⇒ 更正见 §6.36；真·用户可见的缺口是 `maxlength` 静默截断，已挪进队列 4b。⚠️ 这两个表单（GroupCreateModal / ProfileSection）不在任何探针段的挂载清单里，运行时只验到相邻段 |
| 文本长度上限（跨语言同一件事） | 前端 `utils/validation.ts`(群名 40 / 昵称 40 / 公告 500 / 搜索词 100 / 列表过滤 50) + `utils/todos.ts`(自定义类型 20 / 标题 200 / 描述 4000) + `utils/externalLinks.ts`(链接名 32) + `utils/logFilter.ts`(日志过滤 200)；后端主人：`commands.rs`、`commands/group_announcements.rs`、`commands/group_files.rs`、`commands/external_links.rs`、`protocol.rs` | 不用库（VueUse 的 `useMaxLength` 给不了跨语言对账） | **组合替换（已完成，P1 #8）** | 整改前生产模板里有 **10 处 `maxlength="数字"`**（同一概念三个不同值：搜索/过滤关键词 100、100、100、50、50、200、200），数值全对但没有任何机器判据 ⇒ 后端那几处多是**私有 const**，且超长走的是 `chars().take()` **静默截断**（`chat_search.rs:59`、`group_membership.rs:10`），任一侧改动都不会红。现在每一格绑具名常量，`utils/textLimits.test.ts` 现读两边数值 + 扫全模板禁止裸数字（白名单为空）。⚠️ 口径差异是已知且方向安全的：`maxlength` 数 UTF-16 单元、后端数码点 ⇒ 含 emoji 时前端更严，不会出现"前端放过、后端偷偷截"。⚠️ 这句在 §6.41 后**只对了后端那一半**：前端更严是真的，但"更严"本身原来对用户静默 —— 现在 9 格存值字段都由 `components/ui/CharCounter.vue` 把长度说出来（数字数码点 = schema = 后端，告警色按两把尺里**先到**的那一把亮 ⇒ 不会出现"20/40 却打不进字"）|
| 国际化 | `i18n/index.ts` + `i18n/locales/*`（zh / en，key 一一对应有现成护栏） 仍绕开 vue-i18n 的用户可见中文只剩会话预览那一族标签：`utils/messages.ts`(12 档 `[文件]/[图片]/…`) + `utils/mergeCard.ts`(2 档 `[聊天记录]`) ⇒ 存储 / 协议面，判**暂缓**（§6.42）| `vue-i18n@11` | **组合替换（P1 #2：时间 ✅、预览原因 ✅、通知与日志标题 ✅、表单校验 ✅、错误文案 ✅；剩会话预览标签一族 = 暂缓）** | 已接上的键：`date.yesterday` `date.md` `date.ymd`、`media.tooLarge`、`notify.one` `notify.count` `notify.senderCount`、`logs.merge` `logs.mergeDup` `logs.mergedCount`、`errors.*`（9 条，中英各一份）。现算口径（剥注释后扫「`return "…"` 里含中文」）：生产 `src/utils/**` 只剩 `messages.ts`(12) + `mergeCard.ts`(2)；`errors.ts` 与 `validation.ts` 已归零（本批 + §6.36）。⚠️ `errors.ts` 与 `filePreview.ts`/`mediaAvailability.ts` 里剩下的那批中文**不是文案，而是「匹配后端中文错误串」的分类判据** ⇒ 要说全英文得先让后端给结构化错误码，那属协议面（记为暂缓，不在本专项动）。⚠️ 约束：`utils/*` 被 `node --test` 直接 import，裸 Node 解析不了 `@/` ⇒ 只能由调用侧注入文案（先例：`fileKind.extBadgeLabel`、`time.fmtTimeDivider`；错误那一族的落点见 `composables/useErrorText.ts`）。数据表（`data/emojis.ts`）、判据文案（`designGuards.ts`）与协议占位符（`messages.ts` 的方括号那批）不算这条账 |
| 事件总线 | `utils/appActions.ts`(51) | `mitt@3.0.1` | **直接替换（已完成）** | 只有一个家；`appActions.test.ts` 钉"卸载必须调掉全部解绑"。跨窗口动作不再各写一遍 `window.addEventListener` |
| 订阅↔卸载配对 | **`utils/initScope.ts` 一个家，10 份生产文件在用**（两个 store + `GroupFilesPanel` + §6.59 并进来的 `TitleBar`/`ChatWindow`/`GroupTasksBoard`/`GroupTodosWindow`/`PreviewWindow` + §6.60 的 `ConversationList`/`ResponsiveLayout`） | 不用库（Vue 只提供 `onScopeDispose`，管不到 `listen()` 要等一次 IPC 往返这件事） | **组合替换（§6.59 + §6.60 完成）** | 关键语义是「**迟到的注册**」：卸载函数在 `onBeforeUnmount` 之后才到手时，就地执行它而不是攒进一个已拆掉的列表。§6.59 之前这一族有 4 个家（3 份手写守卫 + 2 处**根本没有守卫**），并回一处后手工句柄与手写守卫在生产码里都是 0（判据 ㊷）；⚠️ 判据只认两个信号（名字前缀 `dispose\|unlisten\|cancel\|teardown\|cleanup` ∪ 类型 `UnlistenFn`），**滚动释放句柄**（`useBackLayer` 的 `release`、`useChatStore` 切群的 `groupTodosUnlisten`，竞态由 `StaleGuard` 裁决）是另一个家，写成反控不许误伤 |
| 浮层全局互斥 | `utils/popupRegistry.ts`(47) + `composables/useExclusivePopup.ts`(32) | 不用库 | **保留自研** | Reka `DismissableLayer` 管的是**栈内**外点/Esc，不提供"不同浮层之间同一时刻只开一个"（`contextmenu` 不触发 click，历史缺陷就是两个菜单并存）。纯状态机、可 Node 直测 |
| 请求缓存 / 去重 / 失效 | `utils/panelQuery.ts`(40) + `utils/groupFilesQuery.ts`(25) + `utils/shareTreeQuery.ts`(28)，消费者 `GroupFilesPanel`、`ShareDirectory`、`ChatSearchDialog` | `@tanstack/vue-query` | **组合替换（已完成）** | 只读面板交给库；消息状态机**刻意不进 Query**（可靠投递/离线队列是业务状态，不是服务端缓存 —— 目标 C 档那条边界） |
| 预览字节缓存 + inflight 去重 | 字节那份：`utils/blobLru.ts`(一个家)。在途去重那份：**已收到** `utils/singleFlight.ts`(一个家)，现 **5 处**在飞取数口各调 `run()`（`filePreview` 3 + `favoritePreview` 1 + `useChatStore.ensureGroupTodoRows` 1）—— 原来自抄 **五份**（预览那 4 份里，`loadThumbPreview` 一度被本行漏数，它是唯一用 `p.finally(...)` 那种**会在同键重新登记后误删别人记录**的写法；第 5 份是群任务补读） | 不用库 | **组合替换（已完成，P1 #3 / #3b）** | Query 不管「按字节封顶的 blob + objectURL 生命周期」⇒ 缓存那层保留自研；去重那 6 行是纯通用逻辑 ⇒ 共用一个 helper。⚠️ 唯一留下的同形状手写在 `useChatStore.loadingMore`（`new Map<string, Promise<void>>`）：它有两处被注释保护的偏离 —— 容量闸门 `pages >= MAX_PAGES` 夹在"并入在飞"与"登记"之间、摘除用 `page.finally(...)` **挂在链上**（让 `page` 始终带处理器，reject 不变成 unhandled rejection，同时所有 await 方各拿同一次结果），这两条都没有判据兜着 ⇒ **保留自研**，判定与实测见 §6.38 **§6.62 又并一层：单条预览上限 `15 MiB` 曾在前端抄三份、Rust 另有三处 `.min(15*1024*1024)`；前端收成 `filePreview.ts` 的 `IMAGE_PREVIEW_MAX_BYTES` 一个家，跨语言同值由 `imageBytes.test.ts` 现读两侧源码对账（那句「与后端同一口径」从此有机凭据）。**
| 防抖 / 节流 | 现算 `grep -ro clearTimeout src --include="*.vue"` = **15 处 / 12 本**生产 `.vue`（§6.40 记的 19 处/13 本是当时的现算，本批与 §6.43 各又去掉了几处手写计时器 ⇒ 两个数别互抄）；通用的那一格已归库，`utils/defer.ts`(93 → **59** 行，现算 `wc -l src/utils/defer.ts`) 只剩 `INPUT_DEFER_MS` + `shouldRunThrottled`；后者现在有 **4 个调用点 / 3 本生产文件**（`windowLaunch` + `useChatStore` 的抖动与群历史重查 + `MessageComposer` 的草稿已满提示）—— §6.55 把散在外面的 5 份手写闸门并进来，并新增一条"手写时间差闸门不许长回第二份"的现扫判据 | `@vueuse/core@14.4.0` 的 `useDebounceFn` + `refDebounced`（**已用四格**：剪贴板 / 监听器 / 防抖 / 延迟镜像） | **直接替换（2026-10-19 完成，§6.44；队列 11① 同批关掉）** | 动手前在本仓那套假定时器下把库的语义逐条量过，六条一致（§6.44）：尾沿只执行一次且取最后一次参数、`cancel` 丢弃待执行、`flush` 立即执行且之后不再补、无待执行时 `flush` 是空操作、延迟镜像初始读原值且窗口后落新值、作用域关闭后不再回写。删掉的旧实现 = `defer.ts` 里的 `Debounced` + `debounce` 与整册 `composables/useDeferredRef.ts`(31)；`useSearchKeyword`/`AddFriendModal`/`ForwardModal`/`LogViewer` 四格直接叫 `refDebounced(x, INPUT_DEFER_MS)`（库的默认窗口是 200ms，实测值是 120 ⇒ 每格显式传常量，常量只有 `defer.ts` 一个家），`useAppStore.persistSoon` 与 `ChatSearchDialog` 的输入防抖直接叫 `useDebounceFn`。真值表留在 `defer.test.ts` 前半 —— 现在钉的是**库契约**，升级改了哪条语义会当场红。⚠️ §6.40 那句「`useDebounceFn` 换不掉两档这一层」**把库的能力记少了**：两档里"延迟镜像"那一档就是 `refDebounced` ⇒ 已在 §6.44 更正。其余五族（长按 4 家、重试 2 家、连点冷却 2 家、反馈复位 3 家、VirtualList 内部收敛 2 制）语义各不同 ⇒ 仍**只登记不并** **§6.61 又并一次：「等一会儿」（`sleep`）这一族曾有 2 份手抄（`MergeCardModal` 私有 helper、`useAppStore` 蓝牙重试内联），库里没有对应物（`@vueuse/core` 14.4.0 与 `@vueuse/shared` 两份 d.ts grep `sleep` 各 0），故收进 `defer.ts` 一个家；`setTimeout(fn, 0)` 当「等这一拍」用的 2 处（`StorageSection`）换回 Vue 自己的 `nextTick`，第 3 处（`useChatStore` 的批量冲刷）判成宏任务边界另一件事、保留。**
| 剪贴板 | `composables/useClipboard.ts` 一个家（VueUse 的 copy + 按 key 的已复制态 + 复位）；`utils/clipboard.ts` 是**粘贴意图分类**（图片/文件/文本三条分支），与复制不是同一件事 ⇒ 不算第二份 | `@vueuse/core` | **组合替换（已完成，P2 #4）** | 写入与老 WebView 的 `legacy` 回退交给 VueUse，本仓只留「按 key 复用同一枚已复制勾」。原第二份在 `LogViewer.vue`（直连 VueUse + 手写 setTimeout，复位时长 2000ms 与组合式的 1500ms 不一致、卸载清理也不一致），现已并回并由 `componentImports.test.ts` 的接线判据钉住。⚠️ 但**唯一家自己也撒过一次谎**：`copyContent` 原本返回 `Promise<boolean>`、实现恒为 `true`（@vueuse/core 14.4.0 的 `copy()` 吞掉 async 写失败、`legacyCopy` 丢掉 `execCommand` 的返回值，之后无条件 `copied=true`）⇒ 5 个组件里 7 处 `ok ? 已复制 : 复制失败` 的失败半边**永远跑不到**，真没写进去时界面还说"已复制"。现在签名改成 `Promise<void>`，假分支由编译器逼着清掉（行为与今天完全一致：今天本来就只显示成功），AboutSection 那第二份"就地反馈 + 自备 1500ms 定时器"也一并并回 `copiedKey`。见 §6.40 |
| 快捷键 | `utils/shortcuts.ts`(40 纯函数) + `composables/useShortcuts.ts`(66) | 不用库 | **保留自研** | 命中表是**应用动作**（与 `appActions` 同源），要躲 IME 组合态；`useMagicKeys` 给的是键名，不是动作 |
| 长按 / 手势 | `utils/longPress.ts`(84) + `utils/lightboxGestures.ts`(81) | 不用库 | **保留自研** | 450ms + 位移阈值 + "松手吞掉紧随的 click"是移动端实测出来的；pinch 缩放 VueUse 没有 |
| 平台 / 输入能力 | `utils/platform.ts`(135)：`canHover`、`resolveMobileLayout`、`prefersReducedMotion`（§6.52） | 不用库 | **保留自研（已收口）** | 判据 ㉟ 禁止组件裸写 `matchMedia`/UA；Android 首屏兜底视口那一条是真实事故。「减弱动态效果」这条查询原来在 `haptics.ts` 里自己抄了一份，现在两家（触觉、桌面 OS 抖窗）都调本模块，`platform.test.ts` 现扫全仓生产码保证不再长出第三份 |
| 首帧语言与窗口标题（第二份实现） | `src/boot/theme-boot.js` ↔ `src/i18n/index.ts`（`detectSystemLocale` 那份） | 不用库 | **保留自研 + 逐例对照（§6.47）** | 脚本必须早于 bundle 执行、import 不到模块 ⇒ 复制是平台约束。本批抓到一处**真实分歧**：`languages` 全是非中英而 `navigator.language` 是中文时，脚本判英文、i18n 判中文 ⇒ 骨架会先英文再翻回中文；已把脚本对齐到事实源，另加"标题取中英两支"与"五扇窗口 HTML 必须同时声明 `data-title-zh`/`data-title-en`"两条判据。期望值全部由 i18n 的公开 API 现算，判据里不抄白名单也不抄前缀规则 |
| 本地存储读写（`localStorage`） | 生产码 **21 处 / 5 本**：`stores/useAppStore.ts` 14、`boot/theme-boot.js` 5、`stores/useChatStore.ts` 2、`layouts/ResponsiveLayout.vue` 2、`i18n/index.ts` 2（复跑：`git grep -c 'localStorage\.\|sessionStorage\.' -- 'src/**/*.ts' 'src/**/*.vue' 'src/boot/*.js' \| grep -v '\.test\.'`） | VueUse `useStorage`（已装）／自写 `utils/storage.ts` | **保留自研（数完了，别重开这把尺子）** | 两头的"家"都不成立：① 21 处的键、回落值、序列化形状**各不相同**，全轴只有 **1 处** 走 JSON（`CHAT_STYLE_KEY`）⇒ 抽 `storage.ts` 是给三个不同形状造一个通用口（§七-4/6）；② `useStorage` 返回的是**新的 ref**，而这些值今天已经各自有权威宿主（store 字段 / `chatStyle` 对象）⇒ 接进去等于多造一个状态源（§三-C 明确禁的那类），且它的写失败与 `copy()` 同一族静默。首屏那 5 处更必须零依赖裸写（`theme-boot.js` 由 inline-boot 内联成裸脚本、早于 bundle，§6.47 已判）。**真正重复的那一维（键名跨 Rust/前端边界）已有 §6.46 的判据守着** ⇒ 本轴的判定 = 已数完 + 已有家，不动码 |
| 主题色三档派生 + 字体首帧 | `src/utils/color.ts` 的 `applyTheme` ↔ `src/style.css:12-16`（硬编兜底）；字体那半还多两处：`skeleton.css` 写死默认栈、`color.ts` 里再抄一份兜底串 | CSS `color-mix()`（本仓已在用）+ 首屏脚本写同一个 token | **直接替换 + 删掉旧实现（§6.49 / §6.50）** | `-soft` / `-ring` / `--gosslan-accent-ink` / `--gosslan-danger-hover` 本来就靠 color-mix 现派生，JS 那一份是异类；收成一份之后首屏只写主色就成套，`.dark` 也第一次可能单独覆盖派生档（以前被 inline 压着） |
| 系统通知 / 保存 / 打开 | `utils/notifications.ts`(61)、`utils/saveImageCore.ts`(57)、`utils/localFile.ts`(51)、`utils/externalLinks.ts`(66) | `@tauri-apps/plugin-notification` / `-dialog` / `-opener` | **组合替换** | 权限、原生通道归插件；文案与聚合是业务（文案那条见上面 i18n 行） |
| 错误映射 | `utils/errors.ts`(106，**纯分类器、一条文案都不带**) + `composables/useErrorText.ts`(29，唯一拼装口) + `i18n/locales/*` 各 9 条 `errors.*` | `vue-i18n@11` | **组合替换（已完成，P1 #2 · §6.42）** | 「这条错误该归哪档」是业务字典（要认后端那些中文错误串 ⇒ 正则里的中文是**判据**不是文案）；「这句话怎么写」归词典。旧公开函数 `friendlyError` / `reportError` **已删除**；95 处 `app.toastError` 与 10 处内联读数共用同一支 `errorText` |

### C. 数据与状态层

| 关注点 | 现读事实 | 结论 |
|---|---|---|
| 服务端状态 vs 业务状态 | `stores/useChatStore.ts`(2945) = 消息状态机（乐观态、ACK、重试、离线）；面板只读数据走 vue-query | **边界正确，不动**。目标里"不得混为一谈"这一条已满足 |
| 同一名片的家 | `utils/memberName.ts` 唯一判据 + `chat.nicknameOf()` 唯一出口 + `memberNameCache.ts` 只管"上次叫什么"的本机显示缓存 | **已收口（2026-10-14）**，不是重复状态源，别重做 |
| 组件级派生态 | `composables/useMessageDisplay.ts`(113) 现推气泡文案/时间分割线 | 合理：从消息行现推，不另存。分割线那一格**阈值与判定不在这里**：与估高端共用 `previewMetrics.shouldShowTimeDivider`（§6.63，㊸ 判据钉住）；昵称行同族（`messageKinds.shouldShowNickname`，§6.64）|
| 浮层开态 | `MessageItem`/`MessageReceipt`/`MessageComposer` 各一个 ref + `popupRegistry` 全局互斥；`MessageReactionBar` 本轮刚把第三条状态源删掉（报告 §6.30） | **合规**，`reactionRoster.test.ts` 现在钉住"派生值不许被直接写" |
| 监听器清理 | 现算分母：`.vue` 里 19 处 `addEventListener` / 12 本（剥注释后全仓生产侧具名注册 25 处）。逐格读后三档：**15 处**挂载期注册 + 卸载期同 `(事件,处理器)` 解绑；**4 处**按业务状态开关（`MessageItem` 长按 3 + `GroupTasksBoard` 粘贴 1）；**根组件 4 处 + store setup 2 处**处理器写成匿名、根本没有可传的句柄 ⇒ 摘不掉。真·文档级常驻只剩 `boot.ts`(崩溃钩子)、`i18n/index.ts`(languagechange)、`useBackLayer`(popstate，带 `installed` 旗标) | **前两组保留自研**（§七.7：行为已对、各自有真界面读数，为用库重排热路径不值；那 4 处寿命不是组件作用域）；**后一组已修（§6.43）**：`App.vue` 交给已装的 `@vueuse/core` `useEventListener`（组件作用域自动解绑，顺带把内联的右键判断提成具名 `suppressContextMenu`），store 那两条挪进 `init()` 的 `scope.onDispose`（同文件本就这个口径，不新增抽象）。新判据在 `designGuards.test.ts`：`.vue` 出现内联处理器 ⇒ 红；手写 add 配不上同 `(事件,处理器)` 的 remove 且整文件没用 `useEventListener` ⇒ 红；另带两条分母下限防"扫空报绿"。⚠️ 更正上一版这格的判断：它把 `App.vue` 三条也算成"文档级常驻不是泄漏"—— 不成立，那是**组件作用域**，重挂一次多一份闭包、多打一次 `set_app_active` |
| 事件订阅（Tauri） | `api/index.ts`(725) 一处出口，`api/events.test.ts`(422) 钉 unlisten | **保留**，有判据 |
| 本地持久化快路径的**键名** | 现算具名 `*_KEY` 字符串常量 **11 个**（`appearance.ts` 2、`useAppStore.ts` 3、`i18n` 1、`useChatStore` 1、`announcementDismiss`/`memberNameCache`/`emojiUsage` 各 1、`ResponsiveLayout` 1）；生产码裸字面量调用 **0 处**（§6.46 之前是 6 处 = 首屏脚本 4 + `ResponsiveLayout` 2） | **保留自研 + 已加跨边界判据（§6.46）**：localStorage 只作启动首帧快路径，真值在后端 settings。首屏脚本 import 不到模块 ⇒ 只能用字面量，键名有两种载体；`appearance.test.ts` 现在**两边都从源码现解析**逐角色比对（私有常量按名字解析，不为测试扩导出面），并断言生产码零裸字面量键（缺席型断言自带正控）。漂移原本是**静默**的：编译期看不见、探针也看不见，只有首帧外观/语言错 |

### D. 业务渲染组件

`components/message/*`(18 份 2544 行)、`GroupTasksBoard.vue`(1577)、`FavoritePanel.vue`(939)、
`ConversationList.vue`(588)、`GroupMemberPanel.vue`(484) 等：**保留自研**，它们只消费 A/B 层的原语。
长度方面本轮不动：`useChatStore.ts` 2945 / `ChatWindow.vue` 1740 / `MessageItem.vue` 1649 /
`GroupTasksBoard.vue` 1577 是仓内前端最长四份，前一轮架构复审已把"纯搬家拆分"判为
短期只降稳定（报告 §7 第 7 步），要拆必须先有能观察行为的读数。

### E. 通信与平台适配

`api/index.ts` 是 IPC 唯一出口（含 `parseIpcList` + zod 读边界）；`utils/transferState.ts`、
`utils/pins.ts`、`utils/quote.ts`、`utils/reminders.ts` 等把后端载荷翻成界面语义，**保留自研**：
协议语义、消息顺序、重试与确认机制不因库化改动（目标第七节第 8 条）。

## 3. 已完成（不重做，只给账）

| 批次 | 落点 | 真删掉的东西 |
|---|---|---|
| Reka 迁移（5.0 全程） | 浮层、Dialog、Select、Switch、RadioGroup、Slider、Toast、Menu、ContextMenu、Focus | `@headlessui/vue` 整包；`utils/hoverCard.ts` + `utils/popupPosition.ts` + `composables/useHoverCard.ts`（−286 行，`3de6dd9`） |
| vue-query 接入 | 群文件 / 共享目录 / 聊天记录搜索 | 三处手写 fetch+loading+error 状态 |
| vue-virtual 接入 | 日志页 | 日志那两条自写窗口切片外壳 |
| dayjs 接入 | `utils/time.ts` 单口 | 日志 / 诊断 / 导出文件名三处手写格式化 |
| zod 接入 | `utils/validation.ts` + `utils/externalLinks.ts` | 手写 if-string 校验 |
| mitt 接入 | `utils/appActions.ts` | 每个动作各写一遍 `window` 自定义事件 |
| VueUse 接入 | `composables/useClipboard.ts` | 自写 clipboard 兼容层（iOS/WKWebView 那一段） |
| 间接层删除 | `GROUP_FILES_QUERY_POLICY`、`filePreview` 里的 `imageMime` 转出、`favoritePreviewCacheBytes`/`filePreviewCacheBytes`/`fileKindColor`/`ICON_WELL_BG`/`__resetWindowLauncherForTest` | 死导出与"为不改 import 点而存在"的转出 |
| 重复实现合并 | `fileKind.extBadgeLabel`（角标三处）、`app.toastError`（错误出口四处）、`canHover`（平台判定） | 各写一遍的分支与文案兜底 |
| 主题令牌「定义 ↔ 消费」 | 判据 ㊺（`designGuards` 161）＋ 5 本组件里 8 处改指在册的令牌（§6.68） | 未定义的 `--gosslan-text-3` / `--gosslan-surface-2` / `--gosslan-link-ink`（**不是新增**，是删掉三个从来没被定义过的名字） |
| Tauri 事件名两端对账 | **已有家，别重开**：`src/api/events.test.ts` 三条一起钉（每个 Rust 事件必须有前端消费者或写在例外清单里 / 前端听的名必须真有人发 / 例外清单不得含已被监听的事件） | 本轮实测过一次"自己重数一遍"的代价：naive 正则只认出 5 个监听名、把 25 个 `EVENT_*` 常量发射判成"没人听"⇒ **要读那个家的解析器，不要另起一把尺子**（复跑：`node --test src/api/events.test.ts`） |
| 尺寸常量的家 | 移动端底栏占位高度：两处手抄的 `4rem` + 一个没人读的 `--gosslan-mobile-tabbar-h` ⇒ 收成令牌一个家（判据 ㊻，§6.69） | 手抄的第二、第三个家 —— 改一处就让另一处的最后一行被 fixed 底栏压住 |
| 构建口径 | `tailwind.config.js` 的 `content` 排掉 `*.test.*` | **13 条死 CSS 规则**从生产包里消失：Tailwind 扫原始文本，判据夹具里那些"故意写坏的示例 class"被当成真在用过的样式生成了出来 |

## 4. 下一批执行顺序

| 序 | 档 | 项 | 为什么先做它 | 验证方式 |
|---|---|---|---|---|
| 1 | ~~P1~~ **已完成** | **时间文案单口 + 接 vue-i18n**（`chatStyle.formatTimeDivider`/`WEEKDAYS` → `utils/time.ts`；`fmtConversationTime` 的「昨天」同批） | 一个能力两个家 + 英文界面整条分割线是中文，用户可见且机器可判 | 实做：`time.test.ts` 8 条（两档语言各断言 + 现算分母 12 处 + 不许动全局）、`npm test` **1053/1053**、快速层 **17/17 19.4s**、探针新增 `locale` 段 **7/7**（真浏览器切语言）、护栏 +1 条 → **234**，名片段 **1/1**。过程中那条接线判据被护栏判成**空转**一次（存在性断言 ⇒ 改成按次数判）；`locale` 段又抓出「全局 dayjs locale 不参与响应式」⇒ 改成参数传语言。报告 §6.31 |
| 1b | ~~P0~~ **已完成** | 语言切换后 dayjs 本地化数据不重算（星期名停在上一门语言） | 真浏览器探针当场抓的，属于"重复状态源/错误失效"那一档 | 改成 `currentLocale()` 当参数传 + 实例级 `.locale()`；`time.test.ts` 钉「剥注释后不许出现 `dayjs.locale(`」 |
| 2 | ~~P1~~ **已完成到"能搬的那一族"（见 §6.42）** | **用户可见文案接 i18n 第二批**：`utils/errors.ts` ✅、`utils/validation.ts` ✅(§6.36)、`components/LogViewer.vue` ✅、`utils/notifications.ts` ✅；`utils/mediaAvailability.ts` / `utils/filePreview.ts` **判为不是文案那一族**（里面的中文是"匹配后端中文错误串/预览原因"的分类判据）| 同一族缺陷一次清完；调用侧注入文案的写法本仓已有先例 | 原计划那条「`return` 出来的中文字面量必须为 0」**按实测不成立也不该成立**：剩下 14 档全在会话预览标签那一族（`messages.ts` 12 + `mergeCard.ts` 2），Rust `protocol::preview_text` 算的那一份会进存储 ⇒ 归零等于改存储/协议，判**暂缓**（§七.8）。实做判据换成两条：`errors.test.ts` 现扫"生产码 throw 的 `errors.*` 键必须在中英词典都有"（含 `all.length >= 7` 防空扫）+ 探针 `errtext` 段真界面读 `[role=alert]` 两行。读数：`npm test` **1072/1072**、快速层 **17/17**、探针全量 **412/412 exit 0**；两次单点变异各 0/4 红（原始串外泄 / 语言对调）|
| 3 | **P1** | ~~inflight 去重三份收一份~~ **已完成（实为四份，见 §6.34）**：`utils/singleFlight.ts` + 5 条用例 + 1 条护栏 | 重复事件处理最典型形状；字节上限留业务侧 | `npm test` 1060/1060、快速层 17/17、探针 imgload/files/lightbox 23/23、护栏 1/1 |
| 3b | ~~P1~~ **已完成（见 §6.38）** | `useChatStore` 的两处同形状在途表：`ensureGroupTodoRows` **并入** `singleFlight`（逐字同形状，调用方全是 `void`）；`loadingMore` **判成保留自研** —— 容量闸门夹在"并入在飞"与"登记"之间、摘除用 `page.finally(...)` 挂在链上（防 unhandled rejection + 所有 await 方各拿同一次结果），两条偏离都没有判据兜着 | 同一份通用逻辑不该有两种实现 —— 但**等价性证不了的那一格就不并**；反向白名单钉在 `singleFlight.test.ts`：谁将来强并而没先补行为判据 ⇒ 测试红 | 现算：`grep -rn createSingleFlight src`（排测试与本体）= 4 实例 / 5 个 `run()` 取数口；残留手写 `new Map<string, Promise` 的生产码 = **1 格**（`useChatStore.ts:1294`，原 2 格）；`npm test` 1065/1065、快速层 17/17 exit 0 |
| 3c | ~~P1~~ **已完成（见 §6.39）** | 10 处手抄 `maxlength="数字"` 全部绑成具名常量 + 新增 `utils/textLimits.test.ts` 做 **TS↔Rust 数值对账**与"模板里不许裸数字"的现扫分母 | 同一个长度规则有三个落点（后端私有 const / 输入框数字 / 有时还有 schema），而任一侧改动都不会红；后端超长走 `chars().take()` 静默截断 | 现算：`grep -rn 'maxlength="[0-9]' src --include="*.vue" \| wc -l` = **0**（原 10）；那一批改的是**被手抄的那 10 格**，全仓常量绑定站点现算是 16 格（其中 9 格要存住 ⇒ 见 4b/§6.41）；两次单点变异各证一次（改 Rust 值 ⇒ 对账红；改回裸数字 ⇒ 分母红）；`npm test` 1068/1068、快速层 17/17、探针 favorites 段新增一格 **9/9**（真实 DOM 读 `attr="50"` 与 `input.maxLength===50`），typo 变异跑一次 **8/9** 当场红 |
| 3d | ~~P1~~ **已完成（见 §6.40）** | 全量计时器形状清点（19 处 / 13 本生产组件）后动手的那一格：`useClipboard.copyContent` 的返回值不再撒谎 + AboutSection 第二份就地反馈并回唯一家 | 包装层承诺了依赖给不了的信号 ⇒ 7 处错误分支是死代码、用户永远只看到成功 | `npm test` 1068/1068、快速层 17/17（vue-tsc 逐处逼出假分支，改完全仓无残留）、探针 settingsmobile/favorites/composermobile **15/15**；清点表里其余五族（长按 4 家、重试 2 家、连点冷却 2 家、反馈复位 3 家、VirtualList 内部收敛 2 制）只登记未动，理由见 §6.40 |
| 4 | **P2** | ~~剪贴板两条入口归一~~ **已完成（见 §6.35）**：`LogViewer` 那份并回 `composables/useClipboard` | 同一个通用交互不该有两份行为不同的实现 | 接线判据（现扫全部 `.vue`）+ 护栏「复制反馈又长出第二份」，两次单点变异跑通 |
| 4b | ~~P3~~ **已完成（见 §6.41）** | 把 **`maxlength` 的静默截断说给用户**：新增 `components/ui/CharCounter.vue` 一枚读数件，9 格「要存住」的上限全部配上 `n/max` 读数（实到 6 本组件），并删掉 `GroupTasksBoard` 里那把用 `.length` 数 UTF-16 的第二把尺 | 这是当前**真·用户可见**的行为缺口，比那两条防御性 toast 文案值得做多；而读数一旦各写一遍就会各数一维 | 现算：`python3` 扫 `src/**.vue` ⇒ 常量绑定 16 格、裸数字 0 格、`<CharCounter>` 9 处；`npm test` **1070/1070**、快速层 **17/17**；探针 `namecap` 段 **3/3**（空值不常驻读数、41 个 emoji 印 `41/40`、20 个 emoji 印 `20/40` 且告警色亮）+ `links` 段 **6/6**（360 px 窄栏里读数与输入框同排：输入框仍 >=120 px、读数右沿不越面板）；三次单点变异各证一次（摘掉 LinksList 读数 ⇒ 静态判据红 / 同一处再摘 ⇒ 探针 5/6；`atCap` 去掉 UTF-16 那半边 ⇒ 探针 2/3），恢复后复绿 |
| 5 | ~~P1~~ **已复核 → 推翻（见 §6.37）** | 「暗色解析两个家」这条**不是重复状态源**：规则的家是 `utils/appearance.ts`（纯函数），第二份 `src/boot/theme-boot.js` 由 vite 插件内联成**裸脚本**、必须早于 bundle 执行（否则首帧闪白），结构上 import 不到那个模块 ⇒ 复制是平台约束；而且两边等价**早就有机器判据**（`appearance.test.ts` 用替身 `localStorage/document/matchMedia` 把那段脚本真跑一遍逐例对照） | 真缺陷是**注释指错地方**：那段脚本让人去对 `useAppStore.readLocalAppearance()`，而该符号**全仓不存在**；`utils/appearance.ts` 头注释又说第二份在 `index.html` 里 —— 早已搬进 `src/boot/theme-boot.js`。两条注释本批已改对 | 不动实现。**判"重复实现"的通用口径：先查有没有等价判据，再看注释点名的符号真不真存在**（这条比这一格更值钱） |
| 6 | ~~P1~~ **清点 + 那一族都已收口（见 §6.40 与 §6.44）** | 「107 处 timer/防抖」是**旧口径**：按"生产 `.vue` 里带 `clearTimeout` 的计时器"现算是 **13 本 / 19 处**（§6.40 当时现算），已按形状分完六族；§6.44 把通用的那一族（输入防抖 + 延迟镜像）整格交给 `@vueuse/core`，现算同一口径 = **12 本 / 15 处** | 分母口径没先对齐就会去合并一批其实不同用途的计时器（重试、冷却、复位、动画、防抖各有各的语义）；数完之后抓到的反而是"包装层撒谎"那一格（⇒ 队列 3d 已修） | 六族里现在只有"输入防抖"落地（§6.44）；其余五族判**保留自研**，改动需要新读数才动 |
| 7 | **暂缓（ defer 那一格已升级为直接替换，见 §6.44；`shouldRunThrottled` 那一格的判定 §6.55 又加固一次）** | `VirtualList.vue`、`utils/defer.ts` 里剩下的 `shouldRunThrottled`、`longPress`/`lightboxGestures`、`shortcuts` | `shouldRunThrottled` 是"拿调用方给的两个时间戳判该不该跑"的纯函数（`windowLaunch` 用它，且要能被 `node --test` 直测）⇒ VueUse 的 `useThrottleFn` 是绑作用域的节流器、给不了这个形状；§6.55 把这条从"我说的"变成"数出来的"：4 个调用点里有一处要的是**同一份墙上时钟预算跨两个出口**（移动端 CSS 抖与桌面搬 OS 窗口共账 `lastShakeAt`），绑作用域的节流器结构上给不了共享额度；其余各有实测语义或库给不了的部分 | §6.55：`defer.test.ts` 第 12 条钉"手写时间差闸门不许长回第二份"（现扫 + 4 条正控 + 分母下限），一次单点变异当场红并点名文件 |
| 10 | **P3 待依赖面** | 「复制失败要不要真做」——@vueuse/core 14.4.0 的 `copy()` 根本没有失败信号（async 分支 `catch` 后转 legacy、`execCommand` 返回值被丢、之后无条件 `copied=true`）⇒ 要做得换写入路径，或自己实现 execCommand 判定 | 上一批（§6.40）把撒谎的签名改成了诚实；**不许**在包装层里假装给出依赖给不了的东西 | 需要真机读数（Android 无 `navigator.clipboard` 那条路）才能定取舍 |
| 11 | **P1 待真机读数**（① 已完成 ⇒ §6.44） | ① ~~`ChatSearchDialog.vue` 的输入防抖~~ 已并回库（`useDebounceFn`，那两条额外语义原样保住：空关键词立即清 + `props.open` 到点复查）；② 长按容差不一致（`MessageItem` 12px vs 两个列表项 10px、`MessageReactionBar` 450ms 且无容差）仍挂着 | ② 是「一个能力几种写法」，但**合并要先定哪个才是实测值** —— 凭代码猜出来的容差会把已钉住的手感换掉 | ① 的等价性用假定时器真值表 + 探针 `search` 段现算证过（§6.44）；② 需要真机拇指读数，探针点不到「长按 500ms + 位移」这种手势 |
| 12 | ~~P0/P1~~ **已完成（见 §6.43）** | DOM 监听的"注册 ↔ 解绑"配对：全仓 `.vue` 19 处逐格读完，只动手真正摘不掉的那 6 处（根组件 4 + store setup 2）；其余 19 处判**保留自研**并写下理由 | 匿名处理器**结构上**没有 remove 的句柄，组件重挂一次多一份闭包 + 多打一次 IPC；这类退化不报错、只在偶发重复里露头 | 新判据 1 条（`designGuards.test.ts`，内联处理器 / 未配对 add 两形状 + 两条分母下限），两次单点变异各点名到文件；`npm test` **1073/1073**、快速层 **17/17**、`verify-guards --only 文本选择` **1/1**（本批改形状时被第 10 步锚点核对当场拦下一次，锚点已跟着改）；真窗口右键行为 **NOT RUN** |
| 13 | ~~P1~~ **已完成（见 §6.44）** | 输入去抖 + 延迟镜像这两格从自研并回 `@vueuse/core@14.4.0`（`useDebounceFn` / `refDebounced`）：删掉 `defer.ts` 里的 `Debounced` + `debounce`（该文件 93 → **54** 行）与整册 `composables/useDeferredRef.ts`(31)，6 个调用点直接叫库；120ms 那一档收进 `defer.ts` 的 `INPUT_DEFER_MS` 一个家（库的默认是 200ms ⇒ 每格显式传） | `useDeferredRef` 只是自研 `debounce` 上面的一层包装，正是「库能用 + 原实现和包装都留着」那一格；两档语义（原值即时 / 派生延迟）库用 `refDebounced` 直接给 | 动手前用**同一套假定时器**现量六条语义全等（尾沿取最后一次、`cancel` 丢弃、`flush` 立即且不再补、空待执行时 `flush` 空操作、镜像初始读原值且窗口后落新值、作用域关闭后不回写）；`npm test` **1073/1073**、快速层 **17/17**、探针 `search`+`logs` **23/23**；三次单点变异各红一次（摘一条 `persistSoon.flush()` ⇒ 计数判据红；`LogViewer` 改回读原值 ⇒ 接线判据红；真值表那条换成不去抖的直通 ⇒ 语义判据红），三次都由 `/tmp` 备份恢复并 `diff -q` 核对后复绿 |
| 14 | ~~P3~~ **已完成（见 §6.45）** | 给"延迟镜像"这一档补**真 DOM 读数**：探针新增 `--only=friendfilter` 4 条（种 3 个对端 → 打字 → 在 50ms / 300ms 两个时刻分别读"输入框的值"与"列表行数"） | §6.44 换了 4 件用这一档的组件，其中三件在探针里**没有挂载段** ⇒ 那批只有静态证据；而这类接线退化后界面完全正常，只有连发粘贴才卡 | 一次单点变异（把派生改回读原值）⇒ 该段 **2/4 红**、红的正是那两条时间判据，`/tmp` 备份恢复 + `diff -q` 后 4/4。⚠️ 顺带修掉一条**我自己写空的判据**：第一版在"同一次页面求值里同步读 DOM"，那对接不接镜像都必然读到旧 DOM（Vue 的渲染排在微任务）⇒ 取样时刻必须落在"渲染已落地、时间窗还没到"那条缝里（这里 50ms，两边各留 ~16ms / ~70ms）|
| 15 | ~~P1~~ **已完成（见 §6.46）** | 跨边界存储键名：首屏脚本的 4 个裸字面量 ↔ TS 侧 11 个具名 `*_KEY` 常量**现算比对**；`ResponsiveLayout.vue` 那 2 处裸字面量具名成 `LIST_W_KEY`；顺带修掉首屏注释里两个**不存在**的符号名 | 键名有两种载体而两边都没有对方 ⇒ 漂移是静默的：脚本读了没人写的键，vue-tsc / 构建 / 探针全绿，只有首帧外观与语言错 | `appearance.test.ts` 11 → **13 条**（正向四角色比对 + 反查孤儿键 + 缺席型"生产码零裸字面量键"并自带 matcher 正控，三条各挂分母下限）。**三次红**：改 `THEME_KEY` 值 ⇒ 1 红并印出两边当前值；我自己在 `ResponsiveLayout` 只改读未改写 ⇒ 缺席判据当场点名那本；把注释改回不存在的 `APPEARANCE_KEY` ⇒ 符号判据 1 红。恢复均 `diff -q` 核对；`npm test` **1075/1075**、快速层 **17/17 19.3s**、`version:check` 与 Change Budget 各 exit 0（现读版本 5.0.35） |
| 17 | ~~P0/P1~~ **已完成（见 §6.47）** | 首帧语言那一格：脚本那份 `detectSystemLocale` 与 `i18n` 补**逐例对照**，顺带修掉抓到的一处真实分歧（`languages` 全不命中时脚本不再看 `navigator.language` ⇒ 中文系统骨架先英文） | 这一族的漂移只在启动那一瞬可见，编译期与探针都看不见；而它是"保留自研的第二份实现"最该有判据的一格 | `appearance.test.ts` 13 → **16/16**（九例语言矩阵 + 标题两支 + 五份窗口 HTML 的 `data-title-*` 齐备；期望值全走 i18n 公开 API）；两次单点变异各红一次（摘兜底 ⇒ 点名 `languages=["ja-JP"] language=zh-CN → 脚本=en-US，i18n=zh-CN`；标题只取中文支 ⇒ 红）；`npm test` **1078/1078**、`npm run build`（含 vue-tsc）exit 0。⚠️ 这批**第一版判据是空转的**：脚本与 i18n 共用同一个替身 `el`，先跑脚本、后调 i18n、再读 `el.lang` ⇒ 读到的一定是 i18n 自己写的值；改成"跑完脚本立刻取快照"才红。快速层第 9 步当时被并行会话的 `verify-guards.py` 语法错误挡住（不是本轮代码） |
| 18 | ~~P3~~ **已完成（见 §6.48）** | 把"延迟镜像"三格挂载段合用一套时间阶梯（`mirrorLadder` + 种 store 前置 `mirrorSeed`），补上 `ForwardModal` 与 `ConversationList` 通讯录过滤两格 | §6.44 换的四件组件里还有两件只有静态证据；而"共用同一件能力"正是单点退化最容易漏的一型 —— 一格接线坏了，另两格照绿 | 探针段数 37 → **39**（现算 `grep -c 'want("' `）；`--only=friendfilter,forwardfilter,contactfilter` 改前 **12/12**、复原后 **12/12**；**一次改三格**（派生都改回读原值）⇒ **恰好 6 条红、每段红的都是那两条时间判据**，三处 `diff -q` 核对复原；收尾全量探针 **424/424、exit 0** |
| 19 | ~~P1~~ **已完成（见 §6.49）** | 主题色三档派生（hover / active / light）从「JS 算一份 + CSS 硬编一份兜底」收敛成 CSS `color-mix()` 一份；`applyTheme` 只写主色与字体，`lighten`/`darken`/`mix` 随本批删除 | 两份实现连比例都不一样，而首屏脚本只写得到主色 ⇒ store 起来之前「按钮已是用户色、hover 与半透明选中底还是出厂蓝」——真实的第一帧缺陷，不是整洁偏好 | `npm test` **1078/1078**、新增探针段 `--only=accent` **6/6**（含取色器自身的合成正控）、快速层 **17/17、39.8s**、`npm run build` exit 0；三次单点变异各红一次（兜底改回硬编 `#2563eb` ⇒ 探针 active 条红；`applyTheme` 重新 inline 写 hover ⇒ 单测那条红；active 混向改成朝白 ⇒ 真实样式表契约红并印出 `= 2.98 < 4.5`）；两次判据空转都被自己抓出来（`color-mix` 的 computed 回的是 `color(srgb …)` 不是 `rgb()`；「inline 里没有派生档」在没有 Tauri 的探针页里恒绿） |
| 20 | ~~P1~~ **已完成（见 §6.50）** | 字体接进首帧：首屏脚本读 `FONT_KEY` 并写 `--gosslan-font-family`，骨架改 `var(--gosslan-font-family, <兜底栈>)`，`applyTheme` 删掉 JS 兜底串（默认档清内联） | 这与 2026-09-21 那条"骨架永远蓝色"是**同一族**缺陷，当年只修了主色那一半；默认栈原本四处各抄一份 （token / JS 兜底 / 骨架写死 / 选项字面量）| `npm test` **1080/1080**（+2）；探针 `accent` 段 6 → **7 条、7/7**；快速层 **17/17、59.9s**；build exit 0；文档门与 change-budget 各 exit 0。**一次改三处 ⇒ 恰好 3 条红**（首屏不写 / 骨架写死 / JS 又抄兜底），三处 `diff -q` 复原。⚠️ 第一版把两次 `applyTheme` 放在同一个 `try/finally` 外，第二次跑在没有 `document` 的环境 ⇒ 红得像产品坏了，其实是替身生命周期写错 |
| 21 | ~~P1~~ **已完成（见 §6.51）** | 查清「两处长按容差不一致」这条待办：**不是缺陷**（两处用的是不同的取消路径，各自成立），代码不动；把它那条隐含前提补成判据 —— 胶囊长按的 `pointerup` / `pointercancel` / `pointerleave` 三个取消出口必须成对在位、起点数与 cancel 数一对一、卸载摘表 | 第二种方案靠浏览器发 `pointercancel` 才成立；少一个出口的失效形状是「在胶囊上竖向滑动 ⇒ 450ms 后名单自己弹出来」，只有真机看得见，而此前没有任何判据（⚠️ §6.53 实测更正：这个形状要 `pointercancel` 与 `pointerleave` 两个出口**一起少**才成立，只摘一个时真浏览器里结果不变） | `longPress.test.ts` 8 → **9/9**（含合成正控）；删掉 `@pointercancel` 那一行 ⇒ 该条红并点名出口，`diff -q` 复原后复绿；`npm test` **1081/1081**、快速层 **17/17 exit 0**；§6.50 收尾全量探针 **431/431、exit 0**（40 段） |
| 22 | ~~P1/P3~~ **已完成（见 §6.52）** | 动效族里唯一 CSS 管不着的那个出口（桌面 `api.shakeWindow()` —— Rust 连发 7 次 `set_position` 搬整扇 OS 窗口）补上系统「减弱动态效果」闸；顺带把这条媒体查询从 `haptics.ts` 的私有实现收进 `utils/platform.ts` 一个家，两家共用 | 同一个 OS 开关原来只接住了四处里的三处（CSS 全局降级、骨架呼吸、触觉），最响的那一处不接 ⇒ 对动效敏感的用户按一下别人的「抖动」按钮，整扇窗自己被搬走，而编译、门禁、探针全都不说话 | `npm test` **1081 → 1085/1085**（新增 4 条：纯函数两方向、查询串只有一个家、触觉两方向、抖窗闸在调用之前）；快速层 **17/17、32.1s**（含 vue-tsc + build）；**收尾全量探针复跑 **431/431、exit 0**（40 段，跑的是本批之后的树）；三次单点变异各红一次**（摘掉 store 的闸 ⇒ 那条接线判据红；haptics 改回自己手抄查询串 ⇒ 「只有一个家」红并点名文件；`prefersReducedMotionByMedia` 判成恒 false ⇒ 触觉与纯函数两条一起红），三处 `diff -q` 核对复原。⚠️ 第一次跑变异用 `NODE="node --test …"` 变量代替整条命令，zsh 不拆词 ⇒ 三次全是 exit 127（command not found），**看着像"没红"其实是根本没跑**；改成每条命令写全才有上面那三份读数 |
| 23 | ~~P0/P3~~ **已完成（见 §6.53）** | 先更正 §6.51 写下的一句错话（「本仓探针没有 CDP 触摸能力」——`check-ui-runtime.mjs:4350` 一直在派发真触摸），再把那句里「只能真机验」的那一格补成运行时判据：从胶囊起手竖向滑动 ⇒ 长按计时器必须被取消、名单不许弹；三条里含**前提自证**（这台浏览器确实发了 cancel）与**反控**（同坐标按住不动仍会弹） | 那条隐含前提是「滚动会抢走这次触摸」；它此前被判成无判据，其实是我自己没去读探针就下的结论 —— 判据能加在原地上，不该欠着 | `--only=touchroster` **9/9、exit 0**（段内 6 → 9）；**两轮变异各证一次**：只摘 `@pointercancel` ⇒ 静态那条红、**运行时那条照绿**；把 `@pointercancel` 与 `@pointerleave` 一起摘 ⇒ 运行时那条**当场红**并印出 `afterScroll=true cancel={"pointer":1,"touch":0}`；`diff -q` 复原后 9/9。⚠️ 由此**推翻 §6.51 写的失效形状**：这条用户可见结果由**两个冗余出口共守**，少一个不成立；应用码一字未动；本批没跑全量探针，**§6.55 收尾那次全量实测 434/434、exit 0（= 431 + 本段 3 条）** |
| 24 | ~~P3~~ **已完成（见 §6.54，无码改动）** | 「无用导出」这一轴机器数完（832 个导出符号分三桶）：**A 桶只剩 2 格**且在 dev 脚本里（并行会话地界 + 删了换不到读数）；B 桶 92 格死的只是 `export` 这个字（纯机械、无用户可见或判据可见收益 ⇒ 判为不做）；C 桶 145 格逐格抽读后是**测试面 API**（护栏用例入口、策略常量由测试对账）| 目标里 P3 明写「删除无用导出」，而这一轴的存量此前只有印象没有数；不数就会一直挂着一条空转工单 | 复跑 `node /tmp/unused-bucket.mjs` ⇒ exported=832 / A=2 / B=92 / C=145。⚠️ 口径：脚本报的「零引用」只是「去读它」，A 与 C 在脚本里长得一样，要靠读代码分开（测试面 API ≠ 死码）。应用码一字未动；`npm test` **1085/1085**、三道文档门 + change-budget 各 exit 0 |
| 25 | ~~P1/P3~~ **已完成（见 §6.55）** | 「至少隔 N 毫秒才放行」这一族先数完（13 处）再动手：**5 份是同一个限流闸的手写复制**（含 `useChatStore` 在同一个 `lastShakeAt` 上的两份逐字复制）⇒ 全部并回 `utils/defer.ts` 的 `shouldRunThrottled`，抖动那两份合成 `claimShakeSlot()`，裸 `1500` 提成 `HISTORY_RELOAD_MIN_INTERVAL_MS`；另 **6 处形状像但语义相反**（要"最近 N 毫秒之内"或"超过 N 就过期"）逐格写明理由保留，2 处属另一件事（消息时间分割线按 `ts` 差算，不碰墙上时钟） | 同一条规则五处各写一遍 ⇒ 改边界要改五处，而"两种抖动共享同一份预算"这个不变量原先没有唯一定义处；更危险的是把反义的那 6 处也一起并家会把意思写反 | `npm test` **1085 → 1086/1086**（新增 `defer.test.ts` 第 12 条：现扫时间差比较 + 4 条已知写法正控 + 分母下限 + 反向"至少 3 份生产文件真在用那个家"）；快速层 **17/17、20.6s exit 0**；**收尾全量探针 434/434、exit 0**（40 段，跑的是本批之后的树）；一次单点变异（在 `appActions.ts` 手写一道闸门）当场红并点名文件，`diff -q` 复原。⚠️ 本批自己踩的：python 批量脚本中途 `TypeError` ⇒ **前半替换只在内存没落盘**，`MessageComposer` 成了"调用没 import"，`npm test` 全绿抓不到（`node --test` 不做 `.vue` 类型检查），是快速层第 17 步 `vue-tsc` 报出来的 ⇒ 脚本式补丁每处替换单独 assert 且立刻落盘、改完必跑类型检查（详见 §6.55）|
| 27 | ~~P1~~ **已完成（见 §6.56）** | 搜索的日期筛选 `dateRangeFor` 把"一天"当 `86_400_000` 毫秒：拆年/月/日求零点后用固定毫秒减法求「昨天 / 近 7 天 / 近 30 天」⇒ 夏令时时区在切换日的**次日**边界差一小时；改走已装的 `dayjs`（`startOf("day").subtract(N,"day")`）。同族再扫 `setHours(` / `getDay()` / `Math.floor(…86` / `toDateString()` ⇒ **零命中**；`todos.ts` 的"满 N 天"与 `logFilter.ts` 的环形秒差语义不是日历日 ⇒ **不改**并写明理由 | 本机（中国无夏令时）永远复现不了 ⇒ 从写下那天起就一直错着。更硬的一条：**同一个「昨天」本仓有两种算法**（`utils/time.ts` 用日历法、这里用固定毫秒），列表标「昨天」的消息在搜索选「昨天」可能筛不到 —— 目标 C 档的"同一份数据两种口径"，只不过口径是**算法**不是状态源 | **先红后绿**：新用例改实现之前跑就红（打印 `差 3600000 ms`），改后 `chatSearch.test.ts` 5/5；四条边界各自能红（`/tmp/dst-discriminate.mjs` 现算：回拨日次日三条各 +3 600 000、拨前日次日那条 −3 600 000；"今天"那条抓不到 ⇒ 明确标成对照）；测试自带时区正控（`getTimezoneOffset()` 必须 300）并把 `process.env.TZ` 在 `finally` 还原；老用例的期望值从"零点减 N 天毫秒"改写成"本地日历日"。`npm test` **1086 → 1087/1087**、快速层 **17/17、26.5s exit 0**、探针 `search` 段 **18/18**。**Rust 侧同族也数完**（现算 `grep -rn "86_400\|86400" src-tauri/src` = 12 命中，逐格读语义）：`export.rs` 的 `format_local_time` 是唯一对夏令时敏感的一处，而它**头注释早已写明**（偏移由前端 `getTimezoneOffset()` 给一个值 ⇒ 跨切换日的历史消息可能差 1 小时，导出功能接受但不假装精确）；`logging.rs` 两处明写 UTC；`relay.rs` 那处是**协议日 key**（动它=改线上语义）；`cache_cleaner.rs`/`offline_queue.rs` 是保留时长。⇒ 无待修项，且这一族在两端都数完了 |
| 29 | ~~P3~~ **已完成（见 §6.57，无码改动）** | 「只为绕过问题而存在的兼容层 + 类型逃生口」这一族机器数完：`@ts-ignore`/`@ts-expect-error`/`eslint-disable` 全 **0**；`as any` 2（VirtualList 键兜底）、`as unknown as` 2（peerMerge 通用合并形状）、非空断言 6（5 处由上一行 early-return 把住、2 处在 `try` 里 ⇒ **没有一处能抛到界面外**）、`legacy` 系 9 行（VueUse 官方开关 / vue-i18n composition mode / `LEGACY_DARK_STORAGE_KEY` 的"读一次+立刻删键"迁移形状）、环境嗅探 7（`node --test` 直连 utils 的结构性必要）、`TODO`/`FIXME`/`HACK`/`@deprecated` 全 **0** | 目标 P3 那句除死代码外还点名"兼容层"，而这一格的存量此前只有印象没有数；**判"兼容层是不是债"看形状不是年龄** —— 读一次就删键的是迁移，每次读都走 legacy 分支的才是债 | 复跑 `node /tmp/escape-scan.mjs` + `node /tmp/shim-scan.mjs` ⇒ 上面每个数。**故意不加棘轮**（理由与 §6.55 那条为什么该写形成对照，写在 §6.57）：新加一处 `foo!.bar` 而 `foo` 真为 null 会当场抛 `TypeError`、面板白掉 ⇒ 响亮失败，棘轮只拦得住自己会喊的东西、却长期拦住合法写法。应用码一字未动 |
| 30 | ~~P1/A 档~~ **已复核 → 判定"不该迁"（见 §6.58，无码改动）** | A 档「浮层 / 提示」的剩余存量数完：Reka `Popover*`/`HoverCard*` **8 处 / 4 本**（已迁的那批）；Reka `Tooltip*` **0**；原生 `title=` 273 行 / 62 本（元素级 **195** 处）；手搓悬停浮层 **1**（`MessageReactionBar` 触摸 reveal，§6.51–6.53 已判）；手搓 `z-index: 9xxx` **0** | 195 处原生 title **不迁** Reka Tooltip，三条实测/口径理由：① 原生 title 是**平台**轮子不是自研轮子（摆位/延迟/聚焦显示浏览器已做好且不占本仓 JS）；② 换过去每处要包 Trigger/Content + Provider，显示时长反而变成本仓要定的事，而触摸端原生 title 本就不显示、Reka 也不会自动在手机上变好；③ 可访问名已由 `aria-label`/内容承担（现算缺口 **0**）| ⚠️ **本批最大收获是量具**：第一版按行匹配报「171 处缺可访问名」，改成按**起始标签整块属性**解析（`/<(div\|span\|button\|a\|li\|td\|th\|p)\b([^>]*?)>/gs`）后 = 1 处，而那 1 处是 `v-html`（解析期无文本、AT 读得到）⇒ 真缺口 **0**。**模板类判据一律按元素解析不按行**（这是"解析期看不见内容"的第三个已知形状，前两个：`git grep` 行式把跨行调用数成 0、`include!` 拆册让锚点不唯一）。复跑 `node /tmp/overlay-scan.mjs` + `node /tmp/title-a11y2.mjs`。**§6.55–§6.58 四批的收尾全量探针 434/434、exit 0（40 段，跑的是 §6.58 之后的树）** |
| 31 | ~~P0/P1~~ **已完成（见 §6.59）** | E 档「Tauri 事件订阅 ↔ 卸载」第一次数：生产码 **8 处订阅 / 5 本组件**，这一族当时有 **4 个家**（`ChatWindow`、`GroupTodosWindow`、`PreviewWindow` 各写一份「迟到就当场取消」的守卫，`TitleBar` 两处**根本没写**）⇒ 全部并回已有的 `utils/initScope`（它头注释早就写着这条竞态与解法）；`GroupTasksBoard` 随草稿开关起伏，改成"每轮一个 scope"（异常分支清空，否则一次注册失败锁死后续所有轮次） | `listen()` 拿卸载函数要等一次 IPC 往返：卸载若发生在往返途中，赋值落在清理**之后** ⇒ 取消函数永远没人调用，监听留在窗口上继续跑一份绑着已丢弃 state 的闭包。后果可见的一格：`GroupTasksBoard` 留下的拖放 handler 会翻 `app.boardDropActive`，而 `ChatWindow.canDropInto()` 正是读它决定"拖进来的文件算任务还是算聊天附件" | `npm test` **1087 → 1088/1088**（+1 判据 ㊷）、快速层 **17/17、21.9s exit 0**、四道文档门 + change-budget 各 exit 0；新守卫一次单点变异红并点名文件（塞回一行手工 `let unlistenProbe` ⇒ `GroupTasksBoard.vue: 手工 unlisten 句柄`）；旧那条贴形状的 `titleBarIcons` 判据迁移后红 ⇒ **换成贴语义的两条**（注册进 scope + 卸载拆 scope），两条各用一次单点变异证能红、`diff -q` 复原后 7/7。组件码净 **−16 行**（−83/+67），手写守卫 3 份 → 0；收尾全量探针 **434/434、exit 0**（40 段，跑的是本批之后的树）。⚠️ **NOT RUN**：真鼠标拖放与"秒关辅助窗"两格没有运行时证据（都要人手赶一个瞬时窗口）；本批另记一条自伤：脚本替换时把整行新内容拼到"只含行首几列"的锚点上，将相邻一行的开头吞掉 ⇒ **改表格行要按整行替换并复看 `git diff`** |
| 32 | ~~P1~~ **已完成（见 §6.60）** | 判据 ㊷ 自己的两处漏：句柄 matcher 按变量名前缀 + 单函数类型认，于是漏掉 `ConversationList` 的 `let disposeFocusSearch`（名字不对）与 `ResponsiveLayout` 的 `let unlistenMenu: UnlistenFn[]`（类型是数组）。两份手抄守卫并回 `initScope`（后者正是「迟到的注册」本人：`void bindMenuEvents().then(fns => unlistenMenu = fns)`）；同轮数完另两条轴：非 `.vue` 生产码 12 处 DOM 监听（**0 泄漏**，模块级 `installed` 闸门结构性不累积 ⇒ 不加判据）、丢弃订阅返回值的形状（生产码 0 处 ⇒ 不加判据） | 判据按名字认句柄＝只覆盖碰巧起对名字的那几处；而「按类型形状全收」当场误伤两处**滚动句柄**（`release`、`groupTodosUnlisten`），那两处的家是 `StaleGuard` 不是 `initScope` ⇒ 判据收到两个信号并把它们写成反控 | `npm test` **1088/1088**（㊷ 是加宽不是新增）、`designGuards` 单册 **155/155**、快速层 **17/17、21.9s exit 0**；**两次单点变异各点名自己的文件**（塞回 `let disposeFocusSearch` ⇒ ConversationList 红；塞回 `let unlistenMenu: UnlistenFn[]` ⇒ ResponsiveLayout 红），各自 `diff -q` 复原；反向下限 6 → 8（实测 10 份消费者）；组件码 **−4 行**；收尾全量探针 **434/434、exit 0**（40 段，跑的是本批之后的树）。⚠️ **NOT RUN**：macOS 菜单在「布局重挂后只执行一遍」没有运行时证据 —— 现网 `<ResponsiveLayout />` 没有 `v-if`（只有 HMR/分支切换能触发重挂），所以这条判**形状不合家 + 迟到竞态未接住**，不写用户可见现象 |
| 33 | ~~P1~~ **已完成（见 §6.61）** | 定时器轴接着数：自研 `sleep` 2 份（`MergeCardModal` 私有 helper + `useAppStore` 内联 2000ms）⇒ 并进 `utils/defer.ts` 一个家；`setTimeout(fn, 0)` 当「等这一拍」用 2 处（`StorageSection` 回显时按住自动落库）⇒ 换 Vue 的 `nextTick`，第 3 处 `useChatStore.ts:684` 是**宏任务边界**的批量冲刷、语义不是同一件事 ⇒ 保留并写明 | 成熟库优先评估先做**在库里的实测**而不是印象：`@vueuse/core@14.4.0`/`@vueuse/shared` 的 `dist/index.d.ts` grep `sleep` 各 **0 命中** ⇒ 没有可换的东西，就不许为了「多用一个库」再包一层；而 `nextTick` 是平台已有能力、全仓 10 份文件已在用 ⇒ 「同一个词两种写法」这一型要靠现扫分母才看得见 | `npm test` **1088 → 1090/1090**（`defer.test.ts` 12 → 14：行为层「499ms 不许醒」+ 绑定层「手抄 sleep 只有 defer 一个家」带 2 条正控与反向钉 ≥2 份消费者）、快速层 **17/17、20.1s exit 0**；两次单点变异各红自己那一条（`sleep` 改成 `Promise.resolve()` ⇒ 行为层红并印出 499ms 那句；塞回 `sleepLocal` ⇒ 绑定层点名 `MergeCardModal`），`diff -q` 复原后 14/14。收尾全量探针 **434/434、exit 0**（40 段，跑的是本批之后的树）。⚠️ **NOT RUN**：「回显不再触发自动落库确认弹窗」在真设置页改保留天数那一发没有机器凭据（`nextTick` 比 `setTimeout(…,0)` 早一拍，这一拍差要真机看）|
| 34 | ~~P1~~ **已完成（见 §6.62）** | 现算 `15 * 1024 * 1024` 的全部落点：前端 3 份（`filePreview.ts:74`、`favoritePreview.ts:26`、`MergeCardModal.vue:41`）+ Rust 3 处 `.min(...)`（`helpers.rs:246`、`favorites.rs:246/314`）；前端收成 `IMAGE_PREVIEW_MAX_BYTES` 一个家（两处消费方改 import），Rust 侧**本批不收常**（要动 `src-tauri/**`：cargo 门禁 + 档位 + 版本清单，且会新造一个跨命令模块的公共导出面 ⇒ 交后端那条线按自己节奏做，同值已由判据钉住）；顺带去掉全仓唯一的裸 `1048576`（`StorageSection.vue:62/109` 改 `(1024 * 1024)`，不新增导出） | §6.39 那条「手抄数字 + TS↔Rust 对账」当时只办了文本长度一维；预览上限是同一族的另一维，坏起来是安静的（前端要 20MiB、后端悄悄截到 15MiB ⇒ 用户只见「这张图点开少一截」，没有异常）| `imageBytes.test.ts` 8 → **9 条**（两侧都从**源码文本**现读现算 —— 不能 import：`filePreview.ts` 要 `@/api`，`node --test` 解析不了 `@/` 别名 ⇒ 判据只能当文本量具）；**三发单点变异各红各的那一条**（Rust 改 16MiB ⇒ 打印 `TS 15728640 vs Rust 16777216`；前端塞回一份手抄 ⇒ 点名 `favoritePreview.ts`；Rust 两处改写成 matcher 不认的 `15_728_640` ⇒ 分母红「只认出 1 处（实测 3）」），三处 `diff -q` 复原；`npm test` **1090 → 1091/1091**、快速层 **17/17、19.7s exit 0**、收尾全量探针 **434/434、exit 0**（40 段，跑的是本批之后的树）。⚠️ 第一次跑快速层在第 5 步 **db 锁作用域守卫** 以 `ENOENT stat logging.rs.tmp.<pid>` 失败（并行会话原子写的临时文件在同一次扫描中消失）—— 同命令复跑绿，根因是那条守卫缺 `ENOENT` 容错，属今晚 J2 线新加的工具，**本批不动它**、只记复现条件。⚠️ 收尾探针**第一次**尝试读到 `✗ 82/86`（4 条红全在 `files` 段、`window.__gf.emit is not a function`），同一棵树 `--only=files` 复跑 **10/10 exit 0** —— 那时 `check-ui-runtime.mjs` 与 `GroupFilesPanel.vue` 都是并行会话的未提交 `M`，而探针是**边跑边 `import('/src/…')`**（`check-ui-runtime.mjs:974/994`），并行写入会让后面几段读到另一份实现 ⇒ 与上面那次 `ENOENT` 同根因；纪律补一条：**跑探针期间自己也不改 `src/**`**。⚠️ **NOT RUN**：真实点开一张 15–20 MiB 的图（要两侧同改才看得见钳制行为）|
| 35 | ~~P1~~ **已完成（见 §6.63）** | 把「跨文件同名同值常量」这一**整轴**数完（205 份生产文件 / 151 个数值常量声明位点 ⇒ 5 组），落到实处的只有 `TIME_DIVIDER_GAP`：两份手抄的 5 分钟阈值 + 两处各写一遍的判定 `!prev \|\| ts - prev.ts >= 阈值`，全部收进 `previewMetrics.TIME_DIVIDER_GAP` + `shouldShowTimeDivider(ts, prevTs)`；空值口径收成 `prevTs == null`（`!prevTs` 会把 `ts===0` 当首条）；顺手清掉两处与代码矛盾的注释（「时间行恒显示」） | 这一格正躺在本仓自己写的契约怀里 —— `messageHeight.ts`/`previewMetrics.ts` 两份头部都明写「两边必须来自同一套常量与**同一个判断函数**，否则相邻消息会互相遮挡」，同族另外两格（㉞ 图片高度、㊳ 可见张数）都有判据，**只有它既抄了两份又没人管**；而且分割行自己占 32px，改一边不红任何测试，坏起来只在「间隔恰好跨阈值」那几条上出现 | 轴是整轴数的不是挑的：5 组里 2 组是扫描器误报（`bytes = new Uint8Array(raw)` 是局部变量、`reloadToken = ref(0)` 是响应式状态）、2 组已被 §6.51/行 11② 判为「等真机拇指读数」⇒ 不重开；判据 ㊸（`designGuards` 155 → **157**）带夹具正控 3 + 反控 4 + 真实树现扫 205 份违规 0 + 反向 importers ≥ 2；**三发单点变异各红各的那一条**（「又声明了一份阈值」/「自己写了一遍间隔比较」/家的空值口径那一行），三处 `diff -q` 复原；`designGuards` **157/157 exit 0**、`npm run build`（vue-tsc+vite）**exit 0**、收尾全量探针 **434/434 exit 0**、四道文档门 + change-budget 各 **exit 0**。⚠️ `npm test` **1093 条里 2 条红**，都在 `mapContract.test.ts` 且点名 `get_log_diagnostics`/`export_diagnostics_bundle` —— 现算这两个名字只存在于三份并行会话的 `M` 文件（`src/api/index.ts`、`src-tauri/src/lib.rs`、`src-tauri/src/commands/logs.rs`），本批一行没碰 ⇒ 那条诊断线自己的收尾；连带 `npm run verify` 在这步 fail-fast、构建步没跑到 ⇒ 本批构建证据由 `npm run build` 直接取。`check-test-manifest` **exit 1** 同理是 Rust 侧此刻编译不过（`logging.rs` 19 条 `E0599`）。⚠️ **NOT RUN**：「间隔恰好跨阈值时渲染这一行 == 估高那 32px」没有凭据 —— 探针里 `[data-time-divider]` 只有语言档那一处、且挂的是单条消息（`prev` 为空 ⇒ 恒出）。**⇒ 这一格已由行 37（§6.65）补成运行时凭据**：实测估高差 32 vs 画出差 32.5 |
| 36 | ~~P1~~ **已完成（见 §6.64）** | 昵称行那条规则：估算端 `isGroup && sender !== selfId && !isTipKind(kind)`、渲染端 `isGroup && !mine` ⇒ 并成 `messageKinds.shouldShowNickname(...)` 一个家，两侧改调用；`mine` 仍由各侧已有口径传入 ⇒ **不新增第三个 self-id 来源**；`MessageItem.vue`（并行会话的在飞文件）一字未动 | 读完实现才确认这**不是遮挡 bug**：提示行走 `MessageItem.vue:1102 v-if=isTip`、正文块在 `:1119 v-else` 里 ⇒ 昵称行结构上就不给提示行渲染，估算端那条 `!isTipKind` 正是把这个结构事实翻译成 18px。它坏的是**可定位性**：一条规则散在三处、靠模板分支暗合，哪天给提示行加来源标注就两边各走一半 | 判据写在 `messageKinds.test.ts` 那条既有的「提示行判定只有一个来源」上（册子仍 15 条）：真值表 5 格 + 「必须有会亮的格子」防空转 + 两端各必须出现 `shouldShowNickname(` 且不许再出现 `isTipKind(`。⚠️ **有一条断言改了口径并写明不是放宽**：原先断言 `messageHeight` 必须出现 `isTipKind(` —— 那是「抄本存在」的证据，现在不许再有抄本，撤销结构断言、同一语义改由真值表承担。三发单点变异各红各的一条（家摘掉 tip 闸门 → 真值表 `system` 那格 `true !== false`；估算端换回手写 → 点名估算端；渲染端退回少一条 → 点名渲染端），三处 `diff -q` 复原。`npm test` **1093/1093 exit 0**（这条链上整层第一次全绿：§6.63 记的那两条并行诊断线红，已被他们自己补上契约图与调用方）、`npm run build` **exit 0**、探针 **434/434 exit 0**（跑了三趟：第一趟 `CDP Runtime.evaluate 45 s 没回包`、第二趟被自己的残留挡在端口预检上 —— 先 `lsof -nP -iTCP:9444` 认出 pid 92683、ppid=1、起了 14 分钟正是第一趟那台，只 `kill -TERM` 这一台；**那道预检是唯一挡住「连到旧构建照样打绿」的东西，别想去放宽**）。⚠️ **NOT RUN**：真机「群聊里一条对方撤回，上下两条有没有错位」没有凭据 —— 探针那 11 处 nickname 里没有一处是消息行昵称的高度断言。**⇒ 高度这一半已由行 37（§6.65）补上**（群/单聊估高差 18 == 渲染端昵称行占位 18，逐像素对平）；**「撤回那条上下有没有错位」仍 NOT RUN** —— 它要的是撤回前后的同一列表状态，探针每次只挂一行、量不到「上下两条对齐」这个关系 |
| 37 | ~~P1~~ **已完成（见 §6.65）** | 把行 35/36 各自欠的那两条 NOT RUN 合成一格量掉：探针新增 `rowpair` 段（第 41 段），挂**两条**带 `ts` 差值的消息进真 `MessageItem`（`prev` 是既有 prop），四档间隔各挂一次（6min / 4min / **恰好 5min** / 5min−1s）判 `[data-time-divider]` 的出与不出；再断「`estimateMessageHeight` 两档之差 == 两次挂载根盒高之差」「群/单聊估高差 == 渲染端昵称行占的那一段」。**应用码一字未动**（判"不动那个常量"的三条理由写在 §6.65） | 「两边调用同一个判定函数」只证到判定层，而 `messageHeight.ts` 文件头那条契约说的是**占位**（"否则相邻消息互相遮挡"）—— 占位只有量矩形才知道。口径上刻意**只比差值、不把 32/18 抄进探针**：抄进去就是给那两个常量开第二个家，正是本专项在收的那一型错 | **实测**：`rowFar 80.5 / rowNear 48 / dividerBox 38.5 / estFar 100 / estNear 68` ⇒ **估高差 32 vs 画出差 32.5**（0.5px 低估，来源算清 = 38.5 − 正文块让出的 6）；昵称行 **18 == 18 逐像素对平**。**三发变异各点名各的那一条**：A 同批改 `TIME_DIVIDER`→40 与 `NICKNAME_ROW`→26 ⇒ 12/14，红两条配对、两条非空转照绿（且 `dRow` 仍 32.5 ⇒ 证它不跟估高端走）；B `>=`→`>` ⇒ 13/14，**只红边界那一格**；C 把探针自己的 `NEAR` 改成 6min ⇒ 12/14，红「4 分钟不画」+「非空转」而**配对那条反而绿**（`\|0−0\|<=1`）⇒ 由此定下一条口径：**配对类判据必须成对写**（一条断相等、一条断不是都为零）。三处 `diff -q` 复原；`--only=rowpair` **14/14 exit 0**、收尾全量 **448/448 exit 0**（41 段；`grep -c '= want('` 现算 40→41）、`npm test` **1093/1093 exit 0**、`npm run build` **exit 0** |
| 38 | ~~P0~~ **已完成（见 §6.66）** | 把「组件自造的 objectURL」这一轴数完（生产码 `URL.createObjectURL(` 现扫 **7 处 / 4 本**）：utils 那 4 处归 LRU 缓存所有（回收走 `blobLru` 注入出口，判据 ⑤ 已钉）、`ProfileSection` 那 1 处三条终局分支各回收一次且没有"取消"概念 ⇒ 都不动；`MergeCardModal` 那 2 处是**唯一同时具备「造 URL」与「取消标志」的一族**，其中 `pull()` 只在这次 `await readContentPreview` **之前**问了一次 `closed`、await 之后直接入账 ⇒ 弹窗关闭撞在这次往返上时那条 URL 永远没人回收（一张上限 15 MiB）。改法不是补一句 if：两处那 4 行「创建 → 问取消 → 回收或入账」收成组件内一个入账出口 `adoptUrl(url, stale?)`，顺带修掉 `probe` 「先 push 再判」留下的死账 | 「关掉一个弹窗」是这条链上唯一会让账本先清空、请求后回来的事件 ⇒ 晚到的那一张不是"暂时没显示"而是永久占内存；与 §6.59 那族「迟到的注册」同形，但这里的句柄是一个 blob URL、回收方是卸载钩子。同族两处复查不对称（快的 `probe` 有、慢的 `pull` 没有）正是最容易长期漏的一型 | 判据 **㊹**（`designGuards` 157 → **159**，全仓 **1093 → 1095**）：只判「同一本文件既有 createObjectURL 又有 closed/cancelled/disposed/unmounted 标志」那一类，要求 create 点数 == `adoptUrl(` 包住数 + 家的三个零件各一条断言 + 两条分母下限（create 点 ≥ 2、那一族 ≥ 1 本）；夹具正控 2 条就是本轮删掉的两种真写法、反控 3 条含「注释里提名字不许被数成调用点」。⚠️ 边界写进注释：这条判"有没有被包住"，**不判"回收有没有真的执行"**（要跑起来才知道，本批没有 IPC 桩）。两发单点变异各红各的一条（M1 换回裸写法 ⇒ 打印「造了 2 个 objectURL，只有 1 个走 adoptUrl」；M2 摘掉 `releaseUrl(url)` ⇒ 红「家不成立」而 M1 那条等式仍绿 ⇒ 两条判的不是同一个病），两处 `diff -q` 复原。`node --test …designGuards.test.ts` **159/159 exit 0**、`npm test` **1095/1095 exit 0**、`npm run build` **exit 0**（复原之后的树）。`MergeCardModal.vue` **+13/−9** |
| 39 | ~~P3~~ **已完成（见 §6.67）** | i18n 词典的**反向可达**这一轴数完并删掉尾巴：HEAD 两册各 1001 键（两册对称 0 差、`t()` 正向缺口 0 由既有三条判据早守着），反向数出 **41 条定义了却全仓引不到**的文案，中英各删 41 行 = **−82 行非业务文案码**、依赖零增减。来源就是「改名与删功能留下的尾巴」那一型：`settings.chatStyle.fontSize.{xs…xl}` 5 条（曾整体改名为 `chatStyle.fontSize.*`）、`friend.profile.*` 6 条、`diag.*` 5 条、`conv.toast.*` 3 条 | 既有三条判据全是**正向**的「调用点 → 词典」，没有一条问「词典 → 调用点」⇒ 死文案每条都要在中英两册各占一行，于是"这条还在用吗"从此没有答案，册子越留越不敢删。这一轴真正值钱的是**量具自己返工三次**：V1「任一种引号起、任一种引号止」报 41；V2 改成「同种引号成对」的**单遍**扫描报 **94** 条，而多出来那些（`logs.filter`、`common.clear`、`nav.me.online`）**正在用** —— `matchAll` 吃完整条 `"t('common.clear')"` 后从闭合引号之后接着走，被它包住的 `'…'` 永远成不了一次"起"，而本仓主流写法恰恰是 `:confirm-label="t('common.clear')"`（`src/components/settings/ResetSection.vue:108`）；V3 改成**三种引号各扫一遍** ⇒ 0 条。**方向要说清**：V1 报的 41 条是对的（漏算引用面只会让死文案显得更多），V2 才是会把在用文案删掉的那一版 ⇒ 定下口径：**缺席型判据换提取形状，必须重跑一遍存量** | 新增反向判据 + 一条引用面夹具（`src/i18n/index.test.ts` 现 19 条）：夹具钉「嵌套单引号里的 key 必须抠得出来」、查表常量 `ct(zo, "group.toast.nameEmpty", …)` 要认、跨行模板不许连坐。**第二个发现更隐蔽**：口径里"注释中的字面量也算引用面"会让**判据读自己的文档** —— 那条注释举例写了 ``t(`diag.${k}`)`` ⇒ 造出一个 `diag.` 前缀把**整族 `diag.*` 洗白**；例子已换成真在用的 ``t(`favorite.cardKind.${active.kind}`)``，边界写进注释。**三发单点变异各点名各的那一条**：M1 两册各加一条死文案 ⇒ 红「死文案」并点名它；M2 只往 zh 一册加 ⇒ 红「key 集合一致」（同轮「死文案」也红 ⇒ 两条判的不是同一个病）；M3 把 `QUOTES` 减到只剩双引号 ⇒ 红夹具并打印 `["t('nav.me.online')"]`；三处 `diff -q` 复原后再跑。删除集另走一条**独立复核**口径：41 条按精确引号 `git grep` 全仓（排除两册与 `docs/`）**0 引用**；7 条裸串命中的全是更长的键（`chat.selfChatTextOnly`、`msg.reactionAddEntry`、`todo.assigneesEmpty`、Rust 字段 `diag.selected_ip`）。读数：`node --test src/i18n/index.test.ts` **19/19 exit 0**（自打印 `词典 985 键 / 引用面 15588 个字面量 / 可达前缀 492 个 / 死文案 0`）、`npm test` **全绿 exit 0**（总条数由脚本自己打印，同棵树现算 1095→1097→1099，后两次涨的是并行会话新增）、`npm run build` **exit 0**。⚠️ 界面这一格按定义**没有可看的东西**（删的全是 0 引用条目）⇒ 真机复看不构成这一批的验收面，运行时体验凭据在行 37。⚠️ 另记一条操作纪律：词典条目**不是一行**（有 `"k":` 后值写在下一行、有三段 `"a" + "b" + "c",` 拼接），按行删 + "下一行不是键行就删"的孤儿清理把活键 `diag.connHealthHint` 吃了两段 ⇒ 中英两册按 `git show HEAD:` 逐字复原 |
| 40 | ~~P1~~ **已完成（见 §6.68）** | 主题令牌这一轴两个方向一起数完（判据自己打印：扫 305 份 / 消费点 1546 处 / 定义 76 个）⇒ 抓到 **8 处消费了一个从来没被定义的 `--gosslan-*`**：`--gosslan-text-3` 5 处（第三档灰从来没存在过 ⇒ 设置页分组标题+箭头、已读小勾、提醒受众弹窗两行说明一直在继承正文色）、`--gosslan-surface-2` 2 处（网络页两枚按钮的 `hover:bg-` 压根没画底色，只有 `transition` 在空转）、`--gosslan-link-ink` 1 处（带兜底 ⇒ 看着正常，但那层间接永远走不到）。全部改指在册的 `--gosslan-text-2` / `--gosslan-hover` / `--gosslan-primary`，**不新造任何档**（新色档要过对比度账，而这些点的语义就是既有的第二档） | 令牌名写在 Tailwind 任意值里 ⇒ **拼错一个字符不报任何错**：CSS 未定义变量在计算值阶段失效，`color` 退继承值、`background` 退初值，坏的样子是"该浅的地方不浅 / 悬停没反应"，只有那一处不对，没人会去查一个 class。这属"静默失败"那一档，正是护栏该管的那一类 | 判据 **㊺**（`designGuards` 159 → **161**）：只判 `--gosslan-` 命名空间（`--reka-toast-swipe-move-x` 这类库运行时给的归外部），要求每个消费点找得到定义；**定义面认三种形状**（CSS 声明 / 内联 `:style` 的字符串键 / `setProperty("…")`）—— 第一版只认 CSS 声明就把 `--gosslan-msg-size`（运行时写）和 `--gosslan-primary`（用户主题色）误判成没定义。**带兜底也算违规**并单发变异证明（N2：同一个坏名字加兜底 ⇒ 照红）；剥注释不能用现成的 `stripCommentsJs`（它按 `//[^\n]*` 砍行注释会连 `url(https://…)` 一起吃）⇒ 另写一把并把"不许砍掉协议地址"钉成反控。两发单点变异各红各的一条（N1 无兜底 ⇒ 点名 `gosslan-nope-xyz ← components/SettingsPanel.vue`；N2 带兜底 ⇒ 同红），两处 `diff -q` 复原。反向那一半**故意不判红**（排版标尺三档 + `--gosslan-mobile-tabbar-h` 是文档里写明等接线的基建，全仓另有 **265 处** `text-[13px]` 这类散值 ⇒ 一次迁进标尺是另一条轴、每处都是可见变化），改成"上限 6 只许变小 + 每轮点名 5 个"，并钉"白名单里的名字必须真有人在消费"。读数：`node --test src/utils/designGuards.test.ts` **161/161 exit 0**、`npm test` **全绿 exit 0**（收尾现算 1099，含并行会话新增）、`npm run build` **exit 0**、收尾全量 CDP 探针 **448/448 条判据绿、exit 0（`/tmp/probe-668.log`）**。⚠️ **要用户看一眼**：那 5 处该变浅灰、那 2 枚按钮该有悬停底色（深浅色各一遍）—— 探针没有针对取色的断言，颜色观感属真机那一档；`--gosslan-mobile-tabbar-h` 那一档已在 **§6.69 / 行 41** 接成单一令牌家（含「必须 rem」的单位口径），仍欠窄窗与 Android textZoom 真机读数。⚠️ 并行重叠：`ChatSearchDialog.vue` 动手前已是**已暂存**状态（工作树与索引当时逐字一致），本批只换第 506 行那一个令牌名，提交归属仍属他们那一笔 |
| 41 | ~~P1~~ **已完成（见 §6.69）** | 移动端底栏的**占位高度**收成一家：全仓生产码 `pb-[calc(` 形状现数恰好 2 处（`ResponsiveLayout` 主内容区、`ConversationList` 列表），两处都手抄同一串 `4rem`，而 `--gosslan-mobile-tabbar-h: 64px` 定义了却没人读 ⇒ **同一档尺寸三个家**。改成两处都读令牌、并把令牌值写成 `4rem`（不是 64px） | 那两处占位是 fixed 底栏的唯一遮挡补偿：占位少了**最后一行永久压在栏底下、滚到底也露不出来**（`ConversationList` 注释里记着这条缺陷原本的样子）。`ResponsiveLayout:108` 早为**显示条件**立过单一事实来源（2026-09-19 那次漂移），但**尺寸**这一维没收 —— 同一对象只钉了一半 | 判据 **㊻**（`designGuards` 161 → **163**）：`pb-[calc(` 命中的每个占位不许含字面长度且必须引用 `--gosslan-*`；两条分母下限（占位 ≥ 2、该令牌被读到 ≥ 2 次）防"退回手抄"与"改名扫空"。**口径边界写死三条**：只扫 `pb-[calc(`（`pb-[max(env(…),0.75rem)]` 那族是安全区下限，误扫会去禁一件正确的事）、`env()` 不算字面量、**单位不在这一条判**。⚠️ 单位是本批唯一的非显然判断：全仓没有根字号覆盖（现数 0 命中）⇒ 今天 `4rem` ≡ 64px、改动逐字等价，但底栏自己的几何（`py-2.5` / `h-5`）是 rem，Android `textZoom` 放大时两者必须一起长 ⇒ 写死 px = 放大档下压行。**两发单点变异各红各的一格**：M1 换回 `4rem` ⇒ 点名 `layouts/ResponsiveLayout.vue: 占位里抄了字面长度 4rem…` 而 ㊺ 照绿（两病不同）；M2 把一处占位换成 `pb-16` ⇒ 红的是分母下限那句；两处 `diff -q` 复原。**同批外溢一条**：Tailwind `content` 原来扫 `src/**` 含 97 本 `*.test.ts` ⇒ 判据夹具里"故意写坏的示例 class"被当成真样式生成进生产 CSS，现数 **13 条死规则**；改成 `!(*.test)` 并按 `fast-glob` 现算核对 **303 → 206 份、差的 97 份全是 test、非测试少 0 份**，产物里那 13 个形状消失、真占位规则仍在、CSS 61945 → 59904 字符。读数：`designGuards` **163/163 exit 0**、`npm run build` **exit 0**、`npm test` 全绿 exit 0、收尾全量 CDP 探针 **448/448 exit 0**。⚠️ **那 448 条不覆盖本批那一格**：探针日志里 `TabBar`、`tabbar`、`底栏`、`pb-` 四个关键词现数 **0 条命中**（阳性对照「移动端」29 条）⇒ ㊻ 钉的是"尺寸只有一个家"，不是"值够不够高"，把令牌改成 `1rem` 时判据与探针都会绿而界面会压行；探针侧遮挡判据登记为待办。⚠️ **harness 侧一条未闭合缺陷（本批不修）**：全绿那次之前有 2 次同形挂死（`/tmp/probe-669b.log` 与 `…c.log` md5 逐字节相同），停在弹窗返回键之后第一次 `Runtime.evaluate`、读数 `264/265`、45 s 没回包；清掉 9444 残留 Chrome 后同段通过，隔离跑 `--only=overlay,imgskel` **48/48 exit 0** ⇒ 按脚本自己那句"记没跑"处理，不为消红放宽预算。⚠️ **NOT RUN**：Android/iOS `textZoom` 放大档（这条单位口径的真机反证）、Windows/Linux 腿；窄窗复看项 = 手机形态滚到底，最后一条会话必须完整露在底栏之上。⚠️ **故意没动的一格**：两处占位的**显示条件**仍不对称（一边 `showMobileTabBar`、一边 `app.isMobile && !keyboardOpen`），"等价"是推断不是读数 ⇒ 只登记。⚠️ §6.68 里"接线要窄窗读数 ⇒ 留在原档"那句的前提已被本行取代 |
| 42 | **暂缓替换（见 §6.70）** | 移动端「整屏覆盖壳」这一族数完：三段形状（`fixed inset-0` + `z-[60]` + `pt-[env(safe-area-inset-top)]`）齐全的生产码现数 **2 份** = 家 1（`MobilePageFrame:54`）+ 抄本 1（`FavoritePanel:691`，连带 `:698–712` 手抄的头部与返回键，它自己的注释写着"与 MobilePageFrame 完全一致"）| 判 **暂缓**，三条代码级理由：① frame 的 inline 根类 `flex h-full min-h-0 flex-col` 与收藏桌面分支的 `flex min-h-0 flex-1 flex-col` 不等价 —— `flex-1` 在 flex-**row** 父里管的是**宽度**，换过去右栏从"占满剩余"变成"按内容收缩"；② 底部安全区两个家给的不是同一个量（frame = 纯 `env()`，收藏 = `max(env,0.75rem)`），套 frame 会变两层相加，iOS 那档约 34 px → 46 px = 真像素变化，按 §八 必须界面读数；③ 出路只有两条且都越界 —— 动公共原语会牵另外 **4 家调用点**（`grep -rn "<MobilePageFrame"` 现数 5 处命中，扣掉原语自己第 14 行的注释示例 = `ResponsiveLayout:832` / `SettingsPanel:160` / `LinksList:107` / `LogViewer:425`；其中 3 家写死 `mode="overlay"`、1 家按 `app.isMobile` 动态选），给原语加 inset 参数则是规则 6 禁止的"为一家调用者加配置层" | 判据 **㊼**（`designGuards` 163 → **165**）：抄本数钉成棘轮（上限 = 登记名单长度，只许变小），新页面再抄一份 ⇒ `这些页面手抄了整屏覆盖壳而没有登记` 点名；家自己认不出来 ⇒ 正控那句红（防形状签名改了名而判据空扫）。**两发变异各红各的一格**：M1 改 `MobilePageFrame:54` 的 `z-[60]` → `z-[62]` ⇒ `EXIT=1` 红在正控；M2 新建一页手抄三段 ⇒ 红在 fresh。⚠️ M1 第一发是**假证据**：`perl s///`（无 `/g`）命中的是第 19 行**注释**里的同形文字，真实 class 没动而判据照绿 ⇒ 变异必须锚代码那处。读数：**165/165 exit 0**、`npm test` **1103 pass / 0 fail exit 0**、`npm run build` **exit 0**、探针 **NOT RUN**（生产码 0 行改动，没有可跑的界面变化）。⚠️ 下一批两条硬约束：改前先取"桌面右栏宽度"基线读数；迁完必须把 `OVERLAY_SHELL_COPIES` 清成 `[]` |
| 43 | **保留自研 + 判据钉配对（见 §6.71）** | DOM 监听「绑定 ↔ 解绑」这一轴数完：按 `(事件名, 处理函数标识)` 配对、同文件认账，生产码现数 **27 处绑定点**（`grep -rn "addEventListener(" ` 数到 29 行，剥注释后 27 ⇒ 差的 2 处活在注释里，其一就是 `initScope.ts:6` 那句话）；未配对 0、匿名 0（名单外）、capture 旗标不一致 0 | 这一族是**静默失败**（漏解绑不报错，只在长跑里长出来），与"Windows 长跑跳死、唯一无界候选＝常驻隐藏窗"同形状 ⇒ 配得上判据。三处**一次性接线**登记并写明理由：`boot/boot.ts`（启动期错误上报，早于任何组件）、`i18n/index.ts`（语言监听模块单例）、`composables/useBackLayer.ts`（`installed` 旗标保证全窗只挂一次）。★ 本轴同族还有一件"两个卸载机制并存"：`App.vue` 已把 4 条交给 VueUse `useEventListener`，其余 27 处仍手写配对 ⇒ 边界按三条判（组件作用域 + 挂载即终身 + 无 capture/条件性摘挂）才允许迁库，store/boot 级与"按开关来回挂"的（`MessageItem` 长按兜底）本来就要手动两侧 ⇒ 迁移面登记为下一批，不在本批顺手做 | 判据 **㊽**（`designGuards` 165 → **167**）三条：具名绑定无解绑点名、匿名只许进名单、**capture 每一侧都必须一致**；分母下限绑定点 ≥ 25；正控 = 名单里的文件今天必须还在绑定，否则 `该从名单里删掉`。三发变异各红各的一格：M1 删 `ChatWindow.vue:959` 解绑 ⇒ 未配对那句；M2 摘 capture 旗标 ⇒ 旗标那句（`有 2/2 处解绑旗标不一致`）；M3 摘掉 `i18n` 的绑定 ⇒ 名单正控。⚠️ **M2 第一次没红，红的是判据自己**：当时规则写成"至少一侧对得上"，而同一对句柄有两处解绑出口（切换关闭 + 卸载兜底），另一侧把判据哄过去了 ⇒ 改成"每一侧都对"才抓到，收紧后真实树照绿（方向是收紧不是放宽）。读数：**167/167 exit 0**、`npm test` **1105 pass / 0 fail exit 0**、`npm run build` **exit 0**、探针 **NOT RUN**（生产码 0 行改动）。⚠️ 判据测不到"解绑真执行过"（要运行时数 `removeEventListener`，属探针的活）。⚠️ **本行那两个数字是 §6.71 当时的读数，已被下一行（§6.72）取代**：手写绑定点 27 → **22**、VueUse 托管 8 → **9**，㊽ 的分母下限也从 ≥25 改成 ≥20 并补一条"走库 ≥8"的反控 ⇒ 以 **行 44** 的现读为准。本行末尾"测不到解绑真执行过"这一格也在 §6.72 拿到**一部分**运行时凭据（探针真按 Escape 关掉了已迁库的那条 keydown），但不是全部 ⇒ 逐站点覆盖见行 44 |
| 44 | **直接替换（见 §6.72）** | 拿行 43 立的三条界（组件作用域 + 挂载即终身 + 无 capture 且无条件摘挂）逐行读过，**5 处**手写配对交给**已装的** `@vueuse/core@14.4.0` 的 `useEventListener`：`ChatWindow.vue` 多选态 Esc、`SettingsWindow.vue` 关窗 Esc、`message/ImageLightbox.vue` 灯箱按键、`ConversationList.vue` 点名单外收起、`composables/useShortcuts.ts` 全局快捷键 | 真删掉的是 **10 条手写注册/注销语句**（5 组配对）+ 因此失去用途的 **4 个生命周期 import 名**。`App.vue` 早就在用 `useEventListener` ⇒ **没有新增依赖**。净行数只 ±1 级别 —— **成果不是"少写几行"，是卸载路径只剩一处会写错**：配对、处理器迟到赋值、capture 旗标都改由那个库保证，而不是每个组件各自记得 | ⚠️ **没迁的各有明说理由**：`MessageItem` 长按兜底要按开关来回挂（且两侧 capture 必须一致）、`TitleBar` 的解绑与 `listenerScope.dispose()` 同在一个 `onBeforeUnmount` 块（拆两处只为迁库不值）、`GroupTasksBoard` 的 scroll 是 capture 相位且与 resize 成对、`stores/*` 与 `boot/*` 根本没有组件作用域；`MessageComposer` / `VirtualList` / `LogViewer` / `useBackLayer` **本轮没逐行读它们的解绑侧 ⇒ 不下判断**，留下一批按同三条一处一处过。★ **同一根轴两把尺子的代价当场显形**：旧那条（只扫 `.vue`、分母硬编码 `registered >= 15`）先红而 ㊽ 全绿 ⇒ 删旧留 ㊽，并在原地留一段「取代关系」注释（㊽ 覆盖面 `.vue` **和** `.ts`、多一条 capture 逐侧一致、分母与正控各一条）⇒ **撤销旧断言不是放宽，是把同一语义指到更强的证据上**；册数 167 → **166**。读数：`node --test src/utils/designGuards.test.ts` **166/166 exit 0**（㊽ 那一次自打印：扫 205 份生产码 / 手写 22 / 走库 9 / 一次性登记 3 / 未配对 0 / 旗标不一致 0 —— ⚠️ 这组数属 §6.72 当时，**行 45 有新读数**）、`npm test` **1104 pass / 0 fail exit 0**、`npm run build`（vue-tsc + vite）**exit 0**、收尾全量 CDP 探针 **448/448 exit 0**。★ **一把不是我为本批新写的尺子也对上了**：清单机器段（`node scripts/frontend-inventory.mjs` 现算）里 `@vueuse/core` 的引用文件数 8 → **13**（正好 +5 = 迁的 5 份文件），`vue` 的引用文件数 90 → **89**（`useShortcuts.ts` 那整行 vue import 消失）⇒ "真接上了"由盘点表自己算出来的数背书，不靠我数自己的语句。⚠️ **逐站点运行时覆盖是读探针源码数出来的**：这 5 处只有 **1 处**被真按键验过 —— `runLightbox` 挂的正是 `ImageLightbox.vue`（533 行 `lightboxMount` 里 `install` 那份真组件），6416 行真发 `Escape`、判据「Esc 关闭：浮层 DOM 撤净且焦点回到 opener」绿，而该组件的 Escape 出口**只有**已迁的 `onKey`（274 行；它用 `FocusScope` 不是 Dialog，没有第二个会关它的处理器）。其余 4 处仍只有静态证据：`runPinKeyboard`（2618..2769）只发 Tab/Enter；`SettingsWindow` 与 `useShortcuts` 探针从未挂载；`ConversationList` 挂的是"姓名过滤"那一段，好友菜单的开/收零判据 ⇒ 真机项照旧列出。⚠️ **一条差点写反的判断**：`grep -c "Escape"` 打在探针日志上是 **0**，我起初把它读成"这 448 条从没按过 Esc"，其实它只证明**日志不打印按键名**（同一份源码里 `cdp.key("Escape"…)` 现数 **8 处**）⇒ **覆盖度只能从发射按键的那份源码数，"日志里查不到"≠"这件事没发生"**。⚠️ **一条工具侧教训**：批量清 import 的判据按 `\bnamed\(` 认"还在用"，漏掉 `computed<{…}[]>(…)` 这种泛型调用 ⇒ 曾错删 `computed`，是 `npm run build` 报出来才补回 ⇒ 必须认 `name<` 也算被引用。⚠️ **NOT RUN**：iOS WKWebView 与 Android 的键盘事件语义（探针跑的是没有 Tauri 的页面，它不替 WebKit 作证）、Windows/Linux 腿。⚠️ 本批改了应用码 ⇒ `Version-Bump:` 欠账与 §6.66/§6.68/§6.69 同一笔一起补；`designGuards` 161 → 166 ⇒ 提交前测试清单基线 `--update` → `--sync-baselines` → 再 check |
| 45 | **直接替换（见 §6.73）** | 不重新数轴，而是**把行 44 写下的两条"不迁理由"拿去读库的实现**（`@vueuse/core@14.4.0`，`node_modules/@vueuse/core/dist/index.js` 里 `useEventListener` 那段）：① 「带 capture 所以不迁」**方向反了** —— 实现把**同一个 options 克隆**同时喂给注册与注销 ⇒ 两侧旗标由构造保证一致，而"手写只摘一侧旗标 ⇒ 解绑是空操作且不报错"正是判据 ㊽ 的 M2 抓到的真缺陷 ⇒ capture 站点是**最该**交出去的一类；② 「解绑与其它清理同在一个卸载块 ⇒ 不值得拆」**自相矛盾** —— §6.72 自己迁的 `ChatWindow` 就是同一情况（它的 `onBeforeUnmount` 里也留着 `dragDropScope.dispose()`）。⇒ 按这两条压着没迁的 **7 处全迁**：`TitleBar` 窗口快捷键、`GroupTasksBoard` scroll(capture)+resize、`LogViewer` visibilitychange、`VirtualList` resize、`MessageComposer` click+selectionchange | 真删 **14 条注册/注销语句 + 2 个 import 名**（`onMounted` 在两处变得没人用；删前按上一批教训连 `name<` 形状一起核过）。★ **这条轴到此闭合**：该迁的迁完，剩下 15 处**每一格都有名字和理由** —— 条件性摘挂 4 处（`GroupTasksBoard` 粘贴与 `subscribeImageDrop()` 那只 `InitScope` 在同一只 `watch` 里成对；`MessageItem` 的 touchend/touchcancel/selectionchange 按开关来回挂且带 capture 与第二处卸载兜底）+ 没有组件作用域 11 处（store 7+1、boot 1、i18n 1、`useBackLayer` 1 匿名）。⚠️ **故意不采用"把目标传成 `computed(() => on ? document : null)`"来让库吃下条件性挂法**：那份实现**没有 `when` 选项**，这么写等于把"挂与不挂"藏进一个假目标，读代码的人必须先读库源码才懂（规则 6），且会动到那只 `InitScope` 关于"退订发生在 IPC 往返途中仍须执行"的既有语义 | ⚠️ 一处**真实但无害**的语义变化：库在 `setup` 里同步注册（`watchImmediate`），原先在 `mounted` 之后 ⇒ 处理器全是 `function` 声明（提升）且这几类事件（keydown/resize/click/selectionchange/visibilitychange）不可能在 setup 与 mounted 之间到达；这句是按"声明形态 + 事件种类"两处读过写的，不是猜的。★ **量具换了一次口径**（这次不是重定下限）：分母原钉"手写 ≥ 20"，每迁一次都要手改 ⇒ **量具在跟着被量的东西走**；读实现发现守恒量是**两个家加起来**（27+8 = 22+9 = 15+16 = **31**，迁移只是把一条 `addEventListener` 换成一条 `useEventListener`）⇒ 主判据钉 **总数 ≥ 28**，两家各自的存在下限（≥13 / ≥15）退成"这一侧不许静默清零"的兜底。两发单点变异各红各的家（`两个家加起来只数到 15 处…（手写 15 + 走库 0）` / `…只数到 16 处…（手写 0 + 走库 16）`），各 `diff -q` 证复原、复原后重跑退 0。⚠️ **这条下限管不住"只删一处监听"**（31→30 照绿）—— 它管"量具空扫 / 整批消失"，少一条归配对判据与探针，不许反过来写成"这条判据能发现漏删"。读数：`designGuards` **166/166 exit 0**（㊽ 现打印 **手写 15 / 走库 16 / 未配对 0 / 旗标不一致 0**）、`npm test` **1104 pass / 0 fail exit 0**、`npm run build` **exit 0**、收尾全量 CDP 探针 **448/448 条判据绿、退码 0**（`/tmp/probe673.log`）。⚠️ **覆盖边界按 §6.72 立的规矩读探针源码数**：这 7 个处理器**没有一个拿到专项断言**；唯一被真实输入顺带执行到的是 `MessageComposer` 的 document click（`inputpanel` 段真挂着这份组件时发了多次真点 —— 「真点之后表情面板由 Reka Portal 挂到 body」「真点『发送』按钮也 emit send」），但「点别处 ⇒ @ 候选列表收起」本身没有断言 ⇒ 那段的绿只背书"这条监听在跑且没把别的弄坏"。其余 6 条（`TitleBar` keydown、`GroupTasksBoard` scroll+resize、`LogViewer` visibilitychange、`VirtualList` resize、`MessageComposer` selectionchange）**一次都没跑到可判读的结局** ⇒ 不许写成"运行时已验"，下面那 6 项真机就是补这一格的。★ **一把不为这批新写的尺子对上了，而且它对出的数比我的直觉更准**：清单机器段（同一脚本现算）`@vueuse/core` 的引用文件数 **13 → 17** —— 是 **+4 不是 +5**：`git show HEAD:src/components/LogViewer.vue | grep -c "@vueuse/core"` 现读 **1** ⇒ 那份文件本来就在 import 这个库，这次只是多一行，文件数不变（我起初按"+5"写，是拿直觉当读数，被这把独立尺子撞回来才去核的）。`vue` 引用文件数 **89 → 89**（这批没让任何文件彻底脱离 vue），生产码总行 **42,843 → 42,842**（净 **−1 行**，但少的是 14 条注册/注销语句、多回来的是注释）。⇒ "真接上了库"由盘点表自己算的数背书，不靠我数自己的语句。⚠️ **要用户真机看的（这批全改在"用户能碰的那一下"上）**：① @ 候选列表点开后再点别处要收、选中文字仍同步；② 群任务台账滚动/缩放时行菜单要收（Android 也试）；③ **草稿关掉后再粘图片不许进图**；④ 日志页切回来立刻刷新（不等 2 s）；⑤ 窗口改大小后虚拟列表不空行不遮挡（聊天窗 + 日志窗）；⑥ 标题栏那条关闭窗口快捷键仍生效且不误伤输入。桌面 + Android 各一遍，iOS 至少 ①②。⚠️ `Version-Bump:` 欠账并入 §6.66/§6.68/§6.69/§6.72 同一笔 |
| 46 | **保留自研 + 补运行时凭据（见 §6.74）** | 行 45 自己登记了"7 处迁库监听没有一个拿到专项断言"——**登记洞不等于补洞**，这一批把最有咬合力的那条补进探针：`scripts/check-ui-runtime.mjs` 的 `runInputPanels` 末尾加一条「点开 @ 名单 ⇒ 真点视口左上角（一定在 `.gosslan-composer` 之外）⇒ 名单收起**而编辑器里那个 `@` 还在**」。业务码一字未动：`isAppCodePath` 现读定义只有 `^src/` 与 `^src-tauri/src/`（`scripts/semver.mjs:118-122`）⇒ 改它不新增版本欠账 | ★ **「草稿里那个 @ 还在」是关键的一半**：只有 mention 状态被清、草稿没动，才证明是 `onDocClickForMention` 收的；把草稿清空的是发送那条路（同段前面刚验过）。缺这半句，「列表不见了」会被「顺手清了一次草稿」混过去 ⇒ 与探针册里那条「判据要能分开两种成因」同纪律。**归因不靠论证**：把那一条 `useEventListener` 的 click 绑定摘掉 ⇒ **23/24、退码 1、红的正是这条**；`cp` 复原 + `diff -q` 报相同 ⇒ 重跑 **24/24 退码 0** ⇒ 这条监听**确实就是**运行时收起名单的那个东西 | 读数：`--only=inputpanel` **23/23 → 24/24 exit 0**、变异轮 **exit 1（红在这一条）**、复原轮 **24/24 exit 0**、收尾全量 全量重跑实测 **449/449 条判据绿、退码 0**（448 + 这条 = 449）。⚠️ 第一趟在 `runOverlay` 挂住 ⇒ 264/265 退码 1，红的是元判据「探针自己跑完了」；而 `runOverlay` 在派发序列里排在 `runInputPanels` 之前（`:2382` vs `:2386`）⇒ 那一趟没跑到新那条，265 不能当本批读数用，也不能读成「新断言弄挂了页面」。第二趟走同一位置照过 ⇒ 记量具单次抖动（那趟僵尸 CfT 占住 9444，由我 kill；前置门只挡起跑，不回收跑挂后的现场）（条数由脚本自己打印，别处不许手抄）。⚠️ 这条**不减少**行 45 那张真机清单：`TitleBar` 关闭窗口快捷键、`GroupTasksBoard` 滚动/缩放收行菜单、`LogViewer` 切回来即刷新、`VirtualList` 改窗后不空行、`MessageComposer` 选区同步、以及「关掉草稿后再粘图片不许进图」——**这 6 处仍只有静态凭据**，运行时那一格只补上了 1 处 |
| 47 | **保留自研（见 §6.75）** | 收藏页那格整屏覆盖壳（`FavoritePanel.vue`）要不要迁给 `MobilePageFrame` | 行 46 之后这条轴只剩一格登记中的抄本（`components/FavoritePanel.vue`，判据 ㊼）。待办原先写的是「迁给 `MobilePageFrame` 并把清单清成 `[]`」—— 本行按行 45 那条教训**先读实现再动手**，判成**不能迁**，三条实测：① `FavoritePanel.vue:688` 的父亲是 `:582` 的 `flex min-h-0 flex-1`（没写 `flex-col` ⇒ 默认 **row**）⇒ 桌面那支的 `flex-1` 管的是**宽度**，而框架 `inline` 写的是 `flex h-full`（`MobilePageFrame.vue:55`，**没有 `flex-1`**）接不了；`overlay` 是 `fixed inset-0`，会把详情摘出流并盖住左列。同文件 `:597` 那句「`flex-1` 把 `flex-basis` 设成 0% 会让 width 失效」正是这个轴为横的自证（左列因此才必须 `flex-none`）。② 移动端那支与 `overlay` 同串（壳 + 头部逐字相同），但要用上库就得把**这一个元素拆成两支** ⇒ 里面这块正文实测 **L688–L881 = 194 行 / 9 处 `@click`（8 个不同处理函数）/ 28 个绑定标识符**：要么把正文抄第二份（比这条轴本来要防的事更糟），要么为消两行 class 串新造一层业务组件（撞 §七.6）。③ 底部留白是两个不同的量：收藏页写 `pb-[max(env(safe-area-inset-bottom),0.75rem)]`，框架的 `.safe-bottom`（`style.css:722-724`）= `padding-bottom: env(safe-area-inset-bottom)`，**没有 0.75rem 兜底** ⇒ 在 `env()` 取 0 的端上那 12px 会静默变 0。⇒ ㊼ 的 `OVERLAY_SHELL_COPIES` **保持 1 格**，但那格里从现在起写的是这三条判定，不是「还没迁」。复跑：`sed -n '582p;597p;688,692p' src/components/FavoritePanel.vue`、`sed -n '52,55p' src/components/MobilePageFrame.vue`、`sed -n '722,724p' src/style.css`；194/9/28 由剥 `<!-- -->` 后按 `<div>/<Transition>` 标签配对现数（口径同 ㊼：按标签块不按行）。★ 教训：**「清成 `[]`」这种待办写法自带一个假前提**（默认剩下的每一格都迁得动）；判一格能不能迁的三步 —— 认父亲主轴、认库各 mode 究竟写出哪些属性、数拆支要付的正文行数与回调数 —— 全在做完就能判，不必动码。本行**没改应用码**，不新增 `Version-Bump:` 欠账 | 复跑命令见报告 §6.47 |
| 48 | **保留自研 + 补运行时凭据（见 §6.76）** | 台账交给库的那一对 window 监听：`scroll`（带 capture）+ `resize` | 接行 46 登记的那句「另外 6 处仍只有静态凭据」，补的是形状最有意思的一格：`GroupTasksBoard` 交给库的 `scroll`（带 capture）+ `resize`（不带）这一对（§6.71 的 M2 变异抓的就是「两侧旗标不一致」）。三条判据加在 `--only=tasksmobile` 里：① 开局核对（菜单打得开 + 行确实挂在一层 `overflow-y-auto` 里 + `window.scrollY=0`）；② 从行自己那层发一根 `bubbles:false` 的 scroll ⇒ window 上临时挂的**冒泡相探针收不到**而菜单**从 DOM 撤掉** ⇒ 收它的是那条带 capture 的 window 监听；③ 真改视口尺寸 ⇒ 同一个菜单也被撤掉。三条都读**撤掉**而不是**看不见**（Reka 只会隐藏浮层）。★ 中途一次「判据红、现象绿」：原先读 `ev.composedPath()` 得 false 而菜单其实被撤了 —— 派发结束后 composedPath 已被清空，那是**尺子坏了**，换成冒泡相探针才对。变异两发各点一面：M1 摘掉 capture 旗标 ⇒ 3/5 退码 1（第二条红；第三条同时红是级联，`openRowMenu` 点的是同一枚 toggle，不许写成两条各自能红）；M2 摘掉 resize 整条 ⇒ 4/5 退码 1（只有第三条红，这发是干净的一格一红）；`cp` + `diff -q` 证复原 ⇒ 5/5 退码 0。⚠️ 第二条的事件是**合成的**：它审的是注册旗标，不是「用户真滚动时 Chromium 发不发 scroll」—— 面板形态那层滚动容器不受高（`min-h-0 flex-1` 挂在 `standalone` 上，实测 `scrollHeight-clientHeight=0`），窗口形态在探针里卡在 `todosLoadedOnce` 渲染空列表 ⇒ 真机那条清单没有因此缩短。 | 读数：`--only=tasksmobile` 2/2 → **5/5 退码 0**；收尾全量 **452/452 条判据绿、退码 0**。运行时那一格 1/7 → **2/7**，剩 5 处仍只有静态凭据。本行**没改应用码**，不新增 `Version-Bump:` 欠账 |
| 49 | **保留自研（见 §6.77）** | 新轴「同一个处理器被两条机制驱动」的全仓存量 | 新开一根轴「同一个处理器被两条机制驱动」：扫 205 份生产码现读 **1 处**（`VirtualList.vue` 的 `onResize`：2 个真调用点 + `ResizeObserver` + `onMounted`）。两版坏尺子（择一式让任意 `watch(` 都算真、把定义与注册当调用点）各造一批假阳性；改严后靠「已知为真那一格必须还在名单里」这个正控才敢读结论。★ 我自己那条「这条 window 监听冗余、可删」的论证被读实现推翻：`computeScrollState()` 带 `emit nearBottom` / `emit loadMore` 副作用，而观察者回调有 `h !== viewport` 守卫 ⇒ 只变宽那一类 resize 只有 window 这条路会重算 ⇒ 两条机制不等价，判**保留自研**、不新增判据。⇒ 目标④这根轴的存量结论 = **1 处多驱动、0 处可删**。复跑 `node /tmp/dupdrivers.mjs`（口径见报告 §6.77）。本行没改应用码 | 复跑命令见报告 §6.49 |
| 50 | **保留自研 + 判据收紧（见 §6.78）** | CSS 令牌轴的反向半边：定义了却没人消费的 `--gosslan-*` | §6.68 那根 CSS 令牌轴的反向半边：㊺ 原先只钉「无人消费 ≤ 6 个 + 每轮打印名字」——数量上限意味着第 5、6 个没人读的名字能混过去，而且没人交代这 4 格是什么。现读 4 格 = `--gosslan-item-radius`（design-guidelines.md:44 明写的语义别名契约）+ `--gosslan-text-title` / `--gosslan-text-callout` / `--gosslan-text-footnote`（style.css:63-66 的字号阶梯，正是 265 处内联 `text-[NNpx]` 的目标档，还没接线）。⇒ 四格都判**保留自研**：删了等于把迁移目的地和对外契约一起删，而 265 处内联值还在原地。量具改形：数量上限 → **逐格点名 + 每格写理由 + 反向钉**（登记的每个名字今天必须仍然无人消费，被接上或拼错就红，与 `DYNAMIC_WRITERS` 同口径），注释写明**这是收紧不是放宽**。非空转：把一个登记名改错一个字 ⇒ 165/166 退码 1、红在「新增了且没登记理由」；`cp` + `diff -q` 证复原 ⇒ 166/166 退码 0。⚠️ 这根轴没因此变短：那 265 处仍是 P3 欠的活且要看观感。本行只动判据与文档，没改应用码 | 复跑命令见报告 §6.50 |
| 51 | **保留自研 + 补运行时凭据（见 §6.79）** | 日志窗交给库的那条 `document visibilitychange` 监听（`LogViewer.vue:174`） | 接着行 46/48 那句「其余仍只有静态凭据」补第 3 处：`components/LogViewer.vue:174` 交给库的 `document visibilitychange` 监听。归因不靠时间差而靠**拆掉竞争驱动**——先点掉自动刷新开关（`:263` → `syncTimer()` → `clearInterval`），此后 `api.getLogs` 的调用方只剩已发生完的 `onMounted` 和我手工发的那根事件；夹具为此新增通用出口 `H.apiCalls(name)`（`stubApi` 顺手计数），因为这种断言**只能数调用次数，读内容读不出来**。顺序上先跑正控（静置 2.3 s 调用数增加）再验"关掉后不动"，否则"不动"可能只是因为压根没跑。两发单点变异：**M1** 摘掉注册行 ⇒ 10/11 退码 1、红的正是那一格（`cHidden:2/cShown:2`）；**M2** 摘掉处理器里的 `!document.hidden` ⇒ **11/11 全绿** ⇒ 证伪了"反向那格证明处理器条件"这句话（`load()` 在 `:148` 判过同一谓词，两处守卫都能给同一结局），于是新开一根 §6.77 的姊妹轴「**同一个谓词被两处守卫**」，判定**保留原样**（M2 已证删掉行为等价，但那句是处理器契约，且改应用码要新造版本欠账）。另把这段一直**隐性依赖**的环境量 `document.hidden` 钉成夹具一部分并打印原生 | 读数（本轮 `hidden=false/visible`），离开时还原 + 一条外溢守卫。踩回一次量具坏：同一次 `cdp.eval` 里读不到 Vue 翻面后的 `aria-pressed`（DOM 写入排在微任务）⇒ 首跑 9/10 红的就是那条。读数 `--only=logs` 5/5 → **11/11 退码 0**，复原轮 11/11，`git diff --stat` 只剩 §6.73 那批内容（本批应用码零变化）。迁库监听的运行时覆盖 **3/7**，仍欠 4 处：`TitleBar` 快捷键、`VirtualList` 改窗不空行、`MessageComposer` 选区同步、关掉草稿后不许再粘图；⚠️ 合成事件只审注册与分支，**日志窗最小化再切回来仍欠真机**。 |
| 52 | **直接替换（见 §6.80）** | 新开一根轴「localStorage 会抛」：全仓生产码 `localStorage.<op>` 直连点现读 25 处，其中 17 处连 try 都没有；同一件事已被四处各自手写（i18n 读+写、chatStore 读+写、useAppStore.loadLocalChatStyle） | P0 形状不是风格：`useAppStore.ts:90/91` 在 store 创建期就 getItem ⇒ 一抛整个 store 起不来；`applyAppearance`、`setThemeColor`、`setFontFamily`、`setChatStyle` 四条写路径没兜 ⇒ Safari 配额写满时用户点一下切换外观整条函数中断（外观既不落 DOM 也不落后端）；`ResponsiveLayout.vue:471` 在拖分栏收尾函数里。不显然的一点：光**访问** `localStorage` 这个属性在某些 WebView 就抛 ⇒ 取后端那一步也得进 try，只在 getItem 外包 try 不够 | 新家 `src/utils/safeStorage.ts`（工厂 `createSafeStorage` 收后端 + 三个包装出口，绝不 rethrow；值的校验全部留在调用方 ⇒ 不长成配置层）。迁走 20 处、删掉 5 份手写 try/catch 脚手架。⚠️ `src/boot/theme-boot.js` 那 5 处判**保留自研**：由 vite `gosslan:inline-boot` 内联进 HTML（`vite.config.ts:38`）、import 不到模块，且整块外层 try 已兜住（代价是第一个抛点让后面四件事全不做，改法留作后续）。判据 **㊾**：正向钉「生产码 .ts/.vue 里的存储直连点必须为空集」，反向钉分母下限（新家消费点 ≥ 20 且迁过的四份文件仍在名单）——防改名把上一句变成假绿；非空转由一发注入（往 useAppStore 塞回一行直连）证明。**读数**：受影响四本 + 新家行为测试 49/49、`判据 ㊾ 非空转：注入一发直连 ⇒ **166/167 退码 1** 并点名 `stores/useAppStore.ts:1063`；`cp` 复原 + `diff -q` ⇒ **167/167 退码 0**；分母读数「扫 206 份生产码 / 直连点 0 / 新家消费点 20 处（4 份文件）」`、`**22 步全通过、共 68.7 s、退码 0**（复跑 `npm run verify:local`；`grep 全部门禁 /tmp/vl680b.log`）`。两次量具假绿自报：helper 的 finally 早于用例体执行、`delete globalThis.localStorage` 只摘影子而原型那份会回来；新家用 `@/` 别名 ⇒ 三份既有测试整本 ERR_MODULE_NOT_FOUND（这台 node --test 不解析别名）。⚠️ NOT RUN：真机 Safari/WKWebView 的 SecurityError 路径、外观与分栏宽的 CDP 探针复看、Android/iOS/Windows 层；动了应用码 ⇒ Version-Bump 欠账再加一格，designGuards 用例数再 +1 ⇒ 测试清单基线三步照旧 |
| 53 | **直接替换（见 §6.81）** | 补 §6.80 自己登记的两条尾巴：把 `localStorage` 当**值**交出去那一族（现读 6 处 hand-off），以及判据 ㊾ 第一版的视野盲区 | 洞是上一批留下的：㊾ 当时只认 `localStorage.<op>` 属性调用，而抛点在**属性访问**那一步 ⇒ `readStoredAppearance(localStorage)` 这条 store 创建期的崩路完全不在判据视野里，修掉 20 处之后它还在。做法是给家加 `safeStorageBackend: StorageLike`（方法名与 localStorage 一致、永不抛），被喂的那些 util 的形参形状一个字没动 ⇒ 喂假表的单测照旧。⚠️ 代价明写：这一面上**写失败读不到成败**（吞成 void） | 形状判据换成语义判据两处：`announcementDismiss.test.ts` 原来钉字面串 `readAnnounceSeen(localStorage)`，改成「必须把家传进去 + `doesNotMatch` 不许直连全局」；判据 ㊾ 正则放宽到裸标识符 + 新增 `safeStorageBackend` 提及数下限 ≥ 6。**非空转**：注入 `const __p681 = localStorage;`（旧形状判据看不见这种）⇒ ㊾ **166/167 退码 1** 点名 `stores/useAppStore.ts:1063`，复原 ⇒ 绿。**读数**：designGuards + announcementDismiss **174/174 exit 0**、`npm test` **1112/1112 exit 0**、快速层 `verify:local` **22 步全通过、共 69.0 s、退码 0**。⚠️ 仍欠两格不许读成收完：`theme-boot.js` 那 5 处（内联约束、逐键 read() 的改法）；`readStoredAppearance`/`memberNameCache`/`announcementDismiss` 内部各自还留一层 try ⇒ §6.79「同一谓词被两处守卫」在这一族成规模出现，本批判保留（那些 util 的单测正是喂会抛的假表），但写明**现在只有外面那层能被 ㊾ 看到**。⚠️ NOT RUN：真机 Safari/WKWebView 的 SecurityError、公告收起/外观/分栏宽的真实界面落盘复看、Android/iOS/Windows 层；动应用码 ⇒ Version-Bump 欠账再加一格 |
| 54 | **保留自研 + 兜底粒度改对（见 §6.82）** | §6.80 留下的最后一格：首屏脚本 theme-boot.js 那 5 枚键的兜底粒度（不是把它并回那个家——并不了） | 旧形状是整块外层 try ⇒ 隐私模式确实不崩（旧测试只钉 doesNotThrow），但 Safari 是**按键**抛的 ⇒ 第一枚键一抛就把主色、字体、首帧语言、macOS 标记一起带走，症状是'深色没闪但整屏出厂蓝 + 系统字体 + 英文标题'且没有任何一层报错。'不崩'和'只做第一件事'是两件事 | 改成逐键 readBootLS(k)（自己那层 try，9 行副本）。★**先红后绿是本批唯一硬凭据**：替身环境加 throwKeys 只让指定键抛 ⇒ 新用例改脚本前 **17/18 红在这一条**、改后 **18/18 exit 0**（比'我读代码认为会带走三件事'强）。键名交叉核对的提取器同步认两种载体，正控补 readBootLS 那一发。**判保留自研的理由要具体**：内联脚本没有模块图，import 会让它拿不到值 ⇒ 首帧防闪白做。**读数**：`npm test` 1113/1113 exit 0、快速层 verify:local 22 步全通过、共 69.3 s、退码 0（这一层真的把脚本内联进三份 HTML 再构建）、readBootLS 现数 6 = 1 定义 + 5 键。⚠️ 外层那圈 try 仍在（document/matchMedia/navigator 还在里面）⇒ 脚本后半段'一抛全跳'的形状本批没动；真机 Safari/WKWebView 按不按键抛、iOS 首帧是否真丢主色 = NOT RUN；动了 src/boot ⇒ Version-Bump 欠账再加一格 |
| 55 | **直接替换 + 判据（见 §6.83）** | 「移动布局的宽度档」这一族数完：全仓宽度媒体查询现读恰好 4 处，其中 3 处是同一串 `(max-width: 767px)`（`useAppStore.ts:246` 建 store 判初值、`:735` 活着的 `matchMedia`、`src/boot/skeleton.css:127` 首屏骨架），第 4 处在注释里 | 三份手抄各自合法：改一份 vue-tsc 过、构建过、探针也过，症状只是"首帧按另一档渲染"或"骨架在手机上画成桌面三栏"。第四档不在我们手里 —— Tailwind 的 `md` = 768px，而全仓结构级断点都写成 `desktop:md:*` 叠加 ⇒ JS 那一档必须恰好低 1px，重叠或留缝的那一刻 `html.is-mobile` 与 `md:` 同时亮/同时灭 | 家落在判据层老家 `utils/platform.ts`（`MOBILE_MAX_WIDTH_PX = 767` + 由它现拼的 `NARROW_LAYOUT_QUERY`，`platform.ts:101`），两处 JS 直连改引用 ⇒ **真删一份手抄**；CSS 那份接不进来（媒体查询读不了自定义属性、骨架又必须早于 JS），只能两边现读对账。判据写在 `platform.test.ts` 末尾（与「减弱动态只有一个家」同族）：正控认裸查询且不数注释／分母下限／反向钉（骨架那处必须仍在 + 两个消费点各 1 次 + Node 现读运行时值）／**md 从 tailwindcss/defaultTheme 现算**不手抄。`useMediaQuery`（14.4.0 dist 读实现）判**不接**：只接 change、没有 resize 与首帧后重判，且内部 `useEventListener` 只在有活动 effectScope 时自动摘，而 `init()` 可重跑 ⇒ 接进去每重跑多一份永不摘的监听。**读数**：先红退码 1（家没建立）→ 改后退码 0 并打印「家=767px / md=768px / JS 裸抄 0 / CSS 查询 skeleton.css (max-width: 767px)」；两发单点变异各点一面（M1 家里改 766 ⇒ 红在补数那条；M2 往家里追加一行手抄 ⇒ 红在裸抄那条并点名）⇒ `diff -q` 复原；`npm test` 1114/1114 退码 0、`verify:local` 22 步全通过 69.6s。★顺带跑出一个**量具的谎**：探针 `check-ui-runtime.mjs:694` 自己 toggle `is-mobile`、从不走 `applyIsMobile()` ⇒ 这条链的运行时凭据仍是零（下一批：让探针真驱动宽度）。⚠️ NOT RUN：真浏览器跨 768 翻面；Android 首帧 980px 那一档骨架仍按宽度判（两个候选改法都要真机首帧读数 ⇒ 暂缓）；动应用码 ⇒ Version-Bump 欠账再加一格 |
| 56 | **补运行时凭据（见 §6.84）** | 上一批数出来的那个量具的谎：探针里唯一的 `is-mobile` 是夹具自己 toggle 的（`check-ui-runtime.mjs:694`），`store.applyIsMobile()` 从没被执行过 ⇒ "摘掉监听"以前一条都不红 | 这条链是移动端布局的唯一入口（#27 事故的兜底就在这三条出口上），而它此前只有文本判据 + 一个假读数。新段 `--only=layoutstore` 跑**真的 `useAppStore().init()`**，查询串从 `/src/utils/platform.ts` 现取（探针里不抄第二个 767），CDP 改视口 1200→390→1200，三格分别读查询本身 / `store.isMobile` / `<html>` 上那个类。`init()` 不 await：布局那一格在第一个 await 之前，后面的 IPC 在无 Tauri 的页面必然抛（实测抛在 invoke，属预期并打印） | 四发变异把「两个机制驱动同一格」的归因坐实（§6.77 那族第一次有运行时读数）：只摘 mq ⇒ 3/3 绿；只摘 resize ⇒ 3/3 绿；**两条都摘 ⇒ 2/3，红的正是跨窄档那一格**；复原 ⇒ 3/3 绿 + `diff -q` 一致 ⇒ 两条冗余出口是故意的、而这条链整体可证伪。★顺带读出**反向那一格的强度**：两条都摘时"退回宽档类为 false"仍绿，因为类压根没挂上过 —— 那格防"只会变窄不会变宽"，不防"这条链没接"（已写进段注释）。读数 `--only=layoutstore` **3/3 退码 0**（q=(max-width: 767px) / vw 1200→390）、`node --check` 通过、快速层 **22 步全通过 58.0 s 退码 0**。⚠️ NOT RUN：Chromium 的 setDeviceMetricsOverride 不重现 Android WebView 首帧读到 980px 那一档 ⇒ 真机首帧读数仍欠（他手上）；本批只动 scripts/ 与文档 ⇒ 不产生 Version-Bump 欠账 |
| 57 | **删除（见 §6.85）** | 「菜单往视口里收」这一族数完：全仓生产码 `Math.max(<数>, Math.min(… window.inner…))` 现读只剩 1 本（`GroupTasksBoard.vue:196`），另一处是 `ConversationList.onFriendContext` 按 `mw=150 / mh=90` 两个猜出来的菜单尺寸收坐标 | 外壳 `ContextMenu.vue` 把鼠标点做成零尺寸虚拟锚点，注释写死「量尺寸、翻转、贴边内收由 Reka 的 popper wrapper 做」；而**同一文件的 `onConvContext` 早就把 x,y 原样传下去** ⇒ 一个文件两种口径。这就是规则七.3 说的"迁移完没人回头删的尾巴"：漂了不编译错、不构建错、探针也不红，症状只是菜单弹开的位置偏离用户点的那一下 | 删掉收边与两个尺寸猜测（坐标原样交外壳）。留下的那一处判**保留**：它限的是菜单**自己的宽**（Reka 不替内容缩宽）且辅助任务窗没有 `minWidth`。判据写在同一条轴的 `contextMenuReka.test.ts` 末尾：正控（matcher 认得出那种写法）／分母下限（≥180 份）／**反向钉名单**（允许留下的那处要点名文件并钉形状）＋反向钉两个菜单都传裸坐标、外壳虚拟锚点契约没被拆。**读数**：该本 `node --test` 退码 0 并打印「现读 1 本文件（名单：components/GroupTasksBoard.vue）」；单点变异（把收边按回好友菜单）⇒ 退码 1、点名 `components/ConversationList.vue`；`cp`+`diff -q` 复原逐字一致；`npm test` 1115/1115（fail=0）退码 0、`verify:local` 22 步全通过 69.1s 退码 0。⚠️ 自报一次量具错：取 npm 计数时 awk 取的是第 2 列（拿到单词 tests）而不是第 3 列，文档里先落了一句占位读数 ⇒ 已按原始行重取并改正（复跑 `grep -m1 "^ℹ tests" /tmp/t685.log`）。⚠️ NOT RUN：探针没有"窗口右缘右键 → 量菜单矩形"那一格（已登记为下一格运行时判据，与 §6.69 窄窗遮挡同族）；动应用码 ⇒ Version-Bump 欠账再加 §6.85 |
| 58 | **暂缓替换 / 阻塞（见 §6.86）** | 试着给 §6.85 那句"贴边内收归 Reka"补运行时凭据：新段 `--only=menufit` 在 420×640 视口装真菜单 `FriendContextMenu.vue`（不装裸外壳 —— 无 slot 内容会量到 0×0 让"在视口内"空转），把锚点放到右下/左上/右上量四边 | `install` 回 `{ok:true, cmp:'…/FriendContextMenu.vue', pinia:true}` 但 `querySelector('.gosslan-menu')` 取不到 ⇒ 四格全红 0/4 退码 1。判为**夹具能力缺口**而不是产品缺陷（同一段代码在应用里天天能弹出来），差别在"组件被单独挂在裸 host 上" | ⚠️ **摘掉了**：`want()` 在全量跑里恒真，留着就是给整套探针钉四格必红 —— 用"大家都红"换自己一条未验主张，规则七.5 不允许。摘除按注释边界逐字节做，并复跑上一条刚建的 `--only=layoutstore` **3/3 退码 0** + `node --check` 通过，证没连带伤到它。⇒ §6.85 那句"库真的会收"目前只有静态凭据（外壳 `:collision-padding="8"` + side/align/offset 齐全 + 全仓唯一外壳被 `contextMenuReka.test.ts` 钉着）。**下一批的具体读法**：别挂菜单组件本身，挂它的父级（`ConversationList` 需要 store 里有数据，或给 `H.install` 加带 slot/provide 的入口），或走真实窗口取证。本批只动 `scripts/` 与文档 ⇒ 不产生 Version-Bump 欠账 |
| 59 | **先红后绿的修复（见 §6.87）** | 首屏脚本剩下那半个「一抛全跳」：§6.82 只把五枚键改成逐键兜底，外层 try 仍罩着脚本后半段（`matchMedia` / `navigator` / `el.lang` / `document.title` / `is-mac`） | `mode` 的默认值是 `system` ⇒ 从没在设置里选过亮暗的大多数首帧恰好要走那条会抛的分支（旧 WebView 没这个 API、受限环境访问就抛）。一抛就把主色、字体、语言、标题、macOS 标记一起带走 ⇒ "深色没闪，但整屏出厂蓝 + 系统字体 + 英文标题 + 38px 骨架标题栏"，且没有任何一层报错。旧注释那句"不影响后续"本身就是错的 | 删掉外层 try，五件事各一个 `bootStep(fn)`；问不到系统偏好时按浅色。`readBootLS` 与五枚裸字面量一个字没动 ⇒ §6.46/§6.82 的跨载体核对不受影响（现数 `readBootLS` 仍 6 = 1 定义 + 5 枚键）。★替身环境加 `matchMediaThrows: true 或 "missing"` 两种世界，**改脚本前 18/19 退码 1**、红在「抛错时主色必须照样落地」，改后 **19/19 退码 0**；用例自带正控（可用时仍要点亮 dark）否则"全关掉"也能骗绿。`npm test` **1116/1116 fail=0**、`verify:local` **22 步全通过 69.4 s 退码 0**（这层真的把脚本内联进三份 HTML 再构建）、`grep theme-boot scripts/guard_cases/*.py` 现读 0 命中 ⇒ 护栏锚点没被挪走。⚠️ NOT RUN：哪一版 WKWebView/WebView 真没有 `matchMedia`、受限环境访问 `navigator` 抛不抛 = 装机判；动 `src/boot` ⇒ Version-Bump 欠账再加一格 |
| 60 | P1 | 只读面板的「手写 loading 三件套」一次数完（7 格，全扫 88 个 .vue） | 这是同一形状的第七份抄本；先挑没有写路径、没有主体可分键那一格交出去，顺带验 `utils/panelQuery` 这个家能不能容纳全局单键 | `npm test` 1122/1122、`npm run verify:local` 22 步 70.1s、三发单点变异各红一格（`bash /tmp/mut690.sh`）；真实界面 NOT RUN（诊断面板三态要人眼看） |
| 61 | P0 | 移动端弹窗顶部被刘海/状态栏压住（用户实测）：两套让位口径收成一枚出口 | 卡片弹窗的让位此前只有 16px，而移动端那枚桌面变量恒 0；同一趟读出预览工具条把 caption 算了**两遍** | `npm run build` 退 0、探针 `lightbox` 9/9（先红读数 delta=60）与 `overlay` 41/41、判据 ㊿ 4 条 + 四发变异（含反向那发）；`env()` 那半 NOT RUN（只能真机） |
| 62 | P0 | PC 栏与移动端那 4 枚导航图标收进单一家；BackArrow 的手抄路径还给 lucide | 造型各写两遍、`:fill` 绑定抄四遍（漏一处＝用户报的那格）；库里已有 `chevron-left` 又被逐字抄了一遍 | `npm test` 1130/1130、`npm run build` 退 0（2898 modules）、designGuards 175/175、探针 `--only=navicon` 6/6 与 11 发变异各点住对应格（文本 4 + 运行时 5 + 判据 51 两发）、内联 `<svg>` 的家现算 2 个；真机观感 NOT RUN |
| 63 | P0 | 「这条窗有没有自绘 caption」的键从布局档改挂 TitleBar 自己写的类（窄辅助窗不再压住标题栏） | 同一事实两处各判一次：CSS 按 `is-mobile` 猜有没有 caption，而画不画看 `TitleBar` 的 prop（`AuxWindowShell`/`LogViewer` 都不传）⇒ 日志窗默认 760 宽就中招，预览工具条落进标题带底下 | `npm test` 1132/1132、designGuards 177/177、`npm run verify:local` 22 步 81.9s、探针 `--only=caption` 12/12 + 三发变异各红 1/4/3 格（含一发我自己否掉的假证据）；真机窄窗观感 NOT RUN |
| 64 | P0 | 输入框里「回车 = 提交」不让输入法先行（§四.1）：家（useImeEnterGuard）修过一次这个坑、规矩就写在自家文件头，但 12 处可编辑绑定只有 3 处接上 ⇒ 另外 9 处（群名 / 任务标题 / 自定义分类 / 链接名 / 昵称这些注定打中文的自由文本）在拼音选字那一下就把半成品存进库 | 家加一个 `enter(fn)` 出口（要事件的两处仍走 `isIme`），9 处接线各补两条 composition 绑定；判据 53 把这条规矩从「这个文件里有没有」升成「全仓 0 例外」 | npm test 1135/1135、designGuards 180/180、verify:local 22 步 81.7s、探针 --only=imecommit 5/5；四发变异各红 3/2/4 格 + 摘一处接线红判据 1 条；iOS WKWebView / Android WebView 的真输入法顺序 NOT RUN（浏览器里事件是合成的） |
| 65 | P0 | 全量 UI 探针「分层返回」那三条判据量错了维度（`history.length` 是**整个标签页**的条目总数）：单独跑 `overlay` 绿、带上前一段 `lightbox` 就红 —— 而卡死那一趟只说"45 s 没回包"，归因只能靠二分 | 二分本身给过假结论（我一度把它判成"被前一段污染"）；`history.length` 还会饱和、有前进条目时被导航截断，它从来不是"我们压的那一条"。一条不知道死在哪格的判据既挡不住回归，又把下一趟的归因带偏 | 改读 `history.state.gosslanBackLayer`（`utils/backStack.ts` 每份文档自己从 1 起的那枚标记）后 `--only=lightbox,overlay` **51/51**、`--only=overlay` **42/42**；两发单点变异各点自己那面（一条都不压 ⇒ 13/15 红在「A 打开」；一次压两条 ⇒ 40/42 红在「A 后退」+「C 连开关」），两发都按 sha 逐字节还原（MATCH ×2、`grep -c MUTANT` → 0）；`npm run verify:local` 22 步退 0（74.2 s，`npm test` 1135/1135）；⚠️ 超时自述与 SIGKILL 升级两支**未被真实卡死触发**（本轮没复现），真 WebView 的 history 行为 NOT RUN |
| 66 | P0 | 菜单贴边那一格拿到运行时凭据（§6.86/§6.88 欠的那格）：探针改按「挂父级、靠状态渲染」的配方挂**业务**菜单 + 390×844 窄视口量真实几何 | 静态凭据（外壳 `:collision-padding="8"` + side/align/offset 齐全）只证明"写了配置"，不证明"在 390 宽的右下角真的收进来了"；且贴边只有一个 owner（`ContextMenu.vue`，会话/联系人两个入口共用）⇒ 量这一处就够，不必每入口各写一份 | 单点变异打在**生产码**上（`ContextMenu.vue` 加 `:avoid-collisions="false"`，Reka 默认 `true`）⇒ `--only=menufit` **EXIT=1、3/9 绿**，实测读数：会话 right=612/bottom=972（右溢 222 px、下溢 128 px）、联系人 right=634/bottom=950（右溢 244 px、下溢 106 px）、说明行 `.gosslan-menu-hint` hintsInside=false（视口 390×844）；`cp` 还原 ⇒ sha256 `f78a9b3c…5178515b783`、`diff -q` MATCH、`grep -c avoid-collisions`=0，复跑 `--only=menufit,ctxmenu` **EXIT=0、21/21**；并进全量：`node scripts/check-ui-runtime.mjs`（全量、退码裸取）**EXIT=0、488/488 绿**，`menufit` 9 格在全量顺序下同样全绿（不依赖前段残留）；⚠️ NOT RUN：只剩真机 iOS WKWebView / Android WebView 与真实 Tauri 窗口那一格 |
| 67 | **P1** | `LinksList` 连读带写一起交给 TanStack Query（§6.90 欠的第二格） | 三条写命令各自把后端返回的**整份数组**回填同一个 ref ⇒ 只迁读的那半边就是"套一层库、旧实现全留"；读写一起交出去才删得掉 `links`/`loading`/`loadError`/`saving` 四枚手写 ref + `onMounted` + `try/finally` | 读侧 `["links",""]` 走 `panelQuery`、三条写命令共用一枚 `useMutation`（成功 `setQueryData` 写回同一键）；单测 +2 格、存量登记册 6→5；探针 `links` 段 6→10 格（`H.linksStore` 内存表驱动真浏览器增/改/删，每条同时断"发的是那条命令 / 列表立刻变 / list 调用次数不变"；第 10 格同页挂 ToastHud、让 add 真抛一次 ⇒ 断 error toast 真的上屏且草稿/列表没被当成成功）；两发单点变异：删 `setQueryData` ⇒ **6/9**（`list=1`、rows 仍是 2 条），换成 `invalidateQueries` ⇒ **6/9**（`list` 2→3→4、rows 却对 ⇒ 抓住它的是"次数不变"那半边）；sha `449058c3…9242d49` 还原后复跑 **9/9**；`npm test` **1137/1137**、`verify:local` **22 步**（首跑 76.4 s / 复跑 65.3 s）；全量并进：`node scripts/check-ui-runtime.mjs` **EXIT=0、492/492、6 分 12 秒**（488+4；中途一次 273/274 是探针自身被遮挡的 45 s 无回包，补 `Page.bringToFront` 后复跑全绿，未改任何断言）；⚠️ NOT RUN：真机（iOS WKWebView / Android WebView / 真实 Tauri 窗口）里的增删改 |
| 68 | **P1** | 诊断面板三态拿到真浏览器判据（§6.90 的 NOT RUN 之一） | §八 清单里唯一还能自动化的一项；此前只能由人眼复看 | 新增 `diag` 段 4 格（加载中 / 有数据 / 刷新失败保留旧数据 / 冷启动失败反控），夹具 `H.diagDeferred` 可控 resolve/reject；**两发单点变异都没咬住**（`&& !diag` 与模板顺序互为等价变异）⇒ 两点变异才红（3/4，旧读数被「诊断数据读取失败」换掉、calls 1→3）；还原 sha `b9f9381a…342d18fd` 后复跑 4/4；并进全量：**EXIT=0、496/496**（492+4）；⚠️ NOT RUN：真机；刷新按钮用 DOM click（只量三态、不量命中区） |
| 8 | **暂缓** | 前端最长四份文件的拆分 | 前一轮判为纯搬家、短期只降稳定 | — |

## 5. 未验证 / 风险

- **真机**：Windows WebView2、Android、iOS 全部 NOT RUN（需要用户设备与授权）；Linux 运行时 NOT RUN。
- **预览窗口**（`components/window/PreviewWindow.vue`）的真实 WKWebView 点击仍 NOT RUN。
- **跨进程 E2E**：并行会话在用同一 `src-tauri/target`，本轮不起。
- **最长门禁**「护栏非空转」整链按本地策略不在本地起（归发版前 / 远端 CI）。
- **英文文案**（这条已由 §6.42 收口，旧表述是"第 1、2 项落地前存在成片中文残留"）：现在唯一还绕开词典的
  用户可见中文是会话预览那一族 14 档标签（`messages.ts` 12 + `mergeCard.ts` 2），它同时是存储/协议面 ⇒ 判**暂缓**。
  ⚠️ 另一半前提仍未解除：`errors.ts`/`filePreview.ts`/`mediaAvailability.ts` 里剩下的中文是**匹配后端错误串的分类判据**，
  要说全英文得先让后端给结构化错误码（协议面，不在本专项动）。
- ~~"延迟镜像"这一档的运行时覆盖还差两格~~ **已补齐（§6.48）**：`AddFriendModal`、`message/ForwardModal.vue`、
  `ConversationList.vue` 的通讯录姓名过滤三格都有真 DOM 挂载段（探针 `friendfilter` / `forwardfilter` / `contactfilter`），
  三格共用一套时间阶梯且**各自能红**（一次改三格派生读原值 ⇒ 恰好 6 条红、每段红的都是那两条时间判据）。
  ⚠️ 更正此前清册的措辞：这一族没有独立的"联系人页"组件 —— 两处调用面是 `ForwardModal`（`refDebounced` 直连）
  与 `ConversationList:53`（`useSearchKeyword`），且会话栏那一格**按用户要求恒不过滤**，量派生必须挂 `view:"contacts"`。
- **触摸「滚动抢走长按手势」那一格已有运行时判据，但只在这台 Chrome 上量过**（§6.53 更正 §6.51）：
  探针的 `touchroster` 段本来就在用 `Input.dispatchTouchEvent`，本批又加了 `Input.synthesizeScrollGesture` 一条带位移的
  手势，实测 `cancel={"pointer":1,"touch":0}` —— **这台 Chrome 在滚动接管时发 `pointercancel`**。仍欠的是
  WKWebView / WebView2 / Android WebView 上到底发 pointer 还是 touchcancel；而且 §6.53 实测出这条结果由
  `pointercancel` 与 `pointerleave` **两个冗余出口共守**（少一个不改变结果），所以别的引擎若只发其中一种时
  行为是否仍成立，只有真机能答。
- **字体首帧已接上（§6.50），但"这台机器装没装那档字体"没盘过**：未安装时浏览器自己回退，界面不报错 ⇒
  "选了思源却仍在系统栈上"目前没有读数；真机首帧（选非默认字体的第一帧）同样 **NOT RUN**。
- **存储键名判据只比名字、不比值**（§6.46）：语言那一格已由 §6.47 补成逐例对照；`themeColor` 那一格 §6.49 之后
  已经是**完整一套**（派生三档由 CSS 跟着主色现算），但**值本身没有校验也没有 TS 侧口径对照** —— 脏值原样进
  `--gosslan-primary`（CSSOM 会忽略非法值，后果是那次覆盖静默不生效，不是崩）；"两边同时改成同一个新名字"这种漂移
  判据也看不见 —— 那是存量迁移问题，不是键名一致性问题。真机首帧外观/语言仍 **NOT RUN**。
- **`-hover` 那一档的白字对比度是契约空白**（§6.49 登记，未动）：它朝白混（更浅 ⇒ 白字更低），12 个组件拿它当 hover 底，
  而 `tokenContrast.ts` 的配对表里没有这一行（danger 的 hover 有）。补这行必然要把主色 hover 改成朝暗混 ——
  那是全应用按钮 hover 的观感方向变化，属负责人判的事，不在整改批里替产品定。
- **`localStorage` 抛错那一路两份实现行为不同（§6.47 只登记，未重构）**：首屏脚本一个 `try` 包全局 ⇒
  隐私模式下 `el.lang` 与 dark 类都不写，而 i18n 会继续按系统语言判定。要修得先把脚本拆成分段兜底，
  而拆分本身没有真机读数支撑（WebView2 / WKWebView 的隐私模式行为未验）⇒ 判**暂缓**。
- **快速层第 9 步曾红过一次，但不是本专项的码**（2026-10-19 现读）：`scripts/verify-guards.py:405` 被写成带字面
  `\n` 的一行 ⇒「判据脚本自身可解析」SyntaxError；该文件与 `guard_cases/file_transfer.py` 都在并行会话的
  未提交改动里（最后提交 `677735c`），本专项一字未动也不替对方改 ⇒ §6.46/§6.47 当时按"第 1–8 步绿 +
  单测 / vue-tsc / 构建 / 文档门 / 版本与预算现算绿"记录。**§6.48 收尾复跑：并行会话已修好，`npm run verify` 17/17、32.9s。**
- **真机「减弱动态效果」两态读数没取**（§6.52）：macOS 系统设置 → 辅助功能 → 显示 → 减弱动态效果，
  需要在打开/关闭两态各收一次「收到强提醒时窗口抖不抖」。CDP 探针帮不上 —— 它跑在没有 Tauri 的页面里，
  `api.shakeWindow()` 那条 IPC 命令根本不存在，所以这一格只能真机补。Windows 桌面腿同样未跑。
- **`requestAttention`（macOS Dock 弹跳 / Windows 任务栏闪烁）本批判为不门控**（§6.52）：
  它是门掉窗口抖动之后唯一还留着的后台感知通道，门掉它等于桌面端收到强提醒完全没有感知。
  这是一条**替产品作的判断**，负责人可随时推翻。
- **清单段的分母是「已跟踪文件」，不是工作树**（2026-10-19 现算）：`node scripts/frontend-inventory.mjs` 用 `git ls-files src` ⇒ 打印 生产 203 / 测试 95 = 298 份；而 `find src -name '*.test.ts' | wc -l` = **97**、非测试源码 **208** 份（合计 305）。差的 7 份就是这 38 批里**新建但从未 commit** 的模块（含本专项新增的 utils 与用例）。⇒ 读那一段时按"已入库口径"读；要工作树口径就现跑上面两条命令并排看。
- 并行会话归属：`src-tauri/**` 与 `docs/architecture/backend-modernization.md` 不碰。

## 6. 交付五问的直答（现算，复跑命令逐条挂着）

> 这一节只回答"结论"，每个数字后面都跟着它自己的现算命令 —— 抄进来的一次就漂一次。

**① 哪些通用能力已经交给成熟库、真正删掉了哪些旧实现？**
锚定浮层（Popover/HoverCard/Dialog/Menu/Select/Switch/RadioGroup/Slider/Toast/Focus）交给 reka-ui，
自研的摆位与"点外面/Esc"实现连同其测试一起删；只读面板的服务端状态交给 @tanstack/vue-query
（`panelQuery/groupFilesQuery/shareTreeQuery` 三格，手写 loading+error+refetch 那套删掉）；
长列表交给 @tanstack/vue-virtual；日期文案交给 dayjs（自研星期名数组与手写分桶删掉）；
运行时数据校验交给 zod/mini（表单侧手写的 `if (trim().length===0)` 那批删掉）；
剪贴板写入与老 WebView 回退交给 @vueuse/core（`LogViewer` 自己抄的那份"copied + setTimeout 复位"删掉）；
图标统一回 lucide-vue-next 的一份导出面。
复跑：`grep -n "reka-ui\|vue-query\|vue-virtual\|dayjs\|zod/mini\|@vueuse/core\|lucide" docs/architecture/frontend-inventory.md`

**② 哪些重复的函数/组件/状态真的合并或删除了？**
五份手抄的"同键在途去重"并成一个家 `src/utils/singleFlight.ts`（预览那 4 份 + 群任务补读那 1 份；
顺带修掉其中一份的错位摘除）；
复制反馈两份并一成（`composables/useClipboard.ts`）；预览字节缓存一份 `blobLru`（此前各处各有一份 Map）；
时间文案两份并一成（`utils/time.ts`，`chatStyle.ts` 里那 10 个硬编码中文串删掉）；
通知正文与日志标题从写死中文改走 vue-i18n；长度上限从"输入框常量 + schema 常量 + 提示里的数字"三份并成一份；
**10 处手抄在模板里的 `maxlength="数字"`（8 个组件、同一概念三种不同值）全部改成领域里的具名常量，并由
`utils/textLimits.test.ts` 与 Rust 侧的 `const …: usize` 现读对账**（§6.39）；
主题色三档派生从「JS 算一份 + `:root` 硬编一份近似值」并成 CSS `color-mix()` 一份，`lighten/darken/mix` 随批删除（§6.49）；
"默认字体栈"从四处（token 值 / JS 兜底串 / 骨架写死 / 选项字面量）收到两处（token + 骨架的必要兜底）（§6.50）。
「减弱动态效果」这条媒体查询从「`haptics.ts` 自己一份」收进 `utils/platform.ts` 一个家，并由 `platform.test.ts` 现扫生产码钉住不许出现第二份手抄（§6.52）。
手写「至少隔 N 才放行」的闸门 5 份并成 `utils/defer.ts` 的 `shouldRunThrottled` 一份（同轮把语义相反的 6 处逐格判成不并，§6.55）；「昨天/近 7 天」这一族曾有**两套算法**（`chatSearch.ts` 拿 86 400 000 毫秒加减 vs `utils/time.ts` 的 dayjs 日历法），夏令时地区筛漏一小时 —— 统一到日历法（§6.56）；「注册↔卸载」这一族曾有 **4 个家**（3 份手抄迟到守卫 + 2 处根本没有守卫），现全部并回 `utils/initScope` 一个家、**10 份生产文件在用**（§6.59/§6.60，判据 ㊷）；手抄的 `sleep`（Promise+setTimeout）2 份并成 `defer.ts` 一份，`setTimeout(fn, 0)` 当「等这一拍」用的 2 处改回 Vue 自己的 `nextTick`（§6.61）。
「单条预览字节上限」曾有 **6 份手抄**（前端 3 + Rust 侧 `.min()` 3），前端收成 `IMAGE_PREVIEW_MAX_BYTES` 一个家、两侧同值改由源码文本现读对账（§6.62）；「时间分割线的 5 分钟阈值」与那句判定各有**两份**（渲染端 `useMessageDisplay` + 估高端 `messageHeight`），连数字带函数一起收进 `previewMetrics.shouldShowTimeDivider` 一个家 —— 这一格本仓两份头部都写着「两边必须来自同一套常量与同一个判断函数」，却只有它没人管（§6.63，判据 ㊸）。
复跑（预览上限那个家）：`node --test --experimental-strip-types src/utils/imageBytes.test.ts` **9/9**，里面那条跨语言对账现读 TS 与 Rust 两侧文本、分母下限 3。
「群聊昵称行」那条规则曾有**两份写法**（估算端带 tip 闸门、渲染端不带，靠模板 v-if/v-else 暗合），并成 `messageKinds.shouldShowNickname` 一个家（§6.64）。
复跑（分割线那个家）：`node --test --experimental-strip-types src/utils/designGuards.test.ts` **157/157**（判据 ㊸：现扫 205 份生产文件违规 0 + 反向 importers ≥ 2 + 夹具正控 3/反控 4）。
合并之外还有一类"重复"是**同一个几何量在两个地方各算一遍**（渲染 ↔ 估高），本专项给它配的量具是差值对照而不是像素常量：`node scripts/check-ui-runtime.mjs --only=rowpair` **14/14**（四档间隔判分割行的出/不出 + 「估高差 == 画出差」两条 + 两条非空转；实测 32 vs 32.5、18 vs 18，读数直接印在 `高度实测表` 那行里，§6.65）。

"重复"还有第三个方向是**留着没人用的东西**：词典里定义了却全仓引不到的文案，既有三条 i18n 判据全是正向的（调用点 → 词典），没有一条问反向。本批把反向补齐成判据并删掉现扫的 **41 条**（中英各 41 行 = −82 行非业务文案码）：`node --test src/i18n/index.test.ts` **19/19**，判据自打印 `词典 985 键 / 引用面 15588 个字面量 / 可达前缀 492 个 / 死文案 0`（§6.67）。这一批的代价全在量具上：引用面提取器返工三次才吃得到 `:label="t('a.b')"` 这种**嵌套引号**（单遍扫描会把它包住的 key 整个咽掉，一度把 94 条在用文案报成死的），而判据**自己的文档注释**举了个 ``t(`diag.${k}`)`` 的例子，于是造出 `diag.` 前缀把整族 `diag.*` 洗白 —— 注释里的字面量也算引用面，量具会读自己的说明。
复跑：`grep -rn "new Map<string, Promise" src --include="*.ts" | grep -v "\.test\.ts" | grep -v "utils/singleFlight.ts" | wc -l`
（现算实得 **1**：只剩 `useChatStore.ts:1294` 那一格，它是**判过之后故意留下的**，理由见下一条与 §6.38）
复跑（注册↔卸载那个家）：`grep -rl "createInitScope(" src --include="*.vue" --include="*.ts" | grep -v ".test." | grep -v "utils/initScope.ts" | wc -l` 现算 **10**；手抄卸载句柄与手写迟到守卫现扫 **0**（`node --test --experimental-strip-types src/utils/designGuards.test.ts` 里的判据 ㊷，含 4 条正控 + 2 条反控）；手抄 `sleep` 现扫 **0**（`node --test --experimental-strip-types src/utils/defer.test.ts`，`useChatStore.ts:684` 那处 `setTimeout(flushNow, 0)` 是宏任务边界的批量冲刷，不在这一族）。

**③ 哪些仍是自研，为什么不能直接替换？**
虚拟列表外壳、`defer`、长按/滑动、全局快捷键、`mitt` 之外的事件总线 —— 逐条在 §2 有理由，共同点是
"现成库要么不提供这套节流/手势参数/窗口模型，要么换过来要把已钉的真实缺陷判据拆掉"；
预览**缓存**那层（按字节封顶 + 淘汰时 revoke objectURL）Zod/Query 都没有这一维；
`useChatStore.loadingMore` 那格在途表**判成保留自研** —— 容量闸门夹在"并入在飞"与"登记"之间、
摘除写成 `page.finally(...)` 挂在链上（让 reject 不变成 unhandled rejection，同时所有 await 方各拿同一次结果），
这两条行为**没有判据兜着**，强并等于拿实测过的翻页定位行为换 6 行；已由 `singleFlight.test.ts`
反向钉住（将来谁并进去而没先补行为判据 ⇒ 测试红）；
触觉这一路不换 VueUse 的 `useReducedMotion()` —— 它返回 `ref` 且把监听挂在 effect scope 上，而 `haptic()` 是被 6 个调用点直呼的普通函数：在模块顶层调 composable 会留一个永久监听（比现状更差），把 `ref` 一路传进工具函数则是为了用库再加一层；现版本每次读 `.matches`，零监听、零 scope、值也是活的（§6.52）；
裸脚本里仍要复制的那一半只剩"读存储 + 判亮暗/语言/平台"，因为它是**平台约束**（内联、必须早于 bundle）；
派生档与字体这两半已经交回 CSS token（§6.49 / §6.50），两边等价由 `appearance.test.ts` 现解析两边逐例判。全部理由与复算命令见 §2 与 §5。

**④ 前端是不是更好读/更好定位了？举三个具体例子。**
(a) 定位"图片时好时坏"以前要在三个预览模块里各读一遍 `get/set/finally`；现在读 `singleFlight.run`
一处，"跑完必须摘除"这条只有家、也只有家改了才会红。
(b) "超长为什么报成不能为空"这类缺陷从"没人知道"变成一条用例 + 一条护栏（`validation.test.ts`）。
(c) 注释指向的函数名现在会被判据对账（`readLocalAppearance` 那种"地图错三处"当场红）。

**⑤ 还有什么没解决、哪些平台没验？**
未做：会话预览那一族中文标签（`messages.ts` 12 档 + `mergeCard.ts` 2 档）—— Rust `protocol::preview_text` 算出的同一族要进存储/通知 ⇒ 属协议与存储面，记**暂缓**，理由见 §6.42；
`utils/errors.ts` 那一族本批已接进词典（§6.42），不再是欠账。
`GroupCreateModal`/`ProfileSection` 两格表单没有运行时探针段（§4 队列 4b）。
未验：Windows / Android / iOS 全平台；E2E 多实例（并行会话在跑）；真机 WKWebView 下的英文观感；
`verify:full` 最长那步（按你的口径留给 release/CI）；store 那两格的"三入口同时补读只打一次 IPC"
只有 helper 单测 + 接线判据，**运行中的实例里没验过**（探针挂不了 store）。清单在 §5。
复跑：`grep -n "NOT RUN\|未验" docs/architecture/frontend-inventory.md | head`

**本轮账目（全部现算）**：判定行 22 行（§2 五张表的数据行）；结论**提及**数（同一行可以同时提到两种结论，所以这组不等于 22）：直接替换 2 · 组合替换 9 · 局部复用 1 · 保留自研 11 · 暂缓替换 1 · 删除 1；
护栏非空转用例 **239 条**（`grep -h '^    Case(' scripts/guard_cases/*.py | wc -l`）；
前端断言 **1140 条**（`npm test` 自印）；快速门禁 17/17（`npm run verify` 自印）。
