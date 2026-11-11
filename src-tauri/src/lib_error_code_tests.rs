// B6 试点批：命令返回值里的错误码（**只加码，不改 human**）。
//
// 这一批的契约是"码 + 原中文"，所以每条证据只守两件事：
// ① 产出点真的把码和那句原文绑在同一个 `coded(...)` 调用里（有人只改文案不带码 ⇒ 红）；
// ② `coded()` 的形状能被前端 `errorCode()` 解析（`code=<大写蛇形> 空格 <人话>`）。
//
// 为什么是源码守卫：这些分支要真触发得先有一份完整的 `AppState` + 特定的库/磁盘/射频状态，
// 本仓现有夹具到不了；而它们唯一会静默坏掉的地方就是"码在、但没跟原文绑在一起"。
// 触发条件 → 码 的对照写在下表里（命令、原文、码），人一眼能核对。

/// `(码, 相对 src/ 的文件, 原中文 human)`。
const B6_CASES: &[(&str, &str, &str)] = &[
    // ── 好友/消息（本笔）────────────────────────────────────────────────
    ("MSG_NOT_FOUND", "commands/chat.rs", "消息不存在"),
    ("MSG_NOT_FOUND", "commands/chat.rs", "要提醒的消息不存在"),
    ("MSG_NOT_FOUND", "commands/chat.rs", "要撤回的消息不存在"),
    ("MSG_NOT_FOUND", "commands/chat.rs", "要切换的消息不存在"),
    ("MSG_NOT_FOUND", "commands/files.rs", "消息不存在"),
    ("MSG_NOT_FOUND", "commands/helpers.rs", "消息不存在"),
    ("MSG_NOT_IN_CONV", "commands/chat.rs", "消息不属于该会话"),
    ("MSG_NOT_IN_CONV", "protocol.rs", "消息不属于该会话"),
    ("E2EE_ENCRYPT_FAILED", "commands/chat.rs", "密钥交换失败"),
    ("E2EE_ENCRYPT_FAILED", "commands/chat.rs", "加密失败"),
    ("E2EE_ENCRYPT_FAILED", "commands/mobile_picker.rs", "密钥交换失败"),
    ("E2EE_ENCRYPT_FAILED", "commands/mobile_picker.rs", "加密失败"),
    // ── 群管理（本笔）──────────────────────────────────────────────────
    ("GROUP_NOT_FOUND", "commands/groups.rs", "群不存在"),
    ("GROUP_NOT_FOUND", "commands/group_files.rs", "群不存在"),
    ("GROUP_NOT_FOUND", "commands/group_announcements.rs", "群不存在"),
    ("GROUP_NOT_FOUND", "commands/window.rs", "群不存在"),
    ("GROUP_NOT_FOUND", "commands/chat.rs", "群不存在"),
    ("GROUP_SELF_NOT_MEMBER", "commands/group_files.rs", "你已不在该群中"),
    ("GROUP_SELF_NOT_MEMBER", "commands/window.rs", "你已不在该群中"),
    ("GROUP_SELF_NOT_MEMBER", "commands/group_announcements.rs", "你不是该群成员"),
    ("GROUP_NAME_EMPTY", "commands/groups.rs", "群名称不能为空"),
    ("GROUP_KEY_MISSING", "commands/groups.rs", "群密钥缺失"),
    ("GROUP_KEY_MISSING", "commands/group_announcements.rs", "群密钥缺失"),
    ("GROUP_KEY_MISSING", "commands/window.rs", "群密钥缺失"),
    ("NUDGE_GROUP_UNSUPPORTED", "commands/window.rs", "窗口抖动只支持单聊"),
    ("MSG_NOT_FOUND", "commands/group_files.rs", "要提醒的消息不存在"),
    ("MSG_NOT_FOUND", "commands/group_announcements.rs", "消息不存在"),
    // ── 文件 / 设置 / 窗口（本笔）──────────────────────────────────────
    ("FILE_NOT_FOUND", "commands/helpers.rs", "文件不存在"),
    ("FILE_NOT_FOUND", "commands/helpers.rs", "文件不存在或不可访问：{path}"),
    ("FILE_NOT_FOUND", "commands/favorites.rs", "文件不存在"),
    ("FILE_NOT_FOUND", "commands/group_announcements.rs", "文件不存在或不可读：{e}"),
    ("FILE_NOT_FOUND", "open_path.rs", "文件不存在：{}"),
    ("CHANNEL_UNKNOWN", "commands/channel.rs", "未知通道: {channel}"),
    // ── B6 第二批：好友申请（本笔）──────────────────────────────────────
    ("FRIEND_SELF_REQUEST", "commands/mobile_picker.rs", "不能向自己发送好友申请"),
    ("FRIEND_ACCEPT_FAILED", "commands/mobile_picker.rs", "同意好友申请失败，请重试"),
    ("FRIEND_REQUEST_GONE", "commands/mobile_picker.rs", "好友申请不存在或已被对方撤回"),
    ("FRIEND_REQUEST_GONE", "commands/mobile_picker.rs", "好友申请不存在或已处理"),
    ("FRIEND_INVALID_CONTACT", "commands/mobile_picker.rs", "无效的联系人"),
    ("FRIEND_ALREADY_FRIEND", "commands/mobile_picker.rs", "已经是好友，无法撤回好友申请"),
    // ── B6 第三批：消息/会话（本笔）─────────────────────────────────────
    ("CANCEL_SELF_CHAT_UNSUPPORTED", "commands/chat.rs", "自聊消息不支持取消"),
    ("CANCEL_NOT_OWN_MESSAGE", "commands/chat.rs", "只能取消自己发送的消息"),
    ("CANCEL_FILE_USE_TRANSFER", "commands/chat.rs", "文件/图片请用「取消发送」的传输通道"),
    ("GROUP_RESEND_ONLY_FOR_GROUPS", "commands/chat.rs", "只有群消息支持按成员补发"),
    ("GROUP_RESEND_NOT_OWN", "commands/chat.rs", "只能补发自己在该群发送的消息"),
    ("RECALL_OWN_CONV_UNSUPPORTED", "commands/chat.rs", "不能撤回自己会话里的消息"),
    ("RENDER_UNSUPPORTED", "commands/chat.rs", "不支持的渲染方式"),
    ("RENDER_SELF_ONLY", "commands/chat.rs", "只能切换自己发送的消息"),
    ("RENDER_TEXT_CODE_ONLY", "commands/chat.rs", "只有文本/代码消息可以切换渲染"),
    ("RENDER_RECALLED", "commands/chat.rs", "已撤回的消息不能切换"),
    ("NUDGE_SELF_UNSUPPORTED", "commands/chat.rs", "不能对自己发起窗口抖动"),
    ("MESSAGE_KIND_UNSUPPORTED", "commands/chat.rs", "不支持的消息类型"),
    ("NUDGE_MISSING", "commands/chat.rs", "对应的强提醒不存在"),
    ("RESEND_USE_GROUP_DELIVERY", "commands/chat.rs", "群消息请用「按成员补发」"),
    ("RESEND_SELF_CHAT_UNNEEDED", "commands/chat.rs", "自聊消息不需要重发"),
    ("RESEND_SELF_ONLY", "commands/chat.rs", "只能重发自己发送的消息"),
    ("RESEND_KIND_UNSUPPORTED", "commands/chat.rs", "这种消息不支持原地重发"),
    ("RESEND_NOT_FAILED", "commands/chat.rs", "这条消息不是失败/已取消状态，不需要重发"),
    ("RESEND_ALREADY_DELIVERED", "commands/chat.rs", "这条消息已经送达或状态已变，不能重发"),
    ("SELF_CHAT_NO_MEDIA", "commands/chat.rs", "和自己聊天暂不支持图片或文件"),
    // ── B6 第四批：群管理（本笔）───────────────────────────────────────
    ("GROUP_INVITE_FRIENDS_ONLY", "commands/groups.rs", "只能把好友加入群聊"),
    ("GROUP_RENAME_OWNER_ONLY", "commands/groups.rs", "只有群主或管理员可以修改群名称"),
    ("GROUP_ADD_MEMBER_OWNER_ONLY", "commands/groups.rs", "只有群主或管理员可以添加成员"),
    ("GROUP_MEMBER_ALREADY_IN", "commands/groups.rs", "该成员已在群中"),
    ("GROUP_ADD_FRIEND_MEMBER_ONLY", "commands/groups.rs", "只能添加好友入群"),
    ("GROUP_REMOVE_OWNER_ONLY", "commands/groups.rs", "只有群主或管理员可以移除成员"),
    ("GROUP_REMOVE_SELF", "commands/groups.rs", "不能移除自己"),
    ("GROUP_REMOVE_OWNER_FORBIDDEN", "commands/groups.rs", "不能移除群主"),
    ("GROUP_MEMBER_NOT_IN", "commands/groups.rs", "该成员不在群中"),
    ("GROUP_APPOINT_ADMIN_OWNER_ONLY", "commands/groups.rs", "只有群主可以任命管理员"),
    ("GROUP_REMOVE_ADMIN_OWNER_ONLY", "commands/groups.rs", "只有群主可以撤销管理员"),
    ("GROUP_ADMIN_LIMIT", "commands/groups.rs", "管理员最多 3 个"),
    ("GROUP_APPOINT_ADMIN_NOT_MEMBER", "commands/groups.rs", "只能任命群成员为管理员"),
    ("GROUP_APPOINT_ADMIN_SELF", "commands/groups.rs", "群主无需任命自己为管理员"),
    ("GROUP_REMOVE_ADMIN_NOT_ADMIN", "commands/groups.rs", "该成员不是管理员"),
    ("GROUP_TRANSFER_OWNER_ONLY", "commands/groups.rs", "只有群创建者可以转让群主"),
    ("GROUP_TRANSFER_TO_SELF", "commands/groups.rs", "不能把群主转让给自己"),
    ("GROUP_TRANSFER_MEMBER_ONLY", "commands/groups.rs", "只能转让给群成员"),
    ("GROUP_OWNER_LEAVE_TRANSFER_FIRST", "commands/groups.rs", "群主退群前请先转让群主"),
    ("GROUP_FILE_KIND_UNSUPPORTED", "commands/group_files.rs", "群聊不支持该消息类型"),
    ("GROUP_TODO_TYPE_NAME_EMPTY", "commands/group_files.rs", "自定义类型名称不能为空"),
    ("GROUP_TODO_TYPE_ICON_INVALID", "commands/group_files.rs", "自定义类型图标不合法"),
    ("GROUP_TODO_TYPE_INVALID", "commands/group_files.rs", "任务类型不合法"),
    ("GROUP_TODO_TITLE_EMPTY", "commands/group_files.rs", "任务标题不能为空"),
    ("GROUP_TODO_ASSIGNEE_REQUIRED", "commands/group_files.rs", "请至少指派一名成员"),
    ("GROUP_TODO_STATUS_INVALID", "commands/group_files.rs", "任务状态不合法"),
    ("GROUP_TODO_PRIORITY_INVALID", "commands/group_files.rs", "任务优先级不合法"),
    ("GROUP_ANNOUNCEMENT_EMPTY", "commands/group_files.rs", "公告内容不能为空"),
    ("GROUP_ANNOUNCEMENT_ID_MISSING", "commands/group_files.rs", "公告标识缺失"),
    ("GROUP_REPLY_TARGET_MISSING", "commands/group_announcements.rs", "缺少目标消息"),
    ("GROUP_REPLY_TARGET_MISSING", "commands/group_announcements.rs", "回应缺少目标消息"),
    ("GROUP_REACTION_UNKNOWN", "commands/group_announcements.rs", "不认识的表情"),
    ("GROUP_FORWARD_FILE_NOT_OWNED", "commands/group_announcements.rs", "这个文件不属于这条消息，已拒绝转发"),
    ("GROUP_FILE_ONLY_PLAIN", "commands/group_announcements.rs", "只能发送普通文件"),
    ("GROUP_NO_OTHER_MEMBERS", "commands/group_announcements.rs", "群内没有其他成员"),
    ("GROUP_MEDIA_NOT_FILE", "commands/group_todo_media.rs", "不是文件"),
    ("GROUP_IMAGE_BYTES_INVALID", "commands/group_todo_media.rs", "图片数据格式不正确"),
    ("GROUP_IMAGE_EMPTY", "commands/group_todo_media.rs", "图片数据为空"),
    ("GROUP_IMAGE_PASTE_ONLY", "commands/group_todo_media.rs", "只支持粘贴图片"),
    // ── B6 第五批：收藏（本笔）─────────────────────────────────────────
    ("FAVORITE_EXPORT_PATH_EMPTY", "commands/favorites.rs", "导出路径为空"),
    // ── B6 第六批：设置/网络（本笔）───────────────────────────────────
    ("RELAY_ENDPOINT_FORMAT_INVALID", "commands/relay.rs", "地址格式应为 ip 或 ip:port，收到：{trimmed}"),
    ("RELAY_TOKEN_TOO_LONG", "commands/relay.rs", "访问口令过长（{} 字符，上限 {} 字符）"),
    ("ROUTED_IPV6_UNSUPPORTED", "commands/routed.rs", "暂不支持 IPv6 地址（当前 TCP 监听仅 IPv4）。请填写 IPv4，例如 100.64.0.1"),
    // ── B6 第七批：文件（本笔）─────────────────────────────────────────
    ("IMAGE_DATA_URL_INVALID", "commands/files.rs", "非法的 data URL"),
    ("IMAGE_BASE64_REQUIRED", "commands/files.rs", "只接受 base64 编码的 data URL"),
    ("IMAGE_NOT_IMAGE", "commands/files.rs", "只接受图片文件"),
    ("IMAGE_FORMAT_UNSUPPORTED", "commands/files.rs", "不支持的图片格式"),
    ("IMAGE_EMPTY", "commands/files.rs", "图片内容为空"),
    ("IMAGE_DECODE_FAILED", "commands/files.rs", "图片解码失败：{e}"),
    ("IMAGE_TOO_LARGE", "commands/files.rs", "图片过大（{} > {}），请压缩后重试"),
    ("IMAGE_TOO_LARGE", "commands/helpers.rs", "图片过大（{} 字节，上限 {} 字节），未保存"),
    ("IMAGE_SAVE_FAILED", "commands/files.rs", "图片保存失败：{e}"),
    ("IMAGE_SOURCE_MISSING", "commands/helpers.rs", "缺少图片来源"),
    ("FILE_DELETE_OUTSIDE_DOWNLOADS", "commands/files.rs", "只能删除下载目录或本机已发媒体目录内的文件"),
    ("FILE_NO_CONTENT_ID", "commands/files.rs", "这条内容没有内容指纹，无法取消"),
    ("FILE_NO_CONTENT_ID", "commands/files.rs", "这条内容没有内容指纹（对方版本较旧），无法重新获取"),
    ("FILE_NO_CONTENT_ID", "commands/files.rs", "这条内容没有内容指纹，无法重新获取"),
    ("FILE_NOT_OWNED_BY_MESSAGE", "commands/files.rs", "这个文件不属于这条消息，已拒绝转发"),
    ("FILE_NOT_OWNED_BY_MESSAGE", "commands/helpers.rs", "这个文件不属于这条消息，已拒绝保存"),
    ("OPEN_PATH_NOT_OWNED", "commands/files.rs", "这个文件不属于这条消息，已拒绝打开"),
    ("OPEN_PATH_UNVERIFIED", "commands/files.rs", "无法确认这个文件属于本应用，已拒绝打开"),
    // 2026-11-09：群文件面板恒红修复后，这里补上底层 err，方便区分真实读库故障；
    // 判据本身没放宽，仍要求这处触发点"码 + 原文"同现在同一 `coded(...)` 调用里。
    ("GFILE_MY_STATUS_READ_FAILED", "commands/files.rs", "群文件「我的状态」读不出来（transfer={} err={e}）"),
    // ── B6 第八批：外链 / 共享（本笔）───────────────────────────────────
    ("LINK_URL_EMPTY", "commands/external_links.rs", "网址不能为空"),
    ("LINK_URL_INVALID", "commands/external_links.rs", "网址格式不正确"),
    ("LINK_URL_SCHEME", "commands/external_links.rs", "网址必须以 http:// 或 https:// 开头"),
    ("LINK_URL_NO_HOST", "commands/external_links.rs", "网址缺少主机名"),
    ("LINK_NAME_EMPTY", "commands/external_links.rs", "请填写名称"),
    ("LINK_NAME_TOO_LONG", "commands/external_links.rs", "名称最长 {MAX_LINK_NAME_CHARS} 个字符"),
    ("LINK_URL_DUPLICATE", "commands/external_links.rs", "该网址已存在"),
    ("LINK_LIMIT_REACHED", "commands/external_links.rs", "最多只能添加 {MAX_EXTERNAL_LINKS} 个链接"),
    ("LINK_NOT_FOUND", "commands/external_links.rs", "链接不存在"),
    ("LINK_IMPORT_TOO_LARGE", "commands/external_links.rs", "导入内容超过 {} KiB 上限"),
    ("LINK_IMPORT_TOO_LARGE", "commands/external_links.rs", "导入文件超过 {} KiB 上限"),
    ("LINK_IMPORT_TOO_LARGE", "commands/external_links.rs", "下载内容超过 {} KiB 上限"),
    ("LINK_IMPORT_NOT_UTF8", "commands/external_links.rs", "下载内容不是 UTF-8 文本"),
    ("LINK_IMPORT_JSON_INVALID", "commands/external_links.rs", "JSON 格式不正确：需要链接数组或 { links: [...] }"),
    ("LINK_CLEAN_OUTSIDE_EXPORT", "commands/external_links.rs", "拒绝清理导出目录之外的路径"),
    ("LINK_DOWNLOAD_HTTP_FAILED", "commands/external_links.rs", "下载失败：HTTP {}"),
    ("SHARE_DIR_MISSING", "commands/share.rs", "目录不存在"),
    ("SHARE_NOT_FRIEND", "commands/share.rs", "对方不是好友"),
    ("SHARE_TIMEOUT", "commands/share.rs", "获取共享目录超时"),
    ("SHARE_NO_ROUTE", "commands/share.rs", "无法联系对方：没有可达的中继邻居"),
    // ── B6 第九批：日志诊断（本笔）──────────────────────────────────────
    ("LOG_READ_FAILED", "commands/logs.rs", "运行日志读取被线程池中断: {e}"),
    ("LOG_CLEAR_FAILED", "commands/logs.rs", "运行日志清空被线程池中断: {e}"),
    ("DIAG_EXPORT_JOIN_FAILED", "commands/logs.rs", "诊断包导出任务失败：{e}"),
    ("DIAG_EXPORT_PATH_EMPTY", "diagnostics.rs", "导出路径为空"),
    ("DIAG_EXPORT_WRITE_FAILED", "diagnostics.rs", "写入诊断包失败：{e}"),
    // 外链窗口在 `logs.rs` 里还有一处二次解析（同一句原文、同一个码）
    ("LINK_URL_INVALID", "commands/logs.rs", "网址格式不正确"),
    // ── B6 第十批：启动/窗口 / 资料 / 更新（本笔）──────────────────────────
    ("AVATAR_TOO_LARGE", "commands/system.rs", "头像过大，请压缩到 2MB 以内"),
    ("PROFILE_SAVE_FAILED", "commands/system.rs", "资料写入被线程池中断: {e}"),
    ("INTERFACE_LIST_FAILED", "commands/system.rs", "网卡枚举被线程池中断: {e}"),
    // 群发送内核：本机写库/入队共用 SEND_LOCAL_WRITE_FAILED（human 各自一句）
    ("SEND_LOCAL_WRITE_FAILED", "commands/window.rs", "逻辑时钟推进失败：{e}"),
    ("SEND_LOCAL_WRITE_FAILED", "commands/window.rs", "消息写入失败：{e}"),
    ("SEND_LOCAL_WRITE_FAILED", "commands/window.rs", "会话写入失败：{e}"),
    ("SEND_LOCAL_WRITE_FAILED", "commands/window.rs", "群消息入队失败：{e}"),
    ("SEND_LOCAL_WRITE_FAILED", "commands/window.rs", "群消息写入失败：{e}"),
    ("UPDATER_CHECK_WHILE_DOWNLOADING", "commands/updater.rs", "更新正在下载，稍后再检查"),
    ("UPDATER_CHECK_IN_PROGRESS", "commands/updater.rs", "更新检查正在进行"),
    ("UPDATER_ALREADY_DOWNLOADING", "commands/updater.rs", "更新已在下载"),
    ("UPDATER_NO_PENDING_UPDATE", "commands/updater.rs", "没有可下载的更新"),
    ("UPDATER_INSTALL_WHILE_DOWNLOADING", "commands/updater.rs", "更新仍在下载"),
    ("UPDATER_NO_UPDATE", "commands/updater.rs", "没有可安装的更新"),
    ("UPDATER_NOT_DOWNLOADED", "commands/updater.rs", "更新尚未下载完成"),
    ("UPDATER_CANCEL_AFTER_INSTALL", "commands/updater.rs", "安装已经开始，无法取消"),
    // ── B6 第十一批：启动失败窗口（本笔）──────────────────────────────────
    ("STARTUP_ALREADY_RECOVERED", "startup_error.rs", "应用已经恢复正常，无需再重试。"),
    ("STARTUP_RETRY_IN_PROGRESS", "startup_error.rs", "上一次重试还没有结束，请等它跑完。"),
    ("STARTUP_NO_PENDING_FAILURE", "startup_error.rs", "没有待处理的启动失败"),
    (
        "STARTUP_NO_PENDING_FAILURE",
        "startup_error.rs",
        "没有待处理的启动失败（这次启动不需要重试）",
    ),
    ("STARTUP_RETRY_POOL_FAILED", "startup_error.rs", "重试任务被线程池中断：{e}"),
    ("STARTUP_MAIN_THREAD_FAILED", "startup_error.rs", "恢复主线程调度失败：{e}"),
    ("STARTUP_DATA_DIR_READ_FAILED", "startup_error.rs", "数据目录读不出来：{e}"),
    // ── B6 第十二批：好友/群管理/收藏里漏网的原话（本笔）────────────────────
    ("FRIENDS_LIST_READ_FAILED", "commands/friends.rs", "好友列表读不出来：{e}"),
    ("GROUP_READS_LIST_READ_FAILED", "commands/groups.rs", "已读名单读不出来：{e}"),
    (
        "GROUP_TODO_TYPE_NAME_TOO_LONG",
        "commands/group_files.rs",
        "自定义类型名称不能超过 {} 字",
    ),
    (
        "GROUP_TODO_TITLE_TOO_LONG",
        "commands/group_files.rs",
        "任务标题不能超过 {MAX_TODO_TITLE_LEN} 字",
    ),
    (
        "GROUP_TODO_DESC_TOO_LONG",
        "commands/group_files.rs",
        "任务描述不能超过 {MAX_TODO_DESC_LEN} 字",
    ),
    (
        "GROUP_ANNOUNCEMENT_TOO_LONG",
        "commands/group_files.rs",
        "公告不能超过 {MAX_ANNOUNCEMENT_LEN} 字",
    ),
    ("GROUP_TODO_IMAGE_TOO_LARGE", "commands/group_todo_media.rs", "单张图片不能超过 {}MB"),
    (
        "FAVORITE_DELETE_BATCH_TOO_LARGE",
        "commands/favorites.rs",
        "一次最多删除 {MAX_DELETE_BATCH} 条，当前 {} 条",
    ),
    // ── B6 第十三批：群管理 reject 族（本笔）──────────────────────────────
    ("NUDGE_MISSING", "commands/group_files.rs", "对应的强提醒不存在"),
    (
        "GROUP_TODO_ASSIGNEE_NOT_MEMBER",
        "commands/group_files.rs",
        "{} 不是群成员",
    ),
    (
        "GROUP_TODO_ARCHIVE_STATE_INVALID",
        "commands/group_files.rs",
        "只有完成或标记为做不了的任务可以归档",
    ),
    (
        "GROUP_ANNOUNCEMENT_OWNER_ONLY",
        "commands/group_files.rs",
        "只有群主或管理员可以发布公告",
    ),
    (
        "GROUP_ANNOUNCEMENT_OWNER_ONLY",
        "commands/group_files.rs",
        "只有群主或管理员可以删除公告",
    ),
    (
        "GROUP_REMIND_TARGET_REQUIRED",
        "commands/group_files.rs",
        "请先选择提醒对象",
    ),
    (
        "GROUP_REMIND_TARGETS_GONE",
        "commands/group_files.rs",
        "提醒对象都已不在群中",
    ),
    // ── B6 第十四批：收藏 reject_favorite 族（本笔）──────────────────────
    (
        "FAVORITE_SOURCE_GONE",
        "commands/favorites.rs",
        "文件已不在本机（可能已被「存储清理」删除），无法收藏",
    ),
    ("FAVORITE_CONTENT_MISSING", "commands/favorites.rs", "内容不存在"),
    ("FAVORITE_PATH_ESCAPE", "commands/favorites.rs", "路径越权"),
];

/// human 是下层原话、没有字面量的触发点：只守"码真的挂在这里"，
/// 原文必须原样透传（由 `b6_does_not_stack_codes` 与 `coded_if_uncoded` 一起兜）。
const B6_DYNAMIC_HUMAN: &[(&str, &str)] = &[
    ("FILE_NOT_FOUND", "commands/files.rs"), // canonicalize 的 OS 原话
    ("TRANSPORT_START_FAILED", "commands/channel.rs"),
    ("CHANNEL_CACHE_CLEAN_FAILED", "commands/channel.rs"), // task join 的原话
    ("ROUTED_ENDPOINT_FORMAT_INVALID", "commands/routed.rs"),
    // 中继配置读取：地址/口令两处带的是底层读库原话，且同码两处 ⇒ 只守码挂在这里
    ("RELAY_CONFIG_READ_FAILED", "commands/relay.rs"),
    // 系统通知：权限被限制 / 发送失败的原话都来自平台侧，不能改写成固定文案
    ("NOTIFY_PERMISSION_DENIED", "commands/network.rs"),
    ("NOTIFY_SEND_FAILED", "commands/network.rs"),
    // 取本地媒体路径失败：human 是解析链给出的原因（可能已经带码）
    ("FILE_PATH_UNRESOLVED", "commands/helpers.rs"),
    // 外链 / 共享：human 来自底层 IO / 任务池原话
    ("LINK_LIST_READ_FAILED", "commands/external_links.rs"),
    ("LINK_IMPORT_READ_FAILED", "commands/external_links.rs"),
    ("LINK_IMPORT_POOL_FAILED", "commands/external_links.rs"),
    ("LINK_SAVE_FAILED", "commands/external_links.rs"),
    ("LINK_EXPORT_FAILED", "commands/external_links.rs"),
    ("LINK_CLEAN_FAILED", "commands/external_links.rs"),
    ("LINK_NETWORK_INIT_FAILED", "commands/external_links.rs"),
    ("SHARE_DIR_READ_FAILED", "commands/share.rs"),
    ("SHARE_SEND_FAILED", "commands/share.rs"),
    // 资料写库：human 是 db 层原话（可能已经带码）
    ("PROFILE_SAVE_FAILED", "commands/system.rs"),
    // 群待办编辑：human 由 `why` 变量拼出（可能已经带码）
    ("GROUP_TODO_EDIT_FORBIDDEN", "commands/group_files.rs"),
    // 收藏复制/存储读取：human 是下层原话
    ("FAVORITE_COPY_FAILED", "commands/favorites.rs"),
    ("FAVORITE_STORE_READ_FAILED", "commands/favorites.rs"),
];

/// B6 白名单命令的"未带码 return Err"存量基线（只减不增）。
///
/// 只守这 20 条试点命令，其余命令一律不参与 —— 免得一次全红。
/// 新增一条裸 `return Err(...)` 会让该命令的数字超过基线 ⇒ 红；
/// 把存量逐条补码后请**下调**对应数字（不允许上调）。
const B6_COMMAND_UNCODED_BASELINE: &[(&str, &str, usize)] = &[
    ("chat.rs", "cancel_message", 0),
    ("chat.rs", "recall_message", 0),
    ("chat.rs", "set_message_render", 0),
    ("chat.rs", "send_message", 0),
    ("chat.rs", "resend_message", 0),
    ("chat.rs", "mark_read", 0),
    ("files.rs", "open_file_native", 0),
    ("files.rs", "request_content", 0),
    ("files.rs", "send_file_auto", 0),
    ("group_files.rs", "send_group_message", 1),
    ("group_files.rs", "send_group_todo", 0),
    ("group_files.rs", "update_group_todo", 0),
    ("group_files.rs", "send_group_announcement", 0),
    ("group_files.rs", "delete_group_announcement", 0),
    ("mobile_picker.rs", "send_friend_request", 0),
    ("mobile_picker.rs", "respond_friend_request", 0),
    ("mobile_picker.rs", "cancel_friend_request", 0),
    ("groups.rs", "rename_group", 0),
    ("groups.rs", "group_add_member", 0),
    ("groups.rs", "group_remove_member", 0),
    ("groups.rs", "transfer_group_creator", 0),
    ("groups.rs", "leave_group", 0),
    ("channel.rs", "set_channel_enabled", 0),
    ("helpers.rs", "copy_file_to_clipboard", 0),
    ("helpers.rs", "copy_file", 0),
    ("helpers.rs", "read_file_preview", 1), // "TOO_LARGE" 是前端契约哨兵，保留不译
    ("helpers.rs", "save_media_as", 0),
    ("files.rs", "cancel_content_fetch", 0),
    ("files.rs", "request_content_by_cid", 0),
    // B6 第六批：设置/网络（命令名与 human 同上表；现在都是 0，锁住不回涨）
    ("network.rs", "focus_window", 0),
    ("network.rs", "send_test_notification", 0),
    ("relay.rs", "probe_relay_server", 0),
    ("relay.rs", "check_relay_server", 0),
    ("relay.rs", "get_relay_config", 0),
    ("relay.rs", "save_relay_config", 0),
    ("routed.rs", "add_routed_endpoint", 0),
    ("routed.rs", "remove_routed_endpoint", 0),
    // B6 第八批：外链 / 共享（同一口径：现在都是 0）
    ("external_links.rs", "list_external_links", 0),
    ("external_links.rs", "add_external_link", 0),
    ("external_links.rs", "update_external_link", 0),
    ("external_links.rs", "remove_external_link", 0),
    ("external_links.rs", "export_external_links", 0),
    ("external_links.rs", "cleanup_external_links_export", 0),
    ("external_links.rs", "import_external_links_file", 0),
    ("external_links.rs", "import_external_links_from_url", 0),
    ("share.rs", "set_share_dir", 0),
    ("share.rs", "set_downloads_dir", 0),
    ("share.rs", "open_downloads_dir", 0),
    ("share.rs", "request_share_tree", 0),
    ("share.rs", "download_shared_file", 0),
    // B6 第九批：日志诊断（三条 async 命令都已带码，锁住不回涨）
    ("logs.rs", "get_logs", 0),
    ("logs.rs", "clear_logs", 0),
    ("logs.rs", "export_diagnostics_bundle", 0),
    // B6 第十批：启动/资料（两条 async 命令都已带码，锁住不回涨）
    ("system.rs", "update_profile", 0),
    ("system.rs", "list_interfaces", 0),
];

fn read_src(rel: &str) -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("读不到 {}：{e}", p.display()))
}

/// 去掉全部空白后比对，避免 rustfmt 把 `coded(a, b)` 拆行导致判据失明。
fn flat(src: &str) -> String {
    src.split_whitespace().collect()
}

#[test]
fn b6_codes_are_bound_to_the_original_human_text() {
    for (code, rel, human) in B6_CASES {
        let src = flat(&read_src(rel));
        // human 也可能自带空格（`format!("未知通道: {channel}")`），而 `flat` 连字面量里的
        // 空白一起吃掉 ⇒ 比对用的 needle 必须同样 flatten，否则测的是空白而不是绑定。
        let human_flat: String = human.split_whitespace().collect();
        // 两种写法都算：文件的 `use` 风格不同（有的全限定、有的先 use 再简写），
        // 但"码与原文绑在同一个调用里"这件事实不变。
        let short = format!("coded({code},\"{human_flat}\"");
        let full = format!("coded(crate::error_codes::{code},\"{human_flat}\"");
        if src.contains(&short) || src.contains(&full) {
            continue;
        }
        // 包了一层日志助手（`coded(CODE, reject(... , "原文"))`）时，码与原文之间隔着
        // `reject(`。这时只要求"同一段表达式里两个事实都在" —— 窗口 400 字符足够覆盖
        // 一个 reject 调用的全部参数，又短到串不进下一条无关分支。
        let marker_short = format!("coded({code},");
        let marker_full = format!("coded(crate::error_codes::{code},");
        let needle = format!("\"{human_flat}\"");
        // 同一个码可能有多个产出点（中继地址 / 口令、导入内容 / 文件 / 下载），
        // 所以要扫**全部**出现位置，不能只看第一处（否则第二条同码判据是假红）。
        let bound_at_coded = [&marker_full, &marker_short]
            .iter()
            .flat_map(|m| src.match_indices(m.as_str()).map(|(i, _)| i))
            .any(|i| {
                // 按字符截断，别在中文 UTF-8 字节中间切（切片会 panic）。
                let window: String = src[i..].chars().take(400).collect();
                window.contains(&needle)
            });
        if bound_at_coded {
            continue;
        }
        // `reject_file_coded(&s, action, reason, 码, "原文")` 把码当参数传，形状里没有
        // `coded(码,`；这一段按"同一调用内码与原文同现"来守（与 reject 家族其它码同口径）。
        let wrapped_ok = src.match_indices("reject_file_coded(").any(|(i, _)| {
            let window: String = src[i..].chars().take(500).collect();
            window.contains(&format!("error_codes::{code},")) && window.contains(&needle)
        });
        assert!(
            wrapped_ok,
            "{rel} 里找不到把 {code} 挂到原文 \"{human}\" 上的调用（coded(码, …) 或 reject_file_coded(…, 码, …)）：这个触发点没带码或 human 被改了"
        );
    }
}

#[test]
fn b6_codes_have_no_duplicate_names_and_are_defined_once() {
    let defs = read_src("error_codes.rs");
    let mut codes: Vec<&str> = B6_CASES.iter().map(|(code, _, _)| *code).collect();
    codes.extend(B6_DYNAMIC_HUMAN.iter().map(|(code, _)| *code));
    codes.sort_unstable();
    codes.dedup();
    for code in codes {
        assert_eq!(
            defs.matches(&format!("pub const {code}: &str = \"{code}\";"))
                .count(),
            1,
            "{code} 必须在 error_codes.rs 里恰好定义一次"
        );
    }
}

/// human 是下层原话、没有字面量的触发点：只守"码真的挂在这里"，
/// 原文由 `coded_if_uncoded` 原样透传（不许自己造一句中文去顶替 OS / 通道原话）。
#[test]
fn b6_dynamic_human_sites_carry_the_code() {
    for (code, rel) in B6_DYNAMIC_HUMAN {
        let src = flat(&read_src(rel));
        let markers = [
            format!("coded({code},"),
            format!("coded(crate::error_codes::{code},"),
            format!("coded_if_uncoded({code},"),
            format!("coded_if_uncoded(crate::error_codes::{code},"),
        ];
        assert!(
            markers.iter().any(|m| src.contains(m)),
            "{rel} 里找不到把 {code} 挂到下层原话上的调用：这一格要么没带码，要么把下层原话改写了"
        );
    }
}

/// `coded_if_uncoded` 的核心契约：**不许套码**（内层已经带码就原样放行）。
#[test]
fn b6_does_not_stack_codes() {
    use crate::error_codes::{coded_if_uncoded, TRANSPORT_START_FAILED};
    let inner = "code=PORT_IN_USE 端口已占用";
    assert_eq!(
        coded_if_uncoded(TRANSPORT_START_FAILED, inner),
        inner,
        "内层已经带码时不许再套一层 —— 否则前端只认最外层，真原因（端口被占）被吃掉"
    );
    assert_eq!(
        coded_if_uncoded(TRANSPORT_START_FAILED, "适配器未开启"),
        "code=TRANSPORT_START_FAILED 适配器未开启",
        "没有码时才补本层的码，human 原文一字不动"
    );
}

/// 数一个函数体里**未带码**的 `return Err(...)`。
///
/// 只认 `return Err`：`?` 与 `.map_err(...)` 是**下层**的出口，那部分由调用链上游负责，
/// 审这一格会把所有透传都误算成本命令自己造的错。
fn count_uncoded_return_err(body: &str) -> usize {
    let body = flat(body);
    let total = body.matches("returnErr(").count();
    let coded = body.matches("returnErr(crate::error_codes::coded(").count()
        + body.matches("returnErr(coded(").count()
        + body
            .matches("returnErr(crate::error_codes::coded_if_uncoded(")
            .count()
        // reject 家族里只有 `reject_file_coded` 自带码；其它 `reject_*` 仍返回裸人话。
        + body.matches("returnErr(reject_file_coded(").count();
    total.saturating_sub(coded)
}

/// 「新命令返回 `Err` 必须带码」的**白名单版**静态护栏。
///
/// 为什么只守这 20 条、且用存量基线：168 条命令里绝大多数还没补码，一次全红只会催生
/// `--no-verify`（那等于把门禁关掉）。这条守的是「本批之后**新增**的裸 `return Err`」——
/// 反例自证：给任意一条基线命令手写一个 `return Err("…")`，数字立刻越线变红。
/// 数字只许**下调**（把存量补成带码时，同步把这里改小），不许上调。
#[test]
fn new_err_in_pilot_commands_must_carry_a_code() {
    for (file, name, baseline) in B6_COMMAND_UNCODED_BASELINE {
        let src = read_src(&format!("commands/{file}"));
        let body = rust_fn_body(&src, &format!("pub async fn {name}("));
        let uncoded = count_uncoded_return_err(&body);
        assert_eq!(
            uncoded, *baseline,
            "{file}::{name} 的未带码 `return Err` 是 {uncoded}，基线写着 {baseline}：\n\
             · 新加的错误必须用 `coded(码, 原文)`；\n\
             · 把存量补成带码时，同步把本表的数字**改小**（只许下调）。"
        );
    }
}

#[test]
fn coded_shape_is_code_space_human() {
    let out = crate::error_codes::coded(crate::error_codes::MSG_NOT_FOUND, "消息不存在");
    assert_eq!(out, "code=MSG_NOT_FOUND 消息不存在");
    assert!(
        out.strip_prefix("code=").unwrap().starts_with("MSG_NOT_FOUND "),
        "前端 errorCode() 的判据是 /code=([A-Z0-9_]+)/，码与人话之间必须有空格才切得开"
    );
}
