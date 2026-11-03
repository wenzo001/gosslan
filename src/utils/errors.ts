/**
 * 错误**分类** —— 保证用户只看到「能读懂 + 可行动」的说明，而不是异常转储。
 *
 * 分工（本批拆干净的正是这一层）：
 *   - 本文件只做分类，**一条文案都不带**（纯函数，能被 `node --test` 直接 import）。
 *   - 文案住在 i18n 词典；拼装住在 `composables/useErrorText.ts`（那边才允许 import `@/i18n`）。
 *   原来这里自带三条中文替换文案和一句「请稍后重试」尾巴 ⇒ 英文界面上端口被占、公钥拿不到
 *   这类提示永远是中文，而它们跟后端一个字的关系都没有，本来就该翻译。
 *
 * 背景（2026-09-10 Apple HIG 审计 P0-6）：调用处曾普遍写 `app.toast(\`发送失败：${e}\`)`，
 * 把 IPC 抛出的错误原样拼进提示。HIG 要求错误讲清「发生了什么」并给出下一步。
 *
 * ⚠️ 实测前提（别想当然）：本项目 Rust 侧**大部分错误本来就是写好的中文说明**
 * （例如「对方不是好友，请先扫描添加好友之后再继续聊天。」）。正确做法不是
 * 「一律替换成通用文案」—— 那会把有用的信息抹掉。策略是：
 *
 *   1) 命中「需要额外解释」的模式 → 给词典键（如公钥缺失时的自动补发说明）；
 *   2) 已经是给人看的中文说明 → 原样保留，不做无用改写；
 *   3) 其余（IO / 库错误的英文串，如 `os error 2`）→ 通用文案，
 *      **原文只进 console**，既不给用户看转储，也不丢排查线索。
 *
 * 第 2 类是**已知的欠账**：要让它也能翻译，前提是后端给结构化错误码（协议面），
 * 已按「暂缓」登记在 `docs/architecture/frontend-inventory.md` §4 队列 2。
 */

/** 需要换成更具体提示的错误特征。命中即给**词典键**，文案由调用侧解析。 */
/**
 * **按码**的那一档（优先于下面那份按文案的正则）。
 *
 * 码的清单与后端 `src-tauri/src/error_codes.rs` 双向对账（见 `errors.test.ts`）：
 * 前端读了一个后端不产出的码 ⇒ 红；后端定了码却没人用 ⇒ 也红。
 * 这两条是必要的：改一句话就把用户提示换档，正是本仓最忌讳的**静默换档**。
 */
const CODE_RULES: Record<string, string> = {
  E2EE_PUBKEY_MISSING: "errors.rule.pubkey",
  PORT_IN_USE: "errors.rule.port",
  // 5.16.91：同步命令（发送/发文件/标记已读）写库前的那几处失败。
  // 以前它们把 `io::Error` / `rusqlite::Error` 的英文原文直接上屏 ⇒ 用户只能读到
  // 「请稍后重试」或一段转储。这里是那批唯一的人话出口。
  SEND_PEER_NOT_FRIEND: "errors.rule.peerNotFriend",
  FILE_SEND_SELF_CHAT: "errors.rule.fileSelfChat",
  SEND_LOCAL_WRITE_FAILED: "errors.rule.localWriteFailed",
  READ_STATE_WRITE_FAILED: "errors.rule.readStateWrite",
  // 5.16.92：能力协商从"写库前拒"改成"先入队后协商"之后新增的两格。
  // 两格都必须说清**下一步**：前者是"让对方升级客户端"，后者是"让对方先上线一次"。
  SEND_KIND_UNSUPPORTED: "errors.rule.kindUnsupported",
  SEND_PEER_KEY_MISSING: "errors.rule.peerKeyMissing",
  // 5.17.5：辅助窗口（设置/日志/外链/看图）建不出来。原始 HRESULT 只进日志，
  // 上屏这句 + 一个「立即重启」按钮（走既有 restart_app）。
  AUX_WINDOW_CREATE_FAILED: "errors.rule.auxWindow",
  // B6 试点批：消息类。同一件事只认一个码、只查一条词典（共用文案不在各调用点复制）。
  MSG_NOT_FOUND: "errors.rule.msgNotFound",
  MSG_NOT_IN_CONV: "errors.rule.msgNotInConv",
  E2EE_ENCRYPT_FAILED: "errors.rule.encryptFailed",
  // B6 试点批：群管理。同一条「群没了 / 你被移出 / 没密钥」只在这里有一条文案。
  GROUP_NOT_FOUND: "errors.rule.groupNotFound",
  GROUP_SELF_NOT_MEMBER: "errors.rule.groupSelfNotMember",
  GROUP_NAME_EMPTY: "errors.rule.groupNameEmpty",
  GROUP_KEY_MISSING: "errors.rule.groupKeyMissing",
  NUDGE_GROUP_UNSUPPORTED: "errors.rule.nudgeGroupUnsupported",
  // B6 试点批：文件 / 设置 / 窗口。
  FILE_NOT_FOUND: "errors.rule.fileNotFound",
  CHANNEL_UNKNOWN: "errors.rule.channelUnknown",
  TRANSPORT_START_FAILED: "errors.rule.transportStartFailed",
  // B6 第二批：好友申请。
  FRIEND_SELF_REQUEST: "errors.rule.friendSelfRequest",
  FRIEND_ACCEPT_FAILED: "errors.rule.friendAcceptFailed",
  FRIEND_REQUEST_GONE: "errors.rule.friendRequestGone",
  FRIEND_INVALID_CONTACT: "errors.rule.friendInvalidContact",
  FRIEND_ALREADY_FRIEND: "errors.rule.friendAlreadyFriend",
  // B6 第三批：消息/会话。
  CANCEL_SELF_CHAT_UNSUPPORTED: "errors.rule.cancelSelfChatUnsupported",
  CANCEL_NOT_OWN_MESSAGE: "errors.rule.cancelNotOwnMessage",
  CANCEL_FILE_USE_TRANSFER: "errors.rule.cancelFileUseTransfer",
  GROUP_RESEND_ONLY_FOR_GROUPS: "errors.rule.groupResendOnlyForGroups",
  GROUP_RESEND_NOT_OWN: "errors.rule.groupResendNotOwn",
  RECALL_OWN_CONV_UNSUPPORTED: "errors.rule.recallOwnConvUnsupported",
  RENDER_UNSUPPORTED: "errors.rule.renderUnsupported",
  RENDER_SELF_ONLY: "errors.rule.renderSelfOnly",
  RENDER_TEXT_CODE_ONLY: "errors.rule.renderTextCodeOnly",
  RENDER_RECALLED: "errors.rule.renderRecalled",
  NUDGE_SELF_UNSUPPORTED: "errors.rule.nudgeSelfUnsupported",
  MESSAGE_KIND_UNSUPPORTED: "errors.rule.messageKindUnsupported",
  NUDGE_MISSING: "errors.rule.nudgeMissing",
  RESEND_USE_GROUP_DELIVERY: "errors.rule.resendUseGroupDelivery",
  RESEND_SELF_CHAT_UNNEEDED: "errors.rule.resendSelfChatUnneeded",
  RESEND_SELF_ONLY: "errors.rule.resendSelfOnly",
  RESEND_KIND_UNSUPPORTED: "errors.rule.resendKindUnsupported",
  RESEND_NOT_FAILED: "errors.rule.resendNotFailed",
  RESEND_ALREADY_DELIVERED: "errors.rule.resendAlreadyDelivered",
  SELF_CHAT_NO_MEDIA: "errors.rule.selfChatNoMedia",
  // B6 第四批：群管理。
  GROUP_INVITE_FRIENDS_ONLY: "errors.rule.groupInviteFriendsOnly",
  GROUP_RENAME_OWNER_ONLY: "errors.rule.groupRenameOwnerOnly",
  GROUP_ADD_MEMBER_OWNER_ONLY: "errors.rule.groupAddMemberOwnerOnly",
  GROUP_MEMBER_ALREADY_IN: "errors.rule.groupMemberAlreadyIn",
  GROUP_ADD_FRIEND_MEMBER_ONLY: "errors.rule.groupAddFriendMemberOnly",
  GROUP_REMOVE_OWNER_ONLY: "errors.rule.groupRemoveOwnerOnly",
  GROUP_REMOVE_SELF: "errors.rule.groupRemoveSelf",
  GROUP_MEMBER_NOT_IN: "errors.rule.groupMemberNotIn",
  GROUP_TRANSFER_OWNER_ONLY: "errors.rule.groupTransferOwnerOnly",
  GROUP_TRANSFER_TO_SELF: "errors.rule.groupTransferToSelf",
  GROUP_TRANSFER_MEMBER_ONLY: "errors.rule.groupTransferMemberOnly",
  GROUP_OWNER_LEAVE_TRANSFER_FIRST: "errors.rule.groupOwnerLeaveTransferFirst",
  GROUP_FILE_KIND_UNSUPPORTED: "errors.rule.groupFileKindUnsupported",
  GROUP_TODO_TYPE_NAME_EMPTY: "errors.rule.groupTodoTypeNameEmpty",
  GROUP_TODO_TYPE_ICON_INVALID: "errors.rule.groupTodoTypeIconInvalid",
  GROUP_TODO_TYPE_INVALID: "errors.rule.groupTodoTypeInvalid",
  GROUP_TODO_TITLE_EMPTY: "errors.rule.groupTodoTitleEmpty",
  GROUP_TODO_ASSIGNEE_REQUIRED: "errors.rule.groupTodoAssigneeRequired",
  GROUP_TODO_STATUS_INVALID: "errors.rule.groupTodoStatusInvalid",
  GROUP_TODO_PRIORITY_INVALID: "errors.rule.groupTodoPriorityInvalid",
  GROUP_ANNOUNCEMENT_EMPTY: "errors.rule.groupAnnouncementEmpty",
  GROUP_ANNOUNCEMENT_ID_MISSING: "errors.rule.groupAnnouncementIdMissing",
  GROUP_REPLY_TARGET_MISSING: "errors.rule.groupReplyTargetMissing",
  GROUP_REACTION_UNKNOWN: "errors.rule.groupReactionUnknown",
  GROUP_FORWARD_FILE_NOT_OWNED: "errors.rule.groupForwardFileNotOwned",
  GROUP_FILE_ONLY_PLAIN: "errors.rule.groupFileOnlyPlain",
  GROUP_NO_OTHER_MEMBERS: "errors.rule.groupNoOtherMembers",
  GROUP_MEDIA_NOT_FILE: "errors.rule.groupMediaNotFile",
  GROUP_IMAGE_BYTES_INVALID: "errors.rule.groupImageBytesInvalid",
  GROUP_IMAGE_EMPTY: "errors.rule.groupImageEmpty",
  GROUP_IMAGE_PASTE_ONLY: "errors.rule.groupImagePasteOnly",
  FAVORITE_EXPORT_PATH_EMPTY: "errors.rule.favoriteExportPathEmpty",
  MAIN_WINDOW_MISSING: "errors.rule.mainWindowMissing",
  RELAY_HOST_REQUIRED: "errors.rule.relayHostRequired",
  RELAY_IPV6_UNSUPPORTED: "errors.rule.relayIpv6Unsupported",
  RELAY_TOKEN_REQUIRED: "errors.rule.relayTokenRequired",
  RELAY_TOKEN_INVALID: "errors.rule.relayTokenInvalid",
  RELAY_TOKEN_TOO_LONG: "errors.rule.relayTokenTooLong",
  RELAY_ENDPOINT_FORMAT_INVALID: "errors.rule.relayEndpointFormatInvalid",
  RELAY_CONFIG_READ_FAILED: "errors.rule.relayConfigReadFailed",
  ROUTED_ENDPOINT_FORMAT_INVALID: "errors.rule.routedEndpointFormatInvalid",
  ROUTED_IPV6_UNSUPPORTED: "errors.rule.routedIpv6Unsupported",
  NOTIFY_PERMISSION_DENIED: "errors.rule.notifyPermissionDenied",
  NOTIFY_SEND_FAILED: "errors.rule.notifySendFailed",
  IMAGE_DATA_URL_INVALID: "errors.rule.imageDataUrlInvalid",
  IMAGE_BASE64_REQUIRED: "errors.rule.imageBase64Required",
  IMAGE_NOT_IMAGE: "errors.rule.imageNotImage",
  IMAGE_FORMAT_UNSUPPORTED: "errors.rule.imageFormatUnsupported",
  IMAGE_DECODE_FAILED: "errors.rule.imageDecodeFailed",
  IMAGE_TOO_LARGE: "errors.rule.imageTooLarge",
  IMAGE_EMPTY: "errors.rule.imageEmpty",
  IMAGE_SAVE_FAILED: "errors.rule.imageSaveFailed",
  IMAGE_SOURCE_MISSING: "errors.rule.imageSourceMissing",
  FILE_DELETE_OUTSIDE_DOWNLOADS: "errors.rule.fileDeleteOutsideDownloads",
  FILE_NO_CONTENT_ID: "errors.rule.fileNoContentId",
  FILE_NOT_OWNED_BY_MESSAGE: "errors.rule.fileNotOwnedByMessage",
  OPEN_PATH_NOT_OWNED: "errors.rule.openPathNotOwned",
  OPEN_PATH_UNVERIFIED: "errors.rule.openPathUnverified",
  FILE_PATH_UNRESOLVED: "errors.rule.filePathUnresolved",
  GFILE_MY_STATUS_READ_FAILED: "errors.rule.gfileMyStatusReadFailed",
  LINK_URL_EMPTY: "errors.rule.linkUrlEmpty",
  LINK_URL_INVALID: "errors.rule.linkUrlInvalid",
  LINK_URL_SCHEME: "errors.rule.linkUrlScheme",
  LINK_URL_NO_HOST: "errors.rule.linkUrlNoHost",
  LINK_NAME_EMPTY: "errors.rule.linkNameEmpty",
  LINK_NAME_TOO_LONG: "errors.rule.linkNameTooLong",
  LINK_URL_DUPLICATE: "errors.rule.linkUrlDuplicate",
  LINK_LIMIT_REACHED: "errors.rule.linkLimitReached",
  LINK_NOT_FOUND: "errors.rule.linkNotFound",
  LINK_LIST_READ_FAILED: "errors.rule.linkListReadFailed",
  LINK_IMPORT_TOO_LARGE: "errors.rule.linkImportTooLarge",
  LINK_IMPORT_NOT_UTF8: "errors.rule.linkImportNotUtf8",
  LINK_IMPORT_READ_FAILED: "errors.rule.linkImportReadFailed",
  LINK_IMPORT_POOL_FAILED: "errors.rule.linkImportPoolFailed",
  LINK_IMPORT_JSON_INVALID: "errors.rule.linkImportJsonInvalid",
  LINK_SAVE_FAILED: "errors.rule.linkSaveFailed",
  LINK_CLEAN_OUTSIDE_EXPORT: "errors.rule.linkCleanOutsideExport",
  LINK_DOWNLOAD_HTTP_FAILED: "errors.rule.linkDownloadHttpFailed",
  LINK_NETWORK_INIT_FAILED: "errors.rule.linkNetworkInitFailed",
  LINK_EXPORT_FAILED: "errors.rule.linkExportFailed",
  LINK_CLEAN_FAILED: "errors.rule.linkCleanFailed",
  SHARE_DIR_MISSING: "errors.rule.shareDirMissing",
  SHARE_DIR_READ_FAILED: "errors.rule.shareDirReadFailed",
  SHARE_NOT_FRIEND: "errors.rule.shareNotFriend",
  SHARE_TIMEOUT: "errors.rule.shareTimeout",
  SHARE_NO_ROUTE: "errors.rule.shareNoRoute",
  SHARE_SEND_FAILED: "errors.rule.shareSendFailed",
  CHANNEL_CACHE_CLEAN_FAILED: "errors.rule.channelCacheCleanFailed",
};

/** 后端 `error_codes::coded()` 的形状：`code=<大写蛇形> 给人看的那句话`。 */
const CODE_RE = /code=([A-Z0-9_]+)/;

/** 取出错误串里的码（没有则 null）。导出是为了让对账判据能直接用它解析。 */
export function errorCode(raw: string): string | null {
  return CODE_RE.exec(raw)?.[1] ?? null;
}

/** 把码摘掉，只留给人看的那半句（否则 toast 上会写着 `code=…`）。 */
export function stripErrorCode(raw: string): string {
  return raw.replace(CODE_RE, "").trim();
}

/** 码 → 词典键。导出给判据读（不导出的话，那份对账就只能正则扫字面量）。 */
export const ERROR_CODE_RULES = CODE_RULES;

// 兜底那一族：OS / 第三方库的串我们**不产码**，只能按签名认。
// 自家产出的语义分支不再依赖这里的正则（那正是本文件上面那个家要替掉的东西）。
const RULES: { re: RegExp; key: string }[] = [
  {
    // E2EE 恒开的固有代价：对方从未上线过/处于不同子网时拿不到公钥。
    // 调用处原本会带出 device_id 等细节，这里换成用户能理解、且知道「不用重发」的说法。
    re: /公钥/,
    key: "errors.rule.pubkey",
  },
  {
    re: /address already in use|端口.{0,8}占用/i,
    key: "errors.rule.port",
  },
  {
    // 库/OS 错误签名（英文）——最典型的「用户看不懂」的一类
    re: /os error|No such file|Connection (refused|reset|aborted)|timed? ?out|permission denied|No route to host|network is unreachable|dns error/i,
    key: "errors.rule.system",
  },
];

/** 技术签名：出现这些说明这串不是写给用户看的（Rust panic / 内部实现细节）。 */
const TECHNICAL = /os error|panicked at|RUST_BACKTRACE|thread '[^']*'|unwrap\(\)|src\/[\w./-]+\.rs:\d+/i;

/**
 * 前端自己抛出的、带**词典键**的错误。
 *
 * `message` 就是那个键（`errors.*`），`params` 是插值要用的数据（如 HTTP 状态码）。
 * 形状与 zod 那套一致（见 `utils/validation.ts`）：**判据与键住纯函数侧，文案住词典侧**，
 * 于是英文界面也说得出「头像压缩后仍超过 1MB」，而排查用的数据一个都不丢。
 */
export class MessageKeyError extends Error {
  readonly params?: Record<string, string | number>;

  constructor(key: string, params?: Record<string, string | number>) {
    super(key);
    this.name = "MessageKeyError";
    this.params = params;
  }
}

/** 分类结论：给键（要查词典）、透传（已是人话）、或只给「请稍后重试」。 */
export type ErrorVerdict =
  | { kind: "copy"; key: string; params?: Record<string, string | number> }
  | { kind: "human"; detail: string }
  | { kind: "retry" };

/** 取错误的可读文本（兼容 Error / string / 任意抛出物）。 */
export function rawErrorMessage(e: unknown): string {
  if (e === null || e === undefined) return "";
  if (e instanceof Error) return e.message.trim();
  return String(e).trim();
}

/** 是否「已经是给人读的文案」：含中文且不带技术签名。 */
function looksUserFacing(s: string): boolean {
  return /[\u4e00-\u9fa5]/.test(s) && !TECHNICAL.test(s);
}

/**
 * 把任意抛出物分成三类之一。**不含任何文案**，所以可以脱离浏览器与词典被判定。
 */
export function classifyError(e: unknown): ErrorVerdict {
  if (e instanceof MessageKeyError) return { kind: "copy", key: e.message, params: e.params };
  const raw = rawErrorMessage(e);
  if (!raw) return { kind: "retry" };
  // 先认码：自家产出的错误靠它，改文案不会换档。
  const code = errorCode(raw);
  if (code) {
    const rule = CODE_RULES[code];
    if (rule) return { kind: "copy", key: rule };
    // 认不出的码**必须回落原文**（不许空白、也不许通用「操作失败」）：
    // 码是我们自己加的前缀，摘掉之后那半句本来就是写给人看的。
    const fallback = stripErrorCode(raw);
    return fallback ? { kind: "human", detail: fallback } : { kind: "retry" };
  }
  const body = raw;
  for (const r of RULES) {
    if (r.re.test(body)) return { kind: "copy", key: r.key };
  }
  if (looksUserFacing(body)) return { kind: "human", detail: body };
  return { kind: "retry" };
}

/**
 * 这串错误值不值得进 console：带技术签名的英文串、或干脆是空串之外的原始异常。
 * 已是人话（含中文/自家词典键）的**不该**打噪音 —— 原行为，别顺手放宽。
 */
export function isTechnicalError(e: unknown): boolean {
  if (e instanceof MessageKeyError) return false;
  const raw = rawErrorMessage(e);
  if (!raw) return false;
  return !looksUserFacing(raw);
}
