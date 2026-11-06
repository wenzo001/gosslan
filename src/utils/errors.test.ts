/**
 * 错误**分类器**的判据。
 *
 * 这里只判"分成哪一类、给哪个键"—— 文案已经搬到 i18n 词典（拼装那一格在
 * `composables/useErrorText.ts`，它 import `@/i18n` 因而不能被 node --test 直接吃）。
 * 于是这一本反而比原来更硬：**分类与文案不再混在一句断言里**，改词典不会红、
 * 改分类必红；而"键在不在词典里"由下面那条现扫生产码的判据兜住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToastText,
  classifyError,
  errorCode,
  ERROR_CODE_RULES,
  isTechnicalError,
  MessageKeyError,
  rawErrorMessage,
  stripErrorCode,
  TOAST_TECHNICAL,
  TOAST_TEXT_MAX_COLUMNS,
  toastDisplayWidth,
} from "./errors.ts";
import { enUS, zhCN } from "../i18n/locales.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("取错误文本：Error / string / null", () => {
  assert.equal(rawErrorMessage(new Error("boom")), "boom");
  assert.equal(rawErrorMessage("直接字符串"), "直接字符串");
  assert.equal(rawErrorMessage(null), "");
  assert.equal(rawErrorMessage(undefined), "");
});

test("自家抛出的错误带词典键，插值数据一个都不丢", () => {
  const e = new MessageKeyError("errors.image.httpFail", { status: 404 });
  assert.deepEqual(classifyError(e), { kind: "copy", key: "errors.image.httpFail", params: { status: 404 } });
  // 键不是"人话"，也不该被当成技术串写进 console（它是给用户看的句子的身份证号）。
  assert.equal(isTechnicalError(e), false);
});

test("公钥缺失 → 自动补发那一档（不再透出 device_id 那一串）", () => {
  const e = "尚未获取 gosslan-a1b2c3 的公钥：对方可能离线或处于不同子网";
  assert.deepEqual(classifyError(e), { kind: "copy", key: "errors.rule.pubkey" });
});

test("已经是给用户看的中文说明 → 原样透传，不做无用改写", () => {
  assert.deepEqual(classifyError("对方不是好友，请先扫描添加好友之后再继续聊天。"), {
    kind: "human",
    detail: "对方不是好友，请先扫描添加好友之后再继续聊天。",
  });
});

test("英文技术串（OS / 库错误）→ 系统那一档，不外露原文", () => {
  assert.deepEqual(classifyError("No such file or directory (os error 2)"), {
    kind: "copy",
    key: "errors.rule.system",
  });
  assert.deepEqual(classifyError("Connection refused"), { kind: "copy", key: "errors.rule.system" });
});

test("Rust panic 一类：既不透传也不给规则，只剩「请稍后重试」", () => {
  assert.deepEqual(classifyError("called `unwrap()` on a `None` value at src/db.rs:120"), {
    kind: "retry",
  });
  assert.equal(isTechnicalError("called `unwrap()` on a `None` value at src/db.rs:120"), true);
});

test("端口占用给出具体那一档", () => {
  assert.deepEqual(classifyError("TCP 绑定 0.0.0.0:59992 失败：端口被占用"), {
    kind: "copy",
    key: "errors.rule.port",
  });
});

test("空错误 / 无 info → 请稍后重试那一档", () => {
  assert.deepEqual(classifyError(null), { kind: "retry" });
  assert.deepEqual(classifyError(""), { kind: "retry" });
  assert.deepEqual(classifyError(undefined), { kind: "retry" });
  assert.equal(isTechnicalError(null), false, "没有原文就别往 console 里打空行");
});

test("已是人话的错误不打 console 噪音，技术串才留线索", () => {
  assert.equal(isTechnicalError("对方不是好友"), false);
  assert.equal(isTechnicalError("os error 2"), true);
});

/**
 * 抛出去的键必须真存在于中英两册（`t()` 的回落是"把键原样上屏" ⇒ 漏一条就是一句英文
 * 界面里的 `errors.avatar.stillTooLarge`）。i18n 那本调用点判据只扫 `t("...")` 字面量，
 * 扫不到 `new MessageKeyError("...")` ⇒ 这一条补的是它管不着的那半个家。
 */
test("生产码里抛出的 errors.* 键都在中英词典里", () => {
  const thrown = new Set<string>();
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "i18n") continue; // 词典本体不扫
        walk(p);
        continue;
      }
      if (!/\.(ts|vue)$/.test(ent.name) || ent.name.includes(".test.")) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/new MessageKeyError\(\s*"([^"]+)"/g)) thrown.add(m[1]);
    }
  };
  walk(SRC);
  // 分母从分类表现取（不手抄清单 —— 手抄的那份一定会漂）。
  const rules = Object.values(ERROR_CODE_RULES);
  const all = [...thrown, ...rules].sort();
  assert.ok(all.length >= 7, `只扫到 ${all.length} 个键 ⇒ 分母变小，先确认是不是被改掉了`);
  for (const k of all) {
    assert.ok(k in zhCN, `中文词典缺 ${k}`);
    assert.ok(k in enUS, `英文词典缺 ${k}`);
    // 拼装那两把模板也要在（分类器不再自带任何一句话）。
  }
  for (const k of ["errors.joined", "errors.toastJoined", "errors.retry"]) {
    assert.ok(k in zhCN && k in enUS, `拼装模板 ${k} 不在词典里`);
  }
});


/**
 * **码优先**（INV-P16 窄口，2026-10-29）。
 *
 * 这一族原来只有一条判据能表达"这话说什么档"：后端那句中文里有没有"公钥"两个字。
 * 于是把"公钥"改成"身份密钥"这种**纯文案改动**会把用户提示从"不用重发，先让对方上线"
 * 悄悄换成"请稍后重试" —— 不报错、不进日志、桌面跑一遍看不出来。
 */
test("码优先：后端换了那句人话的说法，档位不许跟着换（带反向对照）", () => {
  const coded = classifyError("code=E2EE_PUBKEY_MISSING 对端身份密钥暂时拿不到，请先让对方上线");
  assert.deepEqual(coded, { kind: "copy", key: "errors.rule.pubkey" }, "认到码就走那一档，与措辞无关");
  // 反向对照：同样的措辞、**没有码** ⇒ 落到"透传给人看"那一档。
  // 少了这一格，上一条可能只是"任何中文串都返回 pubkey 那一档"的假绿。
  const noCode = classifyError("对端身份密钥暂时拿不到，请先让对方上线");
  assert.equal(noCode.kind, "human", "没码时不该凭空认出 pubkey 那一档（否则码优先那条是空转）");
  const portCoded = classifyError("code=PORT_IN_USE 59992 这个监听口已被别的过程占着");
  assert.deepEqual(portCoded, { kind: "copy", key: "errors.rule.port" }, "端口那一档同样按码认");
});

test("B6 试点批：每个码中英各一条，认不出码必须回落原文", () => {
  const cases: Record<string, string> = {
    MSG_NOT_FOUND: "errors.rule.msgNotFound",
    MSG_NOT_IN_CONV: "errors.rule.msgNotInConv",
    E2EE_ENCRYPT_FAILED: "errors.rule.encryptFailed",
    GROUP_NOT_FOUND: "errors.rule.groupNotFound",
    GROUP_SELF_NOT_MEMBER: "errors.rule.groupSelfNotMember",
    GROUP_NAME_EMPTY: "errors.rule.groupNameEmpty",
    GROUP_KEY_MISSING: "errors.rule.groupKeyMissing",
    NUDGE_GROUP_UNSUPPORTED: "errors.rule.nudgeGroupUnsupported",
    FILE_NOT_FOUND: "errors.rule.fileNotFound",
    CHANNEL_UNKNOWN: "errors.rule.channelUnknown",
    TRANSPORT_START_FAILED: "errors.rule.transportStartFailed",
    FRIEND_SELF_REQUEST: "errors.rule.friendSelfRequest",
    FRIEND_ACCEPT_FAILED: "errors.rule.friendAcceptFailed",
    FRIEND_REQUEST_GONE: "errors.rule.friendRequestGone",
    FRIEND_INVALID_CONTACT: "errors.rule.friendInvalidContact",
    FRIEND_ALREADY_FRIEND: "errors.rule.friendAlreadyFriend",
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
    RENDER_INVALID_LANG: "errors.rule.renderInvalidLang",
    RENDER_SUPERSEDED: "errors.rule.renderSuperseded",
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
    LOG_READ_FAILED: "errors.rule.logReadFailed",
    LOG_CLEAR_FAILED: "errors.rule.logClearFailed",
    DIAG_EXPORT_JOIN_FAILED: "errors.rule.diagExportJoinFailed",
    DIAG_EXPORT_PATH_EMPTY: "errors.rule.diagExportPathEmpty",
    DIAG_EXPORT_WRITE_FAILED: "errors.rule.diagExportWriteFailed",
    AVATAR_TOO_LARGE: "errors.rule.avatarTooLarge",
    PROFILE_SAVE_FAILED: "errors.rule.profileSaveFailed",
    INTERFACE_LIST_FAILED: "errors.rule.interfaceListFailed",
    UPDATER_CHECK_WHILE_DOWNLOADING: "errors.rule.updaterCheckWhileDownloading",
    UPDATER_CHECK_IN_PROGRESS: "errors.rule.updaterCheckInProgress",
    UPDATER_ALREADY_DOWNLOADING: "errors.rule.updaterAlreadyDownloading",
    UPDATER_NO_PENDING_UPDATE: "errors.rule.updaterNoPendingUpdate",
    UPDATER_INSTALL_WHILE_DOWNLOADING: "errors.rule.updaterInstallWhileDownloading",
    UPDATER_NO_UPDATE: "errors.rule.updaterNoUpdate",
    UPDATER_NOT_DOWNLOADED: "errors.rule.updaterNotDownloaded",
    UPDATER_CANCEL_AFTER_INSTALL: "errors.rule.updaterCancelAfterInstall",
    STARTUP_ALREADY_RECOVERED: "errors.rule.startupAlreadyRecovered",
    STARTUP_RETRY_IN_PROGRESS: "errors.rule.startupRetryInProgress",
    STARTUP_NO_PENDING_FAILURE: "errors.rule.startupNoPendingFailure",
    STARTUP_RETRY_POOL_FAILED: "errors.rule.startupRetryPoolFailed",
    STARTUP_MAIN_THREAD_FAILED: "errors.rule.startupMainThreadFailed",
    STARTUP_DATA_DIR_READ_FAILED: "errors.rule.startupDataDirReadFailed",
    FRIENDS_LIST_READ_FAILED: "errors.rule.friendsListReadFailed",
    GROUP_READS_LIST_READ_FAILED: "errors.rule.groupReadsListReadFailed",
    GROUP_TODO_TYPE_NAME_TOO_LONG: "errors.rule.groupTodoTypeNameTooLong",
    GROUP_TODO_TITLE_TOO_LONG: "errors.rule.groupTodoTitleTooLong",
    GROUP_TODO_DESC_TOO_LONG: "errors.rule.groupTodoDescTooLong",
    GROUP_ANNOUNCEMENT_TOO_LONG: "errors.rule.groupAnnouncementTooLong",
    GROUP_TODO_IMAGE_TOO_LARGE: "errors.rule.groupTodoImageTooLarge",
    FAVORITE_DELETE_BATCH_TOO_LARGE: "errors.rule.favoriteDeleteBatchTooLarge",
    GROUP_TODO_ASSIGNEE_NOT_MEMBER: "errors.rule.groupTodoAssigneeNotMember",
    GROUP_TODO_EDIT_FORBIDDEN: "errors.rule.groupTodoEditForbidden",
    GROUP_TODO_ARCHIVE_STATE_INVALID: "errors.rule.groupTodoArchiveStateInvalid",
    GROUP_ANNOUNCEMENT_OWNER_ONLY: "errors.rule.groupAnnouncementOwnerOnly",
    GROUP_REMIND_TARGET_REQUIRED: "errors.rule.groupRemindTargetRequired",
    GROUP_REMIND_TARGETS_GONE: "errors.rule.groupRemindTargetsGone",
    FAVORITE_SOURCE_GONE: "errors.rule.favoriteSourceGone",
    FAVORITE_COPY_FAILED: "errors.rule.favoriteCopyFailed",
    FAVORITE_CONTENT_MISSING: "errors.rule.favoriteContentMissing",
    FAVORITE_STORE_READ_FAILED: "errors.rule.favoriteStoreReadFailed",
    FAVORITE_PATH_ESCAPE: "errors.rule.favoritePathEscape",
  };
  for (const [code, key] of Object.entries(cases)) {
    assert.ok(key in zhCN, `中文词典缺 ${key}`);
    assert.ok(key in enUS, `英文词典缺 ${key}`);
    assert.notEqual(zhCN[key], enUS[key], `${key} 的中英文案必须是两份，不能同一句`);
    assert.deepEqual(classifyError(`code=${code} 原来的中文说明`), { kind: "copy", key });
  }
  // 反向对照：不认识的码不许吞掉原文（中文、英文各一条）。
  assert.deepEqual(classifyError("code=NOT_IMPLEMENTED_YET 这条消息不存在"), {
    kind: "human",
    detail: "这条消息不存在",
  });
  assert.deepEqual(classifyError("code=NOT_IMPLEMENTED_YET that message is gone"), {
    kind: "human",
    detail: "that message is gone",
  });
});

test("码只给我们看：任何一档都不许把 code=… 带上屏", () => {
  const v = classifyError("code=NOT_IMPLEMENTED_YET 磁盘已满，请清理后再试");
  assert.equal(v.kind, "human", "不认识的码仍然要能给人看那句话");
  assert.equal(v.kind === "human" && v.detail.includes("code="), false, `码泄漏到界面上了：${JSON.stringify(v)}`);
  assert.equal(stripErrorCode("code=PORT_IN_USE 端口被占用"), "端口被占用");
  assert.equal(errorCode("端口被占用"), null, "没有码时必须返回 null，不能把整串当码");
});

/**
 * toast 正文的护栏（A1 修正 2026-11-06）。
 *
 * 两件事必须同时成立，缺哪边链子都会空转：
 *   ① 短原因**要**上屏（不能退回到「只报失败」）；
 *   ② 长原因 / 技术串**不上**屏（toast 只有一行，细节留给页面内错误档 + console）。
 */
function trOf(dict: Record<string, string>) {
  return (key: string, params?: Record<string, string | number>) => {
    const tpl = dict[key];
    if (!tpl) return key;
    return tpl.replace(/\{(\w+)\}/g, (_m, name) => (params && name in params ? String(params[name]) : `{${name}}`));
  };
}

test("toast 正文：短原因拼成「结论 · 原因」，长原因退回结论（两边都拿同一函数自证）", () => {
  const tr = trOf(zhCN);
  // ① 短原因必须真的上屏 —— 这是 A1 修正要解决的问题（只报失败越界）。
  assert.equal(buildToastText("对方不是好友", "发送失败", tr), "发送失败 · 对方不是好友");
  // 英文册同一形状（分隔符跟词典走，不在代码里写死）。英文后端串本身没有「人话」那一档
  // （`looksUserFacing` 认中文），所以这里走**码 → 英文文案**这条路。
  assert.equal(
    buildToastText("code=GROUP_TODO_TITLE_EMPTY 原始说明", "Save failed", trOf(enUS)),
    "Save failed · A todo needs a title.",
  );
  // ② 反例自证：这条真实的后端说明**自己**就超过一行，上面的「短」与下面的「长」不是同一段逻辑；
  //    若把原因上限改大 / 删掉长度判断，这条样本就会重新上屏 ⇒ 断言会红。
  const longRaw = "对方不是好友，请先扫描添加好友之后再继续聊天。";
  const longJoined = tr("errors.toastJoined", { prefix: "发送失败", detail: longRaw });
  assert.ok(
    toastDisplayWidth(longRaw) > TOAST_TEXT_MAX_COLUMNS,
    `样本原因只有 ${toastDisplayWidth(longRaw)} 列，本来就该上屏 ⇒ 下面的断言会空转`,
  );
  assert.ok(
    toastDisplayWidth(longJoined) > TOAST_TEXT_MAX_COLUMNS,
    `样本整句只有 ${toastDisplayWidth(longJoined)} 列，触发不了长度闸 ⇒ 下面的断言会空转`,
  );
  assert.equal(buildToastText(longRaw, "发送失败", tr), "发送失败");
});

test("toast 正文不含技术串：URL / err: / 十六进制 / 栈帧都退回结论（样本先自证命中判据）", () => {
  const tr = trOf(zhCN);
  for (const raw of [
    "请求 http://10.0.0.1:59992 失败", // 人话里带 URL
    "写入失败 err: EACCES", // 人话里带 err:
    "窗口创建失败 0x80070005", // 人话里带 HRESULT
    "调用失败 at foo (bar.js:12:3)", // 人话里带栈帧
  ]) {
    // 先证明样本真的命中技术串判据，否则下面「退回结论」可能只是因为分类没给出 detail。
    assert.equal(TOAST_TECHNICAL.test(raw), true, `样本没命中技术串判据：${raw}`);
    assert.equal(buildToastText(raw, "操作失败", tr), "操作失败", `技术串被带上屏了：${raw}`);
  }
});

test("每个错误码的说明都过 toast 闸：原因自身 ≤ 一行、不含技术串、结论句不丢（中英两册，前缀用真实文案）", () => {
  // 前缀必须用**该语言真实的**那句话：旧版中英都用中文「操作失败」，
  // 英文分支实际在断言「中文前缀还在」，前缀原样返回也能过 —— 闸一直在空转。
  const prefixKey = "settings.network.toast.btFail";
  for (const [locale, dict] of [["zh", zhCN], ["en", enUS]] as const) {
    const tr = trOf(dict);
    const prefix = dict[prefixKey];
    assert.ok(prefix, `${locale} 词典缺 ${prefixKey}`);
    for (const [code, key] of Object.entries(ERROR_CODE_RULES)) {
      const text = buildToastText(`code=${code} 原始说明`, prefix, tr);
      assert.ok(text.includes(prefix), `${locale}/${code} 丢了结论句：${text}`);
      assert.equal(TOAST_TECHNICAL.test(text), false, `${locale}/${code} 把技术串带上屏了：${text}`);
      // 契约：要么只剩结论，要么上屏的原因自己不超过一行（可以折到第二行）。
      if (text !== prefix) {
        assert.ok(
          toastDisplayWidth(dict[key]) <= TOAST_TEXT_MAX_COLUMNS,
          `${locale}/${code} 把一个超过一行的段落推上了 toast（${toastDisplayWidth(dict[key])} 列）：${text}`,
        );
      }
      assert.ok(key in dict, `${locale} 词典缺 ${key}`);
    }
  }
});

test("英文前缀更长也不许把原因挤没：同一件事中英都要看得见原因（改回旧总宽判据必红）", () => {
  // 真实调用点：`GroupMemberPanel` 的强提醒失败；原因码 `GROUP_REMIND_TARGET_REQUIRED`。
  for (const [locale, dict] of [["zh", zhCN], ["en", enUS]] as const) {
    const tr = trOf(dict);
    const prefix = dict["remind.sendFail"];
    const detail = dict["errors.rule.groupRemindTargetRequired"];
    const joined = tr("errors.toastJoined", { prefix, detail });
    // 自证：两边**原因一样长**，差别只在语言前缀宽度 —— 这正是旧判据丢原因的根因。
    assert.ok(toastDisplayWidth(prefix) <= TOAST_TEXT_MAX_COLUMNS, `${locale} 前缀样本已超一行，样本选错了`);
    assert.ok(
      toastDisplayWidth(detail) <= TOAST_TEXT_MAX_COLUMNS,
      `${locale} 原因样本已超一行（${toastDisplayWidth(detail)} 列），它本来就不该上屏 ⇒ 下面会空转`,
    );
    if (locale === "en") {
      // 旧逻辑：34 + 3 + 27 = 64 > 40 ⇒ 只留 "Failed to send the strong reminder"。
      assert.ok(
        toastDisplayWidth(joined) > TOAST_TEXT_MAX_COLUMNS,
        `英文样本整句只有 ${toastDisplayWidth(joined)} 列，触发不了旧判据 ⇒ 下面的反例自证会空转`,
      );
    }
    assert.equal(
      buildToastText("code=GROUP_REMIND_TARGET_REQUIRED 原始说明", prefix, tr),
      joined,
      `${locale} 把原因挤没了：${buildToastText("code=GROUP_REMIND_TARGET_REQUIRED 原始说明", prefix, tr)}`,
    );
  }
});

test("通用「请稍后重试」不算原因：读不出人话时 toast 只留结论", () => {
  const tr = trOf(zhCN);
  assert.equal(buildToastText(null, "操作失败", tr), "操作失败");
  assert.equal(buildToastText("called `unwrap()` on a `None` value at src/db.rs:120", "操作失败", tr), "操作失败");
});

/**
 * **跨语言对账**：前端读的码必须都由后端产出，后端产出的码必须都有人用。
 *
 * 分母从 `error_codes.rs` 现读（不手抄清单 —— 手抄的那份一定会漂），
 * 并用"一个不存在的码必须数到 0 次引用"当阳性对照，证明引用计数器真的会说"没有"。
 */
test("跨语言契约：错误码两侧同源（前端读的码 ⊆ 后端产出的码，且后端每个码都被用到）", () => {
  const rustDir = path.join(SRC, "..", "src-tauri", "src");
  const defs = path.join(rustDir, "error_codes.rs");
  const src = fs.readFileSync(defs, "utf8");
  const defined = [...src.matchAll(/^pub const ([A-Z0-9_]+): &str = /gm)].map((m) => m[1]);
  assert.ok(defined.length >= 2, `后端错误码只解析到 ${defined.length} 个 ⇒ 提取器坏了（形状变了？）`);

  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".rs")) files.push(p);
    }
  };
  walk(rustDir);
  const usesOf = (code: string) =>
    files.reduce(
      (n, f) => n + (f.endsWith("error_codes.rs") ? 0
        : (fs.readFileSync(f, "utf8").match(new RegExp(`error_codes::${code}\\b`, "g")) ?? []).length),
      0,
    );
  assert.equal(usesOf("E2EE_PUBKEY_MISSING") > 0, true, "阳性对照：真有引用的码要数得到");
  assert.equal(usesOf("THIS_CODE_IS_NOT_USED_ANYWHERE"), 0, "计数器必须会说『0 处』（否则下面那条恒绿）");

  const dead = defined.filter((c) => usesOf(c) === 0);
  assert.deepEqual(dead, [], `后端定义了但没人用的码（那是一条已经失效的契约）：${dead.join(", ")}`);

  const orphans = Object.keys(ERROR_CODE_RULES).filter((c) => !defined.includes(c));
  assert.deepEqual(orphans, [], `前端读了后端不产出的码：${orphans.join(", ")}`);
});
