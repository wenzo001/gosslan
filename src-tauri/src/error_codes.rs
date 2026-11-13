//! 跨 FFI 的**错误码**（INV-P16 的窄口落地，2026-10-29）。
//!
//! ## 为什么只有这一族需要码
//!
//! 法条要的是五档语义（recoverable / retryable / permanent / user_action_required /
//! security_related）。实况是：**能靠字符串做到的只有"界面上要说哪句话"这一件事**，
//! 而真正需要分档的收尾判断早就有结构化的家（`file::send_retry_verdict` 吃的是
//! `SendFileError{retryable, cancelled}` 两个布尔，不是字符串；台账落库走 `FailReason` 九档）。
//! 所以这里不铺 163 条命令的类型，只把**前端按文案分支的那几条**换成按码分支 ——
//! 那几处今天真的会因为"后端把中文改了个字"而静默换档。
//!
//! ## 形状
//!
//! `code=<大写蛇形> 给人看的那句话`。人话留在码后面：老前端读到的是"code=… 原句"，
//! 仍然能把原句显示出来；新前端先认码、没有码才回落到正则（OS 与第三方库的串本来就没有码，
//! 那一档**必须**继续按签名猜，这是兜底不是分类）。
//!
//! ## 这份清单是与前端对账的
//!
//! `src/utils/errors.test.ts` 现读这里的常量名与前端 `CODE_RULES` 的键，双向比：
//! 前端读了这里没有的码 ⇒ 红；这里定义了码却没人用 ⇒ 也红（那是一条已经失效的契约）。

/// 拿不到对端的 X25519 公钥 ⇒ 无法加密 / 无法发送。
/// 前端那一档的话术要点是"不用重发，先让对方上线或重新配对"。
pub const E2EE_PUBKEY_MISSING: &str = "E2EE_PUBKEY_MISSING";
/// 监听端口被占用（`AddrInUse` 重试耗尽后）。前端那一档要给"先退掉另一个实例"的动作。
pub const PORT_IN_USE: &str = "PORT_IN_USE";

// ── 同步命令失败的"当场"那一档（乐观更新第一批，5.16.91）────────────────────
//
// 这一族与上面两格同通道（命令返回值，一次性弹给用户），不进 `messages.fail_code`，
// 因为**失败发生在写库之前**：库里没有行，气泡只是前端的乐观投影。
// 判据只收"英文/内部串"那几处：已经是人话的分支（如"对方版本不支持"）继续原样透传，
// 不为凑码把本来能读的句子改成词典键。

/// 1:1 发送/发文件时对方已不是好友（写库前挡回）。
pub const SEND_PEER_NOT_FRIEND: &str = "SEND_PEER_NOT_FRIEND";
/// 1:1 文件发送里"和自己聊天"那一格。
pub const FILE_SEND_SELF_CHAT: &str = "FILE_SEND_SELF_CHAT";
/// 本机写库/入队失败（`next_clock`、消息行、会话行、outbox 行）——以前是英文 `e.to_string()`。
pub const SEND_LOCAL_WRITE_FAILED: &str = "SEND_LOCAL_WRITE_FAILED";
/// 已读回执写库失败（`mark_read`）——以前同样是英文串，前端只能落到"请稍后重试"。
pub const READ_STATE_WRITE_FAILED: &str = "READ_STATE_WRITE_FAILED";

/// 辅助窗口（设置 / 日志 / 外链 / 看图）创建失败。
///
/// 典型现场是升级或强制重启后残留的渲染环境：`build()` 返回
/// `WebView2 error … HRESULT(0x80010108)`（`RPC_E_DISCONNECTED`）。原始错误**只进日志**
/// （`code=AUX_WINDOW_CREATE_FAILED … error=…`），上屏的是这个码 —— 前端把它翻成
/// 「完全退出应用再打开」的人话，并给一个走既有 `restart_app` 的按钮。
pub const AUX_WINDOW_CREATE_FAILED: &str = "AUX_WINDOW_CREATE_FAILED";

// ── B6 试点批：命令返回值里"本地记录已经没了 / 会话对不上 / 加密失败"─────────────
//
// 这一族只加码，**人话一个字不改**：`coded()` 的 `human` 半句仍是原来的中文，
// 认出码的新前端按词典说话，认不出的老前端照样显示原句。所以它们是纯增量。

/// 要操作的那条消息已经不在本机记录里（撤回/切换渲染/取消/重发时被清理或从未同步）。
pub const MSG_NOT_FOUND: &str = "MSG_NOT_FOUND";
/// 消息存在，但不属于调用方指定的那个会话（前端旧列表残留或串了会话）。
pub const MSG_NOT_IN_CONV: &str = "MSG_NOT_IN_CONV";
/// 本机 DH / ChaCha20-Poly1305 失败 —— 造不出密文，这条内容发不出去。
pub const E2EE_ENCRYPT_FAILED: &str = "E2EE_ENCRYPT_FAILED";

// ── B6 试点批：群管理 ──────────────────────────────────────────────────────
//
// 同一条「群已经不在了 / 你已被移出 / 还没拿到群密钥」在群消息、群文件、公告、
// 群设置里都会出现 —— 共用码 + 共用一条前端文案，不在各调用点复制。

/// 群记录已经不存在（被解散、被创建者删除，或本地库还没建起来）。
pub const GROUP_NOT_FOUND: &str = "GROUP_NOT_FOUND";
/// 本机已不在群成员表里（被移出/退出后旧界面仍在操作）。
pub const GROUP_SELF_NOT_MEMBER: &str = "GROUP_SELF_NOT_MEMBER";
/// 群名称为空（创建/重命名时 trim 之后是空串）。
pub const GROUP_NAME_EMPTY: &str = "GROUP_NAME_EMPTY";
/// 本机还没拿到该群密钥（新入群、密钥轮换中，或补发臂尚未到达）。
pub const GROUP_KEY_MISSING: &str = "GROUP_KEY_MISSING";
/// 群聊里触发了"窗口抖动"—— 产品上只支持单聊。
pub const NUDGE_GROUP_UNSUPPORTED: &str = "NUDGE_GROUP_UNSUPPORTED";

// ── B6 试点批：文件 / 设置 / 窗口 ──────────────────────────────────────────

/// 要打开/保存/复制的那份本地文件已经不在了（被清理、被移动、还没同步下来）。
pub const FILE_NOT_FOUND: &str = "FILE_NOT_FOUND";
/// 前端传了后端不认识的通道名（只有 `lan` / `bluetooth`）。
pub const CHANNEL_UNKNOWN: &str = "CHANNEL_UNKNOWN";
/// 局域网/蓝牙通道启动或切换失败（适配器、权限、端口占用等底层原因）。
pub const TRANSPORT_START_FAILED: &str = "TRANSPORT_START_FAILED";

// ── B6 第二批：好友申请那一族 ──────────────────────────────────────────────
//
// 同一条「申请没了」在发送侧与同意侧各出现一次（撤回/已处理），所以**一个码、两条原文**，
// 不在调用点各造一句。人话仍原样保留，老前端显示原文，新前端按词典说话。

/// 好友申请的目标就是自己（发送侧与撤回侧同一条）。
pub const FRIEND_SELF_REQUEST: &str = "FRIEND_SELF_REQUEST";
/// 同意申请时本地事务失败（写好友/建会话/删申请行）。
pub const FRIEND_ACCEPT_FAILED: &str = "FRIEND_ACCEPT_FAILED";
/// 这条申请已经不在（对方撤回、已被处理，或旧界面残留）。
pub const FRIEND_REQUEST_GONE: &str = "FRIEND_REQUEST_GONE";
/// 撤回时联系人标识为空/非法（前端旧列表残留）。
pub const FRIEND_INVALID_CONTACT: &str = "FRIEND_INVALID_CONTACT";
/// 已经是好友了，撤回申请没有意义（多半是旧列表残留）。
pub const FRIEND_ALREADY_FRIEND: &str = "FRIEND_ALREADY_FRIEND";

// ── B6 第三批：消息/会话那一族 ────────────────────────────────────────────
//
// 这里大多是"这条消息不该做这个操作"的拒绝分支：原文本身是准确的，但没有主语与去处，
// 直接上屏像机器在训人。码只负责让前端换成人话，原文继续留在日志里。
//
// 重复的几条（切换渲染的三种拒绝）在 `set_message_render` 与 `send_message` 内联分支
// 各出现一次，共用一个码 —— 同一个原因不该有两个码。

/// 取消发送：目标是自己给自己发的消息。
pub const CANCEL_SELF_CHAT_UNSUPPORTED: &str = "CANCEL_SELF_CHAT_UNSUPPORTED";
/// 取消发送：不是自己发的。
pub const CANCEL_NOT_OWN_MESSAGE: &str = "CANCEL_NOT_OWN_MESSAGE";
/// 取消发送：文件/图片走传输通道，不走消息取消。
pub const CANCEL_FILE_USE_TRANSFER: &str = "CANCEL_FILE_USE_TRANSFER";
/// 按成员补发：目标不是群消息。
pub const GROUP_RESEND_ONLY_FOR_GROUPS: &str = "GROUP_RESEND_ONLY_FOR_GROUPS";
/// 按成员补发：不是自己在该群发的消息。
pub const GROUP_RESEND_NOT_OWN: &str = "GROUP_RESEND_NOT_OWN";
/// 撤回：自己会话（自聊）里的消息。
pub const RECALL_OWN_CONV_UNSUPPORTED: &str = "RECALL_OWN_CONV_UNSUPPORTED";
/// 切换渲染：渲染方式未知。
pub const RENDER_UNSUPPORTED: &str = "RENDER_UNSUPPORTED";
/// 切换渲染：不是自己发的。
pub const RENDER_SELF_ONLY: &str = "RENDER_SELF_ONLY";
/// 切换渲染：消息类型不是文本/代码。
pub const RENDER_TEXT_CODE_ONLY: &str = "RENDER_TEXT_CODE_ONLY";
/// 切换渲染：消息已撤回。
pub const RENDER_RECALLED: &str = "RENDER_RECALLED";
/// 切换渲染：代码语言标识不合法（归一化后为空以外的非法字符 / 超长）。
pub const RENDER_INVALID_LANG: &str = "RENDER_INVALID_LANG";
/// 切换渲染：这次切换被更新的事件覆盖（LWW 未应用，不得静默成功）。
pub const RENDER_SUPERSEDED: &str = "RENDER_SUPERSEDED";
/// 窗口抖动：目标是自己的会话。
pub const NUDGE_SELF_UNSUPPORTED: &str = "NUDGE_SELF_UNSUPPORTED";
/// 发送：消息类型不在支持范围。
pub const MESSAGE_KIND_UNSUPPORTED: &str = "MESSAGE_KIND_UNSUPPORTED";
/// 强提醒：对应的提醒记录已不在。
pub const NUDGE_MISSING: &str = "NUDGE_MISSING";
/// 原地重发：群消息要走按成员补发。
pub const RESEND_USE_GROUP_DELIVERY: &str = "RESEND_USE_GROUP_DELIVERY";
/// 原地重发：自聊消息不需要重发。
pub const RESEND_SELF_CHAT_UNNEEDED: &str = "RESEND_SELF_CHAT_UNNEEDED";
/// 原地重发：不是自己发的。
pub const RESEND_SELF_ONLY: &str = "RESEND_SELF_ONLY";
/// 原地重发：该消息类型不支持。
pub const RESEND_KIND_UNSUPPORTED: &str = "RESEND_KIND_UNSUPPORTED";
/// 原地重发：消息不是失败/已取消状态。
pub const RESEND_NOT_FAILED: &str = "RESEND_NOT_FAILED";
/// 原地重发：消息已送达或状态已变。
pub const RESEND_ALREADY_DELIVERED: &str = "RESEND_ALREADY_DELIVERED";
/// 发送：自聊会话不支持图片/文件。
pub const SELF_CHAT_NO_MEDIA: &str = "SELF_CHAT_NO_MEDIA";

// ── B6 第四批：群管理那一族 ────────────────────────────────────────────────
//
// 这一族几乎全是"权限/状态不满足"的拒绝：原文准确但语气像系统日志
// （「只有群创建者可以移除成员」）。码让前端能换成人话并给出下一步，
// 原文继续原样保留给日志与老前端。

/// 建群/拉人：目标不是好友。
pub const GROUP_INVITE_FRIENDS_ONLY: &str = "GROUP_INVITE_FRIENDS_ONLY";
/// 改群名：不是群创建者。
pub const GROUP_RENAME_OWNER_ONLY: &str = "GROUP_RENAME_OWNER_ONLY";
/// 加成员：不是群创建者。
pub const GROUP_ADD_MEMBER_OWNER_ONLY: &str = "GROUP_ADD_MEMBER_OWNER_ONLY";
/// 加成员：该人已在群里。
pub const GROUP_MEMBER_ALREADY_IN: &str = "GROUP_MEMBER_ALREADY_IN";
/// 加成员：只能拉好友进群。
pub const GROUP_ADD_FRIEND_MEMBER_ONLY: &str = "GROUP_ADD_FRIEND_MEMBER_ONLY";
/// 移除成员：不是群创建者。
pub const GROUP_REMOVE_OWNER_ONLY: &str = "GROUP_REMOVE_OWNER_ONLY";
/// 移除成员：目标是自己。
pub const GROUP_REMOVE_SELF: &str = "GROUP_REMOVE_SELF";
/// 移除成员：该人不在群里。
pub const GROUP_MEMBER_NOT_IN: &str = "GROUP_MEMBER_NOT_IN";
/// 转让群主：不是群创建者。
pub const GROUP_TRANSFER_OWNER_ONLY: &str = "GROUP_TRANSFER_OWNER_ONLY";
/// 转让群主：目标是自己。
pub const GROUP_TRANSFER_TO_SELF: &str = "GROUP_TRANSFER_TO_SELF";
/// 转让群主：目标不是群成员。
pub const GROUP_TRANSFER_MEMBER_ONLY: &str = "GROUP_TRANSFER_MEMBER_ONLY";
/// 退群：群主必须先转让。
pub const GROUP_OWNER_LEAVE_TRANSFER_FIRST: &str = "GROUP_OWNER_LEAVE_TRANSFER_FIRST";
/// 移除成员：目标是群主（管理员不能移除群主）。
pub const GROUP_REMOVE_OWNER_FORBIDDEN: &str = "GROUP_REMOVE_OWNER_FORBIDDEN";
/// 任命管理员：不是群主（任免管理员仅群主）。
pub const GROUP_APPOINT_ADMIN_OWNER_ONLY: &str = "GROUP_APPOINT_ADMIN_OWNER_ONLY";
/// 撤销管理员：不是群主。
pub const GROUP_REMOVE_ADMIN_OWNER_ONLY: &str = "GROUP_REMOVE_ADMIN_OWNER_ONLY";
/// 任命管理员：已达上限（每群最多 3 个）。
pub const GROUP_ADMIN_LIMIT: &str = "GROUP_ADMIN_LIMIT";
/// 任命管理员：目标不是群成员。
pub const GROUP_APPOINT_ADMIN_NOT_MEMBER: &str = "GROUP_APPOINT_ADMIN_NOT_MEMBER";
/// 任命管理员：目标是群主本人（群主无需也不应为管理员）。
pub const GROUP_APPOINT_ADMIN_SELF: &str = "GROUP_APPOINT_ADMIN_SELF";
/// 撤销管理员：目标不是管理员。
pub const GROUP_REMOVE_ADMIN_NOT_ADMIN: &str = "GROUP_REMOVE_ADMIN_NOT_ADMIN";
/// 群聊发送：不支持的消息类型。
pub const GROUP_FILE_KIND_UNSUPPORTED: &str = "GROUP_FILE_KIND_UNSUPPORTED";
/// 自定义待办类型：名称为空。
pub const GROUP_TODO_TYPE_NAME_EMPTY: &str = "GROUP_TODO_TYPE_NAME_EMPTY";
/// 自定义待办类型：图标不合法。
pub const GROUP_TODO_TYPE_ICON_INVALID: &str = "GROUP_TODO_TYPE_ICON_INVALID";
/// 待办：类型不合法（发送与更新共用）。
pub const GROUP_TODO_TYPE_INVALID: &str = "GROUP_TODO_TYPE_INVALID";
/// 待办：标题为空（发送与更新共用）。
pub const GROUP_TODO_TITLE_EMPTY: &str = "GROUP_TODO_TITLE_EMPTY";
/// 待办：没有指派任何人。
pub const GROUP_TODO_ASSIGNEE_REQUIRED: &str = "GROUP_TODO_ASSIGNEE_REQUIRED";
/// 待办：状态不合法。
pub const GROUP_TODO_STATUS_INVALID: &str = "GROUP_TODO_STATUS_INVALID";
/// 待办：优先级不合法。
pub const GROUP_TODO_PRIORITY_INVALID: &str = "GROUP_TODO_PRIORITY_INVALID";
/// 待办：关联时间不合法（只接受 `YYYY-MM-DD` 的真实日历日）。
pub const GROUP_TODO_RELATED_ON_INVALID: &str = "GROUP_TODO_RELATED_ON_INVALID";
/// 待办：标签不合法（超过条数上限，或单个标签超过长度上限）。
pub const GROUP_TODO_TAGS_INVALID: &str = "GROUP_TODO_TAGS_INVALID";
/// 公告：内容为空。
pub const GROUP_ANNOUNCEMENT_EMPTY: &str = "GROUP_ANNOUNCEMENT_EMPTY";
/// 公告：标识缺失。
pub const GROUP_ANNOUNCEMENT_ID_MISSING: &str = "GROUP_ANNOUNCEMENT_ID_MISSING";
/// 回应/置顶：缺目标消息（两处原文共用一个码）。
pub const GROUP_REPLY_TARGET_MISSING: &str = "GROUP_REPLY_TARGET_MISSING";
/// 表情回应：未知表情。
pub const GROUP_REACTION_UNKNOWN: &str = "GROUP_REACTION_UNKNOWN";
/// 转发：文件不属于这条消息。
pub const GROUP_FORWARD_FILE_NOT_OWNED: &str = "GROUP_FORWARD_FILE_NOT_OWNED";
/// 群文件：只能发普通文件。
pub const GROUP_FILE_ONLY_PLAIN: &str = "GROUP_FILE_ONLY_PLAIN";
/// 群发文件：群里没有其他人。
pub const GROUP_NO_OTHER_MEMBERS: &str = "GROUP_NO_OTHER_MEMBERS";
/// 待办图片：目标不是文件。
pub const GROUP_MEDIA_NOT_FILE: &str = "GROUP_MEDIA_NOT_FILE";
/// 待办图片：字节格式不合法。
pub const GROUP_IMAGE_BYTES_INVALID: &str = "GROUP_IMAGE_BYTES_INVALID";
/// 待办图片：字节为空。
pub const GROUP_IMAGE_EMPTY: &str = "GROUP_IMAGE_EMPTY";
/// 待办图片：只接受粘贴的图片。
pub const GROUP_IMAGE_PASTE_ONLY: &str = "GROUP_IMAGE_PASTE_ONLY";

// ── B6 第五批：收藏那一族 ──────────────────────────────────────────────────

/// 导出收藏：没有选择保存位置。
pub const FAVORITE_EXPORT_PATH_EMPTY: &str = "FAVORITE_EXPORT_PATH_EMPTY";

// ── B6 第六批：设置/网络那一族 ────────────────────────────────────────────

/// 窗口/提醒类命令找不到主窗口（后台化或最小化后接事件）。
pub const MAIN_WINDOW_MISSING: &str = "MAIN_WINDOW_MISSING";
/// 中继：没填服务器地址。
pub const RELAY_HOST_REQUIRED: &str = "RELAY_HOST_REQUIRED";
/// 中继：填了 IPv6（当前监听只支持 IPv4）。
pub const RELAY_IPV6_UNSUPPORTED: &str = "RELAY_IPV6_UNSUPPORTED";
/// 中继：没填访问口令。
pub const RELAY_TOKEN_REQUIRED: &str = "RELAY_TOKEN_REQUIRED";
/// 中继：口令里有空格或换行。
pub const RELAY_TOKEN_INVALID: &str = "RELAY_TOKEN_INVALID";
/// 中继：口令超过长度上限（human 带实际长度与上限）。
pub const RELAY_TOKEN_TOO_LONG: &str = "RELAY_TOKEN_TOO_LONG";
/// 中继：服务器地址既不是 ip 也不是 ip:port（human 带收到的原值）。
pub const RELAY_ENDPOINT_FORMAT_INVALID: &str = "RELAY_ENDPOINT_FORMAT_INVALID";
/// 中继：设置页读配置失败（地址/口令两处共用一个码，human 带底层原因）。
pub const RELAY_CONFIG_READ_FAILED: &str = "RELAY_CONFIG_READ_FAILED";
/// 跨网段端点：地址格式既不是 ip 也不是 ip:port。
pub const ROUTED_ENDPOINT_FORMAT_INVALID: &str = "ROUTED_ENDPOINT_FORMAT_INVALID";
/// 跨网段端点：填了 IPv6（当前监听只支持 IPv4）。
pub const ROUTED_IPV6_UNSUPPORTED: &str = "ROUTED_IPV6_UNSUPPORTED";
/// 设置页「发送测试通知」：系统通知权限被限制（human 带平台给的原因）。
pub const NOTIFY_PERMISSION_DENIED: &str = "NOTIFY_PERMISSION_DENIED";
/// 设置页「发送测试通知」：系统通知 API 发送失败（human 带底层原因）。
pub const NOTIFY_SEND_FAILED: &str = "NOTIFY_SEND_FAILED";

// ── B6 第七批：文件 / 外链（本笔）──────────────────────────────────────
/// 粘贴图片：不是 data URL / 缺少逗号分隔。
pub const IMAGE_DATA_URL_INVALID: &str = "IMAGE_DATA_URL_INVALID";
/// 粘贴图片：data URL 不是 base64 编码。
pub const IMAGE_BASE64_REQUIRED: &str = "IMAGE_BASE64_REQUIRED";
/// 粘贴图片：MIME 不是 image/*。
pub const IMAGE_NOT_IMAGE: &str = "IMAGE_NOT_IMAGE";
/// 粘贴图片：image/* 里不认识的子类型。
pub const IMAGE_FORMAT_UNSUPPORTED: &str = "IMAGE_FORMAT_UNSUPPORTED";
/// 粘贴图片：base64 解不出来（human 带解码器原话）。
pub const IMAGE_DECODE_FAILED: &str = "IMAGE_DECODE_FAILED";
/// 图片体积超过发送上限（human 带实际值与上限）。
pub const IMAGE_TOO_LARGE: &str = "IMAGE_TOO_LARGE";
/// 图片解出来是 0 字节。
pub const IMAGE_EMPTY: &str = "IMAGE_EMPTY";
/// 图片另存/保存失败（human 带 OS 原话）。
pub const IMAGE_SAVE_FAILED: &str = "IMAGE_SAVE_FAILED";
/// 另存为：既没给 msg_id 也没给 cid。
pub const IMAGE_SOURCE_MISSING: &str = "IMAGE_SOURCE_MISSING";
/// 删除：路径不在下载目录内（安全信号）。
pub const FILE_DELETE_OUTSIDE_DOWNLOADS: &str = "FILE_DELETE_OUTSIDE_DOWNLOADS";
/// 取消 / 重新拉取：消息载荷没有内容指纹。
pub const FILE_NO_CONTENT_ID: &str = "FILE_NO_CONTENT_ID";
/// 打开 / 另存 / 转发：路径与这条消息的台账不符。
pub const FILE_NOT_OWNED_BY_MESSAGE: &str = "FILE_NOT_OWNED_BY_MESSAGE";
/// 打开：台账指向别的路径。
pub const OPEN_PATH_NOT_OWNED: &str = "OPEN_PATH_NOT_OWNED";
/// 打开：台账还没建立、也无法证明是本机发出。
pub const OPEN_PATH_UNVERIFIED: &str = "OPEN_PATH_UNVERIFIED";
/// 取本地媒体路径失败（human 带具体原因，可能已带别的码）。
pub const FILE_PATH_UNRESOLVED: &str = "FILE_PATH_UNRESOLVED";
/// 群文件「我的状态」读不出来（human 带 transfer id）。
pub const GFILE_MY_STATUS_READ_FAILED: &str = "GFILE_MY_STATUS_READ_FAILED";

// ── B6 第八批：外链 / 共享目录（本笔）──────────────────────────────────
/// 外链：网址为空。
pub const LINK_URL_EMPTY: &str = "LINK_URL_EMPTY";
/// 外链：URL 解析失败。
pub const LINK_URL_INVALID: &str = "LINK_URL_INVALID";
/// 外链：不是 http(s) 协议。
pub const LINK_URL_SCHEME: &str = "LINK_URL_SCHEME";
/// 外链：没有主机名。
pub const LINK_URL_NO_HOST: &str = "LINK_URL_NO_HOST";
/// 外链：名称为空。
pub const LINK_NAME_EMPTY: &str = "LINK_NAME_EMPTY";
/// 外链：名称超长（human 带上限）。
pub const LINK_NAME_TOO_LONG: &str = "LINK_NAME_TOO_LONG";
/// 外链：同一网址已在列表里。
pub const LINK_URL_DUPLICATE: &str = "LINK_URL_DUPLICATE";
/// 外链：条数达到上限（human 带上限）。
pub const LINK_LIMIT_REACHED: &str = "LINK_LIMIT_REACHED";
/// 外链：要改/删的链接不存在。
pub const LINK_NOT_FOUND: &str = "LINK_NOT_FOUND";
/// 外链：读取列表失败（human 带底层原因）。
pub const LINK_LIST_READ_FAILED: &str = "LINK_LIST_READ_FAILED";
/// 外链导入：内容超过体积上限（human 带上限）。
pub const LINK_IMPORT_TOO_LARGE: &str = "LINK_IMPORT_TOO_LARGE";
/// 外链导入：内容不是可解析的 JSON / 结构不对。
pub const LINK_IMPORT_JSON_INVALID: &str = "LINK_IMPORT_JSON_INVALID";
/// 外链导入：下载回来的内容不是 UTF-8。
pub const LINK_IMPORT_NOT_UTF8: &str = "LINK_IMPORT_NOT_UTF8";
/// 外链导入：读文件 / 下载 / 读流失败（human 带底层原因）。
pub const LINK_IMPORT_READ_FAILED: &str = "LINK_IMPORT_READ_FAILED";
/// 外链导入：阻塞池任务中断（human 带底层原因）。
pub const LINK_IMPORT_POOL_FAILED: &str = "LINK_IMPORT_POOL_FAILED";
/// 外链：写库失败（human 带底层原因）。
pub const LINK_SAVE_FAILED: &str = "LINK_SAVE_FAILED";
/// 外链清理：路径在导出目录之外（安全信号）。
pub const LINK_CLEAN_OUTSIDE_EXPORT: &str = "LINK_CLEAN_OUTSIDE_EXPORT";
/// 外链从网址导入：HTTP 状态非成功（human 带状态码）。
pub const LINK_DOWNLOAD_HTTP_FAILED: &str = "LINK_DOWNLOAD_HTTP_FAILED";
/// 外链从网址导入：HTTP 客户端初始化失败（human 带底层原因）。
pub const LINK_NETWORK_INIT_FAILED: &str = "LINK_NETWORK_INIT_FAILED";
/// 外链导出：建目录 / 写文件失败（human 带底层原因）。
pub const LINK_EXPORT_FAILED: &str = "LINK_EXPORT_FAILED";
/// 外链清理：删导出文件失败（human 带底层原因）。
pub const LINK_CLEAN_FAILED: &str = "LINK_CLEAN_FAILED";

// ── 外部应用设备认证（2026-11-13，external-app-device-auth Phase 2）─────────────
//
// Gosslan 作为本地设备确认器：RP 来源/端点/事务校验失败、用户拒绝、重放、绑定撤销等。
// 全部 fail closed；与前端 utils/errors.ts CODE_RULES + errors.rule.* 双向对账。
/// 授权深链格式不正确 / scheme 不支持 / 缺事务引用。
pub const DEVICE_AUTH_INVALID_LINK: &str = "DEVICE_AUTH_INVALID_LINK";
/// RP 来源不是合法 HTTPS origin（http 降级 / 带 userinfo/query/fragment / 缺主机）。
pub const DEVICE_AUTH_INVALID_ORIGIN: &str = "DEVICE_AUTH_INVALID_ORIGIN";
/// metadata issuer 与来源不一致，或端点跨域 / 非 HTTPS。
pub const DEVICE_AUTH_CROSS_ORIGIN: &str = "DEVICE_AUTH_CROSS_ORIGIN";
/// metadata 畸形（client_id 空 / 端点格式坏）。
pub const DEVICE_AUTH_BAD_METADATA: &str = "DEVICE_AUTH_BAD_METADATA";
/// 不支持的协议版本 / 动作。
pub const DEVICE_AUTH_UNSUPPORTED: &str = "DEVICE_AUTH_UNSUPPORTED";
/// 请求了未知或未支持的 claim（整笔拒）。
pub const DEVICE_AUTH_UNKNOWN_CLAIM: &str = "DEVICE_AUTH_UNKNOWN_CLAIM";
/// 事务畸形（request_id 空 / challenge 熵不足 / expires_at 非法）。
pub const DEVICE_AUTH_BAD_REQUEST: &str = "DEVICE_AUTH_BAD_REQUEST";
/// 事务或 challenge 已过期。
pub const DEVICE_AUTH_EXPIRED: &str = "DEVICE_AUTH_EXPIRED";
/// 拉取 metadata/请求或回写 decision 的网络失败（human 带底层原因）。
pub const DEVICE_AUTH_NETWORK: &str = "DEVICE_AUTH_NETWORK";
/// 事务已被消费 / 重复批准（防重放）。
pub const DEVICE_AUTH_REPLAYED: &str = "DEVICE_AUTH_REPLAYED";
/// 待确认事务不存在（已清除 / request_id 错）。
pub const DEVICE_AUTH_NOT_FOUND: &str = "DEVICE_AUTH_NOT_FOUND";
/// 绑定已撤销，不能用于 authenticate（须重新显式绑定）。
pub const DEVICE_AUTH_BINDING_REVOKED: &str = "DEVICE_AUTH_BINDING_REVOKED";
/// 已存在撤销态绑定，不许静默覆盖旧公钥（须先在 RP 解绑）。
pub const DEVICE_AUTH_BINDING_EXISTS: &str = "DEVICE_AUTH_BINDING_EXISTS";
/// authenticate 但本机尚无 active 绑定（须先 link）。
pub const DEVICE_AUTH_NO_BINDING: &str = "DEVICE_AUTH_NO_BINDING";
/// 共享目录：路径不存在 / 不是目录。
pub const SHARE_DIR_MISSING: &str = "SHARE_DIR_MISSING";
/// 共享目录：打开接收目录的阻塞任务失败（human 带底层原因）。
pub const SHARE_DIR_READ_FAILED: &str = "SHARE_DIR_READ_FAILED";
/// 共享：对方不是好友。
pub const SHARE_NOT_FRIEND: &str = "SHARE_NOT_FRIEND";
/// 共享：等目录回包超时。
pub const SHARE_TIMEOUT: &str = "SHARE_TIMEOUT";
/// 共享：没有可达的中继邻居。
pub const SHARE_NO_ROUTE: &str = "SHARE_NO_ROUTE";
/// 共享请求发送失败（human 带底层原因，可能已带别的码）。
pub const SHARE_SEND_FAILED: &str = "SHARE_SEND_FAILED";
/// 通道设置：清理缓存任务失败（human 带底层原因）。
pub const CHANNEL_CACHE_CLEAN_FAILED: &str = "CHANNEL_CACHE_CLEAN_FAILED";

// ── B6 第九批：日志诊断 ────────────────────────────────────────────────────
//
// 这一族是"日志页/诊断包导出"的失败：读日志、清日志、写诊断包各自一格。
// 它们都发生在用户明确点了按钮之后 ⇒ 前端那一档要说清"下一步"（重试 / 换个保存位置），
// 而不是把 `spawn_blocking` 的中断串直接上屏。
/// 运行日志读取失败（阻塞池中断，human 带底层原因）。
pub const LOG_READ_FAILED: &str = "LOG_READ_FAILED";
/// 清空运行日志失败（阻塞池中断，human 带底层原因）。
pub const LOG_CLEAR_FAILED: &str = "LOG_CLEAR_FAILED";
/// 诊断包导出任务本身没跑完（阻塞池中断，human 带底层原因）。
pub const DIAG_EXPORT_JOIN_FAILED: &str = "DIAG_EXPORT_JOIN_FAILED";
/// 诊断包导出：保存路径为空（界面没选落点）。
pub const DIAG_EXPORT_PATH_EMPTY: &str = "DIAG_EXPORT_PATH_EMPTY";
/// 诊断包导出：写盘失败（human 带底层原因，常见是目标目录只读/磁盘满）。
pub const DIAG_EXPORT_WRITE_FAILED: &str = "DIAG_EXPORT_WRITE_FAILED";

// ── B6 第十批：启动/窗口 / 资料 / 更新 ──────────────────────────────────────
//
// 这一族覆盖"保存资料""网卡枚举""更新检查/下载/安装/取消"的互斥与缺件分支。
// 它们几乎都是用户连点两下或按错顺序时撞上的 ⇒ 前端那一档要说清"现在正在做什么、
// 接下来该等还是该先检查"，而不是把内部相位名直接上屏。
/// 头像 base64 解码后超过 2 MB（界面侧还有一道更早的压缩校验）。
pub const AVATAR_TOO_LARGE: &str = "AVATAR_TOO_LARGE";
/// 保存资料写库失败（human 带底层原因）。
pub const PROFILE_SAVE_FAILED: &str = "PROFILE_SAVE_FAILED";
/// 网卡枚举失败（human 带底层原因）。
pub const INTERFACE_LIST_FAILED: &str = "INTERFACE_LIST_FAILED";
/// 更新检查：正在下载时又点检查。
pub const UPDATER_CHECK_WHILE_DOWNLOADING: &str = "UPDATER_CHECK_WHILE_DOWNLOADING";
/// 更新检查：上一次检查还没结束。
pub const UPDATER_CHECK_IN_PROGRESS: &str = "UPDATER_CHECK_IN_PROGRESS";
/// 更新下载：已经在下载。
pub const UPDATER_ALREADY_DOWNLOADING: &str = "UPDATER_ALREADY_DOWNLOADING";
/// 更新下载：会话里还没有可下载的清单（先检查更新）。
pub const UPDATER_NO_PENDING_UPDATE: &str = "UPDATER_NO_PENDING_UPDATE";
/// 更新安装：还在下载。
pub const UPDATER_INSTALL_WHILE_DOWNLOADING: &str = "UPDATER_INSTALL_WHILE_DOWNLOADING";
/// 更新安装：会话里没有可安装的更新。
pub const UPDATER_NO_UPDATE: &str = "UPDATER_NO_UPDATE";
/// 更新安装：更新还没下载完成。
pub const UPDATER_NOT_DOWNLOADED: &str = "UPDATER_NOT_DOWNLOADED";
/// 更新取消：安装已经开始。
pub const UPDATER_CANCEL_AFTER_INSTALL: &str = "UPDATER_CANCEL_AFTER_INSTALL";

// ── B6 第十一批：启动失败窗口（重试/打开目录）────────────────────────────
//
// "启动失败"这扇窗上只有三个动作：重试、打开数据目录、退出。前两个失败时的原话
// 必须原样保留，但英文界面要能按码说清"现在该等还是该先退出"。
/// 重试被拒：应用已经恢复，不需要再重试。
pub const STARTUP_ALREADY_RECOVERED: &str = "STARTUP_ALREADY_RECOVERED";
/// 重试被拒：上一轮重试还在跑。
pub const STARTUP_RETRY_IN_PROGRESS: &str = "STARTUP_RETRY_IN_PROGRESS";
/// 重试/取信息被拒：这次启动没有待处理的失败。
pub const STARTUP_NO_PENDING_FAILURE: &str = "STARTUP_NO_PENDING_FAILURE";
/// 重试任务在阻塞池里没跑完（human 带底层原因）。
pub const STARTUP_RETRY_POOL_FAILED: &str = "STARTUP_RETRY_POOL_FAILED";
/// 重试成功后回主线程调度失败（human 带底层原因）。
pub const STARTUP_MAIN_THREAD_FAILED: &str = "STARTUP_MAIN_THREAD_FAILED";
/// 读应用数据目录失败（human 带底层原因）。
pub const STARTUP_DATA_DIR_READ_FAILED: &str = "STARTUP_DATA_DIR_READ_FAILED";

// ── B6 第十二批：好友/群管理里漏网的长文与读表 ─────────────────────────────
//
// 这几格此前只有 `format!` 拼出的中文原话：输入超长三条、读表失败两条、
// 群待办图片体积一格。超长是用户直接可改的（少打几个字），读表是重试一格。
/// 好友列表读不出来（human 带底层原因）。
pub const FRIENDS_LIST_READ_FAILED: &str = "FRIENDS_LIST_READ_FAILED";
/// 群已读名单读不出来（human 带底层原因）。
pub const GROUP_READS_LIST_READ_FAILED: &str = "GROUP_READS_LIST_READ_FAILED";
/// 群待办：自定义类型名称超长。
pub const GROUP_TODO_TYPE_NAME_TOO_LONG: &str = "GROUP_TODO_TYPE_NAME_TOO_LONG";
/// 群待办：任务标题超长。
pub const GROUP_TODO_TITLE_TOO_LONG: &str = "GROUP_TODO_TITLE_TOO_LONG";
/// 群待办：任务描述超长。
pub const GROUP_TODO_DESC_TOO_LONG: &str = "GROUP_TODO_DESC_TOO_LONG";
/// 群公告超长。
pub const GROUP_ANNOUNCEMENT_TOO_LONG: &str = "GROUP_ANNOUNCEMENT_TOO_LONG";
/// 群待办图片超过单张体积上限。
pub const GROUP_TODO_IMAGE_TOO_LARGE: &str = "GROUP_TODO_IMAGE_TOO_LARGE";
/// 群待办：关联的来源任务不存在（用户 2026-11-13 关联任务）。
pub const GROUP_TODO_LINKED_FROM_NOT_FOUND: &str = "GROUP_TODO_LINKED_FROM_NOT_FOUND";
/// 群待办回复：目标任务不存在（用户 2026-11-13 任务回复）。
pub const GROUP_TODO_REPLY_TARGET_MISSING: &str = "GROUP_TODO_REPLY_TARGET_MISSING";
/// 群待办回复：内容为空。
pub const GROUP_TODO_REPLY_EMPTY: &str = "GROUP_TODO_REPLY_EMPTY";
/// 群待办回复：内容超长。
pub const GROUP_TODO_REPLY_TOO_LONG: &str = "GROUP_TODO_REPLY_TOO_LONG";
/// 群待办回复：被回复的那条回复不存在（悬空引用）。
pub const GROUP_TODO_REPLY_PARENT_MISSING: &str = "GROUP_TODO_REPLY_PARENT_MISSING";

// ── B6 第十三批：收藏 ──────────────────────────────────────────────────────
/// 收藏批量删除超过一次上限。
pub const FAVORITE_DELETE_BATCH_TOO_LARGE: &str = "FAVORITE_DELETE_BATCH_TOO_LARGE";

// ── B6 第十三批：群管理里 reject 族的原话 ──────────────────────────────────
//
// 这些走 `reject()`（已带 action+reason 留痕）但返回给前端的是裸中文。
// 用 `coded(码, reject(...))` 外套一层：日志留痕与文案一字不丢，前端多一个可认的码。
/// 群待办：被指派的人已经不在群里。
pub const GROUP_TODO_ASSIGNEE_NOT_MEMBER: &str = "GROUP_TODO_ASSIGNEE_NOT_MEMBER";
/// 群待办：当前成员无权编辑该任务（human 带底层原因）。
pub const GROUP_TODO_EDIT_FORBIDDEN: &str = "GROUP_TODO_EDIT_FORBIDDEN";
/// 群待办：状态不允许归档。
pub const GROUP_TODO_ARCHIVE_STATE_INVALID: &str = "GROUP_TODO_ARCHIVE_STATE_INVALID";
/// 群公告：只有群主可以发布/删除。
pub const GROUP_ANNOUNCEMENT_OWNER_ONLY: &str = "GROUP_ANNOUNCEMENT_OWNER_ONLY";
/// 群提醒：一个提醒对象都没选。
pub const GROUP_REMIND_TARGET_REQUIRED: &str = "GROUP_REMIND_TARGET_REQUIRED";
/// 群提醒：选中的提醒对象都已不在群里。
pub const GROUP_REMIND_TARGETS_GONE: &str = "GROUP_REMIND_TARGETS_GONE";

// ── B6 第十四批：收藏里 reject_favorite 族的原话 ───────────────────────────
// 与群管理 reject 族同一处理：`coded(码, reject_favorite(...))`，只多一个码，留痕不变。
/// 收藏：要收藏的原文件已不在本机。
pub const FAVORITE_SOURCE_GONE: &str = "FAVORITE_SOURCE_GONE";
/// 收藏：复制文件到收藏目录失败（human 带底层原因）。
pub const FAVORITE_COPY_FAILED: &str = "FAVORITE_COPY_FAILED";
/// 收藏预览：内容不存在。
pub const FAVORITE_CONTENT_MISSING: &str = "FAVORITE_CONTENT_MISSING";
/// 收藏预览：内容存储读取失败（human 带底层原因）。
pub const FAVORITE_STORE_READ_FAILED: &str = "FAVORITE_STORE_READ_FAILED";
/// 收藏预览：文件路径越权。
pub const FAVORITE_PATH_ESCAPE: &str = "FAVORITE_PATH_ESCAPE";

/// 给"可能已经带码"的下层错误补码：已带 `code=` 就原样透传，避免叠成两个码。
///
/// 典型场景：通道启动会把 `network::start_from_prefs` 的 `PORT_IN_USE` 透传上来，
/// 外层若再无条件套 `TRANSPORT_START_FAILED`，前端只会看到第一个码 ⇒ 端口占用
/// 那条专门文案就永远走不到。判据见 `b6_does_not_stack_codes`。
pub fn coded_if_uncoded(code: &'static str, msg: impl std::fmt::Display) -> String {
    let msg = msg.to_string();
    if msg.contains("code=") {
        msg
    } else {
        coded(code, msg)
    }
}

/// 把码拼到人话前面 —— **唯一**的写法（不散着 `format!("code=…")`，否则对账判据读不出来）。
pub fn coded(code: &'static str, msg: impl std::fmt::Display) -> String {
    format!("code={code} {msg}")
}

// ── 消息气泡的失败原因（`messages.fail_code`，DB v14→v15）──────────────────────
//
// 上面那两个码走的是**命令返回值**那条通道（一次性、当场弹给用户）；这一族走的是**落库**
// 那条通道：一条被判失败的气泡要能在重启之后仍然说得出"为什么"。此前所有失败都只写成
// `status='failed'`，于是"对方一直不在线所以放弃"与"你把对方删了"在界面上是同一句话。
//
// 全部档位都是**写这一行时就知道原因**的位置。1:1 文件与群文件那一族自 5.15.31 / 5.15.32
// 起也进这张表（原先它们只活在 `file-failed` 事件里，重启就忘）。
// ★ 在册 ≠ 一切原因：**不在册的原因不写这一列**（读回来是 NULL，含义"这一格没记原因"，
//   不是"没有原因"）—— 因为这一列的读者是查词典的界面，写进内部串等于把文案塞进数据
//   （`group_file.rs::persistable_group_fail_code` 守的就是这条）。

/// 重试窗口耗尽（清扫器把仍在队列里的行落终态）。
///
/// **只用于「对方在线、消息却送不到」**（Block 3）：对端在本机发现层可达（有链路或
/// 45s 内还在广播 announce），120s 内始终没有 Ack —— 说明不是"人不在"，而是当时
/// 没有可用的直连、也没有可用的中继。两类的下一步完全不同：这一格的用户动作是
/// "让对方与中间节点保持在线 / 纳入同一中继后点重发"；真离线那一格见
/// [`SEND_PEER_OFFLINE_EXPIRED`]。
pub const SEND_RETRY_EXPIRED: &str = "SEND_RETRY_EXPIRED";
/// 对方**一直离线**，消息在离线保留窗口（7 天）耗尽后落终态（Block 3）。
///
/// 与 [`SEND_RETRY_EXPIRED`] 拆开的原因：`SEND_RETRY_EXPIRED` 原来的文案是
/// "对方可能长时间离线"，而它其实只在**对端可达**时才会写（离线是保留 7 天、不判死）。
/// 于是用户被告知"可能离线"，实际是"在线但没路走" —— 界面给的下一步完全错位。
/// 这一格的用户动作是"等对方上线（或让对方开机）后再点重发"。
pub const SEND_PEER_OFFLINE_EXPIRED: &str = "SEND_PEER_OFFLINE_EXPIRED";
/// 本机启动时发现"发送中但没有任何队列行"的孤儿（崩溃窗口 / 旧版本收尾顺序）。
pub const SEND_ORPHAN_AT_START: &str = "SEND_ORPHAN_AT_START";
/// 好友被删除时，仍在队列里发给这个人的消息随之落败（不是用户取消这一条）。
pub const SEND_PEER_DELETED: &str = "SEND_PEER_DELETED";
/// 群成员退群/被移出，这条群消息对该成员已无处可投、且没有别的成员还在等。
pub const SEND_GROUP_MEMBER_GONE: &str = "SEND_GROUP_MEMBER_GONE";
/// 对端**已经声明**不具备这个 kind 需要的能力位（1:1 能力协商判死，5.16.92）。
/// 与 `SEND_RETRY_EXPIRED` 的区别：这一格不是"等太久"，是"再等也不会变"。
/// 界面要给的下一步是"让对方升级客户端后再重发"，不是"等对方上线"。
pub const SEND_KIND_UNSUPPORTED: &str = "SEND_KIND_UNSUPPORTED";
/// 本机没有对端的 X25519 公钥（好友表与在线自报都缺）⇒ 连密文都造不出来。
/// 与"对方离线"不同：离线好友的公钥通常已在好友表里，这一格说明这条关系从没握过手。
pub const SEND_PEER_KEY_MISSING: &str = "SEND_PEER_KEY_MISSING";

/// 文件单的两种"不是用户取消"的终态。**码只有一个出处**：这里。
/// 同一对常量既写进 `messages.fail_code`（`FileJobEnd::fail_code`）也发进 `file-failed`
/// 事件载荷（`outbox_sweep.rs`）⇒ 界面上同一格不会因"事件说 A、重启后读回来是 B"而变两样。
/// 家原先在 `logging.rs` 的 `FAIL_CODE_*`（那是事件载荷族的对账分母），搬过来是因为
/// 它们从 5.15.31 起**也要落库**，而落库档位的分母是下面那个数组。
pub const FILE_SEND_EXPIRED: &str = "FILE_SEND_EXPIRED";
/// 重试次数用尽（或队列行已不在），这一单再也发不出去。
pub const FILE_SEND_GIVEUP: &str = "FILE_SEND_GIVEUP";

/// 群文件**接收**侧的六种"收不下去"。名字前缀 `GROUP_` 是因为它们只代表**这一格收件人**的
/// 这一单收完了没（逐收件人台账），与 1:1 的失败不是一回事。
/// 以前它们是 `group_file.rs` 里的中文常量，只进日志、永不上屏；
/// 5.15.32 起它们是码 ⇒ 气泡行能带上"为什么"，界面按词典说话，重启之后还在。
///
/// ⚠️ **有码不等于要弹 toast**：断链时每个在途群文件都会失败一次，逐条弹通知就是噪音回归
///（`group_file.rs::should_notify_group_failure` 那份显式名单管这件事）。
pub const GROUP_FILE_STALLED: &str = "GROUP_FILE_STALLED";
/// 一个分片都没收到过（对端根本没开始发）。
pub const GROUP_FILE_NO_CHUNK: &str = "GROUP_FILE_NO_CHUNK";
/// 分片解密后与本机不匹配（内容与密钥/身份对不上）。
pub const GROUP_FILE_DECRYPT_FAILED: &str = "GROUP_FILE_DECRYPT_FAILED";
/// 分片顺序有洞（中间缺片），这一单已经补不齐。
pub const GROUP_FILE_CHUNK_GAP: &str = "GROUP_FILE_CHUNK_GAP";
/// 分片累计超出声明大小（协议层硬失败）。
pub const GROUP_FILE_CHUNK_EXCEEDS_SIZE: &str = "GROUP_FILE_CHUNK_EXCEEDS_SIZE";
/// 对端一条链路都不剩 —— 与"对端没上线"不同：这一单要重发才收得到。
pub const GROUP_FILE_PEER_UNLINKED: &str = "GROUP_FILE_PEER_UNLINKED";

// ── 文件**接收收尾**那一族的四种终态（5.15.35）───────────────────────────────
//
// 这一族的形状与上面两族不同：**判定在文件层、上屏有两道**。1:1 与群共用同一份判据
// （`file/receive.rs::finish_receiver_into` 与 `file/group_receive.rs::finish_group_receive_into`
// 各写一遍同一个决定），所以这里的码**不带 GROUP_ 前缀** —— 它们说的不是"这个收件人这一单"，
// 而是"这份内容收没收成"，两家用同一句话。
//
// 以前这四格给的是**中文散文**（`Err("文件完整性校验失败")`），其中写盘/占名那两格更糟：
// 直接把 `io::Error` 的原文当载荷（"No space left on device (os error 28)"）。⇒ 两种后果：
// 英文界面那格显示中文或显示 OS 原文（前端对未知 reason 是**原样上屏**，那条回落是刻意的）；
// 而群气泡那边因为拿不到在册的码，只能把原因**标成别的事**（详见 `group_file.rs` 收尾那一格）。
// 人话留在日志里（日志读者是排查的人，中文且不该随版本翻改）。
//
// `FILE_INTEGRITY_FAILED` 原先住在 `logging.rs`（事件载荷族），中继接收那一格在用。
// 搬过来是因为接收收尾也用同一个事实 —— 一个事实只许有一个名字，两处各定一条常量
// 就是等着分叉。

/// 收到的字节数与对端声明的大小不符（没收完就收到完成帧）。
pub const FILE_RECEIVE_INCOMPLETE: &str = "FILE_RECEIVE_INCOMPLETE";
/// 内容能收齐但哈希/密钥对不上 —— **这份不是那一份**，已丢弃。
pub const FILE_INTEGRITY_FAILED: &str = "FILE_INTEGRITY_FAILED";
/// 本机写盘失败：`sync_all` / `write_all` / 建目录都归这一格（5.15.40 复核后按实际使用面改的口径）。
/// 盘满另有 `DISK_FULL` —— 那条才有"清出空间后重试"的可行动文案。
pub const FILE_RECEIVE_WRITE_FAILED: &str = "FILE_RECEIVE_WRITE_FAILED";
/// 没能把这一份放到最终落点：同名占位 / 改名 / 消毒后文件名为空（5.15.40 复核后按实际使用面改的口径）。
pub const FILE_RECEIVE_PLACE_FAILED: &str = "FILE_RECEIVE_PLACE_FAILED";

/// 落进 `messages.fail_code` 的全部档位 —— **与前端那张文案表双向对账的分母**
/// （`src/utils/fileFailReason.test.ts` 现读这里，两侧任何一侧多加一条都会红）。
pub const MESSAGE_FAIL_CODES: [&str; 19] = [
    SEND_RETRY_EXPIRED,
    SEND_PEER_OFFLINE_EXPIRED,
    SEND_ORPHAN_AT_START,
    SEND_PEER_DELETED,
    SEND_GROUP_MEMBER_GONE,
    SEND_KIND_UNSUPPORTED,
    SEND_PEER_KEY_MISSING,
    FILE_SEND_EXPIRED,
    FILE_SEND_GIVEUP,
    GROUP_FILE_STALLED,
    GROUP_FILE_NO_CHUNK,
    GROUP_FILE_DECRYPT_FAILED,
    GROUP_FILE_CHUNK_GAP,
    GROUP_FILE_CHUNK_EXCEEDS_SIZE,
    GROUP_FILE_PEER_UNLINKED,
    FILE_RECEIVE_INCOMPLETE,
    FILE_INTEGRITY_FAILED,
    FILE_RECEIVE_WRITE_FAILED,
    FILE_RECEIVE_PLACE_FAILED,
];
