# 产品三旅程验收基线与只读走查（2026-11-20）

> 来源：2026-11-20 设计评审（W3）落地项。三条旅程的定义出自该评审并被采纳为产品验收基线：
> **旅程 1** 首次发现设备 → 安全添加好友 → 发出第一条消息；**旅程 2** 对方离线时发送 →
> 本地排队 → 链路恢复后自动投递，用户回来能看到明确终态；**旅程 3** 收到文件 → 能找到 →
> 能打开 → 能知道是否完整。
>
> 性质：**静态只读走查**——未运行 UI、未真机/读屏验证（一律 `NOT RUN`）；「用户动作数」
> 从代码路径推算。文中 `file:line` 是 2026-11-20 快照，行号会漂，判现状以代码为准。
> 扩展功能（群任务/共享目录/拓扑）的 README 呈现分层**另行决策**，本文只给事实与建议。

## 1. 旅程 1：首次添加与第一条消息

### 1.1 现状分步

| 步骤 | 证据 | 现状 | 动作数 |
|---|---|---|---|
| 打开添加 | `src/components/ConversationList.vue:956-959`、`:1007-1009` | 会话空态直接给「添加好友」主按钮 | 1 |
| 发现设备 | `src/components/AddFriendModal.vue:317-338`、`:478-572` | 打开弹窗自动探测 + 通道开关就地摆放 | 0 |
| 发申请 | `src/components/AddFriendModal.vue:351-370`、`:555-570` | 点「加好友」→ 3s 冷却，行翻「等待对方同意/可取消」 | 1 |
| 对方确认 | `src/components/conversation/FriendRequestList.vue:68-88`；`AddFriendModal.vue:507-524` | 双侧确认均有 UI；申请事件进 `src/stores/useChatStore.ts:469-475` | 对方 1-2 |
| 我被接受 | `src/stores/useChatStore.ts:476-480`、`src/stores/chat/contacts.ts:144-147` | 只刷新数据，无 toast、无自动跳会话 | 0（被动） |
| 安全码核对 | `src/components/FriendProfile.vue:66-82`、`:194-220` | 双方一致的安全码（公钥派生），展示+复制 | 需自行进资料页 |
| 进入会话 | `src/components/ConversationList.vue:555-563`、`FriendProfile.vue:172-178` | 发现列表内已好友行直接变「发起聊天」 | ≥2 |

### 1.2 缺口

- **J1-1 接受后无引导**：`onFriendAccepted` 只刷新（`src/stores/useChatStore.ts:476-480`），
  无 toast、不自动打开会话；新用户要多走 2~3 步才能发出第一条消息。
- **J1-2 被拒绝无反馈**：`onFriendRejected` 只刷列表（`src/stores/useChatStore.ts:481-483`），
  i18n 无「对方拒绝了你的申请」文案（`src/i18n/locales/zh-cn.ts:1718-1727` 只有撤回/等待）；
  申请方只能看到「等待」消失。
- **J1-3 申请无超时终态**：出站态只有 `waiting`/`withdrawn`
  （`src/stores/chat/contacts.ts:121-133`、`src/types.ts:327`）。
- **J1-4 安全码核对无确认动作**：`FriendProfile.vue:194-220` 仅展示+复制，没有
  「我已与对方比对一致」的勾选，核对状态不入库（涉及安全语义设计，需产品裁决）。
- **J1-5 通讯录点好友只开资料页**：`ConversationList.vue:544-548`，发消息要多一跳。

### 1.3 亮点（保持，别在后续改动中破坏）

- 发现空态自带诊断与就地修复：四种「为什么没发现」原因（`AddFriendModal.vue:284-296`）+
  通道开关摆在失败现场（`:406-434`）+ 开通后自动重扫（`:275`）。
- 对方先加我时，发现列表行内直接出现同意/拒绝（`AddFriendModal.vue:507-524`）。
- 桌面+移动双空态都有下一步 CTA（`ConversationList.vue:930-991`、`:993-1019`）。

## 2. 旅程 2：离线排队与恢复投递

### 2.1 状态呈现

| 状态 | 证据 | 用户看到什么 |
|---|---|---|
| sending（在发） | `src/components/message/MessageReceipt.vue:369-377` | 单勾 + 小 spinner |
| 排队等对端 | `MessageReceipt.vue:360-368`；判据 `src/utils/sendWaiting.ts:11,23-31` | 单勾 + 静态时钟；悬浮 tooltip「等待对方上线：对方上线后会自动补发，这条消息最多保留 7 天」（`useMessageDisplay.ts:196`、`zh-cn.ts:1159`） |
| sent / delivered / read | `MessageReceipt.vue:380-401` | 灰单勾 / 灰双勾 / 主题色双勾 |
| failed（终态） | `MessageReceipt.vue:283-300`；tooltip `useMessageDisplay.ts:203-210` | 红色感叹号可点重发，hover 见原因（如「对方一直离线（已保留 7 天）」`zh-cn.ts:1034`） |
| cancelled | `MessageReceipt.vue:303-329` | 红/黄感叹号 |

后端语义：离线条目不判失败、保留 `OUTBOX_OFFLINE_HOLD_MS`
（`src-tauri/src/network/transport/outbox_sweep.rs:116,180-213`）；补发 Ack →
`onMessageAcked` 推进状态（`src/stores/useChatStore.ts:540-546`）；7 天判死写
`fail_code=SEND_RETRY_EXPIRED` 并 emit（`outbox_sweep.rs:48-59,236-244`）。

### 2.2 缺口

- **J2-1 排队中文案只在 hover tooltip**（`useMessageDisplay.ts:196`）：无 toast、无会话列表
  角标——离开屏幕的用户不知道消息在等。
- **J2-2 输入框不禁用也不提示离线**：`canSend` 只看草稿/图片
  （`src/components/chat/MessageComposer.vue:267,1631`）；对比共享目录页有离线横幅
  （`zh-cn.ts:1798`），聊天窗无对应物；在线状态仅会话列表点（`ConversationList.vue:440-449,917`）。
- **J2-3 补发成功零主动通知**：状态静默从时钟切双勾，无「对方回来了，N 条已送达」汇总。
- **J2-4 失败终态无 toast**：`message-failed` 到达只盖缓存（`useChatStore.ts:611-620`），
  对比 cancelled 有 toast（`:608`）；失败只能靠气泡图标被动发现。
- **J2-5 前 2 分钟「对方离线」与「正在发」视觉不可分**（`sendWaiting.ts:27-30`）。

### 2.3 亮点

7 天保留 + `fail_code` 终态 + 任务中心「对方离线，上线后会自动重试」
（`src/utils/taskCenter.ts:340`、`zh-cn.ts:2060`）——离线投递的**系统侧**闭环完整，
缺口集中在**呈现层**。

## 3. 旅程 3：文件的接收、打开与完整性

### 3.1 环节现状

| 环节 | 证据 | 现状 |
|---|---|---|
| 接收 | `src/components/MessageItem.vue:2084-2105`；`src/composables/useMessageFile.ts:59-67` | 文件卡片渲染；落盘路径只信台账 `file_transfers.path` |
| 进度/终态 | `src/components/message/MessageFileBubble.vue:141-210`；`src/utils/transferState.ts:11-49` | 进度条仅 active 态；failed/cancelled/queued/unknown 有文案与视觉分档；停滞双来源（后端 stall + 前端 60s 无进展，`useMessageFile.ts:129-164`） |
| 打开 | `src/utils/localFile.ts:30-46` | 桌面系统默认程序，Android 转 SAF 另存（.apk 例外）；仅图片有应用内 Lightbox（`MessageItem.vue:448-450`） |
| 找回 | `src/components/TaskCenter.vue:77,146-173`；`src/components/FavoritePanel.vue:110-116`；`src/components/GroupFilesPanel.vue:190,206-213` | 任务中心（进行中/失败可重试）、收藏、群文件三个入口；无统一「历史文件库」 |
| 完整性 | 后端 SHA-256 全量校验 `src-tauri/src/network/file/receive.rs:261-326,1365-1370`；文案 `src/utils/fileFailReason.ts:30-127` | 失败=「完整性校验失败，已丢弃」（`zh-cn.ts:1572`）；**成功无任何「已验证」标识** |
| 清理后 | 图片占位 `MessageItem.vue:2032-2049`；文件卡 `msg.cleaned` `useMessageFile.ts:220-228` | 有占位与确认文案（`src/components/settings/StorageSection.vue:69,145-152,263-270`） |

### 3.2 缺口

- **J3-1 续传无 UI 语义**：断点续传仅存在于后端（`receive.rs:163-235`；`.part` 保留
  `receive.rs:1186`），i18n 全库无「续传/继续接收」文案——恢复时用户只看到普通进度条，
  分不清「重收」与「续传」。
- **J3-2 接收失败无持久行**：1:1 接收失败「没有行可写」，只走一次性 toast
  （`src/stores/chat/media.ts:228`；`fileFailReason.ts:43-48` 注释自认）——toast 错过后
  聊天流里无痕迹、无重试入口。
- **J3-3 完整性成功不可见**：SHA 校验通过无 UI 信号，「完整」只能靠没报错来推断
  （`transferState.ts:36-48` done 不出文案）。
- **J3-4 哈希失败不可自愈于同一入口**：integrityFailed 终局丢弃；恢复仅靠 contentTransfers
  的「重新获取」，且只覆盖带 sha256 载荷的消息（`MessageItem.vue:186-194`、`:189-190`
  无 sha 即无重试按钮）。
- **J3-5 面板缺可用性探测**：消息气泡有 mediaPresent 探测（`useMessageFile.ts:191-228`），
  GroupFilesPanel/FavoritePanel 直接 openLocalFile，文件被清理后列表上无「已不可用」标记
  （`GroupFilesPanel.vue:202,213`）。
- **J3-6 非图片文件无应用内预览**：打开即跳系统程序，失败只有 toast
  （`localFile.ts:42-45`）；TaskCenter 只列进行中/失败任务，无已完成文件浏览。

### 3.3 亮点

SHA-256 全量校验 + 失败码到用户文案的完整映射 + 清理前确认/清理后占位——
「不完整的内容不会冒充完整」，这是正确的一半；缺的是**正向信号**（已验证、续传中）。

## 4. 缺口总表与建议层级（决策待定，本文不预设）

| 档 | 含义 | 条目 |
|---|---|---|
| A | 主路径内、低成本高收益，建议优先排 | J1-1 接受后引导、J1-2 拒绝反馈、J2-4 失败终态 toast、J3-3「已验证」信号 |
| B | 主路径体验、中成本 | J2-1 排队可见性、J2-3 补发汇总、J3-1 续传语义、J3-5 面板可用性探测 |
| C | 扩展层或需产品/安全裁决 | J1-3 申请超时态、J1-4 安全码确认交互、J1-5 直达会话、J2-2 输入框离线提示、J2-5 前 2 分钟可分性、J3-2 失败持久行、J3-4 哈希失败自愈、J3-6 统一文件库 |

扩展能力（群任务/共享目录/拓扑诊断）在三条旅程走查中**未发现阻塞项**——它们的问题
是入口层级而非功能缺失，README 呈现分层按本节事实另行决策。

## 5. 4b sweep：notes 状态一致性

- **发现 1 处索引漂移**：`docs/notes/platform-keychain-free-path-2026-11-15.md` 文档本体
  有状态横幅（Windows/Android 已实现、macOS 暂缓，`platform-keychain-free-path-2026-11-15.md:3`），
  但 `docs/AI_ENGINEERING_INDEX.md` 对应条目仍写「决策稿，未实现」⇒ 本次同提交修正。
- 其余带日期 notes 的索引条目均带状态标记（已实施 / 未实现待裁决 / NOT RUN 边界 /
  活契约 / 带日期快照），「日期 + 状态横幅 + 现状读 X」的仓库惯例运转正常。

## 6. 验证边界

静态只读走查；未运行 UI、未真机/读屏验证（`NOT RUN`）；动作数为代码路径推算；
`file:line` 为 2026-11-20 快照，判现状以代码为准（与本仓库其它带日期 notes 同一约定）。
