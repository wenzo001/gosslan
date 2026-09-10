/**
 * 本地化字典（简体中文 / 英文）。
 *
 * 骨架说明：本项目文案原本硬编码中文。这里建立字典 + t() 机制后，逐步把
 * 系统 UI 与设置页文案迁入。key 用层级命名（settings.* / nav.* / common.*），
 * 插值用 `{name}` 占位。
 */

export type MessageDict = Record<string, string>;

export const zhCN: MessageDict = {
  // ---- 通用 ----
  "common.cancel": "取消",
  "common.confirm": "确定",
  "common.clear": "清除",
  "common.notSet": "未设置",
  "common.chooseFolder": "选择文件夹",

  // ---- 导航栏 ----
  "nav.chats": "聊天",
  "nav.contacts": "通讯录",
  "nav.settings": "设置",
  "nav.lightMode": "浅色模式",
  "nav.darkMode": "深色模式",
  "nav.me.online": "我在线（局域网已连接）",
  "nav.me.offline": "离线（局域网未连接）",
  "nav.me.openSettings": "我，{status}，打开设置",
  "nav.chats.unread": "聊天，{n} 条未读",
  "nav.contacts.pending": "通讯录，{n} 条好友申请",

  // ---- 设置页主框架 ----
  "settings.title": "设置",
  "settings.group.appearance": "外观",
  "settings.group.profile": "个人资料",
  "settings.group.chatStyle": "聊天显示",
  "settings.group.chatStyle.footer": "我的消息用所选配色；对方也会按我的配色看到我发的消息（自动同步到已连接设备）。",
  "settings.group.network": "网络通道",
  "settings.group.network.footer": "选择网卡后即开启局域网通道并扫描节点；通道开启时可随时切换网卡。",
  "settings.group.storage": "存储",
  "settings.group.storage.footer": "本页只管「本机落盘的图片与文件」（聊天里收到的附件）和聊天数据库占用；聊天文字不会被自动清理。改动即时保存。保持「永久保存 + 无限制」即不做任何自动删除。",
  "settings.group.security": "安全",
  "settings.group.about": "关于",
  "settings.group.about.footer": "Gosslan v{version} · 无服务器 P2P · 端到端加密 · 数据仅存本机",
  "settings.group.notifications": "通知",
  "settings.group.notifications.footer": "应用在后台、或正在看别的会话时，用系统通知提醒新消息",
  "settings.group.share": "共享目录",
  "settings.group.share.footer": "允许好友浏览并下载你共享的文件夹内容",
  "settings.group.reset": "重置与数据",

  "settings.notify.enabled": "桌面通知",
  "settings.notify.enabled.desc": "关闭后不再收到任何新消息通知",
  "settings.notify.showContent": "通知显示消息内容",
  "settings.notify.showContent.desc": "关闭后只提示「收到新消息」，锁屏与通知中心不显示正文",

  "settings.share.folder": "共享文件夹",

  "settings.reset.restore": "恢复默认设置",
  "settings.reset.clearChat": "清除聊天数据",
  "settings.reset.footnote":
    "恢复默认不影响好友、聊天记录和设备身份。清除聊天数据会删除本机全部消息、会话与文件传输记录，并退出所有群聊（好友关系与设备身份保留）。",

  // ---- 语言切换 ----
  "settings.language.title": "语言",
  "settings.language.system": "跟随系统",
  "settings.language.desc": "跟随系统语言，或手动选择界面语言",

  // ---- 清除聊天数据确认弹窗 ----
  "settings.clear.title": "清除聊天数据",
  "settings.clear.warning": "将删除本机的以下内容，且无法撤销：",
  "settings.clear.item.messages": "所有聊天消息与会话（含群聊）",
  "settings.clear.item.transfers": "文件传输与群文件记录",
  "settings.clear.item.cache": "应用缓存",
  "settings.clear.item.groups": "退出所有群聊（群聊会从列表中移除）",
  "settings.clear.unaffected": "以下内容不受影响：",
  "settings.clear.item.friends": "好友列表",
  "settings.clear.item.identity": "设备身份与加密密钥",
  "settings.clear.item.profile": "昵称、头像与所有设置",
  "settings.clear.item.otherDevices": "其他设备上的聊天记录",
  "settings.clear.note": "清除后收到的新消息仍会正常接收。",

  // ---- 设置页操作 toast ----
  "settings.toast.shareSet": "共享目录已设置",
  "settings.toast.shareFail": "设置共享目录失败",
  "settings.toast.defaultsRestored": "已恢复默认设置",
  "settings.toast.chatCleared": "聊天数据已清除",
  "settings.toast.clearFail": "清除失败",

  // ---- 通知动作 ----
  "notification.markRead": "标记已读",
};

export const enUS: MessageDict = {
  // ---- Common ----
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.clear": "Clear",
  "common.notSet": "Not Set",
  "common.chooseFolder": "Choose Folder",

  // ---- Navigation ----
  "nav.chats": "Chats",
  "nav.contacts": "Contacts",
  "nav.settings": "Settings",
  "nav.lightMode": "Light Mode",
  "nav.darkMode": "Dark Mode",
  "nav.me.online": "Online (LAN connected)",
  "nav.me.offline": "Offline (LAN not connected)",
  "nav.me.openSettings": "My profile, {status}. Open settings.",
  "nav.chats.unread": "Chats, {n} unread",
  "nav.contacts.pending": "Contacts, {n} friend requests",

  // ---- Settings shell ----
  "settings.title": "Settings",
  "settings.group.appearance": "Appearance",
  "settings.group.profile": "Profile",
  "settings.group.chatStyle": "Chat Display",
  "settings.group.chatStyle.footer":
    "Your messages use the chosen colors. Friends see your messages in these colors too, synced to connected devices.",
  "settings.group.network": "Network Channel",
  "settings.group.network.footer":
    "Selecting an interface enables the LAN channel and scans for peers. You can switch the interface anytime while it's enabled.",
  "settings.group.storage": "Storage",
  "settings.group.storage.footer":
    "Covers locally saved images and files (attachments received in chats) and the chat database. Chat text is never deleted automatically. Changes save instantly; choose \"Forever + Unlimited\" to disable auto-deletion.",
  "settings.group.security": "Security",
  "settings.group.about": "About",
  "settings.group.about.footer": "Gosslan v{version} · Serverless P2P · End-to-End Encrypted · Data Stays on Device",
  "settings.group.notifications": "Notifications",
  "settings.group.notifications.footer":
    "Notify you of new messages when the app is in the background or you're viewing another conversation",
  "settings.group.share": "Shared Folder",
  "settings.group.share.footer": "Let friends browse and download the folder you share",
  "settings.group.reset": "Reset & Data",

  "settings.notify.enabled": "Desktop Notifications",
  "settings.notify.enabled.desc": "When off, you won't receive notifications for new messages",
  "settings.notify.showContent": "Show Message Content",
  "settings.notify.showContent.desc":
    "When off, notifications only show \"New message\" and hide the content on the lock screen and in Notification Center",

  "settings.share.folder": "Shared Folder",

  "settings.reset.restore": "Restore Defaults",
  "settings.reset.clearChat": "Clear Chat Data",
  "settings.reset.footnote":
    "Restoring defaults keeps your friends, chat history, and device identity. Clearing chat data deletes all local messages, conversations, and transfer records, and exits all groups (friends and device identity are kept).",

  // ---- Language ----
  "settings.language.title": "Language",
  "settings.language.system": "Follow System",
  "settings.language.desc": "Follow the system language or choose manually",

  // ---- Clear chat data confirm ----
  "settings.clear.title": "Clear Chat Data",
  "settings.clear.warning": "This deletes the following local data and can't be undone:",
  "settings.clear.item.messages": "All messages and conversations (including groups)",
  "settings.clear.item.transfers": "File transfers and group-file records",
  "settings.clear.item.cache": "App cache",
  "settings.clear.item.groups": "Exit all groups (removed from the list)",
  "settings.clear.unaffected": "The following are not affected:",
  "settings.clear.item.friends": "Friend list",
  "settings.clear.item.identity": "Device identity and encryption keys",
  "settings.clear.item.profile": "Nickname, avatar, and all settings",
  "settings.clear.item.otherDevices": "Chat history on other devices",
  "settings.clear.note": "New messages received after clearing will still arrive normally.",

  // ---- Settings toasts ----
  "settings.toast.shareSet": "Shared Folder Set",
  "settings.toast.shareFail": "Failed to Set Shared Folder",
  "settings.toast.defaultsRestored": "Default Settings Restored",
  "settings.toast.chatCleared": "Chat Data Cleared",
  "settings.toast.clearFail": "Clear Failed",

  // ---- Notification actions ----
  "notification.markRead": "Mark as Read",
};
